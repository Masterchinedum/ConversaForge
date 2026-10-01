import { Body, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ROLES, USAGE_KINDS } from '@cf/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiScopes, CurrentWorkspace } from '../../../common/auth/decorators';
import type { WorkspaceContext } from '../../../common/auth/principal';
import { AuditService } from '../../../common/audit/audit.service';
import { Errors } from '../../../common/http/errors';
import { prismaPageArgs, toPage } from '../../../common/http/pagination';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MembersService } from '../../admin/members.service';
import { CoursesService } from '../../courses/courses.service';
import { normEmail, participantForEmail } from '../../courses/participants';
import { apiKeyOf, jsonSafe, V1Controller, V1Page } from './v1.common';

const V1InviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(ROLES).default('MEMBER'),
  })
  .strict();

const PeriodQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const LedgerQuery = V1Page.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  kind: z.enum(USAGE_KINDS).optional(),
  provider: z.string().max(40).optional(),
  sessionId: z.string().max(64).optional(),
});

const AnalyticsQuery = PeriodQuery.extend({ scenarioId: z.string().max(64).optional() });

const CoursesQuery = V1Page.extend({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional() });

const EnrollBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    externalId: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((b) => !!(b.email || b.externalId), 'email or externalId is required');

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function period(q: { from?: Date; to?: Date }, defaultDays?: number) {
  const to = q.to ?? new Date();
  const from = q.from ?? (defaultDays ? new Date(to.getTime() - defaultDays * 86400_000) : monthStart(to));
  if (from > to) throw Errors.validation('`from` must be before `to`');
  if (to.getTime() - from.getTime() > 366 * 86400_000) throw Errors.validation('The period can be at most 366 days');
  return { from, to };
}

/** Organization, members, invitations, courses, analytics and usage over the API. */
@V1Controller('', 'organization')
export class V1OrgController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membersService: MembersService,
    private readonly courses: CoursesService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── organization ─────────────

  @Get('organization')
  @ApiScopes('org:read')
  @ApiOperation({ summary: 'The workspace this API key belongs to' })
  async organization(@CurrentWorkspace() ws: WorkspaceContext) {
    const w = await this.prisma.workspace.findFirst({ where: { id: ws.workspaceId, deletedAt: null }, include: { branding: true } });
    if (!w) throw Errors.notFound('Workspace');
    const memberCount = await this.prisma.membership.count({ where: { workspaceId: w.id } });
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      kind: w.kind,
      createdAt: w.createdAt,
      memberCount,
      branding: w.branding ? { displayName: w.branding.displayName, logoUrl: w.branding.logoUrl, primaryColor: w.branding.primaryColor } : null,
    };
  }

  @Get('members')
  @ApiScopes('org:read')
  @ApiOperation({ summary: 'Workspace members' })
  async members(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(V1Page)) q: z.infer<typeof V1Page>) {
    const rows = await this.prisma.membership.findMany({
      where: { workspaceId: ws.workspaceId, user: { deletedAt: null } },
      include: { user: { select: { id: true, email: true, name: true } } },
      ...prismaPageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return {
      data: page.data.map((m) => ({ id: m.id, userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, createdAt: m.createdAt })),
      nextCursor: page.nextCursor,
    };
  }

  @Post('invitations')
  @ApiScopes('org:write')
  @ApiOperation({ summary: 'Invite someone by email (API keys can invite up to ADMIN)' })
  async invite(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Body(new ZodPipe(V1InviteBody)) body: z.infer<typeof V1InviteBody>) {
    // MembersService (workstream E) owns invitation rules (personal workspaces, owner-only owner invites, one open invite per email).
    return this.membersService.invite(ws.workspaceId, body, apiKeyOf(req), ws);
  }

  // ───────────── courses ─────────────

  @Get('courses')
  @ApiScopes('courses:read')
  @ApiOperation({ summary: 'List courses' })
  async listCourses(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(CoursesQuery)) q: z.infer<typeof CoursesQuery>) {
    const rows = await this.prisma.course.findMany({
      where: { workspaceId: ws.workspaceId, deletedAt: null, ...(q.status ? { status: q.status } : {}) },
      include: { _count: { select: { items: true, enrollments: true } } },
      ...prismaPageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return {
      data: page.data.map((c) => ({ ...this.courses.courseDto(c), itemCount: c._count.items, enrollmentCount: c._count.enrollments })),
      nextCursor: page.nextCursor,
    };
  }

  @Get('courses/:id')
  @ApiScopes('courses:read')
  @ApiOperation({ summary: 'Get a course with its items' })
  getCourse(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.courses.get(ws.workspaceId, id);
  }

  @Post('courses/:id/enrollments')
  @ApiScopes('courses:write')
  @ApiOperation({ summary: 'Enroll a participant by email and/or externalId (idempotent; re-activates dropped enrollments)' })
  async enroll(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string, @Body(new ZodPipe(EnrollBody)) body: z.infer<typeof EnrollBody>) {
    const key = apiKeyOf(req);
    const course = await this.courses.findCourse(ws.workspaceId, id);
    if (course.status === 'ARCHIVED') throw Errors.conflict('This course is archived');
    const email = normEmail(body.email);
    let userId: string | null = null;
    if (email) {
      const u = await this.prisma.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } });
      if (u && !u.deletedAt) userId = u.id;
    }
    // Participant resolution matches the runtime/courses rules (externalId is the stable integration key).
    let participant;
    if (body.externalId) {
      participant = await this.prisma.participant.upsert({
        where: { workspaceId_externalId: { workspaceId: ws.workspaceId, externalId: body.externalId } },
        create: { workspaceId: ws.workspaceId, externalId: body.externalId, email, name: body.name ?? null },
        update: { ...(email ? { email } : {}), ...(body.name ? { name: body.name } : {}), deletedAt: null },
      });
    } else {
      participant = await participantForEmail(this.prisma, ws.workspaceId, email!, userId);
      if (body.name && !participant.name) participant = await this.prisma.participant.update({ where: { id: participant.id }, data: { name: body.name } });
    }
    const pUserId = participant.userId ?? null;
    let outcome: 'created' | 'already' | 'reactivated';
    let enrollment = await this.prisma.enrollment.findUnique({ where: { courseId_participantId: { courseId: course.id, participantId: participant.id } } });
    if (enrollment && enrollment.status !== 'DROPPED') outcome = 'already';
    else if (enrollment) {
      // Same semantics as EnrollmentsService: a dropped enrollment restarts at a new generation (0% progress).
      enrollment = await this.prisma.enrollment.update({
        where: { id: enrollment.id },
        data: { status: 'ACTIVE', generation: { increment: 1 }, completedAt: null, startedAt: null, lastItemId: null, userId: pUserId ?? enrollment.userId },
      });
      outcome = 'reactivated';
    } else {
      try {
        enrollment = await this.prisma.enrollment.create({
          data: { courseId: course.id, workspaceId: ws.workspaceId, participantId: participant.id, userId: pUserId },
        });
        outcome = 'created';
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        enrollment = await this.prisma.enrollment.findUniqueOrThrow({ where: { courseId_participantId: { courseId: course.id, participantId: participant.id } } });
        outcome = 'already';
      }
    }
    if (outcome !== 'already') {
      await this.audit.log({
        workspaceId: ws.workspaceId,
        principal: key,
        action: 'course.enrollments_assigned',
        targetType: 'course',
        targetId: course.id,
        metadata: { via: 'api', outcome, participantId: participant.id },
      });
    }
    return {
      outcome,
      enrollment: {
        id: enrollment.id,
        courseId: course.id,
        status: enrollment.status,
        generation: enrollment.generation,
        createdAt: enrollment.createdAt,
        participant: { id: participant.id, externalId: participant.externalId, email: participant.email, name: participant.name },
      },
    };
  }

  // ───────────── analytics ─────────────

  @Get('analytics/summary')
  @ApiScopes('analytics:read')
  @ApiOperation({ summary: 'Session and score summary for a period (default: last 30 days)' })
  async analytics(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(AnalyticsQuery)) q: z.infer<typeof AnalyticsQuery>) {
    const { from, to } = period(q, 30);
    const where: Prisma.SessionWhereInput = {
      workspaceId: ws.workspaceId,
      deletedAt: null,
      createdAt: { gte: from, lte: to },
      ...(q.scenarioId ? { scenarioId: q.scenarioId } : {}),
    };
    const [byState, byChannel, durations, scores] = await Promise.all([
      this.prisma.session.groupBy({ by: ['state'], where, _count: { _all: true } }),
      this.prisma.session.groupBy({ by: ['channel'], where, _count: { _all: true } }),
      this.prisma.session.aggregate({ where: { ...where, state: 'COMPLETED', durationMs: { not: null } }, _avg: { durationMs: true }, _sum: { durationMs: true } }),
      this.prisma.evaluation.aggregate({
        where: { workspaceId: ws.workspaceId, isCurrent: true, overallScore: { not: null }, session: where },
        _avg: { overallScore: true },
        _count: { _all: true },
      }),
    ]);
    const perScenario = await this.prisma.session.groupBy({ by: ['scenarioId'], where, _count: { _all: true }, orderBy: { _count: { scenarioId: 'desc' } }, take: 20 });
    const scenarioIds = perScenario.map((s) => s.scenarioId);
    const [names, scenarioScores] = await Promise.all([
      this.prisma.scenario.findMany({ where: { id: { in: scenarioIds }, workspaceId: ws.workspaceId }, select: { id: true, name: true } }),
      Promise.all(
        scenarioIds.map((sid) =>
          this.prisma.evaluation.aggregate({
            where: { workspaceId: ws.workspaceId, isCurrent: true, overallScore: { not: null }, session: { ...where, scenarioId: sid } },
            _avg: { overallScore: true },
            _count: { _all: true },
          }),
        ),
      ),
    ]);
    const count = (s: string) => byState.find((b) => b.state === s)?._count._all ?? 0;
    const total = byState.reduce((a, b) => a + b._count._all, 0);
    const ended = count('COMPLETED') + count('ABANDONED') + count('FAILED');
    return {
      period: { from, to },
      sessions: {
        total,
        byState: Object.fromEntries(byState.map((b) => [b.state, b._count._all])),
        byChannel: Object.fromEntries(byChannel.map((b) => [b.channel, b._count._all])),
        completionRate: ended ? count('COMPLETED') / ended : null,
        avgDurationMs: durations._avg.durationMs ?? null,
        totalDurationMs: durations._sum.durationMs ?? 0,
      },
      scores: { evaluated: scores._count._all, avgOverallScore: scores._avg.overallScore ?? null },
      scenarios: perScenario.map((s, i) => ({
        scenarioId: s.scenarioId,
        name: names.find((n) => n.id === s.scenarioId)?.name ?? null,
        sessions: s._count._all,
        evaluated: scenarioScores[i]!._count._all,
        avgOverallScore: scenarioScores[i]!._avg.overallScore ?? null,
      })),
    };
  }

  // ───────────── usage ─────────────

  @Get('usage')
  @ApiScopes('usage:read')
  @ApiOperation({ summary: 'Usage totals by kind and provider for a period (default: current month)' })
  async usage(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    const { from, to } = period(q);
    const rows = await this.prisma.usageLedger.groupBy({
      by: ['kind', 'provider', 'unit'],
      where: { workspaceId: ws.workspaceId, createdAt: { gte: from, lte: to } },
      _sum: { quantity: true, costMicros: true },
      _count: { _all: true },
    });
    const items = rows.map((r) => ({
      kind: r.kind,
      provider: r.provider,
      unit: r.unit,
      quantity: r._sum.quantity ?? 0,
      costMicros: Number(r._sum.costMicros ?? 0),
      entries: r._count._all,
    }));
    return {
      period: { from, to },
      totalCostMicros: items.reduce((a, i) => a + i.costMicros, 0),
      costIsEstimate: true,
      items,
    };
  }

  @Get('usage/ledger')
  @ApiScopes('usage:read')
  @ApiOperation({ summary: 'Individual usage ledger entries (newest first)' })
  async ledger(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(LedgerQuery)) q: z.infer<typeof LedgerQuery>) {
    const { from, to } = period(q);
    const rows = await this.prisma.usageLedger.findMany({
      where: {
        workspaceId: ws.workspaceId,
        createdAt: { gte: from, lte: to },
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.provider ? { provider: q.provider } : {}),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      },
      select: { id: true, sessionId: true, kind: true, provider: true, quantity: true, unit: true, costMicros: true, metadata: true, createdAt: true },
      ...prismaPageArgs(q),
    });
    return jsonSafe(toPage(rows, q.limit));
  }
}
