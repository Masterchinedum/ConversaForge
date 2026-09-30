'use client';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { fieldLabel } from '@cf/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Badge, Button, Checkbox, SimulatedBadge, Spinner, Textarea, clsx } from '@/components/ui';
import { renderValue } from '../panels';
import type { Proposal, ScenarioDetail } from '../types';
import type { ScenarioDraft } from '../use-scenario-draft';

const EXAMPLES = [
  'A 20-minute behavioral interview for a senior product manager. Ask about stakeholder management and a launch that went wrong. Score communication, ownership and product judgment, and have a person review every result.',
  'A 10-minute sales discovery call with a skeptical CFO at a logistics company who is evaluating our analytics product.',
  'A 15-minute coaching session that teaches active listening, then lets the learner practise with a frustrated customer.',
];

type Change = Proposal['changes'][number];

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

/**
 * Scenario Studio conversation: the creator's messages and the assistant's replies, each reply carrying
 * the field changes it proposes (apply all / selected / discard), the fields it left alone, open
 * questions and requests the runtime cannot deliver. History is the server's proposal log, so it
 * survives reloads; an unsent message is kept in local storage.
 */
export function StudioChat({
  draft,
  proposals,
  loaded,
  refresh,
  onApplied,
  onGoto,
  onOpenTemplates,
}: {
  draft: ScenarioDraft;
  /** Oldest first. */
  proposals: Proposal[];
  loaded: boolean;
  refresh: () => Promise<unknown>;
  onApplied: (d: ScenarioDetail, paths: string[]) => void;
  onGoto: (path: string) => void;
  onOpenTemplates?: () => void;
}) {
  const { wsPath } = useWorkspace();
  const storageKey = `cf:studio:composer:${draft.scenarioId ?? 'new'}`;
  const [text, setText] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Restore an unsent message (per scenario; a new draft's message moves with it once created).
  useEffect(() => {
    setText((t) => t || readStored(storageKey) || (draft.scenarioId ? readStored('cf:studio:composer:new') : ''));
    if (draft.scenarioId) writeStored('cf:studio:composer:new', '');
  }, [storageKey, draft.scenarioId]);
  useEffect(() => writeStored(storageKey, text), [storageKey, text]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [proposals.length, sending, sendError]);

  const selectedFor = (p: Proposal) => selected[p.id] ?? p.changes.map((c) => c.path);
  const toggle = (p: Proposal, path: string, on: boolean) => {
    const cur = new Set(selectedFor(p));
    if (on) cur.add(path);
    else cur.delete(path);
    setSelected((s) => ({ ...s, [p.id]: [...cur] }));
  };

  const send = async (message: string) => {
    const msg = message.trim();
    if (msg.length < 3 || sending) return;
    setSending(msg);
    setSendError(null);
    setText('');
    try {
      // The assistant reads the saved draft: save pending edits first (this also creates a new draft).
      if (!(await draft.flush())) throw new Error('Your latest edits could not be saved, so the assistant cannot see them yet. Resolve the save problem above and try again.');
      const id = await draft.ensureCreated();
      await api<Proposal>(wsPath(`/scenarios/${id}/assistant`), { method: 'POST', body: { instruction: msg } });
      await refresh();
    } catch (e) {
      setSendError(errorMessage(e));
      setText((t) => t || msg);
    } finally {
      setSending(null);
    }
  };

  const apply = async (p: Proposal, paths: string[]) => {
    if (!draft.scenarioId) return;
    setBusy(p.id);
    setActionError((m) => ({ ...m, [p.id]: '' }));
    try {
      if (!(await draft.flush())) throw new Error('Save your latest edits before applying suggestions.');
      const r = await api<{ status: string; appliedPaths: string[]; scenario: ScenarioDetail }>(wsPath(`/scenarios/${draft.scenarioId}/assistant/${p.id}/apply`), {
        method: 'POST',
        body: { paths },
      });
      onApplied(r.scenario, r.appliedPaths);
      await refresh();
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'stale'
          ? `${e.message}`
          : e instanceof ApiError && e.code === 'locked'
            ? `${e.message}. Unlock them or apply the other changes.`
            : errorMessage(e);
      setActionError((m) => ({ ...m, [p.id]: msg }));
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

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send(text);
    }
  };
  const answer = (q: string) => {
    setText((t) => `${t ? `${t}\n` : ''}${q}\n→ `);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const hasPending = proposals.some((p) => p.status === 'PENDING');
  const empty = loaded && !proposals.length && !sending;

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="studio-conversation">
        {!loaded && draft.scenarioId && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading conversation…
          </p>
        )}
        {empty && (
          <div className="space-y-4 py-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Describe the scenario you want</h2>
              <p className="mt-1 text-sm text-slate-600">
                Say who the AI plays, who the participant is, what the conversation should achieve, how long it takes and how it should be scored. The configuration on the right fills in as you go, and you can edit any field yourself.
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Try an example</p>
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => setText(ex)} className="block w-full rounded-md border border-slate-200 bg-white p-3 text-left text-sm text-slate-700 hover:border-brand-300 hover:bg-brand-50">
                  {ex}
                </button>
              ))}
            </div>
            {onOpenTemplates && (
              <p className="text-xs text-slate-500">
                Prefer a starting point?{' '}
                <button type="button" className="text-brand-700 underline" onClick={onOpenTemplates}>
                  Start from a template or import YAML/JSON
                </button>
              </p>
            )}
          </div>
        )}

        {proposals.map((p) => (
          <div key={p.id} className="space-y-3" data-testid="studio-exchange">
            <UserBubble text={p.instruction} />
            <AssistantBubble simulated={p.simulated}>
              <p className="whitespace-pre-wrap text-sm text-slate-800" data-testid="assistant-reply">
                {p.reply || (p.changes.length ? 'Here are the changes I suggest.' : 'I did not change anything.')}
              </p>
              {p.changes.length > 0 && (
                <ChangeList
                  proposal={p}
                  selected={selectedFor(p)}
                  onToggle={(path, on) => toggle(p, path, on)}
                  busy={busy === p.id}
                  readOnly={draft.readOnly}
                  onApply={(paths) => apply(p, paths)}
                  onReject={() => reject(p)}
                  onGoto={onGoto}
                />
              )}
              {actionError[p.id] && (
                <Alert tone="error" title="Not applied">
                  {actionError[p.id]}
                </Alert>
              )}
              <LeftAlone preserved={p.preserved} onGoto={onGoto} />
              {p.unsupported.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" data-testid="assistant-unsupported">
                  <p className="font-semibold">Not possible in the runtime</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {p.unsupported.map((u, i) => (
                      <li key={i}>
                        <span className="font-medium">{u.request}</span> — {u.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {p.questions.length > 0 && (
                <div className="space-y-1" data-testid="assistant-questions">
                  <p className="text-xs font-semibold text-slate-600">Open questions</p>
                  {p.questions.map((q, i) => (
                    <button key={i} type="button" onClick={() => answer(q)} className="block w-full rounded border border-slate-200 bg-white px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-50" title="Answer in the message box">
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {p.dropped.length > 0 && (
                <details className="text-xs text-slate-500">
                  <summary className="cursor-pointer">{p.dropped.length} suggestion(s) were discarded by the safety checks</summary>
                  <ul className="list-disc pl-4">
                    {p.dropped.map((d, i) => (
                      <li key={i}>
                        {d.path === '*' ? 'Response' : fieldLabel(d.path)}: {d.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </AssistantBubble>
          </div>
        ))}

        {sending && (
          <div className="space-y-3">
            <UserBubble text={sending} />
            <AssistantBubble>
              <p className="flex items-center gap-2 text-sm text-slate-600" role="status">
                <Spinner /> Working on your scenario…
              </p>
            </AssistantBubble>
          </div>
        )}
        {sendError && (
          <Alert tone="error" title="The assistant could not reply">
            <p>{sendError}</p>
            <p className="mt-1 text-xs">Your message is back in the box below; nothing was changed.</p>
          </Alert>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 space-y-2 border-t border-slate-200 bg-white p-3">
        {hasPending && <p className="text-xs text-indigo-700">Suggestions above are not applied yet. The assistant works from the configuration as it is now.</p>}
        <label htmlFor="studio-prompt" className="sr-only">
          Message the assistant
        </label>
        <Textarea
          id="studio-prompt"
          ref={inputRef}
          rows={proposals.length ? 3 : 5}
          value={text}
          maxLength={4000}
          placeholder={proposals.length ? 'Ask for a change, e.g. “Make it 15 minutes” or “Add a question about pricing”' : 'Describe the scenario you want to build…'}
          disabled={!!sending || draft.readOnly}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">🔒 Locked fields are never changed · ⌘/Ctrl + Enter to send</p>
          <Button type="submit" size="sm" loading={!!sending} disabled={text.trim().length < 3 || draft.readOnly}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[90%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white" data-testid="user-message">
        {text}
      </p>
    </div>
  );
}

function AssistantBubble({ children, simulated }: { children: React.ReactNode; simulated?: boolean }) {
  return (
    <div className="max-w-full space-y-3 rounded-lg rounded-bl-sm border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-500">Assistant</span>
        {simulated && <SimulatedBadge what="Simulated drafter" />}
      </div>
      {children}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = { APPLIED: 'Applied', PARTIAL: 'Partly applied', REJECTED: 'Discarded', STALE: 'Out of date' };

function ChangeList({
  proposal: p,
  selected,
  onToggle,
  busy,
  readOnly,
  onApply,
  onReject,
  onGoto,
}: {
  proposal: Proposal;
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
    <div className="space-y-2" data-testid="assistant-proposal">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-600">
          {pending ? `Proposed changes (${p.changes.length})` : `${STATUS_TEXT[p.status] ?? p.status}: ${p.status === 'PARTIAL' ? `${p.appliedPaths.length} of ${p.changes.length}` : p.changes.length} change${p.changes.length === 1 ? '' : 's'}`}
        </p>
        {!pending && <Badge tone={p.status === 'APPLIED' ? 'green' : p.status === 'PARTIAL' ? 'purple' : 'gray'}>{(STATUS_TEXT[p.status] ?? p.status).toLowerCase()}</Badge>}
      </div>
      <ul className="space-y-2">
        {p.changes.map((c) => (
          <ChangeItem
            key={c.path}
            change={c}
            pending={pending}
            checked={selected.includes(c.path)}
            applied={p.appliedPaths.includes(c.path)}
            onToggle={(on) => onToggle(c.path, on)}
            onGoto={() => onGoto(c.path)}
            disabled={busy || readOnly}
          />
        ))}
      </ul>
      {pending && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onReject} disabled={busy}>
            Discard
          </Button>
          {selected.length > 0 && selected.length < all.length && (
            <Button variant="secondary" size="sm" onClick={() => onApply(selected)} loading={busy} disabled={readOnly}>
              Apply selected ({selected.length})
            </Button>
          )}
          <Button size="sm" onClick={() => onApply(all)} loading={busy && selected.length === all.length} disabled={readOnly || busy}>
            Apply all ({all.length})
          </Button>
        </div>
      )}
    </div>
  );
}

function isShort(v: unknown) {
  return v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 80 && !v.includes('\n'));
}

function ChangeItem({
  change: c,
  pending,
  checked,
  applied,
  onToggle,
  onGoto,
  disabled,
}: {
  change: Change;
  pending: boolean;
  checked: boolean;
  applied: boolean;
  onToggle: (on: boolean) => void;
  onGoto: () => void;
  disabled: boolean;
}) {
  const short = isShort(c.before) && isShort(c.after);
  return (
    <li className={clsx('rounded-md border p-2 text-xs', pending ? 'border-indigo-200 bg-indigo-50/40' : applied ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 opacity-70')} data-testid={`change-${c.path}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {pending ? (
            <Checkbox label={<span className="font-semibold text-slate-800">{fieldLabel(c.path)}</span>} checked={checked} disabled={disabled} onChange={onToggle} />
          ) : (
            <span className="font-semibold text-slate-800">
              {applied ? '✓ ' : '– '}
              {fieldLabel(c.path)}
            </span>
          )}
          {c.reason && <p className="mt-0.5 text-slate-600">{c.reason}</p>}
          {c.overwritesManual && <p className="mt-0.5 font-medium text-amber-800">Replaces text you wrote</p>}
        </div>
        <button type="button" className="shrink-0 text-brand-700 hover:underline" onClick={onGoto}>
          Show field
        </button>
      </div>
      {short ? (
        <p className="mt-1 break-words">
          <span className="rounded bg-red-50 px-1 text-red-900 line-through decoration-red-300">{renderValue(c.before)}</span> → <span className="rounded bg-emerald-50 px-1 text-emerald-900">{renderValue(c.after)}</span>
        </p>
      ) : (
        <details className="mt-1">
          <summary className="cursor-pointer text-slate-600">Before / after</summary>
          <div className="mt-1 grid gap-1">
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-red-900" aria-label="Before">
              {renderValue(c.before)}
            </pre>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-emerald-50 p-2 text-emerald-900" aria-label="After">
              {renderValue(c.after)}
            </pre>
          </div>
        </details>
      )}
    </li>
  );
}

function LeftAlone({ preserved, onGoto }: { preserved: Proposal['preserved']; onGoto: (path: string) => void }) {
  if (!preserved.length) return null;
  const locked = preserved.filter((x) => x.reason === 'locked');
  const mine = preserved.filter((x) => x.reason === 'creator');
  const link = (path: string) => (
    <button key={path} type="button" className="underline decoration-dotted hover:text-slate-900" onClick={() => onGoto(path)}>
      {fieldLabel(path)}
    </button>
  );
  const join = (items: Proposal['preserved']) => items.slice(0, 8).flatMap((x, i) => (i ? [', ', link(x.path)] : [link(x.path)]));
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
