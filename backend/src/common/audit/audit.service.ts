import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { actorFields, type Principal } from '../auth/principal';

/** Append-only audit trail for sensitive changes (roles, access, publishing, keys, deletions, exports). */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: {
    workspaceId: string | null;
    principal: Principal | null | undefined;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
    ip?: string;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: entry.workspaceId,
          ...actorFields(entry.principal),
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
          ip: entry.ip,
        },
      });
    } catch (e: any) {
      // Never fail the user action because the audit write failed, but make it loud.
      this.logger.error(`Audit write failed for ${entry.action}: ${e?.message}`);
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
