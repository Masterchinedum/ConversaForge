import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { env } from '../../config/env';
import { CryptoService } from '../crypto/crypto.service';

/**
 * Object storage abstraction. Keys are ALWAYS prefixed with `ws/<workspaceId>/` so tenant data is
 * separated in the bucket/filesystem, and every read goes through a short-lived signed URL that the
 * API only issues after an authorization check.
 */
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** A URL the browser can fetch directly (S3 presigned) or null to use the API's signed proxy route. */
  presignGet?(key: string, ttlSeconds: number, fileName?: string, mimeType?: string): Promise<string>;
}

class LocalDriver implements StorageDriver {
  constructor(private readonly root: string) {}
  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
  async put(key: string, body: Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  async get(key: string) {
    return fs.readFile(this.resolve(key));
  }
  async stream(key: string) {
    const full = this.resolve(key);
    await fs.access(full);
    return createReadStream(full);
  }
  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
  async exists(key: string) {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

class S3Driver implements StorageDriver {
  private readonly client: S3Client;
  constructor(private readonly bucket: string) {
    this.client = new S3Client({
      region: env.S3_REGION ?? 'auto',
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }),
    );
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async stream(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async exists(key: string) {
    try {
      await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-0' }));
      return true;
    } catch {
      return false;
    }
  }
  async presignGet(key: string, ttlSeconds: number, fileName?: string, mimeType?: string) {
    const serve = safeServeType(mimeType);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: serve.contentType,
        ResponseContentDisposition: contentDispositionHeader(serve.disposition, fileName),
      }),
      { expiresIn: ttlSeconds },
    );
  }
}

/** Types a browser may render inline from our origin without executing script. */
const INLINE_SAFE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'video/webm',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

/**
 * How to serve a stored object: inline only for passive media/document types; anything else (HTML, SVG,
 * XML, JS, unknown…) is forced to a download as application/octet-stream so an uploaded file can never
 * run script on our origin (stored XSS). Text types are pinned to UTF-8 plain text.
 */
export function safeServeType(mimeType: string | null | undefined): { contentType: string; disposition: 'inline' | 'attachment' } {
  const base = String(mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!INLINE_SAFE_TYPES.has(base)) return { contentType: 'application/octet-stream', disposition: 'attachment' };
  if (base.startsWith('text/')) return { contentType: 'text/plain; charset=utf-8', disposition: 'inline' };
  return { contentType: base, disposition: 'inline' };
}

export function contentDispositionHeader(kind: 'inline' | 'attachment', fileName?: string | null): string {
  const ascii = String(fileName ?? '').replace(/[^\w.\- ]/g, '_').slice(0, 150);
  return ascii ? `${kind}; filename="${ascii}"` : kind;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger('Storage');
  readonly driver: StorageDriver;

  constructor(private readonly crypto: CryptoService) {
    if (env.STORAGE_DRIVER === 's3') {
      if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
      this.driver = new S3Driver(env.S3_BUCKET);
    } else {
      this.driver = new LocalDriver(path.resolve(env.STORAGE_LOCAL_DIR));
    }
    this.logger.log(`Using ${env.STORAGE_DRIVER} storage`);
  }

  /** Build a tenant-scoped key. `parts` must not contain user-controlled path separators. */
  key(workspaceId: string, ...parts: string[]): string {
    const safe = parts.map((p) => p.replace(/[^a-zA-Z0-9._-]/g, '_'));
    return ['ws', workspaceId, ...safe].join('/');
  }

  assertWorkspaceKey(workspaceId: string, key: string) {
    if (!key.startsWith(`ws/${workspaceId}/`)) throw new Error('Storage key does not belong to workspace');
  }

  put(key: string, body: Buffer, contentType: string) {
    return this.driver.put(key, body, contentType);
  }
  get(key: string) {
    return this.driver.get(key);
  }
  stream(key: string) {
    return this.driver.stream(key);
  }
  delete(key: string) {
    return this.driver.delete(key);
  }

  /**
   * Signed URL for a media asset. Callers MUST have authorized access to the asset first.
   * S3: presigned object URL. Local: API route /api/media/signed/<token> verified by HMAC.
   */
  async signedUrl(asset: { id: string; storageKey: string; workspaceId: string; fileName?: string | null; mimeType?: string | null }, ttlSeconds = 900) {
    this.assertWorkspaceKey(asset.workspaceId, asset.storageKey);
    if (this.driver.presignGet) return this.driver.presignGet(asset.storageKey, ttlSeconds, asset.fileName ?? undefined, asset.mimeType ?? undefined);
    const token = this.crypto.signPayload({ a: asset.id, k: asset.storageKey, w: asset.workspaceId }, ttlSeconds);
    return `${env.API_PUBLIC_URL}/api/media/signed/${token}`;
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
