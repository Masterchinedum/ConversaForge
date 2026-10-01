/**
 * Turns a model's (or the simulator's) raw rubric judgment into a trustworthy evaluation:
 * validates shape, verifies every evidence quote against the transcript, downgrades unsupported scores
 * to "insufficient evidence", redacts protected-trait mentions and computes the weighted overall score
 * IN CODE with @cf/shared computeWeightedScore (the model never does arithmetic).
 */
import { clampScore, computeWeightedScore, type Rubric, type WeightedResult } from '@cf/shared';
import { z } from 'zod';
import { redactProtected, verifyEvidence, type EvidenceItem, type SpeakerKind, type TurnLike } from './evidence';

const RawCriterion = z
  .object({
    criterionId: z.string(),
    score: z.union([z.number(), z.string(), z.null()]).optional(),
    insufficientEvidence: z.boolean().optional(),
    confidence: z.union([z.number(), z.string(), z.null()]).optional(),
    rationale: z.string().optional().nullable(),
    evidence: z.array(z.unknown()).optional().nullable(),
  })
  .passthrough();

const RawEvaluation = z
  .object({
    criteria: z.array(RawCriterion).default([]),
    summary: z.string().optional().nullable(),
    strengths: z.array(z.unknown()).optional().nullable(),
    weaknesses: z.array(z.unknown()).optional().nullable(),
    improvements: z.array(z.unknown()).optional().nullable(),
    notes: z.array(z.unknown()).optional().nullable(),
  })
  .passthrough();

export interface ProcessedCriterion {
  criterionId: string;
  name: string;
  weight: number;
  score: number | null;
  insufficientEvidence: boolean;
  confidence: number | null;
  rationale: string;
  evidence: EvidenceItem[];
  droppedEvidence: number;
}

export interface ProcessedEvaluation {
  criteria: ProcessedCriterion[];
  weighted: WeightedResult;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
  notes: Array<{ text: string; turnSeqs: number[] }>;
  stats: { droppedEvidence: number; downgradedCriteria: number; redactedSentences: number; missingCriteria: number };
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function strList(v: unknown, max = 8, maxLen = 600): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : typeof (x as any)?.text === 'string' ? (x as any).text : ''))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((s) => (s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s));
}

export function processEvaluation(
  raw: unknown,
  rubric: Pick<Rubric, 'criteria' | 'minEvidenceCoverage' | 'passingScore' | 'evaluatedSubject'>,
  turns: TurnLike[],
  subject: SpeakerKind | null,
): ProcessedEvaluation {
  const parsed = RawEvaluation.safeParse(raw);
  if (!parsed.success) throw new Error('Analysis output did not match the expected structure');
  const r = parsed.data;
  const turnsBySeq = new Map(turns.map((t) => [t.seq, t]));
  const byId = new Map(r.criteria.map((c) => [c.criterionId, c]));
  let redactedSentences = 0;
  const clean = (s: string) => {
    const out = redactProtected(s);
    redactedSentences += out.removed;
    return out.text;
  };

  let droppedTotal = 0;
  let downgraded = 0;
  let missing = 0;
  const criteria: ProcessedCriterion[] = rubric.criteria.map((c) => {
    const j = byId.get(c.id);
    if (!j) {
      missing++;
      return {
        criterionId: c.id,
        name: c.name,
        weight: c.weight,
        score: null,
        insufficientEvidence: true,
        confidence: null,
        rationale: 'The analysis did not return a judgment for this criterion.',
        evidence: [],
        droppedEvidence: 0,
      };
    }
    const { kept, dropped } = verifyEvidence(j.evidence ?? [], turnsBySeq, subject);
    droppedTotal += dropped.length;
    let score = j.insufficientEvidence ? null : clampScore(num(j.score));
    let insufficient = score === null;
    let rationale = clean((j.rationale ?? '').trim()).slice(0, 3000);
    if (score !== null && kept.length === 0) {
      // A score with no verifiable evidence is not trustworthy → insufficient evidence.
      score = null;
      insufficient = true;
      downgraded++;
      rationale = `${rationale ? `${rationale} ` : ''}(Score withheld: none of the cited evidence could be verified in the transcript.)`.trim();
    }
    const conf = num(j.confidence);
    return {
      criterionId: c.id,
      name: c.name,
      weight: c.weight,
      score: score === null ? null : Math.round(score * 10) / 10,
      insufficientEvidence: insufficient,
      confidence: conf === null ? null : Math.max(0, Math.min(1, conf)),
      rationale,
      evidence: kept,
      droppedEvidence: dropped.length,
    };
  });

  const weighted = computeWeightedScore(
    rubric.criteria.map((c) => ({ id: c.id, weight: c.weight })),
    criteria.map((c) => ({ criterionId: c.criterionId, score: c.score, confidence: c.confidence })),
    { minEvidenceCoverage: rubric.minEvidenceCoverage, passingScore: rubric.passingScore },
  );

  const notes = (Array.isArray(r.notes) ? r.notes : [])
    .map((n: any) => ({
      text: clean(typeof n?.text === 'string' ? n.text.trim() : '').slice(0, 1000),
      turnSeqs: (Array.isArray(n?.turnSeqs) ? n.turnSeqs : []).map(Number).filter((s: number) => turnsBySeq.has(s)).slice(0, 10),
    }))
    .filter((n) => n.text)
    .slice(0, 10);

  return {
    criteria,
    weighted,
    summary: clean((r.summary ?? '').trim()).slice(0, 4000),
    strengths: strList(r.strengths).map(clean).filter(Boolean),
    weaknesses: strList(r.weaknesses).map(clean).filter(Boolean),
    improvements: strList(r.improvements).map(clean).filter(Boolean),
    notes,
    stats: { droppedEvidence: droppedTotal, downgradedCriteria: downgraded, redactedSentences, missingCriteria: missing },
  };
}
