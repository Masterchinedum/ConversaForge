import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export const WorkspaceSettingsSchema = z.object({
  maxSessionMinutes: z.number().int().min(1).max(240).optional(),
  defaultRetentionDays: z.number().int().min(1).max(3650).optional(),
  allowPublicScenarios: z.boolean().optional(),
  allowSimulator: z.boolean().optional(),
  analyticsVisibleToMembers: z.boolean().optional(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  private async uniqueSlug(base: string) {
    const root = slugify(base);
    for (let i = 0; i < 5; i++) {
      const slug = i === 0 ? root : `${root}-${this.crypto.randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (!(await this.prisma.workspace.findUnique({ where: { slug } }))) return slug;
    }
    return `${root}-${Date.now().toString(36)}`;
  }

  async createPersonal(userId: string, displayName: string) {
    const slug = await this.uniqueSlug(`${displayName}-personal`);
    return this.prisma.workspace.create({
      data: {
        name: `${displayName}'s workspace`,
        slug,
        kind: 'PERSONAL',
        createdById: userId,
        memberships: { create: { userId, role: 'OWNER' } },
      },
    });
  }

  async createOrganization(principal: Extract<Principal, { kind: 'user' }>, name: string) {
    const slug = await this.uniqueSlug(name);
    const ws = await this.prisma.workspace.create({
      data: {
        name,
        slug,
        kind: 'ORGANIZATION',
        createdById: principal.userId,
        memberships: { create: { userId: principal.userId, role: 'OWNER' } },
      },
    });
    await this.audit.log({ workspaceId: ws.id, principal, action: 'workspace.created', targetType: 'workspace', targetId: ws.id });
    return ws;
  }

  async get(workspaceId: string) {
    const ws = await this.prisma.workspace.findFirstOrThrow({
      where: { id: workspaceId, deletedAt: null },
      include: { branding: true, _count: { select: { memberships: true, scenarios: true } } },
    });
    return ws;
  }

  async update(workspaceId: string, principal: Principal, data: { name?: string; settings?: WorkspaceSettings }) {
    const current = await this.prisma.workspace.findFirstOrThrow({ where: { id: workspaceId, deletedAt: null } });
    const settings = data.settings
      ? ({ ...((current.settings as object) ?? {}), ...data.settings } as Prisma.InputJsonValue)
      : undefined;
    const ws = await this.prisma.workspace.update({ where: { id: workspaceId }, data: { name: data.name, settings } });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'workspace.updated',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { name: data.name, settings: data.settings },
    });
    return ws;
  }

  async settings(workspaceId: string): Promise<WorkspaceSettings> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
    return (ws?.settings as WorkspaceSettings) ?? {};
  }
}
