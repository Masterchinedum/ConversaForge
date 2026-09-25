/**
 * Analytics aggregates against a real Postgres database (default conversaforge_test_f; override with
 * COURSES_TEST_DATABASE_URL). Each test run uses fresh workspaces so counts are exact.
 */
import { randomBytes } from 'node:crypto';

process.env.DATABASE_URL = process.env.COURSES_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/conversaforge_test_f';

import { defaultScenarioConfig, stableStringify } from '@cf/shared';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AnalyticsQuery, AnalyticsService, resolveRange } from './analytics.service';
import { csvCell, toCsv } from './csv';

jest.setTimeout(60_000);

const prisma = new PrismaService();
const crypto = new CryptoService();
const analytics = new AnalyticsService(prisma);
const rand = () => randomBytes(6).toString('hex');
const q = (over: Partial<AnalyticsQuery> = {}): AnalyticsQuery => AnalyticsQuery.parse({ from: '2026-09-01', to: '2026-09-10', ...over });

let ws: { id: string };
let ws2: { id: string };
let memberUser: { id: string };
let scA: { id: string; v: string };
let scB: { id: string; v: string };
let team: { id: string };

async function scenario(workspaceId: string, name: string) {
  const s = await prisma.scenario.create({ data: { workspaceId, slug: `s-${rand()}`, name, type: 'interview' } });
  const config = defaultScenarioConfig({
    basics: { name, type: 'interview' } as any,
    analysis: { participantCanSeeScores: name !== 'Scenario B' } as any,
    rubric: { visibility: 'participant_and_reviewers' } as any,
  });
  const v = await prisma.scenarioVersion.create({
    data: { scenarioId: s.id, workspaceId, version: 1, config: config as unknown as Prisma.InputJsonValue, configHash: crypto.sha256(stableStringify(config)) },
  });
  return { id: s.id, v: v.id };
}

async function session(opts: {
  workspaceId?: string;
  sc: { id: string; v: string };
  participantId: string;
  day: number;
  state?: 'COMPLETED' | 'ABANDONED' | 'ACTIVE';
  channel?: 'BROWSER' | 'EMBED' | 'API';
  durationMs?: number;
  score?: number | null;
  insufficient?: boolean;
  simulated?: boolean;
  criteria?: Array<[string, string, number | null]>;
  costMicros?: number;
}) {
  const workspaceId = opts.workspaceId ?? ws.id;
  const s = await prisma.session.create({
    data: {
      workspaceId,
      scenarioId: opts.sc.id,
      scenarioVersionId: opts.sc.v,
      participantId: opts.participantId,
      state: opts.state ?? 'COMPLETED',
      channel: opts.channel ?? 'BROWSER',
      durationMs: opts.durationMs ?? 60_000,
      createdAt: new Date(Date.UTC(2026, 8, opts.day, 12)),
      providerInfo: { simulated: !!opts.simulated } as Prisma.InputJsonValue,
    },
  });
  if (opts.score !== undefined || opts.insufficient) {
    await prisma.evaluation.create({
      data: {
        sessionId: s.id,
        workspaceId,
        scenarioVersionId: opts.sc.v,
        rubricHash: 'x',
        status: 'COMPLETED',
        overallScore: opts.score ?? null,
        insufficientEvidence: !!opts.insufficient,
        criteria: opts.criteria
          ? { create: opts.criteria.map(([id, name, score]) => ({ criterionId: id, name, weight: 50, score, insufficientEvidence: score == null })) }
          : undefined,
      },
    });
  }
  if (opts.costMicros) {
    await prisma.usageLedger.create({
      data: { workspaceId, sessionId: s.id, kind: 'LLM_INPUT_TOKENS', provider: 'anthropic', quantity: 1, unit: 'tokens', costMicros: BigInt(opts.costMicros), idempotencyKey: `t-${rand()}`, createdAt: new Date(Date.UTC(2026, 8, opts.day, 12)) },
    });
  }
  return s;
}

beforeAll(async () => {
  await prisma.$connect();
  ws = await prisma.workspace.create({ data: { name: 'Analytics', slug: `an-${rand()}` } });
  ws2 = await prisma.workspace.create({ data: { name: 'Analytics other', slug: `an2-${rand()}` } });
  memberUser = await prisma.user.create({ data: { email: `m-${rand()}@example.com`, name: 'Member Mo' } });
  scA = await scenario(ws.id, 'Scenario A');
  scB = await scenario(ws.id, 'Scenario B');
  const scOther = await scenario(ws2.id, 'Other');
  const pMember = await prisma.participant.create({ data: { workspaceId: ws.id, userId: memberUser.id, name: 'Member Mo' } });
  const pEvil = await prisma.participant.create({ data: { workspaceId: ws.id, name: '=HYPERLINK("http://evil.example","click")', email: 'evil@example.com' } });
  const pOther = await prisma.participant.create({ data: { workspaceId: ws2.id, name: 'Other org' } });
  team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Sales, EMEA' } });
  await prisma.teamMember.create({ data: { teamId: team.id, participantId: pMember.id } });

  // Member: 3 sessions (2 scored, one insufficient), scenario A, browser.
  await session({ sc: scA, participantId: pMember.id, day: 2, score: 80, criteria: [['c1', 'Clarity', 90], ['c2', 'Empathy', 70]], costMicros: 1000 });
  await session({ sc: scA, participantId: pMember.id, day: 2, score: 60, criteria: [['c1', 'Clarity', 50], ['c2', 'Empathy', null]], simulated: true });
  await session({ sc: scA, participantId: pMember.id, day: 4, insufficient: true, score: null, state: 'COMPLETED' });
  // Other learner: 2 sessions on B via embed, one abandoned.
  await session({ sc: scB, participantId: pEvil.id, day: 5, channel: 'EMBED', score: 100, costMicros: 500 });
  await session({ sc: scB, participantId: pEvil.id, day: 5, channel: 'EMBED', state: 'ABANDONED' });
  // Outside the range and another workspace — must never be counted.
  await session({ sc: scA, participantId: pMember.id, day: 20, score: 10 });
  await session({ workspaceId: ws2.id, sc: scOther, participantId: pOther.id, day: 3, score: 5, costMicros: 99999 });
});
afterAll(async () => prisma.$disconnect());

describe('analytics summary', () => {
  it('computes workspace KPIs, excluding insufficient evidence from averages and other workspaces entirely', async () => {
    const r = await analytics.summary(ws.id, q(), { role: 'ADMIN', userId: null });
    expect(r.scope).toBe('workspace');
    expect(r.kpis).toMatchObject({
      sessions: 5,
      completed: 4,
      completionRate: 80,
      avgScore: 80, // (80 + 60 + 100) / 3 — the insufficient-evidence session is excluded
      scoredSessions: 3,
      insufficientEvidence: 1,
      simulatedSessions: 1,
      simulatedShare: 20,
      learners: 2,
      totalDurationMs: 300_000,
      costMicros: 1500,
    });
    expect(r.daily).toHaveLength(10);
    expect(r.daily.find((d) => d.date === '2026-09-02')).toMatchObject({ sessions: 2, avgScore: 70 });
    expect(r.daily.find((d) => d.date === '2026-09-03')).toMatchObject({ sessions: 0, avgScore: null });
    expect(r.byScenario.map((s) => [s.name, s.sessions, s.avgScore])).toEqual([
      ['Scenario A', 3, 70],
      ['Scenario B', 2, 100],
    ]);
    expect(r.byChannel.map((c) => [c.id, c.sessions])).toEqual([
      ['BROWSER', 3],
      ['EMBED', 2],
    ]);
    expect(r.byTeam).toEqual([expect.objectContaining({ name: 'Sales, EMEA', sessions: 3 })]);
    expect(r.byState).toEqual(expect.arrayContaining([{ state: 'COMPLETED', count: 4 }, { state: 'ABANDONED', count: 1 }]));
    expect(r.rubric).toBeNull();
    expect(r.recentSessions).toHaveLength(5);
  });

  it('applies scenario/team/channel filters and computes rubric dimensions for a scenario', async () => {
    const a = await analytics.summary(ws.id, q({ scenarioId: scA.id }), { role: 'REVIEWER', userId: null });
    expect(a.kpis.sessions).toBe(3);
    expect(a.kpis.costMicros).toBe(1000); // narrowed to sessions of the scenario
    expect(a.rubric).toEqual([
      { criterionId: 'c1', name: 'Clarity', avgScore: 70, scored: 2, insufficient: 0 },
      { criterionId: 'c2', name: 'Empathy', avgScore: 70, scored: 1, insufficient: 1 },
    ]);
    expect((await analytics.summary(ws.id, q({ channel: 'EMBED' }), { role: 'ADMIN', userId: null })).kpis.sessions).toBe(2);
    expect((await analytics.summary(ws.id, q({ teamId: team.id }), { role: 'ADMIN', userId: null })).kpis.sessions).toBe(3);
    // Injection attempts are just values that match nothing.
    const evil = await analytics.summary(ws.id, q({ scenarioId: `x' OR '1'='1` }), { role: 'ADMIN', userId: null });
    expect(evil.kpis.sessions).toBe(0);
    // The other workspace's team id does not leak data.
    const r2 = await analytics.summary(ws2.id, q({ teamId: team.id }), { role: 'ADMIN', userId: null });
    expect(r2.kpis.sessions).toBe(0);
  });

  it('members only see their own data (and no cost), whatever filters they pass', async () => {
    const r = await analytics.summary(ws.id, q(), { role: 'MEMBER', userId: memberUser.id });
    expect(r.scope).toBe('own');
    expect(r.kpis.sessions).toBe(3);
    expect(r.kpis.costMicros).toBeNull();
    expect(r.byLearner.map((l) => l.name)).toEqual(['Member Mo']);
    const other = await prisma.participant.findFirstOrThrow({ where: { workspaceId: ws.id, email: 'evil@example.com' } });
    const r2 = await analytics.summary(ws.id, q({ participantId: other.id }), { role: 'MEMBER', userId: memberUser.id });
    expect(r2.kpis.sessions).toBe(0);
    const stranger = await analytics.summary(ws.id, q(), { role: 'MEMBER', userId: 'no-such-user' });
    expect(stranger.kpis.sessions).toBe(0);
  });

  it("hides scores from learners when the scenario does not let participants see them", async () => {
    const pMember = await prisma.participant.findFirstOrThrow({ where: { workspaceId: ws.id, userId: memberUser.id } });
    const hidden = await session({ sc: scB, participantId: pMember.id, day: 9, score: 5 });
    try {
      const own = await analytics.summary(ws.id, q(), { role: 'MEMBER', userId: memberUser.id });
      expect(own.kpis.sessions).toBe(4);
      expect(own.kpis.avgScore).toBe(70); // 80 & 60 only; the hidden score (5) is not revealed
      expect(own.recentSessions.find((r) => r.id === hidden.id)!.overallScore).toBeNull();
      const admin = await analytics.summary(ws.id, q(), { role: 'ADMIN', userId: null });
      expect(admin.recentSessions.find((r) => r.id === hidden.id)!.overallScore).toBe(5);
    } finally {
      await prisma.session.delete({ where: { id: hidden.id } });
    }
  });

  it('exports one CSV row per session with escaped cells and criterion columns', async () => {
    const { csv, rows } = await analytics.exportCsv(ws.id, q(), { role: 'ADMIN', userId: null });
    expect(rows).toBe(5);
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe(
      'date,session_id,scenario,version,participant,participant_email,teams,channel,state,duration_seconds,overall_score,insufficient_evidence,criterion: Clarity,criterion: Empathy,simulated',
    );
    expect(lines).toHaveLength(6);
    const evilLine = lines.find((l) => l.includes('evil@example.com'))!;
    expect(evilLine).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    const memberLine = lines.find((l) => l.includes('Member Mo') && l.includes(',60,80,'))!;
    expect(memberLine).toContain('"Sales, EMEA"');
    expect(memberLine).toMatch(/,90,70,false$/);
    const simulatedLine = lines.find((l) => l.includes('Member Mo') && l.includes(',60,60,'))!;
    expect(simulatedLine).toMatch(/,50,insufficient evidence,true$/);
    const insufficientLine = lines.find((l) => l.includes('Member Mo') && l.includes(',true,,,'))!;
    expect(insufficientLine).toMatch(/,60,,true,,,false$/);
  });
});

describe('helpers', () => {
  it('escapes formula-like and special cells', () => {
    expect(csvCell('=1+2')).toBe("'=1+2");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"\nthere')).toBe('"say ""hi""\nthere"');
    expect(csvCell(-2)).toBe('-2');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a'], [[1]])).toBe('﻿a\r\n1\r\n');
  });
  it('resolves date ranges (inclusive end day, default 30 days, max 366)', () => {
    const r = resolveRange('2026-09-01', '2026-09-10');
    expect(r.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-09-11T00:00:00.000Z');
    const d = resolveRange(undefined, undefined, new Date('2026-09-30T00:00:00Z'));
    expect(d.from.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    const big = resolveRange('2020-01-01', '2026-01-01');
    expect((big.to.getTime() - big.from.getTime()) / 86_400_000).toBe(366);
    expect(() => resolveRange('2026-09-10', '2026-09-01')).toThrow();
  });
});
