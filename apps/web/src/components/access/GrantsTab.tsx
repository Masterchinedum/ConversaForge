'use client';
import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Alert, Badge, Button, Card, Checkbox, ConfirmButton, EmptyState, ErrorState, Field, Input, Loading, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { fromLocalInput, STATUS_TONE, type GrantDto } from './types';

const PERMISSION_LABEL = { RUN: 'Can run', VIEW_RESULTS: 'Can view results', EDIT: 'Can edit (includes run & results)' } as const;

export function GrantsTab({ scenarioId }: { scenarioId: string }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const path = wsPath(`/scenarios/${scenarioId}/grants`);
  const { data, error, mutate } = useSWR<{ data: GrantDto[] }>(path);
  const { mutate: mutateKey } = useSWRConfig();
  // Also refresh the access summary (tab counters) on the page.
  const refresh = () => {
    void mutate();
    void mutateKey(wsPath(`/scenarios/${scenarioId}/access`));
  };
  const [type, setType] = useState<'EMAIL' | 'USER' | 'WORKSPACE'>('EMAIL');
  const [who, setWho] = useState('');
  const [permission, setPermission] = useState<'RUN' | 'VIEW_RESULTS' | 'EDIT'>('RUN');
  const [expiresAt, setExpiresAt] = useState('');
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api(path, {
        method: 'POST',
        body: {
          granteeType: type,
          ...(type === 'WORKSPACE' ? { workspace: who.trim() } : { email: who.trim() }),
          permission,
          expiresAt: fromLocalInput(expiresAt),
          notify,
        },
      });
      setWho('');
      setExpiresAt('');
      toast.success('Access granted');
      refresh();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Share with a person or workspace">
        <form className="grid gap-3 md:grid-cols-5" onSubmit={create}>
          <Field label="Share with">
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="EMAIL">Email address</option>
                <option value="USER">Existing user</option>
                <option value="WORKSPACE">Another workspace</option>
              </Select>
            )}
          </Field>
          <Field label={type === 'WORKSPACE' ? 'Workspace id or slug' : 'Email'} className="md:col-span-2">
            {(id) => <Input id={id} required type={type === 'WORKSPACE' ? 'text' : 'email'} value={who} onChange={(e) => setWho(e.target.value)} />}
          </Field>
          <Field label="Permission">
            {(id) => (
              <Select id={id} value={permission} onChange={(e) => setPermission(e.target.value as typeof permission)}>
                {Object.entries(PERMISSION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Expires (optional)">
            {(id) => <Input id={id} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-5">
            {type !== 'WORKSPACE' ? <Checkbox label="Email them a notification" checked={notify} onChange={setNotify} /> : <span />}
            <Button type="submit" loading={saving} disabled={!who.trim()}>
              Grant access
            </Button>
          </div>
          {formError && (
            <div className="md:col-span-5">
              <Alert tone="error">{formError}</Alert>
            </div>
          )}
        </form>
        <p className="mt-3 text-xs text-slate-500">
          Grantees find shared scenarios under <em>Account → Shared with me</em>. Email grants apply once they sign in with that address. Access is checked every time they start a session.
        </p>
      </Card>
      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading />
      ) : !data.data.length ? (
        <EmptyState title="Not shared with anyone yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Grantee</Th>
              <Th>Permission</Th>
              <Th>Status</Th>
              <Th>Expires</Th>
              <Th>Granted</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((g) => (
              <tr key={g.id} className={g.status !== 'active' ? 'opacity-60' : undefined}>
                <Td>
                  <span className="text-xs text-slate-500">{g.granteeType.toLowerCase()} · </span>
                  {g.granteeLabel}
                </Td>
                <Td>{PERMISSION_LABEL[g.permission]}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[g.status]}>{g.status}</Badge>
                </Td>
                <Td>{g.expiresAt ? formatDate(g.expiresAt) : 'Never'}</Td>
                <Td>{formatDate(g.createdAt)}</Td>
                <Td className="text-right">
                  {g.status !== 'revoked' && (
                    <ConfirmButton
                      variant="ghost"
                      size="sm"
                      className="text-red-700"
                      confirmText="Revoke this access?"
                      onConfirm={async () => {
                        try {
                          await api(`${path}/${g.id}`, { method: 'DELETE' });
                          refresh();
                        } catch (e) {
                          toast.error(errorMessage(e));
                        }
                      }}
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
