import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { validateArgs, validateParametersSchema } from './json-schema';
import { guardedRequest, hostAllowed, isBlockedIp, SsrfError, validateOutboundUrl, type GuardDeps } from './ssrf-guard';

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::abcd',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
    '2002:c0a8:0101::1', // 6to4 of 192.168.1.1
    'ff02::1',
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );

  it('rejects http, credentials, private IP literals and internal names at config time', () => {
    expect(() => validateOutboundUrl('http://api.example.com/x')).toThrow(/https/);
    expect(() => validateOutboundUrl('https://user:pw@api.example.com/x')).toThrow(/Credentials/);
    expect(() => validateOutboundUrl('https://169.254.169.254/latest/meta-data')).toThrow(SsrfError);
    expect(() => validateOutboundUrl('https://[::1]/')).toThrow(SsrfError);
    expect(() => validateOutboundUrl('https://localhost/')).toThrow(SsrfError);
    expect(() => validateOutboundUrl('https://db.internal/')).toThrow(SsrfError);
    expect(() => validateOutboundUrl('file:///etc/passwd')).toThrow(SsrfError);
    expect(validateOutboundUrl('https://api.example.com/v1/lookup?x=1').hostname).toBe('api.example.com');
  });

  it('matches allowed hosts exactly or by *.suffix', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('API.example.com.', ['api.example.com'])).toBe(true);
    expect(hostAllowed('evil-api.example.com', ['api.example.com'])).toBe(false);
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.io', ['*.example.com'])).toBe(false);
  });

  it('refuses hosts outside the allowlist before any DNS lookup', async () => {
    const lookup = jest.fn();
    await expect(
      guardedRequest({ url: 'https://other.example.com/x', method: 'POST', allowedHosts: ['api.example.com'], timeoutMs: 1000 }, { lookup, isBlockedIp }),
    ).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks names that resolve to private addresses (incl. when only one of many is private)', async () => {
    const deps: GuardDeps = {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      isBlockedIp,
    };
    await expect(
      guardedRequest({ url: 'https://api.example.com/x', method: 'POST', allowedHosts: ['api.example.com'], timeoutMs: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'blocked_ip' });
    await expect(
      guardedRequest(
        { url: 'https://api.example.com/x', method: 'GET', allowedHosts: ['api.example.com'], timeoutMs: 1000 },
        { lookup: async () => [{ address: '::ffff:169.254.169.254', family: 6 }], isBlockedIp },
      ),
    ).rejects.toMatchObject({ code: 'blocked_ip' });
  });

  it('rejects plain http even if the host is allowed', async () => {
    await expect(
      guardedRequest({ url: 'http://api.example.com/x', method: 'POST', allowedHosts: ['api.example.com'], timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'protocol' });
  });

  describe('against a local TLS server', () => {
    let dir: string;
    let server: https.Server;
    let port: number;
    let ca: Buffer;
    let lastBody = '';
    let lastHeaders: Record<string, unknown> = {};

    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'cf-g-tls-'));
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        '-subj', '/CN=fn.example.com', '-addext', 'subjectAltName=DNS:fn.example.com',
      ], { stdio: 'ignore' });
      ca = readFileSync(path.join(dir, 'cert.pem'));
      server = https.createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert: ca }, (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          lastBody = body;
          lastHeaders = req.headers;
          if (req.url?.startsWith('/redirect')) {
            res.writeHead(302, { location: 'https://169.254.169.254/' }).end();
          } else if (req.url?.startsWith('/big')) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('x'.repeat(100 * 1024));
          } else if (req.url?.startsWith('/slow')) {
            setTimeout(() => res.writeHead(200).end('{}'), 700).unref();
          } else {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, echo: body.length }));
          }
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    });

    // The test "public" resolver maps fn.example.com to loopback and treats it as public ONLY here.
    const deps = (): GuardDeps => ({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], isBlockedIp: () => false, tls: { ca } });

    it('performs a pinned request and returns the body', async () => {
      const res = await guardedRequest(
        { url: `https://fn.example.com:${port}/ok`, method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' }, allowedHosts: ['fn.example.com'], timeoutMs: 3000 },
        deps(),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body.toString())).toEqual({ ok: true, echo: 7 });
      expect(lastBody).toBe('{"a":1}');
      expect(lastHeaders.host).toBe(`fn.example.com:${port}`);
    });

    it('does not follow redirects', async () => {
      await expect(
        guardedRequest({ url: `https://fn.example.com:${port}/redirect`, method: 'GET', allowedHosts: ['fn.example.com'], timeoutMs: 3000 }, deps()),
      ).rejects.toMatchObject({ code: 'redirect' });
    });

    it('caps the response size', async () => {
      await expect(
        guardedRequest({ url: `https://fn.example.com:${port}/big`, method: 'GET', allowedHosts: ['fn.example.com'], timeoutMs: 3000, maxResponseBytes: 64 * 1024 }, deps()),
      ).rejects.toMatchObject({ code: 'too_large' });
    });

    it('times out slow endpoints', async () => {
      await expect(
        guardedRequest({ url: `https://fn.example.com:${port}/slow`, method: 'GET', allowedHosts: ['fn.example.com'], timeoutMs: 300 }, deps()),
      ).rejects.toMatchObject({ code: 'timeout' });
    });

    it('with the default IP policy, a loopback resolution is blocked', async () => {
      await expect(
        guardedRequest(
          { url: `https://fn.example.com:${port}/ok`, method: 'GET', allowedHosts: ['fn.example.com'], timeoutMs: 3000 },
          { ...deps(), isBlockedIp },
        ),
      ).rejects.toMatchObject({ code: 'blocked_ip' });
    });
  });
});

describe('parameters schema + argument validation', () => {
  const schema = {
    type: 'object',
    properties: {
      orderId: { type: 'string', pattern: '^[A-Z]{2}-\\d{4}$', description: 'Order id' },
      quantity: { type: 'integer', minimum: 1, maximum: 10 },
      priority: { type: 'string', enum: ['low', 'high'] },
      tags: { type: 'array', items: { type: 'string', maxLength: 10 }, maxItems: 3, uniqueItems: true },
    },
    required: ['orderId'],
    additionalProperties: false,
  };

  it('accepts a well-formed schema', () => expect(validateParametersSchema(schema)).toEqual([]));

  it('rejects non-object roots, unsupported keywords, bad required and ReDoS patterns', () => {
    expect(validateParametersSchema({ type: 'string' })[0]!.message).toMatch(/type": "object"/);
    expect(validateParametersSchema([])).toHaveLength(1);
    expect(validateParametersSchema({ type: 'object', $ref: '#/x' }).some((i) => /Unsupported/.test(i.message))).toBe(true);
    expect(validateParametersSchema({ type: 'object', properties: {}, required: ['missing'] })).toHaveLength(1);
    expect(validateParametersSchema({ type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } })).toHaveLength(1);
    expect(validateParametersSchema({ type: 'object', properties: { a: { type: 'strin' } } })).toHaveLength(1);
    const deep: any = { type: 'object' };
    let cur = deep;
    for (let i = 0; i < 12; i++) {
      cur.properties = { n: { type: 'object' } };
      cur = cur.properties.n;
    }
    expect(validateParametersSchema(deep).some((i) => /deeply/.test(i.message))).toBe(true);
    expect(validateParametersSchema({ type: 'object', description: 'x'.repeat(20_000) }).some((i) => /too large/.test(i.message))).toBe(true);
  });

  it('validates arguments', () => {
    expect(validateArgs(schema, { orderId: 'AB-1234', quantity: 2, priority: 'low', tags: ['a', 'b'] })).toEqual([]);
    const issues = validateArgs(schema, { orderId: 'nope', quantity: 2.5, priority: 'urgent', extra: true, tags: ['a', 'a'] });
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['orderId', 'quantity', 'priority', 'extra', 'tags']));
    expect(validateArgs(schema, {}).map((i) => i.path)).toEqual(['orderId']);
    expect(validateArgs(schema, 'string' as unknown)).toHaveLength(1);
    expect(validateArgs(schema, { orderId: 'AB-1234', tags: ['x'.repeat(20_000)] })[0]!.message).toMatch(/too large/);
  });
});

describe('provider verification', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verifyCredential, verifyRequest } = require('./provider-verify') as typeof import('./provider-verify');
  const fetchReturning = (status: number, body: string) => (async () => ({ status, text: async () => body })) as any;

  it('builds the documented verification requests', () => {
    expect(verifyRequest('openai', 'k', {})!.url).toBe('https://api.openai.com/v1/models');
    expect(verifyRequest('deepgram', 'k', {})!.headers.authorization).toBe('Token k');
    expect(verifyRequest('elevenlabs', 'k', {})!.headers['xi-api-key']).toBe('k');
    expect(verifyRequest('recall', 'k', { region: 'eu-central-1' })!.url).toBe('https://eu-central-1.recall.ai/api/v1/bot/?limit=1');
    expect(verifyRequest('google_calendar', 'k', {})).toBeNull();
  });

  it('maps provider rejections to invalid, proxies/network failures to error, and redacts echoed keys', async () => {
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz';
    const inv = await verifyCredential('openai', key, {}, fetchReturning(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${key}` } })));
    expect(inv.result).toBe('invalid');
    expect(inv.message).not.toContain(key);
    expect((await verifyCredential('deepgram', 'k'.repeat(10), {}, fetchReturning(403, '{"err_msg":"Insufficient permissions"}'))).result).toBe('invalid');
    expect((await verifyCredential('openai', key, {}, fetchReturning(403, 'Forbidden by proxy'))).result).toBe('error');
    expect((await verifyCredential('openai', key, {}, fetchReturning(200, '{"data":[]}'))).result).toBe('valid');
    expect((await verifyCredential('openai', key, {}, fetchReturning(500, ''))).result).toBe('error');
    const hang = (async (_u: string, init: { signal: AbortSignal }) =>
      new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
    expect(await verifyCredential('openai', key, {}, hang, 50)).toMatchObject({ result: 'error', message: expect.stringMatching(/did not respond/) });
    expect((await verifyCredential('twilio', 'tok', {}, fetchReturning(200, '{}'))).result).toBe('invalid');
  });
});
