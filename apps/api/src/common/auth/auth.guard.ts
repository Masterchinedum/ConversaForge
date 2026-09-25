import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Errors } from '../http/errors';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC } from './decorators';
import type { Principal } from './principal';

export const SESSION_COOKIE = 'cf_session';
export const API_KEY_PREFIX = 'cf_live_';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard #1: resolves the principal from the session cookie or `Authorization: Bearer cf_live_…`.
 * Cookie-authenticated state-changing requests must come from an allowed Origin (CSRF defense;
 * cookies are also SameSite=Lax).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);

    req.principal = await this.resolve(req);

    if (req.principal?.kind === 'user' && !SAFE_METHODS.has(req.method)) this.checkOrigin(req);
    if (!isPublic && !req.principal) throw Errors.unauthorized();
    return true;
  }

  private async resolve(req: FastifyRequest): Promise<Principal | null> {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (token.startsWith(API_KEY_PREFIX)) return this.resolveApiKey(token);
      // Participant session tokens (cfs_…) and embed tokens (cfe_…) are verified by the runtime/access
      // modules on their own routes; they never grant a user principal.
      if (token.startsWith('cfs_') || token.startsWith('cfe_')) return null;
      // Bearer session tokens are accepted for non-browser clients (e.g. CLI tests).
      return this.resolveSession(token);
    }
    const cookie = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (cookie) return this.resolveSession(cookie);
    return null;
  }

  private async resolveSession(token: string): Promise<Principal | null> {
    const s = await this.prisma.authSession.findUnique({
      where: { tokenHash: this.crypto.sha256(token) },
      include: { user: true },
    });
    if (!s || s.revokedAt || s.expiresAt < new Date() || s.user.deletedAt) return null;
    // Touch at most once per 5 minutes.
    if (Date.now() - s.lastUsedAt.getTime() > 5 * 60_000) {
      void this.prisma.authSession.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return {
      kind: 'user',
      userId: s.userId,
      email: s.user.email,
      name: s.user.name,
      authSessionId: s.id,
      isSuperAdmin: s.user.isSuperAdmin,
      emailVerified: !!s.user.emailVerifiedAt,
    };
  }

  private async resolveApiKey(token: string): Promise<Principal | null> {
    const k = await this.prisma.apiKey.findUnique({ where: { keyHash: this.crypto.sha256(token) } });
    if (!k || k.revokedAt || (k.expiresAt && k.expiresAt < new Date())) return null;
    if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60_000) {
      void this.prisma.apiKey.update({ where: { id: k.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return { kind: 'apiKey', apiKeyId: k.id, workspaceId: k.workspaceId, scopes: k.scopes };
  }

  private checkOrigin(req: FastifyRequest) {
    const origin = (req.headers.origin as string | undefined) ?? refererOrigin(req.headers.referer as string | undefined);
    if (!origin) return; // non-browser client (no Origin header); cookies are SameSite=Lax anyway
    const allowed = new Set([
      new URL(env.WEB_PUBLIC_URL).origin,
      new URL(env.API_PUBLIC_URL).origin,
      ...env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    ]);
    if (!allowed.has(origin)) throw Errors.forbidden('Cross-origin request blocked');
  }
}

function refererOrigin(ref?: string): string | undefined {
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}
