import { Injectable, Logger } from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import type { ShareLink } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError, Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { InjectRedis } from '../../common/redis/redis.module';
import { CryptoService } from '../../common/crypto/crypto.service';
import { BrandingService } from '../admin/branding.service';
import { SessionsService } from '../runtime/sessions.service';
import {
  gone,
  identityNeedsEmail,
  identityNeedsName,
  LINK_TOKEN_RE,
  loadRunnableScenario,
  participantVariableFields,
  pickAllowlisted,
  precheckVariables,
  publicScenarioInfo,
  validateIdentity,
  VariablesInput,
} from './access.util';

export const StartBody = z
  .object({
    name: z.string().max(120).optional().nullable(),
    email: z.string().max(254).optional().nullable(),
    passcode: z.string().max(128).optional().nullable(),
    variables: VariablesInput,
  })
  .strict();
export type StartBody = z.infer<typeof StartBody>;

/** Passcode guessing limits: per (link, IP) and per link across all IPs. */
export const PASSCODE_LIMITS = { perIp: 5, perIpWindowSec: 15 * 60, perLink: 50, perLinkWindowSec: 3600 };

const NOT_COUNTED_STATES = ['CANCELLED', 'EXPIRED'] as const;

/**
 * Unauthenticated run flows: share links (/r/<token>) and PUBLIC scenarios (/p/<id>).
 * Every check happens at use time (revocation, expiry, uses, passcode, identity, attempt limits),
 * and uses are consumed with a conditional UPDATE so concurrent requests can never exceed maxUses.
 */
@Injectable()
export class PublicRunService {
  private readonly logger = new Logger('PublicRun');

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    @InjectRedis() private readonly redis: Redis,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionsService,
    private readonly branding: BrandingService,
  ) {}

  get runLimitPerHour() {
    return env.PUBLIC_RUN_RATE_LIMIT_PER_HOUR;
  }

  // ───────────────────────── share links ─────────────────────────

  private async findLink(token: string): Promise<ShareLink> {
    if (typeof token !== 'string' || !LINK_TOKEN_RE.test(token)) throw Errors.notFound('Link');
    const link = await this.prisma.shareLink.findUnique({ where: { token } });
    if (!link) throw Errors.notFound('Link');
    return link;
  }

  private assertLinkActive(link: ShareLink) {
    if (link.revokedAt) throw gone('link_revoked', 'This link has been turned off by the organizer.');
    if (link.expiresAt && link.expiresAt <= new Date()) throw gone('link_expired', 'This link has expired.');
    if (link.maxUses != null && link.useCount >= link.maxUses) {
      throw gone('link_exhausted', link.maxUses === 1 ? 'This one-time link has already been used.' : 'This link has reached its maximum number of uses.');
    }
  }

  async linkLanding(token: string, ip: string) {
    await this.rateLimit.enforce(`pub:land:ip:${ip}`, Math.max(60, this.runLimitPerHour * 15), 3600);
    const link = await this.findLink(token);
    this.assertLinkActive(link);
    const r = await loadRunnableScenario(this.prisma, link.workspaceId, link.scenarioId, link.pinnedVersionId);
    if (!r.config.channels.browser.enabled) throw gone('scenario_unavailable', 'This conversation is not available in the browser.');
    const prefilled = (link.prefilledVariables ?? {}) as Record<string, unknown>;
    return {
      kind: 'link' as const,
      scenario: publicScenarioInfo(r, prefilled),
      access: {
        identityMode: link.identityMode,
        requiresName: identityNeedsName(link.identityMode),
        requiresEmail: identityNeedsEmail(link.identityMode),
        passcodeRequired: !!link.passcodeHash,
        allowedEmailDomains: link.allowedEmailDomains,
        attemptLimitPerEmail: link.perEmailAttemptLimit ?? r.config.access.defaultAttemptLimitPerEmail ?? null,
        oneTime: link.mode === 'ONE_TIME',
        expiresAt: link.expiresAt,
        label: link.label,
      },
      variables: participantVariableFields(r.config, prefilled),
      branding: await this.branding.publicBranding(link.workspaceId),
    };
  }

  /** Atomically reserve passcode attempts before verifying (a burst of guesses cannot slip through). */
  private async checkPasscode(link: ShareLink, passcode: string | null | undefined, ip: string) {
    if (!link.passcodeHash) return;
    const ipKey = `pc:att:${link.id}:${ip}`;
    const linkKey = `pc:att:${link.id}`;
    const [[, ipCount], [, linkCount]] = (await this.redis
      .multi()
      .incr(ipKey)
      .incr(linkKey)
      .exec()) as Array<[Error | null, number]>;
    if (ipCount === 1) await this.redis.expire(ipKey, PASSCODE_LIMITS.perIpWindowSec);
    if (linkCount === 1) await this.redis.expire(linkKey, PASSCODE_LIMITS.perLinkWindowSec);
    const release = async () => {
      await this.redis.multi().decr(ipKey).decr(linkKey).exec();
    };
    if (ipCount > PASSCODE_LIMITS.perIp || linkCount > PASSCODE_LIMITS.perLink) {
      throw Errors.tooMany('Too many passcode attempts. Please wait a few minutes and try again.', { reason: 'passcode_attempts' });
    }
    if (!passcode) {
      await release();
      throw new AppError(403, 'passcode_required', 'This link requires a passcode.');
    }
    const ok = await verify(link.passcodeHash, passcode).catch(() => false);
    if (!ok) throw new AppError(403, 'invalid_passcode', 'The passcode is incorrect.');
    await release(); // correct passcodes do not count against the guess budget
  }

  /** Serialize starts for the same (scope, email) so concurrent requests cannot exceed attempt limits. */
  private async withEmailLock<T>(scope: string, email: string | null, fn: () => Promise<T>): Promise<T> {
    if (!email) return fn();
    const key = `lock:attempt:${scope}:${this.crypto.sha256(email)}`;
    const token = this.crypto.randomToken(8);
    const ok = await this.redis.set(key, token, 'PX', 20_000, 'NX');
    if (!ok) throw Errors.tooMany('A session is already being started for this email. Please wait a moment.', { reason: 'attempt_in_progress' });
    try {
      return await fn();
    } finally {
      // Release only our own lock.
      await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
    }
  }

  private attemptLimitError(limit: number) {
    return new AppError(403, 'attempt_limit_reached', `You have used all ${limit} allowed attempt${limit === 1 ? '' : 's'} for this conversation.`, { limit });
  }

  async startFromLink(token: string, body: StartBody, ip: string) {
    await this.rateLimit.enforce(`pub:run:ip:${ip}`, this.runLimitPerHour, 3600, 'Too many sessions started from your network. Please try again later.');
    const link = await this.findLink(token);
    await this.rateLimit.enforce(`pub:run:link:${link.id}`, this.runLimitPerHour * 25, 3600, 'This link is receiving too many requests. Please try again later.');
    this.assertLinkActive(link);
    await this.checkPasscode(link, body.passcode, ip);

    const r = await loadRunnableScenario(this.prisma, link.workspaceId, link.scenarioId, link.pinnedVersionId);
    if (!r.config.channels.browser.enabled) throw gone('scenario_unavailable', 'This conversation is not available in the browser.');
    const identity = validateIdentity(link.identityMode, body, {
      allowedEmailDomains: link.allowedEmailDomains,
      requireEmail: !!link.perEmailAttemptLimit,
    });
    const limit = link.perEmailAttemptLimit ?? r.config.access.defaultAttemptLimitPerEmail ?? null;

    // Participant values first, link prefills win (the organizer's values cannot be overridden).
    const variables = { ...pickAllowlisted(r.config, body.variables), ...pickAllowlisted(r.config, link.prefilledVariables as Record<string, unknown>) };
    precheckVariables(r.config, variables, identity.name);

    return this.withEmailLock(`link:${link.id}`, limit && identity.email ? identity.email : null, async () => {
      if (limit && identity.email) {
        const used = await this.prisma.session.count({
          where: { workspaceId: link.workspaceId, shareLinkId: link.id, participant: { email: identity.email }, state: { notIn: [...NOT_COUNTED_STATES] } },
        });
        if (used >= limit) throw this.attemptLimitError(limit);
      }

      // Consume one use atomically: the WHERE is re-evaluated under the row lock, so racing requests
      // can never push useCount past maxUses, and revocation/expiry are re-checked at the same instant.
      const now = new Date();
      const consumed = await this.prisma.shareLink.updateMany({
        where: {
          id: link.id,
          revokedAt: null,
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            { OR: [{ maxUses: null }, { useCount: { lt: this.prisma.shareLink.fields.maxUses } }] },
          ],
        },
        data: { useCount: { increment: 1 } },
      });
      if (consumed.count === 0) {
        const fresh = await this.prisma.shareLink.findUnique({ where: { id: link.id } });
        this.assertLinkActive(fresh ?? link);
        throw gone('link_exhausted', 'This link has reached its maximum number of uses.');
      }

      try {
        const { session, sessionToken } = await this.sessions.createSession({
          workspaceId: link.workspaceId,
          scenarioId: link.scenarioId,
          versionId: link.pinnedVersionId,
          channel: 'BROWSER',
          shareLinkId: link.id,
          participant: { name: identity.name, email: identity.email },
          variables,
          metadata: { source: 'share_link', shareLinkLabel: link.label ?? undefined, courseId: link.courseId ?? undefined },
        });
        return { sessionId: session.id, sessionToken };
      } catch (e) {
        // Give the use back so a failed start (quota, provider config) does not burn a one-time link.
        await this.prisma.shareLink
          .updateMany({ where: { id: link.id, useCount: { gt: 0 } }, data: { useCount: { decrement: 1 } } })
          .catch(() => undefined);
        throw e;
      }
    });
  }

  // ───────────────────────── public scenarios ─────────────────────────

  private async loadPublicScenario(scenarioId: string) {
    if (typeof scenarioId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(scenarioId)) throw Errors.notFound('Scenario');
    const scenario = await this.prisma.scenario.findFirst({
      where: { id: scenarioId, deletedAt: null, privacy: 'PUBLIC' },
      include: { workspace: { select: { deletedAt: true, settings: true } } },
    });
    if (!scenario || scenario.workspace.deletedAt) throw Errors.notFound('Scenario');
    const settings = (scenario.workspace.settings ?? {}) as { allowPublicScenarios?: boolean };
    if (settings.allowPublicScenarios === false) throw gone('scenario_unavailable', 'This conversation is not publicly available.');
    const r = await loadRunnableScenario(this.prisma, scenario.workspaceId, scenario.id);
    if (!r.config.channels.browser.enabled) throw gone('scenario_unavailable', 'This conversation is not available in the browser.');
    return r;
  }

  async publicLanding(scenarioId: string, ip: string) {
    await this.rateLimit.enforce(`pub:land:ip:${ip}`, Math.max(60, this.runLimitPerHour * 15), 3600);
    const r = await this.loadPublicScenario(scenarioId);
    const mode = r.config.access.identityMode;
    return {
      kind: 'public' as const,
      scenario: publicScenarioInfo(r),
      access: {
        identityMode: mode,
        requiresName: identityNeedsName(mode),
        requiresEmail: identityNeedsEmail(mode),
        passcodeRequired: false,
        allowedEmailDomains: [] as string[],
        attemptLimitPerEmail: r.config.access.defaultAttemptLimitPerEmail ?? null,
        oneTime: false,
        expiresAt: null,
        label: null,
      },
      variables: participantVariableFields(r.config, {}),
      branding: await this.branding.publicBranding(r.scenario.workspaceId),
    };
  }

  async startPublic(scenarioId: string, body: StartBody, ip: string) {
    await this.rateLimit.enforce(`pub:run:ip:${ip}`, this.runLimitPerHour, 3600, 'Too many sessions started from your network. Please try again later.');
    const r = await this.loadPublicScenario(scenarioId);
    await this.rateLimit.enforce(`pub:run:scenario:${r.scenario.id}`, this.runLimitPerHour * 50, 3600, 'This conversation is receiving too many requests. Please try again later.');
    const limit = r.config.access.defaultAttemptLimitPerEmail ?? null;
    const identity = validateIdentity(r.config.access.identityMode, body, { requireEmail: !!limit });
    const variables = pickAllowlisted(r.config, body.variables);
    precheckVariables(r.config, variables, identity.name);

    return this.withEmailLock(`scenario:${r.scenario.id}`, limit ? identity.email : null, async () => {
      if (limit && identity.email) {
        const used = await this.prisma.session.count({
          where: {
            workspaceId: r.scenario.workspaceId,
            scenarioId: r.scenario.id,
            shareLinkId: null,
            accessTokenId: null,
            participant: { email: identity.email },
            state: { notIn: [...NOT_COUNTED_STATES] },
          },
        });
        if (used >= limit) throw this.attemptLimitError(limit);
      }
      const { session, sessionToken } = await this.sessions.createSession({
        workspaceId: r.scenario.workspaceId,
        scenarioId: r.scenario.id,
        channel: 'BROWSER',
        participant: { name: identity.name, email: identity.email },
        variables,
        metadata: { source: 'public_scenario' },
      });
      return { sessionId: session.id, sessionToken };
    });
  }
}
