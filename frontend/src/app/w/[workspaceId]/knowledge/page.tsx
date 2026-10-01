'use client';
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import useSWR from 'swr';
import { UPLOAD_LIMITS } from '@cf/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  clsx,
  useToast,
} from '@/components/ui';
import { StatusPill } from '@/components/knowledge/parts';
import { SearchTester } from '@/components/knowledge/search-tester';
import { formatBytes, isProcessing, KNOWLEDGE_ACCEPT, typeLabel, type KnowledgeDoc } from '@/components/knowledge/types';

const MAX_MB = Math.round(UPLOAD_LIMITS.knowledgeDocument.maxBytes / 1024 / 1024);
const EXT_OK = /\.(pdf|docx|txt|md|markdown|csv)$/i;

interface UploadItem {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'done' | 'error';
  error?: string;
}

export default function KnowledgePage() {
  const { wsPath, href, can } = useWorkspace();
  const toast = useToast();
  const { data, error, mutate, isLoading } = useSWR<{ data: KnowledgeDoc[]; nextCursor: string | null }>(
    can('knowledge.manage') ? [wsPath('/knowledge/documents'), { limit: 200 }] : null,
    {
      // Poll while anything is still being processed.
      refreshInterval: (d) => (d?.data.some((x) => isProcessing(x.status)) ? 2000 : 0),
    },
  );
  const docs = data?.data ?? [];
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [toDelete, setToDelete] = useState<KnowledgeDoc | null>(null);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        const key = `${f.name}-${f.size}-${Date.now()}-${Math.random()}`;
        let err: string | undefined;
        if (f.size > UPLOAD_LIMITS.knowledgeDocument.maxBytes) err = `Too large (max ${MAX_MB} MB)`;
        else if (!EXT_OK.test(f.name)) err = 'Unsupported type — use PDF, DOCX, TXT, MD or CSV';
        else if (f.size === 0) err = 'The file is empty';
        const item: UploadItem = { key, name: f.name, size: f.size, state: err ? 'error' : 'uploading', error: err };
        setUploads((u) => [item, ...u].slice(0, 10));
        if (err) continue;
        const fd = new FormData();
        fd.append('file', f, f.name);
        try {
          await api(wsPath('/knowledge/documents'), { method: 'POST', body: fd });
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'done' } : x)));
          void mutate();
        } catch (e) {
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'error', error: errorMessage(e) } : x)));
        }
      }
    },
    [wsPath, mutate],
  );

  async function reprocess(d: KnowledgeDoc) {
    try {
      await api(wsPath(`/knowledge/documents/${d.id}/reprocess`), { method: 'POST' });
      toast.info(`Reprocessing “${d.title}”`);
      void mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (!can('knowledge.manage')) {
    return <EmptyState title="Creators only" description="Knowledge documents are managed by creators and admins." />;
  }

  const shown = filter ? docs.filter((d) => d.title.toLowerCase().includes(filter.toLowerCase()) || d.fileName?.toLowerCase().includes(filter.toLowerCase())) : docs;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge"
        description="Upload reference documents (policies, product sheets, case files). Scenarios that include them let the agent search and cite passages. Document text is treated as reference data, never as instructions."
        actions={
          <Button variant="secondary" onClick={() => setPasteOpen(true)}>
            Paste text
          </Button>
        }
      />

      <Card>
        <div
          role="button"
          tabIndex={0}
          aria-label={`Upload documents. PDF, Word, text, Markdown or CSV up to ${MAX_MB} MB.`}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void uploadFiles(Array.from(e.dataTransfer.files));
          }}
          className={clsx(
            'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            dragOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:bg-slate-50',
          )}
        >
          <p className="text-sm font-medium text-slate-800">Drop files here or click to choose</p>
          <p className="mt-1 text-xs text-slate-500">PDF, Word (.docx), TXT, Markdown or CSV · up to {MAX_MB} MB each · scanned (image-only) PDFs are not supported</p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={KNOWLEDGE_ACCEPT}
            className="sr-only"
            data-testid="knowledge-file-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void uploadFiles(files);
            }}
          />
        </div>
        {uploads.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm" aria-live="polite">
            {uploads.map((u) => (
              <li key={u.key} className="flex items-center gap-2">
                <span className="truncate">{u.name}</span>
                <span className="text-xs text-slate-500">{formatBytes(u.size)}</span>
                {u.state === 'uploading' && <Badge tone="blue">Uploading…</Badge>}
                {u.state === 'done' && <Badge tone="green">Uploaded</Badge>}
                {u.state === 'error' && <Badge tone="red">{u.error}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={`Documents${docs.length ? ` (${docs.length})` : ''}`}
        actions={<Input aria-label="Filter documents" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />}
      >
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : isLoading ? (
          <Loading />
        ) : docs.length === 0 ? (
          <EmptyState title="No documents yet" description="Upload a file or paste text to build this workspace’s knowledge base." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Type</Th>
                <Th className="hidden md:table-cell">Size</Th>
                <Th className="hidden lg:table-cell">Chunks</Th>
                <Th className="hidden lg:table-cell">Used by</Th>
                <Th className="hidden lg:table-cell">Added</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <Link href={href(`/knowledge/${d.id}`)} className="font-medium text-brand-700 hover:underline">
                      {d.title}
                    </Link>
                    {d.fileName && <div className="text-xs text-slate-500">{d.fileName}</div>}
                    {d.status === 'FAILED' && d.error && <div className="mt-1 max-w-md text-xs text-red-700">{d.error}</div>}
                    {isProcessing(d.status) && d.error && <div className="mt-1 max-w-md text-xs text-amber-700">{d.error}</div>}
                  </Td>
                  <Td>
                    <StatusPill status={d.status} error={d.error} />
                  </Td>
                  <Td className="hidden md:table-cell">{typeLabel(d.mimeType)}{d.pageCount ? ` · ${d.pageCount} p.` : ''}</Td>
                  <Td className="hidden md:table-cell">{formatBytes(d.sizeBytes)}</Td>
                  <Td className="hidden lg:table-cell">{d.chunkCount}</Td>
                  <Td className="hidden lg:table-cell">
                    {d.referencedBy.length ? (
                      <span title={d.referencedBy.map((r) => r.name).join(', ')}>{d.referencedBy.length} scenario{d.referencedBy.length === 1 ? '' : 's'}</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>
                  <Td className="hidden lg:table-cell">{formatDate(d.createdAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {(d.status === 'FAILED' || d.status === 'COMPLETED') && d.hasSource && (
                        <Button size="sm" variant="ghost" onClick={() => reprocess(d)}>
                          Reprocess
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setToDelete(d)}>
                        Delete
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <SearchTester docs={docs} />

      <PasteTextModal open={pasteOpen} onClose={() => setPasteOpen(false)} onCreated={() => mutate()} />
      <DeleteModal doc={toDelete} onClose={() => setToDelete(null)} onDeleted={() => mutate()} />
    </div>
  );
}

function PasteTextModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [format, setFormat] = useState<'text' | 'markdown'>('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(wsPath('/knowledge/documents/text'), { method: 'POST', body: { title: title.trim(), text, format } });
      toast.success('Document added — processing');
      setTitle('');
      setText('');
      onCreated();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Paste text"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!title.trim() || !text.trim()}>
            Add document
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Title" required>
          {(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Format" hint="Markdown headings (# …) are used as section labels in citations.">
          {(id) => (
            <Select id={id} value={format} onChange={(e) => setFormat(e.target.value as 'text' | 'markdown')}>
              <option value="text">Plain text</option>
              <option value="markdown">Markdown</option>
            </Select>
          )}
        </Field>
        <Field label="Text" required hint={`${text.length.toLocaleString()} / 2,000,000 characters`}>
          {(id) => <Textarea id={id} rows={12} value={text} onChange={(e) => setText(e.target.value)} maxLength={2_000_000} />}
        </Field>
      </div>
    </Modal>
  );
}

function DeleteModal({ doc, onClose, onDeleted }: { doc: KnowledgeDoc | null; onClose: () => void; onDeleted: () => void }) {
  const { wsPath, href } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!doc) return null;
  const refs = doc.referencedBy;

  async function confirm() {
    if (!doc) return;
    setBusy(true);
    try {
      await api(wsPath(`/knowledge/documents/${doc.id}`), { method: 'DELETE' });
      toast.success(`Deleted “${doc.title}”`);
      onDeleted();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete “${doc.title}”?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} loading={busy}>
            Delete document
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>The file, its extracted text and search index are removed. This cannot be undone.</p>
        {refs.length > 0 ? (
          <Alert tone="warning" title={`Used by ${refs.length} scenario${refs.length === 1 ? '' : 's'}`}>
            <ul className="mt-1 list-disc pl-5">
              {refs.map((r) => (
                <li key={r.scenarioId}>
                  <Link className="underline" href={href(`/scenarios/${r.scenarioId}`)}>
                    {r.name}
                  </Link>{' '}
                  {r.published ? `(published v${r.version})` : ''}
                  {r.draft ? ' (draft)' : ''}
                </li>
              ))}
            </ul>
            <p className="mt-2">Agents in these scenarios will no longer find its content. Published versions keep the reference but it will return no results.</p>
          </Alert>
        ) : (
          <p className="text-slate-600">No scenario references this document.</p>
        )}
      </div>
    </Modal>
  );
}
