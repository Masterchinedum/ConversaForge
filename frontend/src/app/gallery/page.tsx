'use client';
import { useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { Button, ButtonLink, EmptyState, ErrorState, Loading } from '@/components/ui';
import { GalleryCard, GalleryFilters } from '@/components/scenarios/gallery';
import type { GalleryCardData } from '@/components/scenarios/types';

type Page = { templates: GalleryCardData[]; data: GalleryCardData[]; nextCursor: string | null };

export default function PublicGalleryPage() {
  const [filters, setFilters] = useState({ q: '', type: '', tag: '' });
  const { data, error, size, setSize, mutate } = useSWRInfinite<Page>((i, prev) =>
    i > 0 && !prev?.nextCursor ? null : ['/gallery', { ...filters, limit: 24, cursor: i > 0 ? prev!.nextCursor : undefined }],
  );
  const templates = data?.[0]?.templates ?? [];
  const scenarios = data?.flatMap((p) => p.data) ?? [];
  const hasMore = !!data?.[data.length - 1]?.nextCursor;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Practice conversations with AI</h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-slate-600">Public scenarios you can try right away, and templates to build your own interview, sales, negotiation, leadership, support and coaching practice.</p>
      <GalleryFilters onChange={setFilters} />
      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="space-y-10">
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Public scenarios</h2>
            {!scenarios.length ? (
              <EmptyState title="No public scenarios match" description="Try another search, or start from a template below." />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {scenarios.map((c) => (
                  <GalleryCard
                    key={c.id}
                    card={c}
                    href={`/gallery/${c.id}`}
                    actions={
                      <>
                        <ButtonLink size="sm" href={`/p/${c.id}`}>
                          Start
                        </ButtonLink>
                        <ButtonLink size="sm" variant="ghost" href={`/gallery/${c.id}`}>
                          Details
                        </ButtonLink>
                      </>
                    }
                  />
                ))}
              </div>
            )}
            {hasMore && (
              <div className="mt-4 text-center">
                <Button variant="secondary" onClick={() => setSize(size + 1)}>
                  Load more
                </Button>
              </div>
            )}
          </section>
          {templates.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Templates</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((c) => (
                  <GalleryCard
                    key={c.id}
                    card={c}
                    href={`/gallery/templates/${c.templateKey ?? c.id}`}
                    actions={
                      <ButtonLink size="sm" variant="secondary" href={`/gallery/templates/${c.templateKey ?? c.id}`}>
                        Use template
                      </ButtonLink>
                    }
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
