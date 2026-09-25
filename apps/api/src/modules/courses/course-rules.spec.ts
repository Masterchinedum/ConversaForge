import { computeProgress, decideAttempt, isSafeHttpsUrl, parseRule, participantCanSeeScores, ruleAllowedFor } from './course-rules';

const items = [
  { id: 'a', position: 0, required: true },
  { id: 'b', position: 1, required: true },
  { id: 'c', position: 2, required: false },
  { id: 'd', position: 3, required: true },
];
const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

describe('computeProgress', () => {
  it('is 0% for an enrollment without attempts', () => {
    const p = computeProgress(items, [], 1, false);
    expect(p.percent).toBe(0);
    expect(p.completedRequired).toBe(0);
    expect(p.totalRequired).toBe(3);
    expect(p.nextItemId).toBe('a');
    expect(p.complete).toBe(false);
  });

  it('counts only attempts of the current generation', () => {
    const attempts = [
      { courseItemId: 'a', generation: 1, status: 'COMPLETED', startedAt: t(1) },
      { courseItemId: 'b', generation: 1, status: 'COMPLETED', startedAt: t(2) },
      { courseItemId: 'd', generation: 1, status: 'COMPLETED', startedAt: t(3) },
    ];
    expect(computeProgress(items, attempts, 1, false).percent).toBe(100);
    expect(computeProgress(items, attempts, 1, false).complete).toBe(true);
    const gen2 = computeProgress(items, attempts, 2, false);
    expect(gen2.percent).toBe(0);
    expect(gen2.statuses.a).toBe('NOT_STARTED');
  });

  it('ignores optional items for the percentage', () => {
    const attempts = [{ courseItemId: 'c', generation: 1, status: 'COMPLETED', startedAt: t(1) }];
    expect(computeProgress(items, attempts, 1, false).percent).toBe(0);
  });

  it('locks items behind incomplete required items when order is forced', () => {
    const attempts = [{ courseItemId: 'a', generation: 1, status: 'COMPLETED', startedAt: t(1) }];
    const p = computeProgress(items, attempts, 1, true);
    expect(p.locked).toEqual({ a: false, b: false, c: true, d: true });
    expect(p.nextItemId).toBe('b');
    const free = computeProgress(items, attempts, 1, false);
    expect(Object.values(free.locked).every((v) => !v)).toBe(true);
  });

  it('reports FAILED / IN_PROGRESS from the latest attempt, COMPLETED wins', () => {
    const attempts = [
      { courseItemId: 'a', generation: 1, status: 'FAILED', startedAt: t(1) },
      { courseItemId: 'a', generation: 1, status: 'STARTED', startedAt: t(2) },
      { courseItemId: 'b', generation: 1, status: 'STARTED', startedAt: t(1) },
      { courseItemId: 'b', generation: 1, status: 'FAILED', startedAt: t(2) },
      { courseItemId: 'd', generation: 1, status: 'COMPLETED', startedAt: t(1) },
      { courseItemId: 'd', generation: 1, status: 'FAILED', startedAt: t(2) },
    ];
    const p = computeProgress(items, attempts, 1, false);
    expect(p.statuses).toMatchObject({ a: 'IN_PROGRESS', b: 'FAILED', d: 'COMPLETED' });
  });

  it('moves on to optional items after required ones and treats all items as counted when none are required', () => {
    const attempts = ['a', 'b', 'd'].map((id, i) => ({ courseItemId: id, generation: 1, status: 'COMPLETED', startedAt: t(i) }));
    expect(computeProgress(items, attempts, 1, true).nextItemId).toBe('c');
    const optionalOnly = [
      { id: 'x', position: 0, required: false },
      { id: 'y', position: 1, required: false },
    ];
    const p = computeProgress(optionalOnly, [{ courseItemId: 'x', generation: 1, status: 'COMPLETED', startedAt: t(0) }], 1, false);
    expect(p.percent).toBe(50);
  });

  it('is 0% (not NaN) for an empty course', () => {
    expect(computeProgress([], [], 1, true)).toMatchObject({ percent: 0, complete: false, nextItemId: null });
  });
});

describe('decideAttempt', () => {
  const ev = (overallScore: number | null, insufficientEvidence = false, status = 'COMPLETED') => ({ id: 'e1', status, overallScore, insufficientEvidence });

  it('session_completed completes only on COMPLETED sessions', () => {
    expect(decideAttempt({ rule: { type: 'session_completed' }, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: null }).status).toBe('COMPLETED');
    expect(decideAttempt({ rule: { type: 'session_completed' }, sessionState: 'ABANDONED', analysisSkipped: false, evaluation: null }).status).toBe('FAILED');
    expect(decideAttempt({ rule: { type: 'session_completed' }, sessionState: 'FAILED', analysisSkipped: false, evaluation: null }).status).toBe('FAILED');
    expect(decideAttempt({ rule: { type: 'session_completed' }, sessionState: 'ACTIVE', analysisSkipped: false, evaluation: null }).status).toBe('STARTED');
  });

  it('min_score waits for scoring, then compares with the threshold', () => {
    const rule = { type: 'min_score' as const, minScore: 70 };
    expect(decideAttempt({ rule, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: null })).toMatchObject({ status: 'STARTED', reason: expect.stringMatching(/scoring/i) });
    expect(decideAttempt({ rule, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: ev(null, false, 'PROCESSING') }).status).toBe('STARTED');
    expect(decideAttempt({ rule, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: ev(69.9) })).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/below/) });
    expect(decideAttempt({ rule, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: ev(70) })).toMatchObject({ status: 'COMPLETED', score: 70 });
  });

  it('min_score is not completed on insufficient evidence, and says why', () => {
    const rule = { type: 'min_score' as const, minScore: 50 };
    const d = decideAttempt({ rule, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: ev(90, true) });
    expect(d.status).toBe('FAILED');
    expect(d.reason).toMatch(/evidence/i);
    const nullScore = decideAttempt({ rule, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: ev(null) });
    expect(nullScore.status).toBe('FAILED');
  });

  it('min_score fails with a reason when analysis is skipped', () => {
    const d = decideAttempt({ rule: { type: 'min_score', minScore: 10 }, sessionState: 'COMPLETED', analysisSkipped: true, evaluation: null });
    expect(d).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/scoring was not performed/) });
  });

  it('does not reveal the number when participants may not see scores', () => {
    const d = decideAttempt({ rule: { type: 'min_score', minScore: 70 }, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: ev(42), scoresVisible: false });
    expect(d.status).toBe('FAILED');
    expect(d.reason).not.toMatch(/42|70/);
  });

  it('participantCanSeeScores follows the scenario config and pending human review', () => {
    const visible = { analysis: { participantCanSeeScores: true }, rubric: { visibility: 'participant_and_reviewers' } };
    expect(participantCanSeeScores(visible)).toBe(true);
    expect(participantCanSeeScores({ ...visible, rubric: { visibility: 'reviewers_only' } })).toBe(false);
    expect(participantCanSeeScores({ rubric: { visibility: 'participant_and_reviewers' } })).toBe(false);
    expect(participantCanSeeScores(visible, { humanReviewRequired: true, reviewedAt: null })).toBe(false);
    expect(participantCanSeeScores(visible, { humanReviewRequired: true, reviewedAt: new Date() })).toBe(true);
  });

  it('manual never self-completes', () => {
    expect(decideAttempt({ rule: { type: 'manual' }, sessionState: 'COMPLETED', analysisSkipped: false, evaluation: ev(100) }).status).toBe('STARTED');
  });
});

describe('rules & urls', () => {
  it('defaults and validates rules per kind', () => {
    expect(parseRule('SCENARIO', {})).toEqual({ type: 'session_completed' });
    expect(parseRule('VIDEO', {})).toEqual({ type: 'viewed' });
    expect(parseRule('VIDEO', { type: 'min_score', minScore: 5 })).toEqual({ type: 'viewed' });
    expect(ruleAllowedFor('SCENARIO', { type: 'viewed' })).toBe(false);
    expect(ruleAllowedFor('LINK', { type: 'manual' })).toBe(true);
  });

  it('accepts only public https URLs', () => {
    expect(isSafeHttpsUrl('https://example.com/video.mp4')).toBe(true);
    expect(isSafeHttpsUrl('http://example.com')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpsUrl('https://user:pw@example.com')).toBe(false);
    expect(isSafeHttpsUrl('https://localhost/x')).toBe(false);
    expect(isSafeHttpsUrl('https://192.168.1.10/x')).toBe(false);
    expect(isSafeHttpsUrl('https://10.0.0.1/x')).toBe(false);
    expect(isSafeHttpsUrl('not a url')).toBe(false);
  });
});
