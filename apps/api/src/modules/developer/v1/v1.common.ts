import { applyDecorators, CanActivate, Controller, ExecutionContext, Injectable, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env';
import { AppError, Errors } from '../../../common/http/errors';
import { RateLimitService } from '../../../common/rate-limit/rate-limit.service';
import type { Principal } from '../../../common/auth/principal';
import { IdempotencyInterceptor } from './idempotency.interceptor';

export type ApiKeyPrincipal = Extract<Principal, { kind: 'apiKey' }>;

/**
 * /api/v1 access: API keys only (cookie sessions are rejected, so browser CSRF is irrelevant here),
 * per-key fixed-window rate limit with standard headers and 429 + Retry-After.
 * Scope checks happen in the global WorkspaceGuard via @ApiScopes on every handler.
 */
@Injectable()
export class ApiKeyV1Guard implements CanActivate {
  constructor(private readonly rateLimit: RateLimitService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const reply = ctx.switchToHttp().getResponse<FastifyReply>();
    const p = req.principal;
    if (!p || p.kind !== 'apiKey') {
      throw new AppError(401, 'api_key_required', 'The v1 API requires an API key: Authorization: Bearer cf_live_…');
    }
    if (!req.workspace || req.workspace.workspaceId !== p.workspaceId) throw Errors.forbidden('API key workspace mismatch');
    const limit = env.API_KEY_RATE_LIMIT_PER_MIN;
    const r = await this.rateLimit.hit(`v1:key:${p.apiKeyId}`, limit, 60);
    reply.header('X-RateLimit-Limit', String(limit));
    reply.header('X-RateLimit-Remaining', String(r.remaining));
    reply.header('X-RateLimit-Reset', String(r.resetIn));
    if (!r.allowed) {
      reply.header('Retry-After', String(r.resetIn));
      throw Errors.tooMany(`Rate limit of ${limit} requests per minute exceeded for this API key`, { retryAfterSeconds: r.resetIn });
    }
    return true;
  }
}

/** Class decorator for every v1 controller. */
export function V1Controller(path: string, tag: string) {
  return applyDecorators(
    Controller(`v1/${path}`.replace(/\/$/, '')),
    ApiTags(`v1 ${tag}`),
    ApiBearerAuth(),
    ApiHeader({ name: 'Idempotency-Key', required: false, description: 'POST only: replay-safe retries for 24 h' }),
    UseGuards(ApiKeyV1Guard),
    UseInterceptors(IdempotencyInterceptor),
  );
}

export function apiKeyOf(req: FastifyRequest): ApiKeyPrincipal {
  const p = req.principal;
  if (!p || p.kind !== 'apiKey') throw new AppError(401, 'api_key_required', 'API key required');
  return p;
}

export const V1Page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const IsoDate = z.coerce.date();

/** Convert BigInt fields (e.g. costMicros) to numbers for JSON. */
export function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}
