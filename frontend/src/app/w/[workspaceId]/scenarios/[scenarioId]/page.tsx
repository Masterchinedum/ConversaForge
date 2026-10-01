'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import type { ScenarioConfig } from '@/shared';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { EmptyState, ErrorState, Loading, clsx, useToast } from '@/components/ui';
import { ChannelCards } from '@/components/scenarios/channels';
import { AnalyticsTab, SessionsTab } from '@/components/scenarios/detail-tabs';
import { Icon, type IconName } from '@/components/scenarios/icons';
import { Markdown } from '@/components/scenarios/markdown';
import { startSelfRun } from '@/components/scenarios/new-scenario';
import { StatusBadge } from '@/components/scenarios/status-badge';
import type { ScenarioDetail } from '@/components/scenarios/types';

type Tab = 'details' | 'sessions' | 'analytics';

/** The scenario page: Join / Edit / Share, channels, and Details · Sessions · Analytics. */
export default function ScenarioPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('details');
  const [menu, setMenu] = useState(false);
  const [joining, setJoining] = useState(false);
  const key = wsPath(`/scenarios/${scenarioId}`);
  const { data: d, error, mutate } = useSWR<ScenarioDetail>(can('scenarios.edit') ? key : null);
  const versionId = d?.scenario.latestVersionId;
  const { data: version } = useSWR<{ version: number; config: ScenarioConfig }>(versionId ? `${key}/versions/${versionId}` : null);

  if (!can('scenarios.edit')) return <ErrorState error={new Error('Only creators can manage scenarios.')} />;
  if (error instanceof ApiError && error.status === 404)
    return (
      <EmptyState
        title="Scenario not found"
        description="It may have been deleted, or it belongs to another workspace."
        action={
          <Link className="text-brand-700 hover:underline" href={href('/scenarios')}>
            Back to scenarios
          </Link>
        }
      />
    );
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!d) return <Loading />;

  const s = d.scenario;
  const published = !!s.latestVersionId && s.status === 'PUBLISHED';
  // Details show what participants get: the published version, or the draft until there is one.
  const cfg = (published && version ? version.config : d.draft.config) as ScenarioConfig;

  const join = async () => {
    setJoining(true);
    try {
      router.push(await startSelfRun(wsPath, s.id));
    } catch (e) {
      toast.error(errorMessage(e));
      setJoining(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMenu(false);
    try {
      await fn();
      toast.success(ok);
      mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const btn = 'inline-flex items-center gap-2 rounded-md border-2 border-brand-200 bg-white px-5 py-1.5 text-sm font-medium text-brand-700 hover:border-brand-400 disabled:border-slate-200 disabled:text-slate-400';

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="scenario-page">
      <div className="space-y-3">
        <Link href={href('/scenarios')} className="text-xs text-slate-500 hover:text-slate-800">
          ← Scenario library
        </Link>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl" data-testid="scenario-title">
          {s.name}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <StatusBadge row={{ ...s, draftHasUnpublishedChanges: d.draftHasUnpublishedChanges }} />
          {d.latestVersion ? <span>Version {d.latestVersion.version} · published {formatDate(d.latestVersion.publishedAt)}</span> : <span>Not created yet: open it in Scenario Studio to finish and create it.</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btn} onClick={join} disabled={!published || joining} title={published ? 'Start a practice session' : 'Create the scenario first'}>
            <Icon name="play" /> Join
          </button>
          <Link href={href(`/scenarios/${s.id}/studio`)} className={btn}>
            <Icon name="pencil" /> Edit
          </Link>
          <Link href={href(`/scenarios/${s.id}/access`)} className={btn}>
            <Icon name="share" /> Share
          </Link>
          <div className="relative">
            <button type="button" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((v) => !v)} className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
              <Icon name="more" />
            </button>
            {menu && (
              <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
                <MenuLink href={href(`/scenarios/${s.id}/legacy`)} label="Open in legacy editor" />
                <MenuButton
                  label="Duplicate"
                  onClick={() =>
                    act(async () => {
                      const copy = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body: { source: 'duplicate', scenarioId: s.id } });
                      router.push(href(`/scenarios/${copy.scenario.id}/studio`));
                    }, 'Duplicated')
                  }
                />
                <MenuButton label="Export YAML" onClick={() => act(() => download(`${key}/export`, `${s.slug}.yaml`, { format: 'yaml', source: published ? 'version' : 'draft' }), 'Downloaded')} />
                <MenuButton label="Export JSON" onClick={() => act(() => download(`${key}/export`, `${s.slug}.json`, { format: 'json', source: published ? 'version' : 'draft' }), 'Downloaded')} />
                {s.status === 'ARCHIVED' ? (
                  <MenuButton label="Unarchive" onClick={() => act(() => api(`${key}/unarchive`, { method: 'POST', body: {} }), 'Restored')} />
                ) : (
                  <MenuButton label="Archive" onClick={() => act(() => api(`${key}/archive`, { method: 'POST', body: {} }), 'Archived')} />
                )}
                <MenuButton
                  label="Delete"
                  danger
                  onClick={() => {
                    if (!window.confirm(`Delete “${s.name}”? Its sessions and versions are kept.`)) return setMenu(false);
                    void act(async () => {
                      await api(key, { method: 'DELETE' });
                      router.push(href('/scenarios'));
                    }, 'Deleted');
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <ChannelCards scenarioId={s.id} published={published} meetingEnabled={cfg.channels.meeting.enabled} personaName={cfg.persona.name} />

      <div className="flex justify-center">
        <div role="tablist" className="inline-flex rounded-lg border border-slate-200 bg-white p-1 text-sm">
          {(['details', 'sessions', 'analytics'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={clsx('rounded-md px-6 py-1.5 font-medium sm:px-10', tab === t ? 'bg-slate-200 text-slate-900' : 'text-slate-600 hover:text-slate-900')}>
              {{ details: 'Details', sessions: 'Sessions', analytics: 'Analytics' }[t]}
              {t === 'sessions' && d.sessionCount > 0 && <span className="ml-1 text-xs text-slate-500">({d.sessionCount})</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === 'details' && (
        <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="details-tab">
          {!published && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">Showing the draft. Participants see nothing until the scenario is created.</p>}
          {published && d.draftHasUnpublishedChanges && <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">Showing version {d.latestVersion?.version}. The draft has changes that are not published yet.</p>}
          <DetailSection icon="chat" title="Overview">
            <p className="text-sm leading-relaxed text-slate-700">{cfg.basics.publicDescription || '—'}</p>
          </DetailSection>
          <DetailSection icon="users" title="Your Instructions">
            {cfg.basics.participantInstructions ? <Markdown text={cfg.basics.participantInstructions} /> : <p className="text-sm text-slate-500">—</p>}
          </DetailSection>
          <DetailSection icon="sparkles" title="AI Instructions" note="Private: only creators see this.">
            {cfg.instructions.aiInstructions ? <Markdown text={cfg.instructions.aiInstructions} /> : <p className="text-sm text-slate-500">No AI instructions yet.</p>}
          </DetailSection>
          <button type="button" onClick={join} disabled={!published || joining} className="inline-flex items-center gap-2 rounded-md bg-fuchsia-600 px-4 py-2 text-sm font-medium text-white hover:bg-fuchsia-700 disabled:bg-slate-300">
            <Icon name="play" /> Join
          </button>
        </div>
      )}
      {tab === 'sessions' && <SessionsTab scenarioId={s.id} scenarioName={s.name} />}
      {tab === 'analytics' && <AnalyticsTab scenarioId={s.id} />}
    </div>
  );
}

function DetailSection({ icon, title, note, children }: { icon: IconName; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-b border-slate-100 pb-6 last-of-type:border-0">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-brand-700">
        <Icon name={icon} className="h-4 w-4" /> {title}
        {note && <span className="text-xs font-normal text-slate-500">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

function MenuLink({ href, label }: { href: string; label: string }) {
  return (
    <Link role="menuitem" href={href} className="block px-3 py-2 hover:bg-slate-50">
      {label}
    </Link>
  );
}
function MenuButton({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={clsx('block w-full px-3 py-2 text-left', danger ? 'text-red-700 hover:bg-red-50' : 'hover:bg-slate-50')}>
      {label}
    </button>
  );
}
