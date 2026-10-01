'use client';
import { useMemo, useState } from 'react';
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
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  Th,
  useToast,
} from '@/components/ui';

interface Fn {
  id: string;
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  allowedHosts: string[];
  timeoutMs: number;
  enabled: boolean;
  updatedAt: string;
}
interface ExecResult {
  ok: boolean;
  status: number | null;
  result?: unknown;
  error?: string;
  errorCode?: string;
  durationMs: number;
}

const MASK = '••••';
const EXAMPLE_SCHEMA = JSON.stringify(
  {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: 'Order number, e.g. AB-1234', pattern: '^[A-Z]{2}-\\d{4}$' },
    },
    required: ['orderId'],
    additionalProperties: false,
  },
  null,
  2,
);

/** Quick client-side check (the server validates fully). */
function checkSchema(text: string): { schema?: Record<string, unknown>; error?: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'The schema must be a JSON object' };
  if ((v as any).type !== 'object') return { error: 'The root schema must have "type": "object"' };
  if (text.length > 16 * 1024) return { error: 'The schema is larger than 16 KB' };
  return { schema: v as Record<string, unknown> };
}

/** Example args from a schema (for the test runner). */
function exampleArgs(schema: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries<any>(schema.properties ?? {})) {
    if (!(schema.required ?? []).includes(k)) continue;
    out[k] = p.enum?.[0] ?? (p.type === 'number' || p.type === 'integer' ? p.minimum ?? 1 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : '');
  }
  return out;
}

export default function FunctionsSettingsPage() {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const allowed = can('providers.manage');
  const { data, error, mutate } = useSWR<{ data: Fn[] }>(allowed ? wsPath('/functions') : null);
  const [editing, setEditing] = useState<Fn | 'new' | null>(null);
  const [testing, setTesting] = useState<Fn | null>(null);

  if (!allowed) return <EmptyState title="Admins only" description="Only workspace admins can manage custom functions." />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Custom functions"
        description="HTTPS endpoints your agents can call as tools (e.g. look up an order). Calls run server-side, only to allowlisted hosts, with signed requests, a timeout and a 64 KB response cap. Grant functions per scenario in the scenario’s tool settings."
        actions={<Button onClick={() => setEditing('new')}>New function</Button>}
      />
      <Card>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <Loading />
        ) : data.data.length === 0 ? (
          <EmptyState title="No functions yet" description="Create one to let agents fetch live data from your systems." action={<Button onClick={() => setEditing('new')}>New function</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th className="hidden md:table-cell">Endpoint</Th>
                <Th>Status</Th>
                <Th className="hidden lg:table-cell">Updated</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((f) => (
                <tr key={f.id}>
                  <Td>
                    <div className="font-mono text-sm font-medium">{f.name}</div>
                    <div className="max-w-sm truncate text-xs text-slate-500">{f.description}</div>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <span className="font-mono text-xs">
                      {f.method} {f.url}
                    </span>
                  </Td>
                  <Td>{f.enabled ? <Badge tone="green">Enabled</Badge> : <Badge>Disabled</Badge>}</Td>
                  <Td className="hidden lg:table-cell text-xs">{formatDate(f.updatedAt)}</Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setTesting(f)}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(f)}>
                        Edit
                      </Button>
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        className="text-red-700"
                        confirmText={`Delete ${f.name}? Scenarios that grant it will no longer be able to call it.`}
                        onConfirm={async () => {
                          try {
                            await api(wsPath(`/functions/${f.id}`), { method: 'DELETE' });
                            toast.success('Function deleted');
                            void mutate();
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Verifying requests">
        <div className="space-y-2 text-sm text-slate-700">
          <p>
            Each call is a <code>POST</code> with JSON <code>{'{ arguments, context: { workspaceId, sessionId, scenarioVersionId, functionName, test, timestamp } }'}</code> (for <code>GET</code>, the same JSON is sent in the <code>payload</code> query parameter).
          </p>
          <p>
            Verify the <code>X-ConversaForge-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> header: <code>v1 = HMAC-SHA256(signing secret, t + &quot;.&quot; + raw body)</code>, and reject timestamps older than 5 minutes. Each function’s signing secret is shown in its editor.
          </p>
          <p>Responses should be JSON (≤ 64 KB). Return data only — the agent treats it as untrusted content, not instructions.</p>
        </div>
      </Card>
      {editing && <FunctionEditor fn={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => mutate()} />}
      {testing && <TestRunner fn={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

function FunctionEditor({ fn, onClose, onSaved }: { fn: Fn | null; onClose: () => void; onSaved: () => void }) {
  const { wsPath } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState(fn?.name ?? '');
  const [description, setDescription] = useState(fn?.description ?? '');
  const [url, setUrl] = useState(fn?.url ?? 'https://');
  const [method, setMethod] = useState<'GET' | 'POST'>(fn?.method ?? 'POST');
  const [hosts, setHosts] = useState((fn?.allowedHosts ?? []).join(', '));
  const [timeoutMs, setTimeoutMs] = useState(fn?.timeoutMs ?? 8000);
  const [enabled, setEnabled] = useState(fn?.enabled ?? true);
  const [schemaText, setSchemaText] = useState(fn ? JSON.stringify(fn.parametersSchema, null, 2) : EXAMPLE_SCHEMA);
  const [headers, setHeaders] = useState<Array<{ k: string; v: string }>>(Object.entries(fn?.headers ?? {}).map(([k, v]) => ({ k, v })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const schemaCheck = useMemo(() => checkSchema(schemaText), [schemaText]);
  const nameOk = /^[a-z][a-z0-9_]{1,63}$/.test(name);

  async function save() {
    if (!schemaCheck.schema) return;
    setBusy(true);
    setError(null);
    const body = {
      name,
      description: description.trim(),
      url: url.trim(),
      method,
      parametersSchema: schemaCheck.schema,
      allowedHosts: hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean),
      timeoutMs: Number(timeoutMs),
      enabled,
      headers: Object.fromEntries(headers.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v])),
    };
    try {
      if (fn) await api(wsPath(`/functions/${fn.id}`), { method: 'PATCH', body });
      else await api(wsPath('/functions'), { method: 'POST', body });
      toast.success(fn ? 'Function saved' : 'Function created');
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    if (!fn) return;
    try {
      const r = await api<{ secret: string }>(wsPath(`/functions/${fn.id}/signing-secret`), { method: 'POST' });
      setSecret(r.secret);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={fn ? `Edit ${fn.name}` : 'New function'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!nameOk || !description.trim() || !schemaCheck.schema}>
            {fn ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required hint="snake_case; the agent sees it as fn_<name>" error={name && !nameOk ? 'Lowercase letters, digits and underscores; start with a letter' : undefined}>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" maxLength={64} />}
          </Field>
          <Field label="Method">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}>
                <option>POST</option>
                <option>GET</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Description" required hint="Tell the agent when to use it and what it returns.">
          {(id) => <Textarea id={id} rows={2} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label="URL" required hint="https only. Private, loopback and cloud-metadata addresses are always blocked.">
          {(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Allowed hosts" hint="Comma separated; defaults to the URL host. *.example.com allows subdomains.">
            {(id) => <Input id={id} value={hosts} onChange={(e) => setHosts(e.target.value)} className="font-mono" />}
          </Field>
          <Field label="Timeout (ms)" hint="500–15000">
            {(id) => <Input id={id} type="number" min={500} max={15000} step={500} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} />}
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Headers</legend>
          <p className="text-xs text-slate-500">Encrypted at rest. Saved values are shown as {MASK}; leave {MASK} to keep a value.</p>
          {headers.map((h, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label="Header name" placeholder="Authorization" value={h.k} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} className="font-mono" />
              <Input aria-label="Header value" type="password" autoComplete="new-password" placeholder="Bearer …" value={h.v} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              <Button variant="ghost" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} aria-label="Remove header">
                ✕
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setHeaders([...headers, { k: '', v: '' }])} disabled={headers.length >= 20}>
            Add header
          </Button>
        </fieldset>
        <Field label="Parameters (JSON Schema)" required error={schemaCheck.error} hint="Root must be an object schema. Supported: type, properties, required, enum, min/max, pattern, items, anyOf/oneOf/allOf, additionalProperties.">
          {(id) => <Textarea id={id} rows={12} value={schemaText} onChange={(e) => setSchemaText(e.target.value)} className="font-mono text-xs" spellCheck={false} aria-invalid={!!schemaCheck.error} />}
        </Field>
        <Checkbox label="Enabled" checked={enabled} onChange={setEnabled} description="Disabled functions are not offered to agents (test runs still work)." />
        {fn && (
          <div className="rounded-md border border-slate-200 p-3 text-sm">
            <p className="font-medium">Signing secret</p>
            {secret ? (
              <div className="mt-1 flex items-center gap-2">
                <code className="break-all text-xs">{secret}</code>
                <CopyButton value={secret} />
              </div>
            ) : (
              <Button size="sm" variant="secondary" className="mt-1" onClick={reveal}>
                Reveal signing secret
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function TestRunner({ fn, onClose }: { fn: Fn; onClose: () => void }) {
  const { wsPath } = useWorkspace();
  const [args, setArgs] = useState(JSON.stringify(exampleArgs(fn.parametersSchema), null, 2));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ExecResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setRes(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch (e) {
      setError(`Arguments are not valid JSON: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    try {
      setRes(await api<ExecResult>(wsPath(`/functions/${fn.id}/test`), { method: 'POST', body: { args: parsed as Record<string, unknown> } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Test ${fn.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={run} loading={busy}>
            Send test request
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Sends a real, signed request to <code className="text-xs">{fn.url}</code> with <code>context.test = true</code>.
        </p>
        <Field label="Arguments (JSON)">
          {(id) => <Textarea id={id} rows={8} value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono text-xs" spellCheck={false} />}
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        {res && (
          <div aria-live="polite" className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {res.ok ? <Badge tone="green">Success</Badge> : <Badge tone="red">Failed</Badge>}
              {res.status != null && <span>HTTP {res.status}</span>}
              <span className="text-slate-500">{res.durationMs} ms</span>
              {res.errorCode && <code className="text-xs text-slate-500">{res.errorCode}</code>}
            </div>
            {res.error && <Alert tone={res.ok ? 'info' : 'error'}>{res.error}</Alert>}
            {res.result !== undefined && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-slate-900 p-3 text-xs text-slate-100">
                {typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
