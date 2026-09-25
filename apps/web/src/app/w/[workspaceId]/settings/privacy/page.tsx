'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

interface DataRequest {
  id: string;
  type: 'EXPORT' | 'DELETE';
  participantId: string | null;
  subjectEmail: string | null;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  error: string | null;
  summary: Record<string, number>;
  hasResult: boolean;
  createdAt: string;
  completedAt: string | null;
}

const STATUS_TONE = { PENDING: 'gray', PROCESSING: 'blue', COMPLETED: 'green', FAILED: 'red' } as const;

export default function PrivacyPage() {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const ws = useSWR<{ settings: { defaultRetentionDays?: number } }>(can('workspace.manage') ? wsPath('') : null);
  const requests = useSWR<{ data: DataRequest[] }>(can('workspace.manage') ? wsPath('/privacy/requests?limit=50') : null, {
    refreshInterval: (d) => (d?.data.some((r) => r.status === 'PENDING' || r.status === 'PROCESSING') ? 3000 : 0),
  });
  const [days, setDays] = useState('');
  const [savingDays, setSavingDays] = useState(false);
  const [type, setType] = useState<'EXPORT' | 'DELETE'>('EXPORT');
  const [by, setBy] = useState<'email' | 'participantId'>('email');
  const [subject, setSubject] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (ws.data) setDays(ws.data.settings?.defaultRetentionDays ? String(ws.data.settings.defaultRetentionDays) : '');
  }, [ws.data]);

  if (!can('workspace.manage')) return <Alert tone="warning">Only admins can manage privacy settings.</Alert>;

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Privacy & retention" description="Control how long session content is kept, and handle participants’ requests to export or delete their data." />
      <Card title="Retention">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setSavingDays(true);
            try {
              await api(wsPath(''), { method: 'PATCH', body: { settings: { defaultRetentionDays: Number(days) } } });
              toast.success('Retention updated');
              ws.mutate();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setSavingDays(false);
            }
          }}
        >
          <Field label="Default retention (days)" hint="1–3650. Applies to sessions without their own retention date.">
            {(id) => <Input id={id} type="number" min={1} max={3650} required className="w-40" value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
          <Button type="submit" loading={savingDays}>
            Save
          </Button>
        </form>
        <div className="mt-3 space-y-1 text-sm text-slate-600">
          <p>
            A daily job deletes recordings and uploads of sessions past their retention date and redacts transcript text and evidence quotes. Scores, extracted values
            and session metadata are kept for reporting. Scenario-level retention (recording settings) sets each session’s own retention date.
          </p>
          {!ws.data?.settings?.defaultRetentionDays && <p className="text-amber-700">No workspace default is set: only sessions with their own retention date are cleaned up.</p>}
        </div>
      </Card>

      <Card title="Participant data requests">
        <form
          className="grid gap-3 md:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setSubmitting(true);
            setFormError(null);
            try {
              await api(wsPath('/privacy/requests'), {
                method: 'POST',
                body: { type, ...(by === 'email' ? { email: subject.trim() } : { participantId: subject.trim() }), ...(type === 'DELETE' ? { confirm: confirmText.trim() } : {}) },
              });
              toast.success(type === 'EXPORT' ? 'Export started' : 'Deletion started');
              setSubject('');
              setConfirmText('');
              requests.mutate();
            } catch (err) {
              setFormError(errorMessage(err));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Field label="Request">
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="EXPORT">Export data (JSON)</option>
                <option value="DELETE">Delete data</option>
              </Select>
            )}
          </Field>
          <Field label="Find participant by">
            {(id) => (
              <Select id={id} value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
                <option value="email">Email</option>
                <option value="participantId">Participant id</option>
              </Select>
            )}
          </Field>
          <Field label={by === 'email' ? 'Email' : 'Participant id'} className="md:col-span-2">
            {(id) => <Input id={id} required type={by === 'email' ? 'email' : 'text'} value={subject} onChange={(e) => setSubject(e.target.value)} />}
          </Field>
          {type === 'DELETE' && (
            <div className="md:col-span-4">
              <Alert tone="warning" title="Permanent deletion">
                Deletes all sessions (transcripts, recordings, scores, extracted data), coach memory, course enrollments and personal details of this participant in
                this workspace. Usage records are kept without personal data. This cannot be undone.
              </Alert>
              <Field label={`Type the ${by === 'email' ? 'email' : 'participant id'} again to confirm`} className="mt-2 max-w-md">
                {(id) => <Input id={id} required value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />}
              </Field>
            </div>
          )}
          <div className="md:col-span-4">
            {formError && <Alert tone="error">{formError}</Alert>}
            <Button type="submit" variant={type === 'DELETE' ? 'danger' : 'primary'} className="mt-2" loading={submitting}>
              {type === 'EXPORT' ? 'Start export' : 'Delete participant data'}
            </Button>
          </div>
        </form>
      </Card>

      {requests.error ? (
        <ErrorState error={requests.error} retry={() => requests.mutate()} />
      ) : !requests.data ? (
        <Loading />
      ) : !requests.data.data.length ? (
        <EmptyState title="No data requests yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Requested</Th>
              <Th>Type</Th>
              <Th>Subject</Th>
              <Th>Status</Th>
              <Th>Result</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {requests.data.data.map((r) => (
              <tr key={r.id}>
                <Td>{formatDate(r.createdAt)}</Td>
                <Td>{r.type.toLowerCase()}</Td>
                <Td>{r.subjectEmail ?? r.participantId}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</Badge>
                  {r.error && <span className="ml-2 text-xs text-red-700">{r.error}</span>}
                </Td>
                <Td className="whitespace-normal text-xs text-slate-600">
                  {Object.entries(r.summary ?? {})
                    .filter(([k]) => k !== 'bytes')
                    .map(([k, v]) => `${v} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
                    .join(', ')}
                </Td>
                <Td className="text-right">
                  {r.type === 'EXPORT' && r.status === 'COMPLETED' && r.hasResult && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        try {
                          const d = await api<{ url: string }>(wsPath(`/privacy/requests/${r.id}/download`), { method: 'POST' });
                          window.location.href = d.url;
                        } catch (e) {
                          toast.error(errorMessage(e));
                        }
                      }}
                    >
                      Download
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="text-xs text-slate-500">Exports are kept for 7 days, then deleted automatically. Download links expire after 15 minutes.</p>
    </div>
  );
}
