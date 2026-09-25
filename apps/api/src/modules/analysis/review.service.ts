import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Channel, type ProcessingStatus, type SessionState } from '@prisma/client';
import { CHANNELS, PROCESSING_STATUSES, SESSION_STATES, roleAtLeast, type Role } from '@cf/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PaginationQuery, toPage } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { PIPELINE_STEPS, STEP_LABELS, parseVersionConfig } from './pipeline.types';

const csvList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(500)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).max(values.length))
    .optional();

export const SessionListQuery = PaginationQuery.extend({
  scenarioId: z.string().max(64).optional(),
  versionId: z.string().max(64).optional(),
  participant: z.string().trim().max(200).optional(),
  participantId: z.string().max(64).optional(),
  state: csvList(SESSION_STATES),
  analysisStatus: csvList(PROCESSING_STATUSES),
  channel: csvList(CHANNELS),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  courseId: z.string().max(64).optional(),
  teamId: z.string().max(64).optional(),
  simulated: z.enum(['true', 'false']).optional(),
  needsReview: z.enum(['true', 'false']).optional(),
});
export type SessionListQuery = z.infer<typeof SessionListQuery>;

const MEDIA_URL_TTL_SECONDS = 600;

@Injectable()
export class ReviewService {
  private readonly logger = new Logger('Review');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /** Tenant-scoped filter for the review list and the bulk CSV export. */
  async buildWhere(workspaceId: string, q: SessionListQuery): Promise<Prisma.SessionWhereInput> {
    const and: Prisma.SessionWhereInput[] = [{ workspaceId, deletedAt: null }];
    if (q.scenarioId) and.push({ scenarioId: q.scenarioId });
    if (q.versionId) and.push({ scenarioVersionId: q.versionId });
    if (q.participantId) and.push({ participantId: q.participantId });
    if (q.participant) {
      const contains = { contains: q.participant, mode: 'insensitive' as const };
      and.push({ participant: { OR: [{ email: contains }, { name: contains }, { externalId: contains }] } });
    }
    if (q.state?.length) and.push({ state: { in: q.state as SessionState[] } });
    if (q.analysisStatus?.length) and.push({ analysisStatus: { in: q.analysisStatus as ProcessingStatus[] } });
    if (q.channel?.length) and.push({ channel: { in: q.channel as Channel[] } });
    if (q.from) and.push({ createdAt: { gte: q.from } });
    if (q.to) and.push({ createdAt: { lte: q.to } });
    if (q.minScore !== undefined || q.maxScore !== undefined) {
      and.push({
        evaluations: {
          some: {
            isCurrent: true,
            workspaceId,
            overallScore: { ...(q.minScore !== undefined ? { gte: q.minScore } : {}), ...(q.maxScore !== undefined ? { lte: q.maxScore } : {}) },
          },
        },
      });
    }
    if (q.simulated === 'true') and.push({ evaluations: { some: { isCurrent: true, simulated: true } } });
    if (q.simulated === 'false') and.push({ evaluations: { some: { isCurrent: true, simulated: false } } });
    if (q.needsReview === 'true') and.push({ evaluations: { some: { isCurrent: true, humanReviewRequired: true, reviewedAt: null } } });
    if (q.courseId) {
      const enrollments = await this.prisma.enrollment.findMany({ where: { workspaceId, courseId: q.courseId }, select: { id: true } });
      and.push({ enrollmentId: { in: enrollments.map((e) => e.id) } });
    }
    if (q.teamId) {
      const members = await this.prisma.teamMember.findMany({ where: { teamId: q.teamId, team: { workspaceId } }, select: { participantId: true } });
      and.push({ participantId: { in: members.map((m) => m.participantId) } });
    }
    return { AND: and };
  }

  private listInclude = {
    participant: { select: { id: true, name: true, email: true, externalId: true } },
    scenario: { select: { id: true, name: true, type: true } },
    scenarioVersion: { select: { id: true, version: true } },
    evaluations: {
      where: { isCurrent: true },
      select: { id: true, overallScore: true, insufficientEvidence: true, simulated: true, humanReviewRequired: true, reviewedAt: true },
      take: 1,
    },
  } satisfies Prisma.SessionInclude;

  private toRow(s: Prisma.SessionGetPayload<{ include: ReviewService['listInclude'] }>) {
    const ev = s.evaluations[0];
    return {
      id: s.id,
      participant: s.participant,
      scenario: { id: s.scenario.id, name: s.scenario.name, type: s.scenario.type },
      version: { id: s.scenarioVersion.id, number: s.scenarioVersion.version },
      channel: s.channel,
      state: s.state,
      durationMs: s.durationMs,
      overallScore: ev?.overallScore ?? null,
      insufficientEvidence: ev ? ev.insufficientEvidence : null,
      analysisStatus: s.analysisStatus,
      analysisError: s.analysisError,
      simulated: ev?.simulated ?? !!(s.providerInfo as any)?.simulated,
      humanReviewRequired: ev?.humanReviewRequired ?? false,
      reviewed: !!ev?.reviewedAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      createdAt: s.createdAt,
    };
  }

  async list(workspaceId: string, q: SessionListQuery) {
    const where = await this.buildWhere(workspaceId, q);
    const rows = await this.prisma.session.findMany({
      where,
      include: this.listInclude,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: Buffer.from(q.cursor, 'base64url').toString('utf8') }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const page = toPage(rows, q.limit);
    return { data: page.data.map((r) => this.toRow(r)), nextCursor: page.nextCursor };
  }

  /** Scenarios (+versions), courses and teams for the filter bar. */
  async facets(workspaceId: string) {
    const [scenarios, courses, teams] = await Promise.all([
      this.prisma.scenario.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, versions: { select: { id: true, version: true }, orderBy: { version: 'desc' } } },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      this.prisma.course.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, title: true }, orderBy: { title: 'asc' }, take: 500 }),
      this.prisma.team.findMany({ where: { workspaceId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
    ]);
    return {
      scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, versions: s.versions.map((v) => ({ id: v.id, number: v.version })) })),
      courses,
      teams,
    };
  }

  async getSessionOr404(workspaceId: string, sessionId: string) {
    const s = await this.prisma.session.findFirst({ where: { id: sessionId, workspaceId, deletedAt: null } });
    if (!s) throw Errors.notFound('Session');
    return s;
  }

  /** Full reviewer detail. SessionEvents are included only for CREATOR+ (debug data). */
  async detail(workspaceId: string, sessionId: string, role: Role) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, workspaceId, deletedAt: null },
      include: {
        participant: { select: { id: true, name: true, email: true, externalId: true, userId: true } },
        scenario: { select: { id: true, name: true, type: true, status: true, latestVersionNumber: true } },
        scenarioVersion: { select: { id: true, version: true, config: true, publishedAt: true } },
      },
    });
    if (!session) throw Errors.notFound('Session');
    const config = parseVersionConfig(session.scenarioVersion.config);
    const includeEvents = roleAtLeast(role, 'CREATOR');

    const [turns, toolEvents, evaluation, history, extractions, jobs, media, report, events] = await Promise.all([
      this.prisma.transcriptTurn.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } }),
      this.prisma.toolEvent.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.evaluation.findFirst({
        where: { sessionId, workspaceId, isCurrent: true },
        include: { criteria: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.evaluation.findMany({
        where: { sessionId, workspaceId },
        select: { id: true, generation: true, overallScore: true, simulated: true, isCurrent: true, createdAt: true, provider: true, model: true },
        orderBy: { generation: 'desc' },
      }),
      this.prisma.extractionResult.findMany({ where: { sessionId, workspaceId }, orderBy: { key: 'asc' } }),
      this.prisma.processingJob.findMany({ where: { sessionId, workspaceId, generation: session.analysisGeneration } }),
      this.prisma.mediaAsset.findMany({ where: { sessionId, workspaceId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.sessionReport.findUnique({ where: { sessionId } }),
      includeEvents
        ? this.prisma.sessionEvent.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' }, take: 2000 })
        : Promise.resolve(null),
    ]);
    let reviewedBy: { id: string; name: string | null; email: string } | null = null;
    if (evaluation?.reviewedById) {
      reviewedBy = await this.prisma.user.findUnique({ where: { id: evaluation.reviewedById }, select: { id: true, name: true, email: true } });
    }

    const now = new Date();
    const sessionExpired = !!session.retentionUntil && session.retentionUntil < now;
    const mediaOut = await Promise.all(
      media.map(async (m) => {
        const expired = sessionExpired || (!!m.retentionUntil && m.retentionUntil < now);
        const ready = m.status === 'READY' && !expired;
        return {
          id: m.id,
          kind: m.kind,
          mimeType: m.mimeType,
          fileName: m.fileName,
          sizeBytes: Number(m.sizeBytes),
          durationMs: m.durationMs,
          status: expired ? 'EXPIRED' : m.status,
          createdAt: m.createdAt,
          url: ready ? await this.storage.signedUrl(m, MEDIA_URL_TTL_SECONDS).catch(() => null) : null,
          urlExpiresInSeconds: ready ? MEDIA_URL_TTL_SECONDS : null,
        };
      }),
    );
    const recordings = mediaOut.filter((m) => m.kind === 'RECORDING_AUDIO' || m.kind === 'RECORDING_VIDEO');
    const consent = (session.consent ?? {}) as Record<string, unknown>;
    let recordingUnavailableReason: string | null = null;
    if (!recordings.some((r) => r.url)) {
      if (!config.recording.audio && !config.recording.video) recordingUnavailableReason = 'Recording is not enabled for this scenario version.';
      else if (consent.recordAudio === false && consent.recordVideo !== true) recordingUnavailableReason = 'The participant did not consent to recording.';
      else if (recordings.some((r) => r.status === 'EXPIRED') || sessionExpired) recordingUnavailableReason = 'The recording was deleted after the retention period.';
      else if (recordings.some((r) => r.status === 'UPLOADING' || r.status === 'PROCESSING')) recordingUnavailableReason = 'The recording is still uploading or processing.';
      else if (recordings.some((r) => r.status === 'FAILED')) recordingUnavailableReason = 'The recording upload failed.';
      else recordingUnavailableReason = 'No recording was captured for this session (e.g. text-only, unsupported browser or connection lost).';
    }

    const order = new Map(config.rubric.criteria.map((c, i) => [c.id, i]));
    const rubricById = new Map(config.rubric.criteria.map((c) => [c.id, c]));
    return {
      session: {
        id: session.id,
        state: session.state,
        stateReason: session.stateReason,
        endedBy: session.endedBy,
        channel: session.channel,
        coachMode: session.coachMode,
        consent,
        providerInfo: session.providerInfo,
        variables: session.variables,
        metadata: session.metadata,
        errorCode: session.errorCode,
        errorMessage: session.errorMessage,
        analysisStatus: session.analysisStatus,
        analysisError: session.analysisError,
        analysisGeneration: session.analysisGeneration,
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        retentionUntil: session.retentionUntil,
        contentRedactedAt: session.contentRedactedAt,
        enrollmentId: session.enrollmentId,
        shareLinkId: session.shareLinkId,
      },
      scenario: session.scenario,
      version: {
        id: session.scenarioVersion.id,
        number: session.scenarioVersion.version,
        publishedAt: session.scenarioVersion.publishedAt,
        isLatest: session.scenarioVersion.version === session.scenario.latestVersionNumber,
      },
      analysisSettings: config.analysis,
      rubric: {
        enabled: config.rubric.enabled,
        evaluatedSubject: config.rubric.evaluatedSubject,
        passingScore: config.rubric.passingScore ?? null,
        minEvidenceCoverage: config.rubric.minEvidenceCoverage,
        visibility: config.rubric.visibility,
      },
      participant: session.participant,
      turns: turns.map((t) => ({
        id: t.id,
        seq: t.seq,
        speaker: t.speaker,
        text: t.text,
        startedAtMs: t.startedAtMs,
        endedAtMs: t.endedAtMs,
        interrupted: t.interrupted,
        confidence: t.confidence,
        source: t.source,
      })),
      toolEvents: toolEvents.map((t) => ({
        id: t.id,
        toolId: t.toolId,
        toolCallId: t.toolCallId,
        kind: t.kind,
        actor: t.actor,
        args: t.args,
        result: t.result,
        createdAt: t.createdAt,
      })),
      evaluation: evaluation
        ? {
            id: evaluation.id,
            generation: evaluation.generation,
            status: evaluation.status,
            overallScore: evaluation.overallScore,
            coverage: evaluation.scoredWeightPct,
            insufficientEvidence: evaluation.insufficientEvidence,
            passed:
              evaluation.overallScore === null || config.rubric.passingScore === undefined ? null : evaluation.overallScore >= config.rubric.passingScore,
            summary: evaluation.summary,
            strengths: evaluation.strengths,
            weaknesses: evaluation.weaknesses,
            improvements: evaluation.improvements,
            notes: evaluation.notes,
            provider: evaluation.provider,
            model: evaluation.model,
            promptVersion: evaluation.promptVersion,
            rubricHash: evaluation.rubricHash,
            scenarioVersionId: evaluation.scenarioVersionId,
            simulated: evaluation.simulated,
            humanReviewRequired: evaluation.humanReviewRequired,
            reviewedAt: evaluation.reviewedAt,
            reviewedBy,
            reviewNote: evaluation.reviewNote,
            createdAt: evaluation.createdAt,
            completedAt: evaluation.completedAt,
            criteria: evaluation.criteria
              .sort((a, b) => (order.get(a.criterionId) ?? 99) - (order.get(b.criterionId) ?? 99))
              .map((c) => ({
                criterionId: c.criterionId,
                name: c.name,
                description: rubricById.get(c.criterionId)?.description ?? '',
                weight: c.weight,
                score: c.score,
                insufficientEvidence: c.insufficientEvidence,
                confidence: c.confidence,
                rationale: c.rationale,
                evidence: c.evidence,
              })),
          }
        : null,
      evaluationHistory: history,
      extraction: extractions.map((x) => ({
        key: x.key,
        type: x.type,
        description: config.extraction.variables.find((v) => v.key === x.key)?.description ?? '',
        value: x.value,
        valid: x.valid,
        errors: x.errors,
        evidence: x.evidence,
        confidence: x.confidence,
        simulated: x.simulated,
        scenarioVersionId: x.scenarioVersionId,
        updatedAt: x.updatedAt,
      })),
      processing: {
        status: session.analysisStatus,
        error: session.analysisError,
        generation: session.analysisGeneration,
        steps: PIPELINE_STEPS.map((step) => {
          const j = jobs.find((x) => x.kind === step);
          return {
            step,
            label: STEP_LABELS[step],
            status: j?.status ?? 'NOT_STARTED',
            attempts: j?.attempts ?? 0,
            lastError: j?.lastError ?? null,
            result: j?.result ?? null,
            startedAt: j?.startedAt ?? null,
            finishedAt: j?.finishedAt ?? null,
          };
        }),
      },
      media: mediaOut,
      recordingUnavailableReason,
      report: report?.content ?? null,
      events: events?.map((e) => ({ id: e.id, type: e.type, payload: e.payload, createdAt: e.createdAt })) ?? null,
    };
  }

  /** Human review sign-off on the current evaluation. */
  async review(workspaceId: string, sessionId: string, principal: Principal, note: string | undefined) {
    await this.getSessionOr404(workspaceId, sessionId);
    const ev = await this.prisma.evaluation.findFirst({ where: { sessionId, workspaceId, isCurrent: true } });
    if (!ev) throw Errors.conflict('There is no evaluation to review yet');
    const userId = principal.kind === 'user' ? principal.userId : null;
    const updated = await this.prisma.evaluation.update({
      where: { id: ev.id },
      data: { reviewedById: userId, reviewedAt: new Date(), reviewNote: note?.trim() || null },
      select: { id: true, reviewedAt: true, reviewNote: true, reviewedById: true },
    });
    await this.audit.log({ workspaceId, principal, action: 'session.reviewed', targetType: 'session', targetId: sessionId, metadata: { evaluationId: ev.id } });
    return updated;
  }

  /** ADMIN: soft-delete the session and delete its stored media objects. */
  async remove(workspaceId: string, sessionId: string, principal: Principal) {
    await this.getSessionOr404(workspaceId, sessionId);
    const media = await this.prisma.mediaAsset.findMany({ where: { sessionId, workspaceId, deletedAt: null } });
    let deletedObjects = 0;
    for (const m of media) {
      try {
        this.storage.assertWorkspaceKey(workspaceId, m.storageKey);
        await this.storage.delete(m.storageKey);
        const parts = await this.prisma.mediaUploadPart.findMany({ where: { assetId: m.id } });
        for (const p of parts) await this.storage.delete(p.storageKey).catch(() => undefined);
        deletedObjects++;
      } catch (e: any) {
        this.logger.warn(`Could not delete media object ${m.id}: ${e?.message}`);
      }
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.mediaAsset.updateMany({ where: { sessionId, workspaceId, deletedAt: null }, data: { deletedAt: now, status: 'DELETED' } }),
      this.prisma.session.update({ where: { id: sessionId }, data: { deletedAt: now, resumeTokenHash: null } }),
    ]);
    await this.audit.log({
      workspaceId,
      principal,
      action: 'session.deleted',
      targetType: 'session',
      targetId: sessionId,
      metadata: { mediaDeleted: deletedObjects },
    });
    return { deleted: true, mediaDeleted: deletedObjects };
  }
}
