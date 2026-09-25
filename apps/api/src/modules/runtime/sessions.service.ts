import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Participant, type Session } from '@prisma/client';
import {
  ScenarioConfigSchema,
  resolveVariables,
  type Channel,
  type ScenarioConfig,
} from '@cf/shared';
import { env } from '../../config/env';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { initialRuntimeState, type ConsentRecord } from './runtime.types';
import { ProviderResolverService } from './voice/provider-resolver.service';

export const SESSION_TOKEN_PREFIX = 'cfs_';
/** How long a participant session token stays valid (bootstrap, resume after refresh, uploads). */
export const SESSION_TOKEN_TTL_MS = 24 * 3600_000;

export interface CreateSessionInput {
  workspaceId: string;
  scenarioId: string;
  /** Pinned version; default = the scenario's latest published version. */
  versionId?: string | null;
  channel: Channel;
  participant: { userId?: string | null; email?: string | null; name?: string | null; externalId?: string | null };
  /** Raw variables; resolved against the version's allowlist (later sources win over defaults). */
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  shareLinkId?: string;
  accessTokenId?: string;
  enrollmentId?: string;
  courseItemAttemptId?: string;
  coachMode?: boolean;
  /**
   * Optional (additive): consent already collected by the caller (e.g. a phone greeting or an API
   * integration). When given, the session starts in READY instead of CREATED.
   */
  consent?: { recordAudio: boolean; recordVideo: boolean; analysis: boolean; source?: string };
  /** Optional (additive): external reference such as a telephony call sid. */
  externalRef?: string;
}

export interface LoadedSession {
  session: Session;
  config: ScenarioConfig;
  scenario: { id: string; name: string; publicDescription: string | null; type: string };
  version: { id: string; version: number };
}

/**
 * Creates and authenticates live sessions. This is the cross-workstream entry point
 * (share links, embeds, courses, API, phone all call createSession).
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger('Sessions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly usage: UsageService,
    private readonly providers: ProviderResolverService,
  ) {}

  async createSession(input: CreateSessionInput): Promise<{ session: Session; sessionToken: string }> {
    const { workspaceId, scenarioId } = input;
    const workspace = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } });
    if (!workspace) throw Errors.notFound('Workspace');
    const scenario = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!scenario) throw Errors.notFound('Scenario');
    if (scenario.archivedAt || scenario.status === 'ARCHIVED') throw Errors.conflict('Scenario is archived');

    const versionId = input.versionId || scenario.latestVersionId;
    if (!versionId) throw Errors.conflict('Scenario has no published version');
    const version = await this.prisma.scenarioVersion.findFirst({ where: { id: versionId, scenarioId, workspaceId } });
    if (!version) {
      if (input.versionId) throw Errors.notFound('Scenario version');
      throw Errors.conflict('Scenario has no published version');
    }
    const config = parseVersionConfig(version.config);

    // Variables: allowlist only, sanitized; participant_name is filled from the participant when allowlisted.
    const allowlist = config.variables.allowlist;
    const name = input.participant.name?.trim() || null;
    const implicit: Record<string, unknown> = {};
    if (name && allowlist.some((v) => v.key === 'participant_name')) implicit.participant_name = name;
    const resolved = resolveVariables(allowlist, implicit, input.variables ?? {});
    if (resolved.errors.length) {
      throw Errors.validation(
        `Missing or invalid variables: ${resolved.errors.map((e) => e.key).join(', ')}`,
        resolved.errors.map((e) => ({ path: `variables.${e.key}`, message: e.message })),
      );
    }

    await this.usage.assertWithinQuota(workspaceId);

    const settings = (workspace.settings ?? {}) as Record<string, unknown>;
    const wsMax = typeof settings.maxSessionMinutes === 'number' ? settings.maxSessionMinutes : env.DEFAULT_MAX_SESSION_MINUTES;
    const maxDurationSec = Math.max(60, Math.round(Math.min(config.conversation.ending.maxDurationMinutes, wsMax) * 60));

    const providerInfo = await this.providers.resolve(workspaceId, config, { channel: input.channel, workspaceSettings: settings });

    const participant = await this.upsertParticipant(workspaceId, input.participant);

    const sessionToken = SESSION_TOKEN_PREFIX + this.crypto.randomToken(32);
    const consent: ConsentRecord | null = input.consent
      ? {
          recordAudio: !!input.consent.recordAudio && config.recording.audio,
          recordVideo: !!input.consent.recordVideo && config.recording.video,
          analysis: !!input.consent.analysis,
          acceptedAt: new Date().toISOString(),
          noticeVersion: this.noticeVersion(config),
          source: input.consent.source ?? 'caller',
        }
      : null;

    const session = await this.prisma.session.create({
      data: {
        workspaceId,
        scenarioId,
        scenarioVersionId: version.id,
        participantId: participant.id,
        channel: input.channel,
        state: consent ? 'READY' : 'CREATED',
        shareLinkId: input.shareLinkId ?? null,
        accessTokenId: input.accessTokenId ?? null,
        enrollmentId: input.enrollmentId ?? null,
        courseItemAttemptId: input.courseItemAttemptId ?? null,
        coachMode: !!input.coachMode,
        variables: resolved.values,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        consent: (consent ?? {}) as unknown as Prisma.InputJsonValue,
        providerInfo: providerInfo as unknown as Prisma.InputJsonValue,
        runtimeState: initialRuntimeState() as unknown as Prisma.InputJsonValue,
        resumeTokenHash: this.crypto.sha256(sessionToken),
        resumeExpiresAt: new Date(Date.now() + SESSION_TOKEN_TTL_MS),
        maxDurationSec,
        externalRef: input.externalRef ?? null,
      },
    });
    await this.prisma.sessionEvent.create({
      data: {
        sessionId: session.id,
        type: 'session.created',
        payload: {
          channel: input.channel,
          scenarioVersionId: version.id,
          version: version.version,
          providerInfo,
          rejectedVariableKeys: resolved.rejectedKeys,
          consentPrefilled: !!consent,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    this.logger.log(
      `Session ${session.id} created (ws ${workspaceId}, scenario ${scenarioId} v${version.version}, ${providerInfo.voiceMode}/${providerInfo.llm.provider}${providerInfo.simulated ? ' SIMULATED' : ''})`,
    );
    return { session, sessionToken };
  }

  /** Constant-time token check. Throws 404 for unknown sessions and 401 for bad/expired tokens. */
  async verifySessionToken(sessionId: string, token: string): Promise<Session> {
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) throw Errors.notFound('Session');
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.deletedAt) throw Errors.notFound('Session');
    if (typeof token !== 'string' || !token.startsWith(SESSION_TOKEN_PREFIX) || token.length > 200 || !session.resumeTokenHash) {
      throw Errors.unauthorized('Invalid session token');
    }
    if (!this.crypto.safeEqual(this.crypto.sha256(token), session.resumeTokenHash)) throw Errors.unauthorized('Invalid session token');
    if (session.resumeExpiresAt && session.resumeExpiresAt < new Date()) throw Errors.unauthorized('Session token has expired');
    return session;
  }

  /** Load a session together with its immutable scenario version config (tenant-scoped by the session). */
  async load(sessionId: string): Promise<LoadedSession> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.deletedAt) throw Errors.notFound('Session');
    const version = await this.prisma.scenarioVersion.findFirst({
      where: { id: session.scenarioVersionId, workspaceId: session.workspaceId },
    });
    const scenario = await this.prisma.scenario.findFirst({
      where: { id: session.scenarioId, workspaceId: session.workspaceId },
      select: { id: true, name: true, publicDescription: true, type: true },
    });
    if (!version || !scenario) throw Errors.notFound('Scenario version');
    return { session, config: parseVersionConfig(version.config), scenario, version: { id: version.id, version: version.version } };
  }

  noticeVersion(config: ScenarioConfig): string {
    const basis = JSON.stringify({
      n: config.recording.consentNotice,
      a: config.recording.audio,
      v: config.recording.video,
      an: config.analysis.enabled,
      r: config.recording.retentionDays,
    });
    return this.crypto.sha256(basis).slice(0, 16);
  }

  private async upsertParticipant(
    workspaceId: string,
    p: CreateSessionInput['participant'],
  ): Promise<Participant> {
    const email = p.email?.trim().toLowerCase().slice(0, 320) || null;
    const name = p.name?.trim().slice(0, 200) || null;
    const externalId = p.externalId?.trim().slice(0, 200) || null;
    const userId = p.userId || null;

    const update = (existing: Participant) => {
      const data: Prisma.ParticipantUpdateInput = {};
      if (name && name !== existing.name) data.name = name;
      if (email && !existing.email) data.email = email;
      if (userId && !existing.userId) data.user = { connect: { id: userId } };
      if (existing.deletedAt) data.deletedAt = null;
      return Object.keys(data).length ? this.prisma.participant.update({ where: { id: existing.id }, data }) : existing;
    };

    if (externalId) {
      try {
        return await this.prisma.participant.upsert({
          where: { workspaceId_externalId: { workspaceId, externalId } },
          create: { workspaceId, externalId, email, name, userId },
          update: {
            ...(name ? { name } : {}),
            ...(email ? { email } : {}),
            deletedAt: null,
          },
        });
      } catch (e) {
        // Concurrent create of the same externalId: re-read.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const again = await this.prisma.participant.findFirst({ where: { workspaceId, externalId } });
          if (again) return again;
        }
        throw e;
      }
    }
    if (userId) {
      const byUser = await this.prisma.participant.findFirst({ where: { workspaceId, userId }, orderBy: { createdAt: 'asc' } });
      if (byUser) return update(byUser);
    }
    if (email) {
      // An email typed on a public/share link is NOT verified. Anonymous runs may only reuse other
      // anonymous (unclaimed, no externalId) participants with that email — never an account-linked
      // participant, whose coach memory and history must not be exposed to whoever types their email.
      // Kept in sync with courses/participants.ts (participantForUser).
      const byEmail = await this.prisma.participant.findFirst({
        where: userId
          ? { workspaceId, email, userId: null }
          : { workspaceId, email, userId: null, externalId: null },
        orderBy: { createdAt: 'asc' },
      });
      if (byEmail) return update(byEmail);
    }
    return this.prisma.participant.create({ data: { workspaceId, email, name, userId } });
  }
}

export function parseVersionConfig(raw: unknown): ScenarioConfig {
  const parsed = ScenarioConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw Errors.conflict('Scenario version configuration is invalid');
  return parsed.data;
}
