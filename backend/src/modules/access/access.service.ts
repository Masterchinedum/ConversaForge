import { Injectable, Logger } from '@nestjs/common';
import type { AccessToken, Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppError, Errors } from '../../common/http/errors';
import { toPage, prismaPageArgs, PaginationQuery } from '../../common/http/pagination';
import { MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { BrandingService } from '../admin/branding.service';
import { SessionsService } from '../runtime/sessions.service';
import {
  assertAllowlistedKeys,
  DEFAULT_TOKEN_TTL_SECONDS,
  EMBED_TOKEN_PREFIX,
  gone,
  identityNeedsName,
  loadRunnableScenario,
  MAX_TOKEN_TTL_SECONDS,
  normalizeOrigin,
  PARTICIPANT_TOKEN_PREFIX,
  participantVariableFields,
  pickAllowlisted,
  precheckVariables,
  publicScenarioInfo,
  VariablesInput,
} from './access.util';

export const MintTokenInput = z
  .object({
    scenarioId: z.string().min(1).max(64),
    pinnedVersionId: z.string().max(64).nullable().optional(),
    purpose: z.enum(['EMBED', 'PARTICIPANT']).default('EMBED'),
    participant: z
      .object({
        externalId: z.string().trim().max(200).nullable().optional(),
        email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
        name: z.string().trim().max(120).nullable().optional(),
      })
      .default({}),
    variables: z.record(z.string().max(2000)).default({}),
    metadata: z
      .record(z.unknown())
      .default({})
      .refine((m) => JSON.stringify(m).length <= 8000, 'metadata must be at most 8 KB of JSON'),
    allowedOrigins: z.array(z.string().max(300)).max(20).default([]),
    maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
    expiresInSeconds: z.number().int().min(60).max(MAX_TOKEN_TTL_SECONDS).default(DEFAULT_TOKEN_TTL_SECONDS),
    /** PARTICIPANT tokens only: email the invitation link to participant.email. */
    sendEmail: z.boolean().optional(),
  })
  .strict();
export type MintTokenInput = z.input<typeof MintTokenInput>;

export const EmbedStartBody = z
  .object({
    /** Origin of the page embedding our iframe, as reported by the embed frame (see trust model). */
    parentOrigin: z.string().max(300).optional().nullable(),
    variables: VariablesInput,
  })
  .strict();
export type EmbedStartBody = z.infer<typeof EmbedStartBody>;

export const ParticipantStartBody = z.object({ name: z.string().max(120).optional().nullable(), variables: VariablesInput }).strict();

export function tokenStatus(t: Pick<AccessToken, 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>, now = new Date()) {
  if (t.revokedAt) return 'revoked' as const;
  if (t.expiresAt <= now) return 'expired' as const;
  if (t.maxUses != null && t.useCount >= t.maxUses) return 'exhausted' as const;
  return 'active' as const;
}

/**
 * Server-minted access tokens:
 *  - `cfe_…` EMBED tokens authorize the embeddable widget to start sessions (origin-restricted).
 *  - `cfp_…` PARTICIPANT tokens are personal invitation links (/r/t/<token>), single-use by default.
 * Only a SHA-256 hash and a short display prefix are stored.
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger('Access');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly mail: MailService,
    private readonly sessions: SessionsService,
    private readonly branding: BrandingService,
  ) {}

  toDto(t: AccessToken) {
    return {
      id: t.id,
      scenarioId: t.scenarioId,
      pinnedVersionId: t.pinnedVersionId,
      purpose: t.purpose,
      prefix: t.prefix,
      participant: { externalId: t.participantExternalId, email: t.participantEmail, name: t.participantName },
      variables: t.variables,
      metadata: t.metadata,
      allowedOrigins: t.allowedOrigins,
      maxUses: t.maxUses,
      useCount: t.useCount,
      expiresAt: t.expiresAt,
      revokedAt: t.revokedAt,
      createdAt: t.createdAt,
      status: tokenStatus(t),
    };
  }

  /** Exported for workstream H (`POST /api/v1/access-tokens`). The plaintext token is returned once. */
  async mintToken(workspaceId: string, raw: MintTokenInput, actor: Principal | null) {
    const input = MintTokenInput.parse(raw);
    const scenario = await this.prisma.scenario.findFirst({ where: { id: input.scenarioId, workspaceId, deletedAt: null } });
    if (!scenario) throw Errors.notFound('Scenario');
    if (input.pinnedVersionId) {
      const v = await this.prisma.scenarioVersion.findFirst({ where: { id: input.pinnedVersionId, scenarioId: scenario.id, workspaceId } });
      if (!v) throw Errors.validation('The pinned version does not belong to this scenario', [{ path: 'pinnedVersionId', message: 'Unknown version' }]);
    }
    const r = await loadRunnableScenario(this.prisma, workspaceId, scenario.id, input.pinnedVersionId).catch(() => {
      throw Errors.validation('Publish the scenario before creating access tokens', [{ path: 'scenarioId', message: 'No runnable version' }]);
    });
    if (input.purpose === 'EMBED' && !r.config.channels.embed.enabled) {
      throw Errors.validation('Embedding is disabled for this scenario (Channels → Embed)', [{ path: 'scenarioId', message: 'Embed channel disabled' }]);
    }
    assertAllowlistedKeys(r.config, input.variables, 'variables');
    const origins: string[] = [];
    for (const o of input.allowedOrigins) {
      const n = normalizeOrigin(o);
      if (!n) throw Errors.validation(`Invalid origin "${o}" — use scheme://host[:port] with no path`, [{ path: 'allowedOrigins', message: 'Invalid origin' }]);
      if (!origins.includes(n)) origins.push(n);
    }
    if (input.purpose === 'PARTICIPANT' && input.sendEmail && !input.participant.email) {
      throw Errors.validation('An email address is required to send the invitation', [{ path: 'participant.email', message: 'Required' }]);
    }

    const prefix = input.purpose === 'EMBED' ? EMBED_TOKEN_PREFIX : PARTICIPANT_TOKEN_PREFIX;
    const token = prefix + this.crypto.randomToken(32);
    const row = await this.prisma.accessToken.create({
      data: {
        workspaceId,
        scenarioId: scenario.id,
        pinnedVersionId: input.pinnedVersionId ?? null,
        purpose: input.purpose,
        tokenHash: this.crypto.sha256(token),
        prefix: token.slice(0, 12),
        participantExternalId: input.participant.externalId || null,
        participantEmail: input.participant.email || null,
        participantName: input.participant.name || null,
        variables: input.variables as Prisma.InputJsonValue,
        metadata: input.metadata as Prisma.InputJsonValue,
        allowedOrigins: origins,
        // Personal invitation links are single-use unless the caller says otherwise.
        maxUses: input.maxUses !== undefined ? input.maxUses : input.purpose === 'PARTICIPANT' ? 1 : null,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        createdById: actor?.kind === 'user' ? actor.userId : null,
        createdByApiKeyId: actor?.kind === 'apiKey' ? actor.apiKeyId : null,
      },
    });
    const url = input.purpose === 'PARTICIPANT' ? `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/r/t/${token}` : null;
    await this.audit.log({
      workspaceId,
      principal: actor,
      action: 'access_token.created',
      targetType: 'access_token',
      targetId: row.id,
      metadata: { scenarioId: scenario.id, purpose: row.purpose, prefix: row.prefix, allowedOrigins: origins, maxUses: row.maxUses, expiresAt: row.expiresAt },
    });
    let emailed = false;
    if (url && input.sendEmail && row.participantEmail) {
      const b = await this.branding.publicBranding(workspaceId);
      const name = r.config.basics.name || scenario.name;
      await this.mail.send({
        to: row.participantEmail,
        subject: `${b.displayName} invited you to "${name}"`,
        text: `Hello${row.participantName ? ` ${row.participantName}` : ''},\n\n${b.displayName} invited you to a conversation: ${name}.\n\nStart here (personal link, do not share): ${url}\n\nThis link expires on ${row.expiresAt.toUTCString()}.${b.supportEmail ? `\n\nQuestions? ${b.supportEmail}` : ''}`,
      });
      emailed = true;
    }
    return { token, url, emailed, accessToken: this.toDto(row) };
  }

  async list(workspaceId: string, q: PaginationQuery & { scenarioId?: string; purpose?: 'EMBED' | 'PARTICIPANT' }) {
    const rows = await this.prisma.accessToken.findMany({
      where: { workspaceId, ...(q.scenarioId ? { scenarioId: q.scenarioId } : {}), ...(q.purpose ? { purpose: q.purpose } : {}) },
      ...prismaPageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return { data: page.data.map((t) => this.toDto(t)), nextCursor: page.nextCursor };
  }

  async revoke(workspaceId: string, id: string, actor: Principal) {
    const t = await this.prisma.accessToken.findFirst({ where: { id, workspaceId } });
    if (!t) throw Errors.notFound('Access token');
    if (t.revokedAt) return this.toDto(t);
    const row = await this.prisma.accessToken.update({ where: { id: t.id }, data: { revokedAt: new Date() } });
    await this.audit.log({ workspaceId, principal: actor, action: 'access_token.revoked', targetType: 'access_token', targetId: t.id, metadata: { prefix: t.prefix, purpose: t.purpose } });
    return this.toDto(row);
  }

  // ───────────────────────── use time ─────────────────────────

  /** Resolve a bearer token and check it is usable right now (revocation/expiry/uses at use time). */
  async resolveBearer(authorization: string | undefined, purpose: 'EMBED' | 'PARTICIPANT'): Promise<AccessToken> {
    const prefix = purpose === 'EMBED' ? EMBED_TOKEN_PREFIX : PARTICIPANT_TOKEN_PREFIX;
    const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!raw.startsWith(prefix) || raw.length > 200) throw Errors.unauthorized(`A valid ${prefix}… token is required`);
    const t = await this.prisma.accessToken.findUnique({ where: { tokenHash: this.crypto.sha256(raw) } });
    if (!t || t.purpose !== purpose || !t.scenarioId) throw Errors.unauthorized('Invalid access token');
    this.assertTokenUsable(t);
    return t;
  }

  private assertTokenUsable(t: AccessToken) {
    const s = tokenStatus(t);
    if (s === 'revoked') throw gone('token_revoked', 'This access link has been revoked.');
    if (s === 'expired') throw gone('token_expired', 'This access link has expired.');
    if (s === 'exhausted') throw gone('token_exhausted', t.maxUses === 1 ? 'This personal link has already been used.' : 'This access link has reached its maximum number of uses.');
  }

  /**
   * Origin enforcement for embed tokens (see docs/embed.md, "Trust model"):
   *  - Direct calls from a customer page carry that page's Origin → must be in allowedOrigins.
   *  - Calls from our own iframe carry OUR origin; the frame reports the embedding page's origin as
   *    `parentOrigin` (from the postMessage handshake / ancestorOrigins), which must be in allowedOrigins.
   * This stops a leaked token from being used on unauthorized sites through the browser. It is not a
   * defense against non-browser clients (which can forge headers); tokens are therefore short-lived,
   * minted server-side, optionally single-use and revocable.
   */
  checkOrigin(t: AccessToken, requestOrigin: string | undefined, parentOrigin: string | null | undefined): string | null {
    if (!t.allowedOrigins.length) return null;
    const ours = new Set([new URL(env.WEB_PUBLIC_URL).origin, new URL(env.API_PUBLIC_URL).origin]);
    const reqO = requestOrigin ? normalizeOrigin(requestOrigin) : null;
    const effective = reqO && !ours.has(reqO) ? reqO : parentOrigin ? normalizeOrigin(parentOrigin) : null;
    if (!effective || !t.allowedOrigins.includes(effective)) {
      throw new AppError(403, 'origin_not_allowed', 'This embed is not allowed on this website.', { origin: effective });
    }
    return effective;
  }

  async embedTokenInfo(authorization: string | undefined, ip: string) {
    await this.rateLimit.enforce(`embed:info:ip:${ip}`, 600, 3600);
    const t = await this.resolveBearer(authorization, 'EMBED');
    const r = await loadRunnableScenario(this.prisma, t.workspaceId, t.scenarioId!, t.pinnedVersionId);
    if (!r.config.channels.embed.enabled) throw gone('scenario_unavailable', 'Embedding is disabled for this conversation.');
    return {
      scenario: publicScenarioInfo(r, (t.variables ?? {}) as Record<string, unknown>),
      allowedOrigins: t.allowedOrigins,
      expiresAt: t.expiresAt,
      participant: { name: t.participantName, hasEmail: !!t.participantEmail },
      variables: participantVariableFields(r.config, (t.variables ?? {}) as Record<string, unknown>),
      branding: await this.branding.publicBranding(t.workspaceId),
    };
  }

  /** Atomically consume one use of a token (conditional update; safe under concurrency). */
  private async consume(t: AccessToken) {
    const now = new Date();
    const res = await this.prisma.accessToken.updateMany({
      where: {
        id: t.id,
        revokedAt: null,
        expiresAt: { gt: now },
        OR: [{ maxUses: null }, { useCount: { lt: this.prisma.accessToken.fields.maxUses } }],
      },
      data: { useCount: { increment: 1 } },
    });
    if (res.count === 0) {
      const fresh = await this.prisma.accessToken.findUnique({ where: { id: t.id } });
      this.assertTokenUsable(fresh ?? t);
      throw gone('token_exhausted', 'This access link has reached its maximum number of uses.');
    }
  }

  private async giveBack(t: AccessToken) {
    await this.prisma.accessToken.updateMany({ where: { id: t.id, useCount: { gt: 0 } }, data: { useCount: { decrement: 1 } } }).catch(() => undefined);
  }

  async startEmbedSession(authorization: string | undefined, origin: string | undefined, body: EmbedStartBody, ip: string) {
    await this.rateLimit.enforce(`embed:run:ip:${ip}`, Math.max(env.PUBLIC_RUN_RATE_LIMIT_PER_HOUR, 60), 3600, 'Too many sessions started from your network. Please try again later.');
    const t = await this.resolveBearer(authorization, 'EMBED');
    const effectiveOrigin = this.checkOrigin(t, origin, body.parentOrigin);
    const r = await loadRunnableScenario(this.prisma, t.workspaceId, t.scenarioId!, t.pinnedVersionId);
    if (!r.config.channels.embed.enabled) throw gone('scenario_unavailable', 'Embedding is disabled for this conversation.');

    // Token variables are authoritative; the page may only fill allowlisted keys the token left unset.
    const tokenVars = pickAllowlisted(r.config, t.variables as Record<string, unknown>);
    const pageVars = pickAllowlisted(r.config, body.variables);
    for (const k of Object.keys(tokenVars)) delete pageVars[k];
    const variables = { ...pageVars, ...tokenVars };
    precheckVariables(r.config, variables, t.participantName);

    await this.consume(t);
    try {
      const { session, sessionToken } = await this.sessions.createSession({
        workspaceId: t.workspaceId,
        scenarioId: t.scenarioId!,
        versionId: t.pinnedVersionId,
        channel: 'EMBED',
        accessTokenId: t.id,
        participant: { externalId: t.participantExternalId, email: t.participantEmail, name: t.participantName },
        variables,
        metadata: { ...((t.metadata ?? {}) as Record<string, unknown>), source: 'embed', embedOrigin: effectiveOrigin ?? undefined },
      });
      return { sessionId: session.id, sessionToken, allowedOrigins: t.allowedOrigins };
    } catch (e) {
      await this.giveBack(t);
      throw e;
    }
  }

  // ── personal invitation links (/r/t/<cfp_token>) ──

  async participantTokenInfo(authorization: string | undefined, ip: string) {
    await this.rateLimit.enforce(`pub:land:ip:${ip}`, Math.max(60, env.PUBLIC_RUN_RATE_LIMIT_PER_HOUR * 15), 3600);
    const t = await this.resolveBearer(authorization, 'PARTICIPANT');
    const r = await loadRunnableScenario(this.prisma, t.workspaceId, t.scenarioId!, t.pinnedVersionId);
    if (!r.config.channels.browser.enabled) throw gone('scenario_unavailable', 'This conversation is not available in the browser.');
    const mode = r.config.access.identityMode;
    return {
      kind: 'invite' as const,
      scenario: publicScenarioInfo(r, (t.variables ?? {}) as Record<string, unknown>),
      access: {
        identityMode: mode,
        requiresName: identityNeedsName(mode) && !t.participantName,
        requiresEmail: false,
        passcodeRequired: false,
        allowedEmailDomains: [] as string[],
        attemptLimitPerEmail: null,
        oneTime: t.maxUses === 1,
        expiresAt: t.expiresAt,
        label: null,
      },
      participant: { name: t.participantName, email: t.participantEmail },
      variables: participantVariableFields(r.config, (t.variables ?? {}) as Record<string, unknown>),
      branding: await this.branding.publicBranding(t.workspaceId),
    };
  }

  async startParticipantSession(authorization: string | undefined, body: z.infer<typeof ParticipantStartBody>, ip: string) {
    await this.rateLimit.enforce(`pub:run:ip:${ip}`, env.PUBLIC_RUN_RATE_LIMIT_PER_HOUR, 3600, 'Too many sessions started from your network. Please try again later.');
    const t = await this.resolveBearer(authorization, 'PARTICIPANT');
    const r = await loadRunnableScenario(this.prisma, t.workspaceId, t.scenarioId!, t.pinnedVersionId);
    if (!r.config.channels.browser.enabled) throw gone('scenario_unavailable', 'This conversation is not available in the browser.');
    const name = t.participantName || body.name?.trim().slice(0, 120) || null;
    if (identityNeedsName(r.config.access.identityMode) && !name) {
      throw Errors.validation('Please enter your name', [{ path: 'name', message: 'Name is required' }]);
    }
    const tokenVars = pickAllowlisted(r.config, t.variables as Record<string, unknown>);
    const own = pickAllowlisted(r.config, body.variables);
    const variables = { ...own, ...tokenVars };
    precheckVariables(r.config, variables, name);
    await this.consume(t);
    try {
      const { session, sessionToken } = await this.sessions.createSession({
        workspaceId: t.workspaceId,
        scenarioId: t.scenarioId!,
        versionId: t.pinnedVersionId,
        channel: 'BROWSER',
        accessTokenId: t.id,
        participant: { externalId: t.participantExternalId, email: t.participantEmail, name },
        variables,
        metadata: { ...((t.metadata ?? {}) as Record<string, unknown>), source: 'participant_invite' },
      });
      return { sessionId: session.id, sessionToken };
    } catch (e) {
      await this.giveBack(t);
      throw e;
    }
  }
}
