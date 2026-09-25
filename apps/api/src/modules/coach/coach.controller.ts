import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentPrincipal, CurrentUser, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PaginationQuery, prismaPageArgs, toPage } from '../../common/http/pagination';
import { ZodPipe } from '../../common/http/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { participantForUser } from '../courses/participants';
import { MemoryService } from './memory.service';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

const ProfileBody = z
  .object({ memoryEnabled: z.boolean().optional(), goals: z.string().max(2000).nullable().optional() })
  .refine((b) => b.memoryEnabled !== undefined || b.goals !== undefined, 'Nothing to update');
const FactBody = z.object({ disabled: z.boolean() });
const LearnersQuery = PaginationQuery.extend({ q: z.string().trim().max(200).optional() });

@ApiTags('coach')
@Controller('workspaces/:workspaceId/coach')
export class CoachController {
  constructor(
    private readonly memory: MemoryService,
    private readonly prisma: PrismaService,
  ) {}

  private async myParticipantIds(workspaceId: string, userId: string) {
    const rows = await this.prisma.participant.findMany({ where: { workspaceId, userId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  // ───────────── the learner's own memory (any member) ─────────────

  @Get('me')
  async me(@Param('workspaceId') ws: string, @CurrentUser() u: UserPrincipal) {
    const ids = await this.myParticipantIds(ws, u.userId);
    const profiles = ids.length ? await this.prisma.coachProfile.findMany({ where: { workspaceId: ws, participantId: { in: ids } } }) : [];
    const primary = profiles[0];
    return {
      profile: {
        // Memory is on by default; it is off if the learner turned it off on any of their profiles.
        memoryEnabled: profiles.length ? profiles.every((p) => p.memoryEnabled) : true,
        goals: primary?.goals ?? null,
        summary: primary?.summary ?? null,
      },
      facts: await this.memory.listFacts(ws, ids),
    };
  }

  @Patch('me')
  async updateMe(@Param('workspaceId') ws: string, @CurrentUser() u: UserPrincipal, @Body(new ZodPipe(ProfileBody)) body: z.infer<typeof ProfileBody>) {
    let ids = await this.myParticipantIds(ws, u.userId);
    if (!ids.length) ids = [(await participantForUser(this.prisma, ws, { userId: u.userId, email: u.email, name: u.name })).id];
    await this.memory.updateProfiles(ws, ids, body);
    return this.me(ws, u);
  }

  @Patch('me/facts/:factId')
  async setMyFact(@Param('workspaceId') ws: string, @Param('factId') factId: string, @CurrentUser() u: UserPrincipal, @Body(new ZodPipe(FactBody)) body: z.infer<typeof FactBody>) {
    return this.memory.setFactDisabled(ws, await this.myParticipantIds(ws, u.userId), factId, body.disabled);
  }

  @Delete('me/facts/:factId')
  async deleteMyFact(@Param('workspaceId') ws: string, @Param('factId') factId: string, @CurrentUser() u: UserPrincipal) {
    return this.memory.deleteFact(ws, await this.myParticipantIds(ws, u.userId), factId);
  }

  @Delete('me/facts')
  async clearMine(@Param('workspaceId') ws: string, @CurrentUser() u: UserPrincipal) {
    return this.memory.clearAll(ws, await this.myParticipantIds(ws, u.userId));
  }

  // ───────────── reviewers (memory.manage) ─────────────

  @Get('learners')
  @RequireCapability('memory.manage')
  async learners(@Param('workspaceId') ws: string, @Query(new ZodPipe(LearnersQuery)) q: z.infer<typeof LearnersQuery>) {
    const where = {
      workspaceId: ws,
      deletedAt: null,
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
              { user: { name: { contains: q.q, mode: 'insensitive' as const } } },
              { user: { email: { contains: q.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.participant.findMany({
      where,
      ...prismaPageArgs(q),
      select: {
        id: true,
        name: true,
        email: true,
        userId: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
        _count: { select: { sessions: true } },
      },
    });
    const page = toPage(rows, q.limit);
    const ids = page.data.map((r) => r.id);
    const [facts, profiles] = await Promise.all([
      ids.length
        ? this.prisma.memoryFact.groupBy({ by: ['participantId', 'disabled'], where: { workspaceId: ws, participantId: { in: ids }, deletedAt: null }, _count: { _all: true } })
        : [],
      ids.length ? this.prisma.coachProfile.findMany({ where: { workspaceId: ws, participantId: { in: ids } } }) : [],
    ]);
    return {
      data: page.data.map((r) => {
        const f = facts.filter((x) => x.participantId === r.id);
        const prof = profiles.find((p) => p.participantId === r.id);
        return {
          participantId: r.id,
          name: r.user?.name ?? r.name,
          email: r.user?.email ?? r.email,
          hasAccount: !!r.userId,
          sessionCount: r._count.sessions,
          activeFacts: f.filter((x) => !x.disabled).reduce((t, x) => t + x._count._all, 0),
          disabledFacts: f.filter((x) => x.disabled).reduce((t, x) => t + x._count._all, 0),
          memoryEnabled: prof?.memoryEnabled ?? true,
          goals: prof?.goals ?? null,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  private async learner(ws: string, participantId: string) {
    const p = await this.prisma.participant.findFirst({
      where: { id: participantId, workspaceId: ws },
      select: { id: true, name: true, email: true, userId: true, user: { select: { name: true, email: true } } },
    });
    if (!p) throw Errors.notFound('Learner');
    return p;
  }

  @Get('learners/:participantId')
  @RequireCapability('memory.manage')
  async learnerDetail(@Param('workspaceId') ws: string, @Param('participantId') pid: string) {
    const p = await this.learner(ws, pid);
    const profile = await this.prisma.coachProfile.findUnique({ where: { workspaceId_participantId: { workspaceId: ws, participantId: pid } } });
    return {
      learner: { participantId: p.id, name: p.user?.name ?? p.name, email: p.user?.email ?? p.email, hasAccount: !!p.userId },
      profile: { memoryEnabled: profile?.memoryEnabled ?? true, goals: profile?.goals ?? null, summary: profile?.summary ?? null },
      facts: await this.memory.listFacts(ws, [pid]),
    };
  }

  @Patch('learners/:participantId')
  @RequireCapability('memory.manage')
  async updateLearner(
    @Param('workspaceId') ws: string,
    @Param('participantId') pid: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(ProfileBody)) body: z.infer<typeof ProfileBody>,
  ) {
    await this.learner(ws, pid);
    await this.memory.updateProfiles(ws, [pid], body, { principal, audit: true });
    return this.learnerDetail(ws, pid);
  }

  @Patch('learners/:participantId/facts/:factId')
  @RequireCapability('memory.manage')
  async setLearnerFact(
    @Param('workspaceId') ws: string,
    @Param('participantId') pid: string,
    @Param('factId') factId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(FactBody)) body: z.infer<typeof FactBody>,
  ) {
    await this.learner(ws, pid);
    return this.memory.setFactDisabled(ws, [pid], factId, body.disabled, { principal, audit: true });
  }

  @Delete('learners/:participantId/facts/:factId')
  @RequireCapability('memory.manage')
  async deleteLearnerFact(@Param('workspaceId') ws: string, @Param('participantId') pid: string, @Param('factId') factId: string, @CurrentPrincipal() principal: Principal) {
    await this.learner(ws, pid);
    return this.memory.deleteFact(ws, [pid], factId, { principal, audit: true });
  }

  @Delete('learners/:participantId/facts')
  @RequireCapability('memory.manage')
  async clearLearner(@Param('workspaceId') ws: string, @Param('participantId') pid: string, @CurrentPrincipal() principal: Principal) {
    await this.learner(ws, pid);
    return this.memory.clearAll(ws, [pid], { principal, audit: true });
  }
}
