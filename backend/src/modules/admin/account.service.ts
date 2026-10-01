import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** The signed-in user's own login sessions (devices). */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listSessions(user: UserPrincipal) {
    const rows = await this.prisma.authSession.findMany({
      where: { userId: user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      take: 100,
    });
    return {
      data: rows.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.expiresAt,
        current: s.id === user.authSessionId,
      })),
    };
  }

  async revokeSession(user: UserPrincipal, id: string) {
    const res = await this.prisma.authSession.updateMany({ where: { id, userId: user.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!res.count) throw Errors.notFound('Session');
    await this.audit.log({ workspaceId: null, principal: user, action: 'user.session_revoked', targetType: 'auth_session', targetId: id });
    return { ok: true, current: id === user.authSessionId };
  }

  async revokeOthers(user: UserPrincipal) {
    const res = await this.prisma.authSession.updateMany({
      where: { userId: user.userId, revokedAt: null, id: { not: user.authSessionId } },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({ workspaceId: null, principal: user, action: 'user.sessions_revoked', targetType: 'user', targetId: user.userId, metadata: { count: res.count } });
    return { ok: true, revoked: res.count };
  }
}
