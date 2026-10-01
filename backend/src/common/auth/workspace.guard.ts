import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Capability } from '@cf/shared';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../http/errors';
import { PrismaService } from '../prisma/prisma.service';
import { API_SCOPES, CAPABILITY } from './decorators';

/**
 * Global guard #2: for every route that has a `:workspaceId` param, the principal must be a member
 * of that workspace (or an API key issued for it, carrying a scope listed via @ApiScopes).
 * Sets req.workspace = { workspaceId, role }. Services must still filter every query by workspaceId.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const workspaceId = (req.params as Record<string, string> | undefined)?.workspaceId;
    const capability =
      this.reflector.getAllAndOverride<Capability>(CAPABILITY, [ctx.getHandler(), ctx.getClass()]) ?? null;
    const scopes = this.reflector.getAllAndOverride<string[]>(API_SCOPES, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const p = req.principal;

    if (p?.kind === 'apiKey') {
      if (!scopes.length || !scopes.some((s) => p.scopes.includes(s))) {
        throw Errors.forbidden(`API key lacks the required scope (${scopes.join(' or ') || 'not available via API'})`);
      }
      if (workspaceId && workspaceId !== p.workspaceId) throw Errors.notFound('Workspace');
      req.workspace = { workspaceId: p.workspaceId, role: 'ADMIN', membershipId: null };
      return true;
    }

    if (!workspaceId) {
      if (capability) throw Errors.forbidden('Capability check requires a workspace');
      return true;
    }
    if (!p) throw Errors.unauthorized();

    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: p.userId } },
      include: { workspace: { select: { deletedAt: true } } },
    });
    if (!membership || membership.workspace.deletedAt) {
      // 404 rather than 403 so workspace ids cannot be probed.
      throw Errors.notFound('Workspace');
    }
    const role = membership.role;
    if (!can(role, capability ?? 'scenarios.run')) throw Errors.forbidden();
    req.workspace = { workspaceId, role, membershipId: membership.id };
    return true;
  }
}
