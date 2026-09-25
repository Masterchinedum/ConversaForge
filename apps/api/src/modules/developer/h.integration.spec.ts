/**
 * Workstream H integration tests: API keys & scopes, tenant isolation, idempotency, pagination,
 * rate limits, webhook production/delivery/retries/auto-disable, and provider-missing channel paths.
 *
 * Runs the full AppModule over HTTP (Fastify inject) against a real Postgres database:
 *   H_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_test_h npx jest src/modules/developer/h.integration.spec.ts
 * The queue is replaced by a recorder (no jobs reach shared Redis queues).
 */
import { createHmac } from 'node:crypto';

const DB = process.env.H_TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB;
  // A public https API URL so meeting bots are not BLOCKED for reachability; Svix secret for Recall webhooks.
  process.env.API_PUBLIC_URL = 'https://api.h-test.example';
  process.env.RECALL_WEBHOOK_SECRET = `whsec_${Buffer.from('recall-h-test-secret-0123456789').toString('base64')}`;
}
const d = DB ? describe : describe.skip;

type Inject = (opts: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }) => Promise<{ statusCode: number; json: () => any; headers: Record<string, any>; body: string }>;

d('Developer platform, webhooks & channels (integration)', () => {
  let app: any;
  let inject: Inject;
  let prisma: any;
  let crypto: any;
  let redis: any;
  let dispatcher: any;
  let env: any;
  const enqueued: Array<{ queue: string; name: string; data: any; opts: any }> = [];

  const uniq = Date.now().toString(36);
  let userToken: string;
  let otherToken: string;
  let wsA: string;
  let wsB: string;
  let fullKey: string;
  let fullKeyId: string;
  let scenarioId: string;
  let scenarioB: string;

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const json = { 'content-type': 'application/json' };

  beforeAll(async () => {
    const { Test } = await import('@nestjs/testing');
    const { FastifyAdapter } = await import('@nestjs/platform-fastify');
    const { WsAdapter } = await import('@nestjs/platform-ws');
    env = (await import('../../config/env')).loadEnv();
    const { AppModule } = await import('../../app.module');
    const { QueueService } = await import('../../common/queue/queue.service');
    const { PrismaService } = await import('../../common/prisma/prisma.service');
    const { CryptoService } = await import('../../common/crypto/crypto.service');
    const { REDIS } = await import('../../common/redis/redis.module');
    const { WebhookDispatcherService } = await import('../webhooks/webhook-dispatcher.service');

    const noop = async () => undefined;
    const fakeQueueObj = new Proxy({ add: async () => ({}) } as any, { get: (t, k) => (k in t ? t[k] : noop) });
    const fakeQueue = {
      enqueue: async (queue: string, name: string, data: any, opts: any = {}) => {
        enqueued.push({ queue, name, data, opts });
        return { id: opts.jobId };
      },
      queue: () => fakeQueueObj,
      process: () => undefined,
      onModuleDestroy: noop,
    };
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(QueueService).useValue(fakeQueue).compile();
    app = mod.createNestApplication(new FastifyAdapter(), { rawBody: true, logger: ['error'] });
    app.setGlobalPrefix('api', { exclude: ['health'] });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const fastify = app.getHttpAdapter().getInstance();
    inject = (o) => fastify.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as any });
    prisma = app.get(PrismaService);
    crypto = app.get(CryptoService);
    redis = app.get(REDIS);
    dispatcher = app.get(WebhookDispatcherService);

    // Users + bearer auth sessions are created directly (the signup route needs the cookie plugin).
    const signup = async (name: string) => {
      const user = await prisma.user.create({ data: { email: `${name}-${uniq}@example.com`, name } });
      const token = crypto.randomToken(32);
      await prisma.authSession.create({ data: { userId: user.id, tokenHash: crypto.sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
      return token;
    };
    userToken = await signup('h-owner');
    otherToken = await signup('h-other');
    const mkWs = async (t: string, name: string) => {
      const r = await inject({ method: 'POST', url: '/api/workspaces', headers: { ...json, ...auth(t) }, payload: { name } });
      expect(r.statusCode).toBeLessThan(300);
      return r.json().id as string;
    };
    wsA = await mkWs(userToken, `H A ${uniq}`);
    wsB = await mkWs(otherToken, `H B ${uniq}`);
    const k = await createKey(userToken, wsA, ['scenarios:read', 'scenarios:write', 'sessions:read', 'sessions:write', 'analysis:read', 'org:read', 'webhooks:write', 'usage:read']);
    fullKey = k.secret;
    fullKeyId = k.id;
  }, 60_000);

  afterAll(async () => {
    if (prisma && wsA) {
      await prisma.webhookSubscription.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
      await prisma.outboxEvent.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
      await prisma.idempotencyRecord.deleteMany({ where: { scope: { in: [wsA, wsB] } } });
    }
    await app?.close();
  });

  async function createKey(token: string, ws: string, scopes: string[], extra: Record<string, unknown> = {}) {
    const r = await inject({ method: 'POST', url: `/api/workspaces/${ws}/api-keys`, headers: { ...json, ...auth(token) }, payload: { name: `k-${scopes.join('-')}`.slice(0, 100), scopes, ...extra } });
    if (r.statusCode !== 201) throw new Error(`createKey ${r.statusCode}: ${r.body}`);
    return r.json();
  }

  async function publishedScenario(key: string, idemKey?: string) {
    const c = await inject({
      method: 'POST',
      url: '/api/v1/scenarios',
      headers: { ...json, ...auth(key), ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
      payload: { source: 'template', templateKey: 'behavioral-interview' },
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().scenario.id;
    const rev = c.json().draft.revision;
    const p1 = await inject({
      method: 'PATCH',
      url: `/api/v1/scenarios/${id}/draft`,
      headers: { ...json, ...auth(key) },
      payload: { revision: rev, patch: [{ path: 'channels.phone.enabled', value: true }, { path: 'channels.meeting.enabled', value: true }] },
    });
    expect(p1.statusCode).toBe(200);
    const p = await inject({ method: 'POST', url: `/api/v1/scenarios/${id}/publish`, headers: { ...json, ...auth(key) }, payload: {} });
    expect(p.statusCode).toBe(200);
    return id as string;
  }

  // ───────────────────────── API keys & scopes ─────────────────────────

  it('creates keys with a one-time secret (only a hash + prefix stored) and lists them without secrets', async () => {
    expect(fullKey).toMatch(/^cf_live_[A-Za-z0-9_-]{40,}$/);
    const row = await prisma.apiKey.findUnique({ where: { id: fullKeyId } });
    expect(row.keyHash).toBe(crypto.sha256(fullKey));
    expect(row.prefix).toBe(fullKey.slice(0, 14));
    const list = await inject({ method: 'GET', url: `/api/workspaces/${wsA}/api-keys`, headers: auth(userToken) });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(fullKey);
    expect(list.body).not.toContain(row.keyHash);
    expect(list.json().data[0]).toMatchObject({ prefix: row.prefix, status: 'active', createdBy: { email: expect.stringContaining('h-owner') } });
    // Invalid scope is rejected; API keys cannot manage API keys.
    const bad = await inject({ method: 'POST', url: `/api/workspaces/${wsA}/api-keys`, headers: { ...json, ...auth(userToken) }, payload: { name: 'x', scopes: ['admin:*'] } });
    expect(bad.statusCode).toBe(422);
    const viaKey = await inject({ method: 'GET', url: `/api/workspaces/${wsA}/api-keys`, headers: auth(fullKey) });
    expect(viaKey.statusCode).toBe(403);
  });

  it('missing scope → 403; revoked or expired key → 401; user sessions are not accepted on v1', async () => {
    const orgOnly = await createKey(userToken, wsA, ['org:read']);
    const r1 = await inject({ method: 'GET', url: '/api/v1/scenarios', headers: auth(orgOnly.secret) });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error.code).toBe('forbidden');
    expect((await inject({ method: 'GET', url: '/api/v1/organization', headers: auth(orgOnly.secret) })).statusCode).toBe(200);

    const rev = await inject({ method: 'POST', url: `/api/workspaces/${wsA}/api-keys/${orgOnly.id}/revoke`, headers: { ...auth(userToken) } });
    expect(rev.json().status).toBe('revoked');
    expect((await inject({ method: 'GET', url: '/api/v1/organization', headers: auth(orgOnly.secret) })).statusCode).toBe(401);

    const exp = await createKey(userToken, wsA, ['org:read']);
    await prisma.apiKey.update({ where: { id: exp.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await inject({ method: 'GET', url: '/api/v1/organization', headers: auth(exp.secret) })).statusCode).toBe(401);

    const u = await inject({ method: 'GET', url: '/api/v1/organization', headers: auth(userToken) });
    expect(u.statusCode).toBe(401);
    expect(u.json().error.code).toBe('api_key_required');
    expect((await inject({ method: 'GET', url: '/api/v1/organization', headers: auth('cf_live_notarealkey') })).statusCode).toBe(401);
  });

  it('a key from workspace A cannot read workspace B resources', async () => {
    scenarioId = await publishedScenario(fullKey);
    const keyB = await createKey(otherToken, wsB, ['scenarios:read', 'scenarios:write', 'sessions:read', 'sessions:write', 'analysis:read']);
    scenarioB = await publishedScenario(keyB.secret);
    const sB = await inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...json, ...auth(keyB.secret) }, payload: { scenarioId: scenarioB, participant: { externalId: 'b-1' } } });
    expect(sB.statusCode).toBe(201);

    expect((await inject({ method: 'GET', url: `/api/v1/scenarios/${scenarioB}`, headers: auth(fullKey) })).statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: `/api/v1/sessions/${sB.json().sessionId}`, headers: auth(fullKey) })).statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: `/api/v1/sessions/${sB.json().sessionId}/transcript`, headers: auth(fullKey) })).statusCode).toBe(404);
    const createInB = await inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...json, ...auth(fullKey) }, payload: { scenarioId: scenarioB, participant: { externalId: 'x' } } });
    expect(createInB.statusCode).toBe(404);
    // Workspace-scoped routes with another workspace id → 404 (no probing).
    expect((await inject({ method: 'GET', url: `/api/workspaces/${wsB}`, headers: auth(fullKey) })).statusCode).toBe(404);
    const list = await inject({ method: 'GET', url: '/api/v1/scenarios', headers: auth(fullKey) });
    expect(list.json().data.map((s: any) => s.id)).not.toContain(scenarioB);
  });

  // ───────────────────────── REST v1 ─────────────────────────

  it('creates a session for a participant and returns a one-time /live URL; cancel works once', async () => {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { ...json, ...auth(fullKey) },
      payload: { scenarioId, participant: { externalId: 'crm-1', name: 'Pat', email: 'pat@example.com' }, variables: { role_title: 'Engineer' }, metadata: { crm: 'x' } },
    });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.url).toBe(`${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/live/${b.sessionId}#t=${b.sessionToken}`);
    const s = await prisma.session.findUnique({ where: { id: b.sessionId } });
    expect(s.channel).toBe('API');
    expect(s.resumeTokenHash).toBe(crypto.sha256(b.sessionToken));
    const g = await inject({ method: 'GET', url: `/api/v1/sessions/${b.sessionId}`, headers: auth(fullKey) });
    expect(g.json()).toMatchObject({ id: b.sessionId, channel: 'API', versionNumber: 1, participant: { externalId: 'crm-1' }, usage: { items: [] } });
    const filtered = await inject({ method: 'GET', url: '/api/v1/sessions?externalId=crm-1', headers: auth(fullKey) });
    expect(filtered.json().data.map((x: any) => x.id)).toEqual([b.sessionId]);
    const c = await inject({ method: 'POST', url: `/api/v1/sessions/${b.sessionId}/cancel`, headers: auth(fullKey) });
    expect(c.json().state).toBe('CANCELLED');
    const ev = await inject({ method: 'GET', url: `/api/v1/sessions/${b.sessionId}/evaluation`, headers: auth(fullKey) });
    expect(ev.statusCode).toBe(404);
  });

  it('cursor pagination returns disjoint pages', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...json, ...auth(fullKey) }, payload: { scenarioId, participant: { externalId: `page-${i}` } } });
      expect(r.statusCode).toBe(201);
    }
    const p1 = await inject({ method: 'GET', url: '/api/v1/sessions?limit=2', headers: auth(fullKey) });
    expect(p1.json().data).toHaveLength(2);
    expect(p1.json().nextCursor).toBeTruthy();
    const p2 = await inject({ method: 'GET', url: `/api/v1/sessions?limit=2&cursor=${p1.json().nextCursor}`, headers: auth(fullKey) });
    const ids1 = p1.json().data.map((x: any) => x.id);
    const ids2 = p2.json().data.map((x: any) => x.id);
    expect(ids2.length).toBeGreaterThan(0);
    expect(ids1.filter((x: string) => ids2.includes(x))).toEqual([]);
    // A cursor from another workspace is rejected.
    const foreign = await prisma.session.findFirst({ where: { workspaceId: wsB } });
    const bad = await inject({ method: 'GET', url: `/api/v1/sessions?cursor=${Buffer.from(foreign.id).toString('base64url')}`, headers: auth(fullKey) });
    expect(bad.statusCode).toBe(400);
  });

  it('Idempotency-Key: replay, mismatch (422), in-flight (409), per-workspace scope', async () => {
    const payload = { source: 'blank', name: `Idem ${uniq}` };
    const h = { ...json, ...auth(fullKey), 'idempotency-key': `idem-${uniq}` };
    const a = await inject({ method: 'POST', url: '/api/v1/scenarios', headers: h, payload });
    expect(a.statusCode).toBe(201);
    expect(a.headers['idempotency-replayed']).toBeUndefined();
    const b = await inject({ method: 'POST', url: '/api/v1/scenarios', headers: h, payload });
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotency-replayed']).toBe('true');
    expect(b.json().scenario.id).toBe(a.json().scenario.id);
    expect(await prisma.scenario.count({ where: { workspaceId: wsA, name: `Idem ${uniq}` } })).toBe(1);

    const c = await inject({ method: 'POST', url: '/api/v1/scenarios', headers: h, payload: { ...payload, name: 'different' } });
    expect(c.statusCode).toBe(422);
    expect(c.json().error.code).toBe('idempotency_key_reused');

    await prisma.idempotencyRecord.create({
      data: { scope: wsA, key: `busy-${uniq}`, method: 'POST', path: '/api/v1/scenarios', requestHash: 'x', expiresAt: new Date(Date.now() + 3600_000) },
    });
    // Same request hash as the in-flight one → 409.
    const { requestHash } = await import('./v1/idempotency.interceptor');
    const hash = requestHash(crypto, 'POST', '/api/v1/scenarios', payload);
    await prisma.idempotencyRecord.update({ where: { scope_key: { scope: wsA, key: `busy-${uniq}` } }, data: { requestHash: hash } });
    const d2 = await inject({ method: 'POST', url: '/api/v1/scenarios', headers: { ...h, 'idempotency-key': `busy-${uniq}` }, payload });
    expect(d2.statusCode).toBe(409);
    expect(d2.json().error.code).toBe('idempotency_request_in_progress');

    // Validation errors are replayed too (deterministic), 5xx would release the key.
    const e1 = await inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...json, ...auth(fullKey), 'idempotency-key': `err-${uniq}` }, payload: { scenarioId: 'nope', participant: { externalId: 'x' } } });
    const e2 = await inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...json, ...auth(fullKey), 'idempotency-key': `err-${uniq}` }, payload: { scenarioId: 'nope', participant: { externalId: 'x' } } });
    expect([e1.statusCode, e2.statusCode]).toEqual([404, 404]);
    expect(e2.headers['idempotency-replayed']).toBe('true');
  });

  it('per-key rate limit → 429 with Retry-After', async () => {
    const k = await createKey(userToken, wsA, ['org:read']);
    const bucket = Math.floor(Date.now() / 1000 / 60);
    await redis.set(`rl:v1:key:${k.id}:${bucket}`, String(env.API_KEY_RATE_LIMIT_PER_MIN), 'EX', 120);
    await redis.set(`rl:v1:key:${k.id}:${bucket + 1}`, String(env.API_KEY_RATE_LIMIT_PER_MIN), 'EX', 180);
    const r = await inject({ method: 'GET', url: '/api/v1/organization', headers: auth(k.secret) });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.headers['x-ratelimit-limit']).toBe(String(env.API_KEY_RATE_LIMIT_PER_MIN));
  });

  it('agent tool manifest only lists tools allowed by the key and calls them with the same scopes', async () => {
    const m = await inject({ method: 'GET', url: '/api/v1/agent/tools', headers: auth(fullKey) });
    expect(m.json().tools.map((t: any) => t.name).sort()).toEqual(['get_session_report', 'list_scenarios', 'list_sessions']);
    const call = await inject({ method: 'POST', url: '/api/v1/agent/call', headers: { ...json, ...auth(fullKey) }, payload: { tool: 'list_scenarios', arguments: { limit: 5 } } });
    expect(call.statusCode).toBe(200);
    expect(call.json().structuredContent.scenarios.map((s: any) => s.id)).toContain(scenarioId);
    const bad = await inject({ method: 'POST', url: '/api/v1/agent/call', headers: { ...json, ...auth(fullKey) }, payload: { tool: 'list_scenarios', arguments: { limit: 500 } } });
    expect(bad.statusCode).toBe(422);
    const scen = await createKey(userToken, wsA, ['scenarios:read']);
    const denied = await inject({ method: 'POST', url: '/api/v1/agent/call', headers: { ...json, ...auth(scen.secret) }, payload: { tool: 'get_session_report', arguments: { sessionId: 'x' } } });
    expect(denied.statusCode).toBe(403);
  });

  // ───────────────────────── webhooks ─────────────────────────

  it('webhooks: SSRF-checked create, one OutboxEvent per (session,type), signed delivery, retries, auto-disable', async () => {
    const blocked = await inject({ method: 'POST', url: '/api/v1/webhooks', headers: { ...json, ...auth(fullKey) }, payload: { url: 'https://10.0.0.7/hook', events: ['session.started'] } });
    expect(blocked.statusCode).toBe(422);
    const created = await inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: { ...json, ...auth(fullKey) },
      payload: { url: 'https://93.184.216.34/hook', events: ['session.started', 'session.completed'] },
    });
    expect(created.statusCode).toBe(201);
    const sub = created.json();
    expect(sub.secret).toMatch(/^whsec_/);
    const stored = await prisma.webhookSubscription.findUnique({ where: { id: sub.id } });
    expect(stored.encryptedSecret).not.toContain(sub.secret);
    expect((await inject({ method: 'GET', url: `/api/v1/webhooks/${sub.id}`, headers: auth(fullKey) })).body).not.toContain(sub.secret);

    const s = await inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...json, ...auth(fullKey) }, payload: { scenarioId, participant: { externalId: 'wh-1', email: 'wh@example.com' } } });
    const sessionId = s.json().sessionId;
    enqueued.length = 0;
    const id1 = await dispatcher.produce({ workspaceId: wsA, sessionId, type: 'session.started', variant: '' });
    const id2 = await dispatcher.produce({ workspaceId: wsA, sessionId, type: 'session.started', variant: '' });
    expect(id1).toBe(id2);
    expect(await prisma.outboxEvent.count({ where: { workspaceId: wsA, id: id1 } })).toBe(1);
    const deliveries = await prisma.webhookDelivery.findMany({ where: { subscriptionId: sub.id } });
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    expect(delivery.payload).toMatchObject({ id: id1, type: 'session.started', workspaceId: wsA, data: { session: { id: sessionId, channel: 'API', versionNumber: 1, participant: { externalId: 'wh-1' } } } });
    // Re-producing may re-enqueue, but always with the same deterministic job id (BullMQ dedupes).
    expect([...new Set(enqueued.filter((j) => j.name === 'deliver').map((j) => j.opts.jobId))]).toEqual([`wh_${delivery.id}_1`]);

    // Attempt 1 fails (HTTP 500) → RETRYING, next job in ~1 min with a deterministic id.
    const seen: any[] = [];
    dispatcher.sender = async (url: URL, body: string, headers: Record<string, string>) => {
      seen.push({ url: url.toString(), body, headers });
      return { statusCode: 500, error: null, responseSnippet: 'nope', durationMs: 3 };
    };
    enqueued.length = 0;
    const r1 = await dispatcher.deliverAttempt({ deliveryId: delivery.id, attempt: 1 });
    expect(r1.status).toBe('RETRYING');
    const h = seen[0].headers;
    expect(h['User-Agent']).toBe('ConversaForge-Webhooks/1.0');
    expect(h['X-ConversaForge-Event']).toBe('session.started');
    expect(h['X-ConversaForge-Delivery']).toBe(delivery.id);
    const { verifySignature } = await import('../webhooks/webhook-signature');
    expect(verifySignature(sub.secret, h['X-ConversaForge-Signature'], seen[0].body)).toBe(true);
    const [t, v1] = h['X-ConversaForge-Signature'].split(',');
    expect(v1.slice(3)).toBe(createHmac('sha256', sub.secret).update(`${t.slice(2)}.${seen[0].body}`).digest('hex'));
    const retry = enqueued.find((j) => j.name === 'deliver')!;
    expect(retry.opts.jobId).toBe(`wh_${delivery.id}_2`);
    expect(retry.opts.delay).toBeGreaterThanOrEqual(59_000);
    expect(retry.opts.delay).toBeLessThanOrEqual(66_500);
    // Re-running the same attempt is a no-op (idempotent claim).
    expect((await dispatcher.deliverAttempt({ deliveryId: delivery.id, attempt: 1 })).status).toBe('SKIPPED');

    // Attempts 2..8 fail → FAILED; with 4 prior failed deliveries the subscription is auto-disabled.
    await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { failureCount: env.WEBHOOK_DISABLE_AFTER_FAILURES - 1 } });
    for (let a = 2; a <= 8; a++) await dispatcher.deliverAttempt({ deliveryId: delivery.id, attempt: a });
    const failed = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id }, include: { attemptLog: true } });
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toBe(8);
    expect(failed.attemptLog.map((x: any) => x.statusCode)).toEqual(Array(8).fill(500));
    const disabled = await prisma.webhookSubscription.findUnique({ where: { id: sub.id } });
    expect(disabled.active).toBe(false);
    expect(disabled.disabledReason).toMatch(/consecutive failed deliveries/);
    const owner = await prisma.membership.findFirst({ where: { workspaceId: wsA, role: 'OWNER' } });
    expect(await prisma.notification.count({ where: { workspaceId: wsA, userId: owner.userId, type: 'webhook.disabled' } })).toBe(1);

    // Manual redeliver works on a disabled endpoint; success resets the failure counter.
    dispatcher.sender = async () => ({ statusCode: 204, error: null, responseSnippet: null, durationMs: 2 });
    const re = await inject({ method: 'POST', url: `/api/v1/webhooks/${sub.id}/deliveries/${delivery.id}/redeliver`, headers: auth(fullKey) });
    expect(re.json()).toMatchObject({ status: 'SUCCEEDED', attempt: 9 });
    expect((await prisma.webhookSubscription.findUnique({ where: { id: sub.id } })).failureCount).toBe(0);
    const log = await inject({ method: 'GET', url: `/api/v1/webhooks/${sub.id}/deliveries/${delivery.id}`, headers: auth(fullKey) });
    expect(log.json().attemptLog).toHaveLength(9);

    // Re-enable; SSRF is re-checked at delivery time (e.g. the stored URL now points inside).
    await inject({ method: 'PATCH', url: `/api/v1/webhooks/${sub.id}`, headers: { ...json, ...auth(fullKey) }, payload: { active: true } });
    await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { url: 'https://169.254.169.254/latest' } });
    let called = false;
    dispatcher.sender = async () => {
      called = true;
      return { statusCode: 200, error: null, responseSnippet: null, durationMs: 1 };
    };
    const ping = await inject({ method: 'POST', url: `/api/v1/webhooks/${sub.id}/test`, headers: auth(fullKey) });
    expect(ping.json().status).toBe('FAILED');
    expect(ping.json().error).toMatch(/^Blocked:/);
    expect(called).toBe(false);
  });

  it('session.completed only fans out to subscriptions for that event; CANCELLED produces no event', async () => {
    const sub = (
      await inject({ method: 'POST', url: '/api/v1/webhooks', headers: { ...json, ...auth(fullKey) }, payload: { url: 'https://93.184.216.34/other', events: ['session.analyzed'] } })
    ).json();
    const s = await inject({ method: 'POST', url: '/api/v1/sessions', headers: { ...json, ...auth(fullKey) }, payload: { scenarioId, participant: { externalId: 'wh-2' } } });
    await dispatcher.produce({ workspaceId: wsA, sessionId: s.json().sessionId, type: 'session.completed', variant: '' });
    expect(await prisma.webhookDelivery.count({ where: { subscriptionId: sub.id } })).toBe(0);
    const { terminalStateToEvent } = await import('../webhooks/webhook-payload');
    expect(terminalStateToEvent('CANCELLED')).toBeNull();
  });

  // ───────────────────────── channels: provider-missing paths ─────────────────────────

  it('phone/meeting channels report BLOCKED / provider_unavailable with exact reasons (never simulated)', async () => {
    const av = await inject({ method: 'GET', url: `/api/workspaces/${wsA}/channels/availability`, headers: auth(userToken) });
    expect(av.statusCode).toBe(200);
    const availability = av.json();
    const num = await inject({
      method: 'POST',
      url: `/api/workspaces/${wsA}/channels/phone-numbers`,
      headers: { ...json, ...auth(userToken) },
      payload: { e164: `+1415555${String(Date.now()).slice(-4)}`, inboundScenarioId: scenarioId },
    });
    expect(num.statusCode).toBe(201);
    const e164 = num.json().e164;

    if (!availability.twilio.configured) {
      expect(availability.twilio.reason).toMatch(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
      // Without credentials we cannot validate Twilio's signature → reject.
      const r = await inject({ method: 'POST', url: '/api/channels/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `To=${encodeURIComponent(e164)}&From=%2B14155550123&CallSid=CA1` });
      expect(r.statusCode).toBe(403);
      const call = await inject({ method: 'POST', url: `/api/workspaces/${wsA}/channels/calls`, headers: { ...json, ...auth(userToken) }, payload: { to: '+14155550123', scenarioId } });
      expect(call.statusCode).toBe(503);
      expect(call.json().error.code).toBe('provider_unavailable');
      const batch = await inject({ method: 'POST', url: `/api/workspaces/${wsA}/channels/batches`, headers: { ...json, ...auth(userToken) }, payload: { name: 'b', scenarioId } });
      expect(batch.json()).toMatchObject({ status: 'BLOCKED', statusReason: expect.stringMatching(/TWILIO_ACCOUNT_SID/) });
    }

    // With a workspace Twilio connection but no speech providers: a signed call is answered with a spoken
    // "not configured" message and the session is FAILED with provider_unavailable.
    const authToken = 'tw_test_token_h';
    await prisma.providerConnection.create({
      data: { workspaceId: wsA, provider: 'twilio', kind: 'TELEPHONY', encryptedSecret: crypto.encrypt(JSON.stringify({ accountSid: 'AC' + 'a'.repeat(32), authToken })), config: { accountSid: 'AC' + 'a'.repeat(32) } },
    });
    const params: Record<string, string> = { AccountSid: 'AC' + 'a'.repeat(32), CallSid: `CA${uniq}`, From: '+14155550123', To: e164 };
    const url = `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/channels/twilio/voice`;
    const { computeTwilioSignature } = await import('../channels/twilio/twilio-signature');
    const sig = computeTwilioSignature(authToken, url, params);
    const r = await inject({
      method: 'POST',
      url: '/api/channels/twilio/voice',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
      payload: new URLSearchParams(params).toString(),
    });
    const speech = (await inject({ method: 'GET', url: `/api/workspaces/${wsA}/channels/availability`, headers: auth(userToken) })).json();
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/xml/);
    if (!speech.phoneReady) {
      expect(r.body).toMatch(/<Say[^>]*>Sorry, this line is not configured\. Goodbye\.<\/Say><Hangup\/>/);
      const s = await prisma.session.findFirst({ where: { workspaceId: wsA, externalRef: `CA${uniq}` } });
      expect(s).toMatchObject({ channel: 'PHONE_INBOUND', state: 'FAILED', errorCode: 'provider_unavailable' });
    }
    const badSig = await inject({
      method: 'POST',
      url: '/api/channels/twilio/voice',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'AAAA' },
      payload: new URLSearchParams(params).toString(),
    });
    expect(badSig.statusCode).toBe(403);

    const bot = await inject({ method: 'POST', url: `/api/workspaces/${wsA}/channels/meeting-bots`, headers: { ...json, ...auth(userToken) }, payload: { scenarioId, meetingUrl: 'https://meet.google.com/abc-defg-hij' } });
    if (!availability.recall.configured) {
      expect(bot.json()).toMatchObject({ status: 'BLOCKED', lastError: expect.stringMatching(/RECALL_API_KEY/), sessionId: null });
    }
    // Recall webhook without a valid token/signature is rejected.
    const wh = await inject({ method: 'POST', url: `/api/channels/recall/webhook?bot=${bot.json().id}&token=bad`, headers: json, payload: { event: 'transcript.data' } });
    expect(wh.statusCode).toBe(401);

    // Members without channels.manage cannot use channel admin routes.
    expect((await inject({ method: 'GET', url: `/api/workspaces/${wsA}/channels/availability`, headers: auth(otherToken) })).statusCode).toBe(404);
  });
  it('meeting bots (Recall.ai, faked HTTP): create → realtime transcript → Svix status → COMPLETED session', async () => {
    const { MeetingsService } = await import('../channels/meetings.service');
    const meetings = app.get(MeetingsService);
    await prisma.providerConnection.create({
      data: { workspaceId: wsA, provider: 'recall', kind: 'MEETING', encryptedSecret: crypto.encrypt('recall_test_key'), config: { region: 'eu-central-1' } },
    });
    const calls: Array<{ url: string; init: any }> = [];
    meetings.fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (init.method === 'POST') return new Response(JSON.stringify({ id: 'bot_abc123' }), { status: 201 });
      return new Response(JSON.stringify({ id: 'bot_abc123', status_changes: [{ code: 'joining_call' }, { code: 'in_call_recording' }] }), { status: 200 });
    }) as any;
    const r = await inject({
      method: 'POST',
      url: `/api/workspaces/${wsA}/channels/meeting-bots`,
      headers: { ...json, ...auth(userToken) },
      payload: { scenarioId, meetingUrl: 'https://us02web.zoom.us/j/1234567890', evaluatedSpeakerName: 'Dana' },
    });
    expect(r.statusCode).toBe(201);
    const bot = r.json();
    expect(bot).toMatchObject({ status: 'JOINING', providerBotId: 'bot_abc123', platform: 'zoom' });
    const req = calls[0]!;
    expect(req.url).toBe('https://eu-central-1.recall.ai/api/v1/bot/');
    expect(req.init.headers.Authorization).toBe('Token recall_test_key');
    const sent = JSON.parse(req.init.body);
    expect(sent).toMatchObject({ meeting_url: 'https://us02web.zoom.us/j/1234567890', recording_config: { transcript: { provider: { recallai_streaming: expect.any(Object) } } } });
    const endpoint = new URL(sent.recording_config.realtime_endpoints[0].url);
    expect(sent.recording_config.realtime_endpoints[0].events).toEqual(['transcript.data']);
    expect(endpoint.origin + endpoint.pathname).toBe('https://api.h-test.example/api/channels/recall/webhook');
    const session = await prisma.session.findUnique({ where: { id: bot.sessionId } });
    expect(session).toMatchObject({ channel: 'MEETING', externalRef: 'bot_abc123', state: 'READY' });

    const utter = (speaker: string, text: string, t: number) => ({
      event: 'transcript.data',
      data: {
        data: { words: [{ text, start_timestamp: { relative: t }, end_timestamp: { relative: t + 2 } }], participant: { id: speaker === 'Dana' ? 1 : 2, name: speaker } },
        bot: { id: 'bot_abc123', metadata: {} },
      },
    });
    const url = `/api/channels/recall/webhook${endpoint.search}`;
    expect((await inject({ method: 'POST', url, headers: json, payload: utter('Dana', 'Thanks for joining, what is your budget?', 1) })).statusCode).toBe(200);
    expect((await inject({ method: 'POST', url, headers: json, payload: utter('Lee', 'Around fifty thousand.', 4) })).statusCode).toBe(200);
    expect((await inject({ method: 'POST', url, headers: json, payload: utter('Lee', 'Around fifty thousand.', 4) })).statusCode).toBe(200); // duplicate
    const turns = await prisma.transcriptTurn.findMany({ where: { sessionId: bot.sessionId }, orderBy: { seq: 'asc' } });
    expect(turns.map((t: any) => [t.seq, t.speaker, t.text])).toEqual([
      [1, 'PARTICIPANT', 'Thanks for joining, what is your budget?'],
      [2, 'AGENT', 'Around fifty thousand.'],
    ]);
    expect((await prisma.session.findUnique({ where: { id: bot.sessionId } })).state).toBe('ACTIVE');

    // Status webhook signed with the Svix scheme (workspace verification secret).
    const body = JSON.stringify({ event: 'bot.done', data: { data: { code: 'done' }, bot: { id: 'bot_abc123', metadata: { conversaforge_bot_id: bot.id } } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(process.env.RECALL_WEBHOOK_SECRET!.slice(6), 'base64');
    const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
    const unsigned = await inject({ method: 'POST', url: '/api/channels/recall/webhook', headers: json, payload: body });
    expect(unsigned.statusCode).toBe(401);
    const done = await inject({ method: 'POST', url: '/api/channels/recall/webhook', headers: { ...json, 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, payload: body });
    expect(done.statusCode).toBe(200);
    const finished = await prisma.session.findUnique({ where: { id: bot.sessionId } });
    expect(finished.state).toBe('COMPLETED');
    expect(finished.endedAt).toBeTruthy();
    expect((await prisma.meetingBot.findUnique({ where: { id: bot.id } })).status).toBe('COMPLETED');
    // Late utterances after completion are ignored.
    await inject({ method: 'POST', url, headers: json, payload: utter('Dana', 'late', 99) });
    expect(await prisma.transcriptTurn.count({ where: { sessionId: bot.sessionId } })).toBe(2);
  });
  it('batch scheduler dials with the concurrency limit and completes from call outcomes', async () => {
    const { BatchesService } = await import('../channels/batches.service');
    const batches = app.get(BatchesService);
    // Speech providers present (fake keys; nothing is called in this test) → phone channel "ready".
    for (const provider of ['deepgram', 'elevenlabs']) {
      await prisma.providerConnection.create({ data: { workspaceId: wsA, provider, kind: provider === 'deepgram' ? 'STT' : 'TTS', encryptedSecret: crypto.encrypt(`fake-${provider}`) } });
    }
    const b = (await inject({ method: 'POST', url: `/api/workspaces/${wsA}/channels/batches`, headers: { ...json, ...auth(userToken) }, payload: { name: 'Batch', scenarioId, concurrency: 2 } })).json();
    expect(b.status).toBe('DRAFT');
    const up = await inject({
      method: 'POST',
      url: `/api/workspaces/${wsA}/channels/batches/${b.id}/targets`,
      headers: { ...json, ...auth(userToken) },
      payload: { csv: 'phone,name,role_title\n+14155550201,A,Eng\n+14155550202,B,PM\n+14155550203,C,\nnot-a-phone,D,' },
    });
    expect(up.json()).toMatchObject({ added: 3, errorCount: 1 });
    enqueued.length = 0;
    const started = await inject({ method: 'POST', url: `/api/workspaces/${wsA}/channels/batches/${b.id}/start`, headers: { ...json, ...auth(userToken) }, payload: {} });
    expect(started.json()).toMatchObject({ status: 'RUNNING' });
    expect(enqueued.some((j) => j.name === 'batch_tick' && j.data.batchId === b.id)).toBe(true);

    const dialed: any[] = [];
    let n = 0;
    const dial = async (_ws: string, input: any, ctx: any) => {
      dialed.push({ input, ctx });
      const s = await prisma.session.create({
        data: {
          workspaceId: wsA,
          scenarioId,
          scenarioVersionId: (await prisma.scenario.findUnique({ where: { id: scenarioId } })).latestVersionId,
          participantId: (await prisma.participant.create({ data: { workspaceId: wsA, externalId: `batch-${uniq}-${n}` } })).id,
          channel: 'PHONE_OUTBOUND',
          metadata: { twilio: { batchId: ctx.batchId, targetId: ctx.targetId } },
        },
      });
      return { sessionId: s.id, callSid: `CAbatch${n++}`, status: 'queued' };
    };
    expect(await batches.tick(b.id, dial)).toMatchObject({ dialed: 2, status: 'RUNNING' });
    expect(dialed.map((d) => d.input.to)).toEqual(['+14155550201', '+14155550202']);
    expect(dialed[0].input.variables).toEqual({ role_title: 'Eng' });
    // Concurrency respected: nothing more while two are in flight.
    expect((await batches.tick(b.id, dial)).dialed).toBe(0);
    const t1 = await prisma.outboundCallTarget.findFirst({ where: { batchId: b.id, phone: '+14155550201' } });
    const s1 = await prisma.session.findUnique({ where: { id: t1.sessionId } });
    await batches.onCallOutcome({ sessionId: s1.id, callSid: 'CAbatch0', callStatus: 'no-answer', durationSec: null, connected: false }, s1);
    expect((await prisma.outboundCallTarget.findUnique({ where: { id: t1.id } })).status).toBe('NO_ANSWER');
    expect((await batches.tick(b.id, dial)).dialed).toBe(1);
    for (const t of await prisma.outboundCallTarget.findMany({ where: { batchId: b.id, status: 'DIALING' } })) {
      const s = await prisma.session.findUnique({ where: { id: t.sessionId } });
      await batches.onCallOutcome({ sessionId: s.id, callSid: t.callSid, callStatus: 'completed', durationSec: 42, connected: true }, s);
    }
    expect(await batches.tick(b.id, dial)).toMatchObject({ status: 'COMPLETED' });
    const final = (await inject({ method: 'GET', url: `/api/workspaces/${wsA}/channels/batches/${b.id}`, headers: auth(userToken) })).json();
    expect(final).toMatchObject({ status: 'COMPLETED', progress: { total: 3, COMPLETED: 2, NO_ANSWER: 1 } });
  });
});
