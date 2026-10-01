import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WEBHOOK_EVENTS, type WebhookEventType } from '@cf/shared';
import type { Job } from 'bullmq';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService, workerRuntime } from '../../common/queue/queue.service';
import { assertSafeUrl, SsrfError } from './ssrf-guard';
import { postJson, type SendResult } from './webhook-http';
import {
  outboxEventId,
  terminalStateToEvent,
  type DeliverableEventType,
  type WebhookEventPayload,
  type WebhookEvaluationData,
  type WebhookExtractionItem,
  type WebhookSessionData,
} from './webhook-payload';
import { decideAfterAttempt, DELIVERY_TIMEOUT_MS, isSuccessStatus, MAX_ATTEMPTS } from './webhook-retry';
import { signatureHeader } from './webhook-signature';

export const USER_AGENT = 'ConversaForge-Webhooks/1.0';

interface ProduceJob {
  workspaceId: string;
  sessionId: string;
  type: WebhookEventType;
  variant: string;
  failure?: { stage: 'session' | 'analysis'; errorCode: string | null };
}
interface DeliverJob {
  deliveryId: string;
  attempt: number;
  manual?: boolean;
}

export interface AttemptReport {
  deliveryId: string;
  attempt: number;
  status: 'SUCCEEDED' | 'RETRYING' | 'FAILED' | 'SKIPPED';
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
}

/**
 * Event production (DomainEvents → OutboxEvent → WebhookDelivery fan-out) and delivery
 * (signed POST, exponential-backoff retries, auto-disable). All steps are idempotent:
 *   - OutboxEvent id is deterministic per (session, type)
 *   - WebhookDelivery is unique per (subscriptionId, eventId)
 *   - delivery attempts are claimed atomically (attempts = n-1 → n) and jobs use id wh_<delivery>_<attempt>
 */
@Injectable()
export class WebhookDispatcherService implements OnModuleInit {
  private readonly logger = new Logger('Webhooks');
  /** Overridable in tests (e.g. to point at a fake sender). */
  sender: typeof postJson = postJson;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly queue: QueueService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.events.on('session.started', (e) => this.enqueueProduce({ ...e, type: 'session.started', variant: '' }));
    this.events.on('session.terminal', (e) => {
      const mapped = terminalStateToEvent(e.state);
      if (!mapped) return;
      return this.enqueueProduce({
        workspaceId: e.workspaceId,
        sessionId: e.sessionId,
        type: mapped.type,
        variant: mapped.variant,
        ...(mapped.type === 'session.failed' ? { failure: { stage: 'session' as const, errorCode: null } } : {}),
      });
    });
    // One event per analysis result: re-processing (a new analysis generation) produces a new event,
    // duplicates of the same result do not.
    this.events.on('session.analyzed', (e) => this.enqueueProduce({ ...pick(e), type: 'session.analyzed', variant: e.evaluationId ?? 'none' }));
    this.events.on('session.extracted', async (e) => {
      const s = await this.prisma.session.findFirst({ where: { id: e.sessionId, workspaceId: e.workspaceId }, select: { analysisGeneration: true } });
      return this.enqueueProduce({ ...pick(e), type: 'session.extracted', variant: `g${s?.analysisGeneration ?? 0}` });
    });
    this.events.on('session.failed', (e) =>
      this.enqueueProduce({ ...pick(e), type: 'session.failed', variant: 'analysis', failure: { stage: 'analysis', errorCode: e.errorCode } }),
    );

    this.queue.process<ProduceJob | DeliverJob | Record<string, never>>(QUEUES.webhooks, async (job: Job) => {
      if (job.name === 'produce') return this.produce(job.data as ProduceJob);
      if (job.name === 'deliver') return this.deliverAttempt(job.data as DeliverJob);
      if (job.name === 'sweep') return this.sweep();
      return undefined;
    });
    if (workerRuntime.enabled) {
      void this.queue
        .queue(QUEUES.webhooks)
        .add('sweep', {}, { repeat: { every: 5 * 60_000 }, jobId: 'wh_sweep', removeOnComplete: true, removeOnFail: true })
        .catch((e) => this.logger.warn(`Could not schedule webhook sweeper: ${e?.message}`));
    }
  }

  // ───────────────────────── production ─────────────────────────

  private async enqueueProduce(data: ProduceJob) {
    await this.queue.enqueue(QUEUES.webhooks, 'produce', data, {
      jobId: `whp_${outboxEventId(data.workspaceId, data.sessionId, data.type, data.variant)}`,
    });
  }

  /** Build the payload, write the OutboxEvent once and fan out deliveries. Returns the event id. */
  async produce(input: ProduceJob): Promise<string | null> {
    const eventId = outboxEventId(input.workspaceId, input.sessionId, input.type, input.variant);
    let event = await this.prisma.outboxEvent.findFirst({ where: { id: eventId, workspaceId: input.workspaceId } });
    if (!event) {
      const data = await this.buildEventData(input);
      if (!data) {
        this.logger.warn(`Session ${input.sessionId} not found for ${input.type}; no event produced`);
        return null;
      }
      const createdAt = new Date();
      const payload: WebhookEventPayload = {
        id: eventId,
        type: input.type,
        createdAt: createdAt.toISOString(),
        workspaceId: input.workspaceId,
        data,
      };
      try {
        event = await this.prisma.outboxEvent.create({
          data: { id: eventId, workspaceId: input.workspaceId, type: input.type, payload: payload as unknown as Prisma.InputJsonValue, createdAt },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        event = await this.prisma.outboxEvent.findFirstOrThrow({ where: { id: eventId, workspaceId: input.workspaceId } });
      }
    }
    await this.fanOut(event);
    return event.id;
  }

  private async fanOut(event: { id: string; workspaceId: string; type: string; payload: Prisma.JsonValue; createdAt: Date }) {
    const subs = await this.prisma.webhookSubscription.findMany({
      where: { workspaceId: event.workspaceId, active: true, events: { has: event.type }, createdAt: { lte: event.createdAt } },
      select: { id: true },
    });
    for (const sub of subs) {
      let delivery = await this.prisma.webhookDelivery.findUnique({
        where: { subscriptionId_eventId: { subscriptionId: sub.id, eventId: event.id } },
      });
      if (!delivery) {
        try {
          delivery = await this.prisma.webhookDelivery.create({
            data: {
              subscriptionId: sub.id,
              workspaceId: event.workspaceId,
              eventId: event.id,
              eventType: event.type,
              payload: event.payload as Prisma.InputJsonValue,
              status: 'PENDING',
              nextAttemptAt: new Date(),
            },
          });
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
          continue; // created concurrently; that producer enqueues it
        }
      }
      if (delivery.status === 'PENDING' && delivery.attempts === 0) {
        await this.enqueueDelivery(delivery.id, 1);
      }
    }
    await this.prisma.outboxEvent.updateMany({ where: { id: event.id, dispatchedAt: null }, data: { dispatchedAt: new Date() } });
  }

  async enqueueDelivery(deliveryId: string, attempt: number, delayMs = 0, manual = false) {
    await this.queue.enqueue(
      QUEUES.webhooks,
      'deliver',
      { deliveryId, attempt, manual } satisfies DeliverJob,
      { jobId: `wh_${deliveryId}_${attempt}${manual ? '_m' : ''}`, delay: delayMs > 0 ? delayMs : undefined, attempts: 3 },
    );
  }

  /** Assemble `data` for a session event; null when the session no longer exists. */
  async buildEventData(input: ProduceJob): Promise<WebhookEventPayload['data'] | null> {
    const s = await this.prisma.session.findFirst({
      where: { id: input.sessionId, workspaceId: input.workspaceId },
      include: {
        participant: { select: { id: true, externalId: true, email: true, name: true } },
        scenarioVersion: { select: { version: true } },
      },
    });
    if (!s) return null;
    const session: WebhookSessionData = {
      id: s.id,
      scenarioId: s.scenarioId,
      scenarioVersionId: s.scenarioVersionId,
      versionNumber: s.scenarioVersion.version,
      state: s.state,
      channel: s.channel,
      participant: { id: s.participant.id, externalId: s.participant.externalId, email: s.participant.email, name: s.participant.name },
      startedAt: s.startedAt?.toISOString() ?? null,
      endedAt: s.endedAt?.toISOString() ?? null,
      durationMs: s.durationMs,
      metadata: (s.metadata as Record<string, unknown>) ?? {},
    };
    const data: WebhookEventPayload['data'] = { session };
    if (input.type === 'session.analyzed') data.evaluation = await this.evaluationData(s.id, input.workspaceId);
    if (input.type === 'session.extracted') data.extraction = await this.extractionData(s.id, input.workspaceId);
    if (input.type === 'session.failed') {
      data.failure = {
        stage: input.failure?.stage ?? 'session',
        errorCode: input.failure?.errorCode ?? (input.failure?.stage === 'analysis' ? null : s.errorCode),
        message: input.failure?.stage === 'analysis' ? s.analysisError : s.errorMessage,
      };
    }
    return data;
  }

  async evaluationData(sessionId: string, workspaceId: string): Promise<WebhookEvaluationData | null> {
    const ev = await this.prisma.evaluation.findFirst({
      where: { sessionId, workspaceId, isCurrent: true },
      orderBy: { createdAt: 'desc' },
      include: { criteria: true },
    });
    if (!ev) return null;
    return {
      id: ev.id,
      overallScore: ev.overallScore,
      scoredWeightPct: ev.scoredWeightPct,
      insufficientEvidence: ev.insufficientEvidence,
      humanReviewRequired: ev.humanReviewRequired,
      simulated: ev.simulated,
      criteria: ev.criteria.map((c) => ({
        criterionId: c.criterionId,
        name: c.name,
        weight: c.weight,
        score: c.score,
        insufficientEvidence: c.insufficientEvidence,
        confidence: c.confidence,
      })),
    };
  }

  async extractionData(sessionId: string, workspaceId: string): Promise<WebhookExtractionItem[]> {
    const rows = await this.prisma.extractionResult.findMany({ where: { sessionId, workspaceId }, orderBy: { key: 'asc' } });
    return rows.map((r) => ({ key: r.key, type: r.type, value: r.value, valid: r.valid, confidence: r.confidence, simulated: r.simulated }));
  }

  // ───────────────────────── delivery ─────────────────────────

  private urlPolicy() {
    return { allowDevLocalhost: env.NODE_ENV === 'development' };
  }

  secretsFor(sub: { encryptedSecret: string; previousEncryptedSecret: string | null; previousSecretExpiresAt: Date | null }): string[] {
    const secrets = [this.crypto.decrypt(sub.encryptedSecret)];
    if (sub.previousEncryptedSecret && sub.previousSecretExpiresAt && sub.previousSecretExpiresAt > new Date()) {
      try {
        secrets.push(this.crypto.decrypt(sub.previousEncryptedSecret));
      } catch {
        /* ignore a corrupt previous secret */
      }
    }
    return secrets;
  }

  /** Execute one attempt of a delivery (idempotent per attempt number). */
  async deliverAttempt(job: DeliverJob): Promise<AttemptReport> {
    const { deliveryId, attempt } = job;
    const manual = !!job.manual;
    const skipped = (error: string): AttemptReport => ({ deliveryId, attempt, status: 'SKIPPED', statusCode: null, error, durationMs: null });

    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { subscription: true } });
    if (!delivery) return skipped('Delivery not found');
    const sub = delivery.subscription;
    if (!manual && delivery.status === 'SUCCEEDED') return skipped('Already delivered');
    if (!manual && !sub.active) {
      await this.prisma.webhookDelivery.updateMany({
        where: { id: deliveryId, status: { in: ['PENDING', 'RETRYING'] } },
        data: { status: 'FAILED', lastError: 'Subscription is disabled', nextAttemptAt: null },
      });
      return skipped('Subscription is disabled');
    }
    // Atomic claim: only one worker may run attempt n.
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, attempts: attempt - 1 },
      data: { attempts: attempt },
    });
    if (claimed.count === 0) return skipped('Attempt already processed');

    const body = JSON.stringify(delivery.payload);
    let result: SendResult;
    try {
      const url = await assertSafeUrl(sub.url, this.urlPolicy());
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-ConversaForge-Event': delivery.eventType,
        'X-ConversaForge-Delivery': delivery.id,
        'X-ConversaForge-Attempt': String(attempt),
        'X-ConversaForge-Signature': signatureHeader(this.secretsFor(sub), body),
      };
      result = await this.sender(url, body, headers, {
        timeoutMs: DELIVERY_TIMEOUT_MS,
        allowLoopback: this.urlPolicy().allowDevLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
      });
    } catch (e: any) {
      const msg = e instanceof SsrfError ? `Blocked: ${e.message}` : `Delivery error: ${e?.message ?? e}`;
      result = { statusCode: null, error: msg, responseSnippet: null, durationMs: 0 };
    }

    const ok = result.statusCode !== null && isSuccessStatus(result.statusCode) && !result.error;
    const error = ok ? null : result.error ?? `HTTP ${result.statusCode}`;
    await this.prisma.webhookDeliveryAttempt
      .create({
        data: {
          deliveryId,
          workspaceId: delivery.workspaceId,
          attempt,
          manual,
          statusCode: result.statusCode,
          error,
          responseSnippet: result.responseSnippet,
          durationMs: result.durationMs,
        },
      })
      .catch((e) => {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      });

    const decision = decideAfterAttempt({
      attempt,
      manual,
      outcome: ok ? { ok: true, statusCode: result.statusCode! } : { ok: false, statusCode: result.statusCode, error: error! },
      failureCount: sub.failureCount,
      disableAfter: env.WEBHOOK_DISABLE_AFTER_FAILURES,
      jitter: Math.random(),
    });

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: decision.status,
        lastStatusCode: result.statusCode,
        lastError: error,
        nextAttemptAt: decision.nextAttemptAt,
        ...(ok ? { deliveredAt: new Date() } : {}),
      },
    });

    if (ok) {
      if (sub.failureCount !== 0) await this.prisma.webhookSubscription.update({ where: { id: sub.id }, data: { failureCount: 0 } });
    } else if (decision.status === 'RETRYING' && decision.nextAttemptAt) {
      await this.enqueueDelivery(deliveryId, attempt + 1, decision.nextAttemptAt.getTime() - Date.now());
    } else if (decision.status === 'FAILED' && !manual) {
      // Increment atomically, then check the threshold against the stored value.
      const updated = await this.prisma.webhookSubscription.update({
        where: { id: sub.id },
        data: { failureCount: { increment: 1 } },
      });
      if (updated.active && updated.failureCount >= env.WEBHOOK_DISABLE_AFTER_FAILURES) await this.autoDisable(updated.id, updated.workspaceId, updated.url, updated.failureCount);
    }

    return { deliveryId, attempt, status: decision.status, statusCode: result.statusCode, error, durationMs: result.durationMs };
  }

  private async autoDisable(subscriptionId: string, workspaceId: string, url: string, failures: number) {
    const reason = `Automatically disabled after ${failures} consecutive failed deliveries`;
    const res = await this.prisma.webhookSubscription.updateMany({
      where: { id: subscriptionId, active: true },
      data: { active: false, disabledAt: new Date(), disabledReason: reason },
    });
    if (!res.count) return;
    this.logger.warn(`Webhook subscription ${subscriptionId} disabled: ${reason}`);
    await this.audit.log({
      workspaceId,
      principal: null,
      action: 'webhook.auto_disabled',
      targetType: 'WebhookSubscription',
      targetId: subscriptionId,
      metadata: { failures },
    });
    const admins = await this.prisma.membership.findMany({ where: { workspaceId, role: { in: ['OWNER', 'ADMIN'] } }, select: { userId: true } });
    if (admins.length) {
      await this.prisma.notification.createMany({
        data: admins.map((a) => ({
          workspaceId,
          userId: a.userId,
          type: 'webhook.disabled',
          title: 'A webhook endpoint was disabled',
          body: `${url} — ${reason}. Fix the endpoint, then re-enable it in API & webhooks.`,
          link: `/w/${workspaceId}/settings/developer`,
        })),
      });
    }
  }

  /** Re-enqueue deliveries whose job was lost (e.g. Redis flushed) — safe because attempts are claimed atomically. */
  async sweep(now = new Date()): Promise<number> {
    const stale = await this.prisma.webhookDelivery.findMany({
      where: { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lt: new Date(now.getTime() - 2 * 60_000) }, attempts: { lt: MAX_ATTEMPTS } },
      select: { id: true, attempts: true },
      take: 500,
    });
    for (const d of stale) await this.enqueueDelivery(d.id, d.attempts + 1);
    // Events whose fan-out was interrupted.
    const undispatched = await this.prisma.outboxEvent.findMany({
      where: { dispatchedAt: null, createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
      take: 200,
    });
    for (const ev of undispatched) await this.fanOut(ev);
    return stale.length + undispatched.length;
  }

  isKnownEvent(t: string): t is WebhookEventType {
    return (WEBHOOK_EVENTS as readonly string[]).includes(t);
  }

  /** Create a ping event + delivery for one subscription and deliver it synchronously. */
  async ping(subscriptionId: string, workspaceId: string): Promise<AttemptReport & { eventId: string }> {
    const eventId = `evt_ping_${this.crypto.randomToken(12)}`;
    const payload: WebhookEventPayload = {
      id: eventId,
      type: 'ping' as DeliverableEventType,
      createdAt: new Date().toISOString(),
      workspaceId,
      data: { ping: { message: 'Test event from ConversaForge', subscriptionId } },
    };
    await this.prisma.outboxEvent.create({
      data: { id: eventId, workspaceId, type: 'ping', payload: payload as unknown as Prisma.InputJsonValue, dispatchedAt: new Date() },
    });
    const delivery = await this.prisma.webhookDelivery.create({
      data: { subscriptionId, workspaceId, eventId, eventType: 'ping', payload: payload as unknown as Prisma.InputJsonValue, status: 'PENDING' },
    });
    const report = await this.deliverAttempt({ deliveryId: delivery.id, attempt: 1, manual: true });
    return { ...report, eventId };
  }
}

function pick(e: { sessionId: string; workspaceId: string }) {
  return { sessionId: e.sessionId, workspaceId: e.workspaceId };
}
