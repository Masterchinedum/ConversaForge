import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Course, type CourseItem, type Enrollment, type Participant } from '@prisma/client';
import { can, type Role } from '@cf/shared';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionsService } from '../runtime/sessions.service';
import { CourseProgressService } from './course-progress.service';
import { computeProgress, parseRule, participantCanSeeScores, type CourseItemKindT, type ProgressResult } from './course-rules';
import { CoursesService } from './courses.service';
import { claimEmailEnrollments, normEmail, participantForUser } from './participants';

export interface LearnerRef {
  userId: string;
  email: string;
  name: string | null;
}

/**
 * How the learner reached the course:
 *  - member: workspace member using /w/:ws/learn (role decides preview rights)
 *  - token:  any logged-in user holding the course share token (/c/:token)
 */
export type LearnAccess = { via: 'member'; role: Role } | { via: 'token' };

type CourseWithItems = Course & { items: CourseItem[] };

@Injectable()
export class LearnService {
  private readonly logger = new Logger('Learn');

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly progress: CourseProgressService,
    private readonly sessions: SessionsService,
  ) {}

  // ───────────── resolution & access ─────────────

  private async findParticipant(workspaceId: string, userId: string): Promise<Participant | null> {
    return this.prisma.participant.findFirst({ where: { workspaceId, userId }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * The learner's participant, linking an unclaimed participant created for their email (assignment
   * before signup) and moving any email-assigned enrollments onto it. Does not create a row otherwise.
   */
  private async learnerParticipant(workspaceId: string, user: LearnerRef): Promise<Participant | null> {
    let p = await this.findParticipant(workspaceId, user.userId);
    if (!p) {
      const email = normEmail(user.email);
      const unclaimed = email ? await this.prisma.participant.findFirst({ where: { workspaceId, email, userId: null }, select: { id: true } }) : null;
      if (!unclaimed) return null;
      p = await participantForUser(this.prisma, workspaceId, user);
    }
    await claimEmailEnrollments(this.prisma, workspaceId, user, p);
    return p;
  }

  private async findEnrollment(courseId: string, workspaceId: string, user: LearnerRef): Promise<Enrollment | null> {
    const p = await this.learnerParticipant(workspaceId, user);
    if (p) {
      const e = await this.prisma.enrollment.findUnique({ where: { courseId_participantId: { courseId, participantId: p.id } } });
      if (e) return e;
    }
    // Enrollment may be recorded against the user directly (e.g. participant row created differently).
    return this.prisma.enrollment.findFirst({ where: { courseId, workspaceId, userId: user.userId }, orderBy: { createdAt: 'asc' } });
  }

  async loadMemberCourse(workspaceId: string, courseId: string): Promise<CourseWithItems> {
    const c = await this.prisma.course.findFirst({
      where: { id: courseId, workspaceId, deletedAt: null },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!c) throw Errors.notFound('Course');
    return c;
  }

  async loadTokenCourse(token: string): Promise<CourseWithItems> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw Errors.notFound('Course');
    const c = await this.prisma.course.findFirst({
      where: { shareToken: token, deletedAt: null, status: 'PUBLISHED' },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!c) throw Errors.notFound('Course');
    const ws = await this.prisma.workspace.findFirst({ where: { id: c.workspaceId, deletedAt: null }, select: { id: true } });
    if (!ws) throw Errors.notFound('Course');
    return c;
  }

  private canPreview(access: LearnAccess) {
    return access.via === 'member' && can(access.role, 'courses.edit');
  }

  /** Whether the user may self-enroll through this access path. */
  private canSelfEnroll(course: Course, access: LearnAccess) {
    if (this.canPreview(access)) return true;
    if (course.status !== 'PUBLISHED') return false;
    if (access.via === 'token') return true; // holding a valid (unrevoked) share token
    return course.visibility === 'ORGANIZATION' || course.visibility === 'PUBLIC';
  }

  /** Throws 404 when the user may not see the course at all. */
  private assertVisible(course: Course, enrollment: Enrollment | null, access: LearnAccess) {
    if (this.canPreview(access)) return;
    const active = enrollment && enrollment.status !== 'DROPPED';
    if (course.status === 'PUBLISHED' && (active || this.canSelfEnroll(course, access))) return;
    if (course.status === 'ARCHIVED' && active) return; // read-only history
    throw Errors.notFound('Course');
  }

  private assertRunnable(course: Course, access: LearnAccess) {
    if (course.status === 'PUBLISHED') return;
    if (course.status === 'DRAFT' && this.canPreview(access)) return;
    throw Errors.conflict(course.status === 'ARCHIVED' ? 'This course has been archived' : 'This course is not published yet');
  }

  // ───────────── overview ─────────────

  async overview(workspaceId: string, user: LearnerRef, role: Role) {
    const participant = await this.learnerParticipant(workspaceId, user);
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        workspaceId,
        status: { not: 'DROPPED' },
        OR: [{ userId: user.userId }, ...(participant ? [{ participantId: participant.id }] : [])],
        course: { deletedAt: null, status: { in: ['PUBLISHED', 'ARCHIVED'] } },
      },
      include: { course: { include: { items: { orderBy: { position: 'asc' } } } } },
      orderBy: { updatedAt: 'desc' },
    });
    const mine = await Promise.all(
      enrollments.map(async (e) => {
        const p = await this.progress.progressFor(e, e.course.forcedOrder, e.course.items);
        const next = e.course.items.find((i) => i.id === p.nextItemId);
        return {
          enrollment: this.enrollmentDto(e),
          course: await this.courseSummary(e.course),
          progress: this.progressDto(p),
          nextItem: next ? { id: next.id, title: next.title, kind: next.kind } : null,
        };
      }),
    );
    const enrolledIds = new Set(enrollments.map((e) => e.courseId));
    const available = await this.prisma.course.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: 'PUBLISHED',
        visibility: { in: ['ORGANIZATION', 'PUBLIC'] },
        id: { notIn: [...enrolledIds] },
      },
      include: { items: { select: { id: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return {
      enrollments: mine,
      available: await Promise.all(
        available.map(async (c) => ({ ...(await this.courseSummary(c)), itemCount: c.items.length })),
      ),
      canPreviewDrafts: can(role, 'courses.edit'),
    };
  }

  private async courseSummary(c: Course) {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      title: c.title,
      description: c.description,
      coverImageUrl: await this.courses.coverImageUrl(c),
      forcedOrder: c.forcedOrder,
      visibility: c.visibility,
      status: c.status,
    };
  }

  private enrollmentDto(e: Enrollment) {
    return {
      id: e.id,
      status: e.status,
      generation: e.generation,
      assigned: !!e.assignedById,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      createdAt: e.createdAt,
      lastItemId: e.lastItemId,
    };
  }

  private progressDto(p: ProgressResult) {
    return { percent: p.percent, completedRequired: p.completedRequired, totalRequired: p.totalRequired, complete: p.complete };
  }

  // ───────────── player detail ─────────────

  async detail(course: CourseWithItems, user: LearnerRef, access: LearnAccess) {
    let enrollment = await this.findEnrollment(course.id, course.workspaceId, user);
    this.assertVisible(course, enrollment, access);
    if (enrollment && enrollment.status !== 'DROPPED') {
      await this.progress.reconcileEnrollment(enrollment.id, enrollment.generation);
      enrollment = await this.prisma.enrollment.findUnique({ where: { id: enrollment.id } });
    }
    const active = enrollment && enrollment.status !== 'DROPPED' ? enrollment : null;
    const attempts = active
      ? await this.prisma.courseItemAttempt.findMany({ where: { enrollmentId: active.id }, orderBy: { startedAt: 'desc' } })
      : [];
    const p = active
      ? await this.progress.progressFor(active, course.forcedOrder, course.items)
      : // Not enrolled: nothing counts (0%); locks computed as for a fresh enrollment.
        computeProgress(course.items, [], 1, course.forcedOrder);

    const dtos = await this.courses.itemDtos(course.workspaceId, course.items);
    const visibleScoreSessions = await this.scoreVisibleSessions(course.workspaceId, attempts.filter((a) => a.score != null && a.sessionId).map((a) => a.sessionId!));
    const items = dtos.map((d) => {
      const mine = active ? attempts.filter((a) => a.courseItemId === d.id && a.generation === active.generation) : [];
      const last = mine[0];
      return {
        id: d.id,
        position: d.position,
        kind: d.kind,
        title: d.title,
        description: d.description,
        required: d.required,
        completionRule: d.completionRule,
        scenario: d.scenario ? { id: d.scenario.id, name: d.scenario.name, type: d.scenario.type, publicDescription: d.scenario.publicDescription, runnable: d.scenario.runnable } : null,
        url: d.kind === 'LINK' || (!d.assetId && d.url) ? d.url : null,
        asset: d.asset ? { fileName: d.asset.fileName, mimeType: d.asset.mimeType } : null,
        status: p.statuses[d.id] ?? 'NOT_STARTED',
        locked: p.locked[d.id] ?? false,
        attemptCount: mine.length,
        lastAttempt: last
          ? {
              id: last.id,
              status: last.status,
              reason: last.statusReason,
              sessionId: last.sessionId,
              // Numeric scores only when the scenario lets participants see them (same rule as the participant report).
              score: last.sessionId && visibleScoreSessions.has(last.sessionId) ? last.score : null,
              startedAt: last.startedAt,
              completedAt: last.completedAt,
            }
          : null,
      };
    });
    const previousGenerations = active
      ? [...new Set(attempts.filter((a) => a.generation < active.generation).map((a) => a.generation))].sort((a, b) => b - a).map((g) => ({
          generation: g,
          completedItems: new Set(attempts.filter((a) => a.generation === g && a.status === 'COMPLETED').map((a) => a.courseItemId)).size,
          attempts: attempts.filter((a) => a.generation === g).length,
        }))
      : [];
    return {
      course: await this.courseSummary(course),
      enrollment: active ? this.enrollmentDto(active) : null,
      progress: this.progressDto(p),
      nextItemId: active ? p.nextItemId : null,
      items,
      history: previousGenerations,
      canEnroll: !active && this.canSelfEnroll(course, access),
      canUnenroll: !!active && !active.assignedById,
      preview: course.status !== 'PUBLISHED',
    };
  }

  private async scoreVisibleSessions(workspaceId: string, sessionIds: string[]): Promise<Set<string>> {
    if (!sessionIds.length) return new Set();
    const sessions = await this.prisma.session.findMany({
      where: { id: { in: sessionIds }, workspaceId },
      select: {
        id: true,
        scenarioVersion: { select: { config: true } },
        evaluations: { where: { isCurrent: true }, orderBy: { createdAt: 'desc' }, take: 1, select: { humanReviewRequired: true, reviewedAt: true } },
      },
    });
    return new Set(sessions.filter((s) => participantCanSeeScores(s.scenarioVersion.config, s.evaluations[0])).map((s) => s.id));
  }

  // ───────────── enrollment ─────────────

  async enroll(course: Course, user: LearnerRef, access: LearnAccess): Promise<Enrollment> {
    const existing = await this.findEnrollment(course.id, course.workspaceId, user);
    if (existing && existing.status !== 'DROPPED') return existing;
    if (!this.canSelfEnroll(course, access)) {
      if (existing || course.status === 'PUBLISHED') throw Errors.forbidden('This course is by assignment only');
      throw Errors.notFound('Course');
    }
    if (existing) {
      // Re-enrolling after dropping out starts a fresh generation: nothing from before counts.
      return this.prisma.enrollment.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', generation: { increment: 1 }, completedAt: null, startedAt: null, lastItemId: null, userId: user.userId },
      });
    }
    const participant = await participantForUser(this.prisma, course.workspaceId, user);
    try {
      return await this.prisma.enrollment.create({
        data: { courseId: course.id, workspaceId: course.workspaceId, participantId: participant.id, userId: user.userId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.enrollment.findUnique({ where: { courseId_participantId: { courseId: course.id, participantId: participant.id } } });
        if (again) return again;
      }
      throw e;
    }
  }

  async unenroll(course: Course, user: LearnerRef) {
    const e = await this.findEnrollment(course.id, course.workspaceId, user);
    if (!e || e.status === 'DROPPED') throw Errors.notFound('Enrollment');
    if (e.assignedById) throw Errors.forbidden('This course was assigned to you; ask the course owner to remove it');
    await this.prisma.enrollment.update({ where: { id: e.id }, data: { status: 'DROPPED' } });
    return { ok: true };
  }

  /** Active enrollment for acting on items; self-enrolls when that is allowed. */
  private async requireEnrollment(course: Course, user: LearnerRef, access: LearnAccess): Promise<Enrollment> {
    const e = await this.findEnrollment(course.id, course.workspaceId, user);
    if (e && e.status !== 'DROPPED') return e;
    this.assertVisible(course, e, access);
    return this.enroll(course, user, access);
  }

  private async currentProgress(course: CourseWithItems, e: Enrollment) {
    return this.progress.progressFor(e, course.forcedOrder, course.items);
  }

  private findItem(course: CourseWithItems, itemId: string) {
    const item = course.items.find((i) => i.id === itemId);
    if (!item) throw Errors.notFound('Course item');
    return item;
  }

  private assertUnlocked(p: ProgressResult, item: CourseItem) {
    if (p.locked[item.id]) {
      throw Errors.conflict('Complete the earlier required items first — this course must be taken in order', { code: 'item_locked' });
    }
  }

  // ───────────── actions ─────────────

  async start(course: CourseWithItems, user: LearnerRef, itemId: string, access: LearnAccess) {
    const item = this.findItem(course, itemId);
    const e = await this.requireEnrollment(course, user, access);
    this.assertRunnable(course, access);
    const p = await this.currentProgress(course, e);
    this.assertUnlocked(p, item);

    await this.prisma.enrollment.update({
      where: { id: e.id },
      data: { lastItemId: item.id, ...(e.startedAt ? {} : { startedAt: new Date() }) },
    });

    if (item.kind !== 'SCENARIO') {
      return { kind: item.kind, itemId: item.id, content: await this.contentFor(course, item) };
    }
    if (!item.scenarioId) throw Errors.conflict('This item has no scenario');
    const attempt = await this.prisma.courseItemAttempt.create({
      data: { enrollmentId: e.id, courseItemId: item.id, generation: e.generation, status: 'STARTED' },
    });
    try {
      const { session, sessionToken } = await this.sessions.createSession({
        workspaceId: course.workspaceId,
        scenarioId: item.scenarioId,
        versionId: item.pinnedVersionId,
        channel: 'BROWSER',
        participant: { userId: user.userId, email: user.email, name: user.name },
        metadata: { courseId: course.id, courseItemId: item.id, source: access.via === 'token' ? 'course_link' : 'course' },
        enrollmentId: e.id,
        courseItemAttemptId: attempt.id,
        coachMode: true,
      });
      await this.prisma.courseItemAttempt.update({ where: { id: attempt.id }, data: { sessionId: session.id } });
      if (session.participantId !== e.participantId) {
        this.logger.warn(`Session ${session.id} participant ${session.participantId} differs from enrollment participant ${e.participantId}`);
      }
      return { kind: 'SCENARIO' as const, itemId: item.id, attemptId: attempt.id, sessionId: session.id, sessionToken, liveUrl: `/live/${session.id}` };
    } catch (err) {
      await this.prisma.courseItemAttempt.delete({ where: { id: attempt.id } }).catch(() => undefined);
      throw err;
    }
  }

  async complete(course: CourseWithItems, user: LearnerRef, itemId: string, access: LearnAccess) {
    const item = this.findItem(course, itemId);
    const e = await this.requireEnrollment(course, user, access);
    this.assertRunnable(course, access);
    const rule = parseRule(item.kind as CourseItemKindT, item.completionRule);
    if (rule.type !== 'viewed') {
      throw Errors.conflict(
        rule.type === 'manual' ? 'A reviewer marks this item complete' : 'This item is completed by finishing its practice session',
      );
    }
    const p = await this.currentProgress(course, e);
    this.assertUnlocked(p, item);
    const done = await this.prisma.courseItemAttempt.findFirst({
      where: { enrollmentId: e.id, courseItemId: item.id, generation: e.generation, status: 'COMPLETED' },
    });
    if (!done) {
      const now = new Date();
      await this.prisma.courseItemAttempt.create({
        data: { enrollmentId: e.id, courseItemId: item.id, generation: e.generation, status: 'COMPLETED', startedAt: now, completedAt: now },
      });
    }
    await this.prisma.enrollment.update({
      where: { id: e.id },
      data: { lastItemId: item.id, ...(e.startedAt ? {} : { startedAt: new Date() }) },
    });
    await this.progress.refreshEnrollmentStatus(e);
    return this.detail(course, user, access);
  }

  async continue(course: CourseWithItems, user: LearnerRef, access: LearnAccess) {
    const e = await this.requireEnrollment(course, user, access);
    const p = await this.currentProgress(course, e);
    if (!p.nextItemId) return { done: true, progress: this.progressDto(p) };
    const next = this.findItem(course, p.nextItemId);
    if (next.kind === 'SCENARIO') return { done: false, ...(await this.start(course, user, next.id, access)) };
    return { done: false, kind: next.kind, itemId: next.id, content: await this.contentFor(course, next) };
  }

  async startOver(course: CourseWithItems, user: LearnerRef, access: LearnAccess) {
    const e = await this.findEnrollment(course.id, course.workspaceId, user);
    if (!e || e.status === 'DROPPED') throw Errors.notFound('Enrollment');
    this.assertVisible(course, e, access);
    // Old attempts are kept (history) but no longer count: progress only reads the current generation.
    await this.prisma.enrollment.update({
      where: { id: e.id },
      data: { generation: { increment: 1 }, status: 'ACTIVE', completedAt: null, lastItemId: null, startedAt: new Date() },
    });
    return this.detail(course, user, access);
  }

  async content(course: CourseWithItems, user: LearnerRef, itemId: string, access: LearnAccess) {
    const item = this.findItem(course, itemId);
    const e = await this.findEnrollment(course.id, course.workspaceId, user);
    this.assertVisible(course, e, access);
    if (!e || e.status === 'DROPPED') {
      if (!this.canPreview(access)) throw Errors.forbidden('Enroll in the course to open its content');
    } else {
      const p = await this.currentProgress(course, e);
      this.assertUnlocked(p, item);
    }
    return this.contentFor(course, item);
  }

  private async contentFor(course: Course, item: CourseItem) {
    if (item.kind === 'SCENARIO') return null;
    if (item.assetId) {
      const a = await this.prisma.mediaAsset.findFirst({ where: { id: item.assetId, workspaceId: course.workspaceId, deletedAt: null } });
      if (!a) throw Errors.notFound('Media');
      return { url: await this.courses.signedAssetUrl(course.workspaceId, a.id, 1800), mimeType: a.mimeType, fileName: a.fileName, external: false };
    }
    return { url: item.url, mimeType: null, fileName: null, external: true };
  }
}
