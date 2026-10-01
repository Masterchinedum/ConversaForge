import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { CourseItem, Enrollment } from '@prisma/client';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService } from '../../common/queue/queue.service';
import { computeProgress, decideAttempt, parseRule, participantCanSeeScores, type CourseItemKindT, type ProgressResult } from './course-rules';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED']);

/**
 * Keeps course item attempts and enrollment status in sync with sessions:
 *   session.terminal / session.analyzed / session.failed → durable job → refreshAttemptForSession().
 * The refresh is computed from source rows (session state + current evaluation), so duplicate or
 * out-of-order events are harmless, and a COMPLETED attempt is never downgraded.
 */
@Injectable()
export class CourseProgressService implements OnModuleInit {
  private readonly logger = new Logger('CourseProgress');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly queue: QueueService,
  ) {}

  onModuleInit() {
    this.events.on('session.terminal', (p) => this.onSessionEvent(p.sessionId, `terminal_${p.state}`));
    this.events.on('session.analyzed', (p) => this.onSessionEvent(p.sessionId, `analyzed_${p.evaluationId ?? 'none'}`));
    this.events.on('session.failed', (p) => this.onSessionEvent(p.sessionId, 'analysis_failed'));
    this.queue.process<{ sessionId: string }>(QUEUES.courses, async (job) => this.refreshAttemptForSession(job.data.sessionId), 4);
  }

  private async onSessionEvent(sessionId: string, trigger: string) {
    const s = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { courseItemAttemptId: true } });
    if (!s?.courseItemAttemptId) return;
    try {
      await this.queue.enqueue(QUEUES.courses, 'attempt.refresh', { sessionId }, { jobId: `course_${sessionId}_${trigger}` });
    } catch (e: any) {
      this.logger.warn(`Could not enqueue course refresh for ${sessionId} (${e?.message}); processing inline`);
      await this.refreshAttemptForSession(sessionId);
    }
  }

  /** Idempotent: recompute the attempt linked to this session, then the enrollment status. */
  async refreshAttemptForSession(sessionId: string): Promise<{ status: string; reason: string | null } | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        workspaceId: true,
        state: true,
        consent: true,
        analysisStatus: true,
        enrollmentId: true,
        courseItemAttemptId: true,
        scenarioVersionId: true,
      },
    });
    if (!session?.courseItemAttemptId) return null;
    const attempt = await this.prisma.courseItemAttempt.findFirst({
      where: { id: session.courseItemAttemptId, enrollment: { workspaceId: session.workspaceId } },
      include: { courseItem: true, enrollment: true },
    });
    if (!attempt) return null;
    if (attempt.sessionId && attempt.sessionId !== session.id) {
      this.logger.warn(`Session ${session.id} claims attempt ${attempt.id} which belongs to session ${attempt.sessionId}; ignoring`);
      return null;
    }
    if (session.enrollmentId && session.enrollmentId !== attempt.enrollmentId) {
      this.logger.warn(`Session ${session.id} enrollment mismatch for attempt ${attempt.id}; ignoring`);
      return null;
    }
    if (attempt.status === 'COMPLETED') {
      // Never downgrade; just record the (latest) score for display once analysis has run.
      const ev = await this.prisma.evaluation.findFirst({
        where: { sessionId: session.id, workspaceId: session.workspaceId, isCurrent: true, status: { in: ['COMPLETED', 'PARTIAL'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, overallScore: true, insufficientEvidence: true },
      });
      if (ev && ev.id !== attempt.evaluationId && attempt.courseItem.completionRule && parseRule(attempt.courseItem.kind as CourseItemKindT, attempt.courseItem.completionRule).type !== 'min_score') {
        await this.prisma.courseItemAttempt.update({
          where: { id: attempt.id },
          data: { evaluationId: ev.id, score: ev.insufficientEvidence ? null : ev.overallScore },
        });
      }
      await this.refreshEnrollmentStatus(attempt.enrollment);
      return { status: 'COMPLETED', reason: null };
    }
    if (!TERMINAL.has(session.state)) return { status: attempt.status, reason: attempt.statusReason };

    const rule = parseRule(attempt.courseItem.kind as CourseItemKindT, attempt.courseItem.completionRule);
    const evaluation = await this.prisma.evaluation.findFirst({
      where: { sessionId: session.id, workspaceId: session.workspaceId, isCurrent: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, overallScore: true, insufficientEvidence: true, humanReviewRequired: true, reviewedAt: true },
    });
    const analysisSkipped = await this.analysisSkipped(session);
    const version = await this.prisma.scenarioVersion.findFirst({
      where: { id: session.scenarioVersionId, workspaceId: session.workspaceId },
      select: { config: true },
    });
    const scoresVisible = participantCanSeeScores(version?.config, evaluation);
    const decision = decideAttempt({ rule, sessionState: session.state, analysisSkipped, evaluation, scoresVisible });

    await this.prisma.courseItemAttempt.updateMany({
      where: { id: attempt.id, status: { not: 'COMPLETED' } },
      data: {
        sessionId: session.id,
        status: decision.status,
        statusReason: decision.reason,
        score: decision.score ?? evaluation?.overallScore ?? null,
        evaluationId: decision.evaluationId ?? evaluation?.id ?? null,
        completedAt: decision.status === 'COMPLETED' ? new Date() : null,
      },
    });
    await this.refreshEnrollmentStatus(attempt.enrollment);
    return { status: decision.status, reason: decision.reason };
  }

  private async analysisSkipped(session: { workspaceId: string; consent: unknown; analysisStatus: string; scenarioVersionId: string }) {
    if (session.analysisStatus === 'SKIPPED') return true;
    const consent = (session.consent ?? {}) as { analysis?: boolean };
    if (consent.analysis === false) return true;
    const v = await this.prisma.scenarioVersion.findFirst({
      where: { id: session.scenarioVersionId, workspaceId: session.workspaceId },
      select: { config: true },
    });
    const cfg = (v?.config ?? {}) as { analysis?: { enabled?: boolean }; rubric?: { enabled?: boolean; criteria?: unknown[] } };
    if (cfg.analysis?.enabled === false) return true;
    if (cfg.rubric && (cfg.rubric.enabled === false || (Array.isArray(cfg.rubric.criteria) && cfg.rubric.criteria.length === 0))) return true;
    return false;
  }

  async progressFor(enrollment: Pick<Enrollment, 'id' | 'generation' | 'courseId'>, forcedOrder: boolean, items?: CourseItem[]): Promise<ProgressResult> {
    const its = items ?? (await this.prisma.courseItem.findMany({ where: { courseId: enrollment.courseId }, orderBy: { position: 'asc' } }));
    const attempts = await this.prisma.courseItemAttempt.findMany({
      where: { enrollmentId: enrollment.id, generation: enrollment.generation },
      select: { courseItemId: true, generation: true, status: true, startedAt: true, completedAt: true },
    });
    return computeProgress(its, attempts, enrollment.generation, forcedOrder);
  }

  /** Mark the enrollment COMPLETED once all required items of the current generation are complete (idempotent). */
  async refreshEnrollmentStatus(enrollment: Pick<Enrollment, 'id' | 'generation' | 'courseId' | 'status'>) {
    if (enrollment.status === 'DROPPED') return;
    const course = await this.prisma.course.findUnique({ where: { id: enrollment.courseId }, select: { forcedOrder: true } });
    const fresh = await this.prisma.enrollment.findUnique({ where: { id: enrollment.id } });
    if (!course || !fresh || fresh.status === 'DROPPED') return;
    const p = await this.progressFor(fresh, course.forcedOrder);
    if (p.complete && fresh.status !== 'COMPLETED') {
      await this.prisma.enrollment.updateMany({
        where: { id: fresh.id, generation: fresh.generation, status: 'ACTIVE' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }
  }

  /**
   * Safety net for lost events: attempts still STARTED whose session already ended are re-evaluated
   * (called when a learner opens a course).
   */
  async reconcileEnrollment(enrollmentId: string, generation: number) {
    const open = await this.prisma.courseItemAttempt.findMany({
      where: { enrollmentId, generation, status: 'STARTED', sessionId: { not: null } },
      select: { sessionId: true },
      take: 50,
    });
    if (!open.length) return;
    const sessions = await this.prisma.session.findMany({
      where: { id: { in: open.map((o) => o.sessionId!) } },
      select: { id: true, state: true },
    });
    for (const s of sessions) if (TERMINAL.has(s.state)) await this.refreshAttemptForSession(s.id);
  }
}
