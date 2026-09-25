'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import useSWR from 'swr';
import { AccessTokensTab } from '@/components/access/AccessTokensTab';
import { GrantsTab } from '@/components/access/GrantsTab';
import { ShareLinksTab } from '@/components/access/ShareLinksTab';
import type { AccessSummary } from '@/components/access/types';
import { Alert, Badge, Card, CopyButton, ErrorState, Loading, PageHeader, Tabs } from '@/components/ui';
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
                <p>Gallery listing: {data.scenario.galleryListed ? 'listed' : 'not listed'}.</p>
              </>
            )}
            <p className="text-slate-600">
              Privacy and gallery listing are edited in the scenario editor (Basics → Privacy) and take effect when you publish.{' '}
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

export default function ScenarioAccessPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AccessPageInner />
    </Suspense>
  );
}
