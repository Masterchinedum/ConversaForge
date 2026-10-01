import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { UPLOAD_LIMITS } from '@cf/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppError, Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';

const Hex = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex color like #4f46e5')
  .transform((v) => v.toLowerCase());

export const UpdateBrandingBody = z
  .object({
    displayName: z.string().trim().max(80).nullable().optional(),
    primaryColor: Hex.nullable().optional(),
    accentColor: Hex.nullable().optional(),
    supportEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
    emailFooter: z.string().trim().max(1000).nullable().optional(),
    hidePoweredBy: z.boolean().optional(),
  })
  .strict();
export type UpdateBrandingBody = z.infer<typeof UpdateBrandingBody>;

/** Only raster formats: SVG can carry script, so it is rejected rather than sanitized. */
const LOGO_TYPES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  const t = LOGO_TYPES.find((x) => x.test(buf));
  return t ? { mime: t.mime, ext: t.ext } : null;
}

export interface PublicBranding {
  workspaceName: string;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  supportEmail: string | null;
  hidePoweredBy: boolean;
}

@Injectable()
export class BrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  private logoUrl(workspaceId: string, assetId: string) {
    return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/public/branding/${workspaceId}/logo?v=${assetId.slice(-8)}`;
  }

  async get(workspaceId: string) {
    const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { name: true } });
    if (!ws) throw Errors.notFound('Workspace');
    const b = await this.prisma.workspaceBranding.findUnique({ where: { workspaceId } });
    return {
      workspaceName: ws.name,
      displayName: b?.displayName ?? null,
      logoUrl: b?.logoUrl ?? null,
      primaryColor: b?.primaryColor ?? null,
      accentColor: b?.accentColor ?? null,
      supportEmail: b?.supportEmail ?? null,
      emailFooter: b?.emailFooter ?? null,
      hidePoweredBy: b?.hidePoweredBy ?? false,
      updatedAt: b?.updatedAt ?? null,
    };
  }

  /** Participant-facing branding (public by nature; never includes internal fields). */
  async publicBranding(workspaceId: string): Promise<PublicBranding> {
    const b = await this.get(workspaceId);
    return {
      workspaceName: b.workspaceName,
      displayName: b.displayName || b.workspaceName,
      logoUrl: b.logoUrl,
      primaryColor: b.primaryColor,
      accentColor: b.accentColor,
      supportEmail: b.supportEmail,
      hidePoweredBy: b.hidePoweredBy,
    };
  }

  async update(workspaceId: string, body: UpdateBrandingBody, principal: Principal) {
    const data = { ...body, updatedById: principal.kind === 'user' ? principal.userId : null };
    await this.prisma.workspaceBranding.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    await this.audit.log({ workspaceId, principal, action: 'branding.updated', targetType: 'workspace', targetId: workspaceId, metadata: { fields: Object.keys(body) } });
    return this.get(workspaceId);
  }

  async uploadLogo(workspaceId: string, file: { buffer: Buffer; fileName?: string }, principal: Principal) {
    const limit = UPLOAD_LIMITS.branding.maxBytes;
    if (file.buffer.length === 0) throw Errors.validation('The file is empty');
    if (file.buffer.length > limit) throw new AppError(413, 'payload_too_large', `Logo must be at most ${Math.round(limit / 1024 / 1024)} MB`);
    const kind = sniffImage(file.buffer);
    if (!kind) throw new AppError(415, 'unsupported_media_type', 'Logo must be a PNG, JPEG or WebP image (SVG is not accepted for security reasons)');
    const id = this.crypto.randomToken(9).replace(/[^a-zA-Z0-9]/g, 'x');
    const key = this.storage.key(workspaceId, 'branding', `logo-${Date.now()}-${id}.${kind.ext}`);
    await this.storage.put(key, file.buffer, kind.mime);
    const asset = await this.prisma.mediaAsset.create({
      data: {
        workspaceId,
        kind: 'BRANDING',
        storageKey: key,
        fileName: `logo.${kind.ext}`,
        mimeType: kind.mime,
        sizeBytes: BigInt(file.buffer.length),
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
        status: 'READY',
        createdById: principal.kind === 'user' ? principal.userId : null,
      },
    });
    const prev = await this.prisma.workspaceBranding.findUnique({ where: { workspaceId } });
    await this.prisma.workspaceBranding.upsert({
      where: { workspaceId },
      create: { workspaceId, logoAssetId: asset.id, logoUrl: this.logoUrl(workspaceId, asset.id) },
      update: { logoAssetId: asset.id, logoUrl: this.logoUrl(workspaceId, asset.id) },
    });
    if (prev?.logoAssetId) await this.deleteAsset(workspaceId, prev.logoAssetId);
    await this.audit.log({ workspaceId, principal, action: 'branding.logo_uploaded', targetType: 'media', targetId: asset.id, metadata: { mimeType: kind.mime, sizeBytes: file.buffer.length } });
    return this.get(workspaceId);
  }

  async removeLogo(workspaceId: string, principal: Principal) {
    const b = await this.prisma.workspaceBranding.findUnique({ where: { workspaceId } });
    if (b?.logoAssetId) {
      await this.prisma.workspaceBranding.update({ where: { workspaceId }, data: { logoAssetId: null, logoUrl: null } });
      await this.deleteAsset(workspaceId, b.logoAssetId);
      await this.audit.log({ workspaceId, principal, action: 'branding.logo_removed', targetType: 'workspace', targetId: workspaceId });
    }
    return this.get(workspaceId);
  }

  private async deleteAsset(workspaceId: string, assetId: string) {
    const a = await this.prisma.mediaAsset.findFirst({ where: { id: assetId, workspaceId } });
    if (!a) return;
    await this.storage.delete(a.storageKey).catch(() => undefined);
    await this.prisma.mediaAsset.update({ where: { id: a.id }, data: { status: 'DELETED', deletedAt: new Date() } });
  }

  /** Logo bytes for the public endpoint. */
  async logo(workspaceId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workspaceId)) return null;
    const b = await this.prisma.workspaceBranding.findUnique({ where: { workspaceId } });
    if (!b?.logoAssetId) return null;
    const a = await this.prisma.mediaAsset.findFirst({ where: { id: b.logoAssetId, workspaceId, kind: 'BRANDING', deletedAt: null } });
    if (!a) return null;
    this.storage.assertWorkspaceKey(workspaceId, a.storageKey);
    return { buffer: await this.storage.get(a.storageKey), mimeType: a.mimeType };
  }
}
