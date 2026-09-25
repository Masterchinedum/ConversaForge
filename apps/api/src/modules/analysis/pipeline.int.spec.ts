/**
 * Integration tests for the post-session pipeline against a real Postgres database
 * (default: conversaforge_test_d; override with ANALYSIS_TEST_DATABASE_URL). Queueing is replaced by an
 * inline dispatcher that mimics BullMQ retries, so no Redis is needed.
 */
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = process.env.ANALYSIS_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/conversaforge_test_d';

import { defaultScenarioConfig, stableStringify, type ScenarioConfigInput } from '@cf/shared';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { DomainEvents, type DomainEventMap } from '../../common/events/domain-events';
import { AppError } from '../../common/http/errors';
import { LlmService } from '../../common/llm/llm.service';
import type { JsonRequest, LlmProvider, ResolvedLlm } from '../../common/llm/llm.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { UsageService } from '../usage/usage.service';
import { AnalysisService } from './analysis.service';
import { ExportService } from './export.service';
import { ParticipantReportService } from './participant-report.service';
import type { StepJobData } from './pipeline.types';
import { ReviewService } from './review.service';
import { SIMULATED_SUMMARY_PREFIX } from './simulator';
import { PipelineStepsService } from './steps.service';

jest.setTimeout(60_000);

const prisma = new PrismaService();
const crypto = new CryptoService();
const events = new DomainEvents();
const llm = new LlmService(prisma, crypto);
const realResolve = llm.resolve.bind(llm);
const usage = new UsageService(prisma, events);
const mail = { send: jest.fn(async () => ({ delivered: false, logged: true })), configured: false } as any;
const storage = new StorageService(crypto);
const audit = new AuditService(prisma);
const steps = new PipelineStepsService(prisma, llm, usage, mail, crypto);
const queueStub = { process: jest.fn(), queue: jest.fn(), enqueue: jest.fn() } as any;
const analysis = new AnalysisService(prisma, queueStub, events, steps);
const review = new ReviewService(prisma, storage, audit);
const reports = new ParticipantReportService(prisma);
const exportsSvc = new ExportService(review, prisma);

// Inline dispatcher: FIFO, BullMQ-like retries (4 attempts).
const pending: StepJobData[] = [];
analysis.dispatcher = async (data) => {
  pending.push(data);
};
async function drain() {
  let guard = 0;
  while (pending.length) {
    if (++guard > 200) throw new Error('pipeline did not settle');
    const d = pending.shift()!;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await analysis.runStep(d, { attempt, isFinalAttempt: attempt === 4 });
        break;
      } catch {
        /* retried */
      }
    }
  }
}
async function waitFor(cond: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const emitted: Array<{ type: keyof DomainEventMap; payload: any }> = [];
for (const type of ['session.analyzed', 'session.extracted', 'session.failed'] as const) {
  events.on(type, (payload) => void emitted.push({ type, payload }));
}

function useProvider(provider: LlmProvider | null) {
  (llm as any).resolve = provider
    ? async (): Promise<ResolvedLlm> => ({ provider, model: 'test-model', simulated: false, source: 'environment' })
    : realResolve;
}
function fakeProvider(handler: (req: JsonRequest) => unknown): LlmProvider {
  return {
    id: 'anthropic',
    simulated: false,
    streamChat: (() => {
      throw new Error('not used');
    }) as any,
    completeJson: async (model: string, req: JsonRequest) => ({
      json: handler(req),
      usage: { provider: 'anthropic' as const, model, inputTokens: 1000, outputTokens: 200 },
    }),
  };
}
const isScoring = (req: JsonRequest) => 'criteria' in ((req.jsonSchema as any).properties ?? {});

const baseConfig = (over: ScenarioConfigInput = {}) =>
  defaultScenarioConfig({
    basics: { name: 'Interview practice', type: 'coaching', publicDescription: 'Practice', participantInstructions: 'Talk' },
    persona: { role: 'Hiring manager' },
    instructions: { goals: ['Assess leadership'] },
    rubric: {
      evaluatedSubject: 'the participant (candidate)',
      minEvidenceCoverage: 0.5,
      criteria: [
        { id: 'leadership', name: 'Leadership', description: 'Leads a team through a project and splits work', weight: 60, strongPerformance: 'Describes leading people with specifics' },
        { id: 'results', name: 'Results', description: 'Quantifies outcomes such as invoice errors or deadlines', weight: 40, strongPerformance: 'Numbers and outcomes' },
      ],
    },
    extraction: {
      variables: [
        { key: 'years_experience', type: 'number', description: 'Years of experience' },
        { key: 'team_size', type: 'number', description: 'Size of the team they led' },
      ],
    },
    ...over,
  });

const TURNS = [
  { speaker: 'AGENT', text: 'Tell me about a project you led. How many years of experience do you have?' },
  { speaker: 'PARTICIPANT', text: 'I have 8 years of experience. Last year I led the billing migration and split the team of 6 engineers into two squads.' },
  { speaker: 'AGENT', text: 'What was the result?' },
  { speaker: 'PARTICIPANT', text: 'We cut invoice errors by 40% and shipped two weeks before the deadline.' },
] as const;

let ws: { id: string };
let ws2: { id: string };
let user: { id: string };
let otherUser: { id: string };
let scenario: { id: string };
let v1: { id: string };

async function makeVersion(scenarioId: string, workspaceId: string, version: number, config: ReturnType<typeof defaultScenarioConfig>) {
  const v = await prisma.scenarioVersion.create({
    data: { scenarioId, workspaceId, version, config: config as unknown as Prisma.InputJsonValue, configHash: crypto.sha256(stableStringify(config)) },
  });
  await prisma.scenario.update({ where: { id: scenarioId }, data: { latestVersionId: v.id, latestVersionNumber: version, status: 'PUBLISHED' } });
  return v;
}

async function makeSession(opts: {
  versionId?: string;
  scenarioId?: string;
  workspaceId?: string;
  consent?: Record<string, unknown>;
  turns?: ReadonlyArray<{ speaker: string; text: string }>;
  userId?: string | null;
  state?: 'COMPLETED' | 'ABANDONED' | 'CANCELLED' | 'ACTIVE';
}) {
  const workspaceId = opts.workspaceId ?? ws.id;
  const participant = await prisma.participant.create({
    data: { workspaceId, name: 'Pat Doe', email: `pat-${rand()}@example.com`, userId: opts.userId ?? null },
  });
  const token = `cfs_${rand()}`;
  const session = await prisma.session.create({
    data: {
      workspaceId,
      scenarioId: opts.scenarioId ?? scenario.id,
      scenarioVersionId: opts.versionId ?? v1.id,
      participantId: participant.id,
      state: opts.state ?? 'COMPLETED',
      consent: (opts.consent ?? { analysis: true, recordAudio: false }) as Prisma.InputJsonValue,
      startedAt: new Date(Date.now() - 120_000),
      endedAt: new Date(),
      durationMs: 120_000,
      resumeTokenHash: crypto.sha256(token),
      resumeExpiresAt: new Date(Date.now() + 3600_000),
    },
  });
  let ms = 0;
  for (const [i, t] of (opts.turns ?? TURNS).entries()) {
    await prisma.transcriptTurn.create({
      data: { sessionId: session.id, seq: i + 1, speaker: t.speaker as any, text: t.text, startedAtMs: ms, endedAtMs: i === 1 ? ms - 5 : ms + 4000 },
    });
    ms += 5000;
  }
  return { session, token };
}

function rand() {
  return randomBytes(6).toString('hex');
}

beforeAll(async () => {
  await prisma.$connect();
  user = await prisma.user.create({ data: { email: `rev-${rand()}@example.com`, name: 'Reviewer' } });
  otherUser = await prisma.user.create({ data: { email: `other-${rand()}@example.com`, name: 'Other' } });
  ws = await prisma.workspace.create({ data: { name: 'D test', slug: `d-test-${rand()}` } });
  ws2 = await prisma.workspace.create({ data: { name: 'D other', slug: `d-other-${rand()}` } });
  await prisma.membership.create({ data: { workspaceId: ws.id, userId: user.id, role: 'REVIEWER' } });
  scenario = await prisma.scenario.create({ data: { workspaceId: ws.id, slug: `s-${rand()}`, name: 'Interview practice', type: 'coaching' } });
  v1 = await makeVersion(scenario.id, ws.id, 1, baseConfig({ analysis: { notifyOnComplete: true } }));
  await analysis.onModuleInit(); // registers the session.terminal listener (no worker in tests)
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  useProvider(null);
  emitted.length = 0;
  pending.length = 0;
});

describe('post-session pipeline', () => {
  let sessionId: string;

  it('runs the whole pipeline with the simulator after session.terminal', async () => {
    const { session } = await makeSession({});
    sessionId = session.id;
    events.emit('session.terminal', { sessionId, workspaceId: ws.id, state: 'COMPLETED' });
    await waitFor(() => pending.length > 0);
    await drain();

    const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.analysisStatus).toBe('COMPLETED');
    expect(s.analysisGeneration).toBe(1);
    const jobs = await prisma.processingJob.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    expect(jobs.map((j) => j.idempotencyKey).sort()).toEqual(
      ['extract', 'finalize_transcript', 'notify', 'report', 'score'].map((k) => `pipeline_${sessionId}_${k}_g1`).sort(),
    );
    expect(jobs.every((j) => j.status === 'COMPLETED')).toBe(true);

    const ev = await prisma.evaluation.findFirstOrThrow({ where: { sessionId }, include: { criteria: true } });
    expect(ev.simulated).toBe(true);
    expect(ev.summary!.startsWith(SIMULATED_SUMMARY_PREFIX)).toBe(true);
    expect(ev.scenarioVersionId).toBe(v1.id);
    expect(ev.isCurrent).toBe(true);
    expect(ev.criteria).toHaveLength(2);
    expect(ev.overallScore).not.toBeNull();
    // every stored quote is a real excerpt of a participant turn
    const turns = await prisma.transcriptTurn.findMany({ where: { sessionId } });
    for (const c of ev.criteria) {
      for (const e of c.evidence as Array<{ turnSeq: number; quote: string }>) {
        const t = turns.find((x) => x.seq === e.turnSeq)!;
        expect(t.speaker).toBe('PARTICIPANT');
        expect(t.text).toContain(e.quote);
      }
    }
    // timing sanity fix (turn 2 had end < start)
    expect(turns.find((t) => t.seq === 2)!.endedAtMs).toBe(turns.find((t) => t.seq === 2)!.startedAtMs);

    const extraction = await prisma.extractionResult.findMany({ where: { sessionId }, orderBy: { key: 'asc' } });
    expect(extraction.map((x) => [x.key, x.value, x.simulated, x.scenarioVersionId])).toEqual([
      ['team_size', 6, true, v1.id],
      ['years_experience', 8, true, v1.id],
    ]);
    const report = await prisma.sessionReport.findUniqueOrThrow({ where: { sessionId } });
    expect((report.content as any).scenarioVersion).toEqual({ id: v1.id, number: 1 });
    expect((report.content as any).processing.status).toBe('COMPLETED');
    expect((report.content as any).transcript.talkTimeRatio).toBeTruthy();

    // notifications to reviewers (REVIEWER member)
    const notes = await prisma.notification.findMany({ where: { workspaceId: ws.id, link: `/w/${ws.id}/sessions/${sessionId}` } });
    expect(notes.map((n) => n.userId)).toEqual([user.id]);
    expect(emitted.map((e) => e.type)).toEqual(['session.analyzed', 'session.extracted']);
    expect(emitted[0]!.payload.evaluationId).toBe(ev.id);
    expect(emitted[0]!.payload.overallScore).toBe(ev.overallScore);
  });

  it('is idempotent: duplicate events and re-running steps never duplicate rows', async () => {
    const r = await analysis.startPipeline(sessionId, 'terminal');
    expect(r.generation).toBe(1);
    expect(pending).toHaveLength(0);
    const ctx = { sessionId, workspaceId: ws.id, generation: 1 };
    await steps.run('score', ctx);
    await steps.run('score', ctx);
    await steps.run('extract', ctx);
    await steps.run('notify', ctx);
    // a duplicate delivery of a finished job only advances; nothing re-runs
    await analysis.runStep({ ...ctx, step: 'score' }, { attempt: 1, isFinalAttempt: false });
    await drain();
    expect(await prisma.evaluation.count({ where: { sessionId } })).toBe(1);
    const ev = await prisma.evaluation.findFirstOrThrow({ where: { sessionId } });
    expect(await prisma.criterionScore.count({ where: { evaluationId: ev.id } })).toBe(2);
    expect(await prisma.extractionResult.count({ where: { sessionId } })).toBe(2);
    expect(await prisma.processingJob.count({ where: { sessionId } })).toBe(5);
    expect(await prisma.notification.count({ where: { link: `/w/${ws.id}/sessions/${sessionId}` } })).toBe(1);
  });

  it('reprocess creates a new current evaluation, keeps history, and uses the exact version after republish', async () => {
    // Republish the scenario with a different rubric: the session must still be scored against v1.
    const v2 = await makeVersion(
      scenario.id,
      ws.id,
      2,
      baseConfig({
        rubric: { criteria: [{ id: 'other', name: 'Other', description: 'Something else', weight: 100 }] },
        extraction: { variables: [{ key: 'city', type: 'text', description: 'City' }] },
      }),
    );
    expect(v2.id).not.toBe(v1.id);
    const r = await analysis.reprocess(sessionId, ws.id);
    expect(r.generation).toBe(2);
    await drain();
    const evs = await prisma.evaluation.findMany({ where: { sessionId }, include: { criteria: true }, orderBy: { generation: 'asc' } });
    expect(evs.map((e) => [e.generation, e.isCurrent])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(evs[1]!.scenarioVersionId).toBe(v1.id);
    expect(evs[1]!.criteria.map((c) => c.criterionId).sort()).toEqual(['leadership', 'results']);
    const extraction = await prisma.extractionResult.findMany({ where: { sessionId } });
    expect(extraction.every((x) => x.scenarioVersionId === v1.id)).toBe(true);
    expect(extraction.map((x) => x.key).sort()).toEqual(['team_size', 'years_experience']);
    const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.analysisGeneration).toBe(2);
    expect(s.analysisStatus).toBe('COMPLETED');
    // a stale job from generation 1 is ignored
    await analysis.runStep({ sessionId, workspaceId: ws.id, step: 'score', generation: 1 }, { attempt: 1, isFinalAttempt: true });
    expect(await prisma.evaluation.count({ where: { sessionId } })).toBe(2);
  });

  it('drops fabricated evidence from a real provider and stores extraction validation errors', async () => {
    const { session } = await makeSession({});
    useProvider(
      fakeProvider((req) =>
        isScoring(req)
          ? {
              criteria: [
                { criterionId: 'leadership', score: 95, insufficientEvidence: false, confidence: 0.9, rationale: 'Led a 200-person org.', evidence: [{ turnSeq: 2, quote: 'I led a 200 person organization' }] },
                { criterionId: 'results', score: 70, insufficientEvidence: false, confidence: 0.7, rationale: 'Quantified.', evidence: [{ turnSeq: 4, quote: 'We cut invoice errors by 40%' }, { turnSeq: 1, quote: 'What was the result?' }] },
              ],
              summary: 'Good. Their age suggests seniority.',
              strengths: ['Numbers'],
              weaknesses: [],
              improvements: ['More detail'],
              notes: [],
            }
          : { values: { years_experience: { value: 'lots', evidenceTurnSeqs: [2], confidence: 0.4 }, team_size: { value: 6, evidenceTurnSeqs: [2, 999], confidence: 0.9 } } },
      ),
    );
    await analysis.startPipeline(session.id, 'terminal');
    await drain();
    const ev = await prisma.evaluation.findFirstOrThrow({ where: { sessionId: session.id }, include: { criteria: true } });
    const lead = ev.criteria.find((c) => c.criterionId === 'leadership')!;
    expect(lead.score).toBeNull();
    expect(lead.insufficientEvidence).toBe(true);
    const res = ev.criteria.find((c) => c.criterionId === 'results')!;
    expect(res.score).toBe(70);
    expect(res.evidence).toEqual([{ turnSeq: 4, quote: 'We cut invoice errors by 40%' }]);
    // 40% of weight evidenced < 50% coverage → no overall score; computed in code
    expect(ev.overallScore).toBeNull();
    expect(ev.insufficientEvidence).toBe(true);
    expect(ev.simulated).toBe(false);
    expect(ev.provider).toBe('anthropic');
    expect(ev.summary).toBe('Good.');
    const years = await prisma.extractionResult.findUniqueOrThrow({ where: { sessionId_key: { sessionId: session.id, key: 'years_experience' } } });
    expect(years.valid).toBe(false);
    expect(years.errors).toEqual(['Not a number']);
    expect(years.value).toBeNull();
    const team = await prisma.extractionResult.findUniqueOrThrow({ where: { sessionId_key: { sessionId: session.id, key: 'team_size' } } });
    expect(team.valid).toBe(true);
    expect((team.evidence as any[]).map((e) => e.turnSeq)).toEqual([2]);
    // analysis token usage recorded once per step, idempotently
    const ledger = await prisma.usageLedger.findMany({ where: { sessionId: session.id } });
    expect(ledger.map((l) => l.kind).sort()).toEqual(['ANALYSIS_INPUT_TOKENS', 'ANALYSIS_INPUT_TOKENS', 'ANALYSIS_OUTPUT_TOKENS', 'ANALYSIS_OUTPUT_TOKENS']);
    await steps.run('score', { sessionId: session.id, workspaceId: ws.id, generation: 1 });
    expect(await prisma.usageLedger.count({ where: { sessionId: session.id } })).toBe(4);
  });

  it('a failing step is marked FAILED without corrupting prior results, and can be retried', async () => {
    const { session } = await makeSession({});
    await analysis.startPipeline(session.id, 'terminal');
    await drain(); // simulator: gen 1 completes
    const first = await prisma.evaluation.findFirstOrThrow({ where: { sessionId: session.id } });

    let calls = 0;
    useProvider(
      fakeProvider((req) => {
        if (isScoring(req)) {
          calls++;
          throw new Error('upstream 529 overloaded');
        }
        return { values: { years_experience: { value: 8, evidenceTurnSeqs: [2], confidence: 0.9 }, team_size: { value: null, evidenceTurnSeqs: [], confidence: 0 } } };
      }),
    );
    await analysis.reprocess(session.id, ws.id);
    await drain();
    expect(calls).toBe(4); // retried with backoff (BullMQ) up to the attempt limit
    const s = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(s.analysisStatus).toBe('PARTIAL');
    expect(s.analysisError).toMatch(/score: upstream 529/);
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { idempotencyKey: `pipeline_${session.id}_score_g2` } });
    expect(job.status).toBe('FAILED');
    expect(job.attempts).toBe(4);
    // prior evaluation untouched and still current
    const evs = await prisma.evaluation.findMany({ where: { sessionId: session.id } });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.id).toBe(first.id);
    expect(evs[0]!.isCurrent).toBe(true);
    expect(emitted.map((e) => e.type)).toContain('session.analyzed');

    // Retry the failed step with a working provider.
    useProvider(null);
    emitted.length = 0;
    await analysis.retryStep(ws.id, session.id, 'score');
    await drain();
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.analysisStatus).toBe('COMPLETED');
    const current = await prisma.evaluation.findFirstOrThrow({ where: { sessionId: session.id, isCurrent: true } });
    expect(current.generation).toBe(2);
    expect(await prisma.evaluation.count({ where: { sessionId: session.id } })).toBe(2);
    await expect(analysis.retryStep(ws.id, session.id, 'score')).rejects.toThrow(/Only a failed step/);
  });

  it('fails the session analysis when scoring and extraction both fail, emitting session.failed', async () => {
    const { session } = await makeSession({});
    useProvider(
      fakeProvider(() => {
        throw new Error('boom');
      }),
    );
    await analysis.startPipeline(session.id, 'terminal');
    await drain();
    const s = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(s.analysisStatus).toBe('FAILED');
    expect(emitted).toEqual([{ type: 'session.failed', payload: { sessionId: session.id, workspaceId: ws.id, errorCode: 'analysis_failed' } }]);
  });

  it('skips sessions without consent, without participant speech, or that never ran', async () => {
    const noConsent = await makeSession({ consent: { analysis: false } });
    const silent = await makeSession({ turns: [{ speaker: 'AGENT', text: 'Hello?' }] });
    const cancelled = await makeSession({ state: 'CANCELLED' });
    for (const x of [noConsent, silent, cancelled]) await analysis.startPipeline(x.session.id, 'terminal');
    expect(pending).toHaveLength(0);
    const rows = await prisma.session.findMany({ where: { id: { in: [noConsent.session.id, silent.session.id, cancelled.session.id] } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(noConsent.session.id)!.analysisStatus).toBe('SKIPPED');
    expect(byId.get(noConsent.session.id)!.analysisError).toMatch(/consent/);
    expect(byId.get(silent.session.id)!.analysisError).toMatch(/No participant speech/);
    expect(byId.get(cancelled.session.id)!.analysisStatus).toBe('SKIPPED');
    await expect(analysis.reprocess(noConsent.session.id, ws.id)).rejects.toThrow(/consent/);
    const active = await makeSession({ state: 'ACTIVE' });
    await expect(analysis.reprocess(active.session.id, ws.id)).rejects.toThrow(/not ended/);
  });

  it('sweep resumes a session stuck in QUEUED', async () => {
    const { session } = await makeSession({});
    await analysis.startPipeline(session.id, 'terminal');
    pending.length = 0; // simulate a lost job
    const r = await analysis.sweep({ startup: true });
    expect(r.resumed).toBeGreaterThanOrEqual(1);
    expect(pending.some((p) => p.sessionId === session.id && p.step === 'finalize_transcript')).toBe(true);
    await drain();
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).analysisStatus).toBe('COMPLETED');
  });
});

describe('review access & participant reports', () => {
  it('returns 404 for sessions in another workspace', async () => {
    const { session } = await makeSession({});
    await expect(review.detail(ws2.id, session.id, 'OWNER')).rejects.toMatchObject({ status: 404 });
    await expect(analysis.reprocess(session.id, ws2.id)).rejects.toBeInstanceOf(AppError);
    await expect(analysis.retryStep(ws2.id, session.id, 'score')).rejects.toMatchObject({ status: 404 });
    await expect(review.review(ws2.id, session.id, { kind: 'user', userId: user.id } as any, 'x')).rejects.toMatchObject({ status: 404 });
    await expect(review.remove(ws2.id, session.id, { kind: 'user', userId: user.id } as any)).rejects.toMatchObject({ status: 404 });
    const list = await review.list(ws2.id, { limit: 100 } as any);
    expect(list.data.find((r) => r.id === session.id)).toBeUndefined();
    const own = await review.list(ws.id, { limit: 100, participant: 'pat doe' } as any);
    expect(own.data.find((r) => r.id === session.id)).toBeDefined();
    // debug events only for CREATOR+
    expect((await review.detail(ws.id, session.id, 'REVIEWER')).events).toBeNull();
    expect((await review.detail(ws.id, session.id, 'CREATOR')).events).toEqual([]);
  });

  it('filters by score range and exports CSV with criterion + extraction columns', async () => {
    const { session } = await makeSession({});
    await analysis.startPipeline(session.id, 'terminal');
    await drain();
    const ev = await prisma.evaluation.findFirstOrThrow({ where: { sessionId: session.id, isCurrent: true } });
    const inRange = await review.list(ws.id, { limit: 100, minScore: Math.floor(ev.overallScore!), maxScore: Math.ceil(ev.overallScore!) } as any);
    expect(inRange.data.map((r) => r.id)).toContain(session.id);
    const outRange = await review.list(ws.id, { limit: 100, minScore: 100 } as any);
    expect(outRange.data.map((r) => r.id)).not.toContain(session.id);
    await prisma.participant.update({ where: { id: session.participantId }, data: { name: '=cmd|" /C calc"!A0' } });
    const csv = await exportsSvc.sessionsCsv(ws.id, { limit: 25, participantId: session.participantId } as any);
    expect(csv.count).toBe(1);
    const [header, row] = csv.body.replace('﻿', '').split('\r\n');
    expect(header).toContain('score:Leadership');
    expect(header).toContain('extract:years_experience');
    expect(row).toContain(`"'=cmd|"" /C calc""!A0"`);
    const pdf = await exportsSvc.sessionPdf(await review.detail(ws.id, session.id, 'REVIEWER'));
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('participant report shows only what the version allows', async () => {
    // defaults: transcript + feedback visible, scores hidden
    const a = await makeSession({ userId: user.id });
    await analysis.startPipeline(a.session.id, 'terminal');
    await drain();
    const ra = await reports.forSession(await prisma.session.findUniqueOrThrow({ where: { id: a.session.id } }));
    expect(ra.visibility).toEqual({ transcript: true, feedback: true, scores: false });
    expect(ra.transcript).toHaveLength(4);
    expect(ra.feedback!.summary).toMatch(/^Simulated analysis/);
    expect(ra.scores).toBeNull();
    const json = JSON.stringify(ra);
    for (const forbidden of ['"rationale"', '"evidence"', '"reviewNote"', 'years_experience', '"extraction"', '"notes"', '"criteria"']) expect(json).not.toContain(forbidden);

    // scores visible only with participantCanSeeScores AND rubric visibility participant_and_reviewers
    const s2 = await prisma.scenario.create({ data: { workspaceId: ws.id, slug: `s2-${rand()}`, name: 'Visible', type: 'coaching' } });
    const vScores = await makeVersion(
      s2.id,
      ws.id,
      1,
      baseConfig({
        analysis: { participantCanSeeScores: true, participantCanSeeTranscript: false },
        rubric: {
          visibility: 'participant_and_reviewers',
          minEvidenceCoverage: 0.5,
          criteria: [{ id: 'leadership', name: 'Leadership', description: 'Leads a team through a project', weight: 100 }],
        },
      }),
    );
    const b = await makeSession({ scenarioId: s2.id, versionId: vScores.id });
    await analysis.startPipeline(b.session.id, 'terminal');
    await drain();
    const rb = await reports.forSession(await prisma.session.findUniqueOrThrow({ where: { id: b.session.id } }));
    expect(rb.visibility).toEqual({ transcript: false, feedback: true, scores: true });
    expect(rb.transcript).toBeNull();
    expect(rb.scores).toMatchObject({ awaitingReview: false, criteria: [{ name: 'Leadership', weight: 100 }] });
    expect(JSON.stringify(rb.scores)).not.toContain('rationale');

    // canSeeScores but reviewers_only visibility → hidden
    const s3 = await prisma.scenario.create({ data: { workspaceId: ws.id, slug: `s3-${rand()}`, name: 'Hidden', type: 'interview' } });
    const vHidden = await makeVersion(s3.id, ws.id, 1, baseConfig({ analysis: { participantCanSeeScores: true, participantCanSeeFeedback: false } }));
    const c = await makeSession({ scenarioId: s3.id, versionId: vHidden.id });
    await analysis.startPipeline(c.session.id, 'terminal');
    await drain();
    const rc = await reports.forSession(await prisma.session.findUniqueOrThrow({ where: { id: c.session.id } }));
    expect(rc.scores).toBeNull();
    expect(rc.feedback).toBeNull();
    // interview scenarios require human review
    expect((await prisma.evaluation.findFirstOrThrow({ where: { sessionId: c.session.id } })).humanReviewRequired).toBe(true);

    // logged-in participant can read their own report; another user cannot
    await expect(reports.forUser(user.id, a.session.id)).resolves.toBeDefined();
    await expect(reports.forUser(otherUser.id, a.session.id)).rejects.toMatchObject({ status: 404 });
    const mine = await reports.listForUser(user.id, { limit: 50 });
    expect(mine.data.map((m) => m.id)).toEqual([a.session.id]);
    expect(mine.data[0]!.overallScore).toBeNull(); // scores not visible for that version
  });

  it('human review sign-off and admin delete', async () => {
    const { session } = await makeSession({});
    await analysis.startPipeline(session.id, 'terminal');
    await drain();
    const principal = { kind: 'user', userId: user.id, email: 'x', name: null, authSessionId: 'a', isSuperAdmin: false } as const;
    const r = await review.review(ws.id, session.id, principal, 'Looks right');
    expect(r.reviewedById).toBe(user.id);
    const d = await review.detail(ws.id, session.id, 'REVIEWER');
    expect(d.evaluation!.reviewNote).toBe('Looks right');
    await review.remove(ws.id, session.id, principal);
    await expect(review.detail(ws.id, session.id, 'OWNER')).rejects.toMatchObject({ status: 404 });
    const logs = await prisma.auditLog.findMany({ where: { targetId: session.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(['session.deleted', 'session.reviewed']);
  });
});
