import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { stableStringify } from '@cf/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, lastValueFrom, Observable } from 'rxjs';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { AppError } from '../../../common/http/errors';
import { PrismaService } from '../../../common/prisma/prisma.service';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
/** An in-flight record older than this is considered abandoned (process crashed) and may be taken over. */
export const IDEMPOTENCY_STALE_LOCK_MS = 5 * 60_000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Error statuses whose outcome is deterministic and therefore replayed; others release the key. */
const REPLAYABLE_ERROR_STATUSES = new Set([400, 403, 404, 410, 422]);

export class IdempotencyErrors {
  static reused() {
    return new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request (method, path or body)');
  }
  static inFlight() {
    return new AppError(409, 'idempotency_request_in_progress', 'A request with this Idempotency-Key is still being processed; retry later');
  }
  static invalid() {
    return new AppError(400, 'bad_request', 'Idempotency-Key must be 1-255 printable ASCII characters');
  }
}

export function requestHash(crypto: { sha256(v: string): string }, method: string, url: string, body: unknown): string {
  return crypto.sha256(`${method.toUpperCase()} ${url}\n${stableStringify(body ?? null)}`);
}

/**
 * `Idempotency-Key` support for POST requests (scope = the API key's workspace):
 *   - first request: the key is claimed (in-flight record), the handler runs, the response is stored for 24 h
 *   - same key + same request → stored response replayed with `Idempotency-Replayed: true`
 *   - same key + different request → 422 idempotency_key_reused
 *   - same key while the first request is still running → 409 idempotency_request_in_progress
 *   - 5xx / transient errors release the key so the client can retry
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const reply = ctx.switchToHttp().getResponse<FastifyReply>();
    const rawKey = req.headers[IDEMPOTENCY_HEADER];
    if (req.method !== 'POST' || rawKey === undefined) return next.handle();
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || !KEY_RE.test(key)) throw IdempotencyErrors.invalid();
    const scope = req.workspace?.workspaceId;
    if (!scope) return next.handle();
    const hash = requestHash(this.crypto, req.method, req.url, req.body);
    const successStatus = (Reflect.getMetadata(HTTP_CODE_METADATA, ctx.getHandler()) as number | undefined) ?? 201;

    return from(this.run(scope, key, req, reply, hash, successStatus, next));
  }

  private async run(
    scope: string,
    key: string,
    req: FastifyRequest,
    reply: FastifyReply,
    hash: string,
    successStatus: number,
    next: CallHandler,
  ): Promise<unknown> {
    const claimed = await this.claim(scope, key, req, hash);
    if (claimed.kind === 'replay') {
      reply.header('Idempotency-Replayed', 'true');
      const { status, body } = claimed;
      if (status >= 400) {
        const err = (body as any)?.error ?? {};
        throw new AppError(status, err.code ?? 'error', err.message ?? 'Request failed', err.details);
      }
      return body;
    }

    const recordId = claimed.id;
    try {
      const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
      const stored = result === undefined ? null : JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
      await this.prisma.idempotencyRecord.update({
        where: { id: recordId },
        data: { responseStatus: successStatus, responseBody: stored === null ? Prisma.JsonNull : (stored as Prisma.InputJsonValue) },
      });
      return result;
    } catch (err) {
      if (err instanceof AppError && REPLAYABLE_ERROR_STATUSES.has(err.getStatus())) {
        await this.prisma.idempotencyRecord
          .update({
            where: { id: recordId },
            data: {
              responseStatus: err.getStatus(),
              responseBody: { error: { code: err.code, message: err.message, details: (err.details ?? null) as Prisma.InputJsonValue } },
            },
          })
          .catch(() => undefined);
      } else {
        await this.prisma.idempotencyRecord.delete({ where: { id: recordId } }).catch(() => undefined);
      }
      throw err;
    }
  }

  private async claim(
    scope: string,
    key: string,
    req: FastifyRequest,
    hash: string,
  ): Promise<{ kind: 'claimed'; id: string } | { kind: 'replay'; status: number; body: unknown }> {
    if (Math.random() < 0.02) {
      // Opportunistic cleanup of expired records for this workspace.
      await this.prisma.idempotencyRecord.deleteMany({ where: { scope, expiresAt: { lt: new Date() } } }).catch(() => undefined);
    }
    for (let i = 0; i < 2; i++) {
      try {
        const rec = await this.prisma.idempotencyRecord.create({
          data: {
            scope,
            key,
            method: req.method,
            path: req.url.slice(0, 1000),
            requestHash: hash,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          },
        });
        return { kind: 'claimed', id: rec.id };
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
      const existing = await this.prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
      if (!existing) continue; // released concurrently → retry claim
      const now = Date.now();
      if (existing.expiresAt.getTime() <= now) {
        await this.prisma.idempotencyRecord.deleteMany({ where: { id: existing.id, expiresAt: { lte: new Date(now) } } });
        continue;
      }
      if (existing.requestHash !== hash) throw IdempotencyErrors.reused();
      if (existing.responseStatus === null) {
        if (now - existing.createdAt.getTime() > IDEMPOTENCY_STALE_LOCK_MS) {
          await this.prisma.idempotencyRecord.deleteMany({ where: { id: existing.id, responseStatus: null } });
          continue;
        }
        throw IdempotencyErrors.inFlight();
      }
      return { kind: 'replay', status: existing.responseStatus, body: existing.responseBody };
    }
    throw IdempotencyErrors.inFlight();
  }
}

