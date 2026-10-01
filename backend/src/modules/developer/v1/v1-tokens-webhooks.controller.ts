import { Body, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { ApiScopes, CurrentWorkspace } from '../../../common/auth/decorators';
import type { WorkspaceContext } from '../../../common/auth/principal';
import { PaginationQuery } from '../../../common/http/pagination';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { AccessService, MintTokenInput } from '../../access/access.service';
import {
  CreateWebhookSchema,
  DeliveriesQuery,
  RotateSecretSchema,
  UpdateWebhookSchema,
  WebhooksService,
  type CreateWebhookInput,
  type UpdateWebhookInput,
} from '../../webhooks/webhooks.service';
import { apiKeyOf, V1Controller } from './v1.common';

/** Embed (`cfe_`) and participant (`cfp_`) access tokens — rules are workstream E's AccessService. */
@V1Controller('access-tokens', 'access tokens')
export class V1AccessTokensController {
  constructor(private readonly access: AccessService) {}

  @Post()
  @ApiScopes('tokens:write')
  @ApiOperation({ summary: 'Mint an embed (cfe_) or participant (cfp_) token; the token is returned once' })
  mint(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Body(new ZodPipe(MintTokenInput)) body: z.infer<typeof MintTokenInput>) {
    return this.access.mintToken(ws.workspaceId, body, apiKeyOf(req));
  }

  @Delete(':id')
  @ApiScopes('tokens:write')
  @ApiOperation({ summary: 'Revoke an access token (checked at use time)' })
  revoke(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string) {
    return this.access.revoke(ws.workspaceId, id, apiKeyOf(req));
  }
}

/** Webhook endpoints over the API (same service and SSRF rules as the settings UI). */
@V1Controller('webhooks', 'webhooks')
export class V1WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @ApiScopes('webhooks:write')
  list(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(PaginationQuery)) q: PaginationQuery) {
    return this.webhooks.list(ws.workspaceId, q);
  }

  @Post()
  @ApiScopes('webhooks:write')
  @ApiOperation({ summary: 'Create a webhook endpoint; the signing secret (whsec_…) is returned once' })
  create(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Body(new ZodPipe(CreateWebhookSchema)) body: CreateWebhookInput) {
    return this.webhooks.create(ws.workspaceId, apiKeyOf(req), body);
  }

  @Get(':id')
  @ApiScopes('webhooks:write')
  get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    return this.webhooks.get(ws.workspaceId, id);
  }

  @Patch(':id')
  @ApiScopes('webhooks:write')
  update(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string, @Body(new ZodPipe(UpdateWebhookSchema)) body: UpdateWebhookInput) {
    return this.webhooks.update(ws.workspaceId, apiKeyOf(req), id, body);
  }

  @Delete(':id')
  @ApiScopes('webhooks:write')
  remove(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string) {
    return this.webhooks.remove(ws.workspaceId, apiKeyOf(req), id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @ApiScopes('webhooks:write')
  rotate(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body(new ZodPipe(RotateSecretSchema)) body: z.infer<typeof RotateSecretSchema>,
  ) {
    return this.webhooks.rotateSecret(ws.workspaceId, apiKeyOf(req), id, body.overlapHours);
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiScopes('webhooks:write')
  @ApiOperation({ summary: 'Send a signed ping event now' })
  test(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string) {
    return this.webhooks.test(ws.workspaceId, apiKeyOf(req), id);
  }

  @Get(':id/deliveries')
  @ApiScopes('webhooks:write')
  deliveries(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string, @Query(new ZodPipe(DeliveriesQuery)) q: z.infer<typeof DeliveriesQuery>) {
    return this.webhooks.listDeliveries(ws.workspaceId, id, q);
  }

  @Get(':id/deliveries/:deliveryId')
  @ApiScopes('webhooks:write')
  delivery(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    return this.webhooks.getDelivery(ws.workspaceId, id, deliveryId);
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  @HttpCode(200)
  @ApiScopes('webhooks:write')
  redeliver(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    return this.webhooks.redeliver(ws.workspaceId, apiKeyOf(req), id, deliveryId);
  }
}
