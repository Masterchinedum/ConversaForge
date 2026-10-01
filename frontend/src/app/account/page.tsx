'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
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
  Table,
  Td,
  Th,
  useToast,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDuration, formatScore } from '@/lib/format';
import { storeSessionToken } from '@/lib/live/token';
import { useMe } from '@/lib/workspace';

interface LoginSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}
interface SharedItem {
  scenario: { id: string; name: string; description?: string; durationMinutes?: number; personaName?: string };
  workspace: { id: string; name: string };
  permissions: string[];
  canRun: boolean;
  canViewResults: boolean;
  runnable: boolean;
  expiresAt: string | null;
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export default function AccountPage() {
  const router = useRouter();
  const toast = useToast();
  const { data: me, error: meError, mutate: mutateMe } = useMe();
  const sessions = useSWR<{ data: LoginSession[] }>(me ? '/auth/sessions' : null);
  const shared = useSWR<{ data: SharedItem[] }>(me ? '/me/shared-scenarios' : null);
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const [results, setResults] = useState<SharedItem | null>(null);

  useEffect(() => {
    if (meError) router.replace('/login?next=/account');
  }, [meError, router]);
  useEffect(() => {
    if (me) setName(me.user.name ?? '');
  }, [me]);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#shared') document.getElementById('shared')?.scrollIntoView();
  }, [shared.data]);

  if (!me) return <Loading />;

  const runShared = async (item: SharedItem) => {
    try {
      const r = await api<{ sessionId: string; sessionToken: string }>(`/shared/scenarios/${item.scenario.id}/sessions`, { method: 'POST', body: {} });
      storeSessionToken(r.sessionId, r.sessionToken);
      router.push(`/live/${r.sessionId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      shared.mutate();
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader title="Account" description={me.user.email} back={{ href: '/app', label: 'Back to workspace' }} />
      <div className="space-y-6">
        <Card title="Profile">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setSavingName(true);
              try {
                await api('/auth/me', { method: 'PATCH', body: { name: name.trim() } });
                await mutateMe();
                toast.success('Profile updated');
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setSavingName(false);
              }
            }}
          >
            <Field label="Display name" className="min-w-[240px] flex-1">
              {(id) => <Input id={id} value={name} maxLength={100} required onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Button type="submit" loading={savingName} disabled={!name.trim() || name.trim() === (me.user.name ?? '')}>
              Save
            </Button>
          </form>
        </Card>

        <Card title="Change password">
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setPwError(null);
              if (pw.next !== pw.confirm) return setPwError('The new passwords do not match');
              if (pw.next.length < 10) return setPwError('Use at least 10 characters');
              setSavingPw(true);
              try {
                await api('/auth/change-password', { method: 'POST', body: { currentPassword: pw.current, newPassword: pw.next } });
                setPw({ current: '', next: '', confirm: '' });
                toast.success('Password changed. Other devices were signed out.');
                sessions.mutate();
              } catch (err) {
                setPwError(errorMessage(err));
              } finally {
                setSavingPw(false);
              }
            }}
          >
            <Field label="Current password">
              {(id) => <Input id={id} type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}
            </Field>
            <Field label="New password" hint="At least 10 characters">
              {(id) => <Input id={id} type="password" autoComplete="new-password" required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />}
            </Field>
            <Field label="Confirm new password">
              {(id) => <Input id={id} type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />}
            </Field>
            <div className="sm:col-span-3">
              {pwError && <Alert tone="error">{pwError}</Alert>}
              <Button type="submit" className="mt-2" loading={savingPw}>
                Change password
              </Button>
            </div>
          </form>
        </Card>

        <Card
          title="Signed-in devices"
          actions={
            (sessions.data?.data.length ?? 0) > 1 && (
              <ConfirmButton
                variant="secondary"
                size="sm"
                confirmText="Sign out of all other devices?"
                onConfirm={async () => {
                  const r = await api<{ revoked: number }>('/auth/sessions', { method: 'DELETE' });
                  toast.success(`Signed out ${r.revoked} other session(s)`);
                  sessions.mutate();
                }}
              >
                Sign out other devices
              </ConfirmButton>
            )
          }
        >
          {sessions.error ? (
            <ErrorState error={sessions.error} retry={() => sessions.mutate()} />
          ) : !sessions.data ? (
            <Loading />
          ) : (
            <ul className="divide-y divide-slate-100">
              {sessions.data.data.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <p className="font-medium text-slate-800">
                      {describeAgent(s.userAgent)} {s.current && <Badge tone="green">This device</Badge>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {s.ip ?? 'unknown IP'} · signed in {formatDate(s.createdAt)} · last active {formatDate(s.lastUsedAt)}
                    </p>
                  </div>
                  {!s.current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                        sessions.mutate();
                      }}
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Workspaces">
          <ul className="divide-y divide-slate-100">
            {me.workspaces.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <Link href={`/w/${w.id}`} className="font-medium text-brand-700 hover:underline">
                    {w.name}
                  </Link>
                  <span className="ml-2 text-xs text-slate-500">
                    {w.kind === 'PERSONAL' ? 'Personal' : 'Organization'} · {w.role.toLowerCase()}
                  </span>
                </div>
                {w.kind === 'ORGANIZATION' && (
                  <ConfirmButton
                    variant="ghost"
                    size="sm"
                    confirmText={`Leave ${w.name}? You will lose access to its scenarios and results.`}
                    onConfirm={async () => {
                      try {
                        await api(`/workspaces/${w.id}/leave`, { method: 'POST' });
                        toast.success(`You left ${w.name}`);
                        try {
                          if (localStorage.getItem('cf:lastWorkspace') === w.id) localStorage.removeItem('cf:lastWorkspace');
                        } catch {
                          /* ignore */
                        }
                        mutateMe();
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  >
                    Leave
                  </ConfirmButton>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <div id="shared">
          <Card title="Shared with me">
            {shared.error ? (
              <ErrorState error={shared.error} retry={() => shared.mutate()} />
            ) : !shared.data ? (
              <Loading />
            ) : !shared.data.data.length ? (
              <EmptyState title="Nothing shared with you yet" description="When someone shares a scenario with your email, it appears here." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {shared.data.data.map((item) => (
                  <li key={item.scenario.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{item.scenario.name}</p>
                      <p className="text-xs text-slate-500">
                        from {item.workspace.name} · {item.permissions.map((p) => p.toLowerCase().replace('_', ' ')).join(', ')}
                        {item.expiresAt && ` · until ${formatDate(item.expiresAt)}`}
                      </p>
                      {item.scenario.description && <p className="mt-1 line-clamp-2 text-sm text-slate-600">{item.scenario.description}</p>}
                      {!item.runnable && <p className="mt-1 text-xs text-amber-700">Not currently available (unpublished or archived).</p>}
                    </div>
                    <div className="flex gap-2">
                      {item.canViewResults && (
                        <Button variant="secondary" size="sm" onClick={() => setResults(item)}>
                          View results
                        </Button>
                      )}
                      {item.canRun && (
                        <Button size="sm" onClick={() => runShared(item)}>
                          Start
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <SharedResultsModal item={results} onClose={() => setResults(null)} />
    </main>
  );
}

function SharedResultsModal({ item, onClose }: { item: SharedItem | null; onClose: () => void }) {
  const { data, error } = useSWR<{ data: any[] }>(item ? `/shared/scenarios/${item.scenario.id}/sessions?limit=100` : null);
  return (
    <Modal open={!!item} onClose={onClose} title={item ? `Results — ${item.scenario.name}` : 'Results'} wide>
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <Loading />
      ) : !data.data.length ? (
        <EmptyState title="No sessions yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Participant</Th>
              <Th>Date</Th>
              <Th>Duration</Th>
              <Th>Status</Th>
              <Th>Score</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((s) => (
              <tr key={s.id}>
                <Td>{s.participantName}</Td>
                <Td>{formatDate(s.createdAt)}</Td>
                <Td>{formatDuration(s.durationMs)}</Td>
                <Td>{s.state.toLowerCase()}</Td>
                <Td>
                  {formatScore(s.overallScore)} {s.simulated && <Badge tone="yellow">simulated</Badge>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Modal>
  );
}
