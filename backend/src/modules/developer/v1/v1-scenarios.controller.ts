import { Body, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { SCENARIO_TYPES } from '@cf/shared';
import { z } from 'zod';
import { ApiScopes, CurrentWorkspace } from '../../../common/auth/decorators';
import type { WorkspaceContext } from '../../../common/auth/principal';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { ListScenariosQuery, PublishBody, UpdateDraftBody } from '../../scenarios/scenarios.schemas';
import { ScenariosService } from '../../scenarios/scenarios.service';
import { apiKeyOf, V1Controller } from './v1.common';

/**
 * POST /v1/scenarios body. `source: "config"` is a v1 convenience that imports a full ScenarioConfig
 * object (parsed as data, validated with the shared schema) — the other sources are workstream A's.
 */
export const V1CreateScenarioBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('blank'), name: z.string().trim().min(1).max(120), type: z.enum(SCENARIO_TYPES).optional() }),
  z.object({ source: z.literal('template'), templateKey: z.string().min(1).max(80), name: z.string().trim().min(1).max(120).optional() }),
  z.object({ source: z.literal('config'), config: z.record(z.unknown()), name: z.string().trim().min(1).max(120).optional() }),
  z.object({
    source: z.literal('import'),
    text: z.string().min(1).max(210_000),
    format: z.enum(['yaml', 'json', 'auto']).default('auto'),
    name: z.string().trim().min(1).max(120).optional(),
  }),
]);

const V1ListQuery = ListScenariosQuery.pick({ limit: true, cursor: true, q: true, type: true, status: true, tag: true, includeArchived: true, sort: true });

/** Scenarios over the API. Every rule (validation, versioning, immutability) is ScenariosService's. */
@V1Controller('scenarios', 'scenarios')
export class V1ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Get()
  @ApiScopes('scenarios:read')
  @ApiOperation({ summary: 'List scenarios' })
  list(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(V1ListQuery)) q: z.infer<typeof V1ListQuery>) {
    return this.scenarios.list(ws.workspaceId, { ...q, sort: q.sort ?? 'updated' } as ListScenariosQuery);
  }

  @Get(':id')
  @ApiScopes('scenarios:read')
  @ApiOperation({ summary: 'Get a scenario with its draft summary and latest version' })
  async get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    const d = await this.scenarios.detail(ws.workspaceId, id);
    return {
      ...d.scenario,
      latestVersion: d.latestVersion,
      draft: {
        revision: d.draft.revision,
        baseVersionId: d.draft.baseVersionId,
        updatedAt: d.draft.updatedAt,
        hasUnpublishedChanges: d.draftHasUnpublishedChanges,
        canPublish: d.canPublish,
        issues: d.issues,
        config: d.draft.config,
      },
      sessionCount: d.sessionCount,
    };
  }

  @Get(':id/versions')
  @ApiScopes('scenarios:read')
  @ApiOperation({ summary: 'List published versions (newest first)' })
  async versions(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    const r = await this.scenarios.listVersions(ws.workspaceId, id);
    return { data: r.data, nextCursor: null };
  }

  @Get(':id/versions/:versionId')
  @ApiScopes('scenarios:read')
  @ApiOperation({ summary: 'Get an immutable published version including its config' })
  version(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string, @Param('versionId') versionId: string) {
    return this.scenarios.getVersion(ws.workspaceId, id, versionId);
  }

  @Post()
  @ApiScopes('scenarios:write')
  @ApiOperation({ summary: 'Create a scenario (blank, from a template, from a config object or YAML/JSON text)' })
  create(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Body(new ZodPipe(V1CreateScenarioBody)) body: z.infer<typeof V1CreateScenarioBody>) {
    const principal = apiKeyOf(req);
    switch (body.source) {
      case 'config':
        return this.scenarios.create(ws.workspaceId, principal, { source: 'import', text: JSON.stringify(body.config), format: 'json', name: body.name });
      case 'blank':
        return this.scenarios.create(ws.workspaceId, principal, { source: 'blank', name: body.name, type: body.type });
      default:
        return this.scenarios.create(ws.workspaceId, principal, body as any);
    }
  }

  @Patch(':id/draft')
  @ApiScopes('scenarios:write')
  @ApiOperation({ summary: 'Update the draft (full config or path patches) with optimistic concurrency on `revision`' })
  updateDraft(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string, @Body(new ZodPipe(UpdateDraftBody)) body: z.infer<typeof UpdateDraftBody>) {
    return this.scenarios.updateDraft(ws.workspaceId, apiKeyOf(req), id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiScopes('scenarios:write')
  @ApiOperation({ summary: 'Validate and publish the draft as a new immutable version' })
  publish(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string, @Body(new ZodPipe(PublishBody)) body: z.infer<typeof PublishBody>) {
    return this.scenarios.publish(ws.workspaceId, apiKeyOf(req), id, body);
  }
}
