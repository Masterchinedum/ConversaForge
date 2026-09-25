import { Injectable } from '@nestjs/common';
import { Prisma, type Scenario, type ScenarioDraft, type ScenarioVersion } from '@prisma/client';
import {
  defaultScenarioConfig,
  diffConfigs,
  EDITABLE_FIELD_PATHS,
  getToolDefinition,
  normalizeScenarioConfig,
  parseScenarioConfig,
  SCENARIO_TEMPLATES,
  ScenarioConfigSchema,
  setAtPath,
  validateScenarioForPublish,
  type ScenarioConfig,
  type ValidationIssue,
} from '@cf/shared';
import { AuditService } from '../../common/audit/audit.service';
import { userIdOf, type Principal } from '../../common/auth/principal';
import { AppError, Errors } from '../../common/http/errors';
import { decodeCursor, encodeCursor } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { exportScenarioConfig, importScenarioConfig, scrubData, toHttpError, type ImportFormat } from './scenario-io';
import {
  draftPublishHash,
  hashConfig,
  isSafeConfigPath,
  slugify,
  zodIssuesToDetails,
} from './scenario-utils';
import type { CreateScenarioBody, ListScenariosQuery, UpdateDraftBody } from './scenarios.schemas';

type ScenarioWithDraft = Scenario & { draft: ScenarioDraft | null };

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  config?: ScenarioConfig;
}

export interface RunnableVersion {
  scenario: Scenario;
  version: ScenarioVersion;
  config: ScenarioConfig;
}

/**
 * Scenarios: library, drafts (optimistic concurrency), validation, immutable versions, rollback,
 * duplicate/import/export. Every query is scoped by workspaceId; a scenario from another workspace is a 404.
 */
@Injectable()
export class ScenariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── lookups ─────────────────────────────

  async findScenario(workspaceId: string, scenarioId: string): Promise<ScenarioWithDraft> {
    const s = await this.prisma.scenario.findFirst({
      where: { id: scenarioId, workspaceId, deletedAt: null },
      include: { draft: true },
    });
    if (!s) throw Errors.notFound('Scenario');
    if (!s.draft) {
      // Defensive: every scenario is created with a draft; recreate from the latest version if missing.
      const latest = s.latestVersionId
        ? await this.prisma.scenarioVersion.findFirst({ where: { id: s.latestVersionId, workspaceId } })
        : null;
      const draft = await this.prisma.scenarioDraft.create({
        data: {
          scenarioId: s.id,
          config: (latest?.config ?? defaultScenarioConfig({ basics: { name: s.name } })) as Prisma.InputJsonValue,
          lockedFields: [],
          baseVersionId: latest?.id ?? null,
        },
      });
      return { ...s, draft };
    }
    return s;
  }

  async findVersion(workspaceId: string, scenarioId: string, versionId: string): Promise<ScenarioVersion> {
    const v = await this.prisma.scenarioVersion.findFirst({ where: { id: versionId, scenarioId, workspaceId } });
    if (!v) throw Errors.notFound('Scenario version');
    return v;
  }

  private async latestVersion(workspaceId: string, s: Scenario): Promise<ScenarioVersion | null> {
    if (!s.latestVersionId) return null;
    return this.prisma.scenarioVersion.findFirst({ where: { id: s.latestVersionId, scenarioId: s.id, workspaceId } });
  }

  /**
   * Contract for the runtime (workstream B) and access flows: the exact immutable version to run.
   * Throws 404 for unknown/other-workspace scenarios or versions, 409 when unpublished or archived.
   */
  async getRunnableVersion(workspaceId: string, scenarioId: string, versionId?: string | null): Promise<RunnableVersion> {
    const scenario = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!scenario) throw Errors.notFound('Scenario');
    if (scenario.status === 'ARCHIVED' || scenario.archivedAt) {
      throw new AppError(409, 'scenario_archived', 'This scenario has been archived and cannot be run');
    }
    const id = versionId ?? scenario.latestVersionId;
    if (!id) throw new AppError(409, 'scenario_unpublished', 'This scenario has not been published yet');
    const version = await this.prisma.scenarioVersion.findFirst({ where: { id, scenarioId, workspaceId } });
    if (!version) throw Errors.notFound('Scenario version');
    const parsed = ScenarioConfigSchema.safeParse(version.config);
    if (!parsed.success) throw new AppError(500, 'invalid_version', 'The published version could not be loaded');
    return { scenario, version, config: parsed.data };
  }

  // ───────────────────────────── list ─────────────────────────────

  async list(workspaceId: string, q: ListScenariosQuery) {
    const where: Prisma.ScenarioWhereInput = { workspaceId, deletedAt: null };
    if (q.status) where.status = q.status;
    else if (!q.includeArchived) where.status = { not: 'ARCHIVED' };
    if (q.type) where.type = q.type;
    if (q.privacy) where.privacy = q.privacy;
    if (q.isTemplate !== undefined) where.isTemplate = q.isTemplate;
    if (q.tag) where.tags = { has: q.tag.toLowerCase() };
    if (q.q) {
      where.OR = [
        { name: { contains: q.q, mode: 'insensitive' } },
        { publicDescription: { contains: q.q, mode: 'insensitive' } },
        { slug: { contains: q.q.toLowerCase() } },
        { tags: { has: q.q.toLowerCase() } },
        { draft: { config: { path: ['basics', 'internalDescription'], string_contains: q.q } } },
      ];
    }
    const orderBy: Prisma.ScenarioOrderByWithRelationInput[] =
      q.sort === 'name' ? [{ name: 'asc' }, { id: 'asc' }] : q.sort === 'created' ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ updatedAt: 'desc' }, { id: 'desc' }];
    const cursorId = decodeCursor(q.cursor);
    if (cursorId) {
      // A cursor from another workspace must not be usable to probe ids.
      const ok = await this.prisma.scenario.count({ where: { id: cursorId, workspaceId } });
      if (!ok) throw Errors.badRequest('Invalid cursor');
    }
    const rows = await this.prisma.scenario.findMany({
      where,
      orderBy,
      take: q.limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      include: {
        draft: { select: { config: true, revision: true, updatedAt: true } },
        _count: { select: { sessions: { where: { deletedAt: null } } } },
      },
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const versionIds = page.map((r) => r.latestVersionId).filter((x): x is string => !!x);
    const versions = versionIds.length
      ? await this.prisma.scenarioVersion.findMany({ where: { id: { in: versionIds }, workspaceId }, select: { id: true, configHash: true, publishedAt: true } })
      : [];
    const byId = new Map(versions.map((v) => [v.id, v]));
    return {
      data: page.map((r) => {
        const latest = r.latestVersionId ? byId.get(r.latestVersionId) : undefined;
        const draftHash = r.draft ? draftPublishHash(r.draft.config) : null;
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          type: r.type,
          status: r.status,
          privacy: r.privacy,
          tags: r.tags,
          publicDescription: r.publicDescription,
          isTemplate: r.isTemplate,
          galleryListed: r.galleryListed,
          latestVersionId: r.latestVersionId,
          latestVersionNumber: r.latestVersionNumber,
          latestPublishedAt: latest?.publishedAt ?? null,
          draftRevision: r.draft?.revision ?? null,
          draftHasUnpublishedChanges: !latest || draftHash !== latest.configHash,
          sessionCount: r._count.sessions,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          archivedAt: r.archivedAt,
        };
      }),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
    };
  }

  // ───────────────────────────── create ─────────────────────────────

  async create(workspaceId: string, principal: Principal, body: CreateScenarioBody) {
    let config: ScenarioConfig;
    let lockedFields: string[] = [];
    let origin: Record<string, unknown> = { source: body.source };

    switch (body.source) {
      case 'blank':
        config = defaultScenarioConfig({ basics: { name: body.name, type: body.type ?? 'custom' } });
        break;
      case 'template': {
        const t = SCENARIO_TEMPLATES.find((x) => x.key === body.templateKey);
        if (!t) throw Errors.notFound('Template');
        config = defaultScenarioConfig(JSON.parse(JSON.stringify(t.config)));
        if (body.name) config.basics.name = body.name;
        origin = { source: 'template', templateKey: t.key };
        break;
      }
      case 'import': {
        try {
          config = importScenarioConfig(body.text, body.format as ImportFormat);
        } catch (e) {
          toHttpError(e);
        }
        if (body.name) config.basics.name = body.name;
        if (!config.basics.name.trim()) config.basics.name = 'Imported scenario';
        break;
      }
      case 'duplicate': {
        const src = await this.findScenario(workspaceId, body.scenarioId);
        let raw: unknown;
        if (body.versionId) {
          raw = (await this.findVersion(workspaceId, src.id, body.versionId)).config;
          origin = { source: 'duplicate', scenarioId: src.id, versionId: body.versionId };
        } else {
          raw = src.draft!.config;
          lockedFields = [...src.draft!.lockedFields];
          origin = { source: 'duplicate', scenarioId: src.id, fromDraft: true };
        }
        const parsed = parseScenarioConfig(JSON.parse(JSON.stringify(raw)));
        config = parsed.success ? parsed.data : defaultScenarioConfig({ basics: { name: src.name } });
        config.basics.name = body.name ?? `${config.basics.name || src.name} (copy)`.slice(0, 120);
        break;
      }
    }

    if (config.basics.privacy === 'PUBLIC' && !(await this.publicAllowed(workspaceId))) config.basics.privacy = 'PRIVATE';

    const scenario = await this.insertScenario(workspaceId, principal, config, lockedFields);
    await this.audit.log({
      workspaceId,
      principal,
      action: 'scenario.created',
      targetType: 'scenario',
      targetId: scenario.id,
      metadata: origin,
    });
    return this.detail(workspaceId, scenario.id);
  }

  private async insertScenario(workspaceId: string, principal: Principal, config: ScenarioConfig, lockedFields: string[]) {
    const userId = userIdOf(principal);
    const meta = metaFromConfig(config);
    for (let attempt = 0; attempt < 4; attempt++) {
      const slug = await this.uniqueSlug(workspaceId, config.basics.name, attempt);
      try {
        return await this.prisma.scenario.create({
          data: {
            workspaceId,
            slug,
            ...meta,
            createdById: userId,
            updatedById: userId,
            draft: { create: { config: config as Prisma.InputJsonValue, lockedFields, updatedById: userId } },
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw Errors.conflict('Could not allocate a unique slug; try another name');
  }

  private async uniqueSlug(workspaceId: string, name: string, attempt: number) {
    const root = slugify(name || 'untitled');
    if (attempt === 0) {
      const taken = await this.prisma.scenario.findMany({
        where: { workspaceId, slug: { startsWith: root } },
        select: { slug: true },
      });
      const set = new Set(taken.map((t) => t.slug));
      if (!set.has(root)) return root;
      for (let i = 2; i < 500; i++) if (!set.has(`${root}-${i}`)) return `${root}-${i}`;
    }
    return `${root}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ───────────────────────────── detail / draft ─────────────────────────────

  async detail(workspaceId: string, scenarioId: string) {
    const s = await this.findScenario(workspaceId, scenarioId);
    const [latest, sessionCount] = await Promise.all([
      this.latestVersion(workspaceId, s),
      this.prisma.session.count({ where: { scenarioId: s.id, workspaceId, deletedAt: null } }),
    ]);
    const validation = await this.validateConfig(workspaceId, s.draft!.config);
    const draftHash = draftPublishHash(s.draft!.config);
    const publisher = latest?.publishedById
      ? await this.prisma.user.findUnique({ where: { id: latest.publishedById }, select: { id: true, name: true, email: true } })
      : null;
    return {
      scenario: publicScenarioRow(s),
      draft: {
        config: s.draft!.config,
        lockedFields: s.draft!.lockedFields,
        revision: s.draft!.revision,
        baseVersionId: s.draft!.baseVersionId,
        updatedAt: s.draft!.updatedAt,
      },
      latestVersion: latest
        ? {
            id: latest.id,
            version: latest.version,
            publishedAt: latest.publishedAt,
            changeNote: latest.changeNote,
            configHash: latest.configHash,
            publishedBy: publisher,
          }
        : null,
      draftHasUnpublishedChanges: !latest || draftHash !== latest.configHash,
      issues: validation.issues,
      canPublish: validation.ok,
      sessionCount,
    };
  }

  async updateDraft(workspaceId: string, principal: Principal, scenarioId: string, body: UpdateDraftBody) {
    const s = await this.findScenario(workspaceId, scenarioId);
    const draft = s.draft!;
    if (body.revision !== draft.revision) throw revisionConflict(draft.revision);

    let next: unknown = body.config !== undefined ? scrubData(body.config) : draft.config;
    for (const p of body.patch ?? []) {
      if (!isSafeConfigPath(p.path)) throw Errors.validation(`Invalid field path: ${p.path}`, [{ path: p.path, message: 'Unknown or unsafe field path' }]);
      next = setAtPath(next, p.path, scrubData(p.value));
    }
    const parsed = parseScenarioConfig(next);
    if (!parsed.success) throw Errors.validation('The draft has invalid values', zodIssuesToDetails(parsed.error.issues));
    const config = parsed.data;
    if (config.basics.privacy === 'PUBLIC' && s.privacy !== 'PUBLIC' && !(await this.publicAllowed(workspaceId))) {
      throw Errors.validation('Public scenarios are disabled for this workspace', [
        { path: 'basics.privacy', message: 'An admin has disabled public scenarios for this workspace', severity: 'error' },
      ]);
    }
    const lockedFields = body.lockedFields ?? draft.lockedFields;
    await this.writeDraft(workspaceId, principal, s, draft.revision, config, lockedFields);
    return this.detail(workspaceId, scenarioId);
  }

  /** Revision-checked draft write that also keeps the Scenario row's basics in sync. */
  async writeDraft(
    workspaceId: string,
    principal: Principal,
    s: Scenario,
    expectedRevision: number,
    config: ScenarioConfig,
    lockedFields: string[],
    extra: { baseVersionId?: string | null } = {},
  ) {
    const userId = userIdOf(principal);
    const meta = metaFromConfig(config);
    // Privacy follows the draft, except that a scenario listed in the gallery is unlisted when it stops being PUBLIC.
    const galleryListed = meta.privacy === 'PUBLIC' ? undefined : false;
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.scenarioDraft.updateMany({
        where: { scenarioId: s.id, revision: expectedRevision },
        data: {
          config: config as Prisma.InputJsonValue,
          lockedFields,
          revision: { increment: 1 },
          updatedById: userId,
          ...(extra.baseVersionId !== undefined ? { baseVersionId: extra.baseVersionId } : {}),
        },
      });
      if (res.count === 0) {
        const cur = await tx.scenarioDraft.findUnique({ where: { scenarioId: s.id }, select: { revision: true } });
        throw revisionConflict(cur?.revision ?? expectedRevision);
      }
      await tx.scenario.updateMany({
        where: { id: s.id, workspaceId },
        data: { ...meta, ...(galleryListed === false ? { galleryListed } : {}), updatedById: userId },
      });
    });
  }

  async importIntoDraft(workspaceId: string, principal: Principal, scenarioId: string, body: { revision: number; text: string; format: ImportFormat }) {
    const s = await this.findScenario(workspaceId, scenarioId);
    if (body.revision !== s.draft!.revision) throw revisionConflict(s.draft!.revision);
    let config: ScenarioConfig;
    try {
      config = importScenarioConfig(body.text, body.format);
    } catch (e) {
      toHttpError(e);
    }
    if (config.basics.privacy === 'PUBLIC' && s.privacy !== 'PUBLIC' && !(await this.publicAllowed(workspaceId))) config.basics.privacy = 'PRIVATE';
    await this.writeDraft(workspaceId, principal, s, s.draft!.revision, config, s.draft!.lockedFields);
    await this.audit.log({ workspaceId, principal, action: 'scenario.draft_imported', targetType: 'scenario', targetId: s.id });
    return this.detail(workspaceId, scenarioId);
  }

  /** Discard draft changes: reset the draft to a version (default: latest published). */
  async revertDraft(workspaceId: string, principal: Principal, scenarioId: string, body: { revision: number; versionId?: string }) {
    const s = await this.findScenario(workspaceId, scenarioId);
    if (body.revision !== s.draft!.revision) throw revisionConflict(s.draft!.revision);
    const id = body.versionId ?? s.latestVersionId;
    if (!id) throw Errors.conflict('This scenario has no published version to revert to');
    const v = await this.findVersion(workspaceId, s.id, id);
    const config = ScenarioConfigSchema.parse(v.config);
    await this.writeDraft(workspaceId, principal, s, s.draft!.revision, config, s.draft!.lockedFields, { baseVersionId: v.id });
    return this.detail(workspaceId, scenarioId);
  }

  async updateMeta(workspaceId: string, principal: Principal, scenarioId: string, body: { isTemplate?: boolean }) {
    const s = await this.findScenario(workspaceId, scenarioId);
    if (body.isTemplate !== undefined) {
      await this.prisma.scenario.updateMany({ where: { id: s.id, workspaceId }, data: { isTemplate: body.isTemplate, updatedById: userIdOf(principal) } });
      await this.audit.log({ workspaceId, principal, action: 'scenario.template_flag', targetType: 'scenario', targetId: s.id, metadata: { isTemplate: body.isTemplate } });
    }
    return this.detail(workspaceId, scenarioId);
  }

  // ───────────────────────────── validation ─────────────────────────────

  private async publicAllowed(workspaceId: string): Promise<boolean> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
    return (ws?.settings as Record<string, unknown> | null)?.allowPublicScenarios !== false;
  }

  /** Workspace-level checks that the shared (pure) validator cannot do. */
  async workspaceIssues(workspaceId: string, c: ScenarioConfig): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    const docIds = Array.from(new Set(c.knowledge.documentIds));
    if (docIds.length) {
      const docs = await this.prisma.knowledgeDocument.findMany({
        where: { id: { in: docIds }, workspaceId, deletedAt: null },
        select: { id: true, title: true, status: true },
      });
      const found = new Map(docs.map((d) => [d.id, d]));
      c.knowledge.documentIds.forEach((id, i) => {
        const d = found.get(id);
        if (!d) issues.push({ path: `knowledge.documentIds.${i}`, message: `Knowledge document ${id} was not found in this workspace`, severity: 'error' });
        else if (d.status === 'FAILED') issues.push({ path: `knowledge.documentIds.${i}`, message: `Knowledge document "${d.title}" failed processing and will not be searchable`, severity: 'warning' });
        else if (d.status !== 'COMPLETED') issues.push({ path: `knowledge.documentIds.${i}`, message: `Knowledge document "${d.title}" is still processing`, severity: 'warning' });
      });
    }

    const fnIds = Array.from(new Set(c.tools.customFunctionIds));
    if (fnIds.length) {
      const fns = await this.prisma.customFunction.findMany({
        where: { id: { in: fnIds }, workspaceId, deletedAt: null },
        select: { id: true, name: true, enabled: true },
      });
      const found = new Map(fns.map((f) => [f.id, f]));
      c.tools.customFunctionIds.forEach((id, i) => {
        const f = found.get(id);
        if (!f) issues.push({ path: `tools.customFunctionIds.${i}`, message: `Custom function ${id} was not found in this workspace`, severity: 'error' });
        else if (!f.enabled) issues.push({ path: `tools.customFunctionIds.${i}`, message: `Custom function "${f.name}" is disabled`, severity: 'warning' });
      });
    }

    const seenTools = new Set<string>();
    c.tools.enabled.forEach((t, i) => {
      const def = getToolDefinition(t.toolId);
      if (!def) issues.push({ path: `tools.enabled.${i}.toolId`, message: `Unknown tool "${t.toolId}"`, severity: 'error' });
      else if (def.status === 'planned' && t.enabled) {
        issues.push({ path: `tools.enabled.${i}.toolId`, message: `The "${def.name}" tool is not available yet (coming soon)`, severity: 'error' });
      }
      if (seenTools.has(t.toolId)) issues.push({ path: `tools.enabled.${i}.toolId`, message: `Tool "${t.toolId}" is listed twice`, severity: 'error' });
      seenTools.add(t.toolId);
    });
    const enabledIds = new Set(c.tools.enabled.filter((t) => t.enabled).map((t) => t.toolId));
    if (enabledIds.has('knowledge_search') && docIds.length === 0) {
      issues.push({ path: 'knowledge.documentIds', message: 'Knowledge search is enabled but no knowledge documents are attached', severity: 'warning' });
    }
    if (!enabledIds.has('end_session')) {
      issues.push({ path: 'tools', message: 'The end_session tool is disabled: the agent cannot end the conversation itself', severity: 'warning' });
    }

    if (c.basics.privacy === 'PUBLIC' && !(await this.publicAllowed(workspaceId))) {
      issues.push({ path: 'basics.privacy', message: 'Public scenarios are disabled for this workspace', severity: 'error' });
    }
    return issues;
  }

  /** Full publish validation: shared semantic rules + workspace checks. */
  async validateConfig(workspaceId: string, raw: unknown): Promise<ValidationResult> {
    const r = validateScenarioForPublish(raw);
    if (!r.config) return { ok: false, issues: r.issues };
    const extra = await this.workspaceIssues(workspaceId, r.config);
    const issues = [...r.issues, ...extra];
    return { ok: !issues.some((i) => i.severity === 'error'), issues, config: r.config };
  }

  async validate(workspaceId: string, scenarioId: string, config?: Record<string, unknown>) {
    const s = await this.findScenario(workspaceId, scenarioId);
    const r = await this.validateConfig(workspaceId, config !== undefined ? scrubData(config) : s.draft!.config);
    return { ok: r.ok, issues: r.issues };
  }

  // ───────────────────────────── publish / versions / rollback ─────────────────────────────

  async publish(workspaceId: string, principal: Principal, scenarioId: string, body: { changeNote?: string; revision?: number }) {
    const s = await this.findScenario(workspaceId, scenarioId);
    if (s.status === 'ARCHIVED') throw Errors.conflict('Unarchive this scenario before publishing');
    if (body.revision !== undefined && body.revision !== s.draft!.revision) throw revisionConflict(s.draft!.revision);
    const v = await this.validateConfig(workspaceId, s.draft!.config);
    if (!v.ok || !v.config) {
      throw Errors.validation('Fix the errors before publishing', v.issues.filter((i) => i.severity === 'error'));
    }
    const normalized = normalizeScenarioConfig(v.config);
    const version = await this.createVersion(workspaceId, principal, s.id, normalized, {
      changeNote: body.changeNote || null,
      rolledBackFromVersionId: null,
      draftRevision: s.draft!.revision,
    });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'scenario.published',
      targetType: 'scenario',
      targetId: s.id,
      metadata: { versionId: version.id, version: version.version, changeNote: body.changeNote ?? null, configHash: version.configHash },
    });
    return { version: versionSummary(version), scenario: await this.detail(workspaceId, s.id) };
  }

  /**
   * Insert a new immutable version (number = max+1) and point the scenario at it, atomically.
   * The scenario row is locked for the duration so concurrent publishes serialize.
   */
  private async createVersion(
    workspaceId: string,
    principal: Principal,
    scenarioId: string,
    normalized: ScenarioConfig,
    opts: { changeNote: string | null; rolledBackFromVersionId: string | null; draftRevision?: number; resetDraft?: boolean },
  ): Promise<ScenarioVersion> {
    const configHash = hashConfig(normalized);
    const userId = userIdOf(principal);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Scenario" WHERE id = ${scenarioId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
        const scenario = await tx.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
        if (!scenario) throw Errors.notFound('Scenario');
        if (scenario.latestVersionId) {
          const latest = await tx.scenarioVersion.findFirst({
            where: { id: scenario.latestVersionId, scenarioId, workspaceId },
            select: { version: true, configHash: true },
          });
          if (latest && latest.configHash === configHash) {
            throw new AppError(409, 'no_changes', `No changes since version ${latest.version}`, { version: latest.version });
          }
        }
        if (opts.draftRevision !== undefined && !opts.resetDraft) {
          const d = await tx.scenarioDraft.findUnique({ where: { scenarioId }, select: { revision: true } });
          if (d && d.revision !== opts.draftRevision) throw revisionConflict(d.revision);
        }
        const max = await tx.scenarioVersion.aggregate({ where: { scenarioId }, _max: { version: true } });
        const number = (max._max.version ?? 0) + 1;
        const version = await tx.scenarioVersion.create({
          data: {
            scenarioId,
            workspaceId,
            version: number,
            config: normalized as Prisma.InputJsonValue,
            configHash,
            schemaVersion: normalized.schemaVersion,
            changeNote: opts.changeNote,
            rolledBackFromVersionId: opts.rolledBackFromVersionId,
            publishedById: userId,
          },
        });
        await tx.scenario.update({
          where: { id: scenarioId },
          data: {
            latestVersionId: version.id,
            latestVersionNumber: number,
            status: 'PUBLISHED',
            archivedAt: null,
            updatedById: userId,
            ...(opts.resetDraft ? metaFromConfig(normalized) : {}),
          },
        });
        if (opts.resetDraft) {
          await tx.scenarioDraft.update({
            where: { scenarioId },
            data: { config: normalized as Prisma.InputJsonValue, baseVersionId: version.id, revision: { increment: 1 }, updatedById: userId },
          });
        } else {
          await tx.scenarioDraft.update({ where: { scenarioId }, data: { baseVersionId: version.id } });
        }
        return version;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.conflict('Another publish happened at the same time; please retry');
      }
      throw e;
    }
  }

  async listVersions(workspaceId: string, scenarioId: string) {
    const s = await this.findScenario(workspaceId, scenarioId);
    const versions = await this.prisma.scenarioVersion.findMany({
      where: { scenarioId: s.id, workspaceId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        configHash: true,
        changeNote: true,
        publishedAt: true,
        publishedById: true,
        rolledBackFromVersionId: true,
        schemaVersion: true,
        _count: { select: { sessions: true } },
      },
    });
    const userIds = Array.from(new Set(versions.map((v) => v.publishedById).filter((x): x is string => !!x)));
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
    const byUser = new Map(users.map((u) => [u.id, u]));
    const byId = new Map(versions.map((v) => [v.id, v.version]));
    const draftHash = draftPublishHash(s.draft!.config);
    return {
      data: versions.map((v) => ({
        id: v.id,
        version: v.version,
        configHash: v.configHash,
        changeNote: v.changeNote,
        publishedAt: v.publishedAt,
        publishedBy: v.publishedById ? byUser.get(v.publishedById) ?? { id: v.publishedById, name: null, email: null } : null,
        rolledBackFromVersionId: v.rolledBackFromVersionId,
        rolledBackFromVersion: v.rolledBackFromVersionId ? byId.get(v.rolledBackFromVersionId) ?? null : null,
        isLatest: v.id === s.latestVersionId,
        matchesDraft: draftHash === v.configHash,
        sessionCount: v._count.sessions,
      })),
    };
  }

  async getVersion(workspaceId: string, scenarioId: string, versionId: string) {
    await this.findScenario(workspaceId, scenarioId);
    const v = await this.findVersion(workspaceId, scenarioId, versionId);
    return { ...versionSummary(v), config: v.config };
  }

  private async resolveConfigRef(workspaceId: string, s: ScenarioWithDraft, ref: string): Promise<{ label: string; config: unknown; versionId: string | null }> {
    if (ref === 'draft') return { label: 'Draft', config: s.draft!.config, versionId: null };
    const id = ref === 'latest' ? s.latestVersionId : ref;
    if (!id) {
      // Nothing published yet: diff against an empty config so the whole draft shows as new.
      return { label: 'Nothing published', config: defaultScenarioConfig(), versionId: null };
    }
    const v = await this.findVersion(workspaceId, s.id, id);
    return { label: `Version ${v.version}`, config: v.config, versionId: v.id };
  }

  async diff(workspaceId: string, scenarioId: string, from: string, to: string) {
    const s = await this.findScenario(workspaceId, scenarioId);
    const [a, b] = await Promise.all([this.resolveConfigRef(workspaceId, s, from), this.resolveConfigRef(workspaceId, s, to)]);
    // Compare the draft in its normalized form so whitespace-only/default-only differences don't show up.
    const norm = (ref: string, cfg: unknown) => {
      if (ref !== 'draft') return cfg;
      const p = parseScenarioConfig(cfg);
      return p.success ? normalizeScenarioConfig(p.data) : cfg;
    };
    return {
      from: { ref: from, label: a.label, versionId: a.versionId },
      to: { ref: to, label: b.label, versionId: b.versionId },
      changes: diffConfigs(norm(from, a.config), norm(to, b.config)),
    };
  }

  async rollback(workspaceId: string, principal: Principal, scenarioId: string, versionId: string, body: { changeNote?: string }) {
    const s = await this.findScenario(workspaceId, scenarioId);
    if (s.status === 'ARCHIVED') throw Errors.conflict('Unarchive this scenario before rolling back');
    const target = await this.findVersion(workspaceId, s.id, versionId);
    const v = await this.validateConfig(workspaceId, target.config);
    if (!v.ok || !v.config) {
      throw Errors.validation(
        `Version ${target.version} can no longer be published as-is`,
        v.issues.filter((i) => i.severity === 'error'),
      );
    }
    const normalized = normalizeScenarioConfig(v.config);
    const version = await this.createVersion(workspaceId, principal, s.id, normalized, {
      changeNote: body.changeNote || `Rolled back to version ${target.version}`,
      rolledBackFromVersionId: target.id,
      resetDraft: true,
    });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'scenario.rolled_back',
      targetType: 'scenario',
      targetId: s.id,
      metadata: { fromVersionId: target.id, fromVersion: target.version, versionId: version.id, version: version.version },
    });
    return { version: versionSummary(version), scenario: await this.detail(workspaceId, s.id) };
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async archive(workspaceId: string, principal: Principal, scenarioId: string) {
    const s = await this.findScenario(workspaceId, scenarioId);
    await this.prisma.scenario.updateMany({
      where: { id: s.id, workspaceId },
      data: { status: 'ARCHIVED', archivedAt: new Date(), galleryListed: false, updatedById: userIdOf(principal) },
    });
    await this.audit.log({ workspaceId, principal, action: 'scenario.archived', targetType: 'scenario', targetId: s.id });
    return this.detail(workspaceId, scenarioId);
  }

  async unarchive(workspaceId: string, principal: Principal, scenarioId: string) {
    const s = await this.findScenario(workspaceId, scenarioId);
    await this.prisma.scenario.updateMany({
      where: { id: s.id, workspaceId },
      data: { status: s.latestVersionId ? 'PUBLISHED' : 'DRAFT', archivedAt: null, updatedById: userIdOf(principal) },
    });
    await this.audit.log({ workspaceId, principal, action: 'scenario.unarchived', targetType: 'scenario', targetId: s.id });
    return this.detail(workspaceId, scenarioId);
  }

  /** Soft delete: the row, versions and sessions stay (sessions keep their exact version snapshot). */
  async remove(workspaceId: string, principal: Principal, scenarioId: string) {
    const s = await this.findScenario(workspaceId, scenarioId);
    await this.prisma.scenario.updateMany({
      where: { id: s.id, workspaceId },
      data: { deletedAt: new Date(), galleryListed: false, updatedById: userIdOf(principal) },
    });
    await this.audit.log({ workspaceId, principal, action: 'scenario.deleted', targetType: 'scenario', targetId: s.id, metadata: { name: s.name } });
    return { ok: true };
  }

  async setGalleryListed(workspaceId: string, principal: Principal, scenarioId: string, listed: boolean) {
    const s = await this.findScenario(workspaceId, scenarioId);
    if (listed) {
      const problems: string[] = [];
      if (s.privacy !== 'PUBLIC') problems.push('Set privacy to Public first');
      if (!s.latestVersionId || s.status !== 'PUBLISHED') problems.push('Publish the scenario first');
      if (!(await this.publicAllowed(workspaceId))) problems.push('Public scenarios are disabled for this workspace');
      if (problems.length) throw Errors.validation(problems.join('. '), problems.map((m) => ({ path: 'galleryListed', message: m })));
    }
    await this.prisma.scenario.updateMany({ where: { id: s.id, workspaceId }, data: { galleryListed: listed, updatedById: userIdOf(principal) } });
    await this.audit.log({ workspaceId, principal, action: listed ? 'scenario.gallery_listed' : 'scenario.gallery_unlisted', targetType: 'scenario', targetId: s.id });
    return this.detail(workspaceId, scenarioId);
  }

  // ───────────────────────────── export ─────────────────────────────

  async exportConfig(workspaceId: string, principal: Principal, scenarioId: string, q: { format: 'yaml' | 'json'; source: 'draft' | 'version'; versionId?: string }) {
    const s = await this.findScenario(workspaceId, scenarioId);
    let config: unknown;
    let versionNumber: number | null = null;
    if (q.source === 'draft') {
      config = s.draft!.config;
    } else {
      const id = q.versionId ?? s.latestVersionId;
      if (!id) throw Errors.notFound('Published version');
      const v = await this.findVersion(workspaceId, s.id, id);
      config = v.config;
      versionNumber = v.version;
    }
    const body = exportScenarioConfig(config, q.format, { name: s.name, version: versionNumber, source: q.source });
    const filename = `${s.slug}${versionNumber ? `-v${versionNumber}` : '-draft'}.${q.format === 'yaml' ? 'yaml' : 'json'}`;
    await this.audit.log({ workspaceId, principal, action: 'scenario.exported', targetType: 'scenario', targetId: s.id, metadata: { format: q.format, source: q.source, version: versionNumber } });
    return { filename, contentType: q.format === 'yaml' ? 'application/yaml; charset=utf-8' : 'application/json; charset=utf-8', body };
  }

  /** Paths the editor may lock / the assistant may target (exposed for clients). */
  editablePaths() {
    return EDITABLE_FIELD_PATHS;
  }

  /** Config of the draft or a version, for preview. */
  async configFor(workspaceId: string, scenarioId: string, source: 'draft' | 'version', versionId?: string) {
    const s = await this.findScenario(workspaceId, scenarioId);
    if (source === 'draft') {
      const p = parseScenarioConfig(s.draft!.config);
      if (!p.success) throw Errors.validation('The draft has invalid values', zodIssuesToDetails(p.error.issues));
      return { scenario: s, config: p.data, version: null as ScenarioVersion | null };
    }
    const id = versionId ?? s.latestVersionId;
    if (!id) throw Errors.notFound('Published version');
    const v = await this.findVersion(workspaceId, s.id, id);
    return { scenario: s, config: ScenarioConfigSchema.parse(v.config), version: v };
  }
}

// ───────────────────────────── helpers ─────────────────────────────

export function metaFromConfig(c: ScenarioConfig) {
  return {
    name: c.basics.name.trim().slice(0, 120) || 'Untitled scenario',
    type: c.basics.type,
    privacy: c.basics.privacy,
    tags: Array.from(new Set(c.basics.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))).slice(0, 20),
    publicDescription: c.basics.publicDescription.trim() || null,
  };
}

function revisionConflict(currentRevision: number) {
  return new AppError(409, 'revision_conflict', 'The draft was changed by someone else. Reload to get the latest version.', { currentRevision });
}

function versionSummary(v: ScenarioVersion) {
  return {
    id: v.id,
    version: v.version,
    configHash: v.configHash,
    changeNote: v.changeNote,
    publishedAt: v.publishedAt,
    publishedById: v.publishedById,
    rolledBackFromVersionId: v.rolledBackFromVersionId,
    schemaVersion: v.schemaVersion,
  };
}

function publicScenarioRow(s: Scenario) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    type: s.type,
    status: s.status,
    privacy: s.privacy,
    tags: s.tags,
    publicDescription: s.publicDescription,
    isTemplate: s.isTemplate,
    galleryListed: s.galleryListed,
    latestVersionId: s.latestVersionId,
    latestVersionNumber: s.latestVersionNumber,
    createdById: s.createdById,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt,
  };
}
