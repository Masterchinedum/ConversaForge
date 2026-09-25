import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { USAGE_KINDS } from '@cf/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PaginationQuery, prismaPageArgs, toPage } from '../../common/http/pagination';
import { MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { periodKey, QUOTA_METRICS, UsageService, type QuotaMetric } from '../usage/usage.service';
import { toCsv } from './csv';

export const LedgerQuery = PaginationQuery.extend({
  kind: z.enum(USAGE_KINDS).optional(),
  provider: z.string().max(40).optional(),
  sessionId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type LedgerQuery = z.infer<typeof LedgerQuery>;

export const QuotaBody = z
  .object({
    metric: z.enum(QUOTA_METRICS),
    limitValue: z.number().min(0).max(1e15),
    alertThresholdPct: z.number().int().min(1).max(100).default(80),
    hardLimit: z.boolean().default(true),
  })
  .strict();
export type QuotaBody = z.infer<typeof QuotaBody>;

export const LEDGER_EXPORT_MAX_ROWS = 100_000;

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function formatMetric(metric: string, value: number) {
  switch (metric) {
    case 'cost_micros':
      return `$${(value / 1_000_000).toFixed(2)}`;
    case 'storage_bytes':
      return `${(value / 1e9).toFixed(2)} GB`;
    case 'session_minutes':
    case 'telephony_minutes':
      return `${value.toFixed(1)} min`;
    default:
      return String(Math.round(value));
  }
}

@Injectable()
export class UsageAdminService {
  private readonly logger = new Logger('UsageAdmin');

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private ledgerWhere(workspaceId: string, q: Omit<LedgerQuery, 'limit' | 'cursor'>): Prisma.UsageLedgerWhereInput {
    return {
      workspaceId,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
  }

  async ledger(workspaceId: string, q: LedgerQuery) {
    const rows = await this.prisma.usageLedger.findMany({ where: this.ledgerWhere(workspaceId, q), ...prismaPageArgs(q) });
    const page = toPage(rows, q.limit);
    return {
      data: page.data.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        kind: r.kind,
        provider: r.provider,
        model: (r.metadata as Record<string, unknown>)?.model ?? null,
        quantity: r.quantity,
        unit: r.unit,
        costMicros: Number(r.costMicros),
        createdAt: r.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async exportCsv(workspaceId: string, q: Omit<LedgerQuery, 'limit' | 'cursor'>) {
    const rows = await this.prisma.usageLedger.findMany({
      where: this.ledgerWhere(workspaceId, q),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LEDGER_EXPORT_MAX_ROWS,
    });
    return toCsv(
      ['time', 'session_id', 'kind', 'provider', 'model', 'quantity', 'unit', 'estimated_cost_usd'],
      rows.map((r) => [
        r.createdAt,
        r.sessionId,
        r.kind,
        r.provider,
        (r.metadata as Record<string, unknown>)?.model ?? '',
        r.quantity,
        r.unit,
        (Number(r.costMicros) / 1_000_000).toFixed(6),
      ]),
    );
  }

  async summary(workspaceId: string) {
    const since = monthStart();
    const [totals, byKind, byProvider, quotas, openAlerts, topSessions, daily, billing] = await Promise.all([
      this.usage.currentTotals(workspaceId),
      this.prisma.usageLedger.groupBy({ by: ['kind'], where: { workspaceId, createdAt: { gte: since } }, _sum: { quantity: true, costMicros: true } }),
      this.prisma.usageLedger.groupBy({ by: ['provider'], where: { workspaceId, createdAt: { gte: since } }, _sum: { costMicros: true }, _count: { _all: true } }),
      this.prisma.workspaceQuota.findMany({ where: { workspaceId, period: 'month' }, orderBy: { metric: 'asc' } }),
      this.prisma.usageAlert.count({ where: { workspaceId, acknowledgedAt: null } }),
      this.prisma.usageLedger.groupBy({
        by: ['sessionId'],
        where: { workspaceId, createdAt: { gte: since }, sessionId: { not: null } },
        _sum: { costMicros: true },
        orderBy: { _sum: { costMicros: 'desc' } },
        take: 10,
      }),
      this.prisma.$queryRaw<Array<{ day: Date; cost: bigint | null; n: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS day, SUM("costMicros")::bigint AS cost, COUNT(*)::bigint AS n
        FROM "UsageLedger" WHERE "workspaceId" = ${workspaceId} AND "createdAt" >= ${new Date(Date.now() - 30 * 86400_000)}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.billingAccount.findUnique({ where: { workspaceId } }),
    ]);
    const sessionIds = topSessions.map((s) => s.sessionId!).filter(Boolean);
    const sessions = sessionIds.length
      ? await this.prisma.session.findMany({
          where: { id: { in: sessionIds }, workspaceId },
          select: { id: true, createdAt: true, durationMs: true, scenario: { select: { name: true } }, participant: { select: { name: true, email: true } } },
        })
      : [];
    return {
      period: periodKey(),
      periodStart: since,
      totals,
      estimatedCostMicros: totals.cost_micros,
      byKind: byKind.map((k) => ({ kind: k.kind, quantity: k._sum.quantity ?? 0, costMicros: Number(k._sum.costMicros ?? 0) })),
      byProvider: byProvider.map((p) => ({ provider: p.provider, entries: p._count._all, costMicros: Number(p._sum.costMicros ?? 0) })),
      quotas: quotas.map((q) => {
        const used = totals[q.metric as QuotaMetric] ?? 0;
        return { ...this.quotaDto(q), used, pct: q.limitValue > 0 ? Math.round((used / q.limitValue) * 1000) / 10 : null };
      }),
      openAlerts,
      topSessions: topSessions.map((t) => {
        const s = sessions.find((x) => x.id === t.sessionId);
        return {
          sessionId: t.sessionId,
          costMicros: Number(t._sum.costMicros ?? 0),
          scenarioName: s?.scenario.name ?? null,
          participant: s ? s.participant.name ?? s.participant.email ?? 'Anonymous' : null,
          createdAt: s?.createdAt ?? null,
          durationMs: s?.durationMs ?? null,
        };
      }),
      daily: daily.map((d) => ({ day: d.day, costMicros: Number(d.cost ?? 0), entries: Number(d.n) })),
      billing: { plan: billing?.plan ?? 'free', status: billing?.status ?? 'active', provider: billing?.provider ?? env.BILLING_PROVIDER },
    };
  }

  async sessionCost(workspaceId: string, sessionId: string) {
    const s = await this.prisma.session.findFirst({ where: { id: sessionId, workspaceId }, select: { id: true } });
    if (!s) throw Errors.notFound('Session');
    const rows = await this.prisma.usageLedger.groupBy({ by: ['kind', 'provider'], where: { workspaceId, sessionId }, _sum: { quantity: true, costMicros: true } });
    return {
      sessionId,
      totalCostMicros: rows.reduce((a, r) => a + Number(r._sum.costMicros ?? 0), 0),
      items: rows.map((r) => ({ kind: r.kind, provider: r.provider, quantity: r._sum.quantity ?? 0, costMicros: Number(r._sum.costMicros ?? 0) })),
    };
  }

  // ── quotas ──

  private quotaDto(q: { id: string; metric: string; period: string; limitValue: number; alertThresholdPct: number; hardLimit: boolean; updatedAt: Date }) {
    return { id: q.id, metric: q.metric, period: q.period, limitValue: q.limitValue, alertThresholdPct: q.alertThresholdPct, hardLimit: q.hardLimit, updatedAt: q.updatedAt };
  }

  async listQuotas(workspaceId: string) {
    const [quotas, totals] = await Promise.all([this.prisma.workspaceQuota.findMany({ where: { workspaceId }, orderBy: { metric: 'asc' } }), this.usage.currentTotals(workspaceId)]);
    return { data: quotas.map((q) => ({ ...this.quotaDto(q), used: totals[q.metric as QuotaMetric] ?? 0 })) };
  }

  async upsertQuota(workspaceId: string, body: QuotaBody, actor: Principal) {
    const updatedById = actor.kind === 'user' ? actor.userId : null;
    const q = await this.prisma.workspaceQuota.upsert({
      where: { workspaceId_metric_period: { workspaceId, metric: body.metric, period: 'month' } },
      create: { workspaceId, metric: body.metric, period: 'month', limitValue: body.limitValue, alertThresholdPct: body.alertThresholdPct, hardLimit: body.hardLimit, updatedById },
      update: { limitValue: body.limitValue, alertThresholdPct: body.alertThresholdPct, hardLimit: body.hardLimit, updatedById },
    });
    await this.audit.log({ workspaceId, principal: actor, action: 'quota.updated', targetType: 'quota', targetId: q.id, metadata: { ...body } });
    return this.quotaDto(q);
  }

  async deleteQuota(workspaceId: string, id: string, actor: Principal) {
    const q = await this.prisma.workspaceQuota.findFirst({ where: { id, workspaceId } });
    if (!q) throw Errors.notFound('Quota');
    await this.prisma.workspaceQuota.delete({ where: { id: q.id } });
    await this.audit.log({ workspaceId, principal: actor, action: 'quota.deleted', targetType: 'quota', targetId: q.id, metadata: { metric: q.metric } });
    return { ok: true };
  }

  // ── alerts ──

  async listAlerts(workspaceId: string, includeAcknowledged = true) {
    const rows = await this.prisma.usageAlert.findMany({
      where: { workspaceId, ...(includeAcknowledged ? {} : { acknowledgedAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { data: rows };
  }

  async acknowledge(workspaceId: string, id: string, actor: Principal) {
    const a = await this.prisma.usageAlert.findFirst({ where: { id, workspaceId } });
    if (!a) throw Errors.notFound('Alert');
    if (a.acknowledgedAt) return a;
    const row = await this.prisma.usageAlert.update({
      where: { id: a.id },
      data: { acknowledgedAt: new Date(), acknowledgedById: actor.kind === 'user' ? actor.userId : null },
    });
    await this.audit.log({ workspaceId, principal: actor, action: 'usage_alert.acknowledged', targetType: 'usage_alert', targetId: a.id, metadata: { metric: a.metric, thresholdPct: a.thresholdPct } });
    return row;
  }

  /**
   * Maintenance: evaluate quotas for every workspace that has any, then email admins about alerts not
   * yet notified. Idempotent: alerts are unique per (metric, period, threshold) and each one is claimed
   * with a conditional update before its email is sent.
   */
  async checkAllWorkspaces() {
    const ws = await this.prisma.workspaceQuota.findMany({ distinct: ['workspaceId'], select: { workspaceId: true } });
    let checked = 0;
    for (const { workspaceId } of ws) {
      try {
        await this.usage.checkAlerts(workspaceId);
        checked++;
      } catch (e: any) {
        this.logger.error(`checkAlerts failed for ${workspaceId}: ${e?.message}`);
      }
    }
    const notified = await this.notifyPendingAlerts();
    this.logger.log(`Usage alert check: ${checked} workspace(s) checked, ${notified} alert(s) notified`);
    return { checked, notified };
  }

  async notifyPendingAlerts() {
    const pending = await this.prisma.usageAlert.findMany({ where: { notifiedAt: null }, orderBy: { createdAt: 'asc' }, take: 500 });
    let notified = 0;
    for (const alert of pending) {
      const claim = await this.prisma.usageAlert.updateMany({ where: { id: alert.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
      if (!claim.count) continue;
      const [ws, admins, quota] = await Promise.all([
        this.prisma.workspace.findFirst({ where: { id: alert.workspaceId, deletedAt: null }, select: { name: true } }),
        this.prisma.membership.findMany({ where: { workspaceId: alert.workspaceId, role: { in: ['OWNER', 'ADMIN'] }, user: { deletedAt: null } }, include: { user: { select: { id: true, email: true } } } }),
        this.prisma.workspaceQuota.findFirst({ where: { workspaceId: alert.workspaceId, metric: alert.metric, period: 'month' } }),
      ]);
      if (!ws) continue;
      const title =
        alert.thresholdPct >= 100
          ? `${ws.name}: monthly ${alert.metric.replace(/_/g, ' ')} limit reached`
          : `${ws.name}: ${alert.thresholdPct}% of monthly ${alert.metric.replace(/_/g, ' ')} used`;
      const body = `Usage for ${alert.metric.replace(/_/g, ' ')} in ${alert.periodKey} is ${formatMetric(alert.metric, alert.valueAtTrigger)}${
        quota ? ` of a ${formatMetric(alert.metric, quota.limitValue)} ${quota.hardLimit ? 'hard' : 'soft'} limit` : ''
      }.${alert.thresholdPct >= 100 && quota?.hardLimit ? ' New sessions are blocked until the limit is raised or the period resets.' : ''}`;
      const link = `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/w/${alert.workspaceId}/settings/usage`;
      for (const m of admins) {
        await this.prisma.notification
          .create({ data: { workspaceId: alert.workspaceId, userId: m.user.id, type: 'usage.alert', title, body, link: `/w/${alert.workspaceId}/settings/usage` } })
          .catch(() => undefined);
        await this.mail.send({ to: m.user.email, subject: title, text: `${body}\n\nReview usage and quotas: ${link}` }).catch((e) => this.logger.warn(`Alert email failed: ${e?.message}`));
      }
      notified++;
    }
    return notified;
  }
}
