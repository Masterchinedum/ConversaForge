import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type OutboundCallBatch, type Session } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import { userIdOf, type Principal } from '../../common/auth/principal';
import { AppError, Errors } from '../../common/http/errors';
import { prismaPageArgs, toPage, type PaginationQuery } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService } from '../../common/queue/queue.service';
import { parseVersionConfig } from '../runtime/sessions.service';
import { ChannelProvidersService, TWILIO_MISSING } from './channel-providers.service';
import { CsvError, parseTargetsCsv } from './csv';
import { PhoneService, type CallOutcome } from './phone.service';

export const CreateBatchBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    scenarioId: z.string().min(1).max(64),
    fromNumberId: z.string().min(1).max(64).optional().nullable(),
    scheduledAt: z.coerce.date().optional().nullable(),
    concurrency: z.number().int().min(1).max(10).default(1),
    variables: z.record(z.string().max(2000)).default({}),
  })
  .strict();

export const UploadTargetsBody = z
  .object({
    csv: z.string().min(1).max(1_000_000),
    /** replace = drop existing PENDING targets first. */
    mode: z.enum(['append', 'replace']).default('append'),
  })
  .strict();

export const StartBatchBody = z.object({ scheduledAt: z.coerce.date().optional().nullable() }).strict().default({});

/** A dialing target with no status callback for this long is considered failed. */
const STUCK_DIALING_MS = 15 * 60_000;
const TICK_SAFETY_MS = 30_000;
const EDITABLE = new Set(['DRAFT', 'BLOCKED', 'SCHEDULED']);

/**
 * Batch / scheduled outbound calling. Each target becomes a normal PHONE_OUTBOUND session (analysis,
 * extraction and webhooks run as usual). A scheduler job on QUEUES.channels dials up to `concurrency`
 * calls at a time; Twilio status callbacks update targets and trigger the next dial.
 * Without Twilio (or speech providers / a public URL) the batch is BLOCKED with the reason.
 */
@Injectable()
export class BatchesService {
  private readonly logger = new Logger('CallBatches');

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly phone: PhoneService,
    private readonly providers: ChannelProvidersService,
    private readonly audit: AuditService,
  ) {
    this.phone.onCallOutcome((o, s) => this.onCallOutcome(o, s));
  }

  private async find(workspaceId: string, id: string) {
    const b = await this.prisma.outboundCallBatch.findFirst({ where: { id, workspaceId } });
    if (!b) throw Errors.notFound('Call batch');
    return b;
  }

  async progress(batchId: string) {
    const rows = await this.prisma.outboundCallTarget.groupBy({ by: ['status'], where: { batchId }, _count: { _all: true } });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r._count._all;
    const total = rows.reduce((a, r) => a + r._count._all, 0);
    return { total, ...counts };
  }

  async serialize(b: OutboundCallBatch) {
    return {
      id: b.id,
      name: b.name,
      scenarioId: b.scenarioId,
      fromNumberId: b.fromNumberId,
      scheduledAt: b.scheduledAt,
      status: b.status,
      statusReason: b.statusReason,
      concurrency: b.concurrency,
      variables: b.variables,
      startedAt: b.startedAt,
      completedAt: b.completedAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      progress: await this.progress(b.id),
    };
  }

  async list(workspaceId: string, q: PaginationQuery) {
    const rows = await this.prisma.outboundCallBatch.findMany({ where: { workspaceId }, ...prismaPageArgs(q) });
    const page = toPage(rows, q.limit);
    return { data: await Promise.all(page.data.map((b) => this.serialize(b))), nextCursor: page.nextCursor };
  }

  async get(workspaceId: string, id: string) {
    return this.serialize(await this.find(workspaceId, id));
  }

  async targets(workspaceId: string, batchId: string, q: PaginationQuery & { status?: string }) {
    await this.find(workspaceId, batchId);
    const rows = await this.prisma.outboundCallTarget.findMany({
      where: { batchId, ...(q.status ? { status: q.status } : {}) },
      ...prismaPageArgs(q),
    });
    return toPage(rows, q.limit);
  }

  private async allowlistKeys(workspaceId: string, scenarioId: string) {
    const s = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!s) throw Errors.notFound('Scenario');
    if (!s.latestVersionId) return { keys: [] as string[], config: null };
    const v = await this.prisma.scenarioVersion.findFirst({ where: { id: s.latestVersionId, workspaceId } });
    const config = parseVersionConfig(v?.config);
    return { keys: config.variables.allowlist.map((a) => a.key), config };
  }

  async create(workspaceId: string, principal: Principal, input: z.infer<typeof CreateBatchBody>) {
    const { keys } = await this.allowlistKeys(workspaceId, input.scenarioId);
    const bad = Object.keys(input.variables).filter((k) => !keys.includes(k));
    if (bad.length) throw Errors.validation(`Variables not in the scenario allowlist: ${bad.join(', ')}`);
    if (input.fromNumberId) {
      const n = await this.prisma.phoneNumber.findFirst({ where: { id: input.fromNumberId, workspaceId } });
      if (!n) throw Errors.notFound('Phone number');
    }
    const twilio = await this.providers.twilio(workspaceId);
    const b = await this.prisma.outboundCallBatch.create({
      data: {
        workspaceId,
        scenarioId: input.scenarioId,
        name: input.name,
        fromNumberId: input.fromNumberId ?? null,
        scheduledAt: input.scheduledAt ?? null,
        concurrency: input.concurrency,
        variables: input.variables as Prisma.InputJsonValue,
        status: twilio ? 'DRAFT' : 'BLOCKED',
        statusReason: twilio ? null : TWILIO_MISSING,
        createdById: userIdOf(principal),
      },
    });
    await this.audit.log({ workspaceId, principal, action: 'channel.batch_created', targetType: 'call_batch', targetId: b.id });
    return this.serialize(b);
  }

  async uploadTargets(workspaceId: string, principal: Principal, batchId: string, input: z.infer<typeof UploadTargetsBody>) {
    const b = await this.find(workspaceId, batchId);
    if (!EDITABLE.has(b.status)) throw Errors.conflict(`Targets cannot be changed while the batch is ${b.status}`);
    const { keys } = await this.allowlistKeys(workspaceId, b.scenarioId);
    let parsed;
    try {
      parsed = parseTargetsCsv(input.csv, keys);
    } catch (e) {
      if (e instanceof CsvError) throw Errors.validation(e.message);
      throw e;
    }
    if (input.mode === 'replace') await this.prisma.outboundCallTarget.deleteMany({ where: { batchId, status: 'PENDING' } });
    const existing = new Set((await this.prisma.outboundCallTarget.findMany({ where: { batchId }, select: { phone: true } })).map((t) => t.phone));
    const fresh = parsed.targets.filter((t) => !existing.has(t.phone));
    const total = existing.size + fresh.length;
    if (total > 5000) throw Errors.validation('A batch can have at most 5000 targets');
    if (fresh.length) {
      await this.prisma.outboundCallTarget.createMany({
        data: fresh.map((t) => ({
          batchId,
          phone: t.phone,
          name: t.name,
          email: t.email,
          externalId: t.externalId,
          variables: t.variables as Prisma.InputJsonValue,
        })),
      });
    }
    await this.audit.log({ workspaceId, principal, action: 'channel.batch_targets_uploaded', targetType: 'call_batch', targetId: batchId, metadata: { added: fresh.length, errors: parsed.errors.length } });
    return {
      added: fresh.length,
      skippedExisting: parsed.targets.length - fresh.length,
      duplicatesInFile: parsed.duplicates,
      errors: parsed.errors.slice(0, 200),
      errorCount: parsed.errors.length,
      ignoredColumns: parsed.ignoredColumns,
      batch: await this.serialize(await this.find(workspaceId, batchId)),
    };
  }

  /** Why the batch cannot dial right now (null = ready). */
  private async blockReason(b: OutboundCallBatch): Promise<string | null> {
    if (!(await this.providers.twilio(b.workspaceId))) return TWILIO_MISSING;
    const ready = await this.phone.phoneReadiness(b.workspaceId);
    if (ready) return ready;
    const { config } = await this.allowlistKeys(b.workspaceId, b.scenarioId);
    if (!config) return 'The scenario has no published version.';
    if (!config.channels.phone.enabled) return 'The phone channel is disabled for this scenario.';
    const from = b.fromNumberId
      ? await this.prisma.phoneNumber.findFirst({ where: { id: b.fromNumberId, workspaceId: b.workspaceId } })
      : await this.prisma.phoneNumber.findFirst({ where: { workspaceId: b.workspaceId, provider: 'twilio' } });
    if (!from) return 'Add a Twilio phone number to call from.';
    return null;
  }

  async start(workspaceId: string, principal: Principal, batchId: string, input: z.infer<typeof StartBatchBody>) {
    const b = await this.find(workspaceId, batchId);
    if (!['DRAFT', 'BLOCKED', 'SCHEDULED'].includes(b.status)) throw Errors.conflict(`A ${b.status} batch cannot be started`);
    const pending = await this.prisma.outboundCallTarget.count({ where: { batchId, status: 'PENDING' } });
    if (!pending) throw Errors.conflict('Upload at least one target first');
    const reason = await this.blockReason(b);
    if (reason) {
      const blocked = await this.prisma.outboundCallBatch.update({ where: { id: b.id }, data: { status: 'BLOCKED', statusReason: reason } });
      return this.serialize(blocked);
    }
    const scheduledAt = input.scheduledAt ?? b.scheduledAt;
    const future = scheduledAt && scheduledAt.getTime() > Date.now() + 5_000;
    const updated = await this.prisma.outboundCallBatch.update({
      where: { id: b.id },
      data: { status: future ? 'SCHEDULED' : 'RUNNING', statusReason: null, scheduledAt: scheduledAt ?? null, ...(future ? {} : { startedAt: new Date() }) },
    });
    await this.enqueueTick(b.id, future ? scheduledAt!.getTime() - Date.now() : 0);
    await this.audit.log({ workspaceId, principal, action: 'channel.batch_started', targetType: 'call_batch', targetId: b.id, metadata: { scheduledAt, pending } });
    return this.serialize(updated);
  }

  async cancel(workspaceId: string, principal: Principal, batchId: string) {
    const b = await this.find(workspaceId, batchId);
    if (['COMPLETED', 'CANCELLED'].includes(b.status)) return this.serialize(b);
    await this.prisma.outboundCallTarget.updateMany({ where: { batchId, status: 'PENDING' }, data: { status: 'SKIPPED', lastError: 'Batch cancelled' } });
    const updated = await this.prisma.outboundCallBatch.update({ where: { id: b.id }, data: { status: 'CANCELLED', completedAt: new Date() } });
    await this.audit.log({ workspaceId, principal, action: 'channel.batch_cancelled', targetType: 'call_batch', targetId: b.id });
    return this.serialize(updated);
  }

  async enqueueTick(batchId: string, delayMs = 0) {
    const at = Date.now() + Math.max(0, delayMs);
    await this.queue.enqueue(QUEUES.channels, 'batch_tick', { batchId }, { jobId: `batch_tick_${batchId}_${Math.floor(at / 5000)}`, delay: delayMs > 0 ? delayMs : undefined, attempts: 3 });
  }

  /** Scheduler step (idempotent): dial up to `concurrency` calls, finish the batch when done. */
  async tick(batchId: string, dial = (ws: string, input: Parameters<PhoneService['startOutboundCall']>[2], ctx: { batchId: string; targetId: string }) => this.phone.startOutboundCall(ws, null, input, ctx)) {
    let b = await this.prisma.outboundCallBatch.findUnique({ where: { id: batchId } });
    if (!b || !['RUNNING', 'SCHEDULED'].includes(b.status)) return { dialed: 0, status: b?.status ?? 'missing' };
    if (b.status === 'SCHEDULED') {
      if (b.scheduledAt && b.scheduledAt.getTime() > Date.now() + 5_000) {
        await this.enqueueTick(b.id, b.scheduledAt.getTime() - Date.now());
        return { dialed: 0, status: b.status };
      }
      b = await this.prisma.outboundCallBatch.update({ where: { id: b.id }, data: { status: 'RUNNING', startedAt: b.startedAt ?? new Date() } });
    }
    const reason = await this.blockReason(b);
    if (reason) {
      await this.prisma.outboundCallBatch.update({ where: { id: b.id }, data: { status: 'BLOCKED', statusReason: reason } });
      return { dialed: 0, status: 'BLOCKED' };
    }
    // Stuck dials (no status callback) count as failed.
    await this.prisma.outboundCallTarget.updateMany({
      where: { batchId, status: { in: ['DIALING', 'IN_PROGRESS'] }, updatedAt: { lt: new Date(Date.now() - STUCK_DIALING_MS) } },
      data: { status: 'FAILED', lastError: 'No call status received from Twilio' },
    });
    const inflight = await this.prisma.outboundCallTarget.count({ where: { batchId, status: { in: ['DIALING', 'IN_PROGRESS'] } } });
    let slots = Math.max(0, b.concurrency - inflight);
    let dialed = 0;
    while (slots > 0) {
      const next = await this.prisma.outboundCallTarget.findFirst({ where: { batchId, status: 'PENDING' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (!next) break;
      const claimed = await this.prisma.outboundCallTarget.updateMany({ where: { id: next.id, status: 'PENDING' }, data: { status: 'DIALING', attempts: { increment: 1 } } });
      if (!claimed.count) continue;
      slots--;
      try {
        const res = await dial(
          b.workspaceId,
          {
            to: next.phone,
            scenarioId: b.scenarioId,
            fromNumberId: b.fromNumberId ?? undefined,
            name: next.name ?? undefined,
            email: next.email ?? undefined,
            externalId: next.externalId ?? undefined,
            variables: { ...((b.variables as Record<string, string>) ?? {}), ...((next.variables as Record<string, string>) ?? {}) },
          },
          { batchId: b.id, targetId: next.id },
        );
        await this.prisma.outboundCallTarget.update({ where: { id: next.id }, data: { sessionId: res.sessionId, callSid: res.callSid, lastError: null } });
        dialed++;
      } catch (e: any) {
        const msg = e instanceof AppError ? e.message : String(e?.message ?? e);
        await this.prisma.outboundCallTarget.update({ where: { id: next.id }, data: { status: 'FAILED', lastError: msg.slice(0, 500) } });
        if (e instanceof AppError && e.getStatus() === 503) {
          await this.prisma.outboundCallBatch.update({ where: { id: b.id }, data: { status: 'BLOCKED', statusReason: msg } });
          return { dialed, status: 'BLOCKED' };
        }
      }
    }
    const remaining = await this.prisma.outboundCallTarget.count({ where: { batchId, status: { in: ['PENDING', 'DIALING', 'IN_PROGRESS'] } } });
    if (!remaining) {
      await this.prisma.outboundCallBatch.updateMany({ where: { id: b.id, status: 'RUNNING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
      return { dialed, status: 'COMPLETED' };
    }
    // Safety net in case a status callback is lost.
    await this.enqueueTick(b.id, TICK_SAFETY_MS);
    return { dialed, status: 'RUNNING' };
  }

  /** Twilio status callback outcome → target status, then dial the next target. */
  async onCallOutcome(o: CallOutcome, session: Session) {
    const meta = (session.metadata ?? {}) as any;
    const targetId = meta?.twilio?.targetId;
    const batchId = meta?.twilio?.batchId;
    if (!targetId || !batchId) return;
    const status =
      o.callStatus === 'completed' ? (o.connected ? 'COMPLETED' : 'FAILED') : o.callStatus === 'busy' || o.callStatus === 'no-answer' ? 'NO_ANSWER' : 'FAILED';
    await this.prisma.outboundCallTarget.updateMany({
      where: { id: targetId, batchId, status: { in: ['DIALING', 'IN_PROGRESS'] } },
      data: { status, lastError: status === 'COMPLETED' ? null : `Call ${o.callStatus}${o.connected ? '' : ' (not connected)'}` },
    });
    await this.enqueueTick(batchId);
  }
}
