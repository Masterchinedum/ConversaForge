import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma, type UsageKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DomainEvents } from '../../common/events/domain-events';
import { Errors } from '../../common/http/errors';
import { estimateCostMicros } from './pricing';

export const QUOTA_METRICS = ['session_minutes', 'cost_micros', 'sessions', 'storage_bytes', 'telephony_minutes'] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

export function periodKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function periodStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Usage ledger: every billable unit (tokens, minutes, characters, bytes) is recorded once with an
 * idempotency key, so retries and reconnects never double-charge.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger('Usage');
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
  ) {}

  async record(entry: {
    workspaceId: string;
    sessionId?: string | null;
    kind: UsageKind;
    provider: string;
    model?: string;
    quantity: number;
    unit: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!Number.isFinite(entry.quantity) || entry.quantity <= 0) return false;
    const costMicros = estimateCostMicros(entry.kind, entry.provider, entry.model, entry.quantity);
    try {
      await this.prisma.usageLedger.create({
        data: {
          workspaceId: entry.workspaceId,
          sessionId: entry.sessionId ?? null,
          kind: entry.kind,
          provider: entry.provider,
          quantity: entry.quantity,
          unit: entry.unit,
          costMicros: BigInt(costMicros),
          idempotencyKey: entry.idempotencyKey,
          metadata: { ...(entry.metadata ?? {}), model: entry.model } as Prisma.InputJsonValue,
        },
      });
      this.events.emit('usage.recorded', { workspaceId: entry.workspaceId, sessionId: entry.sessionId ?? null });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false; // duplicate → already charged
      throw e;
    }
  }

  /** Record LLM token usage (input + output) with derived idempotency keys. */
  async recordLlm(
    workspaceId: string,
    sessionId: string | null,
    usage: { provider: string; model: string; inputTokens: number; outputTokens: number },
    idempotencyKey: string,
    analysis = false,
  ) {
    if (usage.provider === 'simulator') return;
    await this.record({
      workspaceId,
      sessionId,
      kind: analysis ? 'ANALYSIS_INPUT_TOKENS' : 'LLM_INPUT_TOKENS',
      provider: usage.provider,
      model: usage.model,
      quantity: usage.inputTokens,
      unit: 'tokens',
      idempotencyKey: `${idempotencyKey}:in`,
    });
    await this.record({
      workspaceId,
      sessionId,
      kind: analysis ? 'ANALYSIS_OUTPUT_TOKENS' : 'LLM_OUTPUT_TOKENS',
      provider: usage.provider,
      model: usage.model,
      quantity: usage.outputTokens,
      unit: 'tokens',
      idempotencyKey: `${idempotencyKey}:out`,
    });
  }

  /** Current-period totals for quota metrics. */
  async currentTotals(workspaceId: string, now = new Date()): Promise<Record<QuotaMetric, number>> {
    const since = periodStart(now);
    const [ledger, sessions] = await Promise.all([
      this.prisma.usageLedger.groupBy({
        by: ['kind'],
        where: { workspaceId, createdAt: { gte: since } },
        _sum: { quantity: true, costMicros: true },
      }),
      this.prisma.session.count({ where: { workspaceId, createdAt: { gte: since }, state: { notIn: ['CANCELLED', 'EXPIRED'] } } }),
    ]);
    const sum = (k: UsageKind) => ledger.find((l) => l.kind === k)?._sum.quantity ?? 0;
    const cost = ledger.reduce((s, l) => s + Number(l._sum.costMicros ?? 0), 0);
    const storage = await this.prisma.mediaAsset.aggregate({
      where: { workspaceId, deletedAt: null, status: { in: ['READY', 'PROCESSING', 'UPLOADING'] } },
      _sum: { sizeBytes: true },
    });
    return {
      session_minutes: sum('SESSION_SECONDS') / 60,
      cost_micros: cost,
      sessions,
      storage_bytes: Number(storage._sum.sizeBytes ?? 0),
      telephony_minutes: sum('TELEPHONY_SECONDS') / 60,
    };
  }

  /**
   * Throws 402 when a hard quota for the metric is exhausted. Call before starting billable work.
   * Also raises alerts when thresholds are crossed.
   */
  async assertWithinQuota(workspaceId: string, metrics: QuotaMetric[] = ['session_minutes', 'cost_micros', 'sessions']) {
    const quotas = await this.prisma.workspaceQuota.findMany({ where: { workspaceId, metric: { in: metrics }, period: 'month' } });
    if (!quotas.length) return;
    const totals = await this.currentTotals(workspaceId);
    for (const q of quotas) {
      const value = totals[q.metric as QuotaMetric] ?? 0;
      await this.maybeAlert(workspaceId, q.metric, value, q.limitValue, q.alertThresholdPct);
      if (q.hardLimit && value >= q.limitValue) {
        throw Errors.quota(`This workspace has reached its monthly ${q.metric.replace('_', ' ')} limit`, {
          metric: q.metric,
          limit: q.limitValue,
          used: value,
        });
      }
    }
  }

  async checkAlerts(workspaceId: string) {
    const quotas = await this.prisma.workspaceQuota.findMany({ where: { workspaceId, period: 'month' } });
    if (!quotas.length) return;
    const totals = await this.currentTotals(workspaceId);
    for (const q of quotas) await this.maybeAlert(workspaceId, q.metric, totals[q.metric as QuotaMetric] ?? 0, q.limitValue, q.alertThresholdPct);
  }

  private async maybeAlert(workspaceId: string, metric: string, value: number, limit: number, thresholdPct: number) {
    if (limit <= 0) return;
    const pct = (value / limit) * 100;
    for (const t of [thresholdPct, 100]) {
      if (pct < t) continue;
      try {
        await this.prisma.usageAlert.create({
          data: { workspaceId, metric, periodKey: periodKey(), thresholdPct: t, valueAtTrigger: value },
        });
        this.logger.warn(`Usage alert: workspace ${workspaceId} ${metric} at ${pct.toFixed(0)}% of limit`);
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
  }
}

@Global()
@Module({ providers: [UsageService], exports: [UsageService] })
export class UsageCoreModule {}
