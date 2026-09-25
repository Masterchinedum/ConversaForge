import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createGTestContext, G_TEST_DB } from '../knowledge/g-test-context';
import type { FetchLike } from './provider-verify';

/**
 * Provider connections + custom functions (integration, real Postgres). Run with G_TEST_DATABASE_URL set.
 */
const d = G_TEST_DB ? describe : describe.skip;

const SECRET = 'sk-ant-api03-THIS-IS-A-FAKE-KEY-abcdefghijklmnop-WXYZ';

function fakeFetch(status: number, body = '{}'): FetchLike & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { status, text: async () => body };
  }) as any;
  f.calls = calls;
  return f;
}

d('ProvidersService (integration)', () => {
  let ctx: Awaited<ReturnType<typeof createGTestContext>>;
  let ws: { id: string };
  let other: { id: string };

  beforeAll(async () => {
    ctx = await createGTestContext();
    ws = await ctx.workspace('Prov');
    other = await ctx.workspace('Other');
  });
  afterAll(async () => {
    await ctx?.prisma.providerConnection.deleteMany({ where: { workspaceId: { in: [ws?.id, other?.id] } } });
    await ctx?.prisma.customFunction.deleteMany({ where: { workspaceId: { in: [ws?.id, other?.id] } } });
    await ctx?.prisma.workspace.deleteMany({ where: { id: { in: [ws?.id, other?.id] } } });
    await ctx?.prisma.$disconnect();
  });

  it('encrypts the secret, never returns or audits it, and marks a rejected key INVALID', async () => {
    const f = fakeFetch(401, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${SECRET}` } }));
    ctx.providers.fetchImpl = f;
    const out = await ctx.providers.create(ws.id, ctx.principal, { provider: 'anthropic', secret: SECRET, config: { liveModel: 'claude-sonnet-5' }, verify: true });
    expect(f.calls[0]).toMatchObject({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' } });
    expect(out.verification).toMatchObject({ result: 'invalid', httpStatus: 401 });
    expect(out.connection).toMatchObject({ provider: 'anthropic', kind: 'LLM', status: 'INVALID', secretLast4: 'WXYZ', capabilities: ['LLM'] });
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('encryptedSecret');

    const row = await ctx.prisma.providerConnection.findFirst({ where: { id: out.connection.id } });
    expect(row.encryptedSecret).not.toContain(SECRET);
    expect(ctx.crypto.decrypt(row.encryptedSecret)).toBe(SECRET);

    const listed = JSON.stringify(await ctx.providers.list(ws.id));
    expect(listed).not.toContain(SECRET);
    const audits = await ctx.prisma.auditLog.findMany({ where: { workspaceId: ws.id } });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(SECRET);

    // INVALID connections are not used by the LLM resolver → simulator.
    const r = await ctx.llm.resolve(ws.id, 'live');
    expect(r.simulated).toBe(true);
    const status = await ctx.providers.status(ws.id);
    const live = status.capabilities.find((c) => c.key === 'live_llm')!;
    expect(live).toMatchObject({ source: 'simulator', simulated: true });
    expect(live.message).toMatch(/Simulator \(no key\).*invalid/);
  });

  it('a network failure leaves the status unchanged; a 200 makes it ACTIVE and LlmService uses it', async () => {
    const conn = (await ctx.providers.list(ws.id)).data.find((c) => c.provider === 'anthropic')!;
    ctx.providers.fetchImpl = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as any;
    const net = await ctx.providers.verify(ws.id, ctx.principal, conn.id);
    expect(net.verification).toMatchObject({ result: 'error' });
    expect(net.connection.status).toBe('INVALID');

    ctx.providers.fetchImpl = fakeFetch(200, '{"data":[]}');
    const ok = await ctx.providers.verify(ws.id, ctx.principal, conn.id);
    expect(ok.connection.status).toBe('ACTIVE');
    expect(ok.connection.lastVerifiedAt).toBeTruthy();

    const r = await ctx.llm.resolve(ws.id, 'live');
    expect(r).toMatchObject({ simulated: false, source: 'workspace', model: 'claude-sonnet-5' });
    expect(r.provider.id).toBe('anthropic');
    const live = (await ctx.providers.status(ws.id)).capabilities.find((c) => c.key === 'live_llm')!;
    expect(live).toMatchObject({ source: 'workspace', provider: 'anthropic', connectionId: conn.id });
    // Other workspaces are unaffected.
    expect((await ctx.llm.resolve(other.id, 'live')).simulated).toBe(true);
    await expect(ctx.providers.get(other.id, conn.id)).rejects.toMatchObject({ status: 404 });
  });

  it('prevents duplicate connections, rotates and revokes (wiping the secret)', async () => {
    ctx.providers.fetchImpl = fakeFetch(200);
    await expect(ctx.providers.create(ws.id, ctx.principal, { provider: 'anthropic', secret: SECRET, config: {}, verify: false })).rejects.toMatchObject({ status: 409 });
    const conn = (await ctx.providers.list(ws.id)).data.find((c) => c.provider === 'anthropic')!;
    const rotated = await ctx.providers.rotate(ws.id, ctx.principal, conn.id, { secret: 'sk-ant-api03-NEW-FAKE-KEY-000000000-ABCD', verify: true });
    expect(rotated.connection.secretLast4).toBe('ABCD');
    const revoked = await ctx.providers.revoke(ws.id, ctx.principal, conn.id);
    expect(revoked).toMatchObject({ status: 'REVOKED' });
    const row = await ctx.prisma.providerConnection.findFirst({ where: { id: conn.id } });
    expect(row.encryptedSecret).toBe('revoked');
    expect(() => ctx.crypto.decrypt(row.encryptedSecret)).toThrow();
    expect((await ctx.llm.resolve(ws.id, 'live')).simulated).toBe(true);
    await expect(ctx.providers.verify(ws.id, ctx.principal, conn.id)).rejects.toMatchObject({ status: 410 });
  });

  it('stores OpenAI with multiple capabilities and Twilio as encrypted JSON exposed as sid:token', async () => {
    ctx.providers.fetchImpl = fakeFetch(200);
    const oa = await ctx.providers.create(ws.id, ctx.principal, { provider: 'openai', secret: 'sk-proj-FAKEFAKEFAKEFAKE1234', config: { realtimeModel: 'gpt-realtime', liveModel: 'gpt-4.1-mini' }, verify: true });
    expect(oa.connection).toMatchObject({ kind: 'LLM', capabilities: ['LLM', 'REALTIME', 'TTS', 'STT'], status: 'ACTIVE' });
    const st = await ctx.providers.status(ws.id);
    expect(st.capabilities.find((c) => c.key === 'realtime_voice')).toMatchObject({ source: 'workspace', provider: 'openai', model: 'gpt-realtime' });
    expect(st.capabilities.find((c) => c.key === 'server_tts')).toMatchObject({ source: 'workspace', provider: 'openai' });
    expect(st.capabilities.find((c) => c.key === 'telephony')).toMatchObject({ source: 'unavailable' });

    const sid = 'AC' + 'a'.repeat(32);
    const f = fakeFetch(200);
    ctx.providers.fetchImpl = f;
    const tw = await ctx.providers.create(ws.id, ctx.principal, { provider: 'twilio', secret: 'twilio-auth-token-0000-1111', config: { accountSid: sid }, verify: true });
    expect(f.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`);
    expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${sid}:twilio-auth-token-0000-1111`).toString('base64')}`);
    expect(tw.connection).toMatchObject({ kind: 'TELEPHONY', status: 'ACTIVE' });
    const row = await ctx.prisma.providerConnection.findFirst({ where: { id: tw.connection.id } });
    expect(JSON.parse(ctx.crypto.decrypt(row.encryptedSecret))).toEqual({ accountSid: sid, authToken: 'twilio-auth-token-0000-1111' });
    expect((await ctx.llm.providerSecret(ws.id, 'twilio'))?.secret).toBe(`${sid}:twilio-auth-token-0000-1111`);
    await expect(ctx.providers.create(other.id, ctx.principal, { provider: 'twilio', secret: 'tok-12345678', config: {}, verify: false })).rejects.toMatchObject({ status: 422 });
  });
});

d('CustomFunctionsService (integration)', () => {
  let ctx: Awaited<ReturnType<typeof createGTestContext>>;
  let ws: { id: string };
  let other: { id: string };
  let dir: string;
  let server: https.Server;
  let port: number;
  let ca: Buffer;
  let last: { body: string; headers: Record<string, any>; url: string } = { body: '', headers: {}, url: '' };

  const schema = {
    type: 'object',
    properties: { orderId: { type: 'string', pattern: '^[A-Z]{2}-\\d{4}$' }, verbose: { type: 'boolean' } },
    required: ['orderId'],
    additionalProperties: false,
  };

  beforeAll(async () => {
    ctx = await createGTestContext();
    ws = await ctx.workspace('Fn');
    other = await ctx.workspace('FnOther');
    dir = mkdtempSync(path.join(tmpdir(), 'cf-g-fn-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-subj', '/CN=orders.example.com', '-addext', 'subjectAltName=DNS:orders.example.com'], { stdio: 'ignore' });
    ca = readFileSync(path.join(dir, 'c.pem'));
    server = https.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: ca }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        last = { body, headers: req.headers, url: req.url ?? '' };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'shipped', eta: '2026-10-01' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    // Test resolver: orders.example.com → local TLS server (treated as public ONLY in this test).
    ctx.functions.guardDeps = { lookup: async () => [{ address: '127.0.0.1', family: 4 }], isBlockedIp: () => false, tls: { ca } };
  });
  afterAll(async () => {
    server?.closeAllConnections?.();
    await new Promise((r) => server?.close(r));
    rmSync(dir, { recursive: true, force: true });
    await ctx?.prisma.customFunction.deleteMany({ where: { workspaceId: { in: [ws?.id, other?.id] } } });
    await ctx?.prisma.workspace.deleteMany({ where: { id: { in: [ws?.id, other?.id] } } });
    await ctx?.prisma.$disconnect();
  });

  it('validates definitions (https only, JSON schema object, snake_case, reserved headers, host allowlist)', async () => {
    const base = { name: 'lookup_order', description: 'Look up an order', parametersSchema: schema, url: 'https://orders.example.com/lookup', method: 'POST' as const, timeoutMs: 5000, enabled: true };
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...base, url: 'http://orders.example.com/x' })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...base, url: 'https://169.254.169.254/x' })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...base, parametersSchema: { type: 'array' } })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...base, name: 'LookupOrder' })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...base, headers: { Host: 'evil' } })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...base, allowedHosts: ['other.example.com'] })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...base, allowedHosts: ['*.com'], url: 'https://orders.example.com/x' })).rejects.toMatchObject({ status: 422 });
  });

  it('masks headers, executes with HMAC signature, validates args, isolates workspaces and logs ToolEvents', async () => {
    const fn = await ctx.functions.create(ws.id, ctx.principal, {
      name: 'lookup_order',
      description: 'Look up an order',
      parametersSchema: schema,
      url: `https://orders.example.com:${port}/lookup`,
      method: 'POST',
      headers: { Authorization: 'Bearer super-secret-token' },
      timeoutMs: 5000,
      enabled: true,
    });
    expect(fn.headers).toEqual({ Authorization: '••••' });
    expect(fn.allowedHosts).toEqual(['orders.example.com']);
    const row = await ctx.prisma.customFunction.findFirst({ where: { id: fn.id } });
    expect(row.encryptedHeaders).not.toContain('super-secret-token');
    expect(JSON.stringify(await ctx.functions.list(ws.id))).not.toContain('super-secret-token');
    await expect(ctx.functions.create(ws.id, ctx.principal, { ...fn, parametersSchema: schema, method: 'POST', headers: {} } as any)).rejects.toMatchObject({ status: 409 });

    // Invalid args never leave the server.
    last.url = '';
    const bad = await ctx.functions.execute(ws.id, fn.id, { orderId: 'nope', extra: 1 });
    expect(bad).toMatchObject({ ok: false, errorCode: 'invalid_arguments' });
    expect(last.url).toBe('');

    const res = await ctx.functions.execute(ws.id, fn.id, { orderId: 'AB-1234' }, { sessionId: null });
    expect(res).toMatchObject({ ok: true, status: 200, result: { status: 'shipped', eta: '2026-10-01' }, functionName: 'lookup_order' });
    expect(last.headers.authorization).toBe('Bearer super-secret-token');
    const payload = JSON.parse(last.body);
    expect(payload).toMatchObject({ arguments: { orderId: 'AB-1234' }, context: { workspaceId: ws.id, sessionId: null, functionName: 'lookup_order' } });
    const sig = String(last.headers['x-conversaforge-signature']);
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig)!;
    expect(m).toBeTruthy();
    const { secret } = await ctx.functions.revealSigningSecret(ws.id, ctx.principal, fn.id);
    expect(createHmac('sha256', secret).update(`${m[1]}.${last.body}`).digest('hex')).toBe(m[2]);

    // Another workspace cannot execute or read it.
    expect(await ctx.functions.execute(other.id, fn.id, { orderId: 'AB-1234' })).toMatchObject({ ok: false, errorCode: 'not_found' });
    await expect(ctx.functions.get(other.id, fn.id)).rejects.toMatchObject({ status: 404 });

    // Header "••••" keeps the stored value on update; disabling blocks execution (test runs still allowed).
    await ctx.functions.update(ws.id, ctx.principal, fn.id, { headers: { Authorization: '••••', 'X-Extra': '1' }, enabled: false });
    expect(await ctx.functions.execute(ws.id, fn.id, { orderId: 'AB-1234' })).toMatchObject({ ok: false, errorCode: 'disabled' });
    const t = await ctx.functions.test(ws.id, ctx.principal, fn.id, { orderId: 'AB-1234' });
    expect(t.ok).toBe(true);
    expect(last.headers.authorization).toBe('Bearer super-secret-token');
    expect(last.headers['x-extra']).toBe('1');
    expect(JSON.parse(last.body).context.test).toBe(true);
    await ctx.functions.update(ws.id, ctx.principal, fn.id, { enabled: true });

    // ToolEvent logging (only with sessionId + toolCallId), idempotent.
    const scenario = await ctx.prisma.scenario.create({ data: { workspaceId: ws.id, slug: `fn-${fn.id}`, name: 'S', type: 'support' } });
    const version = await ctx.prisma.scenarioVersion.create({ data: { scenarioId: scenario.id, workspaceId: ws.id, version: 1, config: {}, configHash: 'h' } });
    const participant = await ctx.prisma.participant.create({ data: { workspaceId: ws.id, name: 'P' } });
    const session = await ctx.prisma.session.create({ data: { workspaceId: ws.id, scenarioId: scenario.id, scenarioVersionId: version.id, participantId: participant.id } });
    await ctx.functions.execute(ws.id, fn.id, { orderId: 'AB-1234' }, { sessionId: session.id, toolCallId: 'call_1' });
    await ctx.functions.execute(ws.id, fn.id, { orderId: 'AB-1234' }, { sessionId: session.id, toolCallId: 'call_1' });
    const events = await ctx.prisma.toolEvent.findMany({ where: { sessionId: session.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolId: 'fn:lookup_order', kind: 'RESULT', actor: 'SYSTEM' });
    // A session from another workspace is never written to.
    await ctx.functions.execute(other.id, fn.id, {}, { sessionId: session.id, toolCallId: 'call_2' });
    expect(await ctx.prisma.toolEvent.count({ where: { sessionId: session.id } })).toBe(1);

    // Delete frees the name.
    await ctx.functions.remove(ws.id, ctx.principal, fn.id);
    expect(await ctx.functions.execute(ws.id, fn.id, { orderId: 'AB-1234' })).toMatchObject({ ok: false, errorCode: 'not_found' });
    await ctx.prisma.session.delete({ where: { id: session.id } });
  }, 30_000);

  it('blocks execution when DNS resolves to a private address (default policy)', async () => {
    const fn = await ctx.functions.create(ws.id, ctx.principal, {
      name: 'internal_probe',
      description: 'x',
      parametersSchema: { type: 'object', properties: {} },
      url: 'https://orders.example.com/probe',
      method: 'GET',
      timeoutMs: 2000,
      enabled: true,
    });
    const saved = ctx.functions.guardDeps;
    ctx.functions.guardDeps = { lookup: async () => [{ address: '10.0.0.8', family: 4 }], isBlockedIp: (await import('./ssrf-guard')).isBlockedIp };
    try {
      expect(await ctx.functions.execute(ws.id, fn.id, {})).toMatchObject({ ok: false, errorCode: 'blocked_ip' });
    } finally {
      ctx.functions.guardDeps = saved;
    }
  });
});
