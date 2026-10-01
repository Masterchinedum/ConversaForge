import { Injectable } from '@nestjs/common';
import type { AuditLog, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PaginationQuery, prismaPageArgs, toPage } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toCsv } from './csv';

export const AuditQuery = PaginationQuery.extend({
  /** Prefix match on the action, e.g. "share_link." or "member". */
  action: z.string().trim().max(80).optional(),
  actorUserId: z.string().max(64).optional(),
  /** Free-text actor filter: email substring. */
  actor: z.string().trim().max(254).optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AUDIT_EXPORT_MAX_ROWS = 50_000;

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  private async where(workspaceId: string, q: Omit<AuditQuery, 'limit' | 'cursor'>): Promise<Prisma.AuditLogWhereInput> {
    let actorIds: string[] | undefined;
    if (q.actor) {
      const users = await this.prisma.user.findMany({ where: { email: { contains: q.actor.toLowerCase() } }, select: { id: true }, take: 100 });
      actorIds = users.map((u) => u.id);
    }
    return {
      workspaceId,
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : actorIds ? { actorUserId: { in: actorIds } } : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
  }

  private async withActors(rows: AuditLog[]) {
    const ids = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true } }) : [];
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.actorUserId);
      return {
        id: r.id,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: r.createdAt,
        actor: r.actorUserId
          ? { type: 'user' as const, id: r.actorUserId, email: u?.email ?? null, name: u?.name ?? null }
          : r.actorApiKeyId
            ? { type: 'api_key' as const, id: r.actorApiKeyId, email: null, name: null }
            : { type: 'system' as const, id: null, email: null, name: null },
      };
    });
  }

  async list(workspaceId: string, q: AuditQuery) {
    const rows = await this.prisma.auditLog.findMany({ where: await this.where(workspaceId, q), ...prismaPageArgs(q) });
    const page = toPage(rows, q.limit);
    return { data: await this.withActors(page.data), nextCursor: page.nextCursor };
  }

  async exportCsv(workspaceId: string, q: Omit<AuditQuery, 'limit' | 'cursor'>) {
    const rows = await this.prisma.auditLog.findMany({
      where: await this.where(workspaceId, q),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_EXPORT_MAX_ROWS,
    });
    const data = await this.withActors(rows);
    return toCsv(
      ['time', 'action', 'actor_type', 'actor_id', 'actor_email', 'target_type', 'target_id', 'ip', 'metadata'],
      data.map((r) => [r.createdAt, r.action, r.actor.type, r.actor.id, r.actor.email, r.targetType, r.targetId, r.ip, r.metadata]),
    );
  }
}
