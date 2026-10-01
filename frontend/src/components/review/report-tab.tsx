'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, SimulatedBadge, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { OverallScore, ProcessingBadge, ScoreBar, isProcessing } from './score';
import type { SessionDetail } from './types';

function TurnLink({ seq, onJump, children }: { seq: number; onJump: (seq: number) => void; children?: React.ReactNode }) {
  return (
    <a
      href={`#turn-${seq}`}
      onClick={(e) => {
        e.preventDefault();
        onJump(seq);
      }}
      className="font-medium text-brand-700 hover:underline"
    >
      {children ?? `Turn ${seq}`}
    </a>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items?.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

export function ReportTab({
  d,
  onJump,
  onChanged,
  wsPath,
}: {
  d: SessionDetail;
  onJump: (seq: number) => void;
  onChanged: () => void;
  wsPath: (p: string) => string;
}) {
  const ev = d.evaluation;
  const toast = useToast();
  const [signOff, setSignOff] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  if (!ev) {
    return (
      <EmptyState
        title={isProcessing(d.processing.status) ? 'Analysis in progress…' : 'No evaluation'}
        description={
          isProcessing(d.processing.status)
            ? 'Scores and feedback appear here automatically when processing finishes.'
            : d.processing.status === 'SKIPPED'
              ? d.session.analysisError ?? 'This session was not analyzed.'
              : !d.rubric.enabled
                ? 'This scenario version has no rubric, so there is nothing to score.'
                : d.processing.error ?? 'See the Processing tab for details.'
        }
      />
    );
  }

  const submitReview = async () => {
    setSaving(true);
    try {
      await api(wsPath(`/sessions/${d.session.id}/review`), { method: 'POST', body: { note } });
      toast.success('Review recorded');
      setSignOff(false);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {ev.simulated && (
        <Alert tone="warning" title="Simulated analysis">
          No AI provider is configured, so this evaluation was produced by the local development simulator — a deterministic keyword heuristic that
          only quotes real transcript text. Do not use it for decisions. Configure a provider and reprocess for a real assessment.
        </Alert>
      )}
      {ev.humanReviewRequired &&
        (ev.reviewedAt ? (
          <Alert tone="success" title="Human review completed">
            Signed off {formatDate(ev.reviewedAt)}
            {ev.reviewedBy ? ` by ${ev.reviewedBy.name ?? ev.reviewedBy.email}` : ''}.{ev.reviewNote ? ` Note: “${ev.reviewNote}”` : ''}
          </Alert>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900" role="status">
            <div>
              <p className="font-medium">Advisory result — human review required</p>
              <p>This assessment must be checked by a reviewer against the transcript evidence before it informs any decision.</p>
            </div>
            <Button onClick={() => setSignOff(true)}>Sign off review</Button>
          </div>
        ))}
      {d.processing.status === 'PARTIAL' && (
        <Alert tone="warning" title="Some processing steps failed">
          {d.processing.error} — see the Processing tab to retry.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Overall" className="lg:col-span-1">
          <OverallScore
            score={ev.overallScore}
            coverage={ev.coverage}
            passed={ev.passed}
            passingScore={d.rubric.passingScore}
            minCoverage={d.rubric.minEvidenceCoverage}
          />
          <p className="mt-3 text-xs text-slate-500">
            Evaluated subject: {d.rubric.evaluatedSubject}. {ev.simulated ? 'Local simulator' : `${ev.provider ?? ''} · ${ev.model ?? ''}`} · {ev.promptVersion}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            <ProcessingBadge status={d.processing.status} />
            {ev.simulated && <SimulatedBadge />}
          </div>
        </Card>
        <Card title="Summary" className="lg:col-span-2">
          <p className="whitespace-pre-line text-sm text-slate-800">{ev.summary || '—'}</p>
        </Card>
      </div>

      <section aria-labelledby="criteria-h">
        <h2 id="criteria-h" className="mb-2 text-sm font-semibold text-slate-900">
          Criteria
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          {ev.criteria.map((c) => (
            <article key={c.criterionId} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <header className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{c.name}</h3>
                  {c.description && <p className="text-xs text-slate-500">{c.description}</p>}
                </div>
                <Badge tone="gray" title="Weight in the overall score">
                  {c.weight}%
                </Badge>
              </header>
              <ScoreBar score={c.score} label={`${c.name} score`} />
              {c.score === null && <p className="mt-1 text-xs font-medium text-amber-800">Not enough evidence to score</p>}
              <p className="mt-1 text-xs text-slate-500">Confidence: {c.confidence == null ? '—' : `${Math.round(c.confidence * 100)}%`}</p>
              {c.rationale && <p className="mt-2 text-sm text-slate-700">{c.rationale}</p>}
              {c.evidence.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {c.evidence.map((e, i) => (
                    <li key={i} className="border-l-2 border-brand-500 pl-2 text-sm text-slate-700">
                      <TurnLink seq={e.turnSeq} onJump={onJump} />: “{e.quote}”
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Strengths">
          <List items={ev.strengths} empty="None noted." />
        </Card>
        <Card title="Areas to improve">
          <List items={ev.weaknesses} empty="None noted." />
        </Card>
        <Card title="Practical next steps">
          <List items={ev.improvements} empty="None noted." />
        </Card>
      </div>

      {ev.notes?.length > 0 && (
        <Card title="Notes">
          <ul className="space-y-1 text-sm text-slate-700">
            {ev.notes.map((n, i) => (
              <li key={i}>
                {n.text}{' '}
                {n.turnSeqs.map((s) => (
                  <span key={s} className="mr-1">
                    <TurnLink seq={s} onJump={onJump}>
                      #{s}
                    </TurnLink>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.evaluationHistory.length > 1 && (
        <Card title="Evaluation history">
          <ul className="space-y-1 text-sm">
            {d.evaluationHistory.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Run {h.generation}</span>
                <span className="tabular-nums">{h.overallScore == null ? 'insufficient evidence' : Math.round(h.overallScore)}</span>
                <span className="text-xs text-slate-500">{formatDate(h.createdAt)}</span>
                {h.simulated && <SimulatedBadge />}
                {h.isCurrent && <Badge tone="green">current</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={signOff}
        onClose={() => setSignOff(false)}
        title="Sign off human review"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSignOff(false)}>
              Cancel
            </Button>
            <Button loading={saving} onClick={submitReview}>
              Sign off
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-600">Confirm you have checked the scores against the transcript evidence. Your name and the time are recorded.</p>
        <Field label="Reviewer note (optional)" hint="Visible to reviewers only, never to the participant.">
          {(id) => <Textarea id={id} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </Modal>
    </div>
  );
}
