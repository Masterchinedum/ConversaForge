import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Course, type Enrollment } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { userIdOf } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CourseProgressService } from './course-progress.service';
import { computeProgress, parseRule, type CourseItemKindT } from './course-rules';
import { CoursesService } from './courses.service';
import { normEmail, participantForEmail, participantForUser } from './participants';

export const AssignBody = z
  .object({
    userIds: z.array(z.string().max(64)).max(500).default([]),
    teamIds: z.array(z.string().max(64)).max(100).default([]),
    emails: z.array(z.string().trim().email().max(254)).max(500).default([]),
    notify: z.boolean().default(true),
  })
  .refine((b) => b.userIds.length + b.teamIds.length + b.emails.length > 0, 'Choose at least one member, team or email');

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger('Enrollments');
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly progress: CourseProgressService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async list(workspaceId: string, courseId: string, opts: { includeDropped?: boolean } = {}) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, workspaceId, deletedAt: null },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!course) throw Errors.notFound('Course');
    const enrollments = await this.prisma.enrollment.findMany({
      where: { courseId, workspaceId, ...(opts.includeDropped ? {} : { status: { not: 'DROPPED' } }) },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });
    const participants = await this.prisma.participant.findMany({
      where: { id: { in: enrollments.map((e) => e.participantId) }, workspaceId },
      select: { id: true, name: true, email: true, userId: true, user: { select: { name: true, email: true } } },
    });
    const attempts = await this.prisma.courseItemAttempt.findMany({
      where: { enrollmentId: { in: enrollments.map((e) => e.id) } },
      select: { enrollmentId: true, courseItemId: true, generation: true, status: true, startedAt: true, completedAt: true },
    });
    return enrollments.map((e) => {
      const p = participants.find((x) => x.id === e.participantId);
      const mine = attempts.filter((a) => a.enrollmentId === e.id);
      const prog = computeProgress(course.items, mine, e.generation, course.forcedOrder);
      const lastActivity = mine.reduce<Date | null>((m, a) => {
        const t = a.completedAt ?? a.startedAt;
        return !m || t > m ? t : m;
      }, null);
      return {
        id: e.id,
        status: e.status,
        generation: e.generation,
        assigned: !!e.assignedById,
        createdAt: e.createdAt,
        startedAt: e.startedAt,
        completedAt: e.completedAt,
        lastActivityAt: lastActivity,
        learner: {
          participantId: e.participantId,
          userId: p?.userId ?? e.userId,
          name: p?.user?.name ?? p?.name ?? null,
          email: p?.user?.email ?? p?.email ?? null,
          hasAccount: !!(p?.userId ?? e.userId),
        },
        progress: { percent: prog.percent, completedRequired: prog.completedRequired, totalRequired: prog.totalRequired, complete: prog.complete },
        itemStatuses: prog.statuses,
      };
    });
  }

  async detail(workspaceId: string, courseId: string, enrollmentId: string) {
    const e = await this.prisma.enrollment.findFirst({ where: { id: enrollmentId, courseId, workspaceId } });
    if (!e) throw Errors.notFound('Enrollment');
    const course = await this.prisma.course.findFirst({ where: { id: courseId, workspaceId }, include: { items: { orderBy: { position: 'asc' } } } });
    if (!course) throw Errors.notFound('Course');
    const attempts = await this.prisma.courseItemAttempt.findMany({ where: { enrollmentId: e.id }, orderBy: { startedAt: 'desc' } });
    const p = await this.progress.progressFor(e, course.forcedOrder, course.items);
    const participant = await this.prisma.participant.findFirst({
      where: { id: e.participantId, workspaceId },
      select: { id: true, name: true, email: true, userId: true },
    });
    return {
      enrollment: { id: e.id, status: e.status, generation: e.generation, startedAt: e.startedAt, completedAt: e.completedAt, createdAt: e.createdAt },
      learner: participant,
      progress: { percent: p.percent, completedRequired: p.completedRequired, totalRequired: p.totalRequired, complete: p.complete },
      items: course.items.map((i) => ({
        id: i.id,
        title: i.title,
        kind: i.kind,
        required: i.required,
        completionRule: parseRule(i.kind as CourseItemKindT, i.completionRule),
        status: p.statuses[i.id],
        locked: p.locked[i.id],
      })),
      attempts: attempts.map((a) => ({
        id: a.id,
        courseItemId: a.courseItemId,
        generation: a.generation,
        current: a.generation === e.generation,
        status: a.status,
        reason: a.statusReason,
        sessionId: a.sessionId,
        score: a.score,
        startedAt: a.startedAt,
        completedAt: a.completedAt,
      })),
    };
  }

  private async upsertEnrollment(course: Course, participantId: string, userId: string | null, assignedById: string | null) {
    const existing = await this.prisma.enrollment.findUnique({ where: { courseId_participantId: { courseId: course.id, participantId } } });
    if (existing) {
      if (existing.status !== 'DROPPED') {
        if (!existing.assignedById && assignedById) await this.prisma.enrollment.update({ where: { id: existing.id }, data: { assignedById } });
        return { enrollment: existing, outcome: 'already' as const };
      }
      const e = await this.prisma.enrollment.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', generation: { increment: 1 }, completedAt: null, startedAt: null, lastItemId: null, assignedById, userId: userId ?? existing.userId },
      });
      return { enrollment: e, outcome: 'reactivated' as const };
    }
    try {
      const e = await this.prisma.enrollment.create({ data: { courseId: course.id, workspaceId: course.workspaceId, participantId, userId, assignedById } });
      return { enrollment: e, outcome: 'created' as const };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.enrollment.findUniqueOrThrow({ where: { courseId_participantId: { courseId: course.id, participantId } } });
        return { enrollment: again, outcome: 'already' as const };
      }
      throw err;
    }
  }

  async assign(workspaceId: string, courseId: string, principal: Principal, body: z.infer<typeof AssignBody>) {
    const course = await this.courses.findCourse(workspaceId, courseId);
    const assignedById = userIdOf(principal);
    const invalid: Array<{ value: string; reason: string }> = [];
    type Target = { participantId: string; userId: string | null; email: string | null; name: string | null; member: boolean };
    const targets = new Map<string, Target>();

    // Members
    if (body.userIds.length) {
      const members = await this.prisma.membership.findMany({
        where: { workspaceId, userId: { in: body.userIds } },
        include: { user: { select: { id: true, email: true, name: true, deletedAt: true } } },
      });
      for (const uid of body.userIds) {
        const m = members.find((x) => x.userId === uid);
        if (!m || m.user.deletedAt) {
          invalid.push({ value: uid, reason: 'Not a member of this workspace' });
          continue;
        }
        const p = await participantForUser(this.prisma, workspaceId, { userId: m.user.id, email: m.user.email, name: m.user.name });
        targets.set(p.id, { participantId: p.id, userId: m.user.id, email: m.user.email, name: m.user.name, member: true });
      }
    }
    // Teams → their participants
    if (body.teamIds.length) {
      const teams = await this.prisma.team.findMany({ where: { id: { in: body.teamIds }, workspaceId }, include: { members: true } });
      for (const tid of body.teamIds) if (!teams.some((t) => t.id === tid)) invalid.push({ value: tid, reason: 'Team not found' });
      const pids = [...new Set(teams.flatMap((t) => t.members.map((m) => m.participantId)))];
      const parts = await this.prisma.participant.findMany({
        where: { id: { in: pids }, workspaceId, deletedAt: null },
        include: { user: { select: { email: true, name: true } } },
      });
      const memberUserIds = new Set(
        (await this.prisma.membership.findMany({ where: { workspaceId, userId: { in: parts.map((p) => p.userId).filter(Boolean) as string[] } }, select: { userId: true } })).map((m) => m.userId),
      );
      for (const p of parts) {
        targets.set(p.id, {
          participantId: p.id,
          userId: p.userId,
          email: p.user?.email ?? p.email,
          name: p.user?.name ?? p.name,
          member: !!p.userId && memberUserIds.has(p.userId),
        });
      }
    }
    // Emails (people who may not have an account yet)
    for (const raw of body.emails) {
      const email = normEmail(raw)!;
      const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, name: true, deletedAt: true, emailVerifiedAt: true } });
      // Only an account that verified this address may be bound to an email assignment.
      const liveUser = user && !user.deletedAt && user.emailVerifiedAt ? user : null;
      const p = await participantForEmail(this.prisma, workspaceId, email, liveUser?.id ?? null);
      const member = liveUser ? !!(await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: liveUser.id } } })) : false;
      targets.set(p.id, { participantId: p.id, userId: p.userId ?? liveUser?.id ?? null, email, name: liveUser?.name ?? p.name, member });
    }

    const counts = { created: 0, reactivated: 0, already: 0 };
    const notify: Target[] = [];
    for (const t of targets.values()) {
      const r = await this.upsertEnrollment(course, t.participantId, t.userId, assignedById);
      counts[r.outcome]++;
      if (r.outcome !== 'already') notify.push(t);
    }
    await this.audit.log({
      workspaceId,
      principal,
      action: 'course.enrollments_assigned',
      targetType: 'course',
      targetId: course.id,
      metadata: { ...counts, users: body.userIds.length, teams: body.teamIds.length, emails: body.emails.length, invalid: invalid.length },
    });
    if (body.notify && course.status === 'PUBLISHED') await this.sendNotices(course, notify);
    return { ...counts, invalid, total: targets.size };
  }

  private async sendNotices(course: Course, targets: Array<{ email: string | null; member: boolean }>) {
    const web = env.WEB_PUBLIC_URL.replace(/\/$/, '');
    const ws = await this.prisma.workspace.findUnique({ where: { id: course.workspaceId }, select: { name: true } });
    for (const t of targets) {
      if (!t.email) continue;
      const link = t.member ? `${web}/w/${course.workspaceId}/learn/courses/${course.id}` : course.shareToken ? `${web}/c/${course.shareToken}` : null;
      if (!link) continue; // non-member without a share link: nothing they can open yet
      try {
        await this.mail.send({
          to: t.email,
          subject: `You have been enrolled in "${course.title}"`,
          text: `${ws?.name ?? 'Your organization'} enrolled you in the course "${course.title}".\n\nOpen it here: ${link}\n\nIf you do not have an account yet, sign up with this email address to start.`,
        });
      } catch (e: any) {
        this.logger.warn(`Enrollment notice to ${t.email} failed: ${e?.message}`);
      }
    }
  }

  async unenroll(workspaceId: string, courseId: string, enrollmentId: string, principal: Principal) {
    const e = await this.prisma.enrollment.findFirst({ where: { id: enrollmentId, courseId, workspaceId } });
    if (!e) throw Errors.notFound('Enrollment');
    await this.prisma.enrollment.update({ where: { id: e.id }, data: { status: 'DROPPED' } });
    await this.audit.log({ workspaceId, principal, action: 'course.unenrolled', targetType: 'enrollment', targetId: e.id, metadata: { courseId } });
    return { ok: true };
  }

  /** Reviewer marks a `manual` item complete for a learner (current generation). */
  async markComplete(workspaceId: string, courseId: string, enrollmentId: string, itemId: string, principal: Principal) {
    const e = await this.prisma.enrollment.findFirst({ where: { id: enrollmentId, courseId, workspaceId, status: { not: 'DROPPED' } } });
    if (!e) throw Errors.notFound('Enrollment');
    const item = await this.prisma.courseItem.findFirst({ where: { id: itemId, courseId } });
    if (!item) throw Errors.notFound('Course item');
    const rule = parseRule(item.kind as CourseItemKindT, item.completionRule);
    if (rule.type !== 'manual') throw Errors.conflict('Only items with a manual completion rule can be marked complete by a reviewer');
    await this.completeManually(e, item.id);
    await this.audit.log({
      workspaceId,
      principal,
      action: 'course.item_marked_complete',
      targetType: 'enrollment',
      targetId: e.id,
      metadata: { courseId, itemId, generation: e.generation },
    });
    return this.detail(workspaceId, courseId, e.id);
  }

  private async completeManually(e: Enrollment, itemId: string) {
    const done = await this.prisma.courseItemAttempt.findFirst({ where: { enrollmentId: e.id, courseItemId: itemId, generation: e.generation, status: 'COMPLETED' } });
    if (!done) {
      // Prefer completing the learner's latest open attempt (keeps its session link); else record a new one.
      const open = await this.prisma.courseItemAttempt.findFirst({
        where: { enrollmentId: e.id, courseItemId: itemId, generation: e.generation, status: { not: 'COMPLETED' } },
        orderBy: { startedAt: 'desc' },
      });
      const now = new Date();
      if (open) await this.prisma.courseItemAttempt.update({ where: { id: open.id }, data: { status: 'COMPLETED', statusReason: 'Marked complete by a reviewer', completedAt: now } });
      else
        await this.prisma.courseItemAttempt.create({
          data: { enrollmentId: e.id, courseItemId: itemId, generation: e.generation, status: 'COMPLETED', statusReason: 'Marked complete by a reviewer', startedAt: now, completedAt: now },
        });
    }
    await this.progress.refreshEnrollmentStatus(e);
  }

  /** Members and teams for the assignment picker. */
  async assignable(workspaceId: string) {
    const [members, teams] = await Promise.all([
      this.prisma.membership.findMany({
        where: { workspaceId, user: { deletedAt: null } },
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
        take: 2000,
      }),
      this.prisma.team.findMany({ where: { workspaceId }, select: { id: true, name: true, _count: { select: { members: true } } }, orderBy: { name: 'asc' } }),
    ]);
    return {
      members: members.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, role: m.role })),
      teams: teams.map((t) => ({ id: t.id, name: t.name, memberCount: t._count.members })),
    };
  }
}
