import { z } from 'zod';

/**
 * Pure course/progress rules (no I/O) so the critical invariants are unit-testable:
 *  - progress counts ONLY attempts in the enrollment's current generation;
 *  - a new enrollment has no attempts → 0%;
 *  - forced order locks an item while any earlier *required* item is incomplete.
 */

export const COURSE_ITEM_KINDS = ['SCENARIO', 'VIDEO', 'DOCUMENT', 'LINK'] as const;
export type CourseItemKindT = (typeof COURSE_ITEM_KINDS)[number];

export const CompletionRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session_completed') }),
  z.object({ type: z.literal('min_score'), minScore: z.number().min(0).max(100) }),
  z.object({ type: z.literal('viewed') }),
  z.object({ type: z.literal('manual') }),
]);
export type CompletionRule = z.infer<typeof CompletionRuleSchema>;

export function defaultRuleFor(kind: CourseItemKindT): CompletionRule {
  return kind === 'SCENARIO' ? { type: 'session_completed' } : { type: 'viewed' };
}

/** Which rules make sense for which kind of item. */
export function ruleAllowedFor(kind: CourseItemKindT, rule: CompletionRule): boolean {
  if (kind === 'SCENARIO') return rule.type === 'session_completed' || rule.type === 'min_score' || rule.type === 'manual';
  return rule.type === 'viewed' || rule.type === 'manual';
}

/** Parse the stored JSON rule, falling back to the kind's default for empty/invalid values. */
export function parseRule(kind: CourseItemKindT, raw: unknown): CompletionRule {
  const r = CompletionRuleSchema.safeParse(raw);
  if (r.success && ruleAllowedFor(kind, r.data)) return r.data;
  return defaultRuleFor(kind);
}

export type AttemptStatus = 'STARTED' | 'COMPLETED' | 'FAILED';
export type ItemStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface RuleItem {
  id: string;
  position: number;
  required: boolean;
}
export interface RuleAttempt {
  courseItemId: string;
  generation: number;
  status: string;
  startedAt: Date;
  completedAt?: Date | null;
}

/** Status of one item for a given generation (attempts from other generations are ignored). */
export function itemStatus(itemId: string, attempts: RuleAttempt[], generation: number): ItemStatus {
  const mine = attempts.filter((a) => a.courseItemId === itemId && a.generation === generation);
  if (!mine.length) return 'NOT_STARTED';
  if (mine.some((a) => a.status === 'COMPLETED')) return 'COMPLETED';
  const latest = [...mine].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]!;
  return latest.status === 'FAILED' ? 'FAILED' : 'IN_PROGRESS';
}

export interface ProgressResult {
  completedRequired: number;
  totalRequired: number;
  /** 0..100, integer. */
  percent: number;
  /** All counted items complete (and there is at least one). */
  complete: boolean;
  statuses: Record<string, ItemStatus>;
  locked: Record<string, boolean>;
  /** First incomplete item respecting order (required items first when forced), or null when done. */
  nextItemId: string | null;
}

export function computeProgress(
  items: RuleItem[],
  attempts: RuleAttempt[],
  generation: number,
  forcedOrder: boolean,
): ProgressResult {
  const ordered = [...items].sort((a, b) => a.position - b.position);
  const statuses: Record<string, ItemStatus> = {};
  for (const it of ordered) statuses[it.id] = itemStatus(it.id, attempts, generation);

  // Items that count toward progress: required ones; if the course has none marked required, all items.
  const counted = ordered.some((i) => i.required) ? ordered.filter((i) => i.required) : ordered;
  const completedRequired = counted.filter((i) => statuses[i.id] === 'COMPLETED').length;
  const totalRequired = counted.length;
  const percent = totalRequired === 0 ? 0 : Math.floor((completedRequired / totalRequired) * 100);

  const locked: Record<string, boolean> = {};
  let blocked = false;
  for (const it of ordered) {
    locked[it.id] = forcedOrder && blocked;
    if (it.required && statuses[it.id] !== 'COMPLETED') blocked = true;
  }

  // Continue → first incomplete counted item in order; once those are done, the first incomplete optional one.
  const firstIncomplete = (list: RuleItem[]) => list.find((i) => statuses[i.id] !== 'COMPLETED' && !locked[i.id]);
  const next = firstIncomplete(counted) ?? firstIncomplete(ordered);

  return {
    completedRequired,
    totalRequired,
    percent,
    complete: totalRequired > 0 && completedRequired === totalRequired,
    statuses,
    locked,
    nextItemId: next?.id ?? null,
  };
}

/** Is `itemId` locked by forced order (some earlier required item incomplete in this generation)? */
export function isLocked(items: RuleItem[], attempts: RuleAttempt[], generation: number, forcedOrder: boolean, itemId: string) {
  return computeProgress(items, attempts, generation, forcedOrder).locked[itemId] ?? false;
}

export type AttemptDecision = { status: AttemptStatus; reason: string | null; score?: number | null; evaluationId?: string | null };

/**
 * Decide an attempt's status from the session's terminal state and (for min_score) its current evaluation.
 * Deterministic from source-of-truth rows, so replaying events is harmless.
 */
export function decideAttempt(input: {
  rule: CompletionRule;
  sessionState: string;
  analysisSkipped: boolean;
  evaluation: { id: string; status: string; overallScore: number | null; insufficientEvidence: boolean } | null;
}): AttemptDecision {
  const { rule, sessionState, evaluation } = input;
  const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED'];
  if (!TERMINAL.includes(sessionState)) return { status: 'STARTED', reason: null };
  if (sessionState !== 'COMPLETED') {
    return { status: 'FAILED', reason: `The session ended as ${sessionState.toLowerCase()} — you can try again.` };
  }
  switch (rule.type) {
    case 'session_completed':
      return { status: 'COMPLETED', reason: null, score: evaluation?.overallScore ?? null, evaluationId: evaluation?.id ?? null };
    case 'viewed':
      return { status: 'COMPLETED', reason: null };
    case 'manual':
      return { status: 'STARTED', reason: 'Waiting for a reviewer to mark this item complete.' };
    case 'min_score': {
      if (input.analysisSkipped) {
        return { status: 'FAILED', reason: 'This item needs a score, but scoring was not performed for the session (analysis disabled or declined).' };
      }
      if (!evaluation || !['COMPLETED', 'PARTIAL'].includes(evaluation.status)) {
        if (evaluation && evaluation.status === 'FAILED') {
          return { status: 'FAILED', reason: 'Scoring failed for this session — you can try again.', evaluationId: evaluation.id };
        }
        return { status: 'STARTED', reason: 'Waiting for scoring…' };
      }
      if (evaluation.insufficientEvidence || evaluation.overallScore == null) {
        return {
          status: 'FAILED',
          reason: 'Not enough evidence in the conversation to score it — try again and cover the topics in more depth.',
          score: evaluation.overallScore,
          evaluationId: evaluation.id,
        };
      }
      if (evaluation.overallScore < rule.minScore) {
        return {
          status: 'FAILED',
          reason: `Score ${Math.round(evaluation.overallScore)} is below the required ${rule.minScore}.`,
          score: evaluation.overallScore,
          evaluationId: evaluation.id,
        };
      }
      return { status: 'COMPLETED', reason: null, score: evaluation.overallScore, evaluationId: evaluation.id };
    }
  }
}

/** https-only URL check (no credentials, no localhost/private literal hosts). */
export function isSafeHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  if (host.startsWith('[')) return false; // IPv6 literals — not needed for course content
  return true;
}
