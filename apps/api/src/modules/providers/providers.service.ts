import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ProviderConnection } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { userIdOf } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { LlmService } from '../../common/llm/llm.service';
import { LlmUnavailableError } from '../../common/llm/llm.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  connectionCapabilities,
  normalizeCapabilities,
  primaryKind,
  PROVIDER_IDS,
  PROVIDER_KINDS,
  PROVIDERS,
  ProviderConfigSchema,
  type ProviderConfig,
  type ProviderId,
  type ProviderKind,
} from './provider-catalog';
import { parseTwilioSecret, verifyCredential, type FetchLike, type VerifyOutcome } from './provider-verify';

const Secret = z
  .string()
  .trim()
  .min(8, 'The secret looks too short')
  .max(4096)
  .refine((s) => !/[\s\u0000-\u001F]/.test(s), 'The secret must not contain spaces or control characters');

export const CreateConnectionSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  label: z.string().trim().max(80).optional(),
  secret: Secret,
  config: ProviderConfigSchema.default({}),
  /** Verify right away (default true). A network failure does not block saving. */
  verify: z.boolean().default(true),
});
export type CreateConnectionInput = z.infer<typeof CreateConnectionSchema>;

export const UpdateConnectionSchema = z.object({
  label: z.string().trim().max(80).nullable().optional(),
  config: ProviderConfigSchema.optional(),
});
export type UpdateConnectionInput = z.infer<typeof UpdateConnectionSchema>;

export const RotateSecretSchema = z.object({
  secret: Secret,
  accountSid: ProviderConfigSchema.shape.accountSid,
  verify: z.boolean().default(true),
});
export type RotateSecretInput = z.infer<typeof RotateSecretSchema>;

type CapabilitySource = 'workspace' | 'environment' | 'simulator' | 'browser' | 'unavailable';

export interface CapabilityStatus {
  key: 'live_llm' | 'analysis_llm' | 'realtime_voice' | 'server_tts' | 'server_stt' | 'telephony' | 'meeting_bots' | 'calendar';
  label: string;
  source: CapabilitySource;
  provider: string | null;
  model?: string | null;
  simulated: boolean;
  message: string;
  connectionId?: string | null;
}

/**
 * Workspace "bring your own key" provider connections. Secrets are AES-256-GCM encrypted
 * (CryptoService) and are never returned, logged or audited — responses carry only `secretLast4`.
 */
@Injectable()
export class ProvidersService {
  private readonly logger = new Logger('Providers');
  /** Overridable in tests. */
  fetchImpl: FetchLike = ((url, init) => fetch(url, init)) as FetchLike;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly llm: LlmService,
  ) {}

  catalog() {
    return { providers: Object.values(PROVIDERS), kinds: PROVIDER_KINDS };
  }

  async list(workspaceId: string, includeRevoked = false) {
    const rows = await this.prisma.providerConnection.findMany({
      where: { workspaceId, ...(includeRevoked ? {} : { revokedAt: null }) },
      orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
    });
    return { data: rows.map((r) => this.present(r)) };
  }

  async get(workspaceId: string, id: string) {
    return this.present(await this.find(workspaceId, id));
  }

  async create(workspaceId: string, principal: Principal | null, input: CreateConnectionInput) {
    const provider = input.provider;
    const existing = await this.prisma.providerConnection.findFirst({ where: { workspaceId, provider, revokedAt: null } });
    if (existing) {
      throw Errors.conflict(`This workspace already has a ${PROVIDERS[provider].name} connection. Rotate its key or revoke it first.`, {
        connectionId: existing.id,
      });
    }
    const { config, capabilities } = this.normalizeConfig(provider, input.config);
    const secretPlain = this.secretFor(provider, input.secret, config);
    const conn = await this.prisma.providerConnection.create({
      data: {
        workspaceId,
        provider,
        kind: primaryKind(provider, capabilities),
        label: input.label || null,
        encryptedSecret: this.crypto.encrypt(secretPlain),
        secretLast4: last4(input.secret),
        config: config as Prisma.InputJsonValue,
        status: 'ACTIVE',
        createdById: userIdOf(principal),
      },
    });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'provider.connect',
      targetType: 'ProviderConnection',
      targetId: conn.id,
      metadata: { provider, capabilities, label: conn.label, config: redactConfig(config) },
    });
    if (input.verify) return this.verify(workspaceId, principal, conn.id);
    return { connection: this.present(conn), verification: null };
  }

  async update(workspaceId: string, principal: Principal | null, id: string, input: UpdateConnectionInput) {
    const conn = await this.findActive(workspaceId, id);
    const provider = conn.provider as ProviderId;
    let data: Prisma.ProviderConnectionUpdateInput = {};
    if (input.label !== undefined) data.label = input.label || null;
    if (input.config) {
      const merged = { ...(conn.config as ProviderConfig), ...input.config };
      const { config, capabilities } = this.normalizeConfig(provider, merged);
      data = { ...data, config: config as Prisma.InputJsonValue, kind: primaryKind(provider, capabilities) };
      if (provider === 'twilio' && input.config.accountSid) {
        // Keep the encrypted {accountSid, authToken} in sync with the (non-secret) SID.
        const { authToken } = parseTwilioSecret(this.crypto.decrypt(conn.encryptedSecret), conn.config as ProviderConfig);
        if (authToken) data.encryptedSecret = this.crypto.encrypt(JSON.stringify({ accountSid: input.config.accountSid, authToken }));
      }
    }
    const updated = await this.prisma.providerConnection.update({ where: { id: conn.id }, data });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'provider.update',
      targetType: 'ProviderConnection',
      targetId: conn.id,
      metadata: { provider, label: updated.label, config: redactConfig(updated.config as ProviderConfig) },
    });
    return this.present(updated);
  }

  async rotate(workspaceId: string, principal: Principal | null, id: string, input: RotateSecretInput) {
    const conn = await this.findActive(workspaceId, id);
    const provider = conn.provider as ProviderId;
    const config = { ...(conn.config as ProviderConfig), ...(input.accountSid ? { accountSid: input.accountSid } : {}) };
    const secretPlain = this.secretFor(provider, input.secret, config);
    const updated = await this.prisma.providerConnection.update({
      where: { id: conn.id },
      data: {
        encryptedSecret: this.crypto.encrypt(secretPlain),
        secretLast4: last4(input.secret),
        config: config as Prisma.InputJsonValue,
        status: 'ACTIVE',
        lastVerifiedAt: null,
      },
    });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'provider.rotate',
      targetType: 'ProviderConnection',
      targetId: conn.id,
      metadata: { provider, secretLast4: updated.secretLast4 },
    });
    if (input.verify) return this.verify(workspaceId, principal, conn.id);
    return { connection: this.present(updated), verification: null };
  }

  /** Revoke: stop using the connection and wipe the stored secret. */
  async revoke(workspaceId: string, principal: Principal | null, id: string) {
    const conn = await this.findActive(workspaceId, id);
    const updated = await this.prisma.providerConnection.update({
      where: { id: conn.id },
      data: { status: 'REVOKED', revokedAt: new Date(), encryptedSecret: REVOKED_SECRET },
    });
    await this.audit.log({ workspaceId, principal, action: 'provider.revoke', targetType: 'ProviderConnection', targetId: conn.id, metadata: { provider: conn.provider } });
    return this.present(updated);
  }

  async verify(workspaceId: string, principal: Principal | null, id: string): Promise<{ connection: ReturnType<ProvidersService['present']>; verification: VerifyOutcome }> {
    const conn = await this.findActive(workspaceId, id);
    const provider = conn.provider as ProviderId;
    let secret: string;
    try {
      secret = this.crypto.decrypt(conn.encryptedSecret);
    } catch {
      const updated = await this.prisma.providerConnection.update({ where: { id: conn.id }, data: { status: 'INVALID', lastVerifiedAt: new Date() } });
      return {
        connection: this.present(updated),
        verification: { result: 'error', httpStatus: null, message: 'The stored secret could not be decrypted (was ENCRYPTION_KEY changed?). Rotate the key.' },
      };
    }
    const outcome = await verifyCredential(provider, secret, conn.config as ProviderConfig, this.fetchImpl);
    const data: Prisma.ProviderConnectionUpdateInput = {};
    if (outcome.result === 'valid') Object.assign(data, { status: 'ACTIVE', lastVerifiedAt: new Date() });
    else if (outcome.result === 'invalid') Object.assign(data, { status: 'INVALID', lastVerifiedAt: new Date() });
    // 'error' (network/5xx/429) and 'unsupported' leave the status unchanged.
    const updated = Object.keys(data).length ? await this.prisma.providerConnection.update({ where: { id: conn.id }, data }) : conn;
    await this.audit.log({
      workspaceId,
      principal,
      action: 'provider.verify',
      targetType: 'ProviderConnection',
      targetId: conn.id,
      metadata: { provider, result: outcome.result, httpStatus: outcome.httpStatus },
    });
    return { connection: this.present(updated), verification: outcome };
  }

  /** Which source serves each capability right now (for the settings page). */
  async status(workspaceId: string): Promise<{ capabilities: CapabilityStatus[]; simulatorAllowed: boolean; availability: Record<string, boolean> }> {
    const availability = await this.llm.availability(workspaceId);
    const conns = await this.prisma.providerConnection.findMany({
      where: { workspaceId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const active = (provider: ProviderId, cap: ProviderKind) =>
      conns.find((c) => c.provider === provider && c.status === 'ACTIVE' && connectionCapabilities(c).includes(cap)) ?? null;
    const invalid = (provider: ProviderId) => conns.find((c) => c.provider === provider && c.status === 'INVALID') ?? null;

    const out: CapabilityStatus[] = [];

    for (const [key, purpose, label] of [
      ['live_llm', 'live', 'Live conversations'],
      ['analysis_llm', 'analysis', 'Scoring & analysis'],
    ] as const) {
      try {
        const r = await this.llm.resolve(workspaceId, purpose);
        const conn = r.source === 'workspace' ? active(r.provider.id as ProviderId, 'LLM') : null;
        out.push({
          key,
          label,
          source: r.source,
          provider: r.simulated ? 'simulator' : r.provider.id,
          model: r.model,
          simulated: r.simulated,
          connectionId: conn?.id ?? null,
          message: r.simulated
            ? `Simulator (no key) — add an Anthropic or OpenAI key for real ${purpose === 'live' ? 'conversations' : 'analysis'}.${this.invalidNote(conns, ['anthropic', 'openai'])}`
            : `${PROVIDERS[r.provider.id as ProviderId]?.name ?? r.provider.id} · ${r.model} (${r.source === 'workspace' ? 'workspace key' : 'server key'})`,
        });
      } catch (e) {
        if (!(e instanceof LlmUnavailableError)) throw e;
        out.push({ key, label, source: 'unavailable', provider: null, simulated: false, message: e.message });
      }
    }

    const pick = (candidates: Array<{ provider: ProviderId; cap: ProviderKind; envKey: boolean }>) => {
      for (const c of candidates) {
        const conn = active(c.provider, c.cap);
        if (conn) return { source: 'workspace' as const, provider: c.provider, connectionId: conn.id, conn };
      }
      for (const c of candidates) if (c.envKey) return { source: 'environment' as const, provider: c.provider, connectionId: null, conn: null };
      return null;
    };
    const openaiEnv = !!env.OPENAI_API_KEY;

    const realtime = pick([{ provider: 'openai', cap: 'REALTIME', envKey: openaiEnv }]);
    out.push(
      realtime
        ? {
            key: 'realtime_voice',
            label: 'Realtime voice',
            source: realtime.source,
            provider: 'openai',
            model: ((realtime.conn?.config as ProviderConfig | undefined)?.realtimeModel ?? env.OPENAI_REALTIME_MODEL) || null,
            simulated: false,
            connectionId: realtime.connectionId,
            message: `OpenAI Realtime (${realtime.source === 'workspace' ? 'workspace key' : 'server key'})`,
          }
        : {
            key: 'realtime_voice',
            label: 'Realtime voice',
            source: 'unavailable',
            provider: null,
            simulated: false,
            message: `Not configured — sessions use the speech pipeline (browser speech + LLM). Add an OpenAI key to enable realtime voice.${this.invalidNote(conns, ['openai'])}`,
          },
    );

    const tts = pick([
      { provider: 'openai', cap: 'TTS', envKey: openaiEnv },
      { provider: 'elevenlabs', cap: 'TTS', envKey: !!env.ELEVENLABS_API_KEY },
      { provider: 'deepgram', cap: 'TTS', envKey: false },
    ]);
    out.push(
      tts
        ? { key: 'server_tts', label: 'Server text-to-speech', source: tts.source, provider: tts.provider, simulated: false, connectionId: tts.connectionId, message: `${PROVIDERS[tts.provider].name} (${tts.source === 'workspace' ? 'workspace key' : 'server key'})` }
        : {
            key: 'server_tts',
            label: 'Server text-to-speech',
            source: 'browser',
            provider: null,
            simulated: false,
            message: 'Browser speech synthesis (no server key). Add an OpenAI or ElevenLabs key for natural voices and phone calls.',
          },
    );

    const stt = pick([
      { provider: 'openai', cap: 'STT', envKey: openaiEnv },
      { provider: 'deepgram', cap: 'STT', envKey: !!env.DEEPGRAM_API_KEY },
      { provider: 'elevenlabs', cap: 'STT', envKey: false },
    ]);
    out.push(
      stt
        ? { key: 'server_stt', label: 'Server speech-to-text', source: stt.source, provider: stt.provider, simulated: false, connectionId: stt.connectionId, message: `${PROVIDERS[stt.provider].name} (${stt.source === 'workspace' ? 'workspace key' : 'server key'})` }
        : {
            key: 'server_stt',
            label: 'Server speech-to-text',
            source: 'browser',
            provider: null,
            simulated: false,
            message: 'Browser speech recognition / typed input (no server key). Add an OpenAI or Deepgram key for accurate transcripts and phone calls.',
          },
    );

    const tel = pick([{ provider: 'twilio', cap: 'TELEPHONY', envKey: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) }]);
    out.push(
      tel
        ? { key: 'telephony', label: 'Phone calls', source: tel.source, provider: 'twilio', simulated: false, connectionId: tel.connectionId, message: `Twilio (${tel.source === 'workspace' ? 'workspace credentials' : 'server credentials'})` }
        : { key: 'telephony', label: 'Phone calls', source: 'unavailable', provider: null, simulated: false, message: `Unavailable — add Twilio credentials to enable phone channels.${this.invalidNote(conns, ['twilio'])}` },
    );

    const meet = pick([{ provider: 'recall', cap: 'MEETING', envKey: !!env.RECALL_API_KEY }]);
    out.push(
      meet
        ? { key: 'meeting_bots', label: 'Meeting bots', source: meet.source, provider: 'recall', simulated: false, connectionId: meet.connectionId, message: `Recall.ai (${meet.source === 'workspace' ? 'workspace key' : 'server key'})` }
        : { key: 'meeting_bots', label: 'Meeting bots', source: 'unavailable', provider: null, simulated: false, message: `Unavailable — add a Recall.ai key to send agents into Zoom/Meet/Teams.${this.invalidNote(conns, ['recall'])}` },
    );

    const cal = pick([{ provider: 'google_calendar', cap: 'CALENDAR', envKey: false }]);
    out.push(
      cal
        ? { key: 'calendar', label: 'Calendar', source: 'workspace', provider: 'google_calendar', simulated: false, connectionId: cal.connectionId, message: 'Google Calendar (workspace credential)' }
        : { key: 'calendar', label: 'Calendar', source: 'unavailable', provider: null, simulated: false, message: 'Not connected.' },
    );

    return { capabilities: out, simulatorAllowed: env.ALLOW_SIMULATOR, availability };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private invalidNote(conns: ProviderConnection[], providers: string[]): string {
    const bad = conns.filter((c) => providers.includes(c.provider) && c.status === 'INVALID');
    return bad.length ? ` (${bad.map((c) => PROVIDERS[c.provider as ProviderId]?.name ?? c.provider).join(', ')} key is invalid — rotate it.)` : '';
  }

  private normalizeConfig(provider: ProviderId, raw: ProviderConfig) {
    const parsed = ProviderConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) throw Errors.validation('Invalid provider config', parsed.error.issues.map((i) => ({ path: `config.${i.path.join('.')}`, message: i.message })));
    const cfg = parsed.data;
    const capabilities = normalizeCapabilities(provider, cfg.capabilities);
    if (!capabilities.length) throw Errors.validation(`Select at least one capability supported by ${PROVIDERS[provider].name}`);
    // Keep only fields meaningful for the provider.
    const keep: Record<ProviderId, Array<keyof ProviderConfig>> = {
      anthropic: ['liveModel', 'analysisModel'],
      openai: ['liveModel', 'analysisModel', 'realtimeModel', 'ttsModel', 'sttModel', 'voice'],
      deepgram: ['ttsModel', 'sttModel', 'voice'],
      elevenlabs: ['ttsModel', 'sttModel', 'voice'],
      twilio: ['accountSid', 'phoneNumber'],
      recall: ['region'],
      google_calendar: [],
    };
    const config: ProviderConfig = { capabilities };
    for (const k of keep[provider]) if (cfg[k] !== undefined) (config as any)[k] = cfg[k];
    if (provider === 'recall' && !config.region) config.region = env.RECALL_REGION as ProviderConfig['region'];
    return { config, capabilities };
  }

  /** Twilio: store JSON {accountSid, authToken}; everything else: the raw key. */
  private secretFor(provider: ProviderId, secret: string, config: ProviderConfig): string {
    if (provider !== 'twilio') return secret;
    const parsed = parseTwilioSecret(secret, config);
    const accountSid = parsed.accountSid ?? config.accountSid;
    if (!accountSid || !/^AC[a-fA-F0-9]{32}$/.test(accountSid)) {
      throw Errors.validation('Twilio needs the Account SID (config.accountSid, AC followed by 32 hex characters)');
    }
    config.accountSid = accountSid;
    return JSON.stringify({ accountSid, authToken: parsed.authToken ?? secret });
  }

  private async find(workspaceId: string, id: string) {
    if (!id || id.length > 64) throw Errors.notFound('Provider connection');
    const conn = await this.prisma.providerConnection.findFirst({ where: { id, workspaceId } });
    if (!conn) throw Errors.notFound('Provider connection');
    return conn;
  }

  private async findActive(workspaceId: string, id: string) {
    const conn = await this.find(workspaceId, id);
    if (conn.revokedAt) throw Errors.gone('This connection has been revoked');
    return conn;
  }

  /** Public shape: NEVER includes encryptedSecret or the plaintext. */
  present(c: ProviderConnection) {
    const info = PROVIDERS[c.provider as ProviderId];
    return {
      id: c.id,
      provider: c.provider,
      providerName: info?.name ?? c.provider,
      kind: c.kind,
      capabilities: connectionCapabilities(c),
      label: c.label,
      secretLast4: c.secretLast4,
      config: c.config as ProviderConfig,
      status: c.status,
      lastVerifiedAt: c.lastVerifiedAt,
      createdById: c.createdById,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      revokedAt: c.revokedAt,
    };
  }
}

/** Stored in place of the ciphertext after revocation (the secret itself is gone). */
export const REVOKED_SECRET = 'revoked';

function last4(secret: string): string {
  const s = secret.trim();
  return s.length >= 12 ? s.slice(-4) : '';
}

function redactConfig(c: ProviderConfig): Record<string, unknown> {
  const { accountSid, ...rest } = c ?? {};
  return { ...rest, ...(accountSid ? { accountSid: `${accountSid.slice(0, 6)}…` } : {}) };
}
