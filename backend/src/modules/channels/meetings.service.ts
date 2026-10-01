import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, type MeetingBot } from '@prisma/client';
import { createHash } from 'node:crypto';
import { isTerminal, type SessionState } from '../../shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import { userIdOf, type Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { DomainEvents } from '../../common/events/domain-events';
import { AppError, Errors } from '../../common/http/errors';
import { prismaPageArgs, toPage, type PaginationQuery } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService } from '../../common/queue/queue.service';
import { UsageService } from '../usage/usage.service';
import { RuntimeService } from '../runtime/runtime.service';
import { parseVersionConfig, SessionsService } from '../runtime/sessions.service';
import { ChannelProvidersService, RECALL_MISSING, type RecallCreds } from './channel-providers.service';
import { transitionMeetingSession } from './meeting-session';
import { MEETING_BOT_MODES, mapRecallStatus, meetingPlatform, recallBotRequest, utteranceFromTranscriptEvent, verifySvixSignature, type MeetingBotMode } from './recall/recall';

/** Agent bot page diagnostics event. */
export const BotPageEvent = z.object({ event: z.string().trim().min(1).max(40), data: z.record(z.unknown()).optional() }).strict();

export const CreateMeetingBotBody = z
  .object({
    scenarioId: z.string().min(1).max(64),
    meetingUrl: z.string().trim().min(10).max(2000),
    joinAt: z.coerce.date().optional().nullable(),
    botName: z.string().trim().min(1).max(100).optional(),
    /** Transcript speakers with this display name are the evaluated participant; others are the counterpart. */
    evaluatedSpeakerName: z.string().trim().min(1).max(120).optional(),
    calendarEventId: z.string().trim().max(200).optional(),
    /** notetaker: transcribe a real meeting. agent: the scenario's AI persona joins and talks. */
    mode: z.enum(MEETING_BOT_MODES).default('notetaker'),
  })
  .strict();

/** A member practising a scenario in their own meeting: the AI persona joins and talks. */
export const PracticeMeetingBody = z
  .object({
    meetingUrl: z.string().trim().min(10).max(2000),
    joinAt: z.coerce.date().optional().nullable(),
  })
  .strict();

/** Who the evaluated participant is when a member starts the bot for their own practice. */
export interface MeetingParticipant {
  userId?: string | null;
  email?: string | null;
  name?: string | null;
}

const POLL_INTERVAL_MS = 60_000;
const TERMINAL_BOT = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);
/** The bot page authenticates with the session token (24 h TTL), so agent bots must join well within it. */
const AGENT_MAX_LEAD_MS = 20 * 3600_000;

/**
 * Meeting bots via Recall.ai: a bot joins a Zoom / Google Meet / Teams meeting, streams real-time
 * transcript utterances to our webhook, and the resulting MEETING session is analysed by the normal
 * pipeline when the meeting ends. Without Recall credentials the bot is stored as BLOCKED with the
 * exact reason — never simulated.
 *
 * Agent bots (mode "agent") instead open our bot page through Recall output media: the page runs a
 * normal live session (engine attached, live voice) with the meeting as its microphone and speaker.
 * The meeting ending closes the session; the session ending makes the bot leave.
 */
@Injectable()
export class MeetingsService implements OnModuleInit {
  private readonly logger = new Logger('Meetings');
  fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly providers: ChannelProvidersService,
    private readonly sessions: SessionsService,
    private readonly events: DomainEvents,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly runtime: RuntimeService,
  ) {}

  onModuleInit() {
    this.events.on('session.terminal', ({ sessionId }) => this.leaveAfterSession(sessionId));
  }

  endpointToken(botRowId: string) {
    return this.crypto.hmac(`recall-endpoint:${botRowId}`);
  }

  realtimeEndpointUrl(botRowId: string) {
    return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/channels/recall/webhook?bot=${encodeURIComponent(botRowId)}&token=${this.endpointToken(botRowId)}`;
  }

  /** Page the agent bot's browser opens. The token rides in the fragment so it never reaches server logs. */
  botPageUrl(sessionId: string, sessionToken: string) {
    return `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/bot/${encodeURIComponent(sessionId)}#t=${encodeURIComponent(sessionToken)}`;
  }

  private async recallFetch<T = any>(creds: RecallCreds, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.providers.recallUrl(creds, path), {
      method,
      headers: { Authorization: `Token ${creds.apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const detail = json?.detail ?? json?.message ?? (json ? JSON.stringify(json).slice(0, 300) : `HTTP ${res.status}`);
      throw new AppError(502, 'provider_error', `Recall.ai: ${detail}`, { status: res.status });
    }
    return json as T;
  }

  serialize(b: MeetingBot) {
    return {
      id: b.id,
      scenarioId: b.scenarioId,
      provider: b.provider,
      meetingUrl: b.meetingUrl,
      platform: meetingPlatform(b.meetingUrl),
      scheduledAt: b.scheduledAt,
      calendarEventId: b.calendarEventId,
      status: b.status,
      providerBotId: b.providerBotId,
      sessionId: b.sessionId,
      lastError: b.lastError,
      botName: b.botName,
      mode: b.mode as MeetingBotMode,
      evaluatedSpeakerName: b.evaluatedSpeakerName,
      lastEventAt: b.lastEventAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }

  async list(workspaceId: string, q: PaginationQuery) {
    const rows = await this.prisma.meetingBot.findMany({ where: { workspaceId }, ...prismaPageArgs(q) });
    const page = toPage(rows, q.limit);
    return { data: page.data.map((b) => this.serialize(b)), nextCursor: page.nextCursor };
  }

  async get(workspaceId: string, id: string) {
    const b = await this.prisma.meetingBot.findFirst({ where: { id, workspaceId } });
    if (!b) throw Errors.notFound('Meeting bot');
    return this.withPageState(b);
  }

  /** A member's own practice bot (never someone else's). */
  async getOwn(workspaceId: string, userId: string, id: string) {
    const b = await this.prisma.meetingBot.findFirst({ where: { id, workspaceId, createdById: userId } });
    if (!b) throw Errors.notFound('Meeting bot');
    return this.withPageState(b);
  }

  /** Agent bots: whether Recall's browser has opened our bot page (it reports `bot.page` → loaded). */
  private async withPageState(b: MeetingBot) {
    const out = this.serialize(b);
    if (b.mode !== 'agent' || !b.sessionId) return { ...out, pageLoaded: null as boolean | null, botPageOrigin: null as string | null };
    const seen = await this.prisma.sessionEvent.count({ where: { sessionId: b.sessionId, type: 'bot.page' } });
    return { ...out, pageLoaded: seen > 0, botPageOrigin: env.WEB_PUBLIC_URL.replace(/\/$/, '') };
  }

  private pageCheckedAt = 0;

  /**
   * Before sending an agent bot: Recall's browser must be able to open WEB_PUBLIC_URL/bot/…, or the bot
   * sits in the meeting with no page and says nothing. `/health` on the web origin is proxied to the API,
   * so a JSON "ok" proves the public address reaches this app. Requested like a browser, so a tunnel's
   * browser warning page (ngrok free plan) is caught too. Success is cached for a minute.
   */
  async assertBotPageReachable() {
    if (Date.now() - this.pageCheckedAt < 60_000) return;
    const base = env.WEB_PUBLIC_URL.replace(/\/$/, '');
    const fix = 'If you use a tunnel (ngrok, cloudflared), start it and make sure WEB_PUBLIC_URL is its current address, then restart the API.';
    let status = 0;
    let text = '';
    try {
      const res = await this.fetchImpl(`${base}/health`, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json' },
        signal: AbortSignal.timeout(8000),
      } as RequestInit);
      status = res.status;
      text = (await res.text()).slice(0, 4000);
    } catch (e: any) {
      throw new AppError(409, 'bot_page_unreachable', `The AI bot opens its page at ${base}, but that address is not reachable (${e?.name === 'TimeoutError' ? 'timed out' : e?.message ?? 'network error'}). ${fix}`, { url: base });
    }
    let ok = false;
    try {
      ok = JSON.parse(text)?.status === 'ok';
    } catch {
      ok = false;
    }
    if (!ok) {
      const ngrok = /ngrok/i.test(text);
      throw new AppError(
        409,
        'bot_page_unreachable',
        ngrok
          ? `The AI bot opens its page at ${base}, but ngrok shows its browser warning page there, which the bot cannot click through. Use a tunnel without an interstitial (e.g. cloudflared) or an ngrok plan/domain without it.`
          : `The AI bot opens its page at ${base}, but that address answered ${status || 'with something else'} instead of this app. ${fix}`,
        { url: base, status },
      );
    }
    this.pageCheckedAt = Date.now();
  }

  async create(workspaceId: string, principal: Principal, input: z.infer<typeof CreateMeetingBotBody>, participant?: MeetingParticipant) {
    const mode: MeetingBotMode = input.mode ?? 'notetaker';
    const platform = meetingPlatform(input.meetingUrl);
    if (!platform) {
      throw Errors.validation('Enter a Zoom, Google Meet or Microsoft Teams meeting link (https://…)', [{ path: 'meetingUrl', message: 'Unsupported meeting URL' }]);
    }
    if (input.joinAt && input.joinAt.getTime() < Date.now() - 60_000) throw Errors.validation('joinAt must be in the future', [{ path: 'joinAt', message: 'In the past' }]);
    if (mode === 'agent' && input.joinAt && input.joinAt.getTime() > Date.now() + AGENT_MAX_LEAD_MS) {
      throw Errors.validation('An AI agent bot can be scheduled at most 20 hours ahead', [{ path: 'joinAt', message: 'Too far ahead' }]);
    }
    const scenario = await this.prisma.scenario.findFirst({ where: { id: input.scenarioId, workspaceId, deletedAt: null } });
    if (!scenario) throw Errors.notFound('Scenario');
    if (!scenario.latestVersionId) throw Errors.conflict('Publish the scenario before sending a meeting bot');
    const version = await this.prisma.scenarioVersion.findFirst({ where: { id: scenario.latestVersionId, workspaceId } });
    const config = parseVersionConfig(version?.config);
    if (!config.channels.meeting.enabled) throw Errors.conflict('The meeting channel is disabled for this scenario (Channels → Meeting in the scenario editor)');

    const creds = await this.providers.recall(workspaceId);
    const pub = this.providers.publicUrlStatus();
    const page = this.providers.botPageUrlStatus();
    const blockedReason = !creds ? RECALL_MISSING : !pub.ok ? pub.reason : mode === 'agent' && !page.ok ? page.reason : null;
    // An agent bot whose page cannot load joins the meeting and stays silent: refuse up front instead.
    if (mode === 'agent' && !blockedReason) await this.assertBotPageReachable();
    const bot = await this.prisma.meetingBot.create({
      data: {
        workspaceId,
        scenarioId: scenario.id,
        provider: 'recall',
        meetingUrl: input.meetingUrl,
        scheduledAt: input.joinAt ?? null,
        calendarEventId: input.calendarEventId ?? null,
        status: blockedReason ? 'BLOCKED' : 'SCHEDULED',
        lastError: blockedReason,
        botName: input.botName ?? defaultBotName(mode, config.persona.name),
        mode,
        evaluatedSpeakerName: input.evaluatedSpeakerName ?? null,
        createdById: userIdOf(principal),
      },
    });
    await this.audit.log({ workspaceId, principal, action: 'channel.meeting_bot_created', targetType: 'meeting_bot', targetId: bot.id, metadata: { platform, mode, blocked: !!blockedReason } });
    if (blockedReason) return this.serialize(bot);

    let created: Awaited<ReturnType<SessionsService['createSession']>>;
    try {
      created = await this.sessions.createSession({
        workspaceId,
        scenarioId: scenario.id,
        channel: 'MEETING',
        participant: participant ?? { externalId: `meeting:${bot.id}`, name: input.evaluatedSpeakerName ?? 'Meeting participants' },
        consent: { recordAudio: false, recordVideo: false, analysis: config.analysis.enabled, source: 'meeting_bot' },
        metadata: { meeting: { botId: bot.id, platform, url: input.meetingUrl, mode, evaluatedSpeakerName: input.evaluatedSpeakerName ?? null } },
        // Agent bots run the call in the bot page (a browser), so live voice is available.
        mediaInBrowser: mode === 'agent',
      });
    } catch (e: any) {
      await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { status: 'FAILED', lastError: String(e?.message ?? e).slice(0, 500) } });
      throw e;
    }
    const { session, sessionToken } = created;
    try {
      const res = await this.recallFetch<{ id: string }>(
        creds!,
        'POST',
        '/bot/',
        recallBotRequest({
          mode,
          meetingUrl: input.meetingUrl,
          botName: bot.botName ?? defaultBotName(mode, config.persona.name),
          joinAt: input.joinAt,
          language: config.basics.language,
          ...(mode === 'agent' ? { botPageUrl: this.botPageUrl(session.id, sessionToken) } : { realtimeEndpointUrl: this.realtimeEndpointUrl(bot.id) }),
          metadata: { conversaforge_bot_id: bot.id, conversaforge_session_id: session.id, workspace_id: workspaceId },
        }),
      );
      const updated = await this.prisma.meetingBot.update({
        where: { id: bot.id },
        data: { providerBotId: res.id, sessionId: session.id, status: input.joinAt && input.joinAt.getTime() > Date.now() + 60_000 ? 'SCHEDULED' : 'JOINING' },
      });
      await this.prisma.session.update({ where: { id: session.id }, data: { externalRef: res.id } });
      await this.schedulePoll(bot.id, input.joinAt ? Math.max(POLL_INTERVAL_MS, input.joinAt.getTime() - Date.now()) : POLL_INTERVAL_MS);
      return this.serialize(updated);
    } catch (e: any) {
      if (mode === 'agent') await this.failAgentSession(session.id, 'provider_error', String(e?.message ?? e));
      else await transitionMeetingSession(this.prisma, this.events, session.id, 'FAILED', 'meeting_bot_failed', { errorCode: 'provider_error', errorMessage: e?.message });
      const failed = await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { status: 'FAILED', sessionId: session.id, lastError: String(e?.message ?? e).slice(0, 500) } });
      return this.serialize(failed);
    }
  }

  async cancel(workspaceId: string, principal: Principal, id: string) {
    const bot = await this.prisma.meetingBot.findFirst({ where: { id, workspaceId } });
    if (!bot) throw Errors.notFound('Meeting bot');
    if (TERMINAL_BOT.has(bot.status)) return this.serialize(bot);
    const creds = await this.providers.recall(workspaceId);
    if (creds && bot.providerBotId) {
      try {
        if (bot.status === 'SCHEDULED') await this.recallFetch(creds, 'DELETE', `/bot/${encodeURIComponent(bot.providerBotId)}/`);
        else await this.recallFetch(creds, 'POST', `/bot/${encodeURIComponent(bot.providerBotId)}/leave_call/`);
      } catch (e: any) {
        this.logger.warn(`Recall cancel for ${bot.id} failed: ${e?.message}`);
      }
    }
    const updated = await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { status: 'CANCELLED' } });
    if (bot.sessionId && bot.mode === 'agent') {
      await this.closeAgentSession(bot.sessionId, 'meeting_bot_cancelled');
    } else if (bot.sessionId) {
      const s = await this.prisma.session.findUnique({ where: { id: bot.sessionId } });
      if (s && !isTerminal(s.state as SessionState)) {
        await transitionMeetingSession(this.prisma, this.events, s.id, s.startedAt ? 'COMPLETED' : 'CANCELLED', 'meeting_bot_cancelled', { endedBy: 'admin' });
      }
    }
    await this.audit.log({ workspaceId, principal, action: 'channel.meeting_bot_cancelled', targetType: 'meeting_bot', targetId: bot.id });
    return this.serialize(updated);
  }

  // ───────────────────────── agent sessions ─────────────────────────

  /** The meeting is over (or the bot was cancelled): end the live session like a participant hanging up. */
  private async closeAgentSession(sessionId: string, reason: string) {
    try {
      const engine = await this.runtime.getEngine(sessionId);
      if (!engine.isTerminal) await engine.closeSession(reason, 'participant');
    } catch (e: any) {
      this.logger.warn(`Could not close agent session ${sessionId}: ${e?.message}`);
    }
  }

  private async failAgentSession(sessionId: string, code: string, message: string) {
    try {
      const engine = await this.runtime.getEngine(sessionId);
      await engine.fail(code, message.slice(0, 500));
    } catch (e: any) {
      this.logger.warn(`Could not fail agent session ${sessionId}: ${e?.message}`);
    }
  }

  /** An agent session ended (agent closed it, time limit, …): take the bot out of the meeting. */
  async leaveAfterSession(sessionId: string) {
    const bot = await this.prisma.meetingBot.findFirst({ where: { sessionId, mode: 'agent', status: { in: ['SCHEDULED', 'JOINING', 'IN_CALL'] } } });
    if (!bot) return;
    const creds = await this.providers.recall(bot.workspaceId);
    if (creds && bot.providerBotId) {
      try {
        if (bot.status === 'SCHEDULED') await this.recallFetch(creds, 'DELETE', `/bot/${encodeURIComponent(bot.providerBotId)}/`);
        else await this.recallFetch(creds, 'POST', `/bot/${encodeURIComponent(bot.providerBotId)}/leave_call/`);
      } catch (e: any) {
        this.logger.warn(`Recall leave for ${bot.id} failed: ${e?.message}`);
      }
    }
    await this.prisma.meetingBot.updateMany({ where: { id: bot.id, status: { in: ['SCHEDULED', 'JOINING', 'IN_CALL'] } }, data: { status: 'COMPLETED' } });
  }

  // ───────────────────────── webhooks & polling ─────────────────────────

  /**
   * POST /api/channels/recall/webhook. Accepts (a) our per-bot realtime endpoint URL token, or
   * (b) a Svix signature made with RECALL_WEBHOOK_SECRET (bot status webhooks from the Recall dashboard).
   */
  async handleWebhook(query: { bot?: string; token?: string }, headers: Record<string, string | string[] | undefined>, rawBody: Buffer | string, body: any) {
    let bot: MeetingBot | null = null;
    if (query.bot && query.token) {
      const candidate = await this.prisma.meetingBot.findUnique({ where: { id: String(query.bot).slice(0, 64) } });
      if (candidate && this.crypto.safeEqual(String(query.token), this.endpointToken(candidate.id))) bot = candidate;
      else return { status: 401 };
    } else {
      const secret = env.RECALL_WEBHOOK_SECRET;
      if (!secret || !verifySvixSignature(secret, headers, rawBody)) return { status: 401 };
      const providerBotId = body?.data?.bot?.id;
      const rowId = body?.data?.bot?.metadata?.conversaforge_bot_id;
      bot = rowId
        ? await this.prisma.meetingBot.findFirst({ where: { id: String(rowId), providerBotId: String(providerBotId ?? '') } })
        : providerBotId
          ? await this.prisma.meetingBot.findFirst({ where: { providerBotId: String(providerBotId), provider: 'recall' } })
          : null;
      if (!bot) return { status: 200 }; // not ours (shared Recall account); acknowledge
    }
    const event = String(body?.event ?? '');
    if (event === 'transcript.data') {
      await this.ingestUtterance(bot, body);
    } else if (event.startsWith('bot.')) {
      const code = event.slice(4);
      await this.applyStatus(bot, code, body?.data?.data?.sub_code ?? null);
    }
    await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { lastEventAt: new Date() } });
    return { status: 200 };
  }

  async ingestUtterance(bot: MeetingBot, payload: any) {
    // Agent sessions get their transcript from the live session itself.
    if (bot.mode === 'agent') return;
    if (!bot.sessionId || (TERMINAL_BOT.has(bot.status) && bot.status !== 'COMPLETED')) return;
    const u = utteranceFromTranscriptEvent(payload);
    if (!u) return;
    if (u.botId && bot.providerBotId && u.botId !== bot.providerBotId) return;
    const session = await this.prisma.session.findUnique({ where: { id: bot.sessionId } });
    if (!session || session.workspaceId !== bot.workspaceId || isTerminal(session.state as SessionState)) return;
    if (session.state !== 'ACTIVE') {
      await transitionMeetingSession(this.prisma, this.events, session.id, 'ACTIVE', 'meeting_transcript_started');
      if (bot.status !== 'IN_CALL') await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { status: 'IN_CALL' } });
    }
    const evaluated = bot.evaluatedSpeakerName?.trim().toLowerCase();
    const isParticipant = !evaluated || (u.speaker.name ?? '').trim().toLowerCase() === evaluated;
    const clientTurnId = 'rc_' + createHash('sha256').update(`${u.speaker.id}|${u.startMs}|${u.text}`).digest('hex').slice(0, 32);
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await this.prisma.transcriptTurn.findUnique({ where: { sessionId_clientTurnId: { sessionId: session.id, clientTurnId } } });
      if (exists) return;
      const last = await this.prisma.transcriptTurn.findFirst({ where: { sessionId: session.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
      const seq = (last?.seq ?? 0) + 1;
      try {
        await this.prisma.transcriptTurn.create({
          data: {
            sessionId: session.id,
            seq,
            speaker: isParticipant ? 'PARTICIPANT' : 'AGENT',
            text: u.text,
            clientTurnId,
            startedAtMs: u.startMs,
            endedAtMs: u.endMs,
            source: 'meeting_transcript',
            metadata: { speakerName: u.speaker.name, speakerId: u.speaker.id, isHost: u.speaker.isHost, role: isParticipant ? 'evaluated' : 'counterpart' } as Prisma.InputJsonValue,
          },
        });
        await this.prisma.session.updateMany({ where: { id: session.id, lastSeq: { lt: seq } }, data: { lastSeq: seq } });
        return;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
  }

  async applyStatus(bot: MeetingBot, code: string, subCode: string | null) {
    const mapped = mapRecallStatus(code);
    // Every distinct Recall status (waiting room, admitted, …) goes on the session timeline for diagnosis.
    if (bot.sessionId && code !== this.lastRecallCode.get(bot.id)) {
      this.lastRecallCode.set(bot.id, code);
      await this.prisma.sessionEvent
        .create({ data: { sessionId: bot.sessionId, type: 'meeting.bot_status', payload: { code, subCode, mapped } } })
        .catch(() => undefined);
    }
    if (!mapped || bot.status === 'CANCELLED') return;
    if (bot.status === mapped && mapped !== 'COMPLETED') return;
    await this.prisma.meetingBot.update({
      where: { id: bot.id },
      data: { status: mapped, lastEventAt: new Date(), ...(mapped === 'FAILED' ? { lastError: `Recall.ai: ${code}${subCode ? ` (${subCode})` : ''}` } : {}) },
    });
    if (!bot.sessionId) return;
    const s = await this.prisma.session.findUnique({ where: { id: bot.sessionId } });
    if (!s || isTerminal(s.state as SessionState)) return;
    if (bot.mode === 'agent') {
      // The bot page drives the session (it starts it once someone speaks); we only react to the end.
      if (mapped === 'COMPLETED') await this.closeAgentSession(s.id, `recall_${code}`);
      else if (mapped === 'FAILED') await this.failAgentSession(s.id, 'meeting_bot_failed', `Recall.ai bot ${code}${subCode ? ` (${subCode})` : ''}`);
      return;
    }
    if (mapped === 'IN_CALL') await transitionMeetingSession(this.prisma, this.events, s.id, 'ACTIVE', `recall_${code}`);
    else if (mapped === 'COMPLETED') {
      const turns = await this.prisma.transcriptTurn.count({ where: { sessionId: s.id } });
      if (turns > 0 || s.startedAt) {
        await transitionMeetingSession(this.prisma, this.events, s.id, 'COMPLETED', `recall_${code}`, { endedBy: 'system' });
        const done = await this.prisma.session.findUnique({ where: { id: s.id } });
        if (done?.durationMs) {
          await this.usage.record({
            workspaceId: s.workspaceId,
            sessionId: s.id,
            kind: 'SESSION_SECONDS',
            provider: 'recall',
            quantity: Math.round(done.durationMs / 1000),
            unit: 'seconds',
            idempotencyKey: `meeting:${s.id}:duration`,
          });
        }
      } else {
        await transitionMeetingSession(this.prisma, this.events, s.id, 'CANCELLED', 'meeting_ended_without_transcript', { endedBy: 'system' });
      }
    } else if (mapped === 'FAILED') {
      await transitionMeetingSession(this.prisma, this.events, s.id, 'FAILED', `recall_${code}`, { errorCode: 'meeting_bot_failed', errorMessage: `Recall.ai bot ${code}${subCode ? ` (${subCode})` : ''}` });
    }
  }

  async schedulePoll(botId: string, delayMs = POLL_INTERVAL_MS) {
    await this.queue.enqueue(QUEUES.channels, 'recall_poll', { botId }, { jobId: `recall_poll_${botId}_${Math.floor((Date.now() + delayMs) / POLL_INTERVAL_MS)}`, delay: delayMs, attempts: 1 });
  }

  /** Poll Recall for the bot status (works without dashboard webhooks); reschedules itself until terminal. */
  async poll(botId: string) {
    const bot = await this.prisma.meetingBot.findUnique({ where: { id: botId } });
    if (!bot || TERMINAL_BOT.has(bot.status) || !bot.providerBotId) return;
    await this.refreshFromRecall(bot);
    const fresh = await this.prisma.meetingBot.findUnique({ where: { id: botId } });
    if (fresh && !TERMINAL_BOT.has(fresh.status)) await this.schedulePoll(botId);
  }

  /** Ask Recall for the bot's latest status and apply it. Returns the Recall status code, if any. */
  private async refreshFromRecall(bot: MeetingBot): Promise<string | null> {
    const creds = await this.providers.recall(bot.workspaceId);
    if (!creds || !bot.providerBotId) return null;
    try {
      const data = await this.recallFetch<any>(creds, 'GET', `/bot/${encodeURIComponent(bot.providerBotId)}/`);
      const changes: Array<{ code: string; sub_code?: string | null }> = Array.isArray(data?.status_changes) ? data.status_changes : [];
      const last = changes[changes.length - 1];
      if (last?.code) await this.applyStatus(bot, last.code, last.sub_code ?? null);
      return last?.code ?? null;
    } catch (e: any) {
      this.logger.warn(`Recall status for ${bot.id} failed: ${e?.message}`);
      return null;
    }
  }

  // ───────────────────────── agent bot page (session token) ─────────────────────────

  private readonly lastRecallCode = new Map<string, string>();
  private readonly lastPageRefresh = new Map<string, number>();

  /**
   * For the agent bot page: is the bot in the meeting yet? The page starts the practice session (and the
   * persona greets) once the bot is admitted. While the bot is joining, Recall is asked directly at most
   * every 3 s instead of waiting for the 60 s poll.
   */
  async botStatusForPage(sessionId: string, token: string) {
    await this.sessions.verifySessionToken(sessionId, token);
    let bot = await this.prisma.meetingBot.findFirst({ where: { sessionId } });
    if (!bot) return { status: null, recallStatus: null };
    let recallStatus = this.lastRecallCode.get(bot.id) ?? null;
    const last = this.lastPageRefresh.get(bot.id) ?? 0;
    if (!TERMINAL_BOT.has(bot.status) && bot.status !== 'IN_CALL' && Date.now() - last > 3000) {
      this.lastPageRefresh.set(bot.id, Date.now());
      recallStatus = (await this.refreshFromRecall(bot)) ?? recallStatus;
      bot = (await this.prisma.meetingBot.findUnique({ where: { id: bot.id } })) ?? bot;
    }
    return { status: bot.status, recallStatus };
  }

  /** Diagnostics from the agent bot page (audio levels, start trigger, errors), kept on the session timeline. */
  async logPageEvent(sessionId: string, token: string, body: { event: string; data?: Record<string, unknown> }) {
    await this.sessions.verifySessionToken(sessionId, token);
    const count = await this.prisma.sessionEvent.count({ where: { sessionId, type: 'bot.page' } });
    if (count >= 120) return { ok: true, dropped: true };
    // Flat, small, primitive values only: this is diagnostics from an unauthenticated-by-user page.
    const data: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(body.data ?? {}).slice(0, 20)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k)) continue;
      if (typeof v === 'number') data[k] = Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
      else if (typeof v === 'boolean' || v === null) data[k] = v;
      else if (typeof v === 'string') data[k] = v.slice(0, 200);
    }
    await this.prisma.sessionEvent.create({ data: { sessionId, type: 'bot.page', payload: { event: body.event.slice(0, 40), data } } });
    return { ok: true };
  }
}

function defaultBotName(mode: MeetingBotMode, personaName: string | undefined) {
  const name = personaName?.trim();
  if (mode === 'agent') return name ? `${name} (AI)` : 'AI practice partner';
  return name ? `${name} (notetaker)` : 'ConversaForge notetaker';
}
