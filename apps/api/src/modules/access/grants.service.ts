import { Injectable } from '@nestjs/common';
import type { GrantPermission, Prisma, ScenarioGrant } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import { verifiedEmail, type Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PaginationQuery, prismaPageArgs, toPage } from '../../common/http/pagination';
import { MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { SessionsService } from '../runtime/sessions.service';
import { EmailSchema, loadRunnableScenario, pickAllowlisted, precheckVariables, publicScenarioInfo, VariablesInput } from './access.util';

export const CreateGrantBody = z
  .object({
    granteeType: z.enum(['USER', 'EMAIL', 'WORKSPACE']),
    /** USER / EMAIL grants. */
    email: EmailSchema.optional(),
    /** WORKSPACE grants: the other workspace's id or slug. */
    workspace: z.string().trim().min(1).max(80).optional(),
    permission: z.enum(['RUN', 'VIEW_RESULTS', 'EDIT']).default('RUN'),
    expiresAt: z.coerce.date().nullable().optional(),
    notify: z.boolean().default(true),
  })
  .strict();
export type CreateGrantBody = z.infer<typeof CreateGrantBody>;
export const UpdateGrantBody = z
  .object({ permission: z.enum(['RUN', 'VIEW_RESULTS', 'EDIT']).optional(), expiresAt: z.coerce.date().nullable().optional() })
  .strict();

export const SharedStartBody = z.object({ variables: VariablesInput }).strict();

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** EDIT implies the other permissions; VIEW_RESULTS does not allow running and vice versa. */
const IMPLIED: Record<GrantPermission, GrantPermission[]> = {
  RUN: ['RUN', 'EDIT'],
  VIEW_RESULTS: ['VIEW_RESULTS', 'EDIT'],
  EDIT: ['EDIT'],
};

export function grantStatus(g: Pick<ScenarioGrant, 'revokedAt' | 'expiresAt'>, now = new Date()) {
  if (g.revokedAt) return 'revoked' as const;
  if (g.expiresAt && g.expiresAt <= now) return 'expired' as const;
  return 'active' as const;
}

@Injectable()
export class GrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly rateLimit: RateLimitService,
    private readonly sessions: SessionsService,
  ) {}

  private async scenarioOr404(workspaceId: string, scenarioId: string) {
    const s = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!s) throw Errors.notFound('Scenario');
    return s;
  }

  private async decorate(grants: ScenarioGrant[]) {
    const userIds = grants.map((g) => g.granteeUserId).filter((x): x is string => !!x);
    const wsIds = grants.map((g) => g.granteeWorkspaceId).filter((x): x is string => !!x);
    const [users, workspaces] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : [],
      wsIds.length ? this.prisma.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true, slug: true } }) : [],
    ]);
    return grants.map((g) => {
      const u = users.find((x) => x.id === g.granteeUserId);
      const w = workspaces.find((x) => x.id === g.granteeWorkspaceId);
      return {
        id: g.id,
        scenarioId: g.scenarioId,
        granteeType: g.granteeType,
        granteeUserId: g.granteeUserId,
        granteeEmail: g.granteeEmail ?? u?.email ?? null,
        granteeWorkspaceId: g.granteeWorkspaceId,
        granteeLabel: g.granteeType === 'WORKSPACE' ? (w ? `${w.name} (${w.slug})` : 'Unknown workspace') : u ? `${u.name ?? u.email} <${u.email}>` : g.granteeEmail,
        permission: g.permission,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        createdAt: g.createdAt,
        status: grantStatus(g),
      };
    });
  }

  async list(workspaceId: string, scenarioId: string) {
    await this.scenarioOr404(workspaceId, scenarioId);
    const grants = await this.prisma.scenarioGrant.findMany({ where: { workspaceId, scenarioId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500 });
    return { data: await this.decorate(grants) };
  }

  async create(workspaceId: string, scenarioId: string, body: CreateGrantBody, principal: Principal) {
    const scenario = await this.scenarioOr404(workspaceId, scenarioId);
    if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) {
      throw Errors.validation('Expiry must be in the future', [{ path: 'expiresAt', message: 'Must be in the future' }]);
    }
    const data: Prisma.ScenarioGrantUncheckedCreateInput = {
      workspaceId,
      scenarioId,
      granteeType: body.granteeType,
      permission: body.permission,
      expiresAt: body.expiresAt ?? null,
      createdById: principal.kind === 'user' ? principal.userId : null,
    };
    let notifyEmail: string | null = null;
    if (body.granteeType === 'USER') {
      if (!body.email) throw Errors.validation('Enter the email of an existing user', [{ path: 'email', message: 'Required' }]);
      const user = await this.prisma.user.findFirst({ where: { email: body.email, deletedAt: null } });
      if (!user) {
        throw Errors.validation('No account uses that email. Share with the email address instead — it applies when they sign up.', [
          { path: 'email', message: 'No user with this email' },
        ]);
      }
      data.granteeUserId = user.id;
      notifyEmail = user.email;
    } else if (body.granteeType === 'EMAIL') {
      if (!body.email) throw Errors.validation('Enter an email address', [{ path: 'email', message: 'Required' }]);
      data.granteeEmail = body.email;
      notifyEmail = body.email;
    } else {
      if (!body.workspace) throw Errors.validation('Enter the workspace id or slug', [{ path: 'workspace', message: 'Required' }]);
      const ws = await this.prisma.workspace.findFirst({ where: { OR: [{ id: body.workspace }, { slug: body.workspace.toLowerCase() }], deletedAt: null } });
      if (!ws) throw Errors.validation('Workspace not found', [{ path: 'workspace', message: 'Unknown workspace' }]);
      if (ws.id === workspaceId) throw Errors.validation('Members of this workspace already have access through their role', [{ path: 'workspace', message: 'Same workspace' }]);
      data.granteeWorkspaceId = ws.id;
    }
    const now = new Date();
    const dup = await this.prisma.scenarioGrant.findFirst({
      where: {
        workspaceId,
        scenarioId,
        permission: body.permission,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        granteeType: data.granteeType,
        granteeUserId: data.granteeUserId ?? null,
        granteeEmail: data.granteeEmail ?? null,
        granteeWorkspaceId: data.granteeWorkspaceId ?? null,
      },
    });
    if (dup) throw Errors.conflict('This grantee already has an active grant with that permission');
    const grant = await this.prisma.scenarioGrant.create({ data });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'grant.created',
      targetType: 'scenario_grant',
      targetId: grant.id,
      metadata: { scenarioId, granteeType: grant.granteeType, grantee: grant.granteeEmail ?? grant.granteeUserId ?? grant.granteeWorkspaceId, permission: grant.permission, expiresAt: grant.expiresAt },
    });
    if (body.notify && notifyEmail) {
      const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
      const what = grant.permission === 'VIEW_RESULTS' ? 'view results of' : grant.permission === 'EDIT' ? 'collaborate on' : 'practice';
      await this.mail.send({
        to: notifyEmail,
        subject: `You can now ${what} "${scenario.name}"`,
        text: `${ws?.name ?? 'A workspace'} shared "${scenario.name}" with you on ConversaForge.\n\nOpen it here (sign in or create an account with ${notifyEmail}): ${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/account#shared${grant.expiresAt ? `\n\nAccess expires on ${grant.expiresAt.toUTCString()}.` : ''}`,
      });
    }
    return (await this.decorate([grant]))[0];
  }

  async update(workspaceId: string, scenarioId: string, id: string, body: z.infer<typeof UpdateGrantBody>, principal: Principal) {
    const g = await this.prisma.scenarioGrant.findFirst({ where: { id, workspaceId, scenarioId } });
    if (!g) throw Errors.notFound('Grant');
    if (g.revokedAt) throw Errors.conflict('This grant has been revoked');
    if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) throw Errors.validation('Expiry must be in the future');
    const row = await this.prisma.scenarioGrant.update({ where: { id: g.id }, data: { permission: body.permission, expiresAt: body.expiresAt } });
    await this.audit.log({ workspaceId, principal, action: 'grant.updated', targetType: 'scenario_grant', targetId: g.id, metadata: { scenarioId, ...body } });
    return (await this.decorate([row]))[0];
  }

  async revoke(workspaceId: string, scenarioId: string, id: string, principal: Principal) {
    const g = await this.prisma.scenarioGrant.findFirst({ where: { id, workspaceId, scenarioId } });
    if (!g) throw Errors.notFound('Grant');
    const row = g.revokedAt ? g : await this.prisma.scenarioGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } });
    if (!g.revokedAt) await this.audit.log({ workspaceId, principal, action: 'grant.revoked', targetType: 'scenario_grant', targetId: g.id, metadata: { scenarioId } });
    return (await this.decorate([row]))[0];
  }

  // ───────────────────────── grantee side ─────────────────────────

  /** Active grants that apply to this user (by user id, email, or a workspace they belong to). Checked at use time. */
  private async activeGrantsFor(user: UserPrincipal, scenarioId?: string) {
    const memberships = await this.prisma.membership.findMany({ where: { userId: user.userId }, select: { workspaceId: true } });
    const now = new Date();
    return this.prisma.scenarioGrant.findMany({
      where: {
        ...(scenarioId ? { scenarioId } : {}),
        revokedAt: null,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          {
            OR: [
              { granteeType: 'USER', granteeUserId: user.userId },
              // Email grants only apply to a VERIFIED address (anyone can sign up with any email).
              ...(verifiedEmail(user) ? [{ granteeType: 'EMAIL' as const, granteeEmail: verifiedEmail(user)!.toLowerCase() }] : []),
              ...(memberships.length ? [{ granteeType: 'WORKSPACE' as const, granteeWorkspaceId: { in: memberships.map((m) => m.workspaceId) } }] : []),
            ],
          },
        ],
        scenario: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  async sharedWithMe(user: UserPrincipal) {
    const grants = await this.activeGrantsFor(user);
    const byScenario = new Map<string, ScenarioGrant[]>();
    for (const g of grants) byScenario.set(g.scenarioId, [...(byScenario.get(g.scenarioId) ?? []), g]);
    const out = [];
    for (const [scenarioId, gs] of byScenario) {
      const workspaceId = gs[0]!.workspaceId;
      const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, include: { branding: true } });
      if (!ws) continue;
      let info: ReturnType<typeof publicScenarioInfo> | null = null;
      let runnable = true;
      try {
        info = publicScenarioInfo(await loadRunnableScenario(this.prisma, workspaceId, scenarioId));
      } catch {
        runnable = false;
        const s = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId }, select: { id: true, name: true, publicDescription: true } });
        if (!s) continue;
        info = { id: s.id, name: s.name, description: s.publicDescription ?? '' } as ReturnType<typeof publicScenarioInfo>;
      }
      const perms = new Set(gs.map((g) => g.permission));
      const expiries = gs.map((g) => g.expiresAt).filter((d): d is Date => !!d);
      out.push({
        scenario: info,
        workspace: { id: ws.id, name: ws.branding?.displayName || ws.name },
        permissions: [...perms],
        canRun: runnable && gs.some((g) => IMPLIED.RUN.includes(g.permission)),
        canViewResults: gs.some((g) => IMPLIED.VIEW_RESULTS.includes(g.permission)),
        runnable,
        expiresAt: gs.some((g) => !g.expiresAt) ? null : expiries.sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
      });
    }
    return { data: out };
  }

  private async requireGrant(user: UserPrincipal, scenarioId: string, need: GrantPermission) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scenarioId)) throw Errors.notFound('Scenario');
    const grants = await this.activeGrantsFor(user, scenarioId);
    const g = grants.find((x) => IMPLIED[need].includes(x.permission));
    // 404 (not 403) so grantees cannot probe scenarios they have no access to.
    if (!g) throw Errors.notFound('Scenario');
    return g;
  }

  async startShared(user: UserPrincipal, scenarioId: string, body: z.infer<typeof SharedStartBody>) {
    await this.rateLimit.enforce(`shared:run:user:${user.userId}`, 30, 3600, 'You are starting sessions too quickly');
    const g = await this.requireGrant(user, scenarioId, 'RUN');
    const r = await loadRunnableScenario(this.prisma, g.workspaceId, scenarioId);
    const variables = pickAllowlisted(r.config, body.variables);
    precheckVariables(r.config, variables, user.name);
    const { session, sessionToken } = await this.sessions.createSession({
      workspaceId: g.workspaceId,
      scenarioId,
      channel: 'BROWSER',
      participant: { userId: user.userId, email: verifiedEmail(user), name: user.name },
      variables,
      metadata: { source: 'grant', grantId: g.id },
    });
    return { sessionId: session.id, sessionToken };
  }

  /** Read-only list of the scenario's sessions for VIEW_RESULTS grantees (minimal fields). */
  async sharedSessions(user: UserPrincipal, scenarioId: string, q: PaginationQuery) {
    const g = await this.requireGrant(user, scenarioId, 'VIEW_RESULTS');
    const rows = await this.prisma.session.findMany({
      where: { workspaceId: g.workspaceId, scenarioId, deletedAt: null },
      select: {
        id: true,
        state: true,
        createdAt: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        analysisStatus: true,
        participant: { select: { name: true, email: true } },
        evaluations: { where: { isCurrent: true }, select: { overallScore: true, simulated: true, status: true }, take: 1 },
      },
      ...prismaPageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return {
      data: page.data.map((s) => ({
        id: s.id,
        state: s.state,
        createdAt: s.createdAt,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        analysisStatus: s.analysisStatus,
        participantName: s.participant.name ?? s.participant.email ?? 'Anonymous',
        overallScore: s.evaluations[0]?.overallScore ?? null,
        simulated: s.evaluations[0]?.simulated ?? false,
      })),
      nextCursor: page.nextCursor,
    };
  }
}
