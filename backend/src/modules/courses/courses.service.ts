import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Course, type CourseItem, type MediaAsset } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { userIdOf } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { ASSET_LIMITS, mimeAllowedFor, safeFileName, sniffMime, type AssetPurpose } from './course-media';
import {
  COURSE_ITEM_KINDS,
  CompletionRuleSchema,
  defaultRuleFor,
  isSafeHttpsUrl,
  parseRule,
  ruleAllowedFor,
  type CourseItemKindT,
} from './course-rules';

const HttpsUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(isSafeHttpsUrl, 'Must be a public https:// URL');

export const CreateCourseBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional().nullable(),
  coverUrl: HttpsUrl.optional().nullable(),
  forcedOrder: z.boolean().optional(),
  visibility: z.enum(['PRIVATE', 'ORGANIZATION', 'PUBLIC']).optional(),
});
export const UpdateCourseBody = CreateCourseBody.partial().extend({
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
});
export const ListCoursesQuery = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  q: z.string().trim().max(200).optional(),
});

export const ItemBody = z.object({
  kind: z.enum(COURSE_ITEM_KINDS),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  scenarioId: z.string().max(64).optional().nullable(),
  pinnedVersionId: z.string().max(64).optional().nullable(),
  url: HttpsUrl.optional().nullable(),
  assetId: z.string().max(64).optional().nullable(),
  completionRule: CompletionRuleSchema.optional(),
  required: z.boolean().optional(),
});
export const UpdateItemBody = ItemBody.omit({ kind: true }).partial();
export const ReorderBody = z.object({ itemIds: z.array(z.string().max(64)).min(1).max(500) });

type CourseWithItems = Course & { items: CourseItem[] };

@Injectable()
export class CoursesService {
  private readonly logger = new Logger('Courses');
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── helpers ─────────────

  async findCourse(workspaceId: string, courseId: string): Promise<Course> {
    const c = await this.prisma.course.findFirst({ where: { id: courseId, workspaceId, deletedAt: null } });
    if (!c) throw Errors.notFound('Course');
    return c;
  }

  shareUrl(token: string | null) {
    return token ? `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/c/${token}` : null;
  }

  /** Cover image URL: external https URL or a short-lived signed URL for an uploaded asset. */
  async coverImageUrl(course: Pick<Course, 'workspaceId' | 'coverUrl' | 'coverAssetId'>): Promise<string | null> {
    if (course.coverAssetId) {
      const a = await this.prisma.mediaAsset.findFirst({
        where: { id: course.coverAssetId, workspaceId: course.workspaceId, deletedAt: null, kind: 'COURSE_ASSET' },
      });
      if (a) return this.storage.signedUrl(a, 3600);
    }
    return course.coverUrl ?? null;
  }

  async signedAssetUrl(workspaceId: string, assetId: string, ttl = 900): Promise<string> {
    const a = await this.prisma.mediaAsset.findFirst({ where: { id: assetId, workspaceId, deletedAt: null, kind: 'COURSE_ASSET' } });
    if (!a) throw Errors.notFound('Media');
    return this.storage.signedUrl(a, ttl);
  }

  // ───────────── courses ─────────────

  async list(workspaceId: string, q: z.infer<typeof ListCoursesQuery>) {
    const rows = await this.prisma.course.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { title: { contains: q.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 500,
      include: { _count: { select: { items: true } } },
    });
    const enrollCounts = await this.prisma.enrollment.groupBy({
      by: ['courseId', 'status'],
      where: { workspaceId, courseId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    return Promise.all(
      rows.map(async (c) => {
        const counts = enrollCounts.filter((e) => e.courseId === c.id);
        const n = (s?: string) => counts.filter((e) => !s || e.status === s).reduce((t, e) => t + e._count._all, 0);
        return {
          ...this.courseDto(c),
          coverImageUrl: await this.coverImageUrl(c),
          itemCount: c._count.items,
          enrollmentCount: n() - n('DROPPED'),
          completedCount: n('COMPLETED'),
        };
      }),
    );
  }

  courseDto(c: Course) {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      title: c.title,
      description: c.description,
      coverUrl: c.coverUrl,
      coverAssetId: c.coverAssetId,
      forcedOrder: c.forcedOrder,
      visibility: c.visibility,
      status: c.status,
      shareToken: c.shareToken,
      shareUrl: this.shareUrl(c.shareToken),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  async create(workspaceId: string, principal: Principal, body: z.infer<typeof CreateCourseBody>) {
    const c = await this.prisma.course.create({
      data: {
        workspaceId,
        title: body.title,
        description: body.description ?? null,
        coverUrl: body.coverUrl ?? null,
        forcedOrder: body.forcedOrder ?? false,
        visibility: body.visibility ?? 'PRIVATE',
        createdById: userIdOf(principal),
        updatedById: userIdOf(principal),
      },
    });
    await this.audit.log({ workspaceId, principal, action: 'course.created', targetType: 'course', targetId: c.id, metadata: { title: c.title } });
    return this.courseDto(c);
  }

  async get(workspaceId: string, courseId: string) {
    const c = await this.prisma.course.findFirst({
      where: { id: courseId, workspaceId, deletedAt: null },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!c) throw Errors.notFound('Course');
    const [items, enrollmentCount, cover] = await Promise.all([
      this.itemDtos(workspaceId, c.items),
      this.prisma.enrollment.count({ where: { courseId, workspaceId, status: { not: 'DROPPED' } } }),
      this.coverImageUrl(c),
    ]);
    return { ...this.courseDto(c), coverImageUrl: cover, items, enrollmentCount };
  }

  async itemDtos(workspaceId: string, items: CourseItem[]) {
    const scenarioIds = [...new Set(items.map((i) => i.scenarioId).filter(Boolean) as string[])];
    const versionIds = [...new Set(items.map((i) => i.pinnedVersionId).filter(Boolean) as string[])];
    const assetIds = [...new Set(items.map((i) => i.assetId).filter(Boolean) as string[])];
    const [scenarios, versions, assets] = await Promise.all([
      scenarioIds.length
        ? this.prisma.scenario.findMany({
            where: { id: { in: scenarioIds }, workspaceId },
            select: { id: true, name: true, type: true, status: true, latestVersionId: true, latestVersionNumber: true, deletedAt: true, archivedAt: true, publicDescription: true },
          })
        : [],
      versionIds.length
        ? this.prisma.scenarioVersion.findMany({ where: { id: { in: versionIds }, workspaceId }, select: { id: true, version: true, scenarioId: true } })
        : [],
      assetIds.length
        ? this.prisma.mediaAsset.findMany({
            where: { id: { in: assetIds }, workspaceId, deletedAt: null },
            select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
          })
        : [],
    ]);
    return items
      .sort((a, b) => a.position - b.position)
      .map((i) => {
        const s = scenarios.find((x) => x.id === i.scenarioId);
        const v = versions.find((x) => x.id === i.pinnedVersionId);
        const a = assets.find((x) => x.id === i.assetId);
        return {
          id: i.id,
          position: i.position,
          kind: i.kind,
          title: i.title,
          description: i.description,
          scenarioId: i.scenarioId,
          scenario: s
            ? {
                id: s.id,
                name: s.name,
                type: s.type,
                publicDescription: s.publicDescription,
                latestVersionNumber: s.latestVersionNumber,
                runnable: !s.deletedAt && !s.archivedAt && s.status !== 'ARCHIVED' && !!s.latestVersionId,
              }
            : null,
          pinnedVersionId: i.pinnedVersionId,
          pinnedVersion: v ? { id: v.id, version: v.version } : null,
          url: i.url,
          assetId: i.assetId,
          asset: a ? { id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: Number(a.sizeBytes) } : null,
          completionRule: parseRule(i.kind as CourseItemKindT, i.completionRule),
          required: i.required,
        };
      });
  }

  async update(workspaceId: string, courseId: string, principal: Principal, body: z.infer<typeof UpdateCourseBody>) {
    const current = await this.prisma.course.findFirst({
      where: { id: courseId, workspaceId, deletedAt: null },
      include: { items: true },
    });
    if (!current) throw Errors.notFound('Course');
    if (body.status === 'PUBLISHED' && current.status !== 'PUBLISHED') await this.assertPublishable(workspaceId, current);
    const data: Prisma.CourseUpdateInput = { updatedById: userIdOf(principal) };
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.forcedOrder !== undefined) data.forcedOrder = body.forcedOrder;
    if (body.visibility !== undefined) data.visibility = body.visibility;
    if (body.status !== undefined) data.status = body.status;
    if (body.coverUrl && !isSafeHttpsUrl(body.coverUrl)) throw Errors.validation('Cover URL must be a public https:// URL');
    if (body.coverUrl !== undefined) {
      data.coverUrl = body.coverUrl;
      if (body.coverUrl) data.coverAssetId = null; // external URL replaces an uploaded cover
    }
    const c = await this.prisma.course.update({ where: { id: current.id }, data });
    if (body.coverUrl && current.coverAssetId) await this.retireAsset(workspaceId, current.coverAssetId);
    const changes: Record<string, unknown> = {};
    for (const k of ['title', 'forcedOrder', 'visibility', 'status'] as const) if (body[k] !== undefined && body[k] !== current[k]) changes[k] = body[k];
    if (Object.keys(changes).length) {
      const action = changes.status === 'PUBLISHED' ? 'course.published' : changes.visibility ? 'course.visibility_changed' : 'course.updated';
      await this.audit.log({ workspaceId, principal, action, targetType: 'course', targetId: c.id, metadata: changes });
    }
    return this.get(workspaceId, c.id);
  }

  private async assertPublishable(workspaceId: string, course: CourseWithItems) {
    if (!course.items.length) throw Errors.validation('Add at least one item before publishing the course');
    const problems: Array<{ path: string; message: string }> = [];
    for (const item of course.items) {
      if (item.kind === 'SCENARIO') {
        const s = item.scenarioId
          ? await this.prisma.scenario.findFirst({ where: { id: item.scenarioId, workspaceId, deletedAt: null } })
          : null;
        if (!s || !s.latestVersionId || s.status === 'ARCHIVED' || s.archivedAt) {
          problems.push({ path: `items.${item.id}`, message: `"${item.title}": scenario is missing, archived or unpublished` });
        }
      }
    }
    if (problems.length) throw Errors.validation('Some items cannot be run', problems);
  }

  async remove(workspaceId: string, courseId: string, principal: Principal) {
    const c = await this.findCourse(workspaceId, courseId);
    await this.prisma.course.update({ where: { id: c.id }, data: { deletedAt: new Date(), shareToken: null, updatedById: userIdOf(principal) } });
    await this.audit.log({ workspaceId, principal, action: 'course.deleted', targetType: 'course', targetId: c.id, metadata: { title: c.title } });
    return { ok: true };
  }

  async rotateShareToken(workspaceId: string, courseId: string, principal: Principal) {
    const c = await this.findCourse(workspaceId, courseId);
    const token = this.crypto.randomToken(24);
    const updated = await this.prisma.course.update({ where: { id: c.id }, data: { shareToken: token } });
    await this.audit.log({
      workspaceId,
      principal,
      action: c.shareToken ? 'course.share_link_rotated' : 'course.share_link_created',
      targetType: 'course',
      targetId: c.id,
    });
    return { shareToken: updated.shareToken, shareUrl: this.shareUrl(updated.shareToken) };
  }

  async revokeShareToken(workspaceId: string, courseId: string, principal: Principal) {
    const c = await this.findCourse(workspaceId, courseId);
    await this.prisma.course.update({ where: { id: c.id }, data: { shareToken: null } });
    await this.audit.log({ workspaceId, principal, action: 'course.share_link_revoked', targetType: 'course', targetId: c.id });
    return { shareToken: null, shareUrl: null };
  }

  // ───────────── assets ─────────────

  async uploadAsset(
    workspaceId: string,
    courseId: string,
    principal: Principal,
    file: { buffer: Buffer; fileName?: string | null },
    purpose: AssetPurpose,
  ): Promise<{ asset: Pick<MediaAsset, 'id' | 'fileName' | 'mimeType'> & { sizeBytes: number }; coverImageUrl?: string | null }> {
    const course = await this.findCourse(workspaceId, courseId);
    if (!file.buffer.length) throw Errors.validation('The file is empty');
    if (file.buffer.length > ASSET_LIMITS[purpose]) {
      throw Errors.validation(`File too large (max ${Math.round(ASSET_LIMITS[purpose] / 1024 / 1024)} MB)`);
    }
    const mime = sniffMime(file.buffer);
    if (!mime || !mimeAllowedFor(purpose, mime)) {
      const expected = purpose === 'cover' ? 'a PNG, JPEG, GIF or WebP image' : purpose === 'video' ? 'an MP4, WebM or MOV video' : 'a PDF';
      throw Errors.validation(`Unsupported file type — upload ${expected}`);
    }
    const fileName = safeFileName(file.fileName, purpose === 'document' ? 'document.pdf' : purpose);
    const storageKey = this.storage.key(workspaceId, 'courses', course.id, `${this.crypto.randomToken(9)}-${fileName}`);
    await this.storage.put(storageKey, file.buffer, mime);
    const asset = await this.prisma.mediaAsset.create({
      data: {
        workspaceId,
        kind: 'COURSE_ASSET',
        storageKey,
        fileName,
        mimeType: mime,
        sizeBytes: BigInt(file.buffer.length),
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
        status: 'READY',
        metadata: { courseId: course.id, purpose } as Prisma.InputJsonValue,
        createdById: userIdOf(principal),
      },
    });
    let coverImageUrl: string | null | undefined;
    if (purpose === 'cover') {
      await this.prisma.course.update({ where: { id: course.id }, data: { coverAssetId: asset.id, coverUrl: null, updatedById: userIdOf(principal) } });
      if (course.coverAssetId) await this.retireAsset(workspaceId, course.coverAssetId);
      coverImageUrl = await this.storage.signedUrl(asset, 3600);
    }
    return {
      asset: { id: asset.id, fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: Number(asset.sizeBytes) },
      coverImageUrl,
    };
  }

  async removeCover(workspaceId: string, courseId: string, principal: Principal) {
    const c = await this.findCourse(workspaceId, courseId);
    await this.prisma.course.update({ where: { id: c.id }, data: { coverAssetId: null, coverUrl: null, updatedById: userIdOf(principal) } });
    if (c.coverAssetId) await this.retireAsset(workspaceId, c.coverAssetId);
    return { ok: true };
  }

  private async retireAsset(workspaceId: string, assetId: string) {
    const a = await this.prisma.mediaAsset.findFirst({ where: { id: assetId, workspaceId, kind: 'COURSE_ASSET', deletedAt: null } });
    if (!a) return;
    // Only delete when no course item still points at it.
    const inUse = await this.prisma.courseItem.count({ where: { assetId: a.id, course: { workspaceId } } });
    if (inUse) return;
    await this.prisma.mediaAsset.update({ where: { id: a.id }, data: { deletedAt: new Date(), status: 'DELETED' } });
    await this.storage.delete(a.storageKey).catch((e) => this.logger.warn(`Could not delete ${a.storageKey}: ${e?.message}`));
  }

  // ───────────── items ─────────────

  /** Validates an item's references and returns normalized column values. */
  private async normalizeItem(
    workspaceId: string,
    kind: CourseItemKindT,
    input: z.infer<typeof UpdateItemBody>,
  ): Promise<{
    title: string;
    description: string | null;
    scenarioId: string | null;
    pinnedVersionId: string | null;
    url: string | null;
    assetId: string | null;
    completionRule: Prisma.InputJsonValue;
    required: boolean;
  }> {
    const rule = input.completionRule ?? defaultRuleFor(kind);
    if (!ruleAllowedFor(kind, rule)) {
      throw Errors.validation(`Completion rule "${rule.type}" is not available for ${kind.toLowerCase()} items`, [
        { path: 'completionRule', message: 'Not allowed for this item kind' },
      ]);
    }
    if (input.url != null && !isSafeHttpsUrl(input.url)) {
      throw Errors.validation('Links must be public https:// URLs', [{ path: 'url', message: 'Must be a public https:// URL' }]);
    }
    let title = input.title?.trim() ?? '';
    let scenarioId: string | null = null;
    let pinnedVersionId: string | null = null;
    let url: string | null = null;
    let assetId: string | null = null;

    if (kind === 'SCENARIO') {
      if (!input.scenarioId) throw Errors.validation('Choose a scenario', [{ path: 'scenarioId', message: 'Required' }]);
      const s = await this.prisma.scenario.findFirst({ where: { id: input.scenarioId, workspaceId, deletedAt: null } });
      if (!s) throw Errors.validation('Scenario not found in this workspace', [{ path: 'scenarioId', message: 'Not found' }]);
      if (!s.latestVersionId || s.status === 'ARCHIVED' || s.archivedAt) {
        throw Errors.validation('Only scenarios with a published version can be added', [{ path: 'scenarioId', message: 'Not published' }]);
      }
      scenarioId = s.id;
      if (input.pinnedVersionId) {
        const v = await this.prisma.scenarioVersion.findFirst({ where: { id: input.pinnedVersionId, scenarioId: s.id, workspaceId } });
        if (!v) throw Errors.validation('Pinned version does not belong to this scenario', [{ path: 'pinnedVersionId', message: 'Invalid' }]);
        pinnedVersionId = v.id;
      }
      if (!title) title = s.name;
    } else {
      if (input.assetId && input.url) throw Errors.validation('Provide either an uploaded file or a URL, not both');
      if (kind === 'LINK') {
        if (!input.url) throw Errors.validation('A link needs an https URL', [{ path: 'url', message: 'Required' }]);
        url = input.url;
      } else if (input.assetId) {
        const a = await this.prisma.mediaAsset.findFirst({
          where: { id: input.assetId, workspaceId, kind: 'COURSE_ASSET', deletedAt: null, status: 'READY' },
        });
        if (!a) throw Errors.validation('Uploaded file not found in this workspace', [{ path: 'assetId', message: 'Not found' }]);
        const family = kind === 'VIDEO' ? 'video' : 'document';
        if (!mimeAllowedFor(family, a.mimeType)) {
          throw Errors.validation(`The uploaded file is not a ${family === 'video' ? 'video' : 'PDF'}`, [{ path: 'assetId', message: 'Wrong type' }]);
        }
        assetId = a.id;
        if (!title) title = a.fileName ?? '';
      } else if (input.url) {
        url = input.url;
      } else {
        throw Errors.validation('Upload a file or provide an https URL', [{ path: 'url', message: 'Required' }]);
      }
    }
    if (!title) throw Errors.validation('Title is required', [{ path: 'title', message: 'Required' }]);
    return {
      title: title.slice(0, 200),
      description: input.description ?? null,
      scenarioId,
      pinnedVersionId,
      url,
      assetId,
      completionRule: rule as Prisma.InputJsonValue,
      required: input.required ?? true,
    };
  }

  /** Serialize item mutations per course (row lock) so positions stay contiguous. */
  private async withCourseLock<T>(workspaceId: string, courseId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Course" WHERE id = ${courseId} AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (!rows.length) throw Errors.notFound('Course');
      return fn(tx);
    });
  }

  async addItem(workspaceId: string, courseId: string, principal: Principal, body: z.infer<typeof ItemBody>) {
    await this.findCourse(workspaceId, courseId);
    const data = await this.normalizeItem(workspaceId, body.kind, body);
    const item = await this.withCourseLock(workspaceId, courseId, async (tx) => {
      const count = await tx.courseItem.count({ where: { courseId } });
      if (count >= 200) throw Errors.validation('A course can have at most 200 items');
      const created = await tx.courseItem.create({ data: { courseId, kind: body.kind, position: count, ...data } });
      await tx.course.update({ where: { id: courseId }, data: { updatedById: userIdOf(principal) } });
      return created;
    });
    return (await this.itemDtos(workspaceId, [item]))[0];
  }

  async updateItem(workspaceId: string, courseId: string, itemId: string, principal: Principal, body: z.infer<typeof UpdateItemBody>) {
    await this.findCourse(workspaceId, courseId);
    const item = await this.prisma.courseItem.findFirst({ where: { id: itemId, courseId } });
    if (!item) throw Errors.notFound('Course item');
    const kind = item.kind as CourseItemKindT;
    const merged = {
      title: body.title ?? item.title,
      description: body.description !== undefined ? body.description : item.description,
      scenarioId: body.scenarioId !== undefined ? body.scenarioId : item.scenarioId,
      pinnedVersionId:
        body.pinnedVersionId !== undefined ? body.pinnedVersionId : body.scenarioId && body.scenarioId !== item.scenarioId ? null : item.pinnedVersionId,
      url: body.url !== undefined ? body.url : body.assetId ? null : item.url,
      assetId: body.assetId !== undefined ? body.assetId : body.url ? null : item.assetId,
      completionRule: body.completionRule ?? parseRule(kind, item.completionRule),
      required: body.required ?? item.required,
    };
    const data = await this.normalizeItem(workspaceId, kind, merged);
    const updated = await this.prisma.courseItem.update({ where: { id: item.id }, data });
    await this.prisma.course.update({ where: { id: courseId }, data: { updatedById: userIdOf(principal) } });
    return (await this.itemDtos(workspaceId, [updated]))[0];
  }

  async removeItem(workspaceId: string, courseId: string, itemId: string, principal: Principal) {
    await this.withCourseLock(workspaceId, courseId, async (tx) => {
      const item = await tx.courseItem.findFirst({ where: { id: itemId, courseId } });
      if (!item) throw Errors.notFound('Course item');
      await tx.courseItem.delete({ where: { id: item.id } });
      const rest = await tx.courseItem.findMany({ where: { courseId }, orderBy: { position: 'asc' }, select: { id: true } });
      for (const [i, r] of rest.entries()) await tx.courseItem.update({ where: { id: r.id }, data: { position: i } });
      await tx.course.update({ where: { id: courseId }, data: { updatedById: userIdOf(principal) } });
    });
    await this.audit.log({ workspaceId, principal, action: 'course.item_removed', targetType: 'course', targetId: courseId, metadata: { itemId } });
    return { ok: true };
  }

  async reorder(workspaceId: string, courseId: string, principal: Principal, itemIds: string[]) {
    await this.withCourseLock(workspaceId, courseId, async (tx) => {
      const items = await tx.courseItem.findMany({ where: { courseId }, select: { id: true } });
      const current = new Set(items.map((i) => i.id));
      if (new Set(itemIds).size !== itemIds.length || itemIds.length !== current.size || !itemIds.every((id) => current.has(id))) {
        throw Errors.validation('itemIds must list every item of the course exactly once');
      }
      // Two passes avoid transient duplicate positions if a unique index is ever added.
      for (const [i, id] of itemIds.entries()) await tx.courseItem.update({ where: { id }, data: { position: 1000 + i } });
      for (const [i, id] of itemIds.entries()) await tx.courseItem.update({ where: { id }, data: { position: i } });
      await tx.course.update({ where: { id: courseId }, data: { updatedById: userIdOf(principal) } });
    });
    return this.get(workspaceId, courseId);
  }

  /** Scenarios that can be added as items (published, not archived). */
  async scenarioOptions(workspaceId: string) {
    const rows = await this.prisma.scenario.findMany({
      where: { workspaceId, deletedAt: null, latestVersionId: { not: null }, archivedAt: null, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, type: true, latestVersionNumber: true, versions: { select: { id: true, version: true, publishedAt: true }, orderBy: { version: 'desc' }, take: 20 } },
      orderBy: { name: 'asc' },
      take: 500,
    });
    return rows;
  }
}
