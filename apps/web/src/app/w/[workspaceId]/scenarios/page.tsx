'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Button, EmptyState, ErrorState, Loading, clsx, useToast } from '@/components/ui';
import { CreateScenarioDialog } from '@/components/scenarios/create-dialog';
import { Icon } from '@/components/scenarios/icons';
import { NewScenarioModal } from '@/components/scenarios/new-scenario';
import type { ScenarioDetail, ScenarioRow } from '@/components/scenarios/types';

type Filter = '' | 'PUBLISHED' | 'DRAFT' | 'ARCHIVED';

/** Scenario Library: a card per scenario, led by "Create Scenario". */
export default function ScenarioLibraryPage() {
  const { wsPath, href, can } = useWorkspace();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<Filter>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const query = { q: debounced, status: filter || undefined, limit: 24 };
  const { data, error, size, setSize, mutate, isLoading } = useSWRInfinite<{ data: ScenarioRow[]; nextCursor: string | null }>((i, prev) =>
    i > 0 && !prev?.nextCursor ? null : [wsPath('/scenarios'), { ...query, cursor: i > 0 ? prev!.nextCursor : undefined }],
  );
  const rows = data?.flatMap((p) => p.data) ?? [];
  const hasMore = !!data?.[data.length - 1]?.nextCursor;

  if (!can('scenarios.edit')) {
    return (
      <EmptyState
        title="Creators only"
        description="Ask an admin for the Creator role to build scenarios. You can still browse the gallery."
        action={
          <Link className="text-brand-700 underline" href={href('/gallery')}>
            Open the gallery
          </Link>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Scenario Library</h1>
        <p className="mt-2 text-sm text-slate-600">Realistic AI roleplay to practise high-stakes conversations.</p>
        <div className="relative mx-auto mt-6 max-w-2xl">
          <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
          <input
            ref={search}
            aria-label="Search scenarios"
            placeholder="Search scenarios… (⌘K)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-11 pr-3 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs" role="group" aria-label="Show">
          {(
            [
              ['', 'All'],
              ['PUBLISHED', 'Published'],
              ['DRAFT', 'Drafts'],
              ['ARCHIVED', 'Archived'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={clsx('rounded-md px-3 py-1', filter === id ? 'bg-slate-200 font-medium text-slate-900' : 'text-slate-600 hover:text-slate-900')}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : isLoading && !data ? (
        <Loading />
      ) : (
        <>
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="scenario-cards">
            {!filter && (
              <li>
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  data-testid="create-scenario"
                  className="flex h-full min-h-[18rem] w-full flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-6 text-center shadow-sm transition hover:border-brand-300 hover:bg-white"
                >
                  <span className="grid h-20 w-20 place-items-center rounded-full border border-slate-200 bg-slate-100 text-brand-600">
                    <Icon name="plus" className="h-8 w-8" />
                  </span>
                  <span className="text-lg font-semibold text-slate-900">Create Scenario</span>
                  <span className="text-sm text-slate-500">Create a new AI scenario</span>
                </button>
              </li>
            )}
            {rows.map((r) => (
              <ScenarioCard key={r.id} row={r} onChanged={() => mutate()} />
            ))}
          </ul>
          {!rows.length && (debounced || filter) && <p className="mt-8 text-center text-sm text-slate-600">No matching scenarios.</p>}
          {hasMore && (
            <div className="mt-6 text-center">
              <Button variant="secondary" onClick={() => setSize(size + 1)}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      <CreateScenarioDialog open={createOpen} onClose={() => setCreateOpen(false)} onTemplates={() => setTemplatesOpen(true)} />
      <NewScenarioModal open={templatesOpen} onClose={() => setTemplatesOpen(false)} wsPath={wsPath} href={href} />
    </div>
  );
}

const cardInitials = (name: string) => (name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || 'SC').toUpperCase();

function ScenarioCard({ row: r, onChanged }: { row: ScenarioRow; onChanged: () => void }) {
  const { wsPath, href } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMenu(false);
    try {
      await fn();
      toast.success(ok);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const status = r.status === 'ARCHIVED' ? 'Archived' : r.latestVersionNumber ? (r.draftHasUnpublishedChanges ? `v${r.latestVersionNumber} · edited` : `v${r.latestVersionNumber}`) : 'Draft';
  return (
    <li className="relative" data-testid="scenario-card">
      <Link href={href(`/scenarios/${r.id}`)} className="flex h-full min-h-[18rem] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-brand-300 hover:shadow-md">
        <span className="relative block h-20 shrink-0 bg-slate-100">
          <span className="absolute left-1/2 top-4 grid h-24 w-24 -translate-x-1/2 place-items-center overflow-hidden rounded-full border-4 border-slate-500/80 bg-slate-200 text-xl font-semibold text-slate-800" style={r.accentColor ? { borderColor: r.accentColor } : undefined}>
            {r.avatarUrl ? <img src={r.avatarUrl} alt="" className="h-full w-full object-cover" /> : cardInitials(r.name)}
          </span>
        </span>
        <span className="flex flex-1 flex-col items-center px-5 pb-5 pt-16 text-center">
          <span className="line-clamp-2 text-base font-semibold text-slate-900">{r.name}</span>
          <span className="mt-3 line-clamp-2 text-sm text-slate-500">{r.publicDescription || 'No description yet'}</span>
          <span className={clsx('mt-auto rounded-full px-2 pt-0.5 text-[11px]', r.status === 'ARCHIVED' ? 'bg-slate-100 text-slate-500' : r.latestVersionNumber ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800')}>{status}</span>
        </span>
      </Link>
      <div className="absolute right-2 top-2">
        <button type="button" aria-label={`Actions for ${r.name}`} aria-expanded={menu} onClick={() => setMenu((v) => !v)} className="grid h-8 w-8 place-items-center rounded-full bg-white/80 text-slate-600 shadow-sm hover:bg-white">
          <Icon name="more" />
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
            <Link role="menuitem" href={href(`/scenarios/${r.id}/studio`)} className="block px-3 py-2 hover:bg-slate-50">
              Edit in Studio
            </Link>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              onClick={() =>
                act(async () => {
                  const d = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body: { source: 'duplicate', scenarioId: r.id } });
                  router.push(href(`/scenarios/${d.scenario.id}/studio`));
                }, 'Duplicated')
              }
            >
              Duplicate
            </button>
            {r.status === 'ARCHIVED' ? (
              <button type="button" role="menuitem" className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => act(() => api(wsPath(`/scenarios/${r.id}/unarchive`), { method: 'POST', body: {} }), 'Restored')}>
                Unarchive
              </button>
            ) : (
              <button type="button" role="menuitem" className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => act(() => api(wsPath(`/scenarios/${r.id}/archive`), { method: 'POST', body: {} }), 'Archived')}>
                Archive
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-red-700 hover:bg-red-50"
              onClick={() => {
                if (!window.confirm(`Delete “${r.name}”? Its sessions and versions are kept.`)) return setMenu(false);
                void act(() => api(wsPath(`/scenarios/${r.id}`), { method: 'DELETE' }), 'Deleted');
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
