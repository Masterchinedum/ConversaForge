export interface Breakdown {
  id: string;
  name: string;
  email?: string | null;
  sessions: number;
  completed: number;
  completionRate: number | null;
  avgScore: number | null;
  avgDurationMs?: number | null;
}

export interface AnalyticsSummary {
  scope: 'own' | 'workspace';
  range: { from: string; to: string };
  filters: { scenarioId: string | null; teamId: string | null; channel: string | null; participantId: string | null };
  options: { scenarios: Array<{ id: string; name: string }>; teams: Array<{ id: string; name: string }> };
  kpis: {
    sessions: number;
    completed: number;
    completionRate: number | null;
    totalDurationMs: number;
    avgDurationMs: number | null;
    avgScore: number | null;
    scoredSessions: number;
    insufficientEvidence: number;
    simulatedSessions: number;
    simulatedShare: number | null;
    learners: number;
    costMicros: number | null;
  };
  byState: Array<{ state: string; count: number }>;
  daily: Array<{ date: string; sessions: number; completed: number; avgScore: number | null; scored: number }>;
  rubric: Array<{ criterionId: string; name: string; avgScore: number | null; scored: number; insufficient: number }> | null;
  byScenario: Breakdown[];
  byLearner: Breakdown[];
  byTeam: Breakdown[];
  byChannel: Breakdown[];
  recentSessions: Array<{
    id: string;
    createdAt: string;
    state: string;
    durationMs: number | null;
    channel: string;
    overallScore: number | null;
    insufficientEvidence: boolean;
    simulated: boolean;
    scenario: { id: string; name: string | null };
    participant: { id: string; name: string };
  }>;
}

export function formatHours(ms: number) {
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)} h`;
  return `${Math.round(ms / 60_000)} min`;
}
