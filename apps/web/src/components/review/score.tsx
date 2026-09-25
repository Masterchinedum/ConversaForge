'use client';
import { Badge, clsx } from '@/components/ui';
import type { ProcessingStatus } from './types';

export const INSUFFICIENT_LABEL = 'Not enough evidence to score';

function tone(score: number) {
  if (score >= 75) return 'bg-emerald-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

/** Horizontal 0-100 bar; renders an explicit "insufficient evidence" state instead of a number. */
export function ScoreBar({ score, label }: { score: number | null; label?: string }) {
  if (score === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <div className="h-2 w-full rounded-full border border-dashed border-slate-300 bg-slate-50" aria-hidden />
        <span className="whitespace-nowrap">Insufficient evidence</span>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={label ?? 'Score'}
      >
        <div className={clsx('h-full rounded-full', tone(pct))} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right text-sm font-semibold tabular-nums text-slate-900">{Math.round(pct)}</span>
    </div>
  );
}

/** Overall score with uncertainty wording (coverage of rubric weight, pass mark). */
export function OverallScore({
  score,
  coverage,
  passed,
  passingScore,
  minCoverage,
  compact,
}: {
  score: number | null;
  coverage?: number | null;
  passed?: boolean | null;
  passingScore?: number | null;
  minCoverage?: number | null;
  compact?: boolean;
}) {
  const cov = coverage == null ? null : Math.round(coverage * 100);
  if (score === null) {
    return (
      <div>
        <p className={clsx('font-semibold text-amber-800', compact ? 'text-base' : 'text-2xl')}>{INSUFFICIENT_LABEL}</p>
        {!compact && (
          <p className="mt-1 text-sm text-slate-600">
            The conversation contained evidence for {cov ?? 0}% of the rubric weight
            {minCoverage != null ? `; at least ${Math.round(minCoverage * 100)}% is needed for an overall score` : ''}. No number is shown rather than a guess.
          </p>
        )}
      </div>
    );
  }
  return (
    <div>
      <p className={clsx('font-bold tabular-nums text-slate-900', compact ? 'text-xl' : 'text-4xl')}>
        {Math.round(score)}
        <span className="text-base font-medium text-slate-400"> / 100</span>
      </p>
      {!compact && (
        <p className="mt-1 text-sm text-slate-600">
          Weighted across criteria with enough evidence{cov != null ? ` (${cov}% of rubric weight)` : ''}.
          {cov != null && cov < 100 && ' Criteria without evidence are excluded, which adds uncertainty.'}
          {passed != null && passingScore != null && (
            <span className={clsx('ml-1 font-medium', passed ? 'text-emerald-700' : 'text-red-700')}>
              {passed ? `Meets the pass mark of ${passingScore}.` : `Below the pass mark of ${passingScore}.`}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

const STATUS_TONE: Record<ProcessingStatus, 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple'> = {
  NOT_STARTED: 'gray',
  QUEUED: 'blue',
  PROCESSING: 'blue',
  COMPLETED: 'green',
  PARTIAL: 'yellow',
  FAILED: 'red',
  SKIPPED: 'gray',
};
const STATUS_LABEL: Record<ProcessingStatus, string> = {
  NOT_STARTED: 'Not started',
  QUEUED: 'Queued',
  PROCESSING: 'Processing…',
  COMPLETED: 'Analyzed',
  PARTIAL: 'Partially analyzed',
  FAILED: 'Analysis failed',
  SKIPPED: 'Not analyzed',
};

const STEP_LABEL: Record<ProcessingStatus, string> = {
  NOT_STARTED: 'Not started',
  QUEUED: 'Queued',
  PROCESSING: 'Running…',
  COMPLETED: 'Done',
  PARTIAL: 'Partial',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
};

export function ProcessingBadge({ status, title, step }: { status: ProcessingStatus; title?: string | null; step?: boolean }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'gray'} title={title ?? undefined}>
      {(step ? STEP_LABEL : STATUS_LABEL)[status] ?? status}
    </Badge>
  );
}

const STATE_TONE: Record<string, 'gray' | 'blue' | 'green' | 'yellow' | 'red'> = {
  COMPLETED: 'green',
  FAILED: 'red',
  ABANDONED: 'yellow',
  CANCELLED: 'gray',
  EXPIRED: 'gray',
  ACTIVE: 'blue',
};
export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? 'gray'}>{state.charAt(0) + state.slice(1).toLowerCase()}</Badge>;
}

export function isProcessing(status: ProcessingStatus | undefined | null) {
  return status === 'QUEUED' || status === 'PROCESSING';
}

export function mmss(ms: number | null | undefined) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
