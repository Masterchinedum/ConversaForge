'use client';
import { useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { MemoryPanel } from '@/components/learning/MemoryPanel';
import { Badge, Button, EmptyState, ErrorState, Input, Loading, PageHeader, Table, Td, Th } from '@/components/ui';
import { fetcher } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';

interface LearnerRow {
  participantId: string;
  name: string | null;
  email: string | null;
  hasAccount: boolean;
  sessionCount: number;
  activeFacts: number;
  disabledFacts: number;
  memoryEnabled: boolean;
  goals: string | null;
}

/** Reviewer coach dashboard: learners with memory counts; open one to inspect, disable or clear memory. */
export default function CoachDashboardPage() {
  const { wsPath, can } = useWorkspace();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<LearnerRow | null>(null);
  const getKey = (i: number, prev: { data: LearnerRow[]; nextCursor: string | null } | null) => {
    if (prev && !prev.nextCursor) return null;
    return [wsPath('/coach/learners'), { q: q || undefined, limit: 50, cursor: prev?.nextCursor ?? undefined }] as const;
  };
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<{ data: LearnerRow[]; nextCursor: string | null }>(getKey as any, fetcher as any);
  const rows = data?.flatMap((p) => p.data) ?? [];
  const hasMore = !!data?.[data.length - 1]?.nextCursor;

  if (!can('memory.manage')) return <EmptyState title="Not available" description="You need reviewer access to manage learner memory." />;

  return (
    <div>
      <PageHeader
        title="Coach memory"
        description="Facts coaching agents remember about each learner (scoped to this workspace). Changes you make to another learner's memory are recorded in the audit log."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-3">
          <label className="sr-only" htmlFor="learner-search">
            Search learners
          </label>
          <Input id="learner-search" placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} retry={() => mutate()} />
          ) : rows.length === 0 ? (
            <EmptyState title="No learners" description="Learners appear once they have a session or enrollment in this workspace." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Learner</Th>
                  <Th className="text-right">Sessions</Th>
                  <Th className="text-right">Facts</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr
                    key={r.participantId}
                    className={`cursor-pointer hover:bg-slate-50 ${selected?.participantId === r.participantId ? 'bg-brand-50' : ''}`}
                    onClick={() => setSelected(r)}
                  >
                    <Td className="whitespace-normal">
                      <button className="text-left" onClick={() => setSelected(r)} aria-label={`Open memory for ${r.name ?? r.email ?? 'learner'}`}>
                        <span className="font-medium text-slate-900">{r.name ?? r.email ?? 'Anonymous'}</span>
                        {r.name && r.email && <span className="block text-xs text-slate-500">{r.email}</span>}
                      </button>
                      {!r.memoryEnabled && (
                        <Badge tone="yellow" className="ml-1">
                          memory off
                        </Badge>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{r.sessionCount}</Td>
                    <Td className="text-right tabular-nums">
                      {r.activeFacts}
                      {r.disabledFacts > 0 && <span className="text-xs text-slate-500"> (+{r.disabledFacts} off)</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {hasMore && (
            <Button variant="secondary" size="sm" onClick={() => setSize(size + 1)}>
              Load more
            </Button>
          )}
        </div>
        <div>
          {selected ? (
            <div className="space-y-2">
              <h2 className="text-base font-semibold text-slate-900">{selected.name ?? selected.email ?? 'Anonymous learner'}</h2>
              <MemoryPanel key={selected.participantId} basePath={wsPath(`/coach/learners/${selected.participantId}`)} self={false} onChanged={() => mutate()} />
            </div>
          ) : (
            <EmptyState title="Select a learner" description="Open a learner to inspect, disable or clear what coaches remember about them." />
          )}
        </div>
      </div>
    </div>
  );
}
