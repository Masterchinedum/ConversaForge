import { computeSignature, parseSignatureHeader, signatureHeader, verifySignature } from './webhook-signature';
import { assertSafeUrl, assertUrlShape, isPrivateAddress, SsrfError } from './ssrf-guard';
import { decideAfterAttempt, MAX_ATTEMPTS, nextRetryDelayMs, RETRY_DELAYS_MS } from './webhook-retry';
import { outboxEventId, terminalStateToEvent } from './webhook-payload';

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'session.completed', data: { a: 1 } });

  it('generates t=…,v1=<hex HMAC-SHA256(secret, "t.body")> and verifies it', () => {
    const t = 1_790_000_000;
    const header = signatureHeader([secret], body, t);
    expect(header).toBe(`t=${t},v1=${computeSignature(secret, t, body)}`);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, header, body, 300, t + 10)).toBe(true);
  });

  it('matches an independent HMAC computation (receiver example)', () => {
    const t = 1_790_000_123;
    const expected = require('node:crypto').createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(computeSignature(secret, t, body)).toBe(expected);
  });

  it('rejects a tampered body, wrong secret, missing header', () => {
    const t = 1_790_000_000;
    const header = signatureHeader([secret], body, t);
    expect(verifySignature(secret, header, body + ' ', 300, t)).toBe(false);
    expect(verifySignature('whsec_other', header, body, 300, t)).toBe(false);
    expect(verifySignature(secret, undefined, body, 300, t)).toBe(false);
    expect(verifySignature(secret, 'garbage', body, 300, t)).toBe(false);
  });

  it('enforces the timestamp tolerance (replay protection) in both directions', () => {
    const t = 1_790_000_000;
    const header = signatureHeader([secret], body, t);
    expect(verifySignature(secret, header, body, 300, t + 300)).toBe(true);
    expect(verifySignature(secret, header, body, 300, t + 301)).toBe(false);
    expect(verifySignature(secret, header, body, 300, t - 301)).toBe(false);
    expect(verifySignature(secret, header, body, 10, t + 11)).toBe(false);
  });

  it('accepts any of several v1 signatures (secret rotation overlap)', () => {
    const t = 1_790_000_000;
    const header = signatureHeader(['whsec_new', 'whsec_old'], body, t);
    expect(parseSignatureHeader(header).signatures).toHaveLength(2);
    expect(verifySignature('whsec_new', header, body, 300, t)).toBe(true);
    expect(verifySignature('whsec_old', header, body, 300, t)).toBe(true);
    expect(verifySignature('whsec_x', header, body, 300, t)).toBe(false);
  });

  it('works on Buffers (raw body)', () => {
    const t = 1_790_000_000;
    const header = signatureHeader([secret], Buffer.from(body), t);
    expect(verifySignature(secret, header, Buffer.from(body), 300, t)).toBe(true);
  });
});

describe('SSRF guard', () => {
  const prod = { allowDevLocalhost: false };
  const dev = { allowDevLocalhost: true };

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2001:db8::1',
    'ff02::1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it('requires https in production and blocks internal hosts / literals / credentials', () => {
    expect(() => assertUrlShape('http://example.com/hook', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('http://localhost:4188/hook', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('https://localhost/hook', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('https://169.254.169.254/latest/meta-data', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('https://[::1]/x', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('https://metadata.google.internal/x', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('https://printer.local/x', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('https://intranet/x', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('https://user:pw@example.com/x', prod)).toThrow(SsrfError);
    expect(() => assertUrlShape('ftp://example.com/x', prod)).toThrow(SsrfError);
    expect(assertUrlShape('https://hooks.example.com/cf', prod).hostname).toBe('hooks.example.com');
  });

  it('allows http://localhost only in development', () => {
    expect(assertUrlShape('http://localhost:4188/hook', dev).port).toBe('4188');
    expect(assertUrlShape('http://127.0.0.1:4188/hook', dev).hostname).toBe('127.0.0.1');
    expect(() => assertUrlShape('http://example.com/hook', dev)).toThrow(/only allowed for localhost/);
    expect(() => assertUrlShape('http://10.0.0.5/hook', dev)).toThrow(SsrfError);
  });

  it('resolves DNS and rejects hosts that resolve to private addresses (incl. mixed answers)', async () => {
    const resolver = (answers: string[]) => async () => answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    await expect(assertSafeUrl('https://ok.example.com/x', prod, resolver(['93.184.216.34']))).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('https://evil.example.com/x', prod, resolver(['127.0.0.1']))).rejects.toThrow(/non-public/);
    await expect(assertSafeUrl('https://evil.example.com/x', prod, resolver(['93.184.216.34', '10.0.0.1']))).rejects.toThrow(/non-public/);
    await expect(assertSafeUrl('https://evil.example.com/x', prod, resolver(['::ffff:169.254.169.254']))).rejects.toThrow(/non-public/);
    await expect(
      assertSafeUrl('https://nx.example.com/x', prod, async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/Could not resolve/);
  });
});

describe('retry scheduling + auto-disable', () => {
  it('uses 1m, 5m, 30m, 2h, 6h, 12h, 12h and stops after 8 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(8);
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(5 * 60_000);
    expect(nextRetryDelayMs(3)).toBe(30 * 60_000);
    expect(nextRetryDelayMs(4)).toBe(2 * 3600_000);
    expect(nextRetryDelayMs(5)).toBe(6 * 3600_000);
    expect(nextRetryDelayMs(6)).toBe(12 * 3600_000);
    expect(nextRetryDelayMs(7)).toBe(12 * 3600_000);
    expect(nextRetryDelayMs(8)).toBeNull();
    expect(RETRY_DELAYS_MS).toHaveLength(MAX_ATTEMPTS - 1);
    // jitter adds at most +10 %
    expect(nextRetryDelayMs(1, 0.999)!).toBeLessThanOrEqual(66_000);
  });

  it('transitions RETRYING → FAILED and disables after N consecutive failed deliveries', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const fail = { ok: false as const, statusCode: 500, error: 'HTTP 500' };
    const r1 = decideAfterAttempt({ attempt: 1, manual: false, outcome: fail, failureCount: 0, disableAfter: 3, now });
    expect(r1.status).toBe('RETRYING');
    expect(r1.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
    expect(r1.failureCount).toBe(0);

    const last = decideAfterAttempt({ attempt: MAX_ATTEMPTS, manual: false, outcome: fail, failureCount: 1, disableAfter: 3, now });
    expect(last).toEqual({ status: 'FAILED', nextAttemptAt: null, failureCount: 2, disable: false });
    const disable = decideAfterAttempt({ attempt: MAX_ATTEMPTS, manual: false, outcome: fail, failureCount: 2, disableAfter: 3, now });
    expect(disable.disable).toBe(true);

    const ok = decideAfterAttempt({ attempt: 3, manual: false, outcome: { ok: true, statusCode: 204 }, failureCount: 2, disableAfter: 3, now });
    expect(ok).toEqual({ status: 'SUCCEEDED', nextAttemptAt: null, failureCount: 0, disable: false });
  });

  it('manual attempts never retry and never count towards auto-disable', () => {
    const d = decideAfterAttempt({ attempt: 9, manual: true, outcome: { ok: false, statusCode: null, error: 'ECONNREFUSED' }, failureCount: 4, disableAfter: 5 });
    expect(d).toEqual({ status: 'FAILED', nextAttemptAt: null, failureCount: 4, disable: false });
  });
});

describe('event mapping', () => {
  it('maps terminal states (ABANDONED → session.completed; CANCELLED/EXPIRED → none)', () => {
    expect(terminalStateToEvent('COMPLETED')?.type).toBe('session.completed');
    expect(terminalStateToEvent('ABANDONED')?.type).toBe('session.completed');
    expect(terminalStateToEvent('FAILED')?.type).toBe('session.failed');
    expect(terminalStateToEvent('CANCELLED')).toBeNull();
    expect(terminalStateToEvent('EXPIRED')).toBeNull();
  });
  it('event ids are deterministic per (workspace, session, type, variant)', () => {
    expect(outboxEventId('w', 's', 'session.started')).toBe(outboxEventId('w', 's', 'session.started'));
    expect(outboxEventId('w', 's', 'session.started')).not.toBe(outboxEventId('w2', 's', 'session.started'));
    expect(outboxEventId('w', 's', 'session.failed', 'session')).not.toBe(outboxEventId('w', 's', 'session.failed', 'analysis'));
    expect(outboxEventId('w', 's', 'session.started')).toMatch(/^evt_[0-9a-f]{24}$/);
  });
});
