'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { Badge, Button, ConfirmButton, EmptyState, ErrorState, Loading, PageHeader, SimulatedBadge, Tabs, useToast } from '@/components/ui';
import { ProcessingBadge, StateBadge, isProcessing } from '@/components/review/score';
import { ReportTab } from '@/components/review/report-tab';
import { DebugTab, ExtractionTab, ProcessingTab, RecordingTab, TranscriptTab } from '@/components/review/tabs';
import type { SessionDetail } from '@/components/review/types';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

type TabId = 'report' | 'transcript' | 'recording' | 'extracted' | 'processing' | 'debug';

function consentSummary(c: Record<string, unknown>) {
  const parts: string[] = [];
  if (c.analysis === false) parts.push('no analysis');
  else if (c.analysis === true) parts.push('analysis');
  if (c.recordAudio === true) parts.push('audio recording');
  if (c.recordVideo === true) parts.push('video recording');
  if (c.recordAudio === false && c.recordVideo !== true) parts.push('no recording');
  return parts.length ? `Consented: ${parts.join(', ')}` : 'No consent recorded';
}

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('report');
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const { data, error, mutate } = useSWR<SessionDetail>(can('sessions.review') ? wsPath(`/sessions/${sessionId}`) : null, {
    refreshInterval: (d) => (d && isProcessing(d.processing.status) ? 3000 : 0),
  });

  const jump = useCallback((seq: number) => {
    setTab('transcript');
    setFocusSeq(null);
    // re-trigger even when jumping to the same turn twice
    setTimeout(() => setFocusSeq(seq), 0);
    if (typeof window !== 'undefined') window.history.replaceState(window.history.state, '', `#turn-${seq}`);
  }, []);

  // Deep links: /sessions/<id>#turn-12
  useEffect(() => {
    if (!data) return;
    const m = /^#turn-(\d+)$/.exec(window.location.hash);
    if (m) jump(Number(m[1]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  if (!can('sessions.review')) return <EmptyState title="Not available" description="Reviewing sessions requires the reviewer role or higher." />;
  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return <EmptyState title="Session not found" description="It may have been deleted, or it belongs to another workspace." action={<Link className="text-brand-700 hover:underline" href={href('/sessions')}>Back to sessions</Link>} />;
    }
    return <ErrorState error={error} retry={() => mutate()} />;
  }
  if (!data) return <Loading />;
  const d = data;
  const simulated = !!d.evaluation?.simulated || d.extraction.some((x) => x.simulated) || !!d.session.providerInfo?.simulated;

  const exportFile = async (kind: 'pdf' | 'csv') => {
    setExporting(kind);
    try {
      await download(wsPath(`/sessions/${d.session.id}/export.${kind}`), `session-${d.session.id}.${kind}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(null);
    }
  };

  const tabs: Array<{ id: TabId; label: React.ReactNode }> = [
    { id: 'report', label: 'Report' },
    { id: 'transcript', label: `Transcript (${d.turns.length})` },
    { id: 'recording', label: 'Recording' },
    { id: 'extracted', label: `Extracted data${d.extraction.length ? ` (${d.extraction.length})` : ''}` },
    { id: 'processing', label: <span className="inline-flex items-center gap-1">Processing {d.processing.status === 'FAILED' || d.processing.status === 'PARTIAL' ? <span className="h-2 w-2 rounded-full bg-red-500" aria-label="has failures" /> : null}</span> },
    ...(d.events ? [{ id: 'debug' as TabId, label: 'Debug events' }] : []),
  ];

  const who = d.participant.name || d.participant.email || d.participant.externalId || 'Anonymous participant';
  return (
    <div>
      <PageHeader
        back={{ href: href('/sessions'), label: 'Sessions' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {who}
            {simulated && <SimulatedBadge />}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {d.participant.name && d.participant.email && <span>{d.participant.email}</span>}
            <span>
              {can('scenarios.edit') ? (
                <Link href={href(`/scenarios/${d.scenario.id}`)} className="font-medium text-brand-700 hover:underline">
                  {d.scenario.name}
                </Link>
              ) : (
                <span className="font-medium">{d.scenario.name}</span>
              )}{' '}
              <Badge tone={d.version.isLatest ? 'blue' : 'gray'} title={`Scenario version ${d.version.id}${d.version.isLatest ? ' (latest)' : ` — latest is v${d.scenario.latestVersionNumber}`}`}>
                v{d.version.number}
              </Badge>
              {!d.version.isLatest && <span className="ml-1 text-xs text-slate-500">(ran on an older version)</span>}
            </span>
            <span>{d.session.channel.charAt(0) + d.session.channel.slice(1).toLowerCase()}</span>
            <StateBadge state={d.session.state} />
            <span className="tabular-nums">{formatDuration(d.session.durationMs)}</span>
            <span>{formatDate(d.session.startedAt ?? d.session.createdAt)}</span>
            <span className="text-xs text-slate-500">{consentSummary(d.session.consent)}</span>
            <ProcessingBadge status={d.processing.status} title={d.processing.error} />
          </span>
        }
        actions={
          <>
            {can('exports.download') && (
              <>
                <Button variant="secondary" size="sm" loading={exporting === 'pdf'} onClick={() => exportFile('pdf')}>
                  Export PDF
                </Button>
                <Button variant="secondary" size="sm" loading={exporting === 'csv'} onClick={() => exportFile('csv')}>
                  Transcript CSV
                </Button>
              </>
            )}
            {can('sessions.delete') && (
              <ConfirmButton
                variant="danger"
                size="sm"
                confirmText="Delete this session? The recording files are deleted permanently and the session disappears from reports."
                onConfirm={async () => {
                  try {
                    await api(wsPath(`/sessions/${d.session.id}`), { method: 'DELETE' });
                    toast.success('Session deleted');
                    router.push(href('/sessions'));
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Delete
              </ConfirmButton>
            )}
          </>
        }
      />
      {d.session.errorCode && (
        <p className="-mt-3 mb-4 text-sm text-red-700">
          Session error: {d.session.errorCode}
          {d.session.errorMessage ? ` — ${d.session.errorMessage}` : ''}
        </p>
      )}
      {isProcessing(d.processing.status) && (
        <p className="-mt-3 mb-4 text-sm text-sky-800" role="status" aria-live="polite">
          Analysis in progress — this page updates automatically.
        </p>
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div role="tabpanel">
        {tab === 'report' && <ReportTab d={d} onJump={jump} onChanged={() => mutate()} wsPath={wsPath} />}
        {tab === 'transcript' && <TranscriptTab d={d} focusSeq={focusSeq} />}
        {tab === 'recording' && <RecordingTab d={d} />}
        {tab === 'extracted' && <ExtractionTab d={d} onJump={jump} />}
        {tab === 'processing' && <ProcessingTab d={d} wsPath={wsPath} onChanged={() => mutate()} canReprocess={can('sessions.review')} />}
        {tab === 'debug' && d.events && <DebugTab d={d} />}
      </div>
    </div>
  );
}
