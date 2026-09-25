'use client';
import { useState } from 'react';
import useSWR from 'swr';
import {
  Alert,
  Badge,
  Button,
  Card,
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
  Textarea,
  useToast,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { STATUS_TONE, type AccessSummary, type AccessTokenDto } from './types';

const TTL_OPTIONS = [
  { label: '1 hour', value: 3600 },
  { label: '1 day', value: 86400 },
  { label: '7 days', value: 7 * 86400 },
  { label: '30 days (maximum)', value: 30 * 86400 },
];

function embedSnippet(origin: string, token: string) {
  return `<div id="cf-call" style="height:640px"></div>
<script src="${origin}/embed.js"></script>
<script>
  // Mint a fresh cfe_ token on YOUR server for each visitor (POST /api/v1/access-tokens with an API key).
  ConversaForge.init({
    container: '#cf-call',
    token: '${token}',
    onEvent: (e) => console.log('ConversaForge', e.type, e),
  });
</script>`;
}

export function AccessTokensTab({ scenarioId, summary }: { scenarioId: string; summary: AccessSummary }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const path = wsPath('/access-tokens');
  const { data, error, mutate } = useSWR<{ data: AccessTokenDto[] }>(`${path}?scenarioId=${scenarioId}&limit=100`);
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<{ token: string; url: string | null; purpose: string; emailed: boolean } | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="space-y-4">
      <Card title="Embed on your website">
        <div className="space-y-2 text-sm text-slate-700">
          <p>
            Embed tokens (<code>cfe_…</code>) let the ConversaForge widget start sessions on your site. In production, your server mints a short-lived token per
            visitor with an API key (<code>POST /api/v1/access-tokens</code>) and passes it to the page; tokens can be restricted to your site’s origins, limited in
            uses, and revoked. See <code>docs/embed.md</code> for the full guide and trust model.
          </p>
          {!summary.channels.embed && <Alert tone="warning">The embed channel is disabled in this scenario’s settings.</Alert>}
          <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{embedSnippet(origin, 'cfe_…')}</pre>
        </div>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">Tokens are shown only once. We store a hash, never the token itself.</p>
        <Button onClick={() => setCreating(true)} disabled={!summary.runnable}>
          New access token
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading />
      ) : !data.data.length ? (
        <EmptyState title="No access tokens" description="Create an embed token for testing, or a personal invitation link for one participant." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Token</Th>
              <Th>Type</Th>
              <Th>Participant</Th>
              <Th>Allowed origins</Th>
              <Th>Uses</Th>
              <Th>Expires</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.data.map((t) => (
              <tr key={t.id} className={t.status !== 'active' ? 'opacity-60' : undefined}>
                <Td>
                  <code className="text-xs">{t.prefix}…</code>
                </Td>
                <Td>{t.purpose === 'EMBED' ? 'Embed' : 'Personal link'}</Td>
                <Td className="text-xs">{t.participant.name || t.participant.email || t.participant.externalId || '—'}</Td>
                <Td className="whitespace-normal text-xs">{t.allowedOrigins.length ? t.allowedOrigins.join(', ') : <span className="text-amber-700">Any site</span>}</Td>
                <Td>
                  {t.useCount}
                  {t.maxUses != null ? ` / ${t.maxUses}` : ''}
                </Td>
                <Td>{formatDate(t.expiresAt)}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                </Td>
                <Td className="text-right">
                  {t.status !== 'revoked' && (
                    <ConfirmButton
                      variant="ghost"
                      size="sm"
                      className="text-red-700"
                      confirmText="Revoke this token? Sessions already started keep running; no new sessions can start."
                      onConfirm={async () => {
                        try {
                          await api(`${path}/${t.id}`, { method: 'DELETE' });
                          mutate();
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
      {creating && (
        <CreateTokenModal
          scenarioId={scenarioId}
          summary={summary}
          path={path}
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            setMinted(m);
            mutate();
          }}
        />
      )}
      <Modal open={!!minted} onClose={() => setMinted(null)} title="Copy your token now" wide footer={<Button onClick={() => setMinted(null)}>Done</Button>}>
        {minted && (
          <div className="space-y-4 text-sm">
            <Alert tone="warning">This is the only time the token is shown. Store it securely; anyone with it can start sessions within its limits.</Alert>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-slate-100 p-2 text-xs">{minted.token}</code>
              <CopyButton value={minted.token} />
            </div>
            {minted.url && (
              <div>
                <p className="mb-1 font-medium">Personal invitation link {minted.emailed && <Badge tone="green">emailed</Badge>}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-slate-100 p-2 text-xs">{minted.url}</code>
                  <CopyButton value={minted.url} />
                </div>
              </div>
            )}
            {minted.purpose === 'EMBED' && (
              <div>
                <p className="mb-1 font-medium">Embed snippet (for testing)</p>
                <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{embedSnippet(origin, minted.token)}</pre>
                <CopyButton value={embedSnippet(origin, minted.token)} label="Copy snippet" />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function CreateTokenModal({
  scenarioId,
  summary,
  path,
  onClose,
  onCreated,
}: {
  scenarioId: string;
  summary: AccessSummary;
  path: string;
  onClose: () => void;
  onCreated: (m: { token: string; url: string | null; purpose: string; emailed: boolean }) => void;
}) {
  const [purpose, setPurpose] = useState<'EMBED' | 'PARTICIPANT'>('EMBED');
  const [origins, setOrigins] = useState('');
  const [ttl, setTtl] = useState(3600);
  const [maxUses, setMaxUses] = useState('');
  const [participant, setParticipant] = useState({ name: '', email: '', externalId: '' });
  const [vars, setVars] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ token: string; url: string | null; emailed: boolean }>(path, {
        method: 'POST',
        body: {
          scenarioId,
          purpose,
          pinnedVersionId: pinned || null,
          participant: {
            name: participant.name.trim() || null,
            email: participant.email.trim() || null,
            externalId: participant.externalId.trim() || null,
          },
          variables: Object.fromEntries(Object.entries(vars).filter(([, v]) => v.trim())),
          allowedOrigins: origins
            .split(/[\s,]+/)
            .map((o) => o.trim())
            .filter(Boolean),
          maxUses: maxUses ? Number(maxUses) : purpose === 'PARTICIPANT' ? 1 : null,
          expiresInSeconds: ttl,
          ...(purpose === 'PARTICIPANT' ? { sendEmail: sendEmail && !!participant.email.trim() } : {}),
        },
      });
      onCreated({ ...r, purpose });
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
      title="New access token"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Create token
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
        <Field label="Type">
          {(id) => (
            <Select id={id} value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}>
              <option value="EMBED">Embed token (cfe_) — for the website widget</option>
              <option value="PARTICIPANT">Personal invitation link (cfp_) — for one person</option>
            </Select>
          )}
        </Field>
        <Field label="Valid for">
          {(id) => (
            <Select id={id} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {TTL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {purpose === 'EMBED' && (
          <Field label="Allowed origins" hint="e.g. https://www.example.com — one per line. Empty = any site (not recommended)." className="sm:col-span-2">
            {(id) => <Textarea id={id} rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} />}
          </Field>
        )}
        <Field label="Maximum sessions" hint={purpose === 'PARTICIPANT' ? 'Default 1 (single use).' : 'Empty = unlimited until expiry.'}>
          {(id) => <Input id={id} type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />}
        </Field>
        <Field label="Scenario version">
          {(id) => (
            <Select id={id} value={pinned} onChange={(e) => setPinned(e.target.value)}>
              <option value="">Latest published</option>
              {summary.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Participant name">
          {(id) => <Input id={id} maxLength={120} value={participant.name} onChange={(e) => setParticipant({ ...participant, name: e.target.value })} />}
        </Field>
        <Field label="Participant email">
          {(id) => <Input id={id} type="email" value={participant.email} onChange={(e) => setParticipant({ ...participant, email: e.target.value })} />}
        </Field>
        <Field label="External id" hint="Your system’s id for this person (maps to the participant).">
          {(id) => <Input id={id} maxLength={200} value={participant.externalId} onChange={(e) => setParticipant({ ...participant, externalId: e.target.value })} />}
        </Field>
        {purpose === 'PARTICIPANT' && (
          <div className="flex items-end">
            <Checkbox label="Email the invitation link" checked={sendEmail} onChange={setSendEmail} description="Requires a participant email." />
          </div>
        )}
        {summary.variables.length > 0 && (
          <fieldset className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium text-slate-700">Variables (fixed for this token)</legend>
            {summary.variables.map((v) => (
              <Field key={v.key} label={`${v.label} (${v.key})`}>
                {(id) => <Input id={id} maxLength={v.maxLength} value={vars[v.key] ?? ''} onChange={(e) => setVars((s) => ({ ...s, [v.key]: e.target.value }))} />}
              </Field>
            ))}
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
