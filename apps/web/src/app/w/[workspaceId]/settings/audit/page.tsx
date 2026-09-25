'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Button, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Table, Td, Th, useToast } from '@/components/ui';
import { download, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

interface Entry {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  actor: { type: 'user' | 'api_key' | 'system'; id: string | null; email: string | null; name: string | null };
}

export default function AuditPage() {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const [f, setF] = useState({ action: '', actor: '', targetId: '', from: '', to: '' });
  const [cursors, setCursors] = useState<string[]>([]);
  const [detail, setDetail] = useState<Entry | null>(null);
  const query = {
    action: f.action.trim() || undefined,
    actor: f.actor.trim() || undefined,
    targetId: f.targetId.trim() || undefined,
    from: f.from ? new Date(f.from).toISOString() : undefined,
    to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : undefined,
  };
  const cursor = cursors[cursors.length - 1];
  const { data, error } = useSWR<{ data: Entry[]; nextCursor: string | null }>(can('audit.view') ? [wsPath('/audit'), { ...query, limit: 50, cursor }] : null);
  if (!can('audit.view')) return <Alert tone="warning">Only admins can view the audit log.</Alert>;
  const set = (k: keyof typeof f, v: string) => {
    setF((s) => ({ ...s, [k]: v }));
    setCursors([]);
  };
  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Sensitive changes in this workspace: roles, access links and tokens, publishing, settings, quotas, exports and deletions."
        actions={
          <Button variant="secondary" onClick={() => download(wsPath('/audit/export.csv'), 'audit.csv', query).catch((e) => toast.error(errorMessage(e)))}>
            Export CSV
          </Button>
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-5">
        <Field label="Action starts with">{(id) => <Input id={id} placeholder="share_link." value={f.action} onChange={(e) => set('action', e.target.value)} />}</Field>
        <Field label="Actor email contains">{(id) => <Input id={id} value={f.actor} onChange={(e) => set('actor', e.target.value)} />}</Field>
        <Field label="Target id">{(id) => <Input id={id} value={f.targetId} onChange={(e) => set('targetId', e.target.value)} />}</Field>
        <Field label="From">{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />}</Field>
      </div>
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <Loading />
      ) : !data.data.length ? (
        <EmptyState title="No matching entries" />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Target</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.data.map((e) => (
                <tr key={e.id}>
                  <Td>{formatDate(e.createdAt)}</Td>
                  <Td>
                    <code className="text-xs">{e.action}</code>
                  </Td>
                  <Td>{e.actor.type === 'user' ? e.actor.email ?? e.actor.id : e.actor.type === 'api_key' ? `API key ${e.actor.id?.slice(-6)}` : 'System'}</Td>
                  <Td className="text-xs text-slate-600">
                    {e.targetType ?? '—'} {e.targetId && <span className="text-slate-400">{e.targetId}</span>}
                  </Td>
                  <Td className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setDetail(e)}>
                      Details
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-3 flex justify-end gap-2">
            {cursors.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setCursors((c) => c.slice(0, -1))}>
                Previous
              </Button>
            )}
            {data.nextCursor && (
              <Button variant="secondary" size="sm" onClick={() => setCursors((c) => [...c, data.nextCursor!])}>
                Next
              </Button>
            )}
          </div>
        </>
      )}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.action ?? ''} wide>
        {detail && (
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-slate-500">Time</dt>
            <dd>{formatDate(detail.createdAt)}</dd>
            <dt className="text-slate-500">Actor</dt>
            <dd>
              {detail.actor.type} {detail.actor.email ?? detail.actor.id ?? ''}
            </dd>
            <dt className="text-slate-500">Target</dt>
            <dd>
              {detail.targetType} {detail.targetId}
            </dd>
            {detail.ip && (
              <>
                <dt className="text-slate-500">IP</dt>
                <dd>{detail.ip}</dd>
              </>
            )}
            <dt className="text-slate-500">Details</dt>
            <dd>
              <pre className="max-h-80 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(detail.metadata, null, 2)}</pre>
            </dd>
          </dl>
        )}
      </Modal>
    </div>
  );
}
