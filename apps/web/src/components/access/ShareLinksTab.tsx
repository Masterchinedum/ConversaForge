'use client';
import { useState } from 'react';
import useSWR from 'swr';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmButton,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { fromLocalInput, IDENTITY_LABELS, STATUS_TONE, toLocalInput, type AccessSummary, type IdentityMode, type ShareLinkDto } from './types';

interface FormState {
  label: string;
  mode: 'MULTI_USE' | 'ONE_TIME';
  maxUses: string;
  expiresAt: string;
  passcode: string;
  removePasscode: boolean;
  perEmailAttemptLimit: string;
  identityMode: IdentityMode;
  allowedEmailDomains: string;
  prefilled: Record<string, string>;
  pinnedVersionId: string;
}

function initialForm(summary: AccessSummary, link?: ShareLinkDto): FormState {
  return {
    label: link?.label ?? '',
    mode: link?.mode ?? 'MULTI_USE',
    maxUses: link?.maxUses && link.mode !== 'ONE_TIME' ? String(link.maxUses) : '',
    expiresAt: toLocalInput(link?.expiresAt),
    passcode: '',
    removePasscode: false,
    perEmailAttemptLimit: link?.perEmailAttemptLimit ? String(link.perEmailAttemptLimit) : '',
    identityMode: link?.identityMode ?? summary.identityModeDefault,
    allowedEmailDomains: link?.allowedEmailDomains.join(', ') ?? '',
    prefilled: { ...(link?.prefilledVariables ?? {}) },
    pinnedVersionId: link?.pinnedVersionId ?? '',
  };
}

export function ShareLinksTab({ scenarioId, summary }: { scenarioId: string; summary: AccessSummary }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const path = wsPath(`/scenarios/${scenarioId}/links`);
  const { data, error, mutate } = useSWR<{ data: ShareLinkDto[] }>(path);
  const [editing, setEditing] = useState<ShareLinkDto | 'new' | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;
  const rows = data.data.filter((l) => showRevoked || l.status !== 'revoked');

  return (
    <div className="space-y-4">
      {!summary.runnable && <Alert tone="warning">Publish this scenario before creating share links.</Alert>}
      {!summary.channels.browser && <Alert tone="warning">The browser channel is disabled for this scenario, so share links will show “not available”.</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">Anyone with a link can start a session (subject to the rules you set). Links are unguessable and can be revoked any time.</p>
        <div className="flex items-center gap-3">
          <Checkbox label="Show revoked" checked={showRevoked} onChange={setShowRevoked} />
          <Button onClick={() => setEditing('new')} disabled={!summary.runnable}>
            New share link
          </Button>
        </div>
      </div>
      {!rows.length ? (
        <EmptyState title="No share links yet" description="Create a link to let people run this scenario without an account." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Link</Th>
              <Th>Status</Th>
              <Th>Uses</Th>
              <Th>Access rules</Th>
              <Th>Expires</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((l) => (
              <tr key={l.id} className={l.status === 'revoked' ? 'opacity-60' : undefined}>
                <Td className="max-w-[280px]">
                  <p className="font-medium text-slate-900">{l.label || 'Untitled link'}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="truncate text-xs text-slate-500" title={l.url}>
                      {l.url}
                    </code>
                    {l.status === 'active' && <CopyButton value={l.url} />}
                  </div>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[l.status]}>{l.status}</Badge>
                </Td>
                <Td>
                  {l.useCount}
                  {l.maxUses != null ? ` / ${l.maxUses}` : ''}
                  {l.mode === 'ONE_TIME' && <span className="ml-1 text-xs text-slate-500">(one-time)</span>}
                  {l.sessionCount != null && <p className="text-xs text-slate-500">{l.sessionCount} session(s)</p>}
                </Td>
                <Td className="whitespace-normal text-xs text-slate-600">
                  <p>{IDENTITY_LABELS[l.identityMode]}</p>
                  {l.passcodeRequired && <p>Passcode</p>}
                  {l.perEmailAttemptLimit && <p>{l.perEmailAttemptLimit} attempt(s)/email</p>}
                  {l.allowedEmailDomains.length > 0 && <p>Domains: {l.allowedEmailDomains.join(', ')}</p>}
                  {l.pinnedVersion && <p>Pinned to v{l.pinnedVersion}</p>}
                  {Object.keys(l.prefilledVariables ?? {}).length > 0 && <p>Prefilled: {Object.keys(l.prefilledVariables).join(', ')}</p>}
                </Td>
                <Td>{l.expiresAt ? formatDate(l.expiresAt) : 'Never'}</Td>
                <Td className="text-right">
                  {l.status !== 'revoked' && (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(l)}>
                        Edit
                      </Button>
                      <ConfirmButton
                        variant="ghost"
                        size="sm"
                        className="text-red-700"
                        confirmText="Revoke this link? People who have it will no longer be able to start sessions."
                        onConfirm={async () => {
                          try {
                            await api(`${path}/${l.id}`, { method: 'DELETE' });
                            toast.success('Link revoked');
                            mutate();
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        Revoke
                      </ConfirmButton>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing && (
        <LinkModal
          key={editing === 'new' ? 'new' : editing.id}
          summary={summary}
          link={editing === 'new' ? undefined : editing}
          path={path}
          onClose={() => setEditing(null)}
          onSaved={(l, created) => {
            setEditing(null);
            mutate();
            if (created) {
              navigator.clipboard?.writeText(l.url).catch(() => undefined);
              toast.success('Link created and copied to your clipboard');
            } else toast.success('Link updated');
          }}
        />
      )}
    </div>
  );
}

function LinkModal({
  summary,
  link,
  path,
  onClose,
  onSaved,
}: {
  summary: AccessSummary;
  link?: ShareLinkDto;
  path: string;
  onClose: () => void;
  onSaved: (l: ShareLinkDto, created: boolean) => void;
}) {
  const [f, setF] = useState<FormState>(() => initialForm(summary, link));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const emailMode = f.identityMode === 'EMAIL' || f.identityMode === 'NAME_EMAIL';

  const save = async () => {
    setSaving(true);
    setError(null);
    const domains = f.allowedEmailDomains
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const prefilledVariables = Object.fromEntries(Object.entries(f.prefilled).filter(([, v]) => v.trim()));
    const body: Record<string, unknown> = {
      label: f.label.trim() || null,
      mode: f.mode,
      maxUses: f.mode === 'ONE_TIME' ? null : f.maxUses ? Number(f.maxUses) : null,
      expiresAt: fromLocalInput(f.expiresAt),
      perEmailAttemptLimit: emailMode && f.perEmailAttemptLimit ? Number(f.perEmailAttemptLimit) : null,
      identityMode: f.identityMode,
      allowedEmailDomains: emailMode ? domains : [],
      prefilledVariables,
      pinnedVersionId: f.pinnedVersionId || null,
    };
    if (f.passcode) body.passcode = f.passcode;
    else if (link && f.removePasscode) body.passcode = null;
    if (link && body.expiresAt === (link.expiresAt ? new Date(link.expiresAt).toISOString() : null)) delete body.expiresAt;
    try {
      const saved = await api<ShareLinkDto>(link ? `${path}/${link.id}` : path, { method: link ? 'PATCH' : 'POST', body });
      onSaved(saved, !link);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={link ? 'Edit share link' : 'New share link'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {link ? 'Save changes' : 'Create link'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {error && (
          <div className="sm:col-span-2">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        <Field label="Label" hint="Only visible to your team, e.g. “Spring cohort”." className="sm:col-span-2">
          {(id) => <Input id={id} value={f.label} maxLength={120} onChange={(e) => set('label', e.target.value)} />}
        </Field>
        <Field label="Usage">
          {(id) => (
            <Select id={id} value={f.mode} onChange={(e) => set('mode', e.target.value as FormState['mode'])}>
              <option value="MULTI_USE">Reusable link</option>
              <option value="ONE_TIME">One-time link (single session)</option>
            </Select>
          )}
        </Field>
        <Field label="Maximum uses" hint="Leave empty for unlimited.">
          {(id) => (
            <Input id={id} type="number" min={1} disabled={f.mode === 'ONE_TIME'} value={f.mode === 'ONE_TIME' ? '1' : f.maxUses} onChange={(e) => set('maxUses', e.target.value)} />
          )}
        </Field>
        <Field label="Expires" hint="Leave empty to never expire.">
          {(id) => <Input id={id} type="datetime-local" value={f.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />}
        </Field>
        <Field label="Scenario version">
          {(id) => (
            <Select id={id} value={f.pinnedVersionId} onChange={(e) => set('pinnedVersionId', e.target.value)}>
              <option value="">Always the latest published version</option>
              {summary.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Pin to v{v.version} ({new Date(v.publishedAt).toLocaleDateString()})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Participant identity">
          {(id) => (
            <Select id={id} value={f.identityMode} onChange={(e) => set('identityMode', e.target.value as IdentityMode)}>
              {(Object.keys(IDENTITY_LABELS) as IdentityMode[]).map((m) => (
                <option key={m} value={m}>
                  {IDENTITY_LABELS[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Passcode"
          hint={link?.passcodeRequired ? 'A passcode is set. Enter a new one to replace it.' : 'Optional. Share it separately from the link.'}
        >
          {(id) => <Input id={id} type="text" autoComplete="off" minLength={4} maxLength={128} value={f.passcode} onChange={(e) => set('passcode', e.target.value)} />}
        </Field>
        {link?.passcodeRequired && (
          <div className="sm:col-span-2">
            <Checkbox label="Remove the passcode" checked={f.removePasscode} onChange={(v) => set('removePasscode', v)} />
          </div>
        )}
        <Field label="Attempts per email" hint={emailMode ? 'Leave empty for unlimited.' : 'Requires collecting email.'}>
          {(id) => <Input id={id} type="number" min={1} max={1000} disabled={!emailMode} value={f.perEmailAttemptLimit} onChange={(e) => set('perEmailAttemptLimit', e.target.value)} />}
        </Field>
        <Field label="Allowed email domains" hint={emailMode ? 'Comma separated, e.g. acme.com, *.acme.org' : 'Requires collecting email.'}>
          {(id) => <Input id={id} disabled={!emailMode} value={f.allowedEmailDomains} onChange={(e) => set('allowedEmailDomains', e.target.value)} />}
        </Field>
        {summary.variables.length > 0 && (
          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="text-sm font-medium text-slate-700">Prefilled variables</legend>
            <p className="text-xs text-slate-500">
              Values set here are fixed for everyone using this link. Participants can supply the others via <code>?var_&lt;key&gt;=</code> URL parameters.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {summary.variables.map((v) => (
                <Field key={v.key} label={`${v.label} (${v.key})`}>
                  {(id) => (
                    <Input id={id} maxLength={v.maxLength} value={f.prefilled[v.key] ?? ''} onChange={(e) => setF((s) => ({ ...s, prefilled: { ...s.prefilled, [v.key]: e.target.value } }))} />
                  )}
                </Field>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
