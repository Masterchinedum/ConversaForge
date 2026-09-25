import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type DataRequest } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PaginationQuery, prismaPageArgs, toPage } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService, QUEUES } from '../../common/queue/queue.service';
import { StorageService } from '../../common/storage/storage.service';

export const REDACTED_TEXT = '[redacted — retention policy]';
export const EXPORT_RETENTION_DAYS = 7;
const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED'] as const;
const BATCH = 100;

export const DataRequestBody = z
  .object({
    type: z.enum(['EXPORT', 'DELETE']),
    participantId: z.string().max(64).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    /** Required for DELETE to avoid accidents: must equal the email or participant id. */
    confirm: z.string().max(254).optional(),
  })
  .strict()
  .refine((b) => !!b.participantId !== !!b.email, 'Provide exactly one of participantId or email');
export type DataRequestBody = z.infer<typeof DataRequestBody>;

type Evidence = Array<{ turnSeq?: number; quote?: string; [k: string]: unknown }>;
function stripQuotes(evidence: unknown): Prisma.InputJsonValue {
  if (!Array.isArray(evidence)) return [];
  return (evidence as Evidence).map((e) => (e && typeof e === 'object' ? { ...e, quote: e.quote ? '[redacted]' : e.quote ?? null } : e)) as Prisma.InputJsonValue;
}

/**
 * Privacy & retention:
 *  - retention job: after Session.retentionUntil (or the workspace default retention), recordings and
 *    uploads are deleted from storage and transcript/evidence text is redacted; scores, extracted values
 *    and metadata are kept. Standalone media past MediaAsset.retentionUntil (e.g. exports) is deleted.
 *  - data requests: export or delete everything about a participant (by id or email), asynchronously.
 */
@Injectable()
export class PrivacyService {
  private readonly logger = new Logger('Privacy');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  // ───────────────────────── retention ─────────────────────────

  private async deleteMediaObjects(where: Prisma.MediaAssetWhereInput) {
    let deleted = 0;
    for (;;) {
      const assets = await this.prisma.mediaAsset.findMany({ where: { ...where, status: { not: 'DELETED' } }, include: { parts: true }, take: BATCH });
      if (!assets.length) break;
      for (const a of assets) {
        try {
          this.storage.assertWorkspaceKey(a.workspaceId, a.storageKey);
          await this.storage.delete(a.storageKey).catch(() => undefined);
          for (const p of a.parts) {
            if (p.storageKey.startsWith(`ws/${a.workspaceId}/`)) await this.storage.delete(p.storageKey).catch(() => undefined);
          }
        } catch (e: any) {
          this.logger.error(`Refusing to delete media ${a.id}: ${e?.message}`);
        }
        await this.prisma.mediaAsset.update({ where: { id: a.id }, data: { status: 'DELETED', deletedAt: a.deletedAt ?? new Date(), sizeBytes: BigInt(0) } });
        deleted++;
      }
      if (assets.length < BATCH) break;
    }
    return deleted;
  }

  /** Remove recorded content of one session while keeping scores/metadata. Idempotent. */
  async redactSession(sessionId: string) {
    const media = await this.deleteMediaObjects({ sessionId });
    const turns = await this.prisma.transcriptTurn.updateMany({ where: { sessionId, NOT: { text: REDACTED_TEXT } }, data: { text: REDACTED_TEXT, metadata: {} } });
    await this.prisma.toolEvent.updateMany({ where: { sessionId }, data: { args: {}, result: Prisma.DbNull } });
    const evals = await this.prisma.evaluation.findMany({ where: { sessionId }, select: { id: true } });
    if (evals.length) {
      const criteria = await this.prisma.criterionScore.findMany({ where: { evaluationId: { in: evals.map((e) => e.id) } }, select: { id: true, evidence: true } });
      for (const c of criteria) await this.prisma.criterionScore.update({ where: { id: c.id }, data: { evidence: stripQuotes(c.evidence) } });
    }
    const extractions = await this.prisma.extractionResult.findMany({ where: { sessionId }, select: { id: true, evidence: true } });
    for (const x of extractions) await this.prisma.extractionResult.update({ where: { id: x.id }, data: { evidence: stripQuotes(x.evidence) } });
    // Reports embed transcript excerpts; they are derived data and are removed with the content.
    await this.prisma.sessionReport.deleteMany({ where: { sessionId } });
    await this.prisma.session.update({ where: { id: sessionId }, data: { contentRedactedAt: new Date() } });
    return { media, turns: turns.count };
  }

  async runRetention(now = new Date()) {
    const stats = { sessionsRedacted: 0, turnsRedacted: 0, sessionMediaDeleted: 0, expiredMediaDeleted: 0 };
    const staleCutoff = new Date(now.getTime() - 2 * 86400_000);
    const stateFilter: Prisma.SessionWhereInput = { OR: [{ state: { in: [...TERMINAL_STATES] } }, { createdAt: { lt: staleCutoff } }] };

    const workspaces = await this.prisma.workspace.findMany({ select: { id: true, settings: true } });
    const wsDays = new Map<string, number>();
    const conditions: Prisma.SessionWhereInput[] = [{ retentionUntil: { lte: now } }];
    const cutoff = (days: number) => new Date(now.getTime() - days * 86400_000);
    for (const ws of workspaces) {
      const days = (ws.settings as { defaultRetentionDays?: unknown } | null)?.defaultRetentionDays;
      if (typeof days === 'number' && days > 0) {
        wsDays.set(ws.id, days);
        conditions.push({ workspaceId: ws.id, retentionUntil: null, createdAt: { lt: cutoff(days) } });
      }
    }
    // Sessions without their own retention date also follow the scenario version's recording.retentionDays
    // (the stricter of scenario and workspace default wins).
    const versions = await this.prisma.scenarioVersion.findMany({
      where: { sessions: { some: { contentRedactedAt: null, retentionUntil: null } } },
      select: { id: true, workspaceId: true, config: true },
    });
    for (const v of versions) {
      const days = (v.config as { recording?: { retentionDays?: unknown } } | null)?.recording?.retentionDays;
      if (typeof days === 'number' && days > 0 && days < (wsDays.get(v.workspaceId) ?? Infinity)) {
        conditions.push({ scenarioVersionId: v.id, retentionUntil: null, createdAt: { lt: cutoff(days) } });
      }
    }
    for (;;) {
      const due = await this.prisma.session.findMany({
        where: { contentRedactedAt: null, AND: [{ OR: conditions }, stateFilter] },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });
      if (!due.length) break;
      for (const s of due) {
        const r = await this.redactSession(s.id);
        stats.sessionsRedacted++;
        stats.turnsRedacted += r.turns;
        stats.sessionMediaDeleted += r.media;
      }
      if (due.length < BATCH) break;
    }
    stats.expiredMediaDeleted = await this.deleteMediaObjects({ retentionUntil: { lte: now }, kind: { not: 'BRANDING' } });
    this.logger.log(
      `Retention run: ${stats.sessionsRedacted} session(s) redacted (${stats.turnsRedacted} turns, ${stats.sessionMediaDeleted} media), ${stats.expiredMediaDeleted} expired media deleted`,
    );
    return stats;
  }

  // ───────────────────────── data requests ─────────────────────────

  private dto(r: DataRequest) {
    return {
      id: r.id,
      type: r.type,
      participantId: r.participantId,
      subjectEmail: r.subjectEmail,
      status: r.status,
      error: r.error,
      summary: r.summary,
      hasResult: !!r.resultAssetId,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    };
  }

  async list(workspaceId: string, q: PaginationQuery) {
    const rows = await this.prisma.dataRequest.findMany({ where: { workspaceId }, ...prismaPageArgs(q) });
    const page = toPage(rows, q.limit);
    return { data: page.data.map((r) => this.dto(r)), nextCursor: page.nextCursor };
  }

  async get(workspaceId: string, id: string) {
    const r = await this.prisma.dataRequest.findFirst({ where: { id, workspaceId } });
    if (!r) throw Errors.notFound('Data request');
    return this.dto(r);
  }

  async create(workspaceId: string, body: DataRequestBody, actor: Principal) {
    if (body.participantId) {
      const p = await this.prisma.participant.findFirst({ where: { id: body.participantId, workspaceId } });
      if (!p) throw Errors.notFound('Participant');
    }
    if (body.type === 'DELETE' && (body.confirm ?? '').trim().toLowerCase() !== (body.email ?? body.participantId ?? '').toLowerCase()) {
      throw Errors.validation('Type the email (or participant id) again to confirm deletion', [{ path: 'confirm', message: 'Does not match' }]);
    }
    const r = await this.prisma.dataRequest.create({
      data: {
        workspaceId,
        type: body.type,
        participantId: body.participantId ?? null,
        subjectEmail: body.email ?? null,
        requestedById: actor.kind === 'user' ? actor.userId : null,
      },
    });
    await this.audit.log({
      workspaceId,
      principal: actor,
      action: body.type === 'EXPORT' ? 'privacy.export_requested' : 'privacy.delete_requested',
      targetType: 'data_request',
      targetId: r.id,
      metadata: { participantId: r.participantId, email: r.subjectEmail },
    });
    await this.queue.enqueue(QUEUES.adminMaintenance, 'privacy.request', { requestId: r.id }, { jobId: `datareq_${r.id}` });
    return this.dto(r);
  }

  async downloadUrl(workspaceId: string, id: string, actor: Principal) {
    const r = await this.prisma.dataRequest.findFirst({ where: { id, workspaceId } });
    if (!r) throw Errors.notFound('Data request');
    if (r.type !== 'EXPORT' || r.status !== 'COMPLETED' || !r.resultAssetId) throw Errors.conflict('The export is not ready');
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: r.resultAssetId, workspaceId, kind: 'EXPORT', deletedAt: null, status: 'READY' } });
    if (!asset) throw Errors.gone('This export has expired. Request a new one.');
    await this.audit.log({ workspaceId, principal: actor, action: 'privacy.export_downloaded', targetType: 'data_request', targetId: r.id });
    return { url: await this.storage.signedUrl(asset, 900), expiresInSeconds: 900, fileName: asset.fileName };
  }

  private async subjects(r: DataRequest) {
    if (r.participantId) return this.prisma.participant.findMany({ where: { id: r.participantId, workspaceId: r.workspaceId } });
    if (r.subjectEmail) {
      return this.prisma.participant.findMany({ where: { workspaceId: r.workspaceId, email: { equals: r.subjectEmail, mode: 'insensitive' } } });
    }
    return [];
  }

  /** Queue handler. Idempotent: re-running an export overwrites the same object; deletes converge. */
  async process(requestId: string) {
    const r = await this.prisma.dataRequest.findUnique({ where: { id: requestId } });
    if (!r || r.status === 'COMPLETED') return;
    await this.prisma.dataRequest.update({ where: { id: r.id }, data: { status: 'PROCESSING', startedAt: r.startedAt ?? new Date(), error: null } });
    try {
      const summary = r.type === 'EXPORT' ? await this.runExport(r) : await this.runDelete(r);
      await this.prisma.dataRequest.update({
        where: { id: r.id },
        data: { status: 'COMPLETED', completedAt: new Date(), summary: summary.counts as Prisma.InputJsonValue, resultAssetId: summary.assetId ?? null },
      });
      await this.audit.log({
        workspaceId: r.workspaceId,
        principal: null,
        action: r.type === 'EXPORT' ? 'privacy.export_completed' : 'privacy.delete_completed',
        targetType: 'data_request',
        targetId: r.id,
        metadata: summary.counts,
      });
    } catch (e: any) {
      this.logger.error(`Data request ${r.id} failed: ${e?.message}`);
      await this.prisma.dataRequest.update({ where: { id: r.id }, data: { status: 'FAILED', error: String(e?.message ?? e).slice(0, 500) } });
      throw e;
    }
  }

  private async runExport(r: DataRequest) {
    const participants = await this.subjects(r);
    const ids = participants.map((p) => p.id);
    const sessions = ids.length
      ? await this.prisma.session.findMany({
          where: { workspaceId: r.workspaceId, participantId: { in: ids } },
          include: {
            scenario: { select: { name: true } },
            scenarioVersion: { select: { version: true } },
            turns: { orderBy: { seq: 'asc' }, select: { seq: true, speaker: true, text: true, startedAtMs: true, endedAtMs: true, source: true } },
            evaluations: { include: { criteria: true } },
            extractions: true,
            media: { where: { deletedAt: null }, select: { id: true, kind: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const [facts, profiles, enrollments] = ids.length
      ? await Promise.all([
          this.prisma.memoryFact.findMany({ where: { workspaceId: r.workspaceId, participantId: { in: ids }, deletedAt: null } }),
          this.prisma.coachProfile.findMany({ where: { workspaceId: r.workspaceId, participantId: { in: ids } } }),
          this.prisma.enrollment.findMany({ where: { workspaceId: r.workspaceId, participantId: { in: ids } }, include: { course: { select: { title: true } } } }),
        ])
      : [[], [], []];
    const doc = {
      exportedAt: new Date().toISOString(),
      workspaceId: r.workspaceId,
      request: { id: r.id, participantId: r.participantId, email: r.subjectEmail },
      participants: participants.map((p) => ({ id: p.id, name: p.name, email: p.email, externalId: p.externalId, createdAt: p.createdAt, metadata: p.metadata })),
      sessions: sessions.map((s) => ({
        id: s.id,
        participantId: s.participantId,
        scenario: s.scenario.name,
        scenarioVersion: s.scenarioVersion.version,
        channel: s.channel,
        state: s.state,
        createdAt: s.createdAt,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        variables: s.variables,
        consent: s.consent,
        contentRedactedAt: s.contentRedactedAt,
        transcript: s.turns,
        evaluations: s.evaluations.map((e) => ({
          id: e.id,
          overallScore: e.overallScore,
          summary: e.summary,
          strengths: e.strengths,
          weaknesses: e.weaknesses,
          improvements: e.improvements,
          simulated: e.simulated,
          isCurrent: e.isCurrent,
          createdAt: e.createdAt,
          criteria: e.criteria.map((c) => ({ criterionId: c.criterionId, name: c.name, score: c.score, rationale: c.rationale, evidence: c.evidence })),
        })),
        extractions: s.extractions.map((x) => ({ key: x.key, type: x.type, value: x.value, valid: x.valid, evidence: x.evidence, simulated: x.simulated })),
        media: s.media.map((m) => ({ ...m, sizeBytes: Number(m.sizeBytes) })),
      })),
      coachProfiles: profiles.map((p) => ({ participantId: p.participantId, goals: p.goals, summary: p.summary, memoryEnabled: p.memoryEnabled })),
      memoryFacts: facts.map((f) => ({ participantId: f.participantId, category: f.category, content: f.content, createdAt: f.createdAt, disabled: f.disabled })),
      enrollments: enrollments.map((e) => ({ course: e.course.title, status: e.status, startedAt: e.startedAt, completedAt: e.completedAt })),
    };
    const body = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
    const key = this.storage.key(r.workspaceId, 'exports', `data-request-${r.id}.json`);
    await this.storage.put(key, body, 'application/json');
    const asset = await this.prisma.mediaAsset.upsert({
      where: { storageKey: key },
      create: {
        workspaceId: r.workspaceId,
        kind: 'EXPORT',
        storageKey: key,
        fileName: `participant-data-${r.id}.json`,
        mimeType: 'application/json',
        sizeBytes: BigInt(body.length),
        status: 'READY',
        createdById: r.requestedById,
        retentionUntil: new Date(Date.now() + EXPORT_RETENTION_DAYS * 86400_000),
      },
      update: { sizeBytes: BigInt(body.length), status: 'READY', deletedAt: null, retentionUntil: new Date(Date.now() + EXPORT_RETENTION_DAYS * 86400_000) },
    });
    return {
      assetId: asset.id,
      counts: {
        participants: participants.length,
        sessions: sessions.length,
        transcriptTurns: sessions.reduce((a, s) => a + s.turns.length, 0),
        evaluations: sessions.reduce((a, s) => a + s.evaluations.length, 0),
        extractions: sessions.reduce((a, s) => a + s.extractions.length, 0),
        memoryFacts: facts.length,
        bytes: body.length,
      },
    };
  }

  private async runDelete(r: DataRequest) {
    const participants = await this.subjects(r);
    const counts = { participants: participants.length, sessions: 0, media: 0, memoryFacts: 0, enrollments: 0, accessTokensScrubbed: 0 };
    for (const p of participants) {
      const sessions = await this.prisma.session.findMany({ where: { workspaceId: r.workspaceId, participantId: p.id }, select: { id: true } });
      const sessionIds = sessions.map((s) => s.id);
      if (sessionIds.length) {
        counts.media += await this.deleteMediaObjects({ workspaceId: r.workspaceId, sessionId: { in: sessionIds } });
        await this.prisma.sessionReport.deleteMany({ where: { workspaceId: r.workspaceId, sessionId: { in: sessionIds } } });
        await this.prisma.processingJob.deleteMany({ where: { workspaceId: r.workspaceId, sessionId: { in: sessionIds } } });
        // Cascades to turns, events, tool events, evaluations (+criteria), extractions and media rows.
        const del = await this.prisma.session.deleteMany({ where: { workspaceId: r.workspaceId, id: { in: sessionIds } } });
        counts.sessions += del.count;
        // UsageLedger rows are kept for billing: they carry no personal data (only the now-dangling session id).
      }
      const facts = await this.prisma.memoryFact.deleteMany({ where: { workspaceId: r.workspaceId, participantId: p.id } });
      counts.memoryFacts += facts.count;
      await this.prisma.coachProfile.deleteMany({ where: { workspaceId: r.workspaceId, participantId: p.id } });
      const enr = await this.prisma.enrollment.deleteMany({ where: { workspaceId: r.workspaceId, participantId: p.id } });
      counts.enrollments += enr.count;
      await this.prisma.teamMember.deleteMany({ where: { participantId: p.id, team: { workspaceId: r.workspaceId } } });
      if (p.email) {
        const t = await this.prisma.accessToken.updateMany({
          where: { workspaceId: r.workspaceId, participantEmail: p.email },
          data: { participantEmail: null, participantName: null, participantExternalId: null, revokedAt: new Date() },
        });
        counts.accessTokensScrubbed += t.count;
      }
      // Keep a tombstone row (ids referenced by the anonymized usage ledger), without any PII.
      await this.prisma.participant.update({
        where: { id: p.id },
        data: { name: null, email: null, externalId: null, userId: null, metadata: {}, deletedAt: p.deletedAt ?? new Date() },
      });
    }
    return { assetId: null, counts };
  }
}
