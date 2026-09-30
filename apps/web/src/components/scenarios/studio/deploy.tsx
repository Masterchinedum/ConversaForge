'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, download, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Button, ButtonLink, Card, useToast } from '@/components/ui';
import { ChannelCards } from '../channels';
import { Icon } from '../icons';
import { startSelfRun } from '../new-scenario';
import { VersionsTab } from '../panels';
import type { ScenarioDetail } from '../types';
import type { ScenarioDraft } from '../use-scenario-draft';

/** Where the scenario goes live: status, channels, running it, export and the immutable version history. */
export function DeployTab({ draft }: { draft: ScenarioDraft }) {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const d = draft.detail;

  if (!draft.scenarioId || !d) {
    return (
      <Card title="Deploy">
        <p className="text-sm text-slate-600">
          Nothing is live yet. Describe your scenario or edit a field to start a draft, then use <strong>Create Scenario</strong> to publish version 1. Drafts are private and never run.
        </p>
      </Card>
    );
  }
  const s = d.scenario;
  const published = !!s.latestVersionId && s.status === 'PUBLISHED';

  const tryIt = async () => {
    setStarting(true);
    try {
      router.push(await startSelfRun(wsPath, s.id));
    } catch (e) {
      toast.error(errorMessage(e));
      setStarting(false);
    }
  };
  const duplicate = async () => {
    if (!(await draft.flush())) return;
    try {
      const copy = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body: { source: 'duplicate', scenarioId: s.id } });
      toast.success('Duplicated');
      router.push(href(`/scenarios/${copy.scenario.id}/studio`));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const exportAs = (format: 'yaml' | 'json') =>
    download(wsPath(`/scenarios/${s.id}/export`), `${s.slug}.${format}`, { format, source: 'draft' }).catch((e) => toast.error(errorMessage(e)));

  return (
    <div className="mx-auto max-w-4xl space-y-5 py-2" data-testid="deploy-tab">
      <Card title="Status">
        <div className="space-y-2 text-sm">
          {d.latestVersion ? (
            <p>
              <strong>Version {d.latestVersion.version}</strong> published {formatDate(d.latestVersion.publishedAt)}
              {d.latestVersion.publishedBy ? ` by ${d.latestVersion.publishedBy.name ?? d.latestVersion.publishedBy.email}` : ''}.{' '}
              {d.draftHasUnpublishedChanges ? <span className="text-amber-700">The draft has changes that are not published yet. Use Save Changes to publish them.</span> : <span className="text-emerald-700">The draft matches this version.</span>}
            </p>
          ) : (
            <p>
              <strong>Draft</strong> — not created yet. Participants cannot run it until you create the scenario.
            </p>
          )}
          {s.status === 'ARCHIVED' && <Alert tone="warning">This scenario is archived. Unarchive it from the library to run or publish it.</Alert>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" onClick={tryIt} loading={starting} disabled={!published} title={published ? 'Start a practice session with the latest published version' : 'Create the scenario first'}>
              <Icon name="play" className="h-3.5 w-3.5" /> Try it
            </Button>
            <ButtonLink size="sm" variant="secondary" href={href(`/scenarios/${s.id}`)}>
              Details, sessions & analytics
            </ButtonLink>
          </div>
        </div>
      </Card>
      <ChannelCards scenarioId={s.id} published={published} meetingEnabled={!!draft.config?.channels.meeting.enabled} personaName={draft.config?.persona.name ?? ''} />
      <Card title="Export & copy">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => exportAs('yaml')}>
            Export YAML
          </Button>
          <Button size="sm" variant="secondary" onClick={() => exportAs('json')}>
            Export JSON
          </Button>
          <Button size="sm" variant="secondary" onClick={duplicate}>
            Duplicate
          </Button>
        </div>
      </Card>
      <VersionsTab wsPath={wsPath} scenarioId={s.id} canPublish={can('scenarios.publish')} onRolledBack={draft.applyDetail} />
    </div>
  );
}
