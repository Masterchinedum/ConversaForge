import type { RubricCriterion } from './scenario-config';

/**
 * Deterministic score arithmetic. The model supplies per-criterion judgments (0-100 or "insufficient
 * evidence"); all weighting happens here, in code, never in the model.
 */

export interface CriterionJudgment {
  criterionId: string;
  /** 0..100, or null when there is not enough evidence in the transcript. */
  score: number | null;
  confidence?: number | null;
}

export interface WeightedResult {
  /** Weighted mean over criteria with evidence, re-normalized by their weights; null if below coverage. */
  overallScore: number | null;
  /** Share (0..1) of total rubric weight that had evidence. */
  coverage: number;
  insufficientEvidence: boolean;
  perCriterion: Array<{ criterionId: string; weight: number; normalizedWeight: number; score: number | null }>;
  passed: boolean | null;
}

export function clampScore(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

export function computeWeightedScore(
  criteria: Pick<RubricCriterion, 'id' | 'weight'>[],
  judgments: CriterionJudgment[],
  opts: { minEvidenceCoverage?: number; passingScore?: number } = {},
): WeightedResult {
  const minCoverage = opts.minEvidenceCoverage ?? 0.6;
  const totalWeight = criteria.reduce((s, c) => s + Math.max(0, c.weight), 0);
  const byId = new Map(judgments.map((j) => [j.criterionId, j]));

  let evidencedWeight = 0;
  let weightedSum = 0;
  const perCriterion = criteria.map((c) => {
    const w = Math.max(0, c.weight);
    const score = clampScore(byId.get(c.id)?.score ?? null);
    if (score !== null) {
      evidencedWeight += w;
      weightedSum += w * score;
    }
    return { criterionId: c.id, weight: w, normalizedWeight: totalWeight > 0 ? w / totalWeight : 0, score };
  });

  const coverage = totalWeight > 0 ? evidencedWeight / totalWeight : 0;
  const insufficientEvidence = totalWeight === 0 || evidencedWeight === 0 || coverage + 1e-9 < minCoverage;
  const overallScore = insufficientEvidence ? null : round1(weightedSum / evidencedWeight);
  const passed =
    overallScore === null || opts.passingScore === undefined ? null : overallScore >= opts.passingScore;
  return { overallScore, coverage: round4(coverage), insufficientEvidence, perCriterion, passed };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

/** Rescale weights so they sum to exactly 100 (used by the editor's "normalize" button). */
export function normalizeWeights<T extends { weight: number }>(items: T[]): T[] {
  const sum = items.reduce((s, i) => s + Math.max(0, i.weight), 0);
  if (sum <= 0) {
    const even = items.length ? Math.floor((100 / items.length) * 100) / 100 : 0;
    return fixRounding(items.map((i) => ({ ...i, weight: even })));
  }
  return fixRounding(items.map((i) => ({ ...i, weight: Math.round((Math.max(0, i.weight) / sum) * 10000) / 100 })));
}

function fixRounding<T extends { weight: number }>(items: T[]): T[] {
  if (!items.length) return items;
  const sum = items.reduce((s, i) => s + i.weight, 0);
  const diff = Math.round((100 - sum) * 100) / 100;
  if (diff !== 0) {
    const last = items[items.length - 1]!;
    items[items.length - 1] = { ...last, weight: Math.round((last.weight + diff) * 100) / 100 };
  }
  return items;
}
