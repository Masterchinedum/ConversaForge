'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Button, Card, Checkbox, Field, Input, Select } from '@/components/ui';
import { Highlighted } from './parts';
import type { KnowledgeDoc, SearchResult } from './types';

interface SearchResponse {
  query: string;
  tookMs: number;
  results: SearchResult[];
  modelContext: string;
}

/** Try queries the way an agent's knowledge_search tool would, and see ranked excerpts with citations. */
export function SearchTester({ docs, fixedDocumentId }: { docs: KnowledgeDoc[]; fixedDocumentId?: string }) {
  const { wsPath, href } = useWorkspace();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<string>(fixedDocumentId ?? '');
  const [topK, setTopK] = useState(5);
  const [showContext, setShowContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const ready = docs.filter((d) => d.status === 'COMPLETED');

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<SearchResponse>(wsPath('/knowledge/search'), {
        method: 'POST',
        body: { query: query.trim(), topK, ...(scope ? { documentIds: [scope] } : {}) },
      });
      setRes(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Search tester">
      <form onSubmit={run} className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <Field label="Query" hint="Plain words or quoted phrases; -word excludes.">
          {(id) => <Input id={id} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={500} placeholder="e.g. refund window for damaged items" />}
        </Field>
        {!fixedDocumentId && (
          <Field label="Documents">
            {(id) => (
              <Select id={id} value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">All ready documents ({ready.length})</option>
                {ready.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Results">
          {(id) => (
            <Select id={id} value={topK} onChange={(e) => setTopK(Number(e.target.value))}>
              {[3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  Top {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" loading={busy} disabled={!query.trim()}>
          Search
        </Button>
      </form>

      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {res && (
        <div className="mt-4 space-y-3" aria-live="polite">
          <p className="text-xs text-slate-500">
            {res.results.length} result{res.results.length === 1 ? '' : 's'} for “{res.query}” in {res.tookMs} ms
          </p>
          {res.results.length === 0 && <p className="text-sm text-slate-600">No matching passages. Only documents with status “Ready” are searched.</p>}
          <ol className="space-y-3">
            {res.results.map((r, i) => (
              <li key={r.chunkId} className="rounded-md border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="font-semibold text-slate-700">#{i + 1}</span>
                  <Link href={href(`/knowledge/${r.documentId}`)} className="font-medium text-brand-700 hover:underline">
                    {r.documentTitle}
                  </Link>
                  {r.page != null && <span>page {r.page}</span>}
                  {r.heading && <span>· {r.heading}</span>}
                  <span className="ml-auto font-mono">score {r.score.toFixed(4)}</span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-800">
                  <Highlighted text={r.snippet} />
                </p>
                <p className="mt-1 font-mono text-xs text-slate-500">{r.citation}</p>
              </li>
            ))}
          </ol>
          <Checkbox label="Show exactly what the agent receives" checked={showContext} onChange={setShowContext} />
          {showContext && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-slate-900 p-3 text-xs text-slate-100">{res.modelContext}</pre>
          )}
        </div>
      )}
    </Card>
  );
}
