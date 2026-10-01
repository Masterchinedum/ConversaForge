'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Button, Card, ConfirmButton, EmptyState, ErrorState, Input, Loading, PageHeader, Stat, useToast } from '@/components/ui';
import { StatusPill } from '@/components/knowledge/parts';
import { SearchTester } from '@/components/knowledge/search-tester';
import { formatBytes, isProcessing, typeLabel, type KnowledgeChunk, type KnowledgeDoc } from '@/components/knowledge/types';

const PAGE = 10;

export default function KnowledgeDocumentPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const allowed = can('knowledge.manage');
  const { data: doc, error, mutate } = useSWR<KnowledgeDoc>(allowed ? wsPath(`/knowledge/documents/${documentId}`) : null, {
    refreshInterval: (d) => (d && isProcessing(d.status) ? 2000 : 0),
  });
  const [offset, setOffset] = useState(0);
  const { data: chunks, error: chunksError } = useSWR<{ data: KnowledgeChunk[]; total: number; nextOffset: number | null }>(
    allowed && doc?.status === 'COMPLETED' ? [wsPath(`/knowledge/documents/${documentId}/chunks`), { offset, limit: PAGE, v: doc.updatedAt }] : null,
  );
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');

  if (!allowed) return <EmptyState title="Creators only" />;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!doc) return <Loading />;

  async function saveTitle() {
    try {
      await api(wsPath(`/knowledge/documents/${documentId}`), { method: 'PATCH', body: { title: title.trim() } });
      setEditing(false);
      void mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function download() {
    try {
      const r = await api<{ url: string }>(wsPath(`/knowledge/documents/${documentId}/download`));
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function reprocess() {
    try {
      await api(wsPath(`/knowledge/documents/${documentId}/reprocess`), { method: 'POST' });
      setOffset(0);
      void mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: href('/knowledge'), label: 'Knowledge' }}
        title={
          editing ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveTitle();
              }}
            >
              <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
              <Button type="submit" size="sm" disabled={!title.trim()}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <span className="flex items-center gap-2">
              {doc.title}
              <Button
                size="sm"
                variant="link"
                onClick={() => {
                  setTitle(doc.title);
                  setEditing(true);
                }}
              >
                Rename
              </Button>
            </span>
          )
        }
        description={doc.fileName ?? undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {doc.hasSource && (
              <Button variant="secondary" onClick={download}>
                Download original
              </Button>
            )}
            {doc.hasSource && !isProcessing(doc.status) && (
              <Button variant="secondary" onClick={reprocess}>
                Reprocess
              </Button>
            )}
            <ConfirmButton
              variant="danger"
              confirmText={
                doc.referencedBy.length
                  ? `This document is used by ${doc.referencedBy.length} scenario(s): ${doc.referencedBy.map((r) => r.name).join(', ')}. Delete anyway?`
                  : 'Delete this document? This cannot be undone.'
              }
              onConfirm={async () => {
                try {
                  await api(wsPath(`/knowledge/documents/${documentId}`), { method: 'DELETE' });
                  toast.success('Document deleted');
                  router.push(href('/knowledge'));
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Delete
            </ConfirmButton>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Status" value={<StatusPill status={doc.status} error={doc.error} />} />
        <Stat label="Type" value={typeLabel(doc.mimeType)} hint={formatBytes(doc.sizeBytes)} />
        <Stat label="Pages" value={doc.pageCount ?? '—'} />
        <Stat label="Chunks" value={doc.chunkCount} hint={`${doc.charCount.toLocaleString()} characters`} />
        <Stat label="Added" value={<span className="text-sm">{formatDate(doc.createdAt)}</span>} />
      </div>

      {doc.status === 'FAILED' && doc.error && <Alert tone="error" title="Processing failed">{doc.error}</Alert>}
      {isProcessing(doc.status) && <Alert tone="info">The document is being processed. This page refreshes automatically.</Alert>}

      <Card title="Used by scenarios">
        {doc.referencedBy.length === 0 ? (
          <p className="text-sm text-slate-600">Not referenced by any scenario yet. Add it in a scenario’s Knowledge settings.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {doc.referencedBy.map((r) => (
              <li key={r.scenarioId}>
                <Link href={href(`/scenarios/${r.scenarioId}`)} className="text-brand-700 hover:underline">
                  {r.name}
                </Link>{' '}
                <span className="text-slate-500">
                  {r.published ? `published v${r.version}` : ''}
                  {r.published && r.draft ? ' · ' : ''}
                  {r.draft ? 'draft' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {doc.status === 'COMPLETED' && <SearchTester docs={[doc]} fixedDocumentId={doc.id} />}

      {doc.status === 'COMPLETED' && (
        <Card
          title={`Chunks${chunks ? ` (${chunks.total})` : ''}`}
          actions={
            chunks && chunks.total > PAGE ? (
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </Button>
                <span>
                  {offset + 1}–{Math.min(offset + PAGE, chunks.total)} of {chunks.total}
                </span>
                <Button size="sm" variant="secondary" disabled={chunks.nextOffset == null} onClick={() => setOffset(chunks.nextOffset ?? offset)}>
                  Next
                </Button>
              </div>
            ) : null
          }
        >
          {chunksError ? (
            <ErrorState error={chunksError} />
          ) : !chunks ? (
            <Loading />
          ) : (
            <ol className="space-y-3">
              {chunks.data.map((c) => (
                <li key={c.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">#{c.ordinal + 1}</span>
                    {c.page != null && <span>page {c.page}</span>}
                    {c.heading && <span>· {c.heading}</span>}
                    <span className="ml-auto">~{c.tokenCount} tokens</span>
                  </div>
                  <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-sm text-slate-800">{c.text}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}
    </div>
  );
}
