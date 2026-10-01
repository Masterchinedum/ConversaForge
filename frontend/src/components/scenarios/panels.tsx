'use client';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import YAML from 'yaml';
import { parseScenarioConfig, type FieldChange, type ScenarioConfig, type ValidationIssue } from '@cf/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Alert, Badge, Button, Card, Checkbox, ConfirmButton, Loading, Modal, Select, SimulatedBadge, Textarea, clsx, useToast } from '@/components/ui';
import { focusField } from './editor-context';
import type { DiffResponse, Proposal, ScenarioDetail, VersionRow } from './types';

// ───────────────────────────── value rendering ─────────────────────────────

export function renderValue(v: unknown): string {
  if (v === undefined) return '(empty)';
  if (typeof v === 'string') return v || '(empty)';
  return YAML.stringify(v, { lineWidth: 0 }).trim() || '(empty)';
}

export function ChangeRow({ change, children }: { change: FieldChange; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5">
        <code className="text-xs font-semibold text-slate-700">{change.path}</code>
        {children}
      </div>
      {change.reason && <p className="px-3 pt-2 text-xs italic text-slate-600">{change.reason}</p>}
      <div className="grid gap-2 p-3 text-xs sm:grid-cols-2">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-red-900" aria-label="Before">
          {renderValue(change.before)}
        </pre>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-emerald-50 p-2 text-emerald-900" aria-label="After">
          {renderValue(change.after)}
        </pre>
      </div>
    </div>
  );
}

// ───────────────────────────── Validation ─────────────────────────────

export function ValidationPanel({ issues, onGoto }: { issues: ValidationIssue[]; onGoto?: (path: string) => void }) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return (
    <div aria-live="polite" className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Badge tone={errors.length ? 'red' : 'green'}>{errors.length} error{errors.length === 1 ? '' : 's'}</Badge>
        <Badge tone={warnings.length ? 'yellow' : 'gray'}>{warnings.length} warning{warnings.length === 1 ? '' : 's'}</Badge>
      </div>
      {!issues.length && <p className="text-sm text-emerald-700">Ready to publish.</p>}
      <ul className="max-h-80 space-y-1 overflow-y-auto">
        {[...errors, ...warnings].map((i, k) => (
          <li key={k}>
            <button
              type="button"
              className={clsx('w-full rounded px-2 py-1 text-left text-xs hover:bg-slate-100', i.severity === 'error' ? 'text-red-700' : 'text-amber-800')}
              onClick={() => (onGoto ? onGoto(i.path) : focusField(i.path))}
            >
              <span className="font-mono">{i.path || 'config'}</span> — {i.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────── YAML / JSON editor ─────────────────────────────

export function YamlEditor({ config, readOnly, onApply }: { config: ScenarioConfig; readOnly: boolean; onApply: (c: ScenarioConfig) => Promise<void> }) {
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const serialize = (c: ScenarioConfig, f: 'yaml' | 'json') => (f === 'yaml' ? YAML.stringify(c, { lineWidth: 0 }) : JSON.stringify(c, null, 2));
  const [text, setText] = useState(() => serialize(config, 'yaml'));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) setText(serialize(config, format));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, format]);

  const parsed = useMemo(() => {
    if (!text.trim()) return { error: 'Empty document', errors: [] as Array<{ path: string; message: string }> };
    if (text.length > 200 * 1024) return { error: 'Document is larger than 200 KB', errors: [] };
    let data: unknown;
    try {
      if (format === 'json') data = JSON.parse(text);
      else {
        const doc = YAML.parseDocument(text, { schema: 'core', customTags: [], merge: false, uniqueKeys: true, prettyErrors: true });
        const problems = [...doc.errors, ...doc.warnings];
        if (problems.length) return { error: problems[0]!.message, errors: [] };
        data = doc.toJS({ maxAliasCount: 50 });
      }
    } catch (e) {
      return { error: (e as Error).message, errors: [] };
    }
    const r = parseScenarioConfig(data);
    if (!r.success) return { error: 'Schema errors', errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    return { config: r.data, error: null, errors: [] };
  }, [text, format]);

  return (
    <Card
      title="YAML / JSON"
      actions={
        <>
          <Select
            aria-label="Format"
            className="w-24"
            value={format}
            onChange={(e) => {
              const f = e.target.value as 'yaml' | 'json';
              setFormat(f);
              setText(serialize(parsed.config ?? config, f));
              setDirty(false);
            }}
          >
            <option value="yaml">YAML</option>
            <option value="json">JSON</option>
          </Select>
          <Button
            variant="secondary"
            size="sm"
            disabled={!dirty}
            onClick={() => {
              setText(serialize(config, format));
              setDirty(false);
            }}
          >
            Reset
          </Button>
          <Button
            size="sm"
            disabled={readOnly || !dirty || !parsed.config}
            loading={saving}
            onClick={async () => {
              if (!parsed.config) return;
              setSaving(true);
              try {
                await onApply(parsed.config);
                setDirty(false);
              } finally {
                setSaving(false);
              }
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-slate-500">Edit the whole draft as data. Parsed locally for instant feedback, then validated and saved by the server. Tags, anchors bombs and code are rejected.</p>
      <Textarea
        aria-label="Scenario YAML/JSON"
        spellCheck={false}
        rows={28}
        className="font-mono text-xs"
        value={text}
        disabled={readOnly}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
      <div className="mt-2" aria-live="polite">
        {parsed.error ? (
          <Alert tone="error" title={parsed.error}>
            {parsed.errors.length > 0 && (
              <ul className="list-disc pl-4 text-xs">
                {parsed.errors.slice(0, 12).map((e, i) => (
                  <li key={i}>
                    <code>{e.path}</code>: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        ) : (
          <p className="text-xs text-emerald-700">{dirty ? 'Valid — click Apply to save.' : 'In sync with the draft.'}</p>
        )}
      </div>
    </Card>
  );
}

// ───────────────────────────── Drafting assistant ─────────────────────────────

export function AssistantPanel({ wsPath, scenarioId, onApplied, readOnly }: { wsPath: (p: string) => string; scenarioId: string; onApplied: (d: ScenarioDetail) => void; readOnly: boolean }) {
  const toast = useToast();
  const base = wsPath(`/scenarios/${scenarioId}/assistant`);
  const { data, mutate } = useSWR<{ data: Proposal[] }>(base);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Proposal | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!current && data?.data?.[0]?.status === 'PENDING') {
      setCurrent(data.data[0]);
      setSelected(new Set(data.data[0].changes.map((c) => c.path)));
    }
  }, [data, current]);

  const ask = async () => {
    setBusy(true);
    try {
      const p = await api<Proposal>(base, { method: 'POST', body: { instruction } });
      setCurrent(p);
      setSelected(new Set(p.changes.map((c) => c.path)));
      if (!p.changes.length) toast.info('No changes proposed');
      mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const r = await api<{ status: string; scenario: ScenarioDetail }>(`${base}/${current.id}/apply`, { method: 'POST', body: { paths: [...selected] } });
      toast.success(r.status === 'APPLIED' ? 'All changes applied' : 'Selected changes applied');
      onApplied(r.scenario);
      setCurrent(null);
      setInstruction('');
      mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!current) return;
    try {
      await api(`${base}/${current.id}/reject`, { method: 'POST', body: {} });
      setCurrent(null);
      mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-3">
      <label htmlFor="assistant-instruction" className="block text-sm font-medium text-slate-700">
        What should change?
      </label>
      <Textarea
        id="assistant-instruction"
        rows={3}
        value={instruction}
        placeholder="e.g. a 15-minute sales discovery call with a skeptical CFO about our analytics product"
        disabled={readOnly || busy}
        onChange={(e) => setInstruction(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Locked fields (🔒) are never changed.</p>
        <Button size="sm" onClick={ask} loading={busy && !current} disabled={readOnly || instruction.trim().length < 3}>
          Propose changes
        </Button>
      </div>

      {current && (
        <div className="space-y-3 border-t border-slate-200 pt-3" data-testid="assistant-proposal">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Proposal</h3>
            {current.simulated && <SimulatedBadge what="Simulated drafter" />}
            <span className="text-xs text-slate-500">“{current.instruction}”</span>
          </div>
          {current.notes?.map((n, i) => (
            <Alert key={i} tone="info">
              {n}
            </Alert>
          ))}
          {current.changes.map((c) => (
            <ChangeRow key={c.path} change={c}>
              <Checkbox
                label="Accept"
                checked={selected.has(c.path)}
                onChange={(v) => {
                  const next = new Set(selected);
                  if (v) next.add(c.path);
                  else next.delete(c.path);
                  setSelected(next);
                }}
              />
            </ChangeRow>
          ))}
          {current.dropped.length > 0 && (
            <details className="text-xs text-slate-600">
              <summary>{current.dropped.length} suggestion(s) were discarded</summary>
              <ul className="list-disc pl-4">
                {current.dropped.map((d, i) => (
                  <li key={i}>
                    <code>{d.path}</code>: {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={reject} disabled={busy || current.status !== 'PENDING'}>
              Reject all
            </Button>
            <Button size="sm" onClick={apply} loading={busy} disabled={readOnly || !selected.size || current.status !== 'PENDING'}>
              Apply selected ({selected.size})
            </Button>
          </div>
        </div>
      )}

      {!!data?.data?.length && (
        <details className="border-t border-slate-200 pt-2 text-xs">
          <summary className="cursor-pointer text-slate-600">Recent proposals</summary>
          <ul className="mt-1 space-y-1">
            {data.data.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{p.instruction}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {p.simulated && <Badge tone="yellow">sim</Badge>}
                  <Badge tone={p.status === 'APPLIED' ? 'green' : p.status === 'PENDING' ? 'blue' : p.status === 'PARTIAL' ? 'purple' : 'gray'}>{p.status.toLowerCase()}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ───────────────────────────── Publish modal ─────────────────────────────

export function PublishModal({ open, onClose, issues, onPublish, latestVersion }: { open: boolean; onClose: () => void; issues: ValidationIssue[]; onPublish: (note: string) => Promise<void>; latestVersion: number }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Publish version ${latestVersion + 1}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={errors.length > 0}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onPublish(note);
                setNote('');
              } finally {
                setBusy(false);
              }
            }}
          >
            Publish
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Publishing creates a new immutable version. New sessions use it; running and past sessions keep the version they started with.</p>
        {errors.length > 0 && (
          <Alert tone="error" title="Fix these errors first">
            <ValidationPanel
              issues={errors}
              onGoto={(p) => {
                onClose();
                setTimeout(() => focusField(p), 50);
              }}
            />
          </Alert>
        )}
        {!errors.length && warnings.length > 0 && (
          <Alert tone="warning" title={`${warnings.length} warning(s)`}>
            <ul className="list-disc pl-4 text-xs">
              {warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          </Alert>
        )}
        <label className="block text-sm font-medium text-slate-700" htmlFor="change-note">
          Change note
        </label>
        <Textarea id="change-note" rows={2} value={note} maxLength={1000} placeholder="What changed in this version?" onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

// ───────────────────────────── Versions ─────────────────────────────

export function VersionsTab({ wsPath, scenarioId, onRolledBack, canPublish }: { wsPath: (p: string) => string; scenarioId: string; onRolledBack: (d: ScenarioDetail) => void; canPublish: boolean }) {
  const toast = useToast();
  const base = wsPath(`/scenarios/${scenarioId}`);
  const { data, error, mutate } = useSWR<{ data: VersionRow[] }>(`${base}/versions`);
  const [diffRefs, setDiffRefs] = useState<{ from: string; to: string } | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const { data: diff } = useSWR<DiffResponse>(diffRefs ? [`${base}/diff`, diffRefs] : null);
  const { data: view } = useSWR<{ version: number; config: unknown }>(viewId ? `${base}/versions/${viewId}` : null);

  if (error) return <Alert tone="error">{errorMessage(error)}</Alert>;
  if (!data) return <Loading />;
  if (!data.data.length) return <p className="text-sm text-slate-600">No versions yet. Publish to create version 1.</p>;
  const versions = data.data;

  return (
    <div className="space-y-4">
      <Card title="Versions">
        <ul className="divide-y divide-slate-100">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`version-${v.version}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  Version {v.version} {v.isLatest && <Badge tone="green">Latest</Badge>} {v.matchesDraft && <Badge tone="blue">= draft</Badge>}{' '}
                  {v.rolledBackFromVersion && <Badge tone="purple">rollback of v{v.rolledBackFromVersion}</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  {formatDate(v.publishedAt)} · {v.publishedBy?.name ?? v.publishedBy?.email ?? 'API'} · {v.sessionCount} session{v.sessionCount === 1 ? '' : 's'}
                </p>
                {v.changeNote && <p className="text-xs text-slate-700">{v.changeNote}</p>}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button variant="ghost" size="sm" onClick={() => setViewId(v.id)}>
                  View
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDiffRefs({ from: v.id, to: 'draft' })}>
                  Diff vs draft
                </Button>
                {!v.isLatest && (
                  <Button variant="ghost" size="sm" onClick={() => setDiffRefs({ from: v.id, to: 'latest' })}>
                    Diff vs latest
                  </Button>
                )}
                {!v.isLatest && canPublish && (
                  <ConfirmButton
                    variant="secondary"
                    size="sm"
                    confirmText={`Publish a new version with the configuration of version ${v.version}? The draft will be reset to it.`}
                    onConfirm={async () => {
                      try {
                        const r = await api<{ version: { version: number }; scenario: ScenarioDetail }>(`${base}/versions/${v.id}/rollback`, { method: 'POST', body: {} });
                        toast.success(`Rolled back — published version ${r.version.version}`);
                        onRolledBack(r.scenario);
                        mutate();
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  >
                    Rollback to this version
                  </ConfirmButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Compare"
        actions={
          <div className="flex items-center gap-1 text-xs">
            <Select aria-label="Compare from" className="w-32" value={diffRefs?.from ?? ''} onChange={(e) => setDiffRefs({ from: e.target.value, to: diffRefs?.to ?? 'draft' })}>
              <option value="" disabled>
                from…
              </option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </Select>
            →
            <Select aria-label="Compare to" className="w-32" value={diffRefs?.to ?? 'draft'} onChange={(e) => setDiffRefs({ from: diffRefs?.from ?? versions[0]!.id, to: e.target.value })}>
              <option value="draft">Draft</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {!diffRefs ? (
          <p className="text-sm text-slate-500">Pick versions to compare.</p>
        ) : !diff ? (
          <Loading />
        ) : (
          <div className="space-y-2" data-testid="diff">
            <p className="text-xs text-slate-500">
              {diff.from.label} → {diff.to.label}: {diff.changes.length} changed field{diff.changes.length === 1 ? '' : 's'}
            </p>
            {diff.changes.map((c) => (
              <ChangeRow key={c.path} change={c} />
            ))}
          </div>
        )}
      </Card>

      <Modal open={!!viewId} onClose={() => setViewId(null)} title={view ? `Version ${view.version}` : 'Version'} wide>
        {view ? <pre className="whitespace-pre-wrap text-xs">{YAML.stringify(view.config, { lineWidth: 0 })}</pre> : <Loading />}
      </Modal>
    </div>
  );
}

// ───────────────────────────── Preview ─────────────────────────────

interface PreviewResponse {
  participant: {
    name: string;
    typeLabel: string;
    publicDescription: string;
    participantInstructions: string;
    persona: { name: string | null };
    firstTurn: { speaker: string; text: string };
    closingMessage: string;
    estimatedDurationMinutes: number;
    maxDurationMinutes: number;
    consent: { required: boolean; recordAudio: boolean; recordVideo: boolean; analysis: boolean; retentionDays: number; notice: string; customNotice: boolean };
    afterSession: { transcript: boolean; feedback: boolean; scores: boolean; humanReview: boolean };
    visibleTools: Array<{ id: string; name: string }>;
    sampleVariables: Record<string, string>;
  };
  prompt: string | null;
  promptNote: string | null;
  promptVersion: string | null;
}

export function PreviewTab({ wsPath, scenarioId, revision, hasVersion }: { wsPath: (p: string) => string; scenarioId: string; revision: number; hasVersion: boolean }) {
  const [source, setSource] = useState<'draft' | 'version'>('draft');
  const { data, error } = useSWR<PreviewResponse>([wsPath(`/scenarios/${scenarioId}/preview`), { source, rev: revision }]);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="preview-source">Preview</label>
        <Select id="preview-source" className="w-48" value={source} onChange={(e) => setSource(e.target.value as 'draft' | 'version')}>
          <option value="draft">Current draft</option>
          <option value="version" disabled={!hasVersion}>
            Latest published version
          </option>
        </Select>
      </div>
      {error && <Alert tone="error">{errorMessage(error)}</Alert>}
      {!data && !error && <Loading />}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="What participants see">
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs uppercase text-slate-500">{data.participant.typeLabel}</p>
                <h3 className="text-lg font-semibold">{data.participant.name || 'Untitled'}</h3>
                <p className="text-slate-700">{data.participant.publicDescription}</p>
              </div>
              <p className="text-xs text-slate-500">
                About {data.participant.estimatedDurationMinutes} min (max {data.participant.maxDurationMinutes}) · with {data.participant.persona.name ?? 'an AI agent'}
              </p>
              <div className="rounded-md bg-slate-50 p-3 whitespace-pre-wrap">{data.participant.participantInstructions}</div>
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-xs font-semibold text-slate-600">Consent{data.participant.consent.customNotice ? '' : ' (generated notice)'}</p>
                <p>{data.participant.consent.notice}</p>
              </div>
              {data.participant.firstTurn.speaker === 'agent' ? (
                <div>
                  <p className="text-xs font-semibold text-slate-600">{data.participant.persona.name ?? 'AI'} opens with</p>
                  <p className="italic">“{data.participant.firstTurn.text}”</p>
                </div>
              ) : (
                <p className="text-xs text-slate-600">The participant speaks first.</p>
              )}
              <p className="text-xs text-slate-600">
                Afterwards: {[data.participant.afterSession.transcript && 'transcript', data.participant.afterSession.feedback && 'feedback', data.participant.afterSession.scores && 'scores'].filter(Boolean).join(', ') || 'nothing is shown to the participant'}
                {data.participant.afterSession.humanReview ? ' · reviewed by a person' : ''}
              </p>
              {data.participant.visibleTools.length > 0 && <p className="text-xs text-slate-600">On-screen tools: {data.participant.visibleTools.map((t) => t.name).join(', ')}</p>}
              {Object.keys(data.participant.sampleVariables).length > 0 && (
                <p className="text-xs text-slate-500">
                  Sample variables: {Object.entries(data.participant.sampleVariables).map(([k, v]) => `${k}=${v}`).join(', ')}
                </p>
              )}
            </div>
          </Card>
          <Card title="Compiled system prompt">
            {data.prompt ? (
              <>
                <p className="mb-2 text-xs text-slate-500">
                  {data.promptNote} {data.promptVersion && <code>({data.promptVersion})</code>}
                </p>
                <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-3 text-xs text-slate-100">{data.prompt}</pre>
              </>
            ) : (
              <p className="text-sm text-slate-500">{data.promptNote ?? 'Prompt preview is not available.'}</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
