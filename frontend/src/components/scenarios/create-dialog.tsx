'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Spinner } from '@/components/ui';
import { Icon } from './icons';
import type { ScenarioDetail } from './types';

/**
 * "Create Scenario": one prompt. Sending creates a Studio draft, starts the assistant on it and opens
 * Scenario Studio, where the run is already in progress. "Open Studio" starts with an empty draft.
 */
export function CreateScenarioDialog({ open, onClose, onTemplates }: { open: boolean; onClose: () => void; onTemplates: () => void }) {
  const { wsPath, href } = useWorkspace();
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    requestAnimationFrame(() => ref.current?.focus());
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const send = async () => {
    const instruction = text.trim();
    if (instruction.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const d = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body: { source: 'studio' } });
      const id = d.scenario.id;
      try {
        await api(wsPath(`/scenarios/${id}/studio/runs`), { method: 'POST', body: { instruction, mode: 'standard' } });
      } catch {
        // Keep the brief: the Studio shows it in the message box so nothing is lost.
        try {
          localStorage.setItem(`cf:studio:composer:${id}`, instruction);
        } catch {
          /* storage unavailable */
        }
      }
      router.push(href(`/scenarios/${id}/studio`));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/20 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Create a scenario" className="w-full max-w-3xl rounded-2xl border-2 border-brand-500 bg-white shadow-2xl" data-testid="create-dialog">
        <label htmlFor="create-prompt" className="sr-only">
          Describe the scenario to create
        </label>
        <textarea
          id="create-prompt"
          ref={ref}
          rows={4}
          value={text}
          maxLength={4000}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe a scenario, e.g. a 10-minute discovery call where a skeptical CFO pushes back on price…"
          className="block w-full resize-none rounded-t-2xl border-0 bg-transparent px-6 pt-5 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0"
        />
        {error && <p className="px-6 pb-2 text-sm text-red-700">{error}</p>}
        <div className="flex items-center gap-4 px-5 pb-4 pt-2">
          <button type="button" onClick={() => router.push(href('/scenarios/new'))} disabled={busy} className="flex items-center gap-1.5 text-sm text-slate-700 hover:text-brand-700">
            <Icon name="sliders" /> Open Studio
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onTemplates();
            }}
            disabled={busy}
            className="text-sm text-slate-500 hover:text-brand-700"
          >
            Templates & import
          </button>
          <button
            type="button"
            onClick={send}
            disabled={text.trim().length < 3 || busy}
            aria-label="Create with AI"
            title="Create with AI (Enter)"
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {busy ? <Spinner className="h-4 w-4" /> : <Icon name="arrowUp" />}
          </button>
        </div>
      </div>
    </div>
  );
}
