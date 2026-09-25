import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { ApiScopes, CurrentPrincipal, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { ZodPipe } from '../../common/http/zod.pipe';
import { DraftAssistantService } from './draft-assistant.service';
import { compiledPrompt, participantPreview } from './scenario-preview';
import {
  ApplyProposalBody,
  AssistantBody,
  CreateScenarioBody,
  DiffQuery,
  ExportQuery,
  GalleryListBody,
  ImportDraftBody,
  ListScenariosQuery,
  PreviewQuery,
  PublishBody,
  RevertDraftBody,
  RollbackBody,
  UpdateDraftBody,
  UpdateScenarioMetaBody,
  ValidateBody,
} from './scenarios.schemas';
import { ScenariosService } from './scenarios.service';

/**
 * Scenario authoring API. All routes are scoped to a workspace (WorkspaceGuard enforces membership);
 * reading drafts and editing require `scenarios.edit` (CREATOR+), publishing/rollback `scenarios.publish`.
 */
@ApiTags('scenarios')
@Controller('workspaces/:workspaceId/scenarios')
export class ScenariosController {
  constructor(
    private readonly scenarios: ScenariosService,
    private readonly assistant: DraftAssistantService,
  ) {}

  @Get()
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  list(@Param('workspaceId') ws: string, @Query(new ZodPipe(ListScenariosQuery)) q: ListScenariosQuery) {
    return this.scenarios.list(ws, q);
  }

  @Post()
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  create(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateScenarioBody)) body: CreateScenarioBody) {
    return this.scenarios.create(ws, p, body);
  }

  @Get(':scenarioId')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  get(@Param('workspaceId') ws: string, @Param('scenarioId') id: string) {
    return this.scenarios.detail(ws, id);
  }

  @Patch(':scenarioId')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  updateMeta(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(UpdateScenarioMetaBody)) body: z.infer<typeof UpdateScenarioMetaBody>,
  ) {
    return this.scenarios.updateMeta(ws, p, id, body);
  }

  @Delete(':scenarioId')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  remove(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @CurrentPrincipal() p: Principal) {
    return this.scenarios.remove(ws, p, id);
  }

  // ── draft ──

  @Patch(':scenarioId/draft')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  updateDraft(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(UpdateDraftBody)) body: UpdateDraftBody,
  ) {
    return this.scenarios.updateDraft(ws, p, id, body);
  }

  @Post(':scenarioId/draft/import')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  importDraft(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(ImportDraftBody)) body: z.infer<typeof ImportDraftBody>,
  ) {
    return this.scenarios.importIntoDraft(ws, p, id, body);
  }

  @Post(':scenarioId/draft/revert')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  revertDraft(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(RevertDraftBody)) body: z.infer<typeof RevertDraftBody>,
  ) {
    return this.scenarios.revertDraft(ws, p, id, body);
  }

  @Post(':scenarioId/validate')
  @HttpCode(200)
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  validate(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @Body(new ZodPipe(ValidateBody)) body: z.infer<typeof ValidateBody>) {
    return this.scenarios.validate(ws, id, body?.config);
  }

  // ── publish & versions ──

  @Post(':scenarioId/publish')
  @RequireCapability('scenarios.publish')
  @ApiScopes('scenarios:write')
  publish(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(PublishBody)) body: z.infer<typeof PublishBody>,
  ) {
    return this.scenarios.publish(ws, p, id, body ?? {});
  }

  @Get(':scenarioId/versions')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  versions(@Param('workspaceId') ws: string, @Param('scenarioId') id: string) {
    return this.scenarios.listVersions(ws, id);
  }

  @Get(':scenarioId/diff')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  diff(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @Query(new ZodPipe(DiffQuery)) q: z.infer<typeof DiffQuery>) {
    return this.scenarios.diff(ws, id, q.from, q.to);
  }

  @Get(':scenarioId/versions/:versionId')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  version(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @Param('versionId') versionId: string) {
    return this.scenarios.getVersion(ws, id, versionId);
  }

  @Post(':scenarioId/versions/:versionId/rollback')
  @RequireCapability('scenarios.publish')
  @ApiScopes('scenarios:write')
  rollback(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @Param('versionId') versionId: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(RollbackBody)) body: z.infer<typeof RollbackBody>,
  ) {
    return this.scenarios.rollback(ws, p, id, versionId, body ?? {});
  }

  // ── lifecycle ──

  @Post(':scenarioId/archive')
  @HttpCode(200)
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  archive(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @CurrentPrincipal() p: Principal) {
    return this.scenarios.archive(ws, p, id);
  }

  @Post(':scenarioId/unarchive')
  @HttpCode(200)
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:write')
  unarchive(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @CurrentPrincipal() p: Principal) {
    return this.scenarios.unarchive(ws, p, id);
  }

  @Post(':scenarioId/gallery')
  @HttpCode(200)
  @RequireCapability('scenarios.share')
  @ApiScopes('scenarios:write')
  gallery(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(GalleryListBody)) body: z.infer<typeof GalleryListBody>,
  ) {
    return this.scenarios.setGalleryListed(ws, p, id, body.listed);
  }

  // ── export / preview ──

  @Get(':scenarioId/export')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  async export(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(ExportQuery)) q: z.infer<typeof ExportQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const out = await this.scenarios.exportConfig(ws, p, id, q);
    reply.header('Content-Type', out.contentType);
    reply.header('Content-Disposition', `attachment; filename="${out.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    reply.header('Cache-Control', 'no-store');
    return out.body;
  }

  @Get(':scenarioId/preview')
  @RequireCapability('scenarios.edit')
  @ApiScopes('scenarios:read')
  async preview(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @Query(new ZodPipe(PreviewQuery)) q: z.infer<typeof PreviewQuery>) {
    const { config, version } = await this.scenarios.configFor(ws, id, q.source, q.versionId);
    const compiled = compiledPrompt(config);
    return {
      source: q.source,
      version: version ? { id: version.id, version: version.version } : null,
      participant: participantPreview(config),
      prompt: compiled.prompt,
      promptVersion: compiled.version,
      promptNote: compiled.note,
    };
  }

  // ── drafting assistant ──

  @Get(':scenarioId/assistant')
  @RequireCapability('scenarios.edit')
  listProposals(@Param('workspaceId') ws: string, @Param('scenarioId') id: string) {
    return this.assistant.list(ws, id);
  }

  @Post(':scenarioId/assistant')
  @RequireCapability('scenarios.edit')
  propose(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(AssistantBody)) body: z.infer<typeof AssistantBody>,
  ) {
    return this.assistant.propose(ws, p, id, body.instruction);
  }

  @Post(':scenarioId/assistant/:proposalId/apply')
  @HttpCode(200)
  @RequireCapability('scenarios.edit')
  apply(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') id: string,
    @Param('proposalId') proposalId: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(ApplyProposalBody)) body: z.infer<typeof ApplyProposalBody>,
  ) {
    return this.assistant.apply(ws, p, id, proposalId, body?.paths);
  }

  @Post(':scenarioId/assistant/:proposalId/reject')
  @HttpCode(200)
  @RequireCapability('scenarios.edit')
  reject(@Param('workspaceId') ws: string, @Param('scenarioId') id: string, @Param('proposalId') proposalId: string) {
    return this.assistant.reject(ws, id, proposalId);
  }
}
