import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CHANNELS, can, type Role } from '@cf/shared';
import { z } from 'zod';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toCsv } from './csv';

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 366;

const DateParam = z
  .string()
  .trim()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');

export const AnalyticsQuery = z.object({
  from: DateParam.optional(),
  to: DateParam.optional(),
  scenarioId: z.string().max(64).optional(),
  teamId: z.string().max(64).optional(),
  channel: z.enum(CHANNELS).optional(),
  participantId: z.string().max(64).optional(),
  top: z.coerce.number().int().min(1).max(50).default(10),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuery>;

export interface AnalyticsViewer {
  role: Role;
  userId: string | null;
}

export interface ResolvedFilters {
  workspaceId: string;
  from: Date;
  to: Date;
  scenarioId: string | null;
  teamId: string | null;
  channel: string | null;
  participantId: string | null;
  /** When set, only sessions of participants linked to this user (members see their own data only). */
  ownUserId: string | null;
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : typeof v === 'bigint' ? Number(v) : Number(v));
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/** Parse the date range: `to` given as a plain date (YYYY-MM-DD) includes that whole day. Default: last 30 days. */
export function resolveRange(from?: string, to?: string, now = new Date()): { from: Date; to: Date } {
  let end = to ? new Date(to) : now;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to.trim())) end = new Date(end.getTime() + DAY);
  let start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY);
  if (start >= end) throw Errors.validation('"from" must be before "to"');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY) start = new Date(end.getTime() - MAX_RANGE_DAYS * DAY);
  return { from: start, to: end };
}

export function resolveFilters(workspaceId: string, q: AnalyticsQuery, viewer: AnalyticsViewer): ResolvedFilters {
  const { from, to } = resolveRange(q.from, q.to);
  const orgWide = can(viewer.role, 'analytics.view');
  if (!orgWide && !viewer.userId) throw Errors.forbidden();
  return {
    workspaceId,
    from,
    to,
    scenarioId: q.scenarioId ?? null,
    teamId: q.teamId ?? null,
    channel: q.channel ?? null,
    participantId: q.participantId ?? null,
    ownUserId: orgWide ? null : viewer.userId,
  };
}

/**
 * Parameterized WHERE clause over "Session" s for the filters. Every value goes through a bound
 * parameter (Prisma.sql); nothing user-provided is concatenated into SQL.
 */
export function sessionWhere(f: ResolvedFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`s."workspaceId" = ${f.workspaceId}`,
    Prisma.sql`s."deletedAt" IS NULL`,
    Prisma.sql`s."createdAt" >= ${f.from}`,
    Prisma.sql`s."createdAt" < ${f.to}`,
  ];
  if (f.scenarioId) parts.push(Prisma.sql`s."scenarioId" = ${f.scenarioId}`);
  if (f.channel) parts.push(Prisma.sql`s."channel" = ${f.channel}::"Channel"`);
  if (f.participantId) parts.push(Prisma.sql`s."participantId" = ${f.participantId}`);
  if (f.teamId) {
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM "TeamMember" tm JOIN "Team" t ON t.id = tm."teamId"
      WHERE tm."participantId" = s."participantId" AND t.id = ${f.teamId} AND t."workspaceId" = ${f.workspaceId})`);
  }
  if (f.ownUserId) {
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM "Participant" op
      WHERE op.id = s."participantId" AND op."workspaceId" = ${f.workspaceId} AND op."userId" = ${f.ownUserId})`);
  }
  return Prisma.join(parts, ' AND ');
}

/**
 * Learners (own-data scope) only get scores the scenario lets participants see — the same rule as the
 * participant report: analysis on, participantCanSeeScores, rubric visible to participants, review done.
 */
const participantScoreVisibility = Prisma.sql`AND COALESCE((sv.config->'analysis'->>'enabled')::boolean, true)
        AND COALESCE((sv.config->'analysis'->>'participantCanSeeScores')::boolean, false)
        AND COALESCE((sv.config->'rubric'->>'enabled')::boolean, true)
        AND sv.config->'rubric'->>'visibility' = 'participant_and_reviewers'
        AND (e."humanReviewRequired" = false OR e."reviewedAt" IS NOT NULL)`;

/** CTE "f": filtered sessions with their current evaluation (if any) and a simulated flag. */
function baseCte(f: ResolvedFilters): Prisma.Sql {
  return Prisma.sql`WITH f AS (
    SELECT s.id, s."createdAt", s.state::text AS state, s."durationMs", s.channel::text AS channel,
           s."scenarioId", s."scenarioVersionId", s."participantId",
           ev.id AS "evaluationId", ev."overallScore", ev."insufficientEvidence",
           (COALESCE((s."providerInfo"->>'simulated')::boolean, false) OR COALESCE(ev.simulated, false)) AS simulated,
           (ev.id IS NOT NULL AND NOT ev."insufficientEvidence" AND ev."overallScore" IS NOT NULL) AS scored
    FROM "Session" s
    LEFT JOIN "ScenarioVersion" sv ON sv.id = s."scenarioVersionId" AND sv."workspaceId" = s."workspaceId"
    LEFT JOIN LATERAL (
      SELECT e.id, e."overallScore", e."insufficientEvidence", e.simulated
      FROM "Evaluation" e
      WHERE e."sessionId" = s.id AND e."workspaceId" = ${f.workspaceId} AND e."isCurrent" = true
        AND e.status IN ('COMPLETED', 'PARTIAL')
        ${f.ownUserId ? participantScoreVisibility : Prisma.empty}
      ORDER BY e."createdAt" DESC LIMIT 1
    ) ev ON true
    WHERE ${sessionWhere(f)}
  )`;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(workspaceId: string, q: AnalyticsQuery, viewer: AnalyticsViewer) {
    const f = resolveFilters(workspaceId, q, viewer);
    const cte = baseCte(f);

    const [kpiRows, stateRows, dailyRows, scenarioRows, learnerRows, teamRows, channelRows, recentRows] = await Promise.all([
      this.prisma.$queryRaw<any[]>`${cte}
        SELECT count(*) AS total,
               count(*) FILTER (WHERE state = 'COMPLETED') AS completed,
               count(*) FILTER (WHERE state IN ('COMPLETED','FAILED','CANCELLED','EXPIRED','ABANDONED')) AS ended,
               COALESCE(sum("durationMs"), 0) AS "totalDurationMs",
               avg("durationMs") AS "avgDurationMs",
               avg("overallScore") FILTER (WHERE scored) AS "avgScore",
               count(*) FILTER (WHERE scored) AS "scoredCount",
               count(*) FILTER (WHERE "insufficientEvidence") AS "insufficientCount",
               count(*) FILTER (WHERE simulated) AS "simulatedCount",
               count(DISTINCT "participantId") AS learners
        FROM f`,
      this.prisma.$queryRaw<any[]>`${cte} SELECT state, count(*) AS count FROM f GROUP BY state ORDER BY count DESC`,
      this.prisma.$queryRaw<any[]>`${cte}
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
               count(*) AS sessions,
               count(*) FILTER (WHERE state = 'COMPLETED') AS completed,
               avg("overallScore") FILTER (WHERE scored) AS "avgScore",
               count(*) FILTER (WHERE scored) AS "scoredCount"
        FROM f GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<any[]>`${cte}
        SELECT f."scenarioId" AS id, sc.name AS name, count(*) AS sessions,
               count(*) FILTER (WHERE f.state = 'COMPLETED') AS completed,
               avg(f."overallScore") FILTER (WHERE f.scored) AS "avgScore",
               avg(f."durationMs") AS "avgDurationMs"
        FROM f JOIN "Scenario" sc ON sc.id = f."scenarioId" AND sc."workspaceId" = ${workspaceId}
        GROUP BY f."scenarioId", sc.name ORDER BY sessions DESC LIMIT 50`,
      this.prisma.$queryRaw<any[]>`${cte}
        SELECT f."participantId" AS id, COALESCE(u.name, p.name, u.email, p.email, 'Anonymous') AS name,
               COALESCE(u.email, p.email) AS email, count(*) AS sessions,
               count(*) FILTER (WHERE f.state = 'COMPLETED') AS completed,
               avg(f."overallScore") FILTER (WHERE f.scored) AS "avgScore"
        FROM f JOIN "Participant" p ON p.id = f."participantId" AND p."workspaceId" = ${workspaceId}
        LEFT JOIN "User" u ON u.id = p."userId"
        GROUP BY f."participantId", u.name, p.name, u.email, p.email
        ORDER BY sessions DESC, name ASC LIMIT ${q.top}`,
      this.prisma.$queryRaw<any[]>`${cte}
        SELECT t.id, t.name, count(*) AS sessions,
               count(*) FILTER (WHERE f.state = 'COMPLETED') AS completed,
               avg(f."overallScore") FILTER (WHERE f.scored) AS "avgScore"
        FROM f JOIN "TeamMember" tm ON tm."participantId" = f."participantId"
        JOIN "Team" t ON t.id = tm."teamId" AND t."workspaceId" = ${workspaceId}
        GROUP BY t.id, t.name ORDER BY sessions DESC LIMIT 50`,
      this.prisma.$queryRaw<any[]>`${cte}
        SELECT channel AS id, count(*) AS sessions,
               count(*) FILTER (WHERE state = 'COMPLETED') AS completed,
               avg("overallScore") FILTER (WHERE scored) AS "avgScore"
        FROM f GROUP BY channel ORDER BY sessions DESC`,
      this.prisma.$queryRaw<any[]>`${cte}
        SELECT f.id, f."createdAt", f.state, f."durationMs", f.channel, f."overallScore", f."insufficientEvidence", f.simulated,
               f."scenarioId", sc.name AS "scenarioName", f."participantId",
               COALESCE(u.name, p.name, u.email, p.email, 'Anonymous') AS "participantName"
        FROM f
        LEFT JOIN "Scenario" sc ON sc.id = f."scenarioId" AND sc."workspaceId" = ${workspaceId}
        LEFT JOIN "Participant" p ON p.id = f."participantId" AND p."workspaceId" = ${workspaceId}
        LEFT JOIN "User" u ON u.id = p."userId"
        ORDER BY f."createdAt" DESC LIMIT 10`,
    ]);

    let rubric: Array<{ criterionId: string; name: string; avgScore: number | null; scored: number; insufficient: number }> | null = null;
    if (f.scenarioId) {
      const rows = await this.prisma.$queryRaw<any[]>`${cte}
        SELECT cs."criterionId" AS "criterionId",
               (array_agg(cs.name ORDER BY cs."createdAt" DESC))[1] AS name,
               avg(cs.score) FILTER (WHERE cs.score IS NOT NULL AND NOT cs."insufficientEvidence") AS "avgScore",
               count(*) FILTER (WHERE cs.score IS NOT NULL AND NOT cs."insufficientEvidence") AS scored,
               count(*) FILTER (WHERE cs."insufficientEvidence") AS insufficient
        FROM f JOIN "CriterionScore" cs ON cs."evaluationId" = f."evaluationId"
        GROUP BY cs."criterionId" ORDER BY name`;
      rubric = rows.map((r) => ({ criterionId: r.criterionId, name: r.name, avgScore: round1(nn(r.avgScore)), scored: n(r.scored), insufficient: n(r.insufficient) }));
    }

    let costMicros: number | null = null;
    if (!f.ownUserId) {
      const narrowed = !!(f.scenarioId || f.teamId || f.channel || f.participantId);
      const cost = narrowed
        ? await this.prisma.$queryRaw<any[]>`${cte}
            SELECT COALESCE(sum(ul."costMicros"), 0) AS cost FROM "UsageLedger" ul
            WHERE ul."workspaceId" = ${workspaceId} AND ul."sessionId" IN (SELECT id FROM f)`
        : await this.prisma.$queryRaw<any[]>`
            SELECT COALESCE(sum(ul."costMicros"), 0) AS cost FROM "UsageLedger" ul
            WHERE ul."workspaceId" = ${workspaceId} AND ul."createdAt" >= ${f.from} AND ul."createdAt" < ${f.to}`;
      costMicros = n(cost[0]?.cost);
    }

    // Filter options for the UI: org scope lists every scenario/team; own scope only the learner's scenarios.
    const [scenarioOptions, teamOptions] = await Promise.all([
      f.ownUserId
        ? this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
            SELECT DISTINCT sc.id, sc.name FROM "Session" s
            JOIN "Scenario" sc ON sc.id = s."scenarioId" AND sc."workspaceId" = ${workspaceId}
            JOIN "Participant" op ON op.id = s."participantId" AND op."userId" = ${f.ownUserId}
            WHERE s."workspaceId" = ${workspaceId} AND s."deletedAt" IS NULL ORDER BY sc.name LIMIT 500`
        : this.prisma.scenario.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
      f.ownUserId ? Promise.resolve([]) : this.prisma.team.findMany({ where: { workspaceId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
    ]);

    const k = kpiRows[0] ?? {};
    const total = n(k.total);
    const ended = n(k.ended);
    const completed = n(k.completed);

    // Fill every day of the range (UTC) so charts have a continuous axis.
    const byDay = new Map(dailyRows.map((r) => [r.day as string, r]));
    const days: Array<{ date: string; sessions: number; completed: number; avgScore: number | null; scored: number }> = [];
    for (let t = Date.UTC(f.from.getUTCFullYear(), f.from.getUTCMonth(), f.from.getUTCDate()); t < f.to.getTime(); t += DAY) {
      const key = new Date(t).toISOString().slice(0, 10);
      const r = byDay.get(key);
      days.push({ date: key, sessions: n(r?.sessions), completed: n(r?.completed), avgScore: round1(nn(r?.avgScore)), scored: n(r?.scoredCount) });
    }

    const breakdown = (rows: any[]) =>
      rows.map((r) => ({
        id: r.id as string,
        name: (r.name ?? r.id) as string,
        ...(r.email !== undefined ? { email: r.email as string | null } : {}),
        sessions: n(r.sessions),
        completed: n(r.completed),
        completionRate: n(r.sessions) ? Math.round((n(r.completed) / n(r.sessions)) * 1000) / 10 : null,
        avgScore: round1(nn(r.avgScore)),
        ...(r.avgDurationMs !== undefined ? { avgDurationMs: nn(r.avgDurationMs) == null ? null : Math.round(n(r.avgDurationMs)) } : {}),
      }));

    return {
      scope: f.ownUserId ? ('own' as const) : ('workspace' as const),
      range: { from: f.from.toISOString(), to: f.to.toISOString() },
      filters: { scenarioId: f.scenarioId, teamId: f.teamId, channel: f.channel, participantId: f.participantId },
      options: { scenarios: scenarioOptions, teams: teamOptions },
      kpis: {
        sessions: total,
        completed,
        // Completion rate among sessions that have ended (in-progress ones are not failures yet).
        completionRate: ended ? Math.round((completed / ended) * 1000) / 10 : null,
        totalDurationMs: n(k.totalDurationMs),
        avgDurationMs: k.avgDurationMs == null ? null : Math.round(n(k.avgDurationMs)),
        avgScore: round1(nn(k.avgScore)),
        scoredSessions: n(k.scoredCount),
        insufficientEvidence: n(k.insufficientCount),
        simulatedSessions: n(k.simulatedCount),
        simulatedShare: total ? Math.round((n(k.simulatedCount) / total) * 1000) / 10 : null,
        learners: n(k.learners),
        costMicros,
      },
      byState: stateRows.map((r) => ({ state: r.state as string, count: n(r.count) })),
      daily: days,
      rubric,
      byScenario: breakdown(scenarioRows),
      byLearner: breakdown(learnerRows),
      byTeam: breakdown(teamRows),
      byChannel: breakdown(channelRows),
      recentSessions: recentRows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        state: r.state,
        durationMs: nn(r.durationMs),
        channel: r.channel,
        overallScore: round1(nn(r.overallScore)),
        insufficientEvidence: !!r.insufficientEvidence,
        simulated: !!r.simulated,
        scenario: { id: r.scenarioId, name: r.scenarioName },
        participant: { id: r.participantId, name: r.participantName },
      })),
    };
  }

  /** One CSV row per session with the same filters as the summary. */
  async exportCsv(workspaceId: string, q: AnalyticsQuery, viewer: AnalyticsViewer): Promise<{ csv: string; rows: number }> {
    const f = resolveFilters(workspaceId, q, viewer);
    const cte = baseCte(f);
    const rows = await this.prisma.$queryRaw<any[]>`${cte}
      SELECT f.id, f."createdAt", f.state, f."durationMs", f.channel, f."overallScore", f."insufficientEvidence", f.simulated,
             f."evaluationId", sc.name AS "scenarioName", sv.version AS "versionNumber",
             COALESCE(u.name, p.name) AS "participantName", COALESCE(u.email, p.email) AS "participantEmail",
             (SELECT string_agg(t.name, '; ' ORDER BY t.name) FROM "TeamMember" tm JOIN "Team" t ON t.id = tm."teamId"
               WHERE tm."participantId" = f."participantId" AND t."workspaceId" = ${workspaceId}) AS teams
      FROM f
      LEFT JOIN "Scenario" sc ON sc.id = f."scenarioId" AND sc."workspaceId" = ${workspaceId}
      LEFT JOIN "ScenarioVersion" sv ON sv.id = f."scenarioVersionId" AND sv."workspaceId" = ${workspaceId}
      LEFT JOIN "Participant" p ON p.id = f."participantId" AND p."workspaceId" = ${workspaceId}
      LEFT JOIN "User" u ON u.id = p."userId"
      ORDER BY f."createdAt" ASC
      LIMIT 50000`;
    const evalIds = rows.map((r) => r.evaluationId).filter(Boolean) as string[];
    const criteria: Array<{ evaluationId: string; criterionId: string; name: string; score: number | null; insufficientEvidence: boolean }> = [];
    for (let i = 0; i < evalIds.length; i += 5000) {
      criteria.push(
        ...(await this.prisma.criterionScore.findMany({
          where: { evaluationId: { in: evalIds.slice(i, i + 5000) }, evaluation: { workspaceId } },
          select: { evaluationId: true, criterionId: true, name: true, score: true, insufficientEvidence: true },
        })),
      );
    }
    // Criterion columns: one per distinct criterion name (capped); beyond that they are packed in one column.
    const names = [...new Set(criteria.map((c) => c.name))].sort();
    const perColumn = names.length <= 40;
    const byEval = new Map<string, typeof criteria>();
    for (const c of criteria) byEval.set(c.evaluationId, [...(byEval.get(c.evaluationId) ?? []), c]);

    const header = [
      'date',
      'session_id',
      'scenario',
      'version',
      'participant',
      'participant_email',
      'teams',
      'channel',
      'state',
      'duration_seconds',
      'overall_score',
      'insufficient_evidence',
      ...(perColumn ? names.map((nm) => `criterion: ${nm}`) : ['criteria']),
      'simulated',
    ];
    const out = rows.map((r) => {
      const cs = r.evaluationId ? byEval.get(r.evaluationId) ?? [] : [];
      const scoreOf = (c: (typeof criteria)[number]) => (c.insufficientEvidence || c.score == null ? 'insufficient evidence' : Math.round(c.score * 10) / 10);
      const critCols = perColumn
        ? names.map((nm) => {
            const c = cs.find((x) => x.name === nm);
            return c ? scoreOf(c) : null;
          })
        : [cs.map((c) => `${c.name}: ${scoreOf(c)}`).join('; ')];
      return [
        new Date(r.createdAt).toISOString(),
        r.id,
        r.scenarioName,
        r.versionNumber == null ? null : Number(r.versionNumber),
        r.participantName,
        r.participantEmail,
        r.teams,
        r.channel,
        r.state,
        r.durationMs == null ? null : Math.round(Number(r.durationMs) / 1000),
        r.overallScore == null ? null : Math.round(Number(r.overallScore) * 10) / 10,
        !!r.insufficientEvidence,
        ...critCols,
        !!r.simulated,
      ];
    });
    return { csv: toCsv(header, out), rows: out.length };
  }
}
