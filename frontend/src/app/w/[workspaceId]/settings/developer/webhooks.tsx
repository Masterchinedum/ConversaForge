'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { WEBHOOK_EVENTS, type WebhookEventType } from '@cf/shared';
import { Alert, Badge, Button, Card, Checkbox, ConfirmButton, CopyButton, EmptyState, ErrorState, Field, Input, Loading, Modal, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

interface Subscription {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  failureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
  previousSecretExpiresAt: string | null;
  createdAt: string;
}
interface DeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  status: 'PENDING' | 'SUCCEEDED' | 'RETRYING' | 'FAILED';
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}
interface DeliveryDetail extends DeliveryRow {
  payload: unknown;
  attemptLog: Array<{ id: string; attempt: number; manual: boolean; statusCode: number | null; error: string | null; responseSnippet: string | null; durationMs: number | null; createdAt: string }>;
}

const EVENT_HELP: Record<WebhookEventType, string> = {
  'session.started': 'A participant started talking to the agent',
  'session.completed': 'A session ended normally (also sent for abandoned sessions, state = ABANDONED)',
  'session.analyzed': 'Rubric scoring finished (includes the evaluation)',
  'session.extracted': 'Structured variables were extracted (includes the values)',
  'session.failed': 'The session or its analysis failed',
};

const deliveryTone = { SUCCEEDED: 'green', RETRYING: 'yellow', PENDING: 'blue', FAILED: 'red' } as const;

function WebhookForm({ initial, onSaved, onCancel }: { initial?: Subscription; onSaved: (r: Subscription & { secret?: string }) => void; onCancel: () => void }) {
  const { wsPath } = useWorkspace();
  const [url, setUrl] = useState(initial?.url ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [events, setEvents] = useState<string[]>(initial?.events ?? ['session.completed', 'session.analyzed']);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body = { url, description: description || null, events };
      const r = initial
        ? await api<Subscription>(wsPath(`/webhooks/${initial.id}`), { method: 'PATCH', body })
        : await api<Subscription & { secret: string }>(wsPath('/webhooks'), { method: 'POST', body });
      onSaved(r);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4">
      {err && <Alert tone="error">{err}</Alert>}
      <Field label="Endpoint URL" required hint="HTTPS only. Private, loopback and cloud-metadata addresses are blocked (http://localhost is allowed in development).">
        {(id) => <Input id={id} value={url} placeholder="https://example.com/webhooks/conversaforge" onChange={(e) => setUrl(e.target.value)} />}
      </Field>
      <Field label="Description">{(id) => <Input id={id} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Events</legend>
        <div className="mt-2 space-y-2">
          {WEBHOOK_EVENTS.map((ev) => (
            <Checkbox
              key={ev}
              label={<code className="text-xs">{ev}</code>}
              description={EVENT_HELP[ev]}
              checked={events.includes(ev)}
              onChange={(v) => setEvents((p) => (v ? [...p, ev] : p.filter((x) => x !== ev)))}
            />
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={save} loading={saving} disabled={!url.trim() || !events.length}>
          {initial ? 'Save' : 'Add endpoint'}
        </Button>
      </div>
    </div>
  );
}

function DeliveriesModal({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useSWR<{ data: DeliveryRow[]; nextCursor: string | null }>(
    [wsPath(`/webhooks/${sub.id}/deliveries`), { limit: 50, status: status || undefined }],
    { refreshInterval: 5000 },
  );
  const detail = useSWR<DeliveryDetail>(selected ? wsPath(`/webhooks/${sub.id}/deliveries/${selected}`) : null);
  return (
    <Modal open onClose={onClose} title={`Deliveries — ${sub.url}`} wide>
      <div className="mb-3 flex items-center gap-2">
        <label htmlFor="dl-status" className="text-sm text-slate-600">
          Status
        </label>
        <Select id="dl-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">All</option>
          <option value="SUCCEEDED">Succeeded</option>
          <option value="RETRYING">Retrying</option>
          <option value="FAILED">Failed</option>
          <option value="PENDING">Pending</option>
        </Select>
      </div>
      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : isLoading ? (
        <Loading />
      ) : !data?.data.length ? (
        <EmptyState title="No deliveries yet" description="Send a test event or wait for a session event." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Event</Th>
              <Th>Status</Th>
              <Th>Attempts</Th>
              <Th>Response</Th>
              <Th>Created</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((d) => (
              <tr key={d.id} className={selected === d.id ? 'bg-slate-50' : undefined}>
                <Td>
                  <code className="text-xs">{d.eventType}</code>
                </Td>
                <Td>
                  <Badge tone={deliveryTone[d.status]}>{d.status.toLowerCase()}</Badge>
                  {d.status === 'RETRYING' && d.nextAttemptAt && <span className="ml-1 text-xs text-slate-500">next {formatDate(d.nextAttemptAt)}</span>}
                </Td>
                <Td>{d.attempts}</Td>
                <Td className="max-w-[16rem] truncate" >{d.lastStatusCode ?? '—'}{d.lastError && d.status !== 'SUCCEEDED' ? ` · ${d.lastError}` : ''}</Td>
                <Td>{formatDate(d.createdAt)}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setSelected(selected === d.id ? null : d.id)}>
                      {selected === d.id ? 'Hide' : 'Details'}
                    </Button>
                    {(d.status === 'SUCCEEDED' || d.status === 'FAILED') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          try {
                            const r = await api<{ status: string; statusCode: number | null; error: string | null }>(wsPath(`/webhooks/${sub.id}/deliveries/${d.id}/redeliver`), { method: 'POST' });
                            if (r.status === 'SUCCEEDED') toast.success(`Redelivered (HTTP ${r.statusCode})`);
                            else toast.error(`Redelivery failed: ${r.error ?? r.status}`);
                            await mutate();
                            await detail.mutate();
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        Redeliver
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {selected && detail.data && (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-semibold">Attempts</h3>
          <ul className="space-y-1 text-xs">
            {detail.data.attemptLog.map((a) => (
              <li key={a.id} className="rounded border border-slate-200 p-2">
                <span className="font-medium">#{a.attempt}</span>
                {a.manual && <Badge className="ml-1">manual</Badge>} · {formatDate(a.createdAt)} · {a.statusCode ? `HTTP ${a.statusCode}` : 'no response'}
                {a.durationMs != null && ` · ${a.durationMs} ms`}
                {a.error && <span className="block text-red-700">{a.error}</span>}
                {a.responseSnippet && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap bg-slate-50 p-1">{a.responseSnippet}</pre>}
              </li>
            ))}
          </ul>
          <h3 className="text-sm font-semibold">Payload</h3>
          <pre className="max-h-72 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(detail.data.payload, null, 2)}</pre>
        </div>
      )}
    </Modal>
  );
}

export function WebhooksSection() {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<{ data: Subscription[] }>(wsPath('/webhooks?limit=50'));
  const [editing, setEditing] = useState<Subscription | 'new' | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<Subscription | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  return (
    <Card
      title="Webhooks"
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          Add endpoint
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Signed with <code className="rounded bg-slate-100 px-1">X-ConversaForge-Signature: t=…,v1=…</code> (HMAC-SHA256). Failed deliveries are retried with exponential backoff for about 33 hours; an endpoint is
        disabled after repeated failed deliveries and admins are notified.
      </p>
      {secret && (
        <div className="mb-4">
          <Alert tone="success" title="Signing secret — copy it now, it will not be shown again">
            <p className="text-xs">{secret.url}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-900" data-testid="webhook-secret">
                {secret.secret}
              </code>
              <CopyButton value={secret.secret} />
              <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>
                Done
              </Button>
            </div>
          </Alert>
        </div>
      )}
      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : isLoading ? (
        <Loading />
      ) : !data?.data.length ? (
        <EmptyState title="No webhook endpoints" description="Receive session events (started, completed, analyzed, extracted, failed) in your systems." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="break-all font-mono text-sm">{s.url}</p>
                {s.description && <p className="text-xs text-slate-500">{s.description}</p>}
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.active ? <Badge tone="green">active</Badge> : <Badge tone="red">disabled</Badge>}
                  {s.events.map((e) => (
                    <Badge key={e}>{e}</Badge>
                  ))}
                  {s.previousSecretExpiresAt && <Badge tone="yellow">old secret valid until {formatDate(s.previousSecretExpiresAt)}</Badge>}
                </div>
                {!s.active && s.disabledReason && <p className="mt-1 text-xs text-red-700">{s.disabledReason}</p>}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={testing === s.id}
                  onClick={async () => {
                    setTesting(s.id);
                    try {
                      const r = await api<{ status: string; statusCode: number | null; error: string | null }>(wsPath(`/webhooks/${s.id}/test`), { method: 'POST' });
                      if (r.status === 'SUCCEEDED') toast.success(`Ping delivered (HTTP ${r.statusCode})`);
                      else toast.error(`Ping failed: ${r.error ?? `HTTP ${r.statusCode}`}`);
                    } catch (e) {
                      toast.error(errorMessage(e));
                    } finally {
                      setTesting(null);
                    }
                  }}
                >
                  Send test
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setDeliveriesFor(s)}>
                  Deliveries
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api(wsPath(`/webhooks/${s.id}`), { method: 'PATCH', body: { active: !s.active } });
                      await mutate();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  {s.active ? 'Disable' : 'Enable'}
                </Button>
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  confirmText="Rotate the signing secret? The old secret keeps working for 24 hours (both signatures are sent)."
                  onConfirm={async () => {
                    try {
                      const r = await api<{ url: string; secret: string }>(wsPath(`/webhooks/${s.id}/rotate-secret`), { method: 'POST', body: { overlapHours: 24 } });
                      setSecret({ url: r.url, secret: r.secret });
                      await mutate();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Rotate secret
                </ConfirmButton>
                <ConfirmButton
                  size="sm"
                  variant="danger"
                  confirmText="Delete this endpoint and its delivery history?"
                  onConfirm={async () => {
                    try {
                      await api(wsPath(`/webhooks/${s.id}`), { method: 'DELETE' });
                      await mutate();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Delete
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add webhook endpoint' : 'Edit webhook endpoint'} wide>
        {editing && (
          <WebhookForm
            initial={editing === 'new' ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={async (r) => {
              setEditing(null);
              if (r.secret) setSecret({ url: r.url, secret: r.secret });
              await mutate();
            }}
          />
        )}
      </Modal>
      {deliveriesFor && <DeliveriesModal sub={deliveriesFor} onClose={() => setDeliveriesFor(null)} />}
    </Card>
  );
}
