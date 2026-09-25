'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { PRIVACY, SCENARIO_TYPE_LABELS, SCENARIO_TYPES, type ScenarioType } from '@cf/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Badge, Button, ConfirmButton, EmptyState, ErrorState, Input, Loading, PageHeader, Select, Table, Td, Th, useToast } from '@/components/ui';
import { NewScenarioModal } from '@/components/scenarios/new-scenario';
import { StatusBadge } from '@/components/scenarios/status-badge';
import type { ScenarioDetail, ScenarioRow } from '@/components/scenarios/types';

export default function ScenarioLibraryPage() {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = { q: debounced, type, status, privacy, limit: 25 };
  const { data, error, size, setSize, mutate, isLoading } = useSWRInfinite<{ data: ScenarioRow[]; nextCursor: string | null }>(
    (i, prev) => (i > 0 && !prev?.nextCursor ? null : [wsPath('/scenarios'), { ...query, cursor: i > 0 ? prev!.nextCursor : undefined }]),
  );
  const rows = data?.flatMap((p) => p.data) ?? [];
  const hasMore = !!data?.[data.length - 1]?.nextCursor;

  if (!can('scenarios.edit')) {
    return <EmptyState title="Creators only" description="Ask an admin for the Creator role to build scenarios. You can still browse the gallery." action={<Link className="text-brand-700 underline" href={href('/gallery')}>Open the gallery</Link>} />;
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="Scenarios"
        description="Configure AI conversation agents. Drafts are private until published; every publish creates an immutable version."
        actions={
          <Button onClick={() => setShowNew(true)} data-testid="new-scenario">
            New scenario
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input aria-label="Search scenarios" placeholder="Search name, description, tags…" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Type" className="w-44" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {SCENARIO_TYPES.map((t) => (
            <option key={t} value={t}>
              {SCENARIO_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Active</option>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
          <option value="ARCHIVED">Archived</option>
        </Select>
        <Select aria-label="Privacy" className="w-40" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
          <option value="">Any privacy</option>
          {PRIVACY.map((p) => (
            <option key={p} value={p}>
              {p.toLowerCase()}
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : isLoading && !data ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState
          title={debounced || type || status || privacy ? 'No matching scenarios' : 'No scenarios yet'}
          description="Start from a template, a blank scenario, or import a YAML file."
          action={<Button onClick={() => setShowNew(true)}>New scenario</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Privacy</Th>
                <Th>Sessions</Th>
                <Th>Updated</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td className="max-w-xs whitespace-normal">
                    <Link href={href(`/scenarios/${r.id}`)} className="font-medium text-brand-700 hover:underline">
                      {r.name}
                    </Link>
                    {r.isTemplate && <Badge className="ml-1" tone="purple">Template</Badge>}
                    {r.tags.length > 0 && <p className="text-xs text-slate-500">{r.tags.join(' · ')}</p>}
                  </Td>
                  <Td>{SCENARIO_TYPE_LABELS[r.type as ScenarioType] ?? r.type}</Td>
                  <Td>
                    <StatusBadge row={r} />
                  </Td>
                  <Td className="text-xs">{r.privacy.toLowerCase()}</Td>
                  <Td>{r.sessionCount ?? 0}</Td>
                  <Td className="text-xs">{formatDate(r.updatedAt)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          act(async () => {
                            const d = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body: { source: 'duplicate', scenarioId: r.id } });
                            router.push(href(`/scenarios/${d.scenario.id}`));
                          }, 'Duplicated')
                        }
                      >
                        Duplicate
                      </Button>
                      {r.status === 'ARCHIVED' ? (
                        <Button variant="ghost" size="sm" onClick={() => act(() => api(wsPath(`/scenarios/${r.id}/unarchive`), { method: 'POST', body: {} }), 'Restored')}>
                          Unarchive
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => act(() => api(wsPath(`/scenarios/${r.id}/archive`), { method: 'POST', body: {} }), 'Archived')}>
                          Archive
                        </Button>
                      )}
                      <ConfirmButton
                        variant="ghost"
                        size="sm"
                        className="text-red-700"
                        confirmText={`Delete “${r.name}”? Past sessions keep their data.`}
                        onConfirm={() => act(() => api(wsPath(`/scenarios/${r.id}`), { method: 'DELETE' }), 'Deleted')}
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {hasMore && (
            <div className="mt-3 text-center">
              <Button variant="secondary" onClick={() => setSize(size + 1)}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      <NewScenarioModal open={showNew} onClose={() => setShowNew(false)} wsPath={wsPath} href={href} />
    </div>
  );
}
