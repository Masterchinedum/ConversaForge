import { Module } from '@nestjs/common';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Webhooks (workstream H): subscriptions, event production from DomainEvents (outbox),
 * signed deliveries with exponential-backoff retries and auto-disable.
 */
@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDispatcherService],
  exports: [WebhooksService, WebhookDispatcherService],
})
export class WebhooksModule {}
