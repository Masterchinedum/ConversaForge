/**
 * Integration tests for courses/enrollments/progress against a real Postgres database
 * (default conversaforge_test_f; override with COURSES_TEST_DATABASE_URL). Sessions are created through
 * the runtime's real SessionsService; the job queue is replaced by an inline drain.
 */
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = process.env.COURSES_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/conversaforge_test_f';

import { defaultScenarioConfig, stableStringify } from '@cf/shared';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { DomainEvents } from '../../common/events/domain-events';
import { AppError } from '../../common/http/errors';
import { LlmService } from '../../common/llm/llm.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { SessionsService } from '../runtime/sessions.service';
import { ProviderResolverService } from '../runtime/voice/provider-resolver.service';
import { UsageService } from '../usage/usage.service';
import { CourseProgressService } from './course-progress.service';
import { CoursesService } from './courses.service';
import { EnrollmentsService } from './enrollments.service';
import { LearnService, type LearnAccess, type LearnerRef } from './learn.service';

jest.setTimeout(60_000);

const prisma = new PrismaService();
const crypto = new CryptoService();
const events = new DomainEvents();
const audit = new AuditService(prisma);
const storage = new StorageService(crypto);
const llm = new LlmService(prisma, crypto);
const usage = new UsageService(prisma, events);
const sessions = new SessionsService(prisma, crypto, usage, new ProviderResolverService(llm));
const enqueued: Array<{ sessionId: string; jobId?: string }> = [];
const queueStub = {
  process: jest.fn(),
  enqueue: jest.fn(async (_q: string, _name: string, data: { sessionId: string }, opts?: { jobId?: string }) => {
    enqueued.push({ sessionId: data.sessionId, jobId: opts?.jobId });
  }),
} as any;
const mail = { send: jest.fn(async () => ({ delivered: false })) } as any;
const courses = new CoursesService(prisma, storage, crypto, audit);
const progress = new CourseProgressService(prisma, events, queueStub);
const enrollments = new EnrollmentsService(prisma, courses, progress, audit, mail);
const learn = new LearnService(prisma, courses, progress, sessions);

const rand = () => randomBytes(6).toString('hex');
const tick = () => new Promise((r) => setTimeout(r, 30));
/** Let async event listeners run, then process the queued jobs inline (like the BullMQ worker). */
async function drain() {
  await tick();
  while (enqueued.length) {
    const j = enqueued.shift()!;
    await progress.refreshAttemptForSession(j.sessionId);
  }
}

let ws: { id: string };
let ws2: { id: string };
let creator: { id: string; email: string; name: string | null };
let learner: { id: string; email: string; name: string | null };
let learner2: { id: string; email: string; name: string | null };
let scenario: { id: string; name: string };
let scenario2: { id: string };
let creatorP: { kind: 'user'; userId: string; email: string; name: string | null; authSessionId: string; isSuperAdmin: boolean };

const asLearner = (u: { id: string; email: string; name: string | null }): LearnerRef => ({ userId: u.id, email: u.email, name: u.name });
const member: LearnAccess = { via: 'member', role: 'MEMBER' };

async function makeScenario(workspaceId: string, name: string) {
  const s = await prisma.scenario.create({ data: { workspaceId, slug: `s-${rand()}`, name, type: 'coaching' } });
  const config = defaultScenarioConfig({
    basics: { name, type: 'coaching' } as any,
    rubric: { evaluatedSubject: 'the learner', visibility: 'participant_and_reviewers', criteria: [{ id: 'clarity', name: 'Clarity', description: 'Clear', weight: 100 }] } as any,
    analysis: { participantCanSeeScores: true } as any,
  });
  const v = await prisma.scenarioVersion.create({
    data: { scenarioId: s.id, workspaceId, version: 1, config: config as unknown as Prisma.InputJsonValue, configHash: crypto.sha256(stableStringify(config)) },
  });
  await prisma.scenario.update({ where: { id: s.id }, data: { latestVersionId: v.id, latestVersionNumber: 1, status: 'PUBLISHED' } });
  return s;
}

async function endSession(sessionId: string, state: 'COMPLETED' | 'ABANDONED' | 'FAILED') {
  const s = await prisma.session.update({ where: { id: sessionId }, data: { state, endedAt: new Date(), durationMs: 60_000 } });
  events.emit('session.terminal', { sessionId, workspaceId: s.workspaceId, state });
  await drain();
}

async function addEvaluation(sessionId: string, overallScore: number | null, insufficientEvidence = false) {
  const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  await prisma.evaluation.updateMany({ where: { sessionId }, data: { isCurrent: false } });
  const count = await prisma.evaluation.count({ where: { sessionId } });
  const e = await prisma.evaluation.create({
    data: {
      sessionId,
      workspaceId: s.workspaceId,
      scenarioVersionId: s.scenarioVersionId,
      rubricHash: 'x',
      status: 'COMPLETED',
      overallScore,
      insufficientEvidence,
      generation: count + 1,
      completedAt: new Date(),
    },
  });
  events.emit('session.analyzed', { sessionId, workspaceId: s.workspaceId, evaluationId: e.id, overallScore });
  await drain();
  return e;
}

async function newCourse(opts: { forcedOrder?: boolean; visibility?: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC' } = {}) {
  const c = await courses.create(ws.id, creatorP, { title: `Course ${rand()}`, forcedOrder: opts.forcedOrder, visibility: opts.visibility });
  const scenarioItem = await courses.addItem(ws.id, c.id, creatorP, { kind: 'SCENARIO', scenarioId: scenario.id });
  const videoItem = await courses.addItem(ws.id, c.id, creatorP, { kind: 'VIDEO', title: 'Intro video', url: 'https://videos.example.com/intro.mp4' });
  await courses.update(ws.id, c.id, creatorP, { status: 'PUBLISHED' });
  return { course: c, scenarioItem: scenarioItem!, videoItem: videoItem! };
}

const load = (courseId: string) => learn.loadMemberCourse(ws.id, courseId);

beforeAll(async () => {
  await prisma.$connect();
  creator = await prisma.user.create({ data: { email: `creator-${rand()}@example.com`, name: 'Creator' } });
  learner = await prisma.user.create({ data: { email: `learner-${rand()}@example.com`, name: 'Lee Learner' } });
  learner2 = await prisma.user.create({ data: { email: `learner2-${rand()}@example.com`, name: 'Second' } });
  ws = await prisma.workspace.create({ data: { name: 'F test', slug: `f-test-${rand()}` } });
  ws2 = await prisma.workspace.create({ data: { name: 'F other', slug: `f-other-${rand()}` } });
  await prisma.membership.createMany({
    data: [
      { workspaceId: ws.id, userId: creator.id, role: 'CREATOR' },
      { workspaceId: ws.id, userId: learner.id, role: 'MEMBER' },
      { workspaceId: ws.id, userId: learner2.id, role: 'MEMBER' },
    ],
  });
  creatorP = { kind: 'user', userId: creator.id, email: creator.email, name: creator.name, authSessionId: 'x', isSuperAdmin: false };
  scenario = await makeScenario(ws.id, 'Objection handling');
  scenario2 = await makeScenario(ws2.id, 'Other workspace scenario');
  progress.onModuleInit();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('progress invariants', () => {
  it('a new enrollment is 0% even if the learner (and the creator) already completed the same scenario', async () => {
    // Prior, non-course practice of the very same scenario by the learner and by the creator.
    for (const u of [learner, creator]) {
      const { session } = await sessions.createSession({
        workspaceId: ws.id,
        scenarioId: scenario.id,
        channel: 'BROWSER',
        participant: { userId: u.id, email: u.email, name: u.name },
      });
      await endSession(session.id, 'COMPLETED');
      await addEvaluation(session.id, 95);
    }
    const { course } = await newCourse();
    const r = await enrollments.assign(ws.id, course.id, creatorP, { userIds: [learner.id], teamIds: [], emails: [], notify: false });
    expect(r.created).toBe(1);

    const d = await learn.detail(await load(course.id), asLearner(learner), member);
    expect(d.enrollment).not.toBeNull();
    expect(d.progress).toMatchObject({ percent: 0, completedRequired: 0, totalRequired: 2, complete: false });
    expect(d.items.every((i) => i.status === 'NOT_STARTED')).toBe(true);

    const ov = await learn.overview(ws.id, asLearner(learner), 'MEMBER');
    const mine = ov.enrollments.find((e) => e.course.id === course.id)!;
    expect(mine.progress.percent).toBe(0);

    const list = await enrollments.list(ws.id, course.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.progress.percent).toBe(0);

    // The creator (not enrolled) sees 0% as well.
    const asCreator = await learn.detail(await load(course.id), asLearner(creator), { via: 'member', role: 'CREATOR' });
    expect(asCreator.enrollment).toBeNull();
    expect(asCreator.progress.percent).toBe(0);
  });

  it('journey: start scenario → session completes → 50%; view video → 100% and COMPLETED; duplicate events are idempotent', async () => {
    const { course, scenarioItem, videoItem } = await newCourse();
    await enrollments.assign(ws.id, course.id, creatorP, { userIds: [learner.id], teamIds: [], emails: [], notify: false });
    const c = await load(course.id);

    const started = (await learn.start(c, asLearner(learner), scenarioItem.id, member)) as any;
    expect(started.kind).toBe('SCENARIO');
    expect(started.sessionToken).toMatch(/^cfs_/);
    const session = await prisma.session.findUniqueOrThrow({ where: { id: started.sessionId } });
    expect(session.courseItemAttemptId).toBe(started.attemptId);
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { courseId: course.id } });
    expect(session.enrollmentId).toBe(enrollment.id);
    expect(session.participantId).toBe(enrollment.participantId);

    let d = await learn.detail(c, asLearner(learner), member);
    expect(d.items.find((i) => i.id === scenarioItem.id)!.status).toBe('IN_PROGRESS');
    expect(d.progress.percent).toBe(0);

    await endSession(started.sessionId, 'COMPLETED');
    d = await learn.detail(c, asLearner(learner), member);
    expect(d.items.find((i) => i.id === scenarioItem.id)!.status).toBe('COMPLETED');
    expect(d.progress.percent).toBe(50);
    expect(d.nextItemId).toBe(videoItem.id);

    const content = (await learn.content(c, asLearner(learner), videoItem.id, member)) as any;
    expect(content.url).toBe('https://videos.example.com/intro.mp4');
    d = await learn.complete(c, asLearner(learner), videoItem.id, member);
    expect(d.progress).toMatchObject({ percent: 100, complete: true });
    const e1 = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(e1.status).toBe('COMPLETED');
    expect(e1.completedAt).not.toBeNull();

    // Duplicate / replayed events and repeated "viewed" clicks change nothing.
    events.emit('session.terminal', { sessionId: started.sessionId, workspaceId: ws.id, state: 'COMPLETED' });
    events.emit('session.terminal', { sessionId: started.sessionId, workspaceId: ws.id, state: 'COMPLETED' });
    events.emit('session.analyzed', { sessionId: started.sessionId, workspaceId: ws.id, evaluationId: null, overallScore: null });
    await drain();
    await learn.complete(c, asLearner(learner), videoItem.id, member);
    const attempts = await prisma.courseItemAttempt.findMany({ where: { enrollmentId: enrollment.id } });
    expect(attempts.filter((a) => a.status === 'COMPLETED')).toHaveLength(2);
    const e2 = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(e2.completedAt!.getTime()).toBe(e1.completedAt!.getTime());

    // Start over: fresh generation, 0%, history kept.
    d = await learn.startOver(c, asLearner(learner), member);
    expect(d.enrollment!.generation).toBe(2);
    expect(d.enrollment!.status).toBe('ACTIVE');
    expect(d.progress.percent).toBe(0);
    expect(d.items.every((i) => i.status === 'NOT_STARTED')).toBe(true);
    expect(d.history).toEqual([{ generation: 1, completedItems: 2, attempts: 2 }]);
    expect(await prisma.courseItemAttempt.count({ where: { enrollmentId: enrollment.id } })).toBe(2);
    expect(d.nextItemId).toBe(scenarioItem.id);

    // A late event for the old-generation session does not touch the new generation.
    await progress.refreshAttemptForSession(started.sessionId);
    d = await learn.detail(c, asLearner(learner), member);
    expect(d.progress.percent).toBe(0);
  });

  it('abandoned sessions fail the attempt and can be retried', async () => {
    const { course, scenarioItem } = await newCourse();
    await enrollments.assign(ws.id, course.id, creatorP, { userIds: [learner2.id], teamIds: [], emails: [], notify: false });
    const c = await load(course.id);
    const a1 = (await learn.start(c, asLearner(learner2), scenarioItem.id, member)) as any;
    await endSession(a1.sessionId, 'ABANDONED');
    let d = await learn.detail(c, asLearner(learner2), member);
    const it1 = d.items.find((i) => i.id === scenarioItem.id)!;
    expect(it1.status).toBe('FAILED');
    expect(it1.lastAttempt!.reason).toMatch(/abandoned/);
    const a2 = (await learn.start(c, asLearner(learner2), scenarioItem.id, member)) as any;
    await endSession(a2.sessionId, 'COMPLETED');
    d = await learn.detail(c, asLearner(learner2), member);
    expect(d.items.find((i) => i.id === scenarioItem.id)!.status).toBe('COMPLETED');
  });

  it('forced order: starting an item before earlier required items are complete → 409', async () => {
    const { course, scenarioItem, videoItem } = await newCourse({ forcedOrder: true });
    // Put the video first so the scenario is second.
    await courses.reorder(ws.id, course.id, creatorP, [videoItem.id, scenarioItem.id]);
    await enrollments.assign(ws.id, course.id, creatorP, { userIds: [learner2.id], teamIds: [], emails: [], notify: false });
    const c = await load(course.id);
    let d = await learn.detail(c, asLearner(learner2), member);
    expect(d.items.map((i) => [i.id, i.locked])).toEqual([
      [videoItem.id, false],
      [scenarioItem.id, true],
    ]);
    await expect(learn.start(c, asLearner(learner2), scenarioItem.id, member)).rejects.toMatchObject({ status: 409 });
    await learn.complete(c, asLearner(learner2), videoItem.id, member);
    const s = (await learn.start(c, asLearner(learner2), scenarioItem.id, member)) as any;
    expect(s.sessionId).toBeTruthy();
    d = await learn.detail(c, asLearner(learner2), member);
    expect(d.items.find((i) => i.id === scenarioItem.id)!.locked).toBe(false);
  });

  it('min_score: waits for scoring; insufficient evidence and low scores do not complete; enough score completes', async () => {
    const { course, scenarioItem, videoItem } = await newCourse();
    await courses.updateItem(ws.id, course.id, scenarioItem.id, creatorP, { completionRule: { type: 'min_score', minScore: 70 } });
    await courses.updateItem(ws.id, course.id, videoItem.id, creatorP, { required: false });
    await enrollments.assign(ws.id, course.id, creatorP, { userIds: [learner.id], teamIds: [], emails: [], notify: false });
    const c = await load(course.id);
    const item = () => learn.detail(c, asLearner(learner), member).then((d) => ({ d, it: d.items.find((i) => i.id === scenarioItem.id)! }));

    const s1 = (await learn.start(c, asLearner(learner), scenarioItem.id, member)) as any;
    await endSession(s1.sessionId, 'COMPLETED');
    let r = await item();
    expect(r.it.status).toBe('IN_PROGRESS');
    expect(r.it.lastAttempt!.reason).toMatch(/scoring/i);

    await addEvaluation(s1.sessionId, 88, true); // insufficient evidence even though a number exists
    r = await item();
    expect(r.it.status).toBe('FAILED');
    expect(r.it.lastAttempt!.reason).toMatch(/evidence/i);
    expect(r.d.progress.percent).toBe(0);

    const s2 = (await learn.start(c, asLearner(learner), scenarioItem.id, member)) as any;
    await endSession(s2.sessionId, 'COMPLETED');
    await addEvaluation(s2.sessionId, 65);
    r = await item();
    expect(r.it.status).toBe('FAILED');
    expect(r.it.lastAttempt!.reason).toMatch(/below the required 70/);

    // Re-analysis of the same session with a better score completes it (FAILED → COMPLETED allowed).
    await addEvaluation(s2.sessionId, 75);
    r = await item();
    expect(r.it.status).toBe('COMPLETED');
    expect(r.it.lastAttempt!.score).toBe(75);
    expect(r.d.progress).toMatchObject({ percent: 100, complete: true });

    // A later, lower re-analysis never downgrades a completed attempt.
    await addEvaluation(s2.sessionId, 10);
    r = await item();
    expect(r.it.status).toBe('COMPLETED');
  });

  it('ignores sessions whose attempt link does not match (other workspace / other session)', async () => {
    const { course, scenarioItem } = await newCourse();
    await enrollments.assign(ws.id, course.id, creatorP, { userIds: [learner2.id], teamIds: [], emails: [], notify: false });
    const c = await load(course.id);
    const s = (await learn.start(c, asLearner(learner2), scenarioItem.id, member)) as any;
    // A session in another workspace that claims the attempt.
    const { session: foreign } = await sessions.createSession({
      workspaceId: ws2.id,
      scenarioId: scenario2.id,
      channel: 'BROWSER',
      participant: { email: 'x@example.com' },
      courseItemAttemptId: s.attemptId,
    });
    await endSession(foreign.id, 'COMPLETED');
    const d = await learn.detail(c, asLearner(learner2), member);
    expect(d.items.find((i) => i.id === scenarioItem.id)!.status).toBe('IN_PROGRESS');
  });
});

describe('visibility, enrollment & editor validation', () => {
  it('private courses are invisible to unassigned members; organization courses allow self-enrollment', async () => {
    const { course } = await newCourse({ visibility: 'PRIVATE' });
    await expect(learn.detail(await load(course.id), asLearner(learner2), member)).rejects.toMatchObject({ status: 404 });
    await expect(learn.enroll(await load(course.id), asLearner(learner2), member)).rejects.toBeInstanceOf(AppError);

    await courses.update(ws.id, course.id, creatorP, { visibility: 'ORGANIZATION' });
    const d0 = await learn.detail(await load(course.id), asLearner(learner2), member);
    expect(d0.canEnroll).toBe(true);
    expect(d0.enrollment).toBeNull();
    await learn.enroll(await load(course.id), asLearner(learner2), member);
    const d1 = await learn.detail(await load(course.id), asLearner(learner2), member);
    expect(d1.enrollment).not.toBeNull();
    expect(d1.progress.percent).toBe(0);
    expect(d1.canUnenroll).toBe(true);
  });

  it('share token: works for any logged-in user, stops working when rotated or revoked', async () => {
    const { course } = await newCourse({ visibility: 'PRIVATE' });
    const outsider = await prisma.user.create({ data: { email: `out-${rand()}@example.com`, name: 'Outsider' } });
    const { shareToken } = await courses.rotateShareToken(ws.id, course.id, creatorP);
    const c = await learn.loadTokenCourse(shareToken!);
    await learn.enroll(c, asLearner(outsider), { via: 'token' });
    const d = await learn.detail(c, asLearner(outsider), { via: 'token' });
    expect(d.enrollment).not.toBeNull();
    expect(d.progress.percent).toBe(0);
    const again = await courses.rotateShareToken(ws.id, course.id, creatorP);
    await expect(learn.loadTokenCourse(shareToken!)).rejects.toMatchObject({ status: 404 });
    await courses.revokeShareToken(ws.id, course.id, creatorP);
    await expect(learn.loadTokenCourse(again.shareToken!)).rejects.toMatchObject({ status: 404 });
  });

  it('email assignment before signup is claimed by the account with that email', async () => {
    const { course } = await newCourse();
    const email = `later-${rand()}@example.com`;
    const r = await enrollments.assign(ws.id, course.id, creatorP, { userIds: [], teamIds: [], emails: [email.toUpperCase()], notify: false });
    expect(r.created).toBe(1);
    const later = await prisma.user.create({ data: { email, name: 'Later' } });
    await prisma.membership.create({ data: { workspaceId: ws.id, userId: later.id, role: 'MEMBER' } });
    const ov = await learn.overview(ws.id, asLearner(later), 'MEMBER');
    expect(ov.enrollments.map((e) => e.course.id)).toContain(course.id);
    expect(ov.enrollments.find((e) => e.course.id === course.id)!.progress.percent).toBe(0);
  });

  it('team assignment expands to team participants', async () => {
    const { course } = await newCourse();
    const p = await prisma.participant.findFirstOrThrow({ where: { workspaceId: ws.id, userId: learner.id }, orderBy: { createdAt: 'asc' } });
    const team = await prisma.team.create({ data: { workspaceId: ws.id, name: `Team ${rand()}` } });
    await prisma.teamMember.create({ data: { teamId: team.id, participantId: p.id } });
    const r = await enrollments.assign(ws.id, course.id, creatorP, { userIds: [], teamIds: [team.id, 'bogus'], emails: [], notify: false });
    expect(r.created).toBe(1);
    expect(r.invalid).toEqual([{ value: 'bogus', reason: 'Team not found' }]);
  });

  it('validates items: other-workspace scenario, unpublished scenario, non-https URLs, wrong rule', async () => {
    const c = await courses.create(ws.id, creatorP, { title: 'Validation' });
    await expect(courses.addItem(ws.id, c.id, creatorP, { kind: 'SCENARIO', scenarioId: scenario2.id })).rejects.toMatchObject({ status: 422 });
    const draft = await prisma.scenario.create({ data: { workspaceId: ws.id, slug: `d-${rand()}`, name: 'Draft only', type: 'custom' } });
    await expect(courses.addItem(ws.id, c.id, creatorP, { kind: 'SCENARIO', scenarioId: draft.id })).rejects.toMatchObject({ status: 422 });
    await expect(courses.addItem(ws.id, c.id, creatorP, { kind: 'LINK', title: 'x', url: 'http://example.com' } as any)).rejects.toBeTruthy();
    await expect(
      courses.addItem(ws.id, c.id, creatorP, { kind: 'VIDEO', title: 'x', url: 'https://example.com/v.mp4', completionRule: { type: 'min_score', minScore: 5 } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(courses.update(ws.id, c.id, creatorP, { status: 'PUBLISHED' })).rejects.toMatchObject({ status: 422 });
    // Positions stay contiguous across add/remove/reorder.
    const a = await courses.addItem(ws.id, c.id, creatorP, { kind: 'LINK', title: 'A', url: 'https://example.com/a' });
    const b = await courses.addItem(ws.id, c.id, creatorP, { kind: 'LINK', title: 'B', url: 'https://example.com/b' });
    const d = await courses.addItem(ws.id, c.id, creatorP, { kind: 'LINK', title: 'C', url: 'https://example.com/c' });
    await courses.removeItem(ws.id, c.id, b!.id, creatorP);
    let got = await courses.get(ws.id, c.id);
    expect(got.items.map((i) => [i.title, i.position])).toEqual([
      ['A', 0],
      ['C', 1],
    ]);
    await expect(courses.reorder(ws.id, c.id, creatorP, [a!.id])).rejects.toMatchObject({ status: 422 });
    got = await courses.reorder(ws.id, c.id, creatorP, [d!.id, a!.id]);
    expect(got.items.map((i) => [i.title, i.position])).toEqual([
      ['C', 0],
      ['A', 1],
    ]);
    // Cross-workspace access to the course is a 404.
    await expect(courses.get(ws2.id, c.id)).rejects.toMatchObject({ status: 404 });
  });
});
