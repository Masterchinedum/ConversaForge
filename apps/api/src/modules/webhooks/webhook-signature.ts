import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ConversaForge webhook signatures.
 *
 *   X-ConversaForge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=<…>]
 *
 * More than one v1 value is sent while a rotated secret is still in its overlap window; a receiver
 * accepts the request if ANY v1 value matches its secret.
 */
export const SIGNATURE_HEADER = 'X-ConversaForge-Signature';
export const DEFAULT_TOLERANCE_SEC = 300;

export function computeSignature(secret: string, timestamp: number, rawBody: string | Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

/** Build the header value for one or more secrets (current first). */
export function signatureHeader(secrets: string[], rawBody: string | Buffer, timestamp = Math.floor(Date.now() / 1000)): string {
  if (!secrets.length) throw new Error('At least one secret is required');
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${computeSignature(s, timestamp, rawBody)}`)].join(',');
}

export function parseSignatureHeader(header: string): { timestamp: number | null; signatures: string[] } {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase());
  }
  return { timestamp, signatures };
}

/**
 * Verify a webhook signature. Returns true only when the timestamp is within `toleranceSec` of now
 * (replay protection) and at least one v1 signature matches (constant-time comparison).
 * `body` must be the exact raw request body (do not re-serialize parsed JSON).
 */
export function verifySignature(
  secret: string,
  header: string | null | undefined,
  body: string | Buffer,
  toleranceSec = DEFAULT_TOLERANCE_SEC,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !header) return false;
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (timestamp === null || !signatures.length) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(computeSignature(secret, timestamp, body), 'hex');
  return signatures.some((sig) => {
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
