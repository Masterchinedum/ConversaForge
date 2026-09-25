'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Button, ButtonLink, EmptyState, ErrorState, Loading, PageHeader, useToast } from '@/components/ui';
import { GalleryCard, GalleryFilters } from '@/components/scenarios/gallery';
import { startSelfRun } from '@/components/scenarios/new-scenario';
import type { GalleryCardData, ScenarioDetail } from '@/components/scenarios/types';

export default function WorkspaceGalleryPage() {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [filters, setFilters] = useState({ q: '', type: '', tag: '' });
  const { data, error, mutate } = useSWR<{ templates: GalleryCardData[]; scenarios: GalleryCardData[] }>([wsPath('/gallery'), filters]);
  const [busy, setBusy] = useState<string | null>(null);
  const canEdit = can('scenarios.edit');

  const create = async (body: Record<string, unknown>, id: string) => {
    setBusy(id);
    try {
      const d = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body });
      router.push(href(`/scenarios/${d.scenario.id}`));
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  const start = async (id: string) => {
    setBusy(id);
    try {
      router.push(await startSelfRun(wsPath, id));
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader title="Gallery & templates" description="Practice scenarios shared in your organization, and starter templates to build your own." />
      <GalleryFilters onChange={setFilters} />
      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">In this workspace</h2>
            {!data.scenarios.length ? (
              <EmptyState title="Nothing shared yet" description="Published scenarios with Organization or Public privacy appear here." />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.scenarios.map((c) => (
                  <GalleryCard
                    key={c.id}
                    card={c}
                    actions={
                      <>
                        {c.published && (
                          <Button size="sm" loading={busy === c.id} onClick={() => start(c.id)}>
                            Start
                          </Button>
                        )}
                        {canEdit && (
                          <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => create({ source: 'duplicate', scenarioId: c.id, name: c.name }, c.id)}>
                            {c.isTemplate ? 'Use template' : 'Duplicate'}
                          </Button>
                        )}
                        {canEdit && (
                          <ButtonLink size="sm" variant="ghost" href={href(`/scenarios/${c.id}`)}>
                            Edit
                          </ButtonLink>
                        )}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </section>
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Starter templates</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.templates.map((c) => (
                <GalleryCard
                  key={c.id}
                  card={c}
                  actions={
                    canEdit ? (
                      <Button size="sm" loading={busy === c.id} onClick={() => create({ source: 'template', templateKey: c.templateKey ?? c.id }, c.id)}>
                        Use template
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-500">Creators can build from this template.</span>
                    )
                  }
                />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
