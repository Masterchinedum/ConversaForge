import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';

export const TeamBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();
/** Add either an existing participant of this workspace, or a member (their participant is created/linked). */
export const AddTeamMemberBody = z
  .object({ participantId: z.string().max(64).optional(), userId: z.string().max(64).optional() })
  .strict()
  .refine((b) => !!b.participantId !== !!b.userId, 'Provide exactly one of participantId or userId');

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    const teams = await this.prisma.team.findMany({ where: { workspaceId }, include: { _count: { select: { members: true } } }, orderBy: { name: 'asc' } });
    return { data: teams.map((t) => ({ id: t.id, name: t.name, memberCount: t._count.members, createdAt: t.createdAt })) };
  }

  private async teamOr404(workspaceId: string, teamId: string) {
    const t = await this.prisma.team.findFirst({ where: { id: teamId, workspaceId } });
    if (!t) throw Errors.notFound('Team');
    return t;
  }

  async get(workspaceId: string, teamId: string) {
    const team = await this.teamOr404(workspaceId, teamId);
    const rows = await this.prisma.teamMember.findMany({ where: { teamId: team.id }, orderBy: { createdAt: 'asc' } });
    const participants = rows.length
      ? await this.prisma.participant.findMany({
          where: { id: { in: rows.map((r) => r.participantId) }, workspaceId },
          select: { id: true, name: true, email: true, userId: true, externalId: true, deletedAt: true },
        })
      : [];
    return {
      id: team.id,
      name: team.name,
      createdAt: team.createdAt,
      members: rows
        .map((r) => ({ membershipId: r.id, addedAt: r.createdAt, participant: participants.find((p) => p.id === r.participantId) }))
        .filter((r) => r.participant && !r.participant.deletedAt)
        .map((r) => ({
          id: r.membershipId,
          participantId: r.participant!.id,
          name: r.participant!.name,
          email: r.participant!.email,
          userId: r.participant!.userId,
          externalId: r.participant!.externalId,
          addedAt: r.addedAt,
        })),
    };
  }

  async create(workspaceId: string, name: string, actor: Principal) {
    const exists = await this.prisma.team.findFirst({ where: { workspaceId, name } });
    if (exists) throw Errors.conflict('A team with that name already exists');
    const t = await this.prisma.team.create({ data: { workspaceId, name } });
    await this.audit.log({ workspaceId, principal: actor, action: 'team.created', targetType: 'team', targetId: t.id, metadata: { name } });
    return { id: t.id, name: t.name, memberCount: 0, createdAt: t.createdAt };
  }

  async rename(workspaceId: string, teamId: string, name: string, actor: Principal) {
    const t = await this.teamOr404(workspaceId, teamId);
    const clash = await this.prisma.team.findFirst({ where: { workspaceId, name, id: { not: t.id } } });
    if (clash) throw Errors.conflict('A team with that name already exists');
    const row = await this.prisma.team.update({ where: { id: t.id }, data: { name } });
    await this.audit.log({ workspaceId, principal: actor, action: 'team.renamed', targetType: 'team', targetId: t.id, metadata: { from: t.name, to: name } });
    return { id: row.id, name: row.name };
  }

  async remove(workspaceId: string, teamId: string, actor: Principal) {
    const t = await this.teamOr404(workspaceId, teamId);
    await this.prisma.team.delete({ where: { id: t.id } });
    await this.audit.log({ workspaceId, principal: actor, action: 'team.deleted', targetType: 'team', targetId: t.id, metadata: { name: t.name } });
    return { ok: true };
  }

  /** Participant for a workspace member (find by user, then by email, else create). */
  private async participantForMember(workspaceId: string, userId: string) {
    const m = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
    if (!m) throw Errors.validation('That user is not a member of this workspace', [{ path: 'userId', message: 'Not a member' }]);
    const byUser = await this.prisma.participant.findFirst({ where: { workspaceId, userId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    if (byUser) return byUser;
    const byEmail = await this.prisma.participant.findFirst({ where: { workspaceId, email: m.user.email.toLowerCase(), userId: null, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    if (byEmail) return this.prisma.participant.update({ where: { id: byEmail.id }, data: { userId } });
    return this.prisma.participant.create({ data: { workspaceId, userId, email: m.user.email.toLowerCase(), name: m.user.name } });
  }

  async addMember(workspaceId: string, teamId: string, body: z.infer<typeof AddTeamMemberBody>, actor: Principal) {
    const team = await this.teamOr404(workspaceId, teamId);
    const participant = body.userId
      ? await this.participantForMember(workspaceId, body.userId)
      : await this.prisma.participant.findFirst({ where: { id: body.participantId, workspaceId, deletedAt: null } });
    if (!participant) throw Errors.validation('Participant not found in this workspace', [{ path: 'participantId', message: 'Unknown participant' }]);
    const row = await this.prisma.teamMember.upsert({
      where: { teamId_participantId: { teamId: team.id, participantId: participant.id } },
      create: { teamId: team.id, participantId: participant.id },
      update: {},
    });
    await this.audit.log({ workspaceId, principal: actor, action: 'team.member_added', targetType: 'team', targetId: team.id, metadata: { participantId: participant.id } });
    return { id: row.id, participantId: participant.id, name: participant.name, email: participant.email };
  }

  async removeMember(workspaceId: string, teamId: string, participantId: string, actor: Principal) {
    const team = await this.teamOr404(workspaceId, teamId);
    const res = await this.prisma.teamMember.deleteMany({ where: { teamId: team.id, participantId } });
    if (!res.count) throw Errors.notFound('Team member');
    await this.audit.log({ workspaceId, principal: actor, action: 'team.member_removed', targetType: 'team', targetId: team.id, metadata: { participantId } });
    return { ok: true };
  }

  /** People who can be added to a team: workspace members and known participants (search by name/email). */
  async candidates(workspaceId: string, q?: string) {
    const term = q?.trim().slice(0, 100);
    const [members, participants] = await Promise.all([
      this.prisma.membership.findMany({
        where: {
          workspaceId,
          user: { deletedAt: null, ...(term ? { OR: [{ email: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }] } : {}) },
        },
        include: { user: { select: { id: true, email: true, name: true } } },
        take: 25,
      }),
      this.prisma.participant.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          userId: null,
          ...(term ? { OR: [{ email: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }, { externalId: { contains: term } }] } : {}),
        },
        select: { id: true, name: true, email: true, externalId: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ]);
    return {
      members: members.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name, role: m.role })),
      participants,
    };
  }
}
