'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { API_KEY_SCOPES, type ApiKeyScope } from '@cf/shared';
import { Alert, Badge, Button, Card, Checkbox, ConfirmButton, CopyButton, EmptyState, ErrorState, Field, Input, Loading, Modal, Table, Td, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: { id: string; email: string | null; name: string | null } | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked' | 'expired';
  createdAt: string;
}

const SCOPE_HELP: Record<ApiKeyScope, string> = {
  'scenarios:read': 'List scenarios, versions and configs',
  'scenarios:write': 'Create scenarios, edit drafts, publish',
  'sessions:read': 'List sessions, read state and transcripts',
  'sessions:write': 'Create sessions for participants, cancel',
  'analysis:read': 'Evaluations, extracted variables, reports',
  'analytics:read': 'Analytics summary',
  'courses:read': 'List courses and items',
  'courses:write': 'Enroll participants in courses',
  'org:read': 'Organization and members',
  'org:write': 'Invite members',
  'tokens:write': 'Mint / revoke embed and participant tokens',
  'usage:read': 'Usage totals and ledger',
  'webhooks:write': 'Manage webhook endpoints',
};

const statusTone = { active: 'green', revoked: 'gray', expired: 'yellow' } as const;

export function ApiKeysSection() {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<{ data: ApiKeyRow[] }>(wsPath('/api-keys?limit=100'));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['scenarios:read', 'sessions:read', 'analysis:read']);
  const [expires, setExpires] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  const reset = () => {
    setName('');
    setScopes(['scenarios:read', 'sessions:read', 'analysis:read']);
    setExpires('');
    setFormError(null);
  };

  const create = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const r = await api<ApiKeyRow & { secret: string }>(wsPath('/api-keys'), {
        method: 'POST',
        body: { name, scopes, ...(expires ? { expiresAt: new Date(`${expires}T23:59:59`).toISOString() } : {}) },
      });
      setOpen(false);
      setCreated({ name: r.name, secret: r.secret });
      reset();
      await mutate();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="API keys"
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          Create API key
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Keys authenticate the REST API (<code className="rounded bg-slate-100 px-1">Authorization: Bearer cf_live_…</code>) and act as a workspace admin limited to their scopes.
      </p>
      {created && (
        <div className="mb-4">
          <Alert tone="success" title={`Key "${created.name}" created — copy it now, it will not be shown again`}>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-900" data-testid="api-key-secret">
                {created.secret}
              </code>
              <CopyButton value={created.secret} />
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
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
        <EmptyState title="No API keys yet" description="Create a key to call the REST API from your systems." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Key</Th>
              <Th>Scopes</Th>
              <Th>Created by</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((k) => (
              <tr key={k.id}>
                <Td className="font-medium">{k.name}</Td>
                <Td>
                  <code className="font-mono text-xs">{k.prefix}…</code>
                </Td>
                <Td className="whitespace-normal">
                  <div className="flex max-w-xs flex-wrap gap-1">
                    {k.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                </Td>
                <Td>{k.createdBy?.name ?? k.createdBy?.email ?? '—'}</Td>
                <Td>{formatDate(k.lastUsedAt)}</Td>
                <Td>{k.expiresAt ? formatDate(k.expiresAt) : 'Never'}</Td>
                <Td>
                  <Badge tone={statusTone[k.status]}>{k.status}</Badge>
                </Td>
                <Td>
                  {k.status === 'active' && (
                    <ConfirmButton
                      size="sm"
                      variant="danger"
                      confirmText={`Revoke "${k.name}"? Integrations using it stop working immediately.`}
                      onConfirm={async () => {
                        try {
                          await api(wsPath(`/api-keys/${k.id}/revoke`), { method: 'POST' });
                          toast.success('Key revoked');
                          await mutate();
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

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title="Create API key"
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={saving} disabled={!name.trim() || !scopes.length}>
              Create key
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && <Alert tone="error">{formError}</Alert>}
          <Field label="Name" required hint="Where the key is used, e.g. “CRM sync (production)”.">
            {(id) => <Input id={id} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Scopes</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {API_KEY_SCOPES.map((s) => (
                <Checkbox
                  key={s}
                  label={<code className="text-xs">{s}</code>}
                  description={SCOPE_HELP[s]}
                  checked={scopes.includes(s)}
                  onChange={(v) => setScopes((prev) => (v ? [...prev, s] : prev.filter((x) => x !== s)))}
                />
              ))}
            </div>
          </fieldset>
          <Field label="Expires on (optional)" hint="Leave empty for a key that does not expire. Revoke it any time.">
            {(id) => <Input id={id} type="date" value={expires} min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
