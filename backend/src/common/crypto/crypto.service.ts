import { Global, Injectable, Module } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    // Derive a 32-byte key deterministically from any sufficiently long passphrase.
    return createHash('sha256').update(trimmed).digest();
  }
  return buf;
}

/**
 * Secrets at rest: AES-256-GCM with a random 12-byte IV, format "v1:<iv>:<tag>:<ciphertext>" (base64url).
 * Tokens: random base64url; only SHA-256 hashes are stored for bearer credentials.
 */
@Injectable()
export class CryptoService {
  private readonly key = decodeKey(env.ENCRYPTION_KEY);
  private readonly signingKey = Buffer.from(env.SIGNING_SECRET, 'utf8');

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, ct] = payload.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  hmac(value: string, key: Buffer | string = this.signingKey): string {
    return createHmac('sha256', key).update(value).digest('base64url');
  }

  hmacHex(value: string, key: Buffer | string): string {
    return createHmac('sha256', key).update(value).digest('hex');
  }

  safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  /** Signed, expiring token for short-lived capabilities (media URLs, downloads). */
  signPayload(payload: Record<string, unknown>, ttlSeconds: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString(
      'base64url',
    );
    return `${body}.${this.hmac(body)}`;
  }

  verifyPayload<T = Record<string, unknown>>(token: string): (T & { exp: number }) | null {
    const [body, sig] = token.split('.');
    if (!body || !sig || !this.safeEqual(sig, this.hmac(body))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
      return data;
    } catch {
      return null;
    }
  }
}

@Global()
@Module({ providers: [CryptoService], exports: [CryptoService] })
export class CryptoModule {}
