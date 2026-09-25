process.env.DATABASE_URL ??= 'postgresql://x';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.SIGNING_SECRET ??= 'test-signing-secret-test-signing-secret';
import { clientIpFrom } from './client-ip';

const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as any;

describe('clientIpFrom (WebSocket rate-limit key)', () => {
  it('ignores X-Forwarded-For from an untrusted (public) peer', () => {
    expect(clientIpFrom(req('203.0.113.9', '1.2.3.4'))).toBe('203.0.113.9');
  });
  it('uses the nearest untrusted hop when the peer is a trusted proxy', () => {
    expect(clientIpFrom(req('127.0.0.1', '1.2.3.4'))).toBe('1.2.3.4');
    expect(clientIpFrom(req('::ffff:10.0.0.5', 'spoofed, 198.51.100.7, 10.0.0.2'))).toBe('198.51.100.7');
  });
  it('falls back to the peer when there is no header', () => {
    expect(clientIpFrom(req('::1'))).toBe('::1');
  });
});
