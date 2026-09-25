'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  SimulatedBadge,
  Table,
  Td,
  Th,
  useToast,
} from '@/components/ui';

type Kind = 'LLM' | 'REALTIME' | 'TTS' | 'STT' | 'TELEPHONY' | 'MEETING' | 'CALENDAR';
interface ProviderInfo {
  id: string;
  name: string;
  capabilities: Kind[];
  defaultCapabilities: Kind[];
  secretLabel: string;
  secretHelp: string;
  compositeSecret?: boolean;
  docsUrl: string;
}
interface Connection {
  id: string;
  provider: string;
  providerName: string;
  kind: string;
  capabilities: Kind[];
  label: string | null;
  secretLast4: string | null;
  config: Record<string, any>;
  status: 'ACTIVE' | 'INVALID' | 'REVOKED';
  lastVerifiedAt: string | null;
  createdAt: string;
}
interface CapabilityStatus {
  key: string;
  label: string;
  source: 'workspace' | 'environment' | 'simulator' | 'browser' | 'unavailable';
  provider: string | null;
  model?: string | null;
  simulated: boolean;
  message: string;
}
interface Verification {
  result: 'valid' | 'invalid' | 'error' | 'unsupported';
  httpStatus: number | null;
  message: string;
}

const KIND_LABEL: Record<Kind, string> = {
  LLM: 'Language model',
  REALTIME: 'Realtime voice',
  TTS: 'Text-to-speech',
  STT: 'Speech-to-text',
  TELEPHONY: 'Phone calls',
  MEETING: 'Meeting bots',
  CALENDAR: 'Calendar',
};
const SOURCE_BADGE: Record<CapabilityStatus['source'], { tone: 'green' | 'blue' | 'yellow' | 'gray' | 'red'; label: string }> = {
  workspace: { tone: 'green', label: 'Workspace key' },
  environment: { tone: 'blue', label: 'Server key' },
  simulator: { tone: 'yellow', label: 'Simulator' },
  browser: { tone: 'gray', label: 'Browser fallback' },
  unavailable: { tone: 'red', label: 'Unavailable' },
};
const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'];

function verificationToast(toast: ReturnType<typeof useToast>, v: Verification | null) {
  if (!v) return;
  if (v.result === 'valid') toast.success('Key verified');
  else if (v.result === 'invalid') toast.error(v.message);
  else toast.info(v.message);
}

export default function ProvidersSettingsPage() {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const allowed = can('providers.manage');
  const { data: status, error: statusError, mutate: mutateStatus } = useSWR<{ capabilities: CapabilityStatus[]; simulatorAllowed: boolean }>(allowed ? wsPath('/providers/status') : null);
  const { data: list, error, mutate } = useSWR<{ data: Connection[] }>(allowed ? wsPath('/providers') : null);
  const { data: catalog } = useSWR<{ providers: ProviderInfo[] }>(allowed ? wsPath('/providers/catalog') : null);
  const [adding, setAdding] = useState(false);
  const [rotating, setRotating] = useState<Connection | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = () => {
    void mutate();
    void mutateStatus();
  };

  if (!allowed) return <EmptyState title="Admins only" description="Only workspace admins can manage AI provider keys." />;

  const connected = new Set((list?.data ?? []).map((c) => c.provider));

  async function verify(c: Connection) {
    setBusyId(c.id);
    try {
      const r = await api<{ verification: Verification }>(wsPath(`/providers/${c.id}/verify`), { method: 'POST' });
      verificationToast(toast, r.verification);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI providers"
        description="Bring your own keys for language models, voice, phone and meeting bots. Keys are encrypted at rest and never shown again after saving."
        actions={<Button onClick={() => setAdding(true)}>Add provider key</Button>}
      />

      <Card title="What sessions use right now">
        {statusError ? (
          <ErrorState error={statusError} retry={() => mutateStatus()} />
        ) : !status ? (
          <Loading />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Capability</Th>
                  <Th>Source</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {status.capabilities.map((c) => (
                  <tr key={c.key} data-testid={`cap-${c.key}`}>
                    <Td className="font-medium">{c.label}</Td>
                    <Td>
                      {c.simulated ? <SimulatedBadge what="Simulator (no key)" /> : <Badge tone={SOURCE_BADGE[c.source].tone}>{SOURCE_BADGE[c.source].label}</Badge>}
                    </Td>
                    <Td className="min-w-[16rem] whitespace-normal text-sm text-slate-700">{c.message}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {status.capabilities.some((c) => c.simulated) && (
              <div className="mt-3">
                <Alert tone="warning" title="Conversations and analysis are simulated">
                  No language-model key is configured, so the local simulator produces clearly-labeled, rule-based responses. Add an Anthropic or OpenAI key for real conversations and scoring.
                </Alert>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Connections">
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !list ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <EmptyState title="No provider keys yet" description="Sessions use server keys (if configured) or the simulator." action={<Button onClick={() => setAdding(true)}>Add provider key</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Status</Th>
                <Th className="hidden lg:table-cell">Used for</Th>
                <Th className="hidden md:table-cell">Key</Th>
                <Th className="hidden xl:table-cell">Last verified</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} data-testid={`conn-${c.provider}`}>
                  <Td>
                    <div className="font-medium">{c.providerName}</div>
                    {c.label && <div className="text-xs text-slate-500">{c.label}</div>}
                    <ModelSummary c={c} />
                  </Td>
                  <Td>
                    {c.status === 'ACTIVE' ? (
                      <Badge tone="green">{c.lastVerifiedAt ? 'Verified' : 'Active (unverified)'}</Badge>
                    ) : c.status === 'INVALID' ? (
                      <Badge tone="red">Invalid</Badge>
                    ) : (
                      <Badge>Revoked</Badge>
                    )}
                  </Td>
                  <Td className="hidden whitespace-normal text-xs lg:table-cell">{c.capabilities.map((k) => KIND_LABEL[k]).join(', ')}</Td>
                  <Td className="hidden md:table-cell font-mono text-xs">{c.secretLast4 ? `••••${c.secretLast4}` : '••••'}</Td>
                  <Td className="hidden text-xs xl:table-cell">{formatDate(c.lastVerifiedAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" loading={busyId === c.id} onClick={() => verify(c)}>
                        Verify
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                        Settings
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRotating(c)}>
                        Rotate key
                      </Button>
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        className="text-red-700"
                        confirmText={`Revoke the ${c.providerName} key? Sessions will fall back to server keys or the simulator.`}
                        onConfirm={async () => {
                          try {
                            await api(wsPath(`/providers/${c.id}/revoke`), { method: 'POST' });
                            toast.success('Key revoked');
                            refresh();
                          } catch (e) {
                            toast.error(errorMessage(e));
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
      </Card>

      {adding && catalog && <AddConnectionModal providers={catalog.providers} connected={connected} onClose={() => setAdding(false)} onDone={refresh} />}
      {rotating && <RotateModal conn={rotating} onClose={() => setRotating(null)} onDone={refresh} />}
      {editing && catalog && (
        <SettingsModal conn={editing} info={catalog.providers.find((p) => p.id === editing.provider)} onClose={() => setEditing(null)} onDone={refresh} />
      )}
    </div>
  );
}

function ModelSummary({ c }: { c: Connection }) {
  const bits = [
    c.config.liveModel && `live: ${c.config.liveModel}`,
    c.config.analysisModel && `analysis: ${c.config.analysisModel}`,
    c.config.realtimeModel && `realtime: ${c.config.realtimeModel}`,
    c.config.voice && `voice: ${c.config.voice}`,
    c.config.region && `region: ${c.config.region}`,
    c.config.accountSid && `SID ${String(c.config.accountSid).slice(0, 8)}…`,
  ].filter(Boolean);
  return bits.length ? <div className="text-xs text-slate-500">{bits.join(' · ')}</div> : null;
}

/** Provider-specific, non-secret settings. */
function ConfigFields({ provider, config, setConfig, info }: { provider: string; config: Record<string, any>; setConfig: (c: Record<string, any>) => void; info?: ProviderInfo }) {
  const set = (k: string, v: string) => setConfig({ ...config, [k]: v || undefined });
  const caps: Kind[] = config.capabilities ?? info?.defaultCapabilities ?? [];
  return (
    <div className="space-y-3">
      {info && info.capabilities.length > 1 && (
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Use this key for</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {info.capabilities.map((k) => (
              <Checkbox
                key={k}
                label={KIND_LABEL[k]}
                checked={caps.includes(k)}
                onChange={(on) => setConfig({ ...config, capabilities: on ? [...caps, k] : caps.filter((x) => x !== k) })}
              />
            ))}
          </div>
        </fieldset>
      )}
      {(provider === 'anthropic' || provider === 'openai') && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Live conversation model" hint={provider === 'anthropic' ? 'Default: claude-opus-5 (claude-sonnet-5, claude-haiku-4-5 also work)' : 'Default: gpt-4.1-mini'}>
            {(id) => <Input id={id} value={config.liveModel ?? ''} onChange={(e) => set('liveModel', e.target.value.trim())} placeholder="(server default)" />}
          </Field>
          <Field label="Analysis model" hint={provider === 'anthropic' ? 'Default: claude-opus-5' : 'Default: gpt-4.1'}>
            {(id) => <Input id={id} value={config.analysisModel ?? ''} onChange={(e) => set('analysisModel', e.target.value.trim())} placeholder="(server default)" />}
          </Field>
        </div>
      )}
      {provider === 'openai' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Realtime model" hint="Default: gpt-realtime">
            {(id) => <Input id={id} value={config.realtimeModel ?? ''} onChange={(e) => set('realtimeModel', e.target.value.trim())} placeholder="(server default)" />}
          </Field>
          <Field label="Voice" hint="e.g. alloy, verse, coral">
            {(id) => <Input id={id} value={config.voice ?? ''} onChange={(e) => set('voice', e.target.value.trim())} placeholder="(scenario default)" />}
          </Field>
        </div>
      )}
      {(provider === 'elevenlabs' || provider === 'deepgram') && (
        <Field label="Default voice" hint={provider === 'elevenlabs' ? 'ElevenLabs voice id' : 'Deepgram Aura voice, e.g. aura-2-thalia-en'}>
          {(id) => <Input id={id} value={config.voice ?? ''} onChange={(e) => set('voice', e.target.value.trim())} />}
        </Field>
      )}
      {provider === 'twilio' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Account SID" required hint="AC followed by 32 hex characters">
            {(id) => <Input id={id} value={config.accountSid ?? ''} onChange={(e) => set('accountSid', e.target.value.trim())} placeholder="AC…" />}
          </Field>
          <Field label="Default phone number" hint="E.164, e.g. +14155550123 (optional)">
            {(id) => <Input id={id} value={config.phoneNumber ?? ''} onChange={(e) => set('phoneNumber', e.target.value.trim())} />}
          </Field>
        </div>
      )}
      {provider === 'recall' && (
        <Field label="Region">
          {(id) => (
            <Select id={id} value={config.region ?? 'us-east-1'} onChange={(e) => set('region', e.target.value)}>
              {RECALL_REGIONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </div>
  );
}

function AddConnectionModal({ providers, connected, onClose, onDone }: { providers: ProviderInfo[]; connected: Set<string>; onClose: () => void; onDone: () => void }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const available = providers.filter((p) => !connected.has(p.id));
  const [provider, setProvider] = useState(available[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [config, setConfig] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = providers.find((p) => p.id === provider);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ verification: Verification | null }>(wsPath('/providers'), {
        method: 'POST',
        body: { provider, label: label.trim() || undefined, secret: secret.trim(), config: clean(config) },
      });
      verificationToast(toast, r.verification);
      setSecret('');
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add provider key"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!provider || secret.trim().length < 8}>
            Save & verify
          </Button>
        </>
      }
    >
      {available.length === 0 ? (
        <p className="text-sm">Every provider already has a key. Rotate an existing key instead.</p>
      ) : (
        <form
          className="space-y-3"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Provider">
            {(id) => (
              <Select
                id={id}
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setConfig({});
                }}
              >
                {available.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={info?.secretLabel ?? 'API key'} required hint={info?.secretHelp}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />}
          </Field>
          <Field label="Label" hint="Optional, e.g. “Production key”">
            {(id) => <Input id={id} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />}
          </Field>
          <ConfigFields provider={provider} config={config} setConfig={setConfig} info={info} />
          {info && (
            <p className="text-xs text-slate-500">
              Docs:{' '}
              <a className="underline" href={info.docsUrl} target="_blank" rel="noreferrer noopener">
                {info.docsUrl}
              </a>
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

function RotateModal({ conn, onClose, onDone }: { conn: Connection; onClose: () => void; onDone: () => void }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ verification: Verification | null }>(wsPath(`/providers/${conn.id}/rotate`), { method: 'POST', body: { secret: secret.trim() } });
      verificationToast(toast, r.verification);
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Rotate ${conn.providerName} key`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={secret.trim().length < 8}>
            Replace key
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <p className="text-sm text-slate-600">The old key (••••{conn.secretLast4 || '????'}) is replaced immediately. Revoke it at the provider afterwards.</p>
        <Field label={conn.provider === 'twilio' ? 'New auth token' : 'New API key'} required>
          {(id) => <Input id={id} type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function SettingsModal({ conn, info, onClose, onDone }: { conn: Connection; info?: ProviderInfo; onClose: () => void; onDone: () => void }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const [label, setLabel] = useState(conn.label ?? '');
  const [config, setConfig] = useState<Record<string, any>>({ ...conn.config });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(wsPath(`/providers/${conn.id}`), { method: 'PATCH', body: { label: label.trim() || null, config: clean(config) } });
      toast.success('Settings saved');
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${conn.providerName} settings`}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Label">
          {(id) => <Input id={id} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        <ConfigFields provider={conn.provider} config={config} setConfig={setConfig} info={info} />
      </div>
    </Modal>
  );
}

function clean(c: Record<string, any>) {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== ''));
}
