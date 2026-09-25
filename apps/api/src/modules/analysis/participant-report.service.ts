import { Injectable } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { parseVersionConfig } from './pipeline.types';

/**
 * What a participant may see about their OWN session, governed by the exact scenario version's
 * `analysis` settings and rubric visibility:
 *   transcript  ← analysis.participantCanSeeTranscript
 *   feedback    ← analysis.participantCanSeeFeedback (summary / strengths / weaknesses / improvements)
 *   scores      ← analysis.participantCanSeeScores AND rubric.visibility === 'participant_and_reviewers'
 *                 (and, when human review is required, only after a reviewer signed off)
 * Never included: rationale, evidence internals, reviewer notes, extraction, other sessions.
 */
@Injectable()
export class ParticipantReportService {
  constructor(private readonly prisma: PrismaService) {}

  async forSession(session: Session) {
    if (session.deletedAt) throw Errors.notFound('Session');
    const [version, scenario, workspace, branding] = await Promise.all([
      this.prisma.scenarioVersion.findFirst({ where: { id: session.scenarioVersionId, workspaceId: session.workspaceId }, select: { config: true, version: true } }),
      this.prisma.scenario.findFirst({ where: { id: session.scenarioId, workspaceId: session.workspaceId }, select: { name: true, publicDescription: true } }),
      this.prisma.workspace.findUnique({ where: { id: session.workspaceId }, select: { name: true } }),
      this.prisma.workspaceBranding.findUnique({
        where: { workspaceId: session.workspaceId },
        select: { displayName: true, logoUrl: true, primaryColor: true, hidePoweredBy: true },
      }),
    ]);
    if (!version || !scenario) throw Errors.notFound('Session');
    const config = parseVersionConfig(version.config);
    const a = config.analysis;
    const canTranscript = a.participantCanSeeTranscript;
    const canFeedback = a.enabled && a.participantCanSeeFeedback;
    const canScores = a.enabled && a.participantCanSeeScores && config.rubric.enabled && config.rubric.visibility === 'participant_and_reviewers';

    const evaluation =
      canFeedback || canScores
        ? await this.prisma.evaluation.findFirst({
            where: { sessionId: session.id, workspaceId: session.workspaceId, isCurrent: true },
            include: { criteria: { select: { criterionId: true, name: true, weight: true, score: true, insufficientEvidence: true } } },
          })
        : null;
    const turns = canTranscript
      ? await this.prisma.transcriptTurn.findMany({
          where: { sessionId: session.id, speaker: { in: ['AGENT', 'PARTICIPANT'] } },
          orderBy: { seq: 'asc' },
          select: { seq: true, speaker: true, text: true, startedAtMs: true },
        })
      : null;

    const status = session.analysisStatus;
    const pending = status === 'QUEUED' || status === 'PROCESSING' || (status === 'NOT_STARTED' && ['COMPLETED', 'ABANDONED', 'FAILED'].includes(session.state));
    const awaitingReview = !!evaluation?.humanReviewRequired && !evaluation.reviewedAt;
    const order = new Map(config.rubric.criteria.map((c, i) => [c.id, i]));

    return {
      session: {
        id: session.id,
        state: session.state,
        createdAt: session.createdAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
      },
      scenario: { name: scenario.name, description: scenario.publicDescription ?? config.basics.publicDescription },
      workspace: { name: branding?.displayName || workspace?.name || '' },
      branding: branding ? { logoUrl: branding.logoUrl, primaryColor: branding.primaryColor, hidePoweredBy: branding.hidePoweredBy } : null,
      processing: {
        status,
        pending,
        message: pending
          ? 'Your feedback is being prepared…'
          : status === 'SKIPPED'
            ? 'No feedback was generated for this session.'
            : status === 'FAILED'
              ? 'We could not prepare feedback for this session.'
              : null,
      },
      visibility: { transcript: canTranscript, feedback: canFeedback, scores: canScores },
      simulated: !!evaluation?.simulated,
      transcript: turns,
      feedback:
        canFeedback && evaluation
          ? {
              summary: evaluation.summary,
              strengths: evaluation.strengths,
              weaknesses: evaluation.weaknesses,
              improvements: evaluation.improvements,
              simulated: evaluation.simulated,
            }
          : null,
      scores:
        canScores && evaluation
          ? awaitingReview
            ? { awaitingReview: true as const }
            : {
                awaitingReview: false as const,
                overallScore: evaluation.overallScore,
                insufficientEvidence: evaluation.insufficientEvidence,
                criteria: [...evaluation.criteria]
                  .sort((x, y) => (order.get(x.criterionId) ?? 99) - (order.get(y.criterionId) ?? 99))
                  .map((c) => ({ name: c.name, weight: c.weight, score: c.score, insufficientEvidence: c.insufficientEvidence })),
              }
          : null,
    };
  }

  /** The logged-in user's own session (participant linked to their user id). */
  async forUser(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, deletedAt: null, participant: { userId, deletedAt: null }, workspace: { deletedAt: null } },
    });
    if (!session) throw Errors.notFound('Session');
    return this.forSession(session);
  }

  /** "My sessions" across every workspace where the user was the participant. */
  async listForUser(userId: string, q: { limit: number; cursor?: string; workspaceId?: string }) {
    const cursorId = q.cursor ? Buffer.from(q.cursor, 'base64url').toString('utf8') : undefined;
    const rows = await this.prisma.session.findMany({
      where: {
        deletedAt: null,
        participant: { userId, deletedAt: null },
        workspace: { deletedAt: null },
        ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
      },
      include: {
        scenario: { select: { id: true, name: true, type: true } },
        scenarioVersion: { select: { version: true, config: true } },
        workspace: { select: { id: true, name: true } },
        evaluations: { where: { isCurrent: true }, select: { overallScore: true, insufficientEvidence: true, humanReviewRequired: true, reviewedAt: true, simulated: true }, take: 1 },
      },
      take: q.limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const hasMore = rows.length > q.limit;
    const data = (hasMore ? rows.slice(0, q.limit) : rows).map((s) => {
      const cfg = parseVersionConfig(s.scenarioVersion.config);
      const ev = s.evaluations[0];
      const scoresVisible =
        cfg.analysis.enabled &&
        cfg.analysis.participantCanSeeScores &&
        cfg.rubric.enabled &&
        cfg.rubric.visibility === 'participant_and_reviewers' &&
        !!ev &&
        !(ev.humanReviewRequired && !ev.reviewedAt);
      return {
        id: s.id,
        workspace: s.workspace,
        scenario: s.scenario,
        versionNumber: s.scenarioVersion.version,
        channel: s.channel,
        state: s.state,
        durationMs: s.durationMs,
        createdAt: s.createdAt,
        endedAt: s.endedAt,
        analysisStatus: s.analysisStatus,
        courseItemAttemptId: s.courseItemAttemptId,
        enrollmentId: s.enrollmentId,
        overallScore: scoresVisible ? ev!.overallScore : null,
        insufficientEvidence: scoresVisible ? ev!.insufficientEvidence : null,
        scoresVisible,
        feedbackAvailable: cfg.analysis.enabled && cfg.analysis.participantCanSeeFeedback && !!ev,
        simulated: ev?.simulated ?? false,
        reportUrl: `/report/${s.id}`,
      };
    });
    return { data, nextCursor: hasMore ? Buffer.from(data[data.length - 1]!.id, 'utf8').toString('base64url') : null };
  }
}
