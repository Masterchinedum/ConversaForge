'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, download, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Button, ButtonLink, Card, useToast } from '@/components/ui';
import { MeetingPracticeModal } from '../meeting-practice';
import { startSelfRun } from '../new-scenario';
import { VersionsTab } from '../panels';
import type { ScenarioDetail } from '../types';
import type { ScenarioDraft } from '../use-scenario-draft';

/** Where the scenario goes live: status, running it, sharing, export and the immutable version history. */
export function DeployTab({ draft, justCreated }: { draft: ScenarioDraft; justCreated: number | null }) {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
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
      router.push(href(`/scenarios/${copy.scenario.id}`));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const exportAs = (format: 'yaml' | 'json') =>
    download(wsPath(`/scenarios/${s.id}/export`), `${s.slug}.${format}`, { format, source: 'draft' }).catch((e) => toast.error(errorMessage(e)));

  return (
    <div className="space-y-4" data-testid="deploy-tab">
      {justCreated !== null && (
        <Alert tone="success" title={justCreated === 1 ? 'Scenario created' : `Version ${justCreated} published`}>
          Version {justCreated} is live for new sessions. Sessions that already started keep the version they began with.
        </Alert>
      )}
      <Card title="Status">
        <div className="space-y-2 text-sm">
          {d.latestVersion ? (
            <p>
              <strong>Version {d.latestVersion.version}</strong> published {formatDate(d.latestVersion.publishedAt)}
              {d.latestVersion.publishedBy ? ` by ${d.latestVersion.publishedBy.name ?? d.latestVersion.publishedBy.email}` : ''}.{' '}
              {d.draftHasUnpublishedChanges ? <span className="text-amber-700">The draft has unpublished changes.</span> : <span className="text-emerald-700">The draft matches this version.</span>}
            </p>
          ) : (
            <p>
              <strong>Draft</strong> — not created yet. Participants cannot run it until you create the scenario.
            </p>
          )}
          {s.status === 'ARCHIVED' && <Alert tone="warning">This scenario is archived. Unarchive it from the library to run or publish it.</Alert>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" onClick={tryIt} loading={starting} disabled={!published} title={published ? 'Start a practice session with the latest published version' : 'Create the scenario first'}>
              ▶ Try it
            </Button>
            <ButtonLink size="sm" variant="secondary" href={href(`/scenarios/${s.id}/access`)}>
              Share & access
            </ButtonLink>
            <ButtonLink size="sm" variant="secondary" href={`${href('/sessions')}?scenarioId=${s.id}`}>
              Sessions ({d.sessionCount})
            </ButtonLink>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMeetingOpen(true)}
              disabled={!published || !draft.config?.channels.meeting.enabled}
              title={!published ? 'Create the scenario first' : !draft.config?.channels.meeting.enabled ? 'Turn on Channels → Meeting bot, then publish' : 'The AI persona joins your Zoom / Google Meet / Teams meeting'}
            >
              Practice in a meeting
            </Button>
          </div>
        </div>
      </Card>
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
      <MeetingPracticeModal open={meetingOpen} onClose={() => setMeetingOpen(false)} wsPath={wsPath} scenarioId={s.id} personaName={draft.config?.persona.name ?? ''} />
    </div>
  );
}
