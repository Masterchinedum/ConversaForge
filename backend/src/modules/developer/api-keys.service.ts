import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { API_KEY_SCOPES } from '@cf/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import { API_KEY_PREFIX } from '../../common/auth/auth.guard';
import { userIdOf, type Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { prismaPageArgs, toPage, type PaginationQuery } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';

export const MAX_API_KEYS_PER_WORKSPACE = 50;
/** Characters of the secret kept in clear for display ("cf_live_" + 6). */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 14;

export const CreateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1, 'Select at least one scope')
      .transform((a) => Array.from(new Set(a))),
    /** ISO date-time in the future, or omit for a non-expiring key. */
    expiresAt: z.coerce
      .date()
      .optional()
      .nullable()
      .refine((d) => !d || d.getTime() > Date.now() + 60_000, 'Expiry must be in the future')
      .refine((d) => !d || d.getTime() < Date.now() + 5 * 365 * 24 * 3600_000, 'Expiry must be within 5 years'),
  })
  .strict();
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

export const ListApiKeysQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
  includeRevoked: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
});

/** Workspace API keys: `cf_live_<random>`; only sha256(secret) and a short display prefix are stored. */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, q: PaginationQuery & { includeRevoked?: boolean }) {
    const rows = await this.prisma.apiKey.findMany({
      where: { workspaceId, ...(q.includeRevoked === false ? { revokedAt: null } : {}) },
      ...prismaPageArgs(q),
    });
    const page = toPage(rows, q.limit);
    const creatorIds = Array.from(new Set(page.data.map((k) => k.createdById).filter((x): x is string => !!x)));
    const creators = creatorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, email: true, name: true } })
      : [];
    return {
      data: page.data.map((k) => this.serialize(k, creators.find((c) => c.id === k.createdById) ?? null)),
      nextCursor: page.nextCursor,
    };
  }

  serialize(
    k: { id: string; name: string; prefix: string; scopes: string[]; createdById: string | null; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date },
    creator: { id: string; email: string; name: string | null } | null = null,
  ) {
    const now = new Date();
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdBy: creator ? { id: creator.id, email: creator.email, name: creator.name } : k.createdById ? { id: k.createdById, email: null, name: null } : null,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      status: k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt <= now ? 'expired' : 'active',
      createdAt: k.createdAt,
    };
  }

  async create(workspaceId: string, principal: Principal, input: CreateApiKeyInput) {
    const active = await this.prisma.apiKey.count({ where: { workspaceId, revokedAt: null } });
    if (active >= MAX_API_KEYS_PER_WORKSPACE) throw Errors.conflict(`A workspace can have at most ${MAX_API_KEYS_PER_WORKSPACE} active API keys`);
    for (let i = 0; i < 3; i++) {
      const secret = API_KEY_PREFIX + this.crypto.randomToken(32);
      try {
        const k = await this.prisma.apiKey.create({
          data: {
            workspaceId,
            name: input.name,
            prefix: secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
            keyHash: this.crypto.sha256(secret),
            scopes: input.scopes,
            createdById: userIdOf(principal),
            expiresAt: input.expiresAt ?? null,
          },
        });
        await this.audit.log({
          workspaceId,
          principal,
          action: 'apikey.created',
          targetType: 'ApiKey',
          targetId: k.id,
          metadata: { name: k.name, prefix: k.prefix, scopes: k.scopes, expiresAt: k.expiresAt },
        });
        const creator = principal.kind === 'user' ? { id: principal.userId, email: principal.email, name: principal.name } : null;
        // The secret is returned exactly once and never stored.
        return { ...this.serialize(k, creator), secret };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // prefix collision → new secret
        throw e;
      }
    }
    throw Errors.conflict('Could not generate a unique key, please retry');
  }

  async revoke(workspaceId: string, principal: Principal, id: string) {
    const k = await this.prisma.apiKey.findFirst({ where: { id, workspaceId } });
    if (!k) throw Errors.notFound('API key');
    if (k.revokedAt) return this.serialize(k);
    const updated = await this.prisma.apiKey.update({ where: { id: k.id }, data: { revokedAt: new Date() } });
    await this.audit.log({ workspaceId, principal, action: 'apikey.revoked', targetType: 'ApiKey', targetId: k.id, metadata: { name: k.name, prefix: k.prefix } });
    return this.serialize(updated);
  }
}
