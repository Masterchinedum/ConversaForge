import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WEBHOOK_EVENTS } from '@cf/shared';
import type { z } from 'zod';
import { CurrentPrincipal, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { PaginationQuery } from '../../common/http/pagination';
import { ZodPipe } from '../../common/http/zod.pipe';
import {
  CreateWebhookSchema,
  DeliveriesQuery,
  RotateSecretSchema,
  UpdateWebhookSchema,
  WebhooksService,
  type CreateWebhookInput,
  type UpdateWebhookInput,
} from './webhooks.service';

/** Workspace UI routes for webhook endpoints (API-key access goes through /api/v1/webhooks). */
@ApiTags('webhooks')
@Controller('workspaces/:workspaceId/webhooks')
@RequireCapability('webhooks.manage')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('events')
  @ApiOperation({ summary: 'List subscribable event types' })
  events() {
    return { data: WEBHOOK_EVENTS };
  }

  @Get()
  list(@Param('workspaceId') ws: string, @Query(new ZodPipe(PaginationQuery)) q: PaginationQuery) {
    return this.webhooks.list(ws, q);
  }

  @Post()
  create(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateWebhookSchema)) body: CreateWebhookInput) {
    return this.webhooks.create(ws, p, body);
  }

  @Get(':id')
  get(@Param('workspaceId') ws: string, @Param('id') id: string) {
    return this.webhooks.get(ws, id);
  }

  @Patch(':id')
  update(
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(UpdateWebhookSchema)) body: UpdateWebhookInput,
  ) {
    return this.webhooks.update(ws, p, id, body);
  }

  @Delete(':id')
  remove(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal) {
    return this.webhooks.remove(ws, p, id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  rotate(
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(RotateSecretSchema)) body: z.infer<typeof RotateSecretSchema>,
  ) {
    return this.webhooks.rotateSecret(ws, p, id, body.overlapHours);
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a signed `ping` event to the endpoint now' })
  test(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal) {
    return this.webhooks.test(ws, p, id);
  }

  @Get(':id/deliveries')
  deliveries(@Param('workspaceId') ws: string, @Param('id') id: string, @Query(new ZodPipe(DeliveriesQuery)) q: z.infer<typeof DeliveriesQuery>) {
    return this.webhooks.listDeliveries(ws, id, q);
  }

  @Get(':id/deliveries/:deliveryId')
  delivery(@Param('workspaceId') ws: string, @Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    return this.webhooks.getDelivery(ws, id, deliveryId);
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  @HttpCode(200)
  redeliver(@Param('workspaceId') ws: string, @Param('id') id: string, @Param('deliveryId') deliveryId: string, @CurrentPrincipal() p: Principal) {
    return this.webhooks.redeliver(ws, p, id, deliveryId);
  }
}
