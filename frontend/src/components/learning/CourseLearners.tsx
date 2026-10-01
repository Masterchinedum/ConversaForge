'use client';
/** Course editor → Learners tab: assign members/teams/emails, per-learner progress, attempt history. */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { ProgressBar } from '@/components/analytics/charts';
import { Alert, Badge, Button, Checkbox, ConfirmButton, EmptyState, ErrorState, Field, Input, Loading, Modal, Table, Td, Textarea, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { ruleLabel, type CompletionRule, type ItemStatus, type Progress } from '@/lib/learning';
import { useWorkspace } from '@/lib/workspace';

interface EnrollmentRow {
  id: string;
  status: 'ACTIVE' | 'COMPLETED' | 'DROPPED';
  generation: number;
  assigned: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastActivityAt: string | null;
  learner: { participantId: string; userId: string | null; name: string | null; email: string | null; hasAccount: boolean };
  progress: Progress;
}
interface EnrollmentDetail {
  enrollment: { id: string; status: string; generation: number };
  learner: { name: string | null; email: string | null } | null;
  progress: Progress;
  items: Array<{ id: string; title: string; kind: string; required: boolean; completionRule: CompletionRule; status: ItemStatus; locked: boolean }>;
  attempts: Array<{ id: string; courseItemId: string; generation: number; current: boolean; status: string; reason: string | null; sessionId: string | null; score: number | null; startedAt: string; completedAt: string | null }>;
}
interface Assignees {
  members: Array<{ userId: string; name: string | null; email: string; role: string }>;
  teams: Array<{ id: string; name: string; memberCount: number }>;
}

export function CourseLearners({ coursePath, published, shareUrl }: { coursePath: string; published: boolean; shareUrl: string | null }) {
  const { wsPath, can, href } = useWorkspace();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<{ data: EnrollmentRow[] }>(`${coursePath}/enrollments`);
  const [assignOpen, setAssignOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">Progress counts only each learner's current attempt; new enrollments start at 0%.</p>
        {can('courses.assign') && <Button onClick={() => setAssignOpen(true)}>Assign learners</Button>}
      </div>
      {!published && <Alert tone="info">This course is a draft: assigned learners will see it once it is published.</Alert>}
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data?.data.length ? (
        <EmptyState title="No learners yet" description="Assign members, teams or email addresses, or share the course link." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Learner</Th>
              <Th>Status</Th>
              <Th className="w-48">Progress</Th>
              <Th>Last activity</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-normal">
                  <span className="font-medium text-slate-900">{e.learner.name ?? e.learner.email ?? 'Anonymous'}</span>
                  {e.learner.name && e.learner.email && <span className="block text-xs text-slate-500">{e.learner.email}</span>}
                  {!e.learner.hasAccount && <Badge className="ml-1">invited — no account yet</Badge>}
                </Td>
                <Td>
                  <Badge tone={e.status === 'COMPLETED' ? 'green' : 'blue'}>{e.status.toLowerCase()}</Badge>
                  {e.generation > 1 && <span className="ml-1 text-xs text-slate-500">attempt #{e.generation}</span>}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <ProgressBar percent={e.progress.percent} className="w-28" label={`${e.learner.name ?? 'Learner'} progress`} />
                    <span className="text-xs tabular-nums text-slate-700">{e.progress.percent}%</span>
                  </div>
                </Td>
                <Td className="text-xs">{formatDate(e.lastActivityAt)}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setDetailId(e.id)}>
                      Details
                    </Button>
                    {can('courses.assign') && (
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        confirmText="Remove this learner from the course? Their history is kept."
                        onConfirm={async () => {
                          try {
                            await api(`${coursePath}/enrollments/${e.id}`, { method: 'DELETE' });
                            await mutate();
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        Remove
                      </ConfirmButton>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <AssignModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        coursePath={coursePath}
        assigneesPath={wsPath('/courses/options/assignees')}
        shareUrl={shareUrl}
        onDone={() => mutate()}
      />
      <DetailModal
        enrollmentPath={detailId ? `${coursePath}/enrollments/${detailId}` : null}
        onClose={() => setDetailId(null)}
        sessionHref={(id) => href(`/sessions/${id}`)}
        onChanged={() => mutate()}
      />
    </div>
  );
}

function AssignModal({
  open,
  onClose,
  coursePath,
  assigneesPath,
  shareUrl,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  coursePath: string;
  assigneesPath: string;
  shareUrl: string | null;
  onDone: () => void;
}) {
  const toast = useToast();
  const { data } = useSWR<Assignees>(open ? assigneesPath : null);
  const [users, setUsers] = useState<Set<string>>(new Set());
  const [teams, setTeams] = useState<Set<string>>(new Set());
  const [emails, setEmails] = useState('');
  const [filter, setFilter] = useState('');
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const emailList = useMemo(
    () =>
      emails
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean),
    [emails],
  );
  const badEmails = emailList.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
    fn(n);
  };
  const members = (data?.members ?? []).filter((m) => !filter || `${m.name ?? ''} ${m.email}`.toLowerCase().includes(filter.toLowerCase()));

  const submit = async () => {
    setSaving(true);
    try {
      const r = await api<{ created: number; reactivated: number; already: number; invalid: Array<{ value: string; reason: string }> }>(`${coursePath}/enrollments`, {
        method: 'POST',
        body: { userIds: [...users], teamIds: [...teams], emails: emailList, notify },
      });
      toast.success(`Assigned: ${r.created} new, ${r.reactivated} re-enrolled, ${r.already} already enrolled${r.invalid.length ? `, ${r.invalid.length} skipped` : ''}`);
      setUsers(new Set());
      setTeams(new Set());
      setEmails('');
      onDone();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Assign learners"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={badEmails.length > 0 || users.size + teams.size + emailList.length === 0}>
            Assign
          </Button>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-medium text-slate-700">Members</h3>
          <Input placeholder="Filter…" aria-label="Filter members" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {!data ? (
              <Loading />
            ) : (
              members.map((m) => (
                <Checkbox
                  key={m.userId}
                  label={
                    <span>
                      {m.name ?? m.email} <span className="text-xs text-slate-500">{m.name ? m.email : ''}</span>
                    </span>
                  }
                  checked={users.has(m.userId)}
                  onChange={() => toggle(users, m.userId, setUsers)}
                />
              ))
            )}
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-sm font-medium text-slate-700">Teams</h3>
            {data?.teams.length ? (
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {data.teams.map((t) => (
                  <Checkbox key={t.id} label={`${t.name} (${t.memberCount})`} checked={teams.has(t.id)} onChange={() => toggle(teams, t.id, setTeams)} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">No teams in this workspace.</p>
            )}
          </div>
          <Field
            label="Email addresses"
            hint={shareUrl ? 'People without an account enroll through the course link after signing up with this email.' : 'Tip: create a course link (Sharing tab) so people without an account can join after signing up.'}
            error={badEmails.length ? `Invalid: ${badEmails.join(', ')}` : undefined}
          >
            {(id) => <Textarea id={id} rows={3} placeholder="one@example.com, two@example.com" value={emails} onChange={(e) => setEmails(e.target.value)} />}
          </Field>
          <Checkbox label="Email a notification (published courses only)" checked={notify} onChange={setNotify} />
        </div>
      </div>
    </Modal>
  );
}

function DetailModal({
  enrollmentPath,
  onClose,
  sessionHref,
  onChanged,
}: {
  enrollmentPath: string | null;
  onClose: () => void;
  sessionHref: (id: string) => string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { can } = useWorkspace();
  const { data, mutate } = useSWR<EnrollmentDetail>(enrollmentPath);
  const [showHistory, setShowHistory] = useState(false);
  return (
    <Modal open={!!enrollmentPath} onClose={onClose} wide title={data ? `${data.learner?.name ?? data.learner?.email ?? 'Learner'} — ${data.progress.percent}%` : 'Learner'}>
      {!data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>Rule</Th>
                <Th>Status</Th>
                <Th>Latest attempt</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((i) => {
                const last = data.attempts.find((a) => a.courseItemId === i.id && a.current);
                return (
                  <tr key={i.id}>
                    <Td className="whitespace-normal">
                      {i.title}
                      {!i.required && <span className="text-xs text-slate-500"> (optional)</span>}
                    </Td>
                    <Td className="text-xs">{ruleLabel(i.completionRule)}</Td>
                    <Td>
                      <Badge tone={i.status === 'COMPLETED' ? 'green' : i.status === 'FAILED' ? 'red' : i.status === 'IN_PROGRESS' ? 'blue' : 'gray'}>{i.status.replace('_', ' ').toLowerCase()}</Badge>
                    </Td>
                    <Td className="whitespace-normal text-xs">
                      {last ? (
                        <>
                          {formatDate(last.startedAt)}
                          {last.score != null && ` · score ${Math.round(last.score)}`}
                          {last.reason && <span className="block text-amber-700">{last.reason}</span>}
                          {last.sessionId && (
                            <Link href={sessionHref(last.sessionId)} className="block text-brand-700 hover:underline">
                              Open session
                            </Link>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="text-right">
                      {i.completionRule.type === 'manual' && i.status !== 'COMPLETED' && can('sessions.review') && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await api(`${enrollmentPath}/items/${i.id}/complete`, { method: 'POST' });
                              await mutate();
                              onChanged();
                            } catch (e) {
                              toast.error(errorMessage(e));
                            }
                          }}
                        >
                          Mark complete
                        </Button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {data.attempts.some((a) => !a.current) && (
            <div>
              <Button variant="link" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? 'Hide' : 'Show'} earlier attempts (before “start over”)
              </Button>
              {showHistory && (
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {data.attempts
                    .filter((a) => !a.current)
                    .map((a) => (
                      <li key={a.id}>
                        Attempt #{a.generation} · {data.items.find((i) => i.id === a.courseItemId)?.title ?? 'removed item'} · {a.status.toLowerCase()} · {formatDate(a.startedAt)}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
