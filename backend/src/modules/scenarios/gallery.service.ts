import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  defaultScenarioConfig,
  SCENARIO_TEMPLATES,
  SCENARIO_TYPE_LABELS,
  ScenarioConfigSchema,
  substituteVariables,
  type ScenarioConfig,
  type ScenarioTemplate,
  type ScenarioType,
} from '@cf/shared';
import { Errors } from '../../common/http/errors';
import { decodeCursor, encodeCursor } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { GalleryQuery } from './scenarios.schemas';

/**
 * Gallery: built-in templates + published scenarios.
 *
 * PUBLIC SAFETY: public responses are built field-by-field from an allowlist (see `publicCard` /
 * `publicDetail`). Never spread a config or scenario row into a public response — internal description,
 * AI instructions, persona description/role, rubric, extraction, variables, tools, knowledge ids and
 * workspace settings must not leak.
 */

export interface GalleryCard {
  kind: 'template' | 'scenario';
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  publicDescription: string;
  durationMinutes: number;
  personaName: string | null;
  tags: string[];
  workspace?: { name: string; logoUrl: string | null; primaryColor: string | null } | null;
  runUrl?: string | null;
}

function typeLabel(t: string) {
  return SCENARIO_TYPE_LABELS[t as ScenarioType] ?? t;
}

/** Only fields that are meant for anyone to see. */
function publicCard(kind: GalleryCard['kind'], id: string, c: ScenarioConfig): GalleryCard {
  return {
    kind,
    id,
    name: c.basics.name,
    type: c.basics.type,
    typeLabel: typeLabel(c.basics.type),
    publicDescription: c.basics.publicDescription,
    durationMinutes: c.basics.targetDurationMinutes,
    personaName: c.persona.name || null,
    tags: Array.from(new Set(c.basics.tags.map((t) => t.toLowerCase()))),
  };
}

function publicDetail(kind: GalleryCard['kind'], id: string, c: ScenarioConfig) {
  // Placeholders in participant instructions are shown with their defaults or labels, never raw.
  const vars: Record<string, string> = {};
  for (const v of c.variables.allowlist) vars[v.key] = v.defaultValue?.trim() || v.label || v.key;
  return {
    ...publicCard(kind, id, c),
    participantInstructions: substituteVariables(c.basics.participantInstructions, vars),
    maxDurationMinutes: c.conversation.ending.maxDurationMinutes,
    language: c.basics.language,
    recording: { audio: c.recording.audio, video: c.recording.video },
    analysis: c.analysis.enabled,
  };
}

function templateMatches(t: ScenarioTemplate, c: ScenarioConfig, q: { q?: string; type?: string; tag?: string }) {
  if (q.type && c.basics.type !== q.type) return false;
  if (q.tag && !c.basics.tags.map((x) => x.toLowerCase()).includes(q.tag.toLowerCase())) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    const hay = [t.name, t.summary, c.basics.name, c.basics.publicDescription, ...c.basics.tags].join(' ').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

@Injectable()
export class GalleryService {
  private readonly templateConfigs = new Map(SCENARIO_TEMPLATES.map((t) => [t.key, defaultScenarioConfig(t.config)]));

  constructor(private readonly prisma: PrismaService) {}

  templates(q: { q?: string; type?: string; tag?: string } = {}) {
    return SCENARIO_TEMPLATES.filter((t) => templateMatches(t, this.templateConfigs.get(t.key)!, q)).map((t) => ({
      ...publicCard('template', t.key, this.templateConfigs.get(t.key)!),
      name: t.name,
      summary: t.summary,
      templateKey: t.key,
    }));
  }

  templateDetail(key: string) {
    const t = SCENARIO_TEMPLATES.find((x) => x.key === key);
    if (!t) throw Errors.notFound('Template');
    const c = this.templateConfigs.get(key)!;
    return { ...publicDetail('template', key, c), name: t.name, summary: t.summary, templateKey: t.key };
  }

  /** Public gallery: PUBLIC + listed + published scenarios of workspaces that allow public scenarios. */
  async publicList(q: GalleryQuery) {
    const where: Prisma.ScenarioWhereInput = {
      privacy: 'PUBLIC',
      galleryListed: true,
      status: 'PUBLISHED',
      latestVersionId: { not: null },
      deletedAt: null,
      archivedAt: null,
      workspace: { deletedAt: null },
    };
    if (q.type) where.type = q.type;
    if (q.tag) where.tags = { has: q.tag.toLowerCase() };
    if (q.q) {
      where.OR = [
        { name: { contains: q.q, mode: 'insensitive' } },
        { publicDescription: { contains: q.q, mode: 'insensitive' } },
        { tags: { has: q.q.toLowerCase() } },
      ];
    }
    const cursorId = decodeCursor(q.cursor);
    const rows = await this.prisma.scenario.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        workspaceId: true,
        latestVersionId: true,
        workspace: { select: { name: true, settings: true, branding: { select: { displayName: true, logoUrl: true, primaryColor: true } } } },
      },
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const visible = page.filter((r) => (r.workspace.settings as Record<string, unknown> | null)?.allowPublicScenarios !== false);
    const versions = await this.prisma.scenarioVersion.findMany({
      where: { id: { in: visible.map((r) => r.latestVersionId!) } },
      select: { id: true, scenarioId: true, workspaceId: true, config: true },
    });
    const byId = new Map(versions.map((v) => [v.id, v]));
    const data: GalleryCard[] = [];
    for (const r of visible) {
      const v = byId.get(r.latestVersionId!);
      if (!v || v.scenarioId !== r.id || v.workspaceId !== r.workspaceId) continue;
      const parsed = ScenarioConfigSchema.safeParse(v.config);
      if (!parsed.success) continue;
      data.push({
        ...publicCard('scenario', r.id, parsed.data),
        workspace: workspaceBrand(r.workspace),
        runUrl: `/p/${r.id}`,
      });
    }
    return {
      templates: q.cursor ? [] : this.templates(q),
      data,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
    };
  }

  async publicDetail(scenarioId: string) {
    const s = await this.prisma.scenario.findFirst({
      where: {
        id: scenarioId,
        privacy: 'PUBLIC',
        galleryListed: true,
        status: 'PUBLISHED',
        latestVersionId: { not: null },
        deletedAt: null,
        archivedAt: null,
        workspace: { deletedAt: null },
      },
      select: {
        id: true,
        workspaceId: true,
        latestVersionId: true,
        workspace: { select: { name: true, settings: true, branding: { select: { displayName: true, logoUrl: true, primaryColor: true } } } },
      },
    });
    if (!s || (s.workspace.settings as Record<string, unknown> | null)?.allowPublicScenarios === false) throw Errors.notFound('Scenario');
    const v = await this.prisma.scenarioVersion.findFirst({
      where: { id: s.latestVersionId!, scenarioId: s.id, workspaceId: s.workspaceId },
      select: { config: true, version: true },
    });
    const parsed = ScenarioConfigSchema.safeParse(v?.config);
    if (!v || !parsed.success) throw Errors.notFound('Scenario');
    return { ...publicDetail('scenario', s.id, parsed.data), workspace: workspaceBrand(s.workspace), runUrl: `/p/${s.id}` };
  }

  /**
   * Workspace gallery (any member): built-in templates, workspace templates (creators), and
   * published ORGANIZATION/PUBLIC scenarios of this workspace.
   */
  async workspaceGallery(workspaceId: string, canEdit: boolean, q: { q?: string; type?: string; tag?: string }) {
    const where: Prisma.ScenarioWhereInput = {
      workspaceId,
      deletedAt: null,
      archivedAt: null,
      OR: [
        { status: 'PUBLISHED', latestVersionId: { not: null }, privacy: { in: ['ORGANIZATION', 'PUBLIC'] } },
        ...(canEdit ? [{ isTemplate: true }] : []),
      ],
    };
    const and: Prisma.ScenarioWhereInput[] = [];
    if (q.type) and.push({ type: q.type });
    if (q.tag) and.push({ tags: { has: q.tag.toLowerCase() } });
    if (q.q) {
      and.push({
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          { publicDescription: { contains: q.q, mode: 'insensitive' } },
          { tags: { has: q.q.toLowerCase() } },
        ],
      });
    }
    if (and.length) where.AND = and;
    const rows = await this.prisma.scenario.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
      include: { draft: { select: { config: true } } },
    });
    const versionIds = rows.map((r) => r.latestVersionId).filter((x): x is string => !!x);
    const versions = versionIds.length
      ? await this.prisma.scenarioVersion.findMany({ where: { id: { in: versionIds }, workspaceId }, select: { id: true, config: true } })
      : [];
    const byId = new Map(versions.map((v) => [v.id, v.config]));
    const scenarios = rows.flatMap((r) => {
      // Members see the published version; workspace templates without a version show the draft to creators.
      const raw = r.latestVersionId ? byId.get(r.latestVersionId) : canEdit ? r.draft?.config : undefined;
      const parsed = ScenarioConfigSchema.safeParse(raw);
      if (!parsed.success) return [];
      return [
        {
          ...publicCard('scenario', r.id, parsed.data),
          privacy: r.privacy,
          isTemplate: r.isTemplate,
          published: !!r.latestVersionId && r.status === 'PUBLISHED',
          latestVersionNumber: r.latestVersionNumber,
        },
      ];
    });
    return { templates: this.templates(q), scenarios };
  }
}

function workspaceBrand(w: { name: string; branding: { displayName: string | null; logoUrl: string | null; primaryColor: string | null } | null }) {
  return {
    name: w.branding?.displayName || w.name,
    logoUrl: w.branding?.logoUrl ?? null,
    primaryColor: w.branding?.primaryColor ?? null,
  };
}
