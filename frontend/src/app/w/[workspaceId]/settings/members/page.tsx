'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { ROLES, type Role } from '@cf/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Table,
  Tabs,
  Td,
  Th,
  useToast,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDay } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

interface Member {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
}
interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  invitedBy: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}
interface Team {
  id: string;
  name: string;
  memberCount: number;
}

const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Full control, including billing, quotas and ownership',
  ADMIN: 'Members, access, usage, settings',
  CREATOR: 'Build and share scenarios, courses, knowledge',
  REVIEWER: 'Review sessions, reports and analytics',
  MEMBER: 'Take assigned scenarios and courses',
};

type Tab = 'members' | 'invitations' | 'teams';

export default function MembersPage() {
  const { can, workspace } = useWorkspace();
  const [tab, setTab] = useState<Tab>('members');
  if (!can('sessions.review')) return <Alert tone="warning">You don’t have access to the member list.</Alert>;
  return (
    <div>
      <PageHeader title="Members & teams" description="Invite people, set their roles, and group participants into teams." />
      {workspace.kind === 'PERSONAL' && (
        <div className="mb-4">
          <Alert tone="info">This is a personal workspace. Create an organization (workspace menu → New organization) to invite others.</Alert>
        </div>
      )}
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'members', label: 'Members' },
          ...(can('members.manage') ? [{ id: 'invitations' as Tab, label: 'Invitations' }] : []),
          { id: 'teams', label: 'Teams' },
        ]}
      />
      {tab === 'members' && <MembersTab />}
      {tab === 'invitations' && <InvitationsTab />}
      {tab === 'teams' && <TeamsTab />}
    </div>
  );
}

function MembersTab() {
  const { wsPath, can, role: myRole, me } = useWorkspace();
  const toast = useToast();
  const { data, error, mutate } = useSWR<{ data: Member[] }>(wsPath('/members'));
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;
  const owners = data.data.filter((m) => m.role === 'OWNER').length;
  const manage = can('members.manage');

  const editable = (m: Member) => manage && (myRole === 'OWNER' || m.role !== 'OWNER') && !(m.role === 'OWNER' && owners <= 1);

  return (
    <Table>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Email</Th>
          <Th>Role</Th>
          <Th>Joined</Th>
          <Th />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {data.data.map((m) => (
          <tr key={m.id}>
            <Td>
              {m.name ?? '—'} {m.userId === me.user.id && <Badge tone="blue">you</Badge>}
            </Td>
            <Td>{m.email}</Td>
            <Td>
              {editable(m) ? (
                <Select
                  aria-label={`Role for ${m.email}`}
                  value={m.role}
                  className="w-36 py-1"
                  onChange={async (e) => {
                    const role = e.target.value as Role;
                    if (m.userId === me.user.id && !confirm('Change your own role? You may lose access to this page.')) return;
                    try {
                      await api(wsPath(`/members/${m.id}`), { method: 'PATCH', body: { role } });
                      toast.success('Role updated');
                      mutate();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  {ROLES.filter((r) => myRole === 'OWNER' || r !== 'OWNER').map((r) => (
                    <option key={r} value={r} title={ROLE_HELP[r]}>
                      {r.toLowerCase()}
                    </option>
                  ))}
                </Select>
              ) : (
                <span title={m.role === 'OWNER' && owners <= 1 ? 'The last owner cannot be changed' : ROLE_HELP[m.role]}>
                  <Badge tone={m.role === 'OWNER' ? 'purple' : m.role === 'ADMIN' ? 'blue' : 'gray'}>{m.role.toLowerCase()}</Badge>
                </span>
              )}
            </Td>
            <Td>{formatDay(m.createdAt)}</Td>
            <Td className="text-right">
              {editable(m) && m.userId !== me.user.id && (
                <ConfirmButton
                  variant="ghost"
                  size="sm"
                  className="text-red-700"
                  confirmText={`Remove ${m.email} from this workspace?`}
                  onConfirm={async () => {
                    try {
                      await api(wsPath(`/members/${m.id}`), { method: 'DELETE' });
                      toast.success('Member removed');
                      mutate();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  Remove
                </ConfirmButton>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function InvitationsTab() {
  const { wsPath, role: myRole, workspace } = useWorkspace();
  const toast = useToast();
  const { data, error, mutate } = useSWR<{ data: Invitation[] }>(wsPath('/invitations'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('MEMBER');
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (workspace.kind === 'PERSONAL') return <EmptyState title="Personal workspaces can’t invite members" />;
  return (
    <div className="space-y-4">
      <Card title="Invite someone">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setSending(true);
            setFormError(null);
            try {
              const r = await api<{ emailDelivered: boolean }>(wsPath('/invitations'), { method: 'POST', body: { email: email.trim(), role } });
              toast.success(r.emailDelivered ? 'Invitation sent' : 'Invitation created (email not configured — see the API log for the link)');
              setEmail('');
              mutate();
            } catch (err) {
              setFormError(errorMessage(err));
            } finally {
              setSending(false);
            }
          }}
        >
          <Field label="Email" className="min-w-[240px] flex-1">
            {(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Role">
            {(id) => (
              <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.filter((r) => myRole === 'OWNER' || r !== 'OWNER').map((r) => (
                  <option key={r} value={r}>
                    {r.toLowerCase()} — {ROLE_HELP[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" loading={sending}>
            Send invitation
          </Button>
        </form>
        {formError && (
          <div className="mt-3">
            <Alert tone="error">{formError}</Alert>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">Invitations expire after 7 days and can only be accepted by an account with the invited email.</p>
      </Card>
      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading />
      ) : !data.data.length ? (
        <EmptyState title="No pending invitations" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Invited</Th>
              <Th>Expires</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((i) => (
              <tr key={i.id}>
                <Td>{i.email}</Td>
                <Td>{i.role.toLowerCase()}</Td>
                <Td>
                  <Badge tone={i.status === 'pending' ? 'green' : 'gray'}>{i.status}</Badge>
                </Td>
                <Td>
                  {formatDay(i.createdAt)}
                  {i.invitedBy && <span className="text-xs text-slate-500"> by {i.invitedBy}</span>}
                </Td>
                <Td>{formatDate(i.expiresAt)}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          await api(wsPath(`/invitations/${i.id}/resend`), { method: 'POST' });
                          toast.success('Invitation re-sent with a new link');
                          mutate();
                        } catch (err) {
                          toast.error(errorMessage(err));
                        }
                      }}
                    >
                      Resend
                    </Button>
                    <ConfirmButton
                      variant="ghost"
                      size="sm"
                      className="text-red-700"
                      confirmText="Revoke this invitation?"
                      onConfirm={async () => {
                        try {
                          await api(wsPath(`/invitations/${i.id}`), { method: 'DELETE' });
                          mutate();
                        } catch (err) {
                          toast.error(errorMessage(err));
                        }
                      }}
                    >
                      Revoke
                    </ConfirmButton>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function TeamsTab() {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const { data, error, mutate } = useSWR<{ data: Team[] }>(wsPath('/teams'));
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-4">
      {can('members.manage') && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(wsPath('/teams'), { method: 'POST', body: { name: name.trim() } });
              setName('');
              mutate();
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <Field label="New team name">{(id) => <Input id={id} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Button type="submit">Create team</Button>
        </form>
      )}
      {!data.data.length ? (
        <EmptyState title="No teams yet" description="Teams group participants (members or external learners) for assignments and analytics." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Team</Th>
              <Th>Members</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((t) => (
              <tr key={t.id}>
                <Td>{t.name}</Td>
                <Td>{t.memberCount}</Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(t.id)}>
                    Open
                  </Button>
                  {can('members.manage') && (
                    <ConfirmButton
                      variant="ghost"
                      size="sm"
                      className="text-red-700"
                      confirmText={`Delete team ${t.name}? Participants are not deleted.`}
                      onConfirm={async () => {
                        await api(wsPath(`/teams/${t.id}`), { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                        mutate();
                      }}
                    >
                      Delete
                    </ConfirmButton>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {open && <TeamModal teamId={open} onClose={() => (setOpen(null), mutate())} />}
    </div>
  );
}

function TeamModal({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const { data, mutate } = useSWR<{ id: string; name: string; members: Array<{ id: string; participantId: string; name: string | null; email: string | null; userId: string | null }> }>(
    wsPath(`/teams/${teamId}`),
  );
  const [q, setQ] = useState('');
  const candidates = useSWR<{ members: Array<{ userId: string; email: string; name: string | null }>; participants: Array<{ id: string; name: string | null; email: string | null; externalId: string | null }> }>(
    can('members.manage') ? [wsPath('/teams/candidates'), { q }] : null,
  );
  const add = async (body: { userId?: string; participantId?: string }) => {
    try {
      await api(wsPath(`/teams/${teamId}/members`), { method: 'POST', body });
      mutate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const inTeam = new Set(data?.members.map((m) => m.userId ?? m.participantId));
  return (
    <Modal open onClose={onClose} title={data ? `Team: ${data.name}` : 'Team'} wide>
      {!data ? (
        <Loading />
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Members ({data.members.length})</h3>
            {!data.members.length ? (
              <p className="text-sm text-slate-500">No one yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {data.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between py-1.5">
                    <span>
                      {m.name ?? m.email ?? 'Anonymous'} <span className="text-xs text-slate-500">{m.email}</span>
                    </span>
                    {can('members.manage') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          await api(wsPath(`/teams/${teamId}/members/${m.participantId}`), { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                          mutate();
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {can('members.manage') && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Add people</h3>
              <Input placeholder="Search name or email" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
              <ul className="mt-2 max-h-72 divide-y divide-slate-100 overflow-y-auto text-sm">
                {candidates.data?.members
                  .filter((m) => !inTeam.has(m.userId))
                  .map((m) => (
                    <li key={m.userId} className="flex items-center justify-between py-1.5">
                      <span>
                        {m.name ?? m.email} <Badge>member</Badge>
                      </span>
                      <Button size="sm" variant="secondary" onClick={() => add({ userId: m.userId })}>
                        Add
                      </Button>
                    </li>
                  ))}
                {candidates.data?.participants
                  .filter((p) => !inTeam.has(p.id))
                  .map((p) => (
                    <li key={p.id} className="flex items-center justify-between py-1.5">
                      <span>
                        {p.name ?? p.email ?? p.externalId ?? p.id} <Badge tone="gray">participant</Badge>
                      </span>
                      <Button size="sm" variant="secondary" onClick={() => add({ participantId: p.id })}>
                        Add
                      </Button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
