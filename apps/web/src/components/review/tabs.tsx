'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, SimulatedBadge, Table, Td, Th, clsx, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { ProcessingBadge, formatValue, mmss } from './score';
import type { SessionDetail, ToolEventRow, Turn } from './types';

// ── Transcript ──

type Item = { kind: 'turn'; at: number; turn: Turn } | { kind: 'tool'; at: number; ev: ToolEventRow };

function highlight(text: string, q: string) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((p, i) =>
    p.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="rounded bg-yellow-200 px-0.5">
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

export function TranscriptTab({ d, focusSeq }: { d: SessionDetail; focusSeq: number | null }) {
  const [q, setQ] = useState('');
  const [flash, setFlash] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const items = useMemo(() => {
    const start = d.session.startedAt ? new Date(d.session.startedAt).getTime() : null;
    const out: Item[] = d.turns.map((t, i) => ({ kind: 'turn', at: t.startedAtMs ?? (i === 0 ? 0 : Number.NaN), turn: t }));
    // Keep turn order by seq; carry forward the last known offset for turns without timing.
    let last = 0;
    for (const it of out) {
      if (Number.isNaN(it.at)) it.at = last;
      last = it.at;
    }
    for (const ev of d.toolEvents) {
      const at = start ? new Date(ev.createdAt).getTime() - start : Number.MAX_SAFE_INTEGER;
      out.push({ kind: 'tool', at, ev });
    }
    return out.sort((a, b) => a.at - b.at || (a.kind === 'turn' && b.kind === 'turn' ? a.turn.seq - b.turn.seq : a.kind === 'turn' ? -1 : 1));
  }, [d]);

  useEffect(() => {
    if (focusSeq == null) return;
    setQ('');
    setFlash(focusSeq);
    const t = setTimeout(() => {
      const el = document.getElementById(`turn-${focusSeq}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus({ preventScroll: true });
    }, 50);
    const t2 = setTimeout(() => setFlash(null), 2500);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [focusSeq]);

  const visible = q ? items.filter((it) => it.kind === 'turn' && it.turn.text.toLowerCase().includes(q.toLowerCase())) : items;
  if (!d.turns.length) return <EmptyState title="No transcript" description="Nothing was captured for this session." />;

  return (
    <div>
      {d.session.contentRedactedAt && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
          Transcript text and recordings were removed on {new Date(d.session.contentRedactedAt).toLocaleDateString()} under the
          retention policy. Scores and metadata are kept.
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label htmlFor="transcript-search" className="sr-only">
          Search transcript
        </label>
        <Input id="transcript-search" type="search" className="max-w-sm" placeholder="Search transcript…" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <span className="text-xs text-slate-500" aria-live="polite">{visible.length} matching turn(s)</span>}
      </div>
      <ol ref={listRef} className="space-y-2">
        {visible.map((it) =>
          it.kind === 'turn' ? (
            <li
              key={`t${it.turn.id}`}
              id={`turn-${it.turn.seq}`}
              tabIndex={-1}
              className={clsx(
                'scroll-mt-24 rounded-md border p-3 outline-none transition-colors',
                it.turn.speaker === 'PARTICIPANT' ? 'border-sky-200 bg-sky-50/60' : it.turn.speaker === 'AGENT' ? 'border-slate-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50',
                flash === it.turn.seq && 'ring-2 ring-amber-400 bg-amber-50',
              )}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <a href={`#turn-${it.turn.seq}`} className="font-mono text-slate-400 hover:underline">
                  #{it.turn.seq}
                </a>
                <span className={clsx('font-semibold', it.turn.speaker === 'PARTICIPANT' ? 'text-sky-800' : 'text-slate-700')}>
                  {it.turn.speaker === 'PARTICIPANT' ? d.participant.name || 'Participant' : it.turn.speaker === 'AGENT' ? 'Agent' : 'System'}
                </span>
                {it.turn.startedAtMs != null && (
                  <span className="tabular-nums">
                    {mmss(it.turn.startedAtMs)}
                    {it.turn.endedAtMs != null && `–${mmss(it.turn.endedAtMs)}`}
                  </span>
                )}
                {it.turn.interrupted && <Badge tone="yellow">interrupted</Badge>}
                {it.turn.source && <span className="text-slate-400">{it.turn.source}</span>}
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-900">{highlight(it.turn.text, q)}</p>
            </li>
          ) : (
            <li key={`e${it.ev.id}`} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">
              <span aria-hidden>⚙</span>
              <span className="font-medium">{it.ev.toolId}</span>
              <Badge tone={it.ev.kind === 'ERROR' || it.ev.kind === 'DENIED' ? 'red' : 'purple'}>{it.ev.kind.toLowerCase()}</Badge>
              <span>by {it.ev.actor.toLowerCase()}</span>
              {it.at !== Number.MAX_SAFE_INTEGER && <span className="tabular-nums text-violet-700">{mmss(it.at)}</span>}
              <details className="w-full">
                <summary className="cursor-pointer text-violet-700">Details</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px] text-slate-700">
                  {JSON.stringify({ args: it.ev.args, result: it.ev.result }, null, 2)}
                </pre>
              </details>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

// ── Recording ──

export function RecordingTab({ d }: { d: SessionDetail }) {
  const recordings = d.media.filter((m) => m.kind === 'RECORDING_AUDIO' || m.kind === 'RECORDING_VIDEO');
  const uploads = d.media.filter((m) => m.kind === 'TOOL_UPLOAD');
  const playable = recordings.filter((m) => m.url);
  return (
    <div className="space-y-4">
      {playable.length ? (
        playable.map((m) => (
          <Card key={m.id} title={m.kind === 'RECORDING_VIDEO' ? 'Video recording' : 'Audio recording'}>
            {m.kind === 'RECORDING_VIDEO' || m.mimeType.startsWith('video/') ? (
              <video controls preload="metadata" className="w-full max-w-3xl rounded" src={m.url!}>
                Your browser cannot play this recording.
              </video>
            ) : (
              <audio controls preload="metadata" className="w-full max-w-3xl" src={m.url!}>
                Your browser cannot play this recording.
              </audio>
            )}
            <p className="mt-2 text-xs text-slate-500">
              {m.mimeType} · {(m.sizeBytes / 1024 / 1024).toFixed(1)} MB · the playback link expires after a few minutes (reload the page to renew it).
            </p>
          </Card>
        ))
      ) : (
        <EmptyState title="No recording available" description={d.recordingUnavailableReason ?? 'No recording was captured.'} />
      )}
      {uploads.length > 0 && (
        <Card title="Files uploaded during the session">
          <ul className="space-y-1 text-sm">
            {uploads.map((u) => (
              <li key={u.id}>
                {u.url ? (
                  <a href={u.url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                    {u.fileName ?? u.id}
                  </a>
                ) : (
                  <span>{u.fileName ?? u.id}</span>
                )}{' '}
                <span className="text-xs text-slate-500">({u.status.toLowerCase()})</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ── Extracted data ──

export function ExtractionTab({ d, onJump }: { d: SessionDetail; onJump: (seq: number) => void }) {
  if (!d.extraction.length) {
    return <EmptyState title="No extracted data" description="This scenario version defines no extraction variables, or processing has not finished yet." />;
  }
  return (
    <div>
      {d.extraction.some((x) => x.simulated) && (
        <div className="mb-3">
          <Alert tone="warning" title="Simulated extraction">
            Values were found with simple pattern matching by the local simulator (no AI provider configured). Verify against the transcript.
          </Alert>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Variable</Th>
            <Th>Type</Th>
            <Th>Value</Th>
            <Th>Validity</Th>
            <Th>Confidence</Th>
            <Th>Evidence</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {d.extraction.map((x) => (
            <tr key={x.key}>
              <Td>
                <span className="font-mono text-xs">{x.key}</span>
                {x.description && <span className="block max-w-xs whitespace-normal text-xs text-slate-500">{x.description}</span>}
              </Td>
              <Td>{x.type}</Td>
              <Td className="max-w-sm whitespace-normal">{x.value === null ? <span className="text-slate-400">Not found</span> : formatValue(x.value)}</Td>
              <Td>
                {x.valid ? (
                  <Badge tone="green">valid</Badge>
                ) : (
                  <span>
                    <Badge tone="red">invalid</Badge>
                    <span className="mt-1 block max-w-xs whitespace-normal text-xs text-red-700">{x.errors.join('; ')}</span>
                  </span>
                )}
              </Td>
              <Td className="tabular-nums">{x.confidence == null ? '—' : `${Math.round(x.confidence * 100)}%`}</Td>
              <Td>
                {x.evidence.length
                  ? x.evidence.map((e) => (
                      <a
                        key={e.turnSeq}
                        href={`#turn-${e.turnSeq}`}
                        title={e.excerpt}
                        onClick={(ev) => {
                          ev.preventDefault();
                          onJump(e.turnSeq);
                        }}
                        className="mr-2 text-brand-700 hover:underline"
                      >
                        #{e.turnSeq}
                      </a>
                    ))
                  : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

// ── Processing ──

export function ProcessingTab({ d, wsPath, onChanged, canReprocess }: { d: SessionDetail; wsPath: (p: string) => string; onChanged: () => void; canReprocess: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, path: string, msg: string) => {
    setBusy(key);
    try {
      await api(wsPath(path), { method: 'POST' });
      toast.success(msg);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ProcessingBadge status={d.processing.status} />
        <span className="text-sm text-slate-600">Run {d.processing.generation || '—'}</span>
        {canReprocess && (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'reprocess'}
            disabled={d.processing.status === 'QUEUED' || d.processing.status === 'PROCESSING'}
            onClick={() => run('reprocess', `/sessions/${d.session.id}/reprocess`, 'Reprocessing started')}
          >
            Reprocess all
          </Button>
        )}
      </div>
      {d.processing.error && <Alert tone="error">{d.processing.error}</Alert>}
      {d.session.analysisStatus === 'SKIPPED' && d.session.analysisError && <Alert tone="info">{d.session.analysisError}</Alert>}
      <Table>
        <thead>
          <tr>
            <Th>Step</Th>
            <Th>Status</Th>
            <Th>Attempts</Th>
            <Th>Finished</Th>
            <Th>Details</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {d.processing.steps.map((s) => (
            <tr key={s.step}>
              <Td>{s.label}</Td>
              <Td>
                <ProcessingBadge status={s.status} step />
              </Td>
              <Td className="tabular-nums">{s.attempts || '—'}</Td>
              <Td className="text-xs text-slate-500">{s.finishedAt ? formatDate(s.finishedAt) : '—'}</Td>
              <Td className="max-w-md whitespace-normal break-words text-xs [overflow-wrap:anywhere]">
                {s.lastError ? (
                  <span className="text-red-700">{s.lastError}</span>
                ) : s.result?.reason ? (
                  <span className="text-slate-500">{s.result.reason}</span>
                ) : s.result?.simulated ? (
                  <SimulatedBadge />
                ) : s.result?.droppedEvidence ? (
                  <span className="text-slate-500">{s.result.droppedEvidence} unverifiable quote(s) discarded</span>
                ) : null}
              </Td>
              <Td>
                {s.status === 'FAILED' && canReprocess && (
                  <Button size="sm" loading={busy === s.step} onClick={() => run(s.step, `/sessions/${d.session.id}/steps/${s.step}/retry`, 'Retry queued')}>
                    Retry
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

// ── Debug ──

export function DebugTab({ d }: { d: SessionDetail }) {
  return (
    <div className="space-y-4">
      <Card title="Provider & runtime">
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-700">
          {JSON.stringify({ providerInfo: d.session.providerInfo, variables: d.session.variables, metadata: d.session.metadata, error: d.session.errorCode ? { code: d.session.errorCode, message: d.session.errorMessage } : null }, null, 2)}
        </pre>
      </Card>
      <Card title={`Session events (${d.events?.length ?? 0})`}>
        {!d.events?.length ? (
          <p className="text-sm text-slate-500">No events recorded.</p>
        ) : (
          <ol className="space-y-1 font-mono text-xs">
            {d.events.map((e) => (
              <li key={e.id} className="border-b border-slate-100 pb-1">
                <span className="text-slate-400">{new Date(e.createdAt).toISOString().slice(11, 23)}</span> <span className="font-semibold">{e.type}</span>{' '}
                <span className="break-all text-slate-600">{JSON.stringify(e.payload)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
