'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { ApiError, download, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Button, Input, Loading, Select, clsx, useToast } from '@/components/ui';
import { Icon } from './icons';

const RANGES = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: '365', label: 'Last 12 months', days: 365 },
] as const;
const fromFor = (id: string) => new Date(Date.now() - (RANGES.find((r) => r.id === id)?.days ?? 30) * 86400_000).toISOString();

interface SessionRow {
  id: string;
  participant: { id: string; name: string | null; email: string | null } | null;
  version: { id: string; number: number };
  state: string;
  durationMs: number | null;
  overallScore: number | null;
  createdAt: string;
}

const STATUS_FILTERS = [
  { id: '', label: 'All Status' },
  { id: 'COMPLETED', label: 'Completed' },
  { id: 'ACTIVE,CONNECTING,READY,CREATED,PAUSED,RECONNECTING,ENDING', label: 'In progress' },
  { id: 'FAILED,CANCELLED,EXPIRED,ABANDONED', label: 'Ended early' },
];

export const fmtMinutes = (ms: number | null | undefined) => (ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);

/** Sessions of one scenario: search, status and date filters, CSV export. */
export function SessionsTab({ scenarioId, scenarioName }: { scenarioId: string; scenarioName: string }) {
  const { wsPath, href, can } = useWorkspace();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [range, setRange] = useState('30');
  const from = useMemo(() => fromFor(range), [range]);
  const query = { scenarioId, participant: q.trim() || undefined, state: state || undefined, from, limit: 25 };
  const { data, error, size, setSize, mutate, isLoading } = useSWRInfinite<{ data: SessionRow[]; nextCursor: string | null }>((i, prev) =>
    i > 0 && !prev?.nextCursor ? null : [wsPath('/sessions'), { ...query, cursor: i > 0 ? prev!.nextCursor : undefined }],
  );
  const rows = data?.flatMap((p) => p.data) ?? [];
  const hasMore = !!data?.[data.length - 1]?.nextCursor;

  if (!can('sessions.review')) return <Alert tone="info">Your role cannot review sessions.</Alert>;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="sessions-tab">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-brand-700">Sessions for {scenarioName}</h2>
        <button type="button" onClick={() => mutate()} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Refresh" title="Refresh">
          <Icon name="undo" className="h-4 w-4 -scale-x-100" />
        </button>
      </div>
      <div className="relative mb-3">
        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input aria-label="Search sessions" placeholder="Search by name, email…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Status" className="w-44" value={state} onChange={(e) => setState(e.target.value)}>
          {STATUS_FILTERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Date range" className="w-44" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
        {can('exports.download') && (
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => download(wsPath('/sessions/export.csv'), `sessions-${scenarioId}.csv`, { scenarioId, state: state || undefined, from, participant: q.trim() || undefined }).catch((e) => toast.error(errorMessage(e)))}
          >
            <Icon name="download" className="h-4 w-4" /> Export CSV
          </Button>
        )}
      </div>
      {error ? (
        <Alert tone="error">{error instanceof ApiError && error.status === 403 ? 'Your role cannot review sessions.' : errorMessage(error)}</Alert>
      ) : isLoading && !data ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-brand-700">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Score</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!rows.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-600">
                    <p>No sessions found for {scenarioName}.</p>
                    <p className="mt-1 text-xs text-slate-500">Share it, embed it, or send it to a phone number or meeting from the Channels above; sessions appear here automatically.</p>
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <Link href={href(`/sessions/${r.id}`)} className="font-medium text-brand-700 hover:underline">
                      {r.participant?.name || 'Anonymous'}
                    </Link>
                    {r.state !== 'COMPLETED' && <span className="ml-2 text-xs text-slate-500">{r.state.toLowerCase()}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{r.participant?.email ?? '—'}</td>
                  <td className="px-4 py-2.5 tabular-nums">{r.overallScore == null ? '—' : Math.round(r.overallScore)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{formatDate(r.createdAt)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-600">{fmtMinutes(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <div className="mt-3 text-center">
          <Button variant="secondary" size="sm" onClick={() => setSize(size + 1)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

interface Summary {
  kpis: { sessions: number; totalDurationMs: number; avgScore: number | null };
  daily: Array<{ date: string; sessions: number }>;
  byLearner: Array<{ id: string; name: string; email?: string | null; sessions: number; avgScore: number | null }>;
}

const BUCKETS = [
  { label: '< 2 min', max: 2 },
  { label: '2–5', max: 5 },
  { label: '5–10', max: 10 },
  { label: '10–20', max: 20 },
  { label: '20+ min', max: Infinity },
];

/** Totals, daily sessions, duration distribution and top scorers for one scenario. */
export function AnalyticsTab({ scenarioId }: { scenarioId: string }) {
  const { wsPath, can } = useWorkspace();
  const [range, setRange] = useState('30');
  const from = useMemo(() => fromFor(range), [range]);
  const label = RANGES.find((r) => r.id === range)!.label;
  const { data, error } = useSWR<Summary>(can('analytics.view') ? [wsPath('/analytics/summary'), { scenarioId, from, top: 10 }] : null);
  const { data: sessions } = useSWR<{ data: SessionRow[] }>(can('sessions.review') ? [wsPath('/sessions'), { scenarioId, from, limit: 100 }] : null);

  const durations = useMemo(() => {
    const counts = BUCKETS.map(() => 0);
    for (const s of sessions?.data ?? []) {
      if (s.durationMs == null) continue;
      const min = s.durationMs / 60_000;
      counts[BUCKETS.findIndex((b) => min < b.max)]! += 1;
    }
    return BUCKETS.map((b, i) => ({ label: b.label, value: counts[i]! }));
  }, [sessions]);

  if (!can('analytics.view')) return <Alert tone="info">Your role cannot view analytics.</Alert>;
  if (error) return <Alert tone="error">{errorMessage(error)}</Alert>;

  const scorers = (data?.byLearner ?? []).filter((l) => l.avgScore != null).sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0)).slice(0, 10);
  const hasDurations = durations.some((d) => d.value > 0);

  return (
    <div className="space-y-5" data-testid="analytics-tab">
      <div className="flex justify-end">
        <Select aria-label="Date range" className="w-44" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Kpi icon="users" label="Total Sessions" value={String(data.kpis.sessions)} />
            <Kpi icon="clock" label="Total Time" value={`${Math.round((data.kpis.totalDurationMs || 0) / 60_000)} min`} />
          </div>
          <ChartCard title={`Daily Sessions (${label})`}>
            {data.daily.some((d) => d.sessions > 0) ? (
              <BarChart data={data.daily.map((d) => ({ label: d.date.slice(5), value: d.sessions, tip: `${d.date}: ${d.sessions} session${d.sessions === 1 ? '' : 's'}` }))} unit="sessions" />
            ) : (
              <Empty text="No session data available for this period" />
            )}
          </ChartCard>
          <ChartCard title={`Session Duration Distribution (${label})`} note={(sessions?.data.length ?? 0) >= 100 ? 'Latest 100 sessions' : undefined}>
            {hasDurations ? <BarChart data={durations.map((d) => ({ label: d.label, value: d.value, tip: `${d.label}: ${d.value} session${d.value === 1 ? '' : 's'}` }))} unit="sessions" wide /> : <Empty text="No duration data available for this period" />}
          </ChartCard>
          <ChartCard title={`Top Scorers (${label})`}>
            {scorers.length ? (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1.5 font-medium">Participant</th>
                    <th className="py-1.5 font-medium">Sessions</th>
                    <th className="py-1.5 text-right font-medium">Average score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {scorers.map((l) => (
                    <tr key={l.id}>
                      <td className="py-2">
                        {l.name}
                        {l.email && <span className="ml-2 text-xs text-slate-500">{l.email}</span>}
                      </td>
                      <td className="py-2 tabular-nums">{l.sessions}</td>
                      <td className="py-2 text-right font-medium tabular-nums">{l.avgScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-slate-600">No scored sessions for this period</p>
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: 'users' | 'clock'; label: string; value: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <span className="grid h-11 w-11 place-items-center rounded-lg bg-brand-50 text-brand-700">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span>
        <span className="block text-sm text-slate-600">{label}</span>
        <span className="block text-2xl font-semibold tabular-nums text-slate-900">{value}</span>
      </span>
    </div>
  );
}

function ChartCard({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-brand-700">{title}</h3>
        {note && <span className="text-xs text-slate-500">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-16 text-center text-sm text-slate-600">{text}</p>;
}

/** Single-series bar chart: thin bars rounded at the data end, recessive axis, hover tooltip, table for screen readers. */
function BarChart({ data, unit, wide }: { data: Array<{ label: string; value: number; tip: string }>; unit: string; wide?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const H = 180;
  const every = Math.max(1, Math.ceil(data.length / 10));
  return (
    <div className="pt-4">
      <div className="relative flex items-end gap-[2px] border-b border-slate-200" style={{ height: H }} aria-hidden>
        <span className="absolute -top-4 left-0 text-[10px] text-slate-400">max {max}</span>
        {data.map((d, i) => (
          <div key={i} className="relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className={clsx('rounded-t bg-brand-600 transition-opacity', hover !== null && hover !== i && 'opacity-50', wide ? 'w-1/2' : 'w-full max-w-[14px]')} style={{ height: d.value ? Math.max(3, (d.value / max) * (H - 12)) : 0 }} />
            {hover === i && <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white shadow">{d.tip}</div>}
          </div>
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-slate-500" aria-hidden>
        {data.map((d, i) =>
          i % every === 0 ? (
            <span key={i} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / data.length) * 100}%` }}>
              {d.label}
            </span>
          ) : null,
        )}
      </div>
      <table className="sr-only">
        <caption>{unit}</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <th>{d.label}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
