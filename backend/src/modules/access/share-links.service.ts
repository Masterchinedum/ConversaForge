import { Injectable } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { Prisma, ShareLink } from '@prisma/client';
import { IDENTITY_MODES } from '@cf/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertAllowlistedKeys, DomainSchema, identityNeedsEmail, loadRunnableScenario } from './access.util';

const Variables = z.record(z.string().max(2000)).refine((v) => Object.keys(v).length <= 30, 'Too many variables');

const LinkFields = {
  label: z.string().trim().max(120).nullable().optional(),
  mode: z.enum(['MULTI_USE', 'ONE_TIME']),
  maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  /** undefined = keep, null/'' = remove, string = set. Never returned. */
  passcode: z.string().max(128).nullable().optional(),
  perEmailAttemptLimit: z.number().int().min(1).max(1000).nullable().optional(),
  identityMode: z.enum(IDENTITY_MODES),
  allowedEmailDomains: z.array(DomainSchema).max(50),
  prefilledVariables: Variables,
  pinnedVersionId: z.string().max(64).nullable().optional(),
  courseId: z.string().max(64).nullable().optional(),
};

export const CreateLinkBody = z
  .object({
    ...LinkFields,
    mode: LinkFields.mode.default('MULTI_USE'),
    identityMode: LinkFields.identityMode.default('NAME_EMAIL'),
    allowedEmailDomains: LinkFields.allowedEmailDomains.default([]),
    prefilledVariables: Variables.default({}),
  })
  .strict();
export type CreateLinkBody = z.infer<typeof CreateLinkBody>;
export const UpdateLinkBody = z.object(LinkFields).partial().strict();
export type UpdateLinkBody = z.infer<typeof UpdateLinkBody>;

export type LinkStatus = 'active' | 'revoked' | 'expired' | 'exhausted';

export function linkStatus(l: Pick<ShareLink, 'revokedAt' | 'expiresAt' | 'maxUses' | 'useCount'>, now = new Date()): LinkStatus {
  if (l.revokedAt) return 'revoked';
  if (l.expiresAt && l.expiresAt <= now) return 'expired';
  if (l.maxUses != null && l.useCount >= l.maxUses) return 'exhausted';
  return 'active';
}

export function linkUrl(token: string) {
  return `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/r/${token}`;
}

/** Creator-facing share link management (capability scenarios.share). */
@Injectable()
export class ShareLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  private async scenarioOr404(workspaceId: string, scenarioId: string) {
    const s = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!s) throw Errors.notFound('Scenario');
    return s;
  }

  private async linkOr404(workspaceId: string, scenarioId: string, linkId: string) {
    const l = await this.prisma.shareLink.findFirst({ where: { id: linkId, workspaceId, scenarioId } });
    if (!l) throw Errors.notFound('Share link');
    return l;
  }

  toDto(l: ShareLink & { pinnedVersion?: { version: number } | null; sessionCount?: number }) {
    return {
      id: l.id,
      scenarioId: l.scenarioId,
      label: l.label,
      url: linkUrl(l.token),
      mode: l.mode,
      maxUses: l.maxUses,
      useCount: l.useCount,
      expiresAt: l.expiresAt,
      passcodeRequired: !!l.passcodeHash,
      perEmailAttemptLimit: l.perEmailAttemptLimit,
      identityMode: l.identityMode,
      allowedEmailDomains: l.allowedEmailDomains,
      prefilledVariables: l.prefilledVariables,
      pinnedVersionId: l.pinnedVersionId,
      pinnedVersion: l.pinnedVersion?.version ?? null,
      courseId: l.courseId,
      revokedAt: l.revokedAt,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      status: linkStatus(l),
      ...(l.sessionCount !== undefined ? { sessionCount: l.sessionCount } : {}),
    };
  }

  /** Everything the access page needs about the scenario (versions for pinning, variable allowlist, channels). */
  async accessSummary(workspaceId: string, scenarioId: string) {
    const scenario = await this.scenarioOr404(workspaceId, scenarioId);
    const versions = await this.prisma.scenarioVersion.findMany({
      where: { scenarioId, workspaceId },
      select: { id: true, version: true, publishedAt: true, changeNote: true },
      orderBy: { version: 'desc' },
      take: 100,
    });
    let config: Awaited<ReturnType<typeof loadRunnableScenario>>['config'] | null = null;
    try {
      config = (await loadRunnableScenario(this.prisma, workspaceId, scenarioId)).config;
    } catch {
      config = null;
    }
    const [links, grants, tokens] = await Promise.all([
      this.prisma.shareLink.count({ where: { workspaceId, scenarioId, revokedAt: null } }),
      this.prisma.scenarioGrant.count({ where: { workspaceId, scenarioId, revokedAt: null } }),
      this.prisma.accessToken.count({ where: { workspaceId, scenarioId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
    return {
      scenario: {
        id: scenario.id,
        name: scenario.name,
        privacy: scenario.privacy,
        status: scenario.status,
        galleryListed: scenario.galleryListed,
        latestVersionId: scenario.latestVersionId,
        latestVersionNumber: scenario.latestVersionNumber,
        archived: !!scenario.archivedAt || scenario.status === 'ARCHIVED',
      },
      runnable: !!config,
      versions,
      variables: config?.variables.allowlist.map((v) => ({ key: v.key, label: v.label || v.key, required: v.required, maxLength: v.maxLength })) ?? [],
      identityModeDefault: config?.access.identityMode ?? 'NAME_EMAIL',
      defaultAttemptLimitPerEmail: config?.access.defaultAttemptLimitPerEmail ?? null,
      channels: { browser: config?.channels.browser.enabled ?? false, embed: config?.channels.embed.enabled ?? false },
      allowPublicScenarios: ((ws?.settings ?? {}) as { allowPublicScenarios?: boolean }).allowPublicScenarios !== false,
      publicUrl: `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/p/${scenario.id}`,
      counts: { activeLinks: links, activeGrants: grants, activeTokens: tokens },
    };
  }

  async list(workspaceId: string, scenarioId: string) {
    await this.scenarioOr404(workspaceId, scenarioId);
    const links = await this.prisma.shareLink.findMany({
      where: { workspaceId, scenarioId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
    });
    const versionIds = [...new Set(links.map((l) => l.pinnedVersionId).filter((v): v is string => !!v))];
    const versions = versionIds.length
      ? await this.prisma.scenarioVersion.findMany({ where: { id: { in: versionIds }, workspaceId }, select: { id: true, version: true } })
      : [];
    const counts = links.length
      ? await this.prisma.session.groupBy({ by: ['shareLinkId'], where: { workspaceId, shareLinkId: { in: links.map((l) => l.id) } }, _count: { _all: true } })
      : [];
    return {
      data: links.map((l) =>
        this.toDto({
          ...l,
          pinnedVersion: versions.find((v) => v.id === l.pinnedVersionId) ?? null,
          sessionCount: counts.find((c) => c.shareLinkId === l.id)?._count._all ?? 0,
        }),
      ),
    };
  }

  /** Validate the combination of settings against the scenario (shared by create and update). */
  private async validate(
    workspaceId: string,
    scenarioId: string,
    s: {
      mode: 'MULTI_USE' | 'ONE_TIME';
      identityMode: (typeof IDENTITY_MODES)[number];
      perEmailAttemptLimit: number | null;
      allowedEmailDomains: string[];
      prefilledVariables: Record<string, string>;
      pinnedVersionId: string | null;
      courseId: string | null;
      expiresAt: Date | null;
    },
    expiresChanged: boolean,
  ) {
    if (s.pinnedVersionId) {
      const v = await this.prisma.scenarioVersion.findFirst({ where: { id: s.pinnedVersionId, scenarioId, workspaceId } });
      if (!v) throw Errors.validation('The pinned version does not belong to this scenario', [{ path: 'pinnedVersionId', message: 'Unknown version' }]);
    }
    const scenario = await this.scenarioOr404(workspaceId, scenarioId);
    if (!s.pinnedVersionId && !scenario.latestVersionId) {
      throw Errors.validation('Publish the scenario before creating share links', [{ path: 'scenarioId', message: 'Scenario has no published version' }]);
    }
    const { config } = await loadRunnableScenario(this.prisma, workspaceId, scenarioId, s.pinnedVersionId).catch(() => {
      throw Errors.validation('This scenario cannot be shared right now (archived or unpublished)');
    });
    assertAllowlistedKeys(config, s.prefilledVariables);
    if ((s.perEmailAttemptLimit || s.allowedEmailDomains.length) && !identityNeedsEmail(s.identityMode)) {
      throw Errors.validation('Attempt limits and email-domain restrictions require collecting the participant email', [
        { path: 'identityMode', message: 'Choose "Email" or "Name + email"' },
      ]);
    }
    if (s.courseId) {
      const c = await this.prisma.course.findFirst({ where: { id: s.courseId, workspaceId, deletedAt: null } });
      if (!c) throw Errors.validation('Unknown course', [{ path: 'courseId', message: 'Course not found in this workspace' }]);
    }
    if (expiresChanged && s.expiresAt && s.expiresAt.getTime() <= Date.now()) {
      throw Errors.validation('Expiry must be in the future', [{ path: 'expiresAt', message: 'Must be in the future' }]);
    }
  }

  private async hashPasscode(passcode: string | null | undefined): Promise<string | null | undefined> {
    if (passcode === undefined) return undefined;
    if (passcode === null || passcode.trim() === '') return null;
    if (passcode.length < 4) throw Errors.validation('Passcode must be at least 4 characters', [{ path: 'passcode', message: 'Too short' }]);
    return hash(passcode);
  }

  async create(workspaceId: string, scenarioId: string, body: CreateLinkBody, principal: Principal) {
    const settings = {
      mode: body.mode,
      identityMode: body.identityMode,
      perEmailAttemptLimit: body.perEmailAttemptLimit ?? null,
      allowedEmailDomains: [...new Set(body.allowedEmailDomains)],
      prefilledVariables: body.prefilledVariables,
      pinnedVersionId: body.pinnedVersionId ?? null,
      courseId: body.courseId ?? null,
      expiresAt: body.expiresAt ?? null,
    };
    await this.validate(workspaceId, scenarioId, settings, true);
    const passcodeHash = await this.hashPasscode(body.passcode);
    const link = await this.prisma.shareLink.create({
      data: {
        workspaceId,
        scenarioId,
        token: this.crypto.randomToken(32),
        label: body.label?.trim() || null,
        ...settings,
        prefilledVariables: settings.prefilledVariables as Prisma.InputJsonValue,
        maxUses: body.mode === 'ONE_TIME' ? 1 : body.maxUses ?? null,
        passcodeHash: passcodeHash ?? null,
        createdById: principal.kind === 'user' ? principal.userId : null,
      },
    });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'share_link.created',
      targetType: 'share_link',
      targetId: link.id,
      metadata: { scenarioId, mode: link.mode, maxUses: link.maxUses, expiresAt: link.expiresAt, identityMode: link.identityMode, passcode: !!passcodeHash },
    });
    return this.toDto(link);
  }

  async update(workspaceId: string, scenarioId: string, linkId: string, body: UpdateLinkBody, principal: Principal) {
    const cur = await this.linkOr404(workspaceId, scenarioId, linkId);
    if (cur.revokedAt) throw Errors.conflict('This link has been revoked and can no longer be changed');
    const mode = body.mode ?? cur.mode;
    const settings = {
      mode,
      identityMode: body.identityMode ?? cur.identityMode,
      perEmailAttemptLimit: body.perEmailAttemptLimit !== undefined ? body.perEmailAttemptLimit : cur.perEmailAttemptLimit,
      allowedEmailDomains: body.allowedEmailDomains ? [...new Set(body.allowedEmailDomains)] : cur.allowedEmailDomains,
      prefilledVariables: (body.prefilledVariables ?? cur.prefilledVariables) as Record<string, string>,
      pinnedVersionId: body.pinnedVersionId !== undefined ? body.pinnedVersionId : cur.pinnedVersionId,
      courseId: body.courseId !== undefined ? body.courseId : cur.courseId,
      expiresAt: body.expiresAt !== undefined ? body.expiresAt : cur.expiresAt,
    };
    await this.validate(workspaceId, scenarioId, settings, body.expiresAt !== undefined);
    const passcodeHash = await this.hashPasscode(body.passcode);
    const link = await this.prisma.shareLink.update({
      where: { id: cur.id },
      data: {
        ...settings,
        prefilledVariables: settings.prefilledVariables as Prisma.InputJsonValue,
        ...(body.label !== undefined ? { label: body.label?.trim() || null } : {}),
        maxUses: mode === 'ONE_TIME' ? 1 : body.maxUses !== undefined ? body.maxUses : cur.mode === 'ONE_TIME' ? null : cur.maxUses,
        ...(passcodeHash !== undefined ? { passcodeHash } : {}),
      },
    });
    const changed = Object.keys(body).filter((k) => k !== 'passcode');
    await this.audit.log({
      workspaceId,
      principal,
      action: 'share_link.updated',
      targetType: 'share_link',
      targetId: link.id,
      metadata: { scenarioId, changed, passcodeChanged: body.passcode !== undefined },
    });
    return this.toDto(link);
  }

  async revoke(workspaceId: string, scenarioId: string, linkId: string, principal: Principal) {
    const cur = await this.linkOr404(workspaceId, scenarioId, linkId);
    if (cur.revokedAt) return this.toDto(cur);
    const link = await this.prisma.shareLink.update({ where: { id: cur.id }, data: { revokedAt: new Date() } });
    await this.audit.log({ workspaceId, principal, action: 'share_link.revoked', targetType: 'share_link', targetId: link.id, metadata: { scenarioId } });
    return this.toDto(link);
  }
}
