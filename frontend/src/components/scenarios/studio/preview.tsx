'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Loading, useToast } from '@/components/ui';
import { Icon } from '../icons';
import { Markdown } from '../markdown';
import { startSelfRun } from '../new-scenario';
import type { ScenarioDraft } from '../use-scenario-draft';

interface PreviewResponse {
  participant: {
    name: string;
    typeLabel: string;
    publicDescription: string;
    participantInstructions: string;
    persona: { name: string | null };
    firstTurn: { speaker: string; text: string };
    estimatedDurationMinutes: number;
    maxDurationMinutes: number;
    consent: { notice: string; customNotice: boolean };
    afterSession: { transcript: boolean; feedback: boolean; scores: boolean; humanReview: boolean };
    visibleTools: Array<{ id: string; name: string }>;
  };
  prompt: string | null;
  promptNote: string | null;
}

/**
 * Live preview of the saved draft as a participant would meet it (embed-style frame), plus Share, Try Now
 * and Details. It is compiled from the draft on the server and never publishes anything.
 */
export function StudioPreview({ draft }: { draft: ScenarioDraft }) {
  const { wsPath, href } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const id = draft.scenarioId;
  const rev = draft.saveState === 'saved' ? draft.revision() : null;
  const { data, error } = useSWR<PreviewResponse>(id && rev !== null ? [wsPath(`/scenarios/${id}/preview`), { source: 'draft', rev }] : null, { keepPreviousData: true });
  const published = !!draft.detail?.scenario.latestVersionId && draft.detail.scenario.status === 'PUBLISHED';

  if (!id) return <p className="text-sm text-slate-600">The preview appears once the draft has content. Describe your scenario or edit a field first.</p>;

  const tryNow = async () => {
    setStarting(true);
    try {
      router.push(await startSelfRun(wsPath, id));
    } catch (e) {
      toast.error(errorMessage(e));
      setStarting(false);
    }
  };
  const p = data?.participant;

  return (
    <div className="mx-auto max-w-4xl space-y-5 py-2" data-testid="studio-preview">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Icon name="eye" className="h-5 w-5" /> Live Preview
        </h2>
        <p className="text-sm text-slate-600">Updates automatically when saved. Previewing never publishes anything.</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <span className="flex gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </span>
          Participant view
          {draft.saveState !== 'saved' && <span className="ml-auto">Saving…</span>}
        </div>
        <div className="min-h-[18rem] p-6">
          {error && <Alert tone="error">{errorMessage(error)}</Alert>}
          {!p && !error && <Loading />}
          {p && (
            <div className="mx-auto max-w-2xl space-y-4">
              <div className="text-center">
                <span className="mx-auto grid h-16 w-16 place-items-center rounded-full border-4 border-slate-300 bg-slate-100 text-lg font-semibold text-slate-700">{initials(p.persona.name || p.name)}</span>
                <p className="mt-3 text-xs uppercase tracking-wide text-slate-500">{p.typeLabel}</p>
                <h3 className="text-xl font-semibold text-slate-900">{p.name || 'Untitled scenario'}</h3>
                <p className="mt-1 text-sm text-slate-600">{p.publicDescription}</p>
                <p className="mt-2 text-xs text-slate-500">
                  About {p.estimatedDurationMinutes} min · with {p.persona.name ?? 'an AI agent'}
                </p>
              </div>
              {p.participantInstructions && (
                <div className="rounded-lg bg-slate-50 p-4">
                  <Markdown text={p.participantInstructions} />
                </div>
              )}
              <p className="rounded-md border border-slate-200 p-3 text-xs text-slate-600">{p.consent.notice}</p>
              {p.firstTurn.speaker === 'agent' ? (
                <p className="text-sm italic text-slate-700">
                  {p.persona.name ?? 'AI'} opens with: “{p.firstTurn.text}”
                </p>
              ) : (
                <p className="text-xs text-slate-600">You speak first.</p>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <button type="button" onClick={() => router.push(href(`/scenarios/${id}/access`))} className="flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800">
          <Icon name="share" /> Share
        </button>
        <button
          type="button"
          onClick={tryNow}
          disabled={!published || starting}
          title={published ? 'Start a practice session with the latest published version' : 'Create the scenario first'}
          className="flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:bg-slate-300"
        >
          <Icon name="play" /> Try Now
        </button>
        <button type="button" onClick={() => router.push(href(`/scenarios/${id}`))} className="flex items-center justify-center gap-2 rounded-lg bg-fuchsia-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-fuchsia-700">
          <Icon name="doc" /> Details
        </button>
      </div>
      <p className="text-center text-xs text-slate-500">{published ? 'Try, share, or view the details of your scenario.' : 'Try Now works once the scenario is created (published).'}</p>
      {data?.prompt && (
        <details className="rounded-lg border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">Compiled system prompt</summary>
          <p className="mt-2 text-xs text-slate-500">{data.promptNote}</p>
          <pre className="mt-2 max-h-[30rem] overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-3 text-xs text-slate-100">{data.prompt}</pre>
        </details>
      )}
    </div>
  );
}

export function initials(s: string) {
  const words = s.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'AI';
  return (words.length === 1 ? words[0]!.slice(0, 2) : `${words[0]![0]}${words[1]![0]}`).toUpperCase();
}
