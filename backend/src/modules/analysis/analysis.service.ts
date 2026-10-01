import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, type ProcessingStatus } from '@prisma/client';
import { ANALYZABLE_TERMINAL_STATES, TERMINAL_STATES, type SessionState } from '@cf/shared';
import type { Job } from 'bullmq';
import { DomainEvents } from '../../common/events/domain-events';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService, workerRuntime } from '../../common/queue/queue.service';
import {
  NonRetryableError,
  PIPELINE_STEPS,
  TERMINAL_JOB_STATUSES,
  parseVersionConfig,
  pipelineJobKey,
  type PipelineStep,
  type StepJobData,
} from './pipeline.types';
import { PipelineStepsService } from './steps.service';

const MAX_ATTEMPTS = 4;
const SWEEP_JOB = 'sweep';
const STALE_MS = 2 * 60_000;

/**
 * Post-session analysis pipeline (workstream D).
 *
 *   session.terminal → startPipeline → finalize_transcript → score → extract → report → notify → complete
 *
 * Each step is a BullMQ job with a deterministic id `pipeline_<sessionId>_<step>_g<generation>` and a
 * ProcessingJob row with the same idempotency key. Steps are idempotent (upserts / unique constraints),
 * retried with exponential backoff, and a step that fails for good is marked FAILED while the pipeline
 * continues, so earlier results are never lost. `reprocess` starts a new generation; results of older
 * generations are kept (evaluations become isCurrent=false).
 */
@Injectable()
export class AnalysisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Analysis');
  private sweepTimer: NodeJS.Timeout | null = null;
  /**
   * How a step is scheduled. Default: BullMQ. Tests replace it with an inline runner.
   */
  dispatcher: (data: StepJobData, opts: { replace: boolean }) => Promise<void> = (data, opts) => this.enqueueStep(data, opts);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly events: DomainEvents,
    private readonly steps: PipelineStepsService,
  ) {}

  onModuleInit() {
    this.events.on('session.terminal', (p) => this.startPipeline(p.sessionId, 'terminal').then(() => undefined));
    this.queue.process(QUEUES.pipeline, (job: Job) => this.handleJob(job), 4);
    if (workerRuntime.enabled) {
      // Maintenance: re-enqueue sessions stuck in QUEUED/PROCESSING (crash, lost event). Idempotent.
      void this.queue
        .queue(QUEUES.pipeline)
        .upsertJobScheduler('pipeline-sweep', { every: 10 * 60_000 }, { name: SWEEP_JOB, data: {} })
        .catch((e) => this.logger.warn(`Could not schedule pipeline sweep: ${e?.message}`));
      this.sweepTimer = setTimeout(() => void this.sweep({ startup: true }).catch((e) => this.logger.error(`Startup sweep failed: ${e?.message}`)), 5_000);
    }
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
  }

  // ───────────────────────── starting ─────────────────────────

  /** Why a session will not be analyzed (null = analyze). */
  private async skipReason(session: {
    id: string;
    state: string;
    consent: Prisma.JsonValue;
    scenarioVersionId: string;
    workspaceId: string;
  }): Promise<string | null> {
    if (!ANALYZABLE_TERMINAL_STATES.includes(session.state as SessionState)) {
      return `Session ended as ${session.state.toLowerCase()} — nothing to analyze`;
    }
    if ((session.consent as any)?.analysis === false) return 'The participant did not consent to analysis';
    const version = await this.prisma.scenarioVersion.findFirst({
      where: { id: session.scenarioVersionId, workspaceId: session.workspaceId },
      select: { config: true },
    });
    const config = parseVersionConfig(version?.config);
    if (!config.analysis.enabled) return 'Analysis is disabled for this scenario version';
    const participantTurns = await this.prisma.transcriptTurn.count({
      where: { sessionId: session.id, speaker: 'PARTICIPANT', NOT: { text: '' } },
    });
    if (participantTurns === 0) return 'No participant speech was captured in this session';
    return null;
  }

  /**
   * Start (terminal) or restart (reprocess) the pipeline. Safe to call repeatedly: a terminal start only
   * takes effect once (generation 0 → 1, guarded by a conditional update).
   */
  async startPipeline(sessionId: string, reason: 'terminal' | 'reprocess'): Promise<{ generation: number | null; skipped?: string }> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, workspaceId: true, state: true, consent: true, scenarioVersionId: true, analysisGeneration: true, deletedAt: true },
    });
    if (!session || session.deletedAt) return { generation: null, skipped: 'Session not found' };
    if (!TERMINAL_STATES.includes(session.state as SessionState)) {
      if (reason === 'reprocess') throw Errors.conflict('The session has not ended yet');
      return { generation: null, skipped: 'Session is not in a terminal state' };
    }
    if (reason === 'terminal' && session.analysisGeneration > 0) return { generation: session.analysisGeneration };

    const skip = await this.skipReason(session);
    if (skip) {
      if (reason === 'reprocess') throw Errors.conflict(`This session cannot be analyzed: ${skip}`);
      await this.prisma.session.updateMany({
        where: { id: session.id, analysisGeneration: 0 },
        data: { analysisStatus: 'SKIPPED', analysisError: skip },
      });
      return { generation: null, skipped: skip };
    }

    let generation: number;
    if (reason === 'terminal') {
      const r = await this.prisma.session.updateMany({
        where: { id: session.id, analysisGeneration: 0 },
        data: { analysisGeneration: 1, analysisStatus: 'QUEUED', analysisError: null },
      });
      if (r.count === 0) return { generation: null }; // someone else started it
      generation = 1;
    } else {
      const updated = await this.prisma.session.update({
        where: { id: session.id },
        data: { analysisGeneration: { increment: 1 }, analysisStatus: 'QUEUED', analysisError: null },
        select: { analysisGeneration: true },
      });
      generation = updated.analysisGeneration;
    }

    await this.prisma.processingJob.createMany({
      data: PIPELINE_STEPS.map((step) => ({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        kind: step,
        generation,
        idempotencyKey: pipelineJobKey(session.id, step, generation),
        status: 'QUEUED' as const,
      })),
      skipDuplicates: true,
    });
    await this.dispatcher({ sessionId: session.id, workspaceId: session.workspaceId, step: PIPELINE_STEPS[0], generation }, { replace: false });
    this.logger.log(`Pipeline ${reason === 'terminal' ? 'started' : 'restarted'} for session ${session.id} (generation ${generation})`);
    return { generation };
  }

  /** Public contract: re-run the whole pipeline as a new generation (keeps history). */
  async reprocess(sessionId: string, workspaceId?: string) {
    if (workspaceId) {
      const s = await this.prisma.session.findFirst({ where: { id: sessionId, workspaceId, deletedAt: null }, select: { id: true } });
      if (!s) throw Errors.notFound('Session');
    }
    const r = await this.startPipeline(sessionId, 'reprocess');
    return { generation: r.generation, status: 'QUEUED' as ProcessingStatus };
  }

  /** Retry one failed/skipped step of the current generation, then everything after it. */
  async retryStep(workspaceId: string, sessionId: string, step: PipelineStep) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, workspaceId, deletedAt: null },
      select: { id: true, analysisGeneration: true },
    });
    if (!session) throw Errors.notFound('Session');
    if (session.analysisGeneration === 0) throw Errors.conflict('This session has not been processed yet');
    const gen = session.analysisGeneration;
    const job = await this.prisma.processingJob.findUnique({ where: { idempotencyKey: pipelineJobKey(sessionId, step, gen) } });
    if (!job || job.workspaceId !== workspaceId) throw Errors.notFound('Processing step');
    if (job.status !== 'FAILED') throw Errors.conflict('Only a failed step can be retried');
    const idx = PIPELINE_STEPS.indexOf(step);
    await this.prisma.$transaction([
      this.prisma.processingJob.updateMany({
        where: { sessionId, generation: gen, workspaceId, kind: { in: PIPELINE_STEPS.slice(idx) as unknown as string[] } },
        data: { status: 'QUEUED', lastError: null, attempts: 0, startedAt: null, finishedAt: null },
      }),
      this.prisma.session.update({ where: { id: sessionId }, data: { analysisStatus: 'PROCESSING', analysisError: null } }),
    ]);
    await this.dispatcher({ sessionId, workspaceId, step, generation: gen }, { replace: true });
    return { generation: gen, step, status: 'QUEUED' as ProcessingStatus };
  }

  // ───────────────────────── queue plumbing ─────────────────────────

  /** Enqueue with the deterministic id. With `replace`, a finished job with that id is removed first. */
  private async enqueueStep(data: StepJobData, opts: { replace: boolean }) {
    const jobId = pipelineJobKey(data.sessionId, data.step, data.generation);
    const q = this.queue.queue(QUEUES.pipeline);
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        if (!opts.replace) {
          // Finished job but the DB says it still needs to run (crash / lost update) → replace it.
          const pj = await this.prisma.processingJob.findUnique({ where: { idempotencyKey: jobId }, select: { status: true } });
          if (pj && (TERMINAL_JOB_STATUSES as readonly string[]).includes(pj.status)) return;
        }
        await existing.remove().catch(() => undefined);
      } else {
        return; // waiting / delayed / active: already scheduled
      }
    }
    await this.queue.enqueue(QUEUES.pipeline, data.step, data, {
      jobId,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  }

  private async handleJob(job: Job) {
    if (job.name === SWEEP_JOB) return this.sweep({ startup: false });
    const data = job.data as StepJobData;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    return this.runStep(data, { attempt, isFinalAttempt: attempt >= maxAttempts });
  }

  /**
   * Execute one step. Throws (to trigger a BullMQ retry) only for retryable errors on non-final
   * attempts; otherwise records the outcome and advances the pipeline.
   */
  async runStep(data: StepJobData, opts: { attempt: number; isFinalAttempt: boolean }): Promise<void> {
    const key = pipelineJobKey(data.sessionId, data.step, data.generation);
    const session = await this.prisma.session.findFirst({
      where: { id: data.sessionId, workspaceId: data.workspaceId },
      select: { analysisGeneration: true, deletedAt: true, analysisStatus: true },
    });
    if (!session || session.deletedAt || session.analysisGeneration !== data.generation) {
      await this.prisma.processingJob.updateMany({
        where: { idempotencyKey: key, status: { in: ['QUEUED', 'PROCESSING'] } },
        data: { status: 'SKIPPED', lastError: session?.deletedAt || !session ? 'Session deleted' : 'Superseded by a newer processing run', finishedAt: new Date() },
      });
      return;
    }
    const pj = await this.prisma.processingJob.findUnique({ where: { idempotencyKey: key } });
    if (pj && (TERMINAL_JOB_STATUSES as readonly string[]).includes(pj.status)) {
      // Duplicate delivery of a finished step: just make sure the pipeline moves on.
      return this.advance(data);
    }
    await this.prisma.processingJob.upsert({
      where: { idempotencyKey: key },
      create: {
        workspaceId: data.workspaceId,
        sessionId: data.sessionId,
        kind: data.step,
        generation: data.generation,
        idempotencyKey: key,
        status: 'PROCESSING',
        attempts: opts.attempt,
        startedAt: new Date(),
      },
      update: { status: 'PROCESSING', attempts: opts.attempt, startedAt: pj?.startedAt ?? new Date() },
    });
    if (session.analysisStatus === 'QUEUED') {
      await this.prisma.session.updateMany({
        where: { id: data.sessionId, analysisGeneration: data.generation, analysisStatus: 'QUEUED' },
        data: { analysisStatus: 'PROCESSING' },
      });
    }

    try {
      const outcome = await this.steps.run(data.step, { sessionId: data.sessionId, workspaceId: data.workspaceId, generation: data.generation });
      await this.prisma.processingJob.update({
        where: { idempotencyKey: key },
        data: {
          status: outcome.status,
          result: JSON.parse(JSON.stringify(outcome.result)) as Prisma.InputJsonValue,
          lastError: null,
          finishedAt: new Date(),
        },
      });
    } catch (e: any) {
      const message = describeError(e);
      // Client errors from a provider (bad key, bad request, model not found) will not fix themselves.
      const httpStatus = typeof e?.status === 'number' ? e.status : null;
      const retryable = !(e instanceof NonRetryableError) && !(httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 409 && httpStatus !== 429);
      if (retryable && !opts.isFinalAttempt) {
        await this.prisma.processingJob.update({ where: { idempotencyKey: key }, data: { status: 'QUEUED', lastError: `Attempt ${opts.attempt} failed: ${message}` } });
        this.logger.warn(`Step ${data.step} for session ${data.sessionId} failed (attempt ${opts.attempt}), will retry: ${message}`);
        throw e;
      }
      this.logger.error(`Step ${data.step} for session ${data.sessionId} failed permanently: ${message}`);
      await this.prisma.processingJob.update({ where: { idempotencyKey: key }, data: { status: 'FAILED', lastError: message, finishedAt: new Date() } });
    }
    await this.advance(data);
  }

  /** Schedule the next unfinished step of this generation, or complete the pipeline. */
  private async advance(data: StepJobData) {
    const jobs = await this.prisma.processingJob.findMany({
      where: { sessionId: data.sessionId, workspaceId: data.workspaceId, generation: data.generation },
      select: { kind: true, status: true },
    });
    const idx = PIPELINE_STEPS.indexOf(data.step);
    const next = PIPELINE_STEPS.slice(idx + 1).find((s) => {
      const j = jobs.find((x) => x.kind === s);
      return !j || !(TERMINAL_JOB_STATUSES as readonly string[]).includes(j.status);
    });
    if (next) {
      await this.dispatcher({ ...data, step: next }, { replace: false });
      return;
    }
    await this.completePipeline(data.sessionId, data.workspaceId, data.generation);
  }

  /** Compute the final status, patch the report's processing section and emit domain events (once per run). */
  async completePipeline(sessionId: string, workspaceId: string, generation: number) {
    const jobs = await this.prisma.processingJob.findMany({ where: { sessionId, workspaceId, generation } });
    const status = (s: PipelineStep) => jobs.find((j) => j.kind === s)?.status ?? 'NOT_STARTED';
    const failed = jobs.filter((j) => j.status === 'FAILED');
    const coreProduced = status('score') === 'COMPLETED' || status('extract') === 'COMPLETED';
    const coreFailed = status('score') === 'FAILED' || status('extract') === 'FAILED';
    const final: ProcessingStatus = failed.length === 0 ? 'COMPLETED' : coreFailed && !coreProduced ? 'FAILED' : 'PARTIAL';
    const error = failed.length ? failed.map((f) => `${f.kind}: ${f.lastError ?? 'failed'}`).join('; ').slice(0, 2000) : null;

    const r = await this.prisma.session.updateMany({
      where: { id: sessionId, workspaceId, analysisGeneration: generation, analysisStatus: { in: ['QUEUED', 'PROCESSING'] } },
      data: { analysisStatus: final, analysisError: error },
    });
    if (r.count === 0) return;

    const report = await this.prisma.sessionReport.findUnique({ where: { sessionId } });
    if (report) {
      const content = (report.content ?? {}) as Record<string, any>;
      content.processing = {
        status: final,
        error,
        steps: PIPELINE_STEPS.map((s) => {
          const j = jobs.find((x) => x.kind === s);
          return { step: s, status: j?.status ?? 'NOT_STARTED', error: j?.lastError ?? null };
        }),
      };
      await this.prisma.sessionReport.update({ where: { sessionId }, data: { content: content as Prisma.InputJsonValue } });
    }

    if (final === 'FAILED') {
      this.events.emit('session.failed', { sessionId, workspaceId, errorCode: 'analysis_failed' });
    } else {
      const ev = await this.prisma.evaluation.findFirst({
        where: { sessionId, workspaceId, isCurrent: true },
        select: { id: true, overallScore: true },
      });
      this.events.emit('session.analyzed', { sessionId, workspaceId, evaluationId: ev?.id ?? null, overallScore: ev?.overallScore ?? null });
      if (status('extract') === 'COMPLETED') this.events.emit('session.extracted', { sessionId, workspaceId });
    }
    this.logger.log(`Pipeline for session ${sessionId} finished: ${final}`);
  }

  // ───────────────────────── maintenance ─────────────────────────

  /**
   * Re-enqueue sessions stuck in QUEUED/PROCESSING and start sessions whose terminal event was missed.
   * Idempotent: deterministic job ids mean a still-scheduled step is left alone.
   */
  async sweep(opts: { startup: boolean }) {
    const staleBefore = new Date(Date.now() - (opts.startup ? 0 : STALE_MS));
    const stuck = await this.prisma.session.findMany({
      where: { analysisStatus: { in: ['QUEUED', 'PROCESSING'] }, deletedAt: null, updatedAt: { lte: staleBefore }, analysisGeneration: { gt: 0 } },
      select: { id: true, workspaceId: true, analysisGeneration: true },
      take: 200,
      orderBy: { updatedAt: 'asc' },
    });
    for (const s of stuck) {
      const jobs = await this.prisma.processingJob.findMany({
        where: { sessionId: s.id, workspaceId: s.workspaceId, generation: s.analysisGeneration },
        select: { kind: true, status: true },
      });
      const next = PIPELINE_STEPS.find((step) => {
        const j = jobs.find((x) => x.kind === step);
        return !j || !(TERMINAL_JOB_STATUSES as readonly string[]).includes(j.status);
      });
      if (!next) await this.completePipeline(s.id, s.workspaceId, s.analysisGeneration);
      else await this.dispatcher({ sessionId: s.id, workspaceId: s.workspaceId, step: next, generation: s.analysisGeneration }, { replace: false });
    }
    // Missed session.terminal events (e.g. process restarted between the state change and the event).
    const missed = await this.prisma.session.findMany({
      where: {
        analysisGeneration: 0,
        analysisStatus: 'NOT_STARTED',
        deletedAt: null,
        state: { in: [...ANALYZABLE_TERMINAL_STATES] as any },
        updatedAt: { lte: new Date(Date.now() - STALE_MS) },
      },
      select: { id: true },
      take: 200,
    });
    for (const m of missed) await this.startPipeline(m.id, 'terminal').catch((e) => this.logger.warn(`Sweep start ${m.id}: ${e?.message}`));
    if (stuck.length || missed.length) this.logger.log(`Pipeline sweep: ${stuck.length} resumed, ${missed.length} started`);
    return { resumed: stuck.length, started: missed.length };
  }
}

/** Human-readable error for the Processing tab (provider SDK errors carry JSON bodies). */
function describeError(e: any): string {
  const status = typeof e?.status === 'number' ? e.status : null;
  const inner = e?.error?.error?.message ?? e?.error?.message;
  if (status && typeof inner === 'string') return `AI provider error ${status}: ${inner}`.slice(0, 1000);
  return String(e?.message ?? e).slice(0, 1000);
}
