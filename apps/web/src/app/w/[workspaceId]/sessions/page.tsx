'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { CHANNELS, PROCESSING_STATUSES, SESSION_STATES } from '@cf/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  SimulatedBadge,
  Table,
  Td,
  Th,
  useToast,
} from '@/components/ui';
import { OverallScore, ProcessingBadge, StateBadge, isProcessing } from '@/components/review/score';
import type { Facets, SessionRow } from '@/components/review/types';
import { download, errorMessage } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

const FILTER_KEYS = [
  'participant',
  'scenarioId',
  'versionId',
  'state',
  'analysisStatus',
  'channel',
  'from',
  'to',
  'minScore',
  'maxScore',
  'courseId',
  'teamId',
  'simulated',
  'needsReview',
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

function toQuery(f: Filters) {
  const q: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (!v) continue;
    // date inputs are YYYY-MM-DD: make "to" inclusive of the whole day
    if (k === 'from') q.from = new Date(`${v}T00:00:00`).toISOString();
    else if (k === 'to') q.to = new Date(`${v}T23:59:59.999`).toISOString();
    else q[k] = v;
  }
  return q;
}

function SessionsList() {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();

  const filters: Filters = useMemo(() => {
    const f: Filters = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [params]);
  const [search, setSearch] = useState(filters.participant ?? '');
  const [exporting, setExporting] = useState(false);
  const [showMore, setShowMore] = useState(
    !!(filters.from || filters.to || filters.minScore || filters.maxScore || filters.courseId || filters.teamId || filters.channel),
  );

  const setFilter = (patch: Filters) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if ('scenarioId' in patch) next.delete('versionId');
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  // Debounced participant search → URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.participant ?? '') !== search.trim()) setFilter({ participant: search.trim() || undefined });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const { data: facets } = useSWR<Facets>(wsPath('/sessions/facets'));
  const query = toQuery(filters);
  const {
    data: pages,
    error,
    size,
    setSize,
    isValidating,
    mutate,
  } = useSWRInfinite<{ data: SessionRow[]; nextCursor: string | null }>(
    (index, prev) => {
      if (prev && !prev.nextCursor) return null;
      return [wsPath('/sessions'), { ...query, limit: 25, cursor: index === 0 ? undefined : prev?.nextCursor ?? undefined }];
    },
    {
      refreshInterval: (latest) => (latest?.some((p) => p.data.some((r) => isProcessing(r.analysisStatus))) ? 5000 : 0),
    },
  );
  const rows = pages?.flatMap((p) => p.data) ?? [];
  const hasMore = !!pages?.[pages.length - 1]?.nextCursor;
  const versions = facets?.scenarios.find((s) => s.id === filters.scenarioId)?.versions ?? [];
  const activeCount = FILTER_KEYS.filter((k) => filters[k]).length;

  return (
    <div>
      <PageHeader
        title="Sessions"
        description="Every conversation in this workspace with its transcript, evidence-based scores and extracted data."
        actions={
          can('exports.download') && (
            <Button
              variant="secondary"
              loading={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await download(wsPath('/sessions/export.csv'), 'sessions.csv', query);
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setExporting(false);
                }
              }}
            >
              Export CSV{activeCount ? ' (filtered)' : ''}
            </Button>
          )
        }
      />

      <section aria-label="Filters" className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Participant">
            {(id) => <Input id={id} type="search" placeholder="Name, email or external id" value={search} onChange={(e) => setSearch(e.target.value)} />}
          </Field>
          <Field label="Scenario">
            {(id) => (
              <Select id={id} value={filters.scenarioId ?? ''} onChange={(e) => setFilter({ scenarioId: e.target.value || undefined })}>
                <option value="">All scenarios</option>
                {facets?.scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Version">
            {(id) => (
              <Select id={id} value={filters.versionId ?? ''} disabled={!filters.scenarioId} onChange={(e) => setFilter({ versionId: e.target.value || undefined })}>
                <option value="">All versions</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.number}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Session state">
            {(id) => (
              <Select id={id} value={filters.state ?? ''} onChange={(e) => setFilter({ state: e.target.value || undefined })}>
                <option value="">Any state</option>
                <option value="COMPLETED,ABANDONED,FAILED">Ended (analyzable)</option>
                {SESSION_STATES.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Analysis">
            {(id) => (
              <Select id={id} value={filters.analysisStatus ?? ''} onChange={(e) => setFilter({ analysisStatus: e.target.value || undefined })}>
                <option value="">Any status</option>
                <option value="QUEUED,PROCESSING">In progress</option>
                {PROCESSING_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {showMore && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Channel">
              {(id) => (
                <Select id={id} value={filters.channel ?? ''} onChange={(e) => setFilter({ channel: e.target.value || undefined })}>
                  <option value="">Any channel</option>
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="From">{(id) => <Input id={id} type="date" value={filters.from ?? ''} onChange={(e) => setFilter({ from: e.target.value || undefined })} />}</Field>
            <Field label="To">{(id) => <Input id={id} type="date" value={filters.to ?? ''} onChange={(e) => setFilter({ to: e.target.value || undefined })} />}</Field>
            <Field label="Min score">
              {(id) => <Input id={id} type="number" min={0} max={100} value={filters.minScore ?? ''} onChange={(e) => setFilter({ minScore: e.target.value || undefined })} />}
            </Field>
            <Field label="Max score">
              {(id) => <Input id={id} type="number" min={0} max={100} value={filters.maxScore ?? ''} onChange={(e) => setFilter({ maxScore: e.target.value || undefined })} />}
            </Field>
            <Field label="Course">
              {(id) => (
                <Select id={id} value={filters.courseId ?? ''} onChange={(e) => setFilter({ courseId: e.target.value || undefined })}>
                  <option value="">Any course</option>
                  {facets?.courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Team">
              {(id) => (
                <Select id={id} value={filters.teamId ?? ''} onChange={(e) => setFilter({ teamId: e.target.value || undefined })}>
                  <option value="">Any team</option>
                  {facets?.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Analysis source">
              {(id) => (
                <Select id={id} value={filters.simulated ?? ''} onChange={(e) => setFilter({ simulated: e.target.value || undefined })}>
                  <option value="">Any</option>
                  <option value="false">AI provider</option>
                  <option value="true">Simulated</option>
                </Select>
              )}
            </Field>
            <Field label="Human review">
              {(id) => (
                <Select id={id} value={filters.needsReview ?? ''} onChange={(e) => setFilter({ needsReview: e.target.value || undefined })}>
                  <option value="">Any</option>
                  <option value="true">Awaiting sign-off</option>
                </Select>
              )}
            </Field>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <Button variant="link" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
            {showMore ? 'Fewer filters' : 'More filters'}
          </Button>
          {activeCount > 0 && (
            <Button
              variant="link"
              onClick={() => {
                setSearch('');
                router.replace(pathname, { scroll: false });
              }}
            >
              Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
            </Button>
          )}
          {isValidating && <span className="text-xs text-slate-400">Refreshing…</span>}
        </div>
      </section>

      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !pages ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          title={activeCount ? 'No sessions match these filters' : 'No sessions yet'}
          description={activeCount ? 'Try removing a filter.' : 'Sessions appear here as soon as participants run a scenario.'}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Participant</Th>
                <Th>Scenario</Th>
                <Th>Channel</Th>
                <Th>State</Th>
                <Th>Duration</Th>
                <Th>Score</Th>
                <Th>Analysis</Th>
                <Th>Date</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={href(`/sessions/${r.id}`)} className="font-medium text-brand-700 hover:underline">
                      {r.participant.name || r.participant.email || r.participant.externalId || 'Anonymous'}
                    </Link>
                    {r.participant.name && r.participant.email && <span className="block text-xs text-slate-500">{r.participant.email}</span>}
                  </Td>
                  <Td>
                    {r.scenario.name} <Badge className="ml-1">v{r.version.number}</Badge>
                  </Td>
                  <Td>{label(r.channel)}</Td>
                  <Td>
                    <StateBadge state={r.state} />
                  </Td>
                  <Td className="tabular-nums">{formatDuration(r.durationMs)}</Td>
                  <Td>
                    {r.insufficientEvidence === null ? (
                      <span className="text-slate-400">—</span>
                    ) : r.overallScore === null ? (
                      <span className="text-xs text-amber-800" title="Not enough evidence in the transcript to compute an overall score">
                        Insufficient evidence
                      </span>
                    ) : (
                      <OverallScore score={r.overallScore} compact />
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      <ProcessingBadge status={r.analysisStatus} title={r.analysisError} />
                      {r.simulated && <SimulatedBadge />}
                      {r.humanReviewRequired && !r.reviewed && <Badge tone="purple">Needs review</Badge>}
                    </div>
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDate(r.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {hasMore && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" loading={isValidating && size > (pages?.length ?? 0)} onClick={() => setSize(size + 1)}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function SessionsPage() {
  const { can } = useWorkspace();
  if (!can('sessions.review')) {
    return <EmptyState title="Not available" description="Reviewing sessions requires the reviewer role or higher." />;
  }
  return (
    <Suspense fallback={<Loading />}>
      <SessionsList />
    </Suspense>
  );
}
