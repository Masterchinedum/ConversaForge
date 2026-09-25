'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Badge, Button, Card, ConfirmButton, CopyButton, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, Td, Textarea, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

interface Availability {
  twilio: { configured: boolean; source: string | null; reason: string | null };
  recall: { configured: boolean; source: string | null; region: string | null; reason: string | null; webhookSecretConfigured: boolean };
  speech: { stt: string | null; tts: string | null; ready: boolean; reason: string | null };
  publicUrl: { apiPublicUrl: string; ok: boolean; reason: string | null };
  phoneReady: boolean;
  meetingsReady: boolean;
}
interface PhoneNumber {
  id: string;
  e164: string;
  label: string | null;
  inboundScenarioId: string | null;
  voiceUrl: string;
  statusCallbackUrl: string;
}
interface ScenarioLite {
  id: string;
  name: string;
  status: string;
}
interface Batch {
  id: string;
  name: string;
  scenarioId: string;
  status: string;
  statusReason: string | null;
  concurrency: number;
  scheduledAt: string | null;
  createdAt: string;
  progress: Record<string, number> & { total: number };
}
interface Bot {
  id: string;
  scenarioId: string;
  meetingUrl: string;
  platform: string | null;
  scheduledAt: string | null;
  status: string;
  sessionId: string | null;
  lastError: string | null;
  botName: string | null;
  createdAt: string;
}

const statusTone: Record<string, 'gray' | 'green' | 'yellow' | 'red' | 'blue' | 'purple'> = {
  DRAFT: 'gray',
  SCHEDULED: 'blue',
  RUNNING: 'purple',
  COMPLETED: 'green',
  CANCELLED: 'gray',
  BLOCKED: 'red',
  JOINING: 'blue',
  IN_CALL: 'purple',
  FAILED: 'red',
  ACTIVE: 'purple',
  READY: 'blue',
  CREATED: 'gray',
  ABANDONED: 'yellow',
};

function ProviderBanner({ ok, title, okText, reason, badText = 'Not configured' }: { ok: boolean; title: string; okText: string; reason: string | null; badText?: string }) {
  return (
    <Alert tone={ok ? 'success' : 'warning'} title={`${title}: ${ok ? okText : badText}`}>
      {!ok && reason && <span className="text-xs">{reason}</span>}
    </Alert>
  );
}

function usePublishedScenarios() {
  const { wsPath } = useWorkspace();
  return useSWR<{ data: ScenarioLite[] }>(wsPath('/scenarios?status=PUBLISHED&limit=100'));
}

function ScenarioSelect({ id, value, onChange, allowNone }: { id: string; value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  const { data } = usePublishedScenarios();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allowNone ? 'Not answered (says “not configured”)' : 'Choose a published scenario…'}</option>
      {data?.data.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

// ───────────────────────── Phone ─────────────────────────

function PhoneTab({ av }: { av: Availability }) {
  const { wsPath, href } = useWorkspace();
  const toast = useToast();
  const numbers = useSWR<{ data: PhoneNumber[] }>(wsPath('/channels/phone-numbers'));
  const calls = useSWR<{ data: any[] }>([wsPath('/channels/calls'), { limit: 20 }], { refreshInterval: 10_000 });
  const [newNumber, setNewNumber] = useState({ e164: '', label: '', inboundScenarioId: '' });
  const [call, setCall] = useState({ to: '', scenarioId: '', fromNumberId: '', name: '' });
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-6">
      <Card title="Phone numbers">
        <p className="mb-3 text-sm text-slate-600">
          Buy or port a number in your Twilio console, then add it here. In Twilio set <em>A call comes in</em> → Webhook (HTTP POST) to the voice URL below and
          <em> Call status changes</em> to the status URL. Scenarios must have <strong>Channels → Phone</strong> enabled.
        </p>
        {numbers.error ? (
          <ErrorState error={numbers.error} retry={() => numbers.mutate()} />
        ) : !numbers.data ? (
          <Loading />
        ) : numbers.data.data.length === 0 ? (
          <EmptyState title="No phone numbers" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Label</Th>
                <Th>Inbound scenario</Th>
                <Th>Twilio webhooks</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {numbers.data.data.map((n) => (
                <tr key={n.id}>
                  <Td className="font-mono">{n.e164}</Td>
                  <Td>{n.label ?? '—'}</Td>
                  <Td>
                    <ScenarioSelectInline
                      value={n.inboundScenarioId ?? ''}
                      onChange={async (v) => {
                        try {
                          await api(wsPath(`/channels/phone-numbers/${n.id}`), { method: 'PATCH', body: { inboundScenarioId: v || null } });
                          toast.success('Inbound scenario updated');
                          await numbers.mutate();
                        } catch (e) {
                          toast.error(errorMessage(e));
                        }
                      }}
                    />
                  </Td>
                  <Td className="whitespace-normal text-xs">
                    <div className="flex items-center gap-1">
                      Voice: <code className="break-all">{n.voiceUrl}</code> <CopyButton value={n.voiceUrl} />
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      Status: <code className="break-all">{n.statusCallbackUrl}</code> <CopyButton value={n.statusCallbackUrl} />
                    </div>
                  </Td>
                  <Td>
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      confirmText={`Remove ${n.e164}? Inbound calls will be rejected.`}
                      onConfirm={async () => {
                        await api(wsPath(`/channels/phone-numbers/${n.id}`), { method: 'DELETE' });
                        await numbers.mutate();
                      }}
                    >
                      Remove
                    </ConfirmButton>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <form
          className="mt-4 grid gap-3 sm:grid-cols-4 sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(wsPath('/channels/phone-numbers'), {
                method: 'POST',
                body: { e164: newNumber.e164, label: newNumber.label || null, inboundScenarioId: newNumber.inboundScenarioId || null },
              });
              setNewNumber({ e164: '', label: '', inboundScenarioId: '' });
              toast.success('Number added');
              await numbers.mutate();
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <Field label="Number (E.164)" required>
            {(id) => <Input id={id} placeholder="+14155550123" value={newNumber.e164} onChange={(e) => setNewNumber({ ...newNumber, e164: e.target.value })} />}
          </Field>
          <Field label="Label">{(id) => <Input id={id} value={newNumber.label} onChange={(e) => setNewNumber({ ...newNumber, label: e.target.value })} />}</Field>
          <Field label="Answers with">{(id) => <ScenarioSelect id={id} allowNone value={newNumber.inboundScenarioId} onChange={(v) => setNewNumber({ ...newNumber, inboundScenarioId: v })} />}</Field>
          <Button type="submit" disabled={!newNumber.e164}>
            Add number
          </Button>
        </form>
      </Card>

      <Card title="Place an outbound call">
        {!av.phoneReady && (
          <div className="mb-3">
            <Alert tone="warning" title="Calls are blocked until phone is fully configured">
              {[av.twilio.reason, av.speech.reason, av.publicUrl.reason].filter(Boolean).join(' ')}
            </Alert>
          </div>
        )}
        <form
          className="grid gap-3 sm:grid-cols-5 sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api<{ sessionId: string; callSid: string }>(wsPath('/channels/calls'), {
                method: 'POST',
                body: { to: call.to, scenarioId: call.scenarioId, ...(call.fromNumberId ? { fromNumberId: call.fromNumberId } : {}), ...(call.name ? { name: call.name } : {}) },
              });
              toast.success(`Calling… (session ${r.sessionId})`);
              await calls.mutate();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="To (E.164)" required>
            {(id) => <Input id={id} placeholder="+14155550123" value={call.to} onChange={(e) => setCall({ ...call, to: e.target.value })} />}
          </Field>
          <Field label="Name">{(id) => <Input id={id} value={call.name} onChange={(e) => setCall({ ...call, name: e.target.value })} />}</Field>
          <Field label="Scenario" required>
            {(id) => <ScenarioSelect id={id} value={call.scenarioId} onChange={(v) => setCall({ ...call, scenarioId: v })} />}
          </Field>
          <Field label="From">
            {(id) => (
              <Select id={id} value={call.fromNumberId} onChange={(e) => setCall({ ...call, fromNumberId: e.target.value })}>
                <option value="">First number</option>
                {numbers.data?.data.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.e164}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" loading={busy} disabled={!call.to || !call.scenarioId}>
            Call
          </Button>
        </form>
      </Card>

      <Card title="Recent calls">
        {!calls.data ? (
          <Loading />
        ) : !calls.data.data.length ? (
          <EmptyState title="No calls yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Direction</Th>
                <Th>Caller / callee</Th>
                <Th>Scenario</Th>
                <Th>State</Th>
                <Th>Duration</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {calls.data.data.map((c) => (
                <tr key={c.id}>
                  <Td>{c.channel === 'PHONE_INBOUND' ? 'Inbound' : 'Outbound'}</Td>
                  <Td>{c.participant?.name ?? c.participant?.externalId ?? '—'}</Td>
                  <Td>{c.scenario?.name}</Td>
                  <Td className="whitespace-normal">
                    <Badge tone={statusTone[c.state] ?? 'gray'}>{c.state.toLowerCase()}</Badge>
                    {c.errorCode && <span className="ml-1 text-xs text-red-700" title={c.errorMessage ?? ''}>{c.errorCode}</span>}
                    {c.errorMessage && <p className="max-w-xs text-xs text-slate-500">{c.errorMessage}</p>}
                  </Td>
                  <Td>{formatDuration(c.durationMs)}</Td>
                  <Td>{formatDate(c.createdAt)}</Td>
                  <Td>
                    <div className="flex gap-1">
                      <Link className="text-xs text-brand-700 hover:underline" href={href(`/sessions/${c.id}`)}>
                        Session
                      </Link>
                      {['ACTIVE', 'PAUSED', 'RECONNECTING'].includes(c.state) && (
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          confirmText="Transfer this call to the scenario's transfer number?"
                          onConfirm={async () => {
                            try {
                              await api(wsPath(`/channels/calls/${c.id}/transfer`), { method: 'POST' });
                              toast.success('Transferring');
                            } catch (e) {
                              toast.error(errorMessage(e));
                            }
                          }}
                        >
                          Transfer
                        </ConfirmButton>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function ScenarioSelectInline({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = usePublishedScenarios();
  return (
    <Select aria-label="Inbound scenario" value={value} onChange={(e) => onChange(e.target.value)} className="w-56">
      <option value="">Not answered</option>
      {data?.data.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

// ───────────────────────── Batches ─────────────────────────

function BatchesTab() {
  const { wsPath, href } = useWorkspace();
  const toast = useToast();
  const batches = useSWR<{ data: Batch[] }>([wsPath('/channels/batches'), { limit: 50 }], { refreshInterval: 10_000 });
  const numbers = useSWR<{ data: PhoneNumber[] }>(wsPath('/channels/phone-numbers'));
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', scenarioId: '', fromNumberId: '', concurrency: 1, scheduledAt: '' });
  const [upload, setUpload] = useState<Batch | null>(null);
  const [csv, setCsv] = useState('');
  const [uploadResult, setUploadResult] = useState<any>(null);
  const [targetsFor, setTargetsFor] = useState<Batch | null>(null);
  const targets = useSWR<{ data: any[] }>(targetsFor ? [wsPath(`/channels/batches/${targetsFor.id}/targets`), { limit: 100 }] : null, { refreshInterval: 5000 });

  return (
    <Card
      title="Batch & scheduled calls"
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          New batch
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Upload a CSV of people to call. Each answered call becomes a normal session (scored and extracted like any other). Columns: <code>phone</code> (E.164, required), <code>name</code>,{' '}
        <code>email</code>, <code>external_id</code>, and any of the scenario’s allowlisted variables.
      </p>
      {batches.error ? (
        <ErrorState error={batches.error} retry={() => batches.mutate()} />
      ) : !batches.data ? (
        <Loading />
      ) : !batches.data.data.length ? (
        <EmptyState title="No batches yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Progress</Th>
              <Th>Concurrency</Th>
              <Th>Scheduled</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batches.data.data.map((b) => {
              const done = (b.progress.COMPLETED ?? 0) + (b.progress.FAILED ?? 0) + (b.progress.NO_ANSWER ?? 0) + (b.progress.SKIPPED ?? 0);
              return (
                <tr key={b.id}>
                  <Td className="font-medium">{b.name}</Td>
                  <Td className="whitespace-normal">
                    <Badge tone={statusTone[b.status] ?? 'gray'}>{b.status.toLowerCase()}</Badge>
                    {b.statusReason && <p className="max-w-xs text-xs text-red-700">{b.statusReason}</p>}
                  </Td>
                  <Td>
                    <div className="w-40">
                      <div className="h-2 rounded bg-slate-100" role="progressbar" aria-valuenow={done} aria-valuemax={b.progress.total} aria-label="Batch progress">
                        <div className="h-2 rounded bg-brand-600" style={{ width: `${b.progress.total ? (done / b.progress.total) * 100 : 0}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {done}/{b.progress.total} · ✓{b.progress.COMPLETED ?? 0} · no answer {b.progress.NO_ANSWER ?? 0} · failed {b.progress.FAILED ?? 0}
                      </p>
                    </div>
                  </Td>
                  <Td>{b.concurrency}</Td>
                  <Td>{b.scheduledAt ? formatDate(b.scheduledAt) : '—'}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setTargetsFor(targetsFor?.id === b.id ? null : b)}>
                        Targets
                      </Button>
                      {['DRAFT', 'BLOCKED', 'SCHEDULED'].includes(b.status) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setUpload(b);
                            setCsv('');
                            setUploadResult(null);
                          }}
                        >
                          Upload CSV
                        </Button>
                      )}
                      {['DRAFT', 'BLOCKED'].includes(b.status) && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              const r = await api<Batch>(wsPath(`/channels/batches/${b.id}/start`), { method: 'POST', body: {} });
                              if (r.status === 'BLOCKED') toast.error(`Blocked: ${r.statusReason}`);
                              else toast.success(r.status === 'SCHEDULED' ? 'Scheduled' : 'Dialing started');
                              await batches.mutate();
                            } catch (e) {
                              toast.error(errorMessage(e));
                            }
                          }}
                        >
                          {b.scheduledAt ? 'Schedule' : 'Start'}
                        </Button>
                      )}
                      {!['COMPLETED', 'CANCELLED'].includes(b.status) && (
                        <ConfirmButton
                          size="sm"
                          variant="danger"
                          confirmText="Cancel this batch? Pending targets are skipped; calls in progress continue."
                          onConfirm={async () => {
                            await api(wsPath(`/channels/batches/${b.id}/cancel`), { method: 'POST' });
                            await batches.mutate();
                          }}
                        >
                          Cancel
                        </ConfirmButton>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {targetsFor && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">Targets — {targetsFor.name}</h3>
          {!targets.data ? (
            <Loading />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Phone</Th>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th>Attempts</Th>
                  <Th>Error</Th>
                  <Th>Session</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {targets.data.data.map((t) => (
                  <tr key={t.id}>
                    <Td className="font-mono">{t.phone}</Td>
                    <Td>{t.name ?? '—'}</Td>
                    <Td>
                      <Badge tone={t.status === 'COMPLETED' ? 'green' : t.status === 'FAILED' ? 'red' : t.status === 'NO_ANSWER' ? 'yellow' : 'gray'}>{t.status.toLowerCase()}</Badge>
                    </Td>
                    <Td>{t.attempts}</Td>
                    <Td className="max-w-xs truncate">{t.lastError ?? ''}</Td>
                    <Td>
                      {t.sessionId ? (
                        <Link className="text-xs text-brand-700 hover:underline" href={href(`/sessions/${t.sessionId}`)}>
                          Open
                        </Link>
                      ) : (
                        '—'
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New call batch"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              disabled={!form.name || !form.scenarioId}
              onClick={async () => {
                try {
                  const r = await api<Batch>(wsPath('/channels/batches'), {
                    method: 'POST',
                    body: {
                      name: form.name,
                      scenarioId: form.scenarioId,
                      fromNumberId: form.fromNumberId || null,
                      concurrency: Number(form.concurrency),
                      scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
                    },
                  });
                  setCreating(false);
                  if (r.status === 'BLOCKED') toast.error(`Created but blocked: ${r.statusReason}`);
                  await batches.mutate();
                  setUpload(r);
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
          </Field>
          <Field label="Scenario" required>
            {(id) => <ScenarioSelect id={id} value={form.scenarioId} onChange={(v) => setForm({ ...form, scenarioId: v })} />}
          </Field>
          <Field label="Call from">
            {(id) => (
              <Select id={id} value={form.fromNumberId} onChange={(e) => setForm({ ...form, fromNumberId: e.target.value })}>
                <option value="">First number</option>
                {numbers.data?.data.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.e164}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Concurrent calls" hint="1–10 calls at a time.">
            {(id) => <Input id={id} type="number" min={1} max={10} value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })} />}
          </Field>
          <Field label="Start at (optional)" hint="Leave empty to start when you press Start.">
            {(id) => <Input id={id} type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />}
          </Field>
        </div>
      </Modal>

      <Modal open={!!upload} onClose={() => setUpload(null)} title={`Upload targets — ${upload?.name ?? ''}`} wide>
        <div className="space-y-3">
          <Field label="CSV file">
            {(id) => (
              <input
                id={id}
                type="file"
                accept=".csv,text/csv"
                className="text-sm"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 1_000_000) return toast.error('The file must be under 1 MB');
                  setCsv(await f.text());
                }}
              />
            )}
          </Field>
          <Field label="…or paste CSV">
            {(id) => <Textarea id={id} rows={8} className="font-mono text-xs" placeholder={'phone,name,email,external_id\n+14155550123,Ada Lovelace,ada@example.com,crm-1'} value={csv} onChange={(e) => setCsv(e.target.value)} />}
          </Field>
          {uploadResult && (
            <Alert tone={uploadResult.errorCount ? 'warning' : 'success'} title={`Added ${uploadResult.added} target(s)`}>
              <ul className="list-disc pl-5 text-xs">
                {uploadResult.skippedExisting > 0 && <li>{uploadResult.skippedExisting} already in the batch</li>}
                {uploadResult.duplicatesInFile > 0 && <li>{uploadResult.duplicatesInFile} duplicate row(s) in the file</li>}
                {uploadResult.ignoredColumns.length > 0 && <li>Ignored columns (not in the scenario allowlist): {uploadResult.ignoredColumns.join(', ')}</li>}
                {uploadResult.errors.map((e: any) => (
                  <li key={e.row}>
                    Row {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setUpload(null)}>
              Close
            </Button>
            <Button
              disabled={!csv.trim()}
              onClick={async () => {
                try {
                  const r = await api(wsPath(`/channels/batches/${upload!.id}/targets`), { method: 'POST', body: { csv } });
                  setUploadResult(r);
                  await batches.mutate();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Upload
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ───────────────────────── Meetings ─────────────────────────

function MeetingsTab({ av }: { av: Availability }) {
  const { wsPath, href } = useWorkspace();
  const toast = useToast();
  const bots = useSWR<{ data: Bot[] }>([wsPath('/channels/meeting-bots'), { limit: 50 }], { refreshInterval: 10_000 });
  const [form, setForm] = useState({ meetingUrl: '', scenarioId: '', joinAt: '', evaluatedSpeakerName: '' });
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-6">
      <Card title="Send a notetaker bot to a meeting">
        <p className="mb-3 text-sm text-slate-600">
          A Recall.ai bot joins the Zoom / Google Meet / Teams meeting, transcribes it in real time, and the meeting is analysed with the scenario’s rubric and extraction when it ends.
          Tell participants the meeting is being transcribed. Calendar auto-join (Google Calendar) is not implemented — schedule bots per meeting link.
        </p>
        {!av.meetingsReady && (
          <div className="mb-3">
            <Alert tone="warning" title="New bots will be BLOCKED until Recall.ai is configured">
              {[av.recall.reason, av.publicUrl.reason].filter(Boolean).join(' ')}
            </Alert>
          </div>
        )}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api<Bot>(wsPath('/channels/meeting-bots'), {
                method: 'POST',
                body: {
                  meetingUrl: form.meetingUrl,
                  scenarioId: form.scenarioId,
                  ...(form.joinAt ? { joinAt: new Date(form.joinAt).toISOString() } : {}),
                  ...(form.evaluatedSpeakerName ? { evaluatedSpeakerName: form.evaluatedSpeakerName } : {}),
                },
              });
              if (r.status === 'BLOCKED' || r.status === 'FAILED') toast.error(`${r.status}: ${r.lastError}`);
              else toast.success('Bot scheduled');
              await bots.mutate();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Meeting link" required>
            {(id) => <Input id={id} placeholder="https://meet.google.com/abc-defg-hij" value={form.meetingUrl} onChange={(e) => setForm({ ...form, meetingUrl: e.target.value })} />}
          </Field>
          <Field label="Scenario (rubric & extraction)" required>
            {(id) => <ScenarioSelect id={id} value={form.scenarioId} onChange={(v) => setForm({ ...form, scenarioId: v })} />}
          </Field>
          <Field label="Join at (optional)" hint="Empty = join now.">
            {(id) => <Input id={id} type="datetime-local" value={form.joinAt} onChange={(e) => setForm({ ...form, joinAt: e.target.value })} />}
          </Field>
          <Field label="Evaluated speaker (optional)" hint="Display name of the person being evaluated; others are treated as the counterpart.">
            {(id) => <Input id={id} value={form.evaluatedSpeakerName} onChange={(e) => setForm({ ...form, evaluatedSpeakerName: e.target.value })} />}
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" loading={busy} disabled={!form.meetingUrl || !form.scenarioId}>
              Schedule bot
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Meeting bots">
        {!bots.data ? (
          <Loading />
        ) : !bots.data.data.length ? (
          <EmptyState title="No meeting bots yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Meeting</Th>
                <Th>Status</Th>
                <Th>Join at</Th>
                <Th>Session</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bots.data.data.map((b) => (
                <tr key={b.id}>
                  <Td className="max-w-xs truncate">
                    <span className="mr-1 text-xs text-slate-500">{b.platform?.replace('_', ' ')}</span>
                    {b.meetingUrl}
                  </Td>
                  <Td className="whitespace-normal">
                    <Badge tone={statusTone[b.status] ?? 'gray'}>{b.status.toLowerCase()}</Badge>
                    {b.lastError && <p className="max-w-xs text-xs text-red-700">{b.lastError}</p>}
                  </Td>
                  <Td>{b.scheduledAt ? formatDate(b.scheduledAt) : 'Now'}</Td>
                  <Td>
                    {b.sessionId ? (
                      <Link className="text-xs text-brand-700 hover:underline" href={href(`/sessions/${b.sessionId}`)}>
                        Open session
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    {['SCHEDULED', 'JOINING', 'IN_CALL'].includes(b.status) && (
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        confirmText="Remove the bot from this meeting?"
                        onConfirm={async () => {
                          await api(wsPath(`/channels/meeting-bots/${b.id}/cancel`), { method: 'POST' });
                          await bots.mutate();
                        }}
                      >
                        Cancel
                      </ConfirmButton>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

export default function ChannelsPage() {
  const { can, wsPath } = useWorkspace();
  const [tab, setTab] = useState<'phone' | 'batches' | 'meetings'>('phone');
  const av = useSWR<Availability>(can('channels.manage') ? wsPath('/channels/availability') : null);
  if (!can('channels.manage')) return <Alert tone="warning" title="Admins only">You need the admin role to manage phone and meeting channels.</Alert>;
  return (
    <div className="space-y-6">
      <PageHeader title="Phone & meetings" description="Run scenarios over real phone calls (Twilio) and analyse real meetings (Recall.ai). Nothing here is simulated — missing credentials block the channel with the reason." />
      {av.error ? (
        <ErrorState error={av.error} retry={() => av.mutate()} />
      ) : !av.data ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <ProviderBanner ok={av.data.twilio.configured} title="Twilio" okText={`Configured (${av.data.twilio.source} credentials)`} reason={av.data.twilio.reason} />
            <ProviderBanner ok={av.data.speech.ready} title="Server speech (phone)" okText={`STT ${av.data.speech.stt}, TTS ${av.data.speech.tts}`} reason={av.data.speech.reason} />
            <ProviderBanner ok={av.data.recall.configured} title="Recall.ai" okText={`Configured (${av.data.recall.region})`} reason={av.data.recall.reason} />
            <ProviderBanner ok={av.data.publicUrl.ok} title="Public API URL" okText={av.data.publicUrl.apiPublicUrl} badText={`${av.data.publicUrl.apiPublicUrl} is not publicly reachable`} reason={av.data.publicUrl.reason} />
          </div>
          <Tabs
            tabs={[
              { id: 'phone', label: 'Phone numbers & calls' },
              { id: 'batches', label: 'Batch calls' },
              { id: 'meetings', label: 'Meeting bots' },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === 'phone' && <PhoneTab av={av.data} />}
          {tab === 'batches' && <BatchesTab />}
          {tab === 'meetings' && <MeetingsTab av={av.data} />}
        </>
      )}
    </div>
  );
}
