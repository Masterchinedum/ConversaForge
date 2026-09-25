import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Session } from '@prisma/client';
import { isTerminal, type ScenarioConfig, type SessionState } from '@cf/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppError, Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { InjectRedis } from '../../common/redis/redis.module';
import { UsageService } from '../usage/usage.service';
import { RuntimeService } from '../runtime/runtime.service';
import { parseVersionConfig, SessionsService } from '../runtime/sessions.service';
import { ChannelProvidersService, SPEECH_MISSING, TWILIO_MISSING, twilioRequest, type TwilioCreds } from './channel-providers.service';
import { validateTwilioSignature } from './twilio/twilio-signature';
import { E164_RE, normalizePhone, SIP_RE, sayAndHangup, sayLanguage, twiml } from './twilio/twiml';

export const NOT_CONFIGURED_MESSAGE = 'Sorry, this line is not configured. Goodbye.';
const UNAVAILABLE_MESSAGE = 'Sorry, we cannot take your call right now. Please try again later. Goodbye.';
const TOKEN_TTL_SEC = 24 * 3600;
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

export const OutboundCallBody = z
  .object({
    to: z.string().trim().min(5).max(32),
    scenarioId: z.string().min(1).max(64),
    fromNumberId: z.string().min(1).max(64).optional(),
    name: z.string().trim().max(120).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    externalId: z.string().trim().max(200).optional(),
    variables: z.record(z.union([z.string().max(2000), z.number(), z.boolean()])).default({}),
  })
  .strict();
export type OutboundCallInput = z.infer<typeof OutboundCallBody>;

export type TwilioParams = Record<string, string | string[] | undefined>;

function str(p: TwilioParams, k: string): string {
  const v = p[k];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export interface CallOutcome {
  sessionId: string;
  callSid: string | null;
  callStatus: string;
  durationSec: number | null;
  connected: boolean;
}

/**
 * Twilio voice: inbound call webhook (TwiML), outbound call creation, status callbacks and call
 * transfer. The live audio goes through the media-stream bridge (twilio-media.gateway.ts).
 * Every "can't serve this call" path speaks a clear message and hangs up — nothing is simulated.
 */
@Injectable()
export class PhoneService {
  private readonly logger = new Logger('Phone');
  /** Listeners for terminal call outcomes (the batch scheduler subscribes). */
  private readonly outcomeListeners: Array<(o: CallOutcome, session: Session) => Promise<void> | void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly providers: ChannelProvidersService,
    private readonly sessions: SessionsService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly runtimeService: RuntimeService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  onCallOutcome(fn: (o: CallOutcome, session: Session) => Promise<void> | void) {
    this.outcomeListeners.push(fn);
  }

  private runtime(): RuntimeService {
    return this.runtimeService;
  }

  apiBase() {
    return env.API_PUBLIC_URL.replace(/\/$/, '');
  }

  mediaStreamUrl() {
    const u = new URL(this.apiBase());
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws/twilio`;
  }

  /** The exact URL Twilio requested (API_PUBLIC_URL + path and query), used for signature checks. */
  publicUrlFor(reqUrl: string) {
    const u = new URL(this.apiBase());
    return `${u.protocol}//${u.host}${reqUrl}`;
  }

  // ───────────────────────── token stash (outbound calls) ─────────────────────────

  async stashToken(sessionId: string, token: string) {
    await this.redis.set(`ch:tok:${sessionId}`, this.crypto.encrypt(token), 'EX', TOKEN_TTL_SEC);
  }

  async takeToken(sessionId: string): Promise<string | null> {
    const v = await this.redis.get(`ch:tok:${sessionId}`);
    if (!v) return null;
    try {
      return this.crypto.decrypt(v);
    } catch {
      return null;
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  private async failSession(sessionId: string, code: string, message: string) {
    try {
      const engine = await this.runtime().getEngine(sessionId);
      await engine.fail(code, message);
    } catch (e: any) {
      // Engine unavailable: mark the row directly (compare-and-set on non-terminal states).
      this.logger.warn(`Could not fail session ${sessionId} via runtime (${e?.message}); updating directly`);
      await this.prisma.session.updateMany({
        where: { id: sessionId, state: { in: ['CREATED', 'READY', 'CONNECTING'] } },
        data: { state: 'FAILED', stateReason: code, errorCode: code, errorMessage: message.slice(0, 500), endedBy: 'system', endedAt: new Date() },
      });
    }
  }

  private async cancelUnstarted(sessionId: string, reason: string) {
    try {
      const engine = await this.runtime().getEngine(sessionId);
      await engine.closeSession(reason, 'system');
    } catch (e: any) {
      this.logger.warn(`Could not cancel session ${sessionId}: ${e?.message}`);
    }
  }

  private greeting(config: ScenarioConfig): string {
    const notice = config.recording.consentNotice?.trim();
    if (notice) return notice.slice(0, 600);
    return config.analysis.enabled
      ? 'You are speaking with an A I assistant. This call is transcribed and may be analyzed.'
      : 'You are speaking with an A I assistant. This call is transcribed.';
  }

  private streamTwiml(config: ScenarioConfig, sessionId: string, token: string) {
    return twiml([
      { verb: 'Say', text: this.greeting(config), language: sayLanguage(config.basics.language) },
      { verb: 'Stream', url: this.mediaStreamUrl(), parameters: { sessionId, token } },
    ]);
  }

  /** Readiness shared by inbound and outbound calls. Returns a human-readable reason when not ready. */
  async phoneReadiness(workspaceId: string): Promise<string | null> {
    const speech = await this.providers.speech(workspaceId);
    if (!speech.ready) return SPEECH_MISSING;
    const pub = this.providers.publicUrlStatus();
    if (!pub.ok) return pub.reason;
    return null;
  }

  private async runnableConfig(workspaceId: string, scenarioId: string, versionId?: string | null) {
    const scenario = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!scenario || scenario.status === 'ARCHIVED' || !scenario.latestVersionId) return null;
    const version = await this.prisma.scenarioVersion.findFirst({ where: { id: versionId || scenario.latestVersionId, scenarioId, workspaceId } });
    if (!version) return null;
    try {
      return { scenario, version, config: parseVersionConfig(version.config) };
    } catch {
      return null;
    }
  }

  // ───────────────────────── inbound ─────────────────────────

  /**
   * POST /api/channels/twilio/voice. Returns { status, twiml }; status 403 when the request is not
   * a validly signed Twilio request for a number we host.
   */
  async handleInbound(reqUrl: string, params: TwilioParams, signature: string | undefined): Promise<{ status: number; body: string }> {
    const to = normalizePhone(str(params, 'To'));
    const from = str(params, 'From');
    const callSid = str(params, 'CallSid');
    const url = this.publicUrlFor(reqUrl);
    const number = to ? await this.prisma.phoneNumber.findFirst({ where: { provider: 'twilio', e164: to } }) : null;

    if (!number) {
      // Unknown number: only answer (with a spoken message) if the request is signed with the server credentials.
      const envCreds = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? env.TWILIO_AUTH_TOKEN : null;
      if (envCreds && validateTwilioSignature(envCreds, signature, url, params)) return { status: 200, body: sayAndHangup(NOT_CONFIGURED_MESSAGE) };
      return { status: 403, body: 'Forbidden' };
    }
    const creds = await this.providers.twilio(number.workspaceId);
    if (!creds || !this.validRequest(creds, signature, url, params)) {
      this.logger.warn(`Rejected unsigned/invalid Twilio request for ${number.e164} (${creds ? 'bad signature' : TWILIO_MISSING})`);
      return { status: 403, body: 'Forbidden' };
    }
    const ws = number.workspaceId;
    const rl = await this.rateLimit.hit(`twilio:inbound:${number.id}`, 120, 60);
    if (!rl.allowed) return { status: 200, body: sayAndHangup(UNAVAILABLE_MESSAGE) };

    if (!number.inboundScenarioId) return { status: 200, body: sayAndHangup(NOT_CONFIGURED_MESSAGE) };
    const r = await this.runnableConfig(ws, number.inboundScenarioId);
    if (!r || !r.config.channels.phone.enabled) return { status: 200, body: sayAndHangup(NOT_CONFIGURED_MESSAGE, r ? sayLanguage(r.config.basics.language) : undefined) };

    const last4 = from.replace(/\D/g, '').slice(-4);
    let created: { session: Session; sessionToken: string };
    try {
      created = await this.sessions.createSession({
        workspaceId: ws,
        scenarioId: r.scenario.id,
        channel: 'PHONE_INBOUND',
        participant: { externalId: E164_RE.test(from) ? from : null, name: last4 ? `Caller …${last4}` : 'Caller' },
        consent: { recordAudio: false, recordVideo: false, analysis: r.config.analysis.enabled, source: 'phone_greeting' },
        externalRef: callSid || undefined,
        metadata: { twilio: { callSid, from, to, direction: 'inbound', numberId: number.id } },
      });
    } catch (e: any) {
      this.logger.warn(`Inbound call ${callSid}: session could not be created: ${e?.message}`);
      return { status: 200, body: sayAndHangup(UNAVAILABLE_MESSAGE, sayLanguage(r.config.basics.language)) };
    }
    const notReady = await this.phoneReadiness(ws);
    if (notReady) {
      await this.failSession(created.session.id, 'provider_unavailable', notReady);
      return { status: 200, body: sayAndHangup(NOT_CONFIGURED_MESSAGE, sayLanguage(r.config.basics.language)) };
    }
    return { status: 200, body: this.streamTwiml(r.config, created.session.id, created.sessionToken) };
  }

  validRequest(creds: TwilioCreds, signature: string | undefined, url: string, params: TwilioParams): boolean {
    if (!validateTwilioSignature(creds.authToken, signature, url, params)) return false;
    const acct = str(params, 'AccountSid');
    return !acct || acct === creds.accountSid;
  }

  // ───────────────────────── outbound ─────────────────────────

  async startOutboundCall(
    workspaceId: string,
    principal: Principal | null,
    input: OutboundCallInput,
    ctx: { batchId?: string; targetId?: string } = {},
  ): Promise<{ sessionId: string; callSid: string; status: string }> {
    const creds = await this.providers.requireTwilio(workspaceId);
    const notReady = await this.phoneReadiness(workspaceId);
    if (notReady) throw new AppError(503, 'provider_unavailable', notReady);
    const to = normalizePhone(input.to);
    if (!to) throw Errors.validation('`to` must be an E.164 phone number, e.g. +14155550123', [{ path: 'to', message: 'Invalid phone number' }]);
    const from = input.fromNumberId
      ? await this.prisma.phoneNumber.findFirst({ where: { id: input.fromNumberId, workspaceId, provider: 'twilio' } })
      : await this.prisma.phoneNumber.findFirst({ where: { workspaceId, provider: 'twilio' }, orderBy: { createdAt: 'asc' } });
    if (!from) throw Errors.validation('Add a Twilio phone number to this workspace first (Channels → Phone numbers)', [{ path: 'fromNumberId', message: 'No phone number' }]);
    const r = await this.runnableConfig(workspaceId, input.scenarioId);
    if (!r) throw Errors.conflict('The scenario must be published before it can place calls');
    if (!r.config.channels.phone.enabled) throw Errors.conflict('The phone channel is disabled for this scenario (Channels → Phone in the scenario editor)');
    await this.rateLimit.enforce(`twilio:outbound:${workspaceId}`, 60, 60, 'Too many outbound calls per minute for this workspace');

    const { session, sessionToken } = await this.sessions.createSession({
      workspaceId,
      scenarioId: r.scenario.id,
      channel: 'PHONE_OUTBOUND',
      participant: { externalId: input.externalId || to, name: input.name || null, email: input.email || null },
      variables: input.variables,
      consent: { recordAudio: false, recordVideo: false, analysis: r.config.analysis.enabled, source: 'phone_greeting' },
      metadata: { twilio: { to, from: from.e164, direction: 'outbound', numberId: from.id, batchId: ctx.batchId ?? null, targetId: ctx.targetId ?? null } },
    });
    await this.stashToken(session.id, sessionToken);
    const base = this.apiBase();
    try {
      const call = await twilioRequest<{ sid: string; status: string }>(creds, 'POST', '/Calls.json', [
        ['To', to],
        ['From', from.e164],
        ['Url', `${base}/api/channels/twilio/voice/outbound?sessionId=${encodeURIComponent(session.id)}`],
        ['Method', 'POST'],
        ['StatusCallback', `${base}/api/channels/twilio/status?sessionId=${encodeURIComponent(session.id)}`],
        ['StatusCallbackMethod', 'POST'],
        ['StatusCallbackEvent', 'initiated'],
        ['StatusCallbackEvent', 'ringing'],
        ['StatusCallbackEvent', 'answered'],
        ['StatusCallbackEvent', 'completed'],
        ['Timeout', '30'],
      ]);
      await this.prisma.session.update({ where: { id: session.id }, data: { externalRef: call.sid } });
      await this.audit.log({
        workspaceId,
        principal,
        action: 'channel.call_started',
        targetType: 'session',
        targetId: session.id,
        metadata: { to: `…${to.slice(-4)}`, from: from.e164, callSid: call.sid, batchId: ctx.batchId ?? null },
      });
      return { sessionId: session.id, callSid: call.sid, status: call.status };
    } catch (e: any) {
      await this.failSession(session.id, 'provider_error', e?.message ?? 'Twilio call failed');
      throw e;
    }
  }

  /** POST /api/channels/twilio/voice/outbound?sessionId=… (Twilio fetches TwiML when the callee answers). */
  async outboundTwiml(reqUrl: string, sessionId: string, params: TwilioParams, signature: string | undefined): Promise<{ status: number; body: string }> {
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, channel: 'PHONE_OUTBOUND', deletedAt: null } });
    if (!session) return { status: 403, body: 'Forbidden' };
    const creds = await this.providers.twilio(session.workspaceId);
    if (!creds || !this.validRequest(creds, signature, this.publicUrlFor(reqUrl), params)) return { status: 403, body: 'Forbidden' };
    if (session.externalRef && str(params, 'CallSid') && session.externalRef !== str(params, 'CallSid')) return { status: 403, body: 'Forbidden' };
    const r = await this.runnableConfig(session.workspaceId, session.scenarioId, session.scenarioVersionId);
    const token = await this.takeToken(session.id);
    if (!r || !token || isTerminal(session.state as SessionState)) {
      return { status: 200, body: sayAndHangup(UNAVAILABLE_MESSAGE) };
    }
    const notReady = await this.phoneReadiness(session.workspaceId);
    if (notReady) {
      await this.failSession(session.id, 'provider_unavailable', notReady);
      return { status: 200, body: sayAndHangup(NOT_CONFIGURED_MESSAGE, sayLanguage(r.config.basics.language)) };
    }
    return { status: 200, body: this.streamTwiml(r.config, session.id, token) };
  }

  /** POST /api/channels/twilio/status[?sessionId=…] — call progress / completion. */
  async statusCallback(reqUrl: string, sessionIdHint: string | undefined, params: TwilioParams, signature: string | undefined): Promise<{ status: number }> {
    const callSid = str(params, 'CallSid');
    const session = sessionIdHint
      ? await this.prisma.session.findFirst({ where: { id: sessionIdHint, deletedAt: null } })
      : callSid
        ? await this.prisma.session.findFirst({ where: { externalRef: callSid, channel: { in: ['PHONE_INBOUND', 'PHONE_OUTBOUND'] } } })
        : null;
    if (!session) return { status: 403 };
    const creds = await this.providers.twilio(session.workspaceId);
    if (!creds || !this.validRequest(creds, signature, this.publicUrlFor(reqUrl), params)) return { status: 403 };
    if (session.externalRef && callSid && session.externalRef !== callSid) return { status: 403 };

    const callStatus = str(params, 'CallStatus');
    await this.prisma.sessionEvent.create({
      data: {
        sessionId: session.id,
        type: 'channel.twilio_status',
        payload: { callSid, callStatus, duration: str(params, 'CallDuration') || null, answeredBy: str(params, 'AnsweredBy') || null } as Prisma.InputJsonValue,
      },
    });
    if (!TERMINAL_CALL_STATUSES.has(callStatus)) return { status: 204 };

    const durationSec = Number(str(params, 'CallDuration')) || null;
    if (durationSec && durationSec > 0) {
      await this.usage.record({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        kind: 'TELEPHONY_SECONDS',
        provider: 'twilio',
        quantity: durationSec,
        unit: 'seconds',
        idempotencyKey: `twilio:${callSid || session.id}:duration`,
        metadata: { direction: session.channel === 'PHONE_INBOUND' ? 'inbound' : 'outbound' },
      });
    }
    const fresh = await this.prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    const connected = !!fresh.startedAt;
    if (!connected && (fresh.state === 'CREATED' || fresh.state === 'READY')) {
      await this.cancelUnstarted(session.id, `call_${callStatus.replace('-', '_')}`);
    }
    const outcome: CallOutcome = { sessionId: session.id, callSid: callSid || null, callStatus, durationSec, connected };
    for (const l of this.outcomeListeners) {
      try {
        await l(outcome, fresh);
      } catch (e: any) {
        this.logger.error(`Call outcome listener failed: ${e?.message}`);
      }
    }
    return { status: 204 };
  }

  // ───────────────────────── transfer ─────────────────────────

  /**
   * Transfer a live phone session to `channels.phone.transferNumber` (E.164 → <Dial><Number>,
   * sip: URI → <Dial><Sip>) by redirecting the call with new TwiML. The AI session is completed with
   * endedBy "transfer". Triggered by the caller pressing 0 (DTMF) or by an admin via the API.
   */
  async transferCall(workspaceId: string, sessionId: string, initiatedBy: 'caller_dtmf' | 'admin', principal: Principal | null = null) {
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, workspaceId, deletedAt: null } });
    if (!session || !['PHONE_INBOUND', 'PHONE_OUTBOUND'].includes(session.channel)) throw Errors.notFound('Phone session');
    if (!session.externalRef) throw Errors.conflict('This session has no active call');
    if (isTerminal(session.state as SessionState)) throw Errors.conflict('The call has already ended');
    const version = await this.prisma.scenarioVersion.findFirst({ where: { id: session.scenarioVersionId, workspaceId } });
    const config = parseVersionConfig(version?.config);
    const target = (config.channels.phone.transferNumber ?? '').trim();
    const number = normalizePhone(target);
    const sip = SIP_RE.test(target) ? target : null;
    if (!number && !sip) throw Errors.conflict('No valid transfer number is configured for this scenario (Channels → Phone → Transfer number)');
    const creds = await this.providers.requireTwilio(workspaceId);
    const meta = (session.metadata ?? {}) as any;
    const callerId = session.channel === 'PHONE_OUTBOUND' ? meta?.twilio?.from : meta?.twilio?.to;
    const doc = twiml([
      { verb: 'Say', text: 'Please hold while I transfer your call.', language: sayLanguage(config.basics.language) },
      number
        ? { verb: 'DialNumber', number, callerId: typeof callerId === 'string' && E164_RE.test(callerId) ? callerId : undefined, timeout: 30 }
        : { verb: 'DialSip', uri: sip!, timeout: 30 },
    ]);
    await twilioRequest(creds, 'POST', `/Calls/${encodeURIComponent(session.externalRef)}.json`, [['Twiml', doc]]);
    await this.prisma.sessionEvent.create({ data: { sessionId, type: 'channel.transfer', payload: { initiatedBy, target: number ? `…${number.slice(-4)}` : 'sip' } } });
    try {
      const engine = await this.runtime().getEngine(sessionId);
      await engine.closeSession('transferred', 'transfer');
    } catch (e: any) {
      this.logger.warn(`Transfer: could not close session ${sessionId}: ${e?.message}`);
    }
    await this.audit.log({ workspaceId, principal, action: 'channel.call_transferred', targetType: 'session', targetId: sessionId, metadata: { initiatedBy } });
    return { ok: true, transferredTo: number ? `…${number.slice(-4)}` : 'sip' };
  }

  async hangup(workspaceId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, workspaceId } });
    if (!session?.externalRef) return;
    const creds = await this.providers.twilio(workspaceId);
    if (!creds) return;
    await twilioRequest(creds, 'POST', `/Calls/${encodeURIComponent(session.externalRef)}.json`, [['Status', 'completed']]).catch((e) =>
      this.logger.warn(`Hangup ${session.externalRef} failed: ${e?.message}`),
    );
  }
}
