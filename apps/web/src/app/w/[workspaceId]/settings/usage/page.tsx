'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { USAGE_KINDS } from '@cf/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
  Stat,
  Table,
  Td,
  Th,
  useToast,
} from '@/components/ui';
import { api, download, errorMessage } from '@/lib/api';
import { formatDate, formatDuration, formatMoneyMicros } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

const METRICS = {
  session_minutes: { label: 'Session minutes', unit: 'min', toInput: (v: number) => v, fromInput: (v: number) => v },
  cost_micros: { label: 'Estimated AI cost', unit: 'USD', toInput: (v: number) => v / 1_000_000, fromInput: (v: number) => Math.round(v * 1_000_000) },
  sessions: { label: 'Sessions', unit: 'sessions', toInput: (v: number) => v, fromInput: (v: number) => v },
  storage_bytes: { label: 'Storage', unit: 'GB', toInput: (v: number) => v / 1e9, fromInput: (v: number) => Math.round(v * 1e9) },
  telephony_minutes: { label: 'Phone minutes', unit: 'min', toInput: (v: number) => v, fromInput: (v: number) => v },
} as const;
type Metric = keyof typeof METRICS;

function fmtMetric(metric: string, v: number) {
  switch (metric) {
    case 'cost_micros':
      return formatMoneyMicros(v);
    case 'storage_bytes':
      return `${(v / 1e9).toFixed(2)} GB`;
    case 'session_minutes':
    case 'telephony_minutes':
      return `${v.toFixed(1)} min`;
    default:
      return Math.round(v).toLocaleString();
  }
}

interface Summary {
  period: string;
  totals: Record<Metric, number>;
  byKind: Array<{ kind: string; quantity: number; costMicros: number }>;
  byProvider: Array<{ provider: string; entries: number; costMicros: number }>;
  quotas: Array<{ id: string; metric: Metric; limitValue: number; alertThresholdPct: number; hardLimit: boolean; used: number; pct: number | null }>;
  openAlerts: number;
  topSessions: Array<{ sessionId: string; costMicros: number; scenarioName: string | null; participant: string | null; createdAt: string | null; durationMs: number | null }>;
  daily: Array<{ day: string; costMicros: number; entries: number }>;
}

export default function UsagePage() {
  const { wsPath, can } = useWorkspace();
  const summary = useSWR<Summary>(can('usage.view') ? wsPath('/usage/summary') : null);
  if (!can('usage.view')) return <Alert tone="warning">Only admins can view usage.</Alert>;
  if (summary.error) return <ErrorState error={summary.error} retry={() => summary.mutate()} />;
  if (!summary.data) return <Loading />;
  const s = summary.data;
  return (
    <div className="space-y-6">
      <PageHeader title="Usage & quotas" description={`Current period ${s.period} (UTC calendar month). Costs are estimates from list prices.`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions" value={s.totals.sessions.toLocaleString()} />
        <Stat label="Session minutes" value={s.totals.session_minutes.toFixed(1)} />
        <Stat label="Estimated AI cost" value={formatMoneyMicros(s.totals.cost_micros)} />
        <Stat label="Storage" value={`${(s.totals.storage_bytes / 1e9).toFixed(2)} GB`} hint={s.totals.telephony_minutes ? `${s.totals.telephony_minutes.toFixed(1)} phone min` : undefined} />
      </div>
      <AlertsCard onChange={() => summary.mutate()} />
      <QuotasCard summary={s} onChange={() => summary.mutate()} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Daily estimated cost (last 30 days)">
          <DailyBars data={s.daily} />
        </Card>
        <Card title="By provider (this month)">
          {!s.byProvider.length ? (
            <p className="text-sm text-slate-500">No usage recorded yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Provider</Th>
                  <Th className="text-right">Entries</Th>
                  <Th className="text-right">Est. cost</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {s.byProvider.map((p) => (
                  <tr key={p.provider}>
                    <Td>
                      {p.provider} {p.provider === 'simulator' && <Badge tone="yellow">simulated</Badge>}
                    </Td>
                    <Td className="text-right tabular-nums">{p.entries}</Td>
                    <Td className="text-right tabular-nums">{formatMoneyMicros(p.costMicros)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By kind (this month)">
          {!s.byKind.length ? (
            <p className="text-sm text-slate-500">No usage recorded yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Kind</Th>
                  <Th className="text-right">Quantity</Th>
                  <Th className="text-right">Est. cost</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {s.byKind.map((k) => (
                  <tr key={k.kind}>
                    <Td>{k.kind.toLowerCase().replace(/_/g, ' ')}</Td>
                    <Td className="text-right tabular-nums">{Math.round(k.quantity).toLocaleString()}</Td>
                    <Td className="text-right tabular-nums">{formatMoneyMicros(k.costMicros)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Most expensive sessions (this month)">
          {!s.topSessions.length ? (
            <p className="text-sm text-slate-500">No per-session costs yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Session</Th>
                  <Th>Duration</Th>
                  <Th className="text-right">Est. cost</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {s.topSessions.map((t) => (
                  <tr key={t.sessionId}>
                    <Td className="max-w-[220px] truncate">
                      {t.scenarioName ?? t.sessionId}
                      <span className="block text-xs text-slate-500">
                        {t.participant} · {formatDate(t.createdAt)}
                      </span>
                    </Td>
                    <Td>{formatDuration(t.durationMs)}</Td>
                    <Td className="text-right tabular-nums">{formatMoneyMicros(t.costMicros)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <LedgerCard />
      <BillingCard />
    </div>
  );
}

/** Single-series bar chart (brand hue), per-bar hover tooltip + an equivalent data table for screen readers. */
function DailyBars({ data }: { data: Summary['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <p className="text-sm text-slate-500">No usage in the last 30 days.</p>;
  const max = Math.max(...data.map((d) => d.costMicros), 1);
  const day = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <figure>
      <div className="relative">
        <div className="flex h-40 items-end gap-[2px] border-b border-slate-200" aria-hidden>
          {data.map((d, i) => (
            <div key={d.day} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <div
                className={`w-full rounded-t ${hover === i ? 'bg-brand-700' : 'bg-brand-600'}`}
                style={{ height: `${Math.max(2, (d.costMicros / max) * 100)}%` }}
              />
            </div>
          ))}
        </div>
        {hover != null && data[hover] && (
          <div className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-2 py-1 text-xs text-white shadow">
            {day(data[hover]!.day)} · {formatMoneyMicros(data[hover]!.costMicros)} · {data[hover]!.entries} entries
          </div>
        )}
      </div>
      <figcaption className="mt-1 flex justify-between text-xs text-slate-500">
        <span>{day(data[0]!.day)}</span>
        <span>max {formatMoneyMicros(max)}/day</span>
        <span>{day(data[data.length - 1]!.day)}</span>
      </figcaption>
      <table className="sr-only">
        <caption>Daily estimated cost</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <td>{day(d.day)}</td>
              <td>{formatMoneyMicros(d.costMicros)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function QuotasCard({ summary, onChange }: { summary: Summary; onChange: () => void }) {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const [metric, setMetric] = useState<Metric>('session_minutes');
  const [limit, setLimit] = useState('');
  const [threshold, setThreshold] = useState('80');
  const [hard, setHard] = useState(true);
  const manage = can('usage.manage');
  return (
    <Card title="Monthly quotas">
      {!summary.quotas.length ? (
        <p className="mb-3 text-sm text-slate-500">No quotas set — usage is unlimited.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {summary.quotas.map((q) => {
            const pct = Math.min(100, q.pct ?? 0);
            const tone = (q.pct ?? 0) >= 100 ? 'bg-red-600' : (q.pct ?? 0) >= q.alertThresholdPct ? 'bg-amber-500' : 'bg-brand-600';
            return (
              <li key={q.id}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {METRICS[q.metric]?.label ?? q.metric} <Badge tone={q.hardLimit ? 'red' : 'gray'}>{q.hardLimit ? 'hard limit' : 'soft limit'}</Badge>
                  </span>
                  <span className="tabular-nums text-slate-600">
                    {fmtMetric(q.metric, q.used)} / {fmtMetric(q.metric, q.limitValue)} ({q.pct ?? 0}%) · alert at {q.alertThresholdPct}%
                    {manage && (
                      <ConfirmButton
                        variant="link"
                        className="ml-3 text-xs text-red-700"
                        confirmText="Remove this quota?"
                        onConfirm={async () => {
                          await api(wsPath(`/quotas/${q.id}`), { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                          onChange();
                        }}
                      >
                        remove
                      </ConfirmButton>
                    )}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${q.metric} usage`}>
                  <div className={`h-2 rounded-full ${tone}`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {manage ? (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(wsPath('/quotas'), {
                method: 'PUT',
                body: { metric, limitValue: METRICS[metric].fromInput(Number(limit)), alertThresholdPct: Number(threshold), hardLimit: hard },
              });
              setLimit('');
              toast.success('Quota saved');
              onChange();
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <Field label="Metric">
            {(id) => (
              <Select id={id} value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
                {(Object.keys(METRICS) as Metric[]).map((m) => (
                  <option key={m} value={m}>
                    {METRICS[m].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={`Monthly limit (${METRICS[metric].unit})`}>{(id) => <Input id={id} type="number" min={0} step="any" required value={limit} onChange={(e) => setLimit(e.target.value)} className="w-40" />}</Field>
          <Field label="Alert at (%)">{(id) => <Input id={id} type="number" min={1} max={100} required value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-24" />}</Field>
          <div className="pb-2">
            <Checkbox label="Hard limit (block new sessions)" checked={hard} onChange={setHard} />
          </div>
          <Button type="submit">Save quota</Button>
        </form>
      ) : (
        <p className="text-xs text-slate-500">Only owners can change quotas.</p>
      )}
    </Card>
  );
}

function AlertsCard({ onChange }: { onChange: () => void }) {
  const { wsPath } = useWorkspace();
  const { data, mutate } = useSWR<{ data: Array<{ id: string; metric: string; periodKey: string; thresholdPct: number; valueAtTrigger: number; acknowledgedAt: string | null; createdAt: string }> }>(
    wsPath('/usage/alerts'),
  );
  const open = data?.data.filter((a) => !a.acknowledgedAt) ?? [];
  if (!open.length) return null;
  return (
    <div className="space-y-2">
      {open.map((a) => (
        <Alert key={a.id} tone={a.thresholdPct >= 100 ? 'error' : 'warning'} title={`${a.thresholdPct >= 100 ? 'Limit reached' : `${a.thresholdPct}% of limit`}: ${a.metric.replace(/_/g, ' ')} (${a.periodKey})`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Value when triggered: {fmtMetric(a.metric, a.valueAtTrigger)} · {formatDate(a.createdAt)}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await api(wsPath(`/usage/alerts/${a.id}/acknowledge`), { method: 'POST' });
                mutate();
                onChange();
              }}
            >
              Acknowledge
            </Button>
          </div>
        </Alert>
      ))}
    </div>
  );
}

function LedgerCard() {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const [filters, setFilters] = useState({ kind: '', provider: '', sessionId: '', from: '', to: '' });
  const [cursor, setCursor] = useState<string | undefined>();
  const query = {
    kind: filters.kind || undefined,
    provider: filters.provider || undefined,
    sessionId: filters.sessionId || undefined,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
  };
  const { data, error } = useSWR<{ data: Array<{ id: string; sessionId: string | null; kind: string; provider: string; model: string | null; quantity: number; unit: string; costMicros: number; createdAt: string }>; nextCursor: string | null }>(
    [wsPath('/usage/ledger'), { ...query, limit: 50, cursor }],
  );
  const set = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setCursor(undefined);
  };
  return (
    <Card
      title="Usage ledger"
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => download(wsPath('/usage/export.csv'), 'usage.csv', query).catch((e) => toast.error(errorMessage(e)))}
        >
          Export CSV
        </Button>
      }
    >
      <div className="mb-3 grid gap-2 sm:grid-cols-5">
        <Field label="Kind">
          {(id) => (
            <Select id={id} value={filters.kind} onChange={(e) => set('kind', e.target.value)}>
              <option value="">All</option>
              {USAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.toLowerCase().replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Provider">{(id) => <Input id={id} value={filters.provider} placeholder="anthropic" onChange={(e) => set('provider', e.target.value.trim())} />}</Field>
        <Field label="Session id">{(id) => <Input id={id} value={filters.sessionId} onChange={(e) => set('sessionId', e.target.value.trim())} />}</Field>
        <Field label="From">{(id) => <Input id={id} type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />}</Field>
      </div>
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <Loading />
      ) : !data.data.length ? (
        <EmptyState title="No usage entries match" />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Kind</Th>
                <Th>Provider / model</Th>
                <Th className="text-right">Quantity</Th>
                <Th className="text-right">Est. cost</Th>
                <Th>Session</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.data.map((r) => (
                <tr key={r.id}>
                  <Td>{formatDate(r.createdAt)}</Td>
                  <Td>{r.kind.toLowerCase().replace(/_/g, ' ')}</Td>
                  <Td>
                    {r.provider}
                    {r.model ? <span className="text-xs text-slate-500"> · {r.model}</span> : null}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {Math.round(r.quantity * 100) / 100} {r.unit}
                  </Td>
                  <Td className="text-right tabular-nums">{formatMoneyMicros(r.costMicros)}</Td>
                  <Td>
                    {r.sessionId ? (
                      <button className="text-xs text-brand-700 hover:underline" onClick={() => set('sessionId', r.sessionId!)}>
                        {r.sessionId.slice(-8)}
                      </button>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-2 flex justify-end gap-2">
            {cursor && (
              <Button variant="secondary" size="sm" onClick={() => setCursor(undefined)}>
                First page
              </Button>
            )}
            {data.nextCursor && (
              <Button variant="secondary" size="sm" onClick={() => setCursor(data.nextCursor!)}>
                Next page
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function BillingCard() {
  const { wsPath } = useWorkspace();
  const { data } = useSWR<{ provider: string; configured: boolean; message: string; plan: string; status: string; portalUrl: string | null }>(wsPath('/billing'));
  if (!data) return null;
  return (
    <Card title="Billing">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div>
          <p>
            Plan: <strong>{data.plan}</strong> · status {data.status} · provider <code>{data.provider}</code>{' '}
            {!data.configured && <Badge tone="yellow">not configured</Badge>}
          </p>
          <p className="mt-1 text-slate-600">{data.message}</p>
        </div>
        {data.portalUrl && (
          <a className="text-brand-700 hover:underline" href={data.portalUrl} target="_blank" rel="noreferrer">
            Manage billing
          </a>
        )}
      </div>
    </Card>
  );
}
