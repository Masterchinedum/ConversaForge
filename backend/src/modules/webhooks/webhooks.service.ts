import { Injectable } from '@nestjs/common';
import type { Prisma, WebhookSubscription } from '@prisma/client';
import { WEBHOOK_EVENTS } from '@cf/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { userIdOf } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { prismaPageArgs, toPage, type PaginationQuery } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertSafeUrl, SsrfError } from './ssrf-guard';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const MAX_SUBSCRIPTIONS_PER_WORKSPACE = 20;

const EventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, 'Select at least one event')
  .max(WEBHOOK_EVENTS.length)
  .transform((a) => Array.from(new Set(a)));

export const CreateWebhookSchema = z
  .object({
    url: z.string().trim().min(1).max(2000),
    events: EventsSchema,
    description: z.string().trim().max(500).optional().nullable(),
    active: z.boolean().optional(),
  })
  .strict();
export type CreateWebhookInput = z.infer<typeof CreateWebhookSchema>;

export const UpdateWebhookSchema = z
  .object({
    url: z.string().trim().min(1).max(2000).optional(),
    events: EventsSchema.optional(),
    description: z.string().trim().max(500).optional().nullable(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookSchema>;

export const RotateSecretSchema = z
  .object({
    /** Hours the previous secret keeps signing (second v1= value). 0 = revoke immediately. */
    overlapHours: z.number().int().min(0).max(168).default(24),
  })
  .strict()
  .default({});

export const DeliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'RETRYING', 'FAILED']).optional(),
  eventType: z.string().max(40).optional(),
});

export function serializeSubscription(s: WebhookSubscription) {
  return {
    id: s.id,
    url: s.url,
    description: s.description,
    events: s.events,
    active: s.active,
    failureCount: s.failureCount,
    disabledAt: s.disabledAt,
    disabledReason: s.disabledReason,
    previousSecretExpiresAt: s.previousSecretExpiresAt && s.previousSecretExpiresAt > new Date() ? s.previousSecretExpiresAt : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Webhook subscription management (workspace UI + /api/v1/webhooks). */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  private async checkUrl(url: string) {
    try {
      return (await assertSafeUrl(url, { allowDevLocalhost: env.NODE_ENV === 'development' })).toString();
    } catch (e) {
      if (e instanceof SsrfError) throw Errors.validation(e.message, [{ path: 'url', message: e.message }]);
      throw e;
    }
  }

  private newSecret() {
    return WEBHOOK_SECRET_PREFIX + this.crypto.randomToken(24);
  }

  private async find(workspaceId: string, id: string) {
    const s = await this.prisma.webhookSubscription.findFirst({ where: { id, workspaceId } });
    if (!s) throw Errors.notFound('Webhook');
    return s;
  }

  async list(workspaceId: string, q: PaginationQuery) {
    const rows = await this.prisma.webhookSubscription.findMany({ where: { workspaceId }, ...prismaPageArgs(q) });
    const page = toPage(rows, q.limit);
    return { data: page.data.map(serializeSubscription), nextCursor: page.nextCursor };
  }

  async get(workspaceId: string, id: string) {
    return serializeSubscription(await this.find(workspaceId, id));
  }

  async create(workspaceId: string, principal: Principal, input: CreateWebhookInput) {
    const count = await this.prisma.webhookSubscription.count({ where: { workspaceId } });
    if (count >= MAX_SUBSCRIPTIONS_PER_WORKSPACE) throw Errors.conflict(`A workspace can have at most ${MAX_SUBSCRIPTIONS_PER_WORKSPACE} webhook endpoints`);
    const url = await this.checkUrl(input.url);
    const secret = this.newSecret();
    const s = await this.prisma.webhookSubscription.create({
      data: {
        workspaceId,
        url,
        description: input.description ?? null,
        events: input.events,
        active: input.active ?? true,
        encryptedSecret: this.crypto.encrypt(secret),
        createdById: userIdOf(principal),
      },
    });
    await this.audit.log({ workspaceId, principal, action: 'webhook.created', targetType: 'WebhookSubscription', targetId: s.id, metadata: { url, events: input.events } });
    return { ...serializeSubscription(s), secret };
  }

  async update(workspaceId: string, principal: Principal, id: string, input: UpdateWebhookInput) {
    const existing = await this.find(workspaceId, id);
    const data: Prisma.WebhookSubscriptionUpdateInput = {};
    if (input.url !== undefined && input.url !== existing.url) data.url = await this.checkUrl(input.url);
    if (input.events !== undefined) data.events = input.events;
    if (input.description !== undefined) data.description = input.description;
    if (input.active !== undefined) {
      data.active = input.active;
      if (input.active && !existing.active) {
        // Re-enabling resets the failure counter.
        data.failureCount = 0;
        data.disabledAt = null;
        data.disabledReason = null;
      } else if (!input.active && existing.active) {
        data.disabledAt = new Date();
        data.disabledReason = 'Disabled manually';
      }
    }
    const s = await this.prisma.webhookSubscription.update({ where: { id: existing.id }, data });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'webhook.updated',
      targetType: 'WebhookSubscription',
      targetId: id,
      metadata: { fields: Object.keys(input), active: s.active },
    });
    return serializeSubscription(s);
  }

  async remove(workspaceId: string, principal: Principal, id: string) {
    const existing = await this.find(workspaceId, id);
    await this.prisma.webhookSubscription.delete({ where: { id: existing.id } });
    await this.audit.log({ workspaceId, principal, action: 'webhook.deleted', targetType: 'WebhookSubscription', targetId: id, metadata: { url: existing.url } });
    return { ok: true };
  }

  async rotateSecret(workspaceId: string, principal: Principal, id: string, overlapHours: number) {
    const existing = await this.find(workspaceId, id);
    const secret = this.newSecret();
    const s = await this.prisma.webhookSubscription.update({
      where: { id: existing.id },
      data: {
        encryptedSecret: this.crypto.encrypt(secret),
        previousEncryptedSecret: overlapHours > 0 ? existing.encryptedSecret : null,
        previousSecretExpiresAt: overlapHours > 0 ? new Date(Date.now() + overlapHours * 3600_000) : null,
      },
    });
    await this.audit.log({ workspaceId, principal, action: 'webhook.secret_rotated', targetType: 'WebhookSubscription', targetId: id, metadata: { overlapHours } });
    return { ...serializeSubscription(s), secret };
  }

  async test(workspaceId: string, principal: Principal, id: string) {
    const s = await this.find(workspaceId, id);
    const report = await this.dispatcher.ping(s.id, workspaceId);
    await this.audit.log({ workspaceId, principal, action: 'webhook.tested', targetType: 'WebhookSubscription', targetId: id, metadata: { status: report.status, statusCode: report.statusCode } });
    return report;
  }

  async listDeliveries(workspaceId: string, subscriptionId: string, q: z.infer<typeof DeliveriesQuery>) {
    await this.find(workspaceId, subscriptionId);
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { workspaceId, subscriptionId, ...(q.status ? { status: q.status } : {}), ...(q.eventType ? { eventType: q.eventType } : {}) },
      select: {
        id: true,
        eventId: true,
        eventType: true,
        status: true,
        attempts: true,
        lastStatusCode: true,
        lastError: true,
        nextAttemptAt: true,
        deliveredAt: true,
        createdAt: true,
        updatedAt: true,
      },
      ...prismaPageArgs(q),
    });
    return toPage(rows, q.limit);
  }

  async getDelivery(workspaceId: string, subscriptionId: string, deliveryId: string) {
    const d = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, subscriptionId, workspaceId },
      include: { attemptLog: { orderBy: { attempt: 'asc' } } },
    });
    if (!d) throw Errors.notFound('Delivery');
    const { attemptLog, subscriptionId: _s, ...rest } = d;
    return { ...rest, subscriptionId, attemptLog: attemptLog.map(({ workspaceId: _w, ...a }) => a) };
  }

  async redeliver(workspaceId: string, principal: Principal, subscriptionId: string, deliveryId: string) {
    const sub = await this.find(workspaceId, subscriptionId);
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, subscriptionId: sub.id, workspaceId } });
    if (!d) throw Errors.notFound('Delivery');
    if (d.status === 'PENDING' || d.status === 'RETRYING') {
      throw Errors.conflict('This delivery is still being retried automatically; wait for it to finish or fail');
    }
    await this.audit.log({ workspaceId, principal, action: 'webhook.redelivered', targetType: 'WebhookDelivery', targetId: d.id });
    // Deliver now (manual attempts never schedule automatic retries).
    return this.dispatcher.deliverAttempt({ deliveryId: d.id, attempt: d.attempts + 1, manual: true });
  }
}
