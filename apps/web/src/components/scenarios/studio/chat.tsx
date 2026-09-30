'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { fieldLabel } from '@cf/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Badge, Button, Checkbox, SimulatedBadge, Spinner, clsx, useToast } from '@/components/ui';
import { Icon } from '../icons';
import { renderValue } from '../panels';
import type { AgentEvent, Proposal, ScenarioDetail } from '../types';
import type { ScenarioDraft } from '../use-scenario-draft';

export type AgentMode = 'standard' | 'flash' | 'deep';
type Change = Proposal['changes'][number];

const MODE_HELP: Record<AgentMode, string> = {
  standard: 'Drafts, then expands the AI instructions, aligns the rubric and fixes validation errors.',
  flash: 'Flash Mode: one fast pass and a check. Fewer model calls; no expansion or fix passes.',
  deep: 'Deep Research: searches your workspace knowledge base first, then drafts and reviews the whole scenario.',
};

function readStored(key: string) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function writeStored(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const fmtDay = (d: Date) => `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Starts an agent run; shared by the composer, Quick Prompts and the name wand. */
export async function startAgentRun(draft: ScenarioDraft, wsPath: (p: string) => string, instruction: string, mode: AgentMode): Promise<Proposal> {
  if (!(await draft.flush())) throw new Error('Your latest edits could not be saved, so the assistant cannot see them yet. Resolve the save problem and try again.');
  const id = await draft.ensureCreated();
  return api<Proposal>(wsPath(`/scenarios/${id}/studio/runs`), { method: 'POST', body: { instruction, mode } });
}

/**
 * Scenario Studio conversation. Each creator message starts an agent run that edits the draft in steps;
 * the run's progress (narration, tools, field updates, checks) streams in by polling and stays in the
 * history. Older "review" proposals (from the classic editor) still show with Apply / Discard.
 */
export function StudioChat({
  draft,
  proposals,
  loaded,
  refresh,
  starting,
  setStarting,
  onApplied,
  onGoto,
  onOpenTemplates,
  userInitials,
}: {
  draft: ScenarioDraft;
  /** Oldest first. */
  proposals: Proposal[];
  loaded: boolean;
  refresh: () => Promise<unknown>;
  starting: string | null;
  setStarting: (msg: string | null) => void;
  onApplied: (d: ScenarioDetail, paths: string[]) => void;
  onGoto: (path: string) => void;
  onOpenTemplates: () => void;
  userInitials: string;
}) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const storageKey = `cf:studio:composer:${draft.scenarioId ?? 'new'}`;
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode>('standard');
  const [sendError, setSendError] = useState<string | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const running = proposals.find((p) => p.status === 'RUNNING') ?? null;
  const working = !!running || !!starting;

  useEffect(() => {
    setText((t) => t || readStored(storageKey) || (draft.scenarioId ? readStored('cf:studio:composer:new') : ''));
    if (draft.scenarioId) writeStored('cf:studio:composer:new', '');
    const m = readStored('cf:studio:mode');
    if (m === 'flash' || m === 'deep') setMode(m);
  }, [storageKey, draft.scenarioId]);
  useEffect(() => writeStored(storageKey, text), [storageKey, text]);
  useEffect(() => writeStored('cf:studio:mode', mode === 'standard' ? '' : mode), [mode]);

  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  const lastEvents = running?.events.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [proposals.length, lastEvents, starting, sendError]);

  const send = async (message: string) => {
    const msg = message.trim();
    if (msg.length < 3 || working) return;
    setStarting(msg);
    setSendError(null);
    setText('');
    try {
      await startAgentRun(draft, wsPath, msg, mode);
      await refresh();
    } catch (e) {
      setSendError(e instanceof ApiError && e.code === 'agent_busy' ? 'The assistant is still working on the previous message.' : errorMessage(e));
      setText((t) => t || msg);
    } finally {
      setStarting(null);
    }
  };

  const stop = async () => {
    if (!running || !draft.scenarioId) return;
    try {
      await api(wsPath(`/scenarios/${draft.scenarioId}/studio/runs/${running.id}/cancel`), { method: 'POST', body: {} });
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const undo = async (p: Proposal) => {
    if (!draft.scenarioId) return;
    setBusy(p.id);
    try {
      const r = await api<{ reverted: string[]; skipped: string[]; scenario: ScenarioDetail }>(wsPath(`/scenarios/${draft.scenarioId}/studio/runs/${p.id}/undo`), { method: 'POST', body: {} });
      onApplied(r.scenario, r.reverted);
      toast.success(r.skipped.length ? `Undone. Kept ${r.skipped.length} field(s) you changed since.` : 'Undone');
      await refresh();
    } catch (e) {
      setActionError((m) => ({ ...m, [p.id]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  // Classic "review" proposals (made in the classic editor) are still applied by hand.
  const apply = async (p: Proposal, paths: string[]) => {
    if (!draft.scenarioId) return;
    setBusy(p.id);
    try {
      if (!(await draft.flush())) throw new Error('Save your latest edits before applying suggestions.');
      const r = await api<{ appliedPaths: string[]; scenario: ScenarioDetail }>(wsPath(`/scenarios/${draft.scenarioId}/assistant/${p.id}/apply`), { method: 'POST', body: { paths } });
      onApplied(r.scenario, r.appliedPaths);
      await refresh();
    } catch (e) {
      setActionError((m) => ({ ...m, [p.id]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };
  const reject = async (p: Proposal) => {
    if (!draft.scenarioId) return;
    setBusy(p.id);
    try {
      await api(wsPath(`/scenarios/${draft.scenarioId}/assistant/${p.id}/reject`), { method: 'POST', body: {} });
      await refresh();
    } catch (e) {
      setActionError((m) => ({ ...m, [p.id]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };
  const answer = (q: string) => {
    setText((t) => `${t ? `${t}\n` : ''}${q}\n→ `);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const copyConversation = async () => {
    const lines = proposals.flatMap((p) => [`You: ${p.instruction}`, ...p.events.filter((e) => e.kind !== 'tool').map((e) => `Assistant: ${e.text}`), ...(p.reply ? [`Assistant: ${p.reply}`] : []), '']);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success('Conversation copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  const empty = loaded && !proposals.length && !starting;
  let lastDay = '';

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-slate-50">
      <div className="flex h-9 shrink-0 items-center justify-end px-2">
        {!!proposals.length && (
          <button type="button" onClick={copyConversation} className="rounded p-1.5 text-slate-500 hover:bg-white hover:text-slate-900" aria-label="Copy conversation" title="Copy conversation">
            <Icon name="copy" />
          </button>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4" data-testid="studio-conversation">
        {!loaded && draft.scenarioId && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading conversation…
          </p>
        )}
        {empty && (
          <div className="space-y-3 py-6 text-center">
            <Icon name="sparkles" className="mx-auto h-8 w-8 text-brand-600" />
            <h2 className="text-lg font-semibold text-slate-900">Describe the scenario you want</h2>
            <p className="mx-auto max-w-sm text-sm text-slate-600">Say who the AI plays, who practises, the goal, the length and how it should be scored. The form on the right fills in as the assistant works.</p>
          </div>
        )}

        {proposals.map((p) => {
          const d = new Date(p.createdAt);
          const day = d.toDateString();
          const divider = day !== lastDay;
          lastDay = day;
          return (
            <div key={p.id} className="space-y-3" data-testid="studio-exchange">
              {divider && <DateDivider label={fmtDay(d)} />}
              <UserBubble text={p.instruction} time={fmtTime(d)} initials={userInitials} />
              {p.mode === 'review' ? (
                <ReviewProposal
                  p={p}
                  selected={selected[p.id] ?? p.changes.map((c) => c.path)}
                  onToggle={(path, on) => setSelected((s) => ({ ...s, [p.id]: on ? [...(s[p.id] ?? p.changes.map((c) => c.path)), path] : (s[p.id] ?? p.changes.map((c) => c.path)).filter((x) => x !== path) }))}
                  busy={busy === p.id}
                  readOnly={draft.readOnly}
                  onApply={(paths) => apply(p, paths)}
                  onReject={() => reject(p)}
                  onGoto={onGoto}
                />
              ) : (
                <RunView run={p} now={now} busy={busy === p.id} onUndo={() => undo(p)} onGoto={onGoto} onAnswer={answer} />
              )}
              {actionError[p.id] && <Alert tone="error">{actionError[p.id]}</Alert>}
            </div>
          );
        })}

        {starting && (
          <div className="space-y-3">
            {!proposals.length && <DateDivider label={fmtDay(new Date())} />}
            <UserBubble text={starting} time={fmtTime(new Date())} initials={userInitials} />
            <Working label="Working — Connecting to agent" />
          </div>
        )}
        {sendError && (
          <Alert tone="error" title="The assistant could not start">
            <p>{sendError}</p>
            <p className="mt-1 text-xs">Your message is back in the box below; nothing was changed.</p>
          </Alert>
        )}
      </div>

      <div className="shrink-0 p-3">
        <div className="rounded-xl border border-slate-300 bg-white shadow-sm focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500">
          <label htmlFor="studio-prompt" className="sr-only">
            Message the assistant
          </label>
          <textarea
            id="studio-prompt"
            ref={inputRef}
            rows={proposals.length ? 3 : 4}
            value={text}
            maxLength={4000}
            placeholder={proposals.length ? 'Describe how you’d like to edit your scenario…' : 'Describe the scenario you want to build…'}
            disabled={draft.readOnly}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            className="block w-full resize-none rounded-t-xl border-0 bg-transparent px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0"
          />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <div className="relative">
              <button type="button" onClick={() => setPlusOpen((v) => !v)} aria-expanded={plusOpen} aria-label="More options" className="grid h-7 w-7 place-items-center rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50">
                <Icon name="plus" />
              </button>
              {plusOpen && (
                <div className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-1.5 text-left hover:bg-slate-50"
                    onClick={() => {
                      setPlusOpen(false);
                      onOpenTemplates();
                    }}
                  >
                    Start from a template or file…
                  </button>
                </div>
              )}
            </div>
            <ModeChip icon="search" label="Deep Research" active={mode === 'deep'} onClick={() => setMode((m) => (m === 'deep' ? 'standard' : 'deep'))} help={MODE_HELP.deep} />
            <ModeChip icon="bolt" label="Flash Mode" active={mode === 'flash'} onClick={() => setMode((m) => (m === 'flash' ? 'standard' : 'flash'))} help={MODE_HELP.flash} warm />
            <div className="ml-auto">
              {running ? (
                <button type="button" onClick={stop} aria-label="Stop the assistant" title="Stop" className="grid h-8 w-8 place-items-center rounded-full bg-red-600 text-white hover:bg-red-700">
                  <Icon name="stop" className="h-3.5 w-3.5" fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send(text)}
                  disabled={text.trim().length < 3 || working || draft.readOnly}
                  aria-label="Send"
                  title="Send (Enter)"
                  className="grid h-8 w-8 place-items-center rounded-full bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
                >
                  {starting ? <Spinner className="h-4 w-4" /> : <Icon name="arrowUp" />}
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-1 px-1 text-[11px] text-slate-500">{MODE_HELP[mode]} 🔒 Locked fields are never changed.</p>
      </div>
    </div>
  );
}

function ModeChip({ icon, label, active, onClick, help, warm }: { icon: 'search' | 'bolt'; label: string; active: boolean; onClick: () => void; help: string; warm?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={help}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
        active ? (warm ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-brand-400 bg-brand-50 text-brand-800') : 'border-slate-200 text-slate-600 hover:bg-slate-50',
      )}
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-slate-400">
      <span className="h-px flex-1 bg-slate-200" />
      {label}
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  );
}

function UserBubble({ text, time, initials }: { text: string; time: string; initials: string }) {
  return (
    <div className="flex items-end justify-end gap-2">
      <div className="max-w-[88%] rounded-2xl rounded-br-sm border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm">
        <p className="whitespace-pre-wrap" data-testid="user-message">
          {text}
        </p>
        <p className="mt-1 text-right text-[10px] text-slate-400">{time}</p>
      </div>
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700" aria-hidden>
        {initials}
      </span>
    </div>
  );
}

function Working({ label, meta }: { label: string; meta?: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-slate-600" role="status" data-testid="agent-working">
      <span className="flex gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-600" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      {label}
      {meta && <span className="text-xs text-slate-400">{meta}</span>}
    </p>
  );
}

/** Group consecutive tool steps like "3 tools used". */
function groupEvents(events: AgentEvent[]) {
  const out: Array<{ kind: 'tools'; items: AgentEvent[] } | { kind: 'event'; ev: AgentEvent }> = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (ev.kind === 'tool') {
      if (last?.kind === 'tools') last.items.push(ev);
      else out.push({ kind: 'tools', items: [ev] });
    } else out.push({ kind: 'event', ev });
  }
  return out;
}

function RunView({ run, now, busy, onUndo, onGoto, onAnswer }: { run: Proposal; now: number; busy: boolean; onUndo: () => void; onGoto: (path: string) => void; onAnswer: (q: string) => void }) {
  const isRunning = run.status === 'RUNNING';
  const started = new Date(run.createdAt).getTime();
  const elapsed = (run.finishedAt ? new Date(run.finishedAt).getTime() : now) - started;
  const byPath = new Map(run.changes.map((c) => [c.path, c]));
  return (
    <div className="space-y-2.5" data-testid="agent-run" data-status={run.status}>
      <div className="flex items-center gap-2">
        {run.simulated && <SimulatedBadge what="Simulated drafter" />}
        {run.mode !== 'standard' && <Badge tone={run.mode === 'flash' ? 'yellow' : 'blue'}>{run.mode === 'flash' ? 'Flash Mode' : 'Deep Research'}</Badge>}
      </div>
      {groupEvents(run.events).map((g, i) =>
        g.kind === 'tools' ? (
          <Collapsible key={i} summary={`${g.items.length} tool${g.items.length === 1 ? '' : 's'} used`}>
            <ul className="space-y-1">
              {g.items.map((t, k) => (
                <li key={k} className="flex gap-2 text-xs text-slate-600">
                  <span className="text-emerald-600">✓</span>
                  {t.text}
                </li>
              ))}
            </ul>
          </Collapsible>
        ) : g.ev.kind === 'update' ? (
          <Collapsible key={i} tone="green" summary={<span className="inline-flex items-center gap-1.5"><Icon name="checkCircle" className="h-4 w-4 text-emerald-600" />{g.ev.text.replace(/^.*: u/, 'U')}</span>} testId="run-update">
            <ul className="space-y-2">
              {(g.ev.paths ?? []).map((path) => {
                const c = byPath.get(path);
                return (
                  <li key={path} className="text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800">{fieldLabel(path)}</span>
                      <button type="button" className="text-brand-700 hover:underline" onClick={() => onGoto(path)}>
                        Show field
                      </button>
                    </div>
                    {c?.reason && <p className="text-slate-600">{c.reason}</p>}
                    {c && <BeforeAfter change={c} />}
                  </li>
                );
              })}
            </ul>
          </Collapsible>
        ) : g.ev.kind === 'narration' ? (
          <p key={i} className="whitespace-pre-wrap text-sm text-slate-800">
            {g.ev.text}
          </p>
        ) : g.ev.kind === 'check' ? (
          <p key={i} className="flex gap-2 text-xs text-slate-600" data-testid="run-check">
            <span className={/need|attention/.test(g.ev.text) ? 'text-amber-600' : 'text-emerald-600'}>{/need|attention/.test(g.ev.text) ? '!' : '✓'}</span>
            {g.ev.text}
          </p>
        ) : (
          <p key={i} className="text-sm text-red-700">
            {g.ev.text}
          </p>
        ),
      )}

      {isRunning ? (
        <Working label="Thinking…" meta={`${fmtDuration(elapsed)} · ${run.events.length} steps`} />
      ) : (
        <>
          {run.reply && (
            <p className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-800" data-testid="assistant-reply">
              {run.reply}
            </p>
          )}
          <LeftAlone preserved={run.preserved} onGoto={onGoto} />
          {run.unsupported.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" data-testid="assistant-unsupported">
              <p className="font-semibold">Not possible in the runtime</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {run.unsupported.map((u, i) => (
                  <li key={i}>
                    <span className="font-medium">{u.request}</span> — {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.questions.length > 0 && (
            <div className="space-y-1" data-testid="assistant-questions">
              <p className="text-xs font-semibold text-slate-600">Open questions</p>
              {run.questions.map((q, i) => (
                <button key={i} type="button" onClick={() => onAnswer(q)} className="block w-full rounded border border-slate-200 bg-white px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-50" title="Answer in the message box">
                  {q}
                </button>
              ))}
            </div>
          )}
          {run.dropped.length > 0 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">{run.dropped.length} suggestion(s) were blocked by the safety checks</summary>
              <ul className="list-disc pl-4">
                {run.dropped.map((d, i) => (
                  <li key={i}>
                    {fieldLabel(d.path)}: {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span data-testid="run-summary">
              {fmtDuration(elapsed)} · {run.events.length} steps{run.status === 'UNDONE' ? ' · undone' : run.status === 'CANCELLED' ? ' · stopped' : run.status === 'FAILED' ? ' · did not finish' : ''}
            </span>
            {run.changes.length > 0 && ['DONE', 'CANCELLED', 'FAILED'].includes(run.status) && (
              <Button variant="ghost" size="sm" onClick={onUndo} loading={busy} title="Put back the values from before this run">
                <Icon name="undo" className="h-3.5 w-3.5" /> Undo changes
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Collapsible({ summary, children, tone, testId }: { summary: ReactNode; children: ReactNode; tone?: 'green'; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={clsx('rounded-md border', tone === 'green' ? 'border-emerald-200 bg-emerald-50/50' : 'border-slate-200 bg-white')} data-testid={testId}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700">
        <Icon name={open ? 'chevronDown' : 'chevronRight'} className="h-3.5 w-3.5 text-slate-400" />
        {summary}
      </button>
      {open && <div className="border-t border-slate-100 px-3 py-2">{children}</div>}
    </div>
  );
}

function isShort(v: unknown) {
  return v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 80 && !v.includes('\n'));
}

function BeforeAfter({ change: c }: { change: Change }) {
  if (isShort(c.before) && isShort(c.after)) {
    return (
      <p className="mt-0.5 break-words" data-testid={`change-${c.path}`}>
        <span className="rounded bg-red-50 px-1 text-red-900 line-through decoration-red-300">{renderValue(c.before)}</span> → <span className="rounded bg-emerald-50 px-1 text-emerald-900">{renderValue(c.after)}</span>
      </p>
    );
  }
  return (
    <details className="mt-0.5" data-testid={`change-${c.path}`}>
      <summary className="cursor-pointer text-slate-500">Before / after</summary>
      <div className="mt-1 grid gap-1">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-red-900" aria-label="Before">
          {renderValue(c.before)}
        </pre>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-emerald-50 p-2 text-emerald-900" aria-label="After">
          {renderValue(c.after)}
        </pre>
      </div>
    </details>
  );
}

function LeftAlone({ preserved, onGoto }: { preserved: Proposal['preserved']; onGoto: (path: string) => void }) {
  if (!preserved.length) return null;
  const locked = preserved.filter((x) => x.reason === 'locked');
  const mine = preserved.filter((x) => x.reason === 'creator');
  const join = (items: Proposal['preserved']) =>
    items.slice(0, 8).flatMap((x, i) => {
      const link = (
        <button key={x.path} type="button" className="underline decoration-dotted hover:text-slate-900" onClick={() => onGoto(x.path)}>
          {fieldLabel(x.path)}
        </button>
      );
      return i ? [', ', link] : [link];
    });
  return (
    <div className="space-y-0.5 text-xs text-slate-600" data-testid="assistant-left-alone">
      {locked.length > 0 && (
        <p>
          <span className="font-semibold">🔒 Kept (locked):</span> {join(locked)}
          {locked.length > 8 ? ` and ${locked.length - 8} more` : ''}
        </p>
      )}
      {mine.length > 0 && (
        <p>
          <span className="font-semibold">✎ Kept your wording:</span> {join(mine)}
          {mine.length > 8 ? ` and ${mine.length - 8} more` : ''}
        </p>
      )}
    </div>
  );
}

function ReviewProposal({
  p,
  selected,
  onToggle,
  busy,
  readOnly,
  onApply,
  onReject,
  onGoto,
}: {
  p: Proposal;
  selected: string[];
  onToggle: (path: string, on: boolean) => void;
  busy: boolean;
  readOnly: boolean;
  onApply: (paths: string[]) => void;
  onReject: () => void;
  onGoto: (path: string) => void;
}) {
  const pending = p.status === 'PENDING';
  const all = p.changes.map((c) => c.path);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3" data-testid="assistant-proposal">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-500">Suggestion from the classic editor</span>
        {p.simulated && <SimulatedBadge what="Simulated drafter" />}
      </div>
      {p.reply && <p className="whitespace-pre-wrap text-sm text-slate-800">{p.reply}</p>}
      <ul className="space-y-2">
        {p.changes.map((c) => (
          <li key={c.path} className="rounded-md border border-slate-200 p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              {pending ? (
                <Checkbox label={<span className="font-semibold">{fieldLabel(c.path)}</span>} checked={selected.includes(c.path)} disabled={busy || readOnly} onChange={(on) => onToggle(c.path, on)} />
              ) : (
                <span className="font-semibold">
                  {p.appliedPaths.includes(c.path) ? '✓ ' : '– '}
                  {fieldLabel(c.path)}
                </span>
              )}
              <button type="button" className="text-brand-700 hover:underline" onClick={() => onGoto(c.path)}>
                Show field
              </button>
            </div>
            <BeforeAfter change={c} />
          </li>
        ))}
      </ul>
      {pending ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onReject} disabled={busy}>
            Discard
          </Button>
          <Button size="sm" onClick={() => onApply(selected.length ? selected : all)} loading={busy} disabled={readOnly || !selected.length}>
            Apply {selected.length === all.length ? 'all' : 'selected'} ({selected.length})
          </Button>
        </div>
      ) : (
        <p className="text-xs text-slate-500">{p.status.toLowerCase().replace('_', ' ')}</p>
      )}
    </div>
  );
}
