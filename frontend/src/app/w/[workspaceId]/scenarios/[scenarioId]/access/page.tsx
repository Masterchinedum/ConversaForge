'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { AccessTokensTab } from '@/components/access/AccessTokensTab';
import { GrantsTab } from '@/components/access/GrantsTab';
import { ShareLinksTab } from '@/components/access/ShareLinksTab';
import type { AccessSummary } from '@/components/access/types';
import { Alert, Badge, Button, Card, CopyButton, ErrorState, Loading, PageHeader, Tabs, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';

type Tab = 'links' | 'grants' | 'tokens' | 'visibility';

const PRIVACY_TEXT = {
  PRIVATE: 'Only creators in this workspace, plus anyone you share with via links, grants or tokens.',
  ORGANIZATION: 'Every member of this workspace can run it from their dashboard, plus anyone you share with.',
  PUBLIC: 'Anyone with the public URL can run it (rate-limited). It can also be listed in the gallery.',
} as const;

function AccessPageInner() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const search = useSearchParams();
  const tab = (search.get('tab') as Tab) || 'links';
  const { data, error, mutate } = useSWR<AccessSummary>(can('scenarios.share') ? wsPath(`/scenarios/${scenarioId}/access`) : null);

  if (!can('scenarios.share')) return <Alert tone="warning">You need creator access to manage sharing.</Alert>;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;

  const setTab = (t: Tab) => router.replace(`${href(`/scenarios/${scenarioId}/access`)}?tab=${t}`);

  return (
    <div>
      <PageHeader
        title={`Share “${data.scenario.name}”`}
        description="Control who can run this scenario and how: share links, direct grants, embed tokens and public visibility."
        back={{ href: href(`/scenarios/${scenarioId}`), label: 'Back to scenario' }}
        actions={
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Badge tone={data.scenario.privacy === 'PUBLIC' ? 'purple' : data.scenario.privacy === 'ORGANIZATION' ? 'blue' : 'gray'}>{data.scenario.privacy.toLowerCase()}</Badge>
            {data.scenario.latestVersionNumber ? <span>latest v{data.scenario.latestVersionNumber}</span> : <Badge tone="yellow">unpublished</Badge>}
          </div>
        }
      />
      {data.scenario.archived && <Alert tone="warning">This scenario is archived; links and tokens will show “not available”.</Alert>}
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'links', label: `Share links (${data.counts.activeLinks})` },
          { id: 'grants', label: `People & workspaces (${data.counts.activeGrants})` },
          { id: 'tokens', label: `Embed & access tokens (${data.counts.activeTokens})` },
          { id: 'visibility', label: 'Public visibility' },
        ]}
      />
      {tab === 'links' && <ShareLinksTab scenarioId={scenarioId} summary={data} />}
      {tab === 'grants' && <GrantsTab scenarioId={scenarioId} />}
      {tab === 'tokens' && <AccessTokensTab scenarioId={scenarioId} summary={data} />}
      {tab === 'visibility' && (
        <Card title="Visibility">
          <div className="space-y-3 text-sm text-slate-700">
            <p>
              Privacy: <Badge>{data.scenario.privacy.toLowerCase()}</Badge> — {PRIVACY_TEXT[data.scenario.privacy]}
            </p>
            {data.scenario.privacy === 'PUBLIC' && (
              <>
                {!data.allowPublicScenarios && <Alert tone="warning">Public scenarios are disabled in workspace settings, so the public page is unavailable.</Alert>}
                <div className="flex flex-wrap items-center gap-2">
                  <span>Public run page:</span>
                  <code className="rounded bg-slate-100 px-2 py-1 text-xs">{data.publicUrl}</code>
                  <CopyButton value={data.publicUrl} />
                </div>
                <GalleryToggle scenarioId={scenarioId} listed={data.scenario.galleryListed} disabled={!data.allowPublicScenarios || !data.runnable} onChanged={() => mutate()} />
              </>
            )}
            <p className="text-slate-600">
              Privacy is edited in the scenario editor (Basics → Privacy) and applies as soon as the draft is saved; a scenario is only listed in the public gallery while it is Public and published.{' '}
              <Link className="text-brand-700 hover:underline" href={href(`/scenarios/${scenarioId}`)}>
                Open the editor
              </Link>
            </p>
            <p className="text-slate-600">
              Identity collected on the public page: <strong>{data.identityModeDefault.replace('_', ' + ').toLowerCase()}</strong>
              {data.defaultAttemptLimitPerEmail ? `, limited to ${data.defaultAttemptLimitPerEmail} attempt(s) per email` : ''} (scenario access settings).
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

function GalleryToggle({ scenarioId, listed, disabled, onChanged }: { scenarioId: string; listed: boolean; disabled: boolean; onChanged: () => void }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await api(wsPath(`/scenarios/${scenarioId}/gallery`), { method: 'POST', body: { listed: !listed } });
      toast.success(listed ? 'Removed from the public gallery' : 'Listed in the public gallery');
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>
        Gallery listing: <strong>{listed ? 'listed' : 'not listed'}</strong>
      </span>
      <Button size="sm" variant={listed ? 'secondary' : 'primary'} onClick={toggle} loading={busy} disabled={disabled && !listed} data-testid="gallery-toggle">
        {listed ? 'Remove from gallery' : 'List in public gallery'}
      </Button>
    </div>
  );
}

export default function ScenarioAccessPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AccessPageInner />
    </Suspense>
  );
}
