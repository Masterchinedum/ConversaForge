'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { CHANNELS } from '@cf/shared';
import { BarList, LineChart } from '@/components/analytics/charts';
import { RecentSessions } from '@/components/analytics/RecentSessions';
import { formatHours, type AnalyticsSummary, type Breakdown } from '@/components/analytics/types';
import { Alert, Badge, Button, Card, ErrorState, Field, Input, Loading, PageHeader, Select, Stat, Table, Tabs, Td, Th, useToast } from '@/components/ui';
import { download, errorMessage } from '@/lib/api';
import { formatDuration, formatMoneyMicros } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

const PRESETS = [
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: '365', label: 'Last 12 months' },
  { id: 'custom', label: 'Custom range' },
] as const;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function AnalyticsPage() {
  const { wsPath, can, href } = useWorkspace();
  const toast = useToast();
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('30');
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [scenarioId, setScenarioId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [channel, setChannel] = useState('');
  const [breakdown, setBreakdown] = useState<'scenario' | 'learner' | 'team' | 'channel'>('scenario');
  const [exporting, setExporting] = useState(false);

  const query = useMemo(() => {
    const range =
      preset === 'custom'
        ? { from, to }
        : { from: isoDay(new Date(Date.now() - (Number(preset) - 1) * 86_400_000)), to: isoDay(new Date()) };
    return { ...range, scenarioId: scenarioId || undefined, teamId: teamId || undefined, channel: channel || undefined };
  }, [preset, from, to, scenarioId, teamId, channel]);

  const { data, error, isLoading, mutate } = useSWR<AnalyticsSummary>([wsPath('/analytics/summary'), query], { keepPreviousData: true });

  const exportCsv = async () => {
    setExporting(true);
    try {
      await download(wsPath('/analytics/export.csv'), 'sessions.csv', query);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const k = data?.kpis;
  const rows: Breakdown[] = data ? { scenario: data.byScenario, learner: data.byLearner, team: data.byTeam, channel: data.byChannel }[breakdown] : [];
  const own = data?.scope === 'own';

  return (
    <div>
      <PageHeader
        title={own ? 'My practice analytics' : 'Analytics'}
        description={own ? 'Your own sessions in this workspace.' : 'Sessions, completion and scores across the workspace. Averages exclude sessions without enough evidence to score.'}
        actions={
          can('exports.download') && (
            <Button variant="secondary" onClick={exportCsv} loading={exporting}>
              Export CSV
            </Button>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3" role="group" aria-label="Filters">
        <Field label="Period" className="w-44">
          {(id) => (
            <Select id={id} value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {preset === 'custom' && (
          <>
            <Field label="From" className="w-40">
              {(id) => <Input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}
            </Field>
            <Field label="To" className="w-40">
              {(id) => <Input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}
            </Field>
          </>
        )}
        <Field label="Scenario" className="w-56">
          {(id) => (
            <Select id={id} value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
              <option value="">All scenarios</option>
              {data?.options.scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!own && (
          <Field label="Team" className="w-44">
            {(id) => (
              <Select id={id} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">All teams</option>
                {data?.options.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Channel" className="w-44">
          {(id) => (
            <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">All channels</option>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c.replace('_', ' ').toLowerCase()}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {(scenarioId || teamId || channel) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setScenarioId('');
              setTeamId('');
              setChannel('');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {isLoading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data || !k ? null : (
        <div className="space-y-6" aria-busy={isLoading}>
          {k.simulatedSessions > 0 && (
            <Alert tone="warning" title="Includes simulated sessions">
              {k.simulatedSessions} of {k.sessions} sessions ({k.simulatedShare}%) ran on the local simulator — their conversations and scores are not from a real AI provider.
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Sessions" value={k.sessions} hint={`${k.completed} completed`} />
            <Stat label="Completion rate" value={k.completionRate == null ? '—' : `${k.completionRate}%`} hint="of sessions that ended" />
            <Stat
              label="Avg score"
              value={k.avgScore == null ? '—' : k.avgScore}
              hint={`${k.scoredSessions} scored${k.insufficientEvidence ? ` · ${k.insufficientEvidence} insufficient evidence (excluded)` : ''}`}
            />
            <Stat label="Practice time" value={formatHours(k.totalDurationMs)} hint={`avg ${formatDuration(k.avgDurationMs)}`} />
            {!own && <Stat label="Learners" value={k.learners} />}
            {!own && <Stat label="Simulated share" value={k.simulatedShare == null ? '—' : `${k.simulatedShare}%`} />}
            {k.costMicros != null && <Stat label="Usage cost (est.)" value={formatMoneyMicros(k.costMicros)} hint="provider usage in the period" />}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Sessions per day">
              <LineChart label="Sessions" points={data.daily.map((d) => ({ x: d.date, y: d.sessions, note: `${d.completed} completed` }))} />
            </Card>
            <Card title="Average score per day">
              <LineChart
                label="Avg score"
                yMax={100}
                points={data.daily.map((d) => ({ x: d.date, y: d.avgScore, note: d.scored ? `${d.scored} scored session(s)` : 'no scored sessions' }))}
                empty="No scored sessions in this period"
              />
            </Card>
          </div>

          {data.rubric ? (
            <Card title="Rubric dimensions (average score)">
              <BarList
                label="Rubric dimension averages"
                max={100}
                data={data.rubric.map((r) => ({
                  key: r.criterionId,
                  label: r.name,
                  value: r.avgScore,
                  hint: `${r.scored} scored · ${r.insufficient} insufficient evidence`,
                }))}
                empty="No scored criteria for this scenario in the period"
              />
            </Card>
          ) : (
            <p className="text-xs text-slate-500">Choose a scenario to see its rubric dimension averages.</p>
          )}

          <Card title="Breakdown">
            <Tabs
              value={breakdown}
              onChange={setBreakdown}
              tabs={[
                { id: 'scenario', label: 'By scenario' },
                ...(own ? [] : [{ id: 'learner' as const, label: 'Top learners' }, { id: 'team' as const, label: 'By team' }]),
                { id: 'channel', label: 'By channel' },
              ]}
            />
            <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <BarList label="Sessions by group" data={rows.map((r) => ({ key: r.id, label: r.name, value: r.sessions, hint: `${r.completed} completed` }))} empty="No sessions" />
              <Table>
                <thead>
                  <tr>
                    <Th>{breakdown === 'learner' ? 'Learner' : breakdown === 'team' ? 'Team' : breakdown === 'channel' ? 'Channel' : 'Scenario'}</Th>
                    <Th className="text-right">Sessions</Th>
                    <Th className="text-right">Completed</Th>
                    <Th className="text-right">Avg score</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.length === 0 ? (
                    <tr>
                      <Td colSpan={4} className="text-center text-slate-500">
                        No data
                      </Td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r.id}>
                        <Td className="whitespace-normal">
                          {breakdown === 'scenario' ? (
                            <button className="text-left text-brand-700 hover:underline" onClick={() => setScenarioId(r.id)}>
                              {r.name}
                            </button>
                          ) : breakdown === 'team' ? (
                            <button className="text-left text-brand-700 hover:underline" onClick={() => setTeamId(r.id)}>
                              {r.name}
                            </button>
                          ) : (
                            <>
                              {breakdown === 'channel' ? r.name.replace('_', ' ').toLowerCase() : r.name}
                              {r.email && <span className="block text-xs text-slate-500">{r.email}</span>}
                            </>
                          )}
                        </Td>
                        <Td className="text-right tabular-nums">{r.sessions}</Td>
                        <Td className="text-right tabular-nums">{r.completionRate == null ? r.completed : `${r.completed} (${r.completionRate}%)`}</Td>
                        <Td className="text-right tabular-nums">{r.avgScore ?? '—'}</Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </Table>
            </div>
          </Card>

          <Card title="Sessions by state">
            <div className="flex flex-wrap gap-2">
              {data.byState.length === 0 ? (
                <span className="text-sm text-slate-500">No sessions</span>
              ) : (
                data.byState.map((s) => (
                  <Badge key={s.state} tone={s.state === 'COMPLETED' ? 'green' : ['FAILED', 'ABANDONED', 'EXPIRED', 'CANCELLED'].includes(s.state) ? 'red' : 'blue'}>
                    {s.state.toLowerCase()}: {s.count}
                  </Badge>
                ))
              )}
            </div>
          </Card>

          <Card title="Most recent sessions">
            <RecentSessions sessions={data.recentSessions} linkFor={(id) => (can('sessions.review') ? href(`/sessions/${id}`) : `/report/${id}`)} />
          </Card>
        </div>
      )}
    </div>
  );
}
