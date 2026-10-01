import { Body, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { CHANNELS, PROCESSING_STATUSES, SESSION_STATES } from '@cf/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env';
import { ApiScopes, CurrentWorkspace } from '../../../common/auth/decorators';
import type { WorkspaceContext } from '../../../common/auth/principal';
import { AppError, Errors } from '../../../common/http/errors';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { DomainEvents } from '../../../common/events/domain-events';
import { AuditService } from '../../../common/audit/audit.service';
import { ReviewService, type SessionListQuery } from '../../analysis/review.service';
import { SESSION_TOKEN_TTL_MS, SessionsService } from '../../runtime/sessions.service';
import { apiKeyOf, jsonSafe, V1Controller } from './v1.common';

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(500)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).max(values.length))
    .optional();

export const V1SessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  scenarioId: z.string().max(64).optional(),
  versionId: z.string().max(64).optional(),
  participantId: z.string().max(64).optional(),
  externalId: z.string().max(200).optional(),
  email: z.string().trim().toLowerCase().max(320).optional(),
  state: csv(SESSION_STATES),
  channel: csv(CHANNELS),
  analysisStatus: csv(PROCESSING_STATUSES),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const Scalar = z.union([z.string().max(4000), z.number(), z.boolean()]);
export const V1CreateSessionBody = z
  .object({
    scenarioId: z.string().min(1).max(64),
    versionId: z.string().min(1).max(64).optional(),
    participant: z
      .object({
        externalId: z.string().trim().min(1).max(200).optional(),
        email: z.string().trim().toLowerCase().email().max(254).optional(),
        name: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .refine((p) => !!(p.externalId || p.email), 'participant.externalId or participant.email is required'),
    variables: z.record(Scalar).default({}),
    metadata: z
      .record(z.unknown())
      .default({})
      .refine((m) => JSON.stringify(m).length <= 8000, 'metadata must be at most 8 KB of JSON'),
  })
  .strict();

const CANCELLABLE = ['CREATED', 'READY', 'CONNECTING'] as const;

/** Sessions, transcripts and analysis results over the API (read paths share workstream D's rules). */
@V1Controller('sessions', 'sessions')
export class V1SessionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly review: ReviewService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
  ) {}

  private async find(workspaceId: string, id: string) {
    const s = await this.prisma.session.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: {
        participant: { select: { id: true, externalId: true, email: true, name: true } },
        scenario: { select: { id: true, name: true } },
        scenarioVersion: { select: { id: true, version: true } },
      },
    });
    if (!s) throw Errors.notFound('Session');
    return s;
  }

  @Get()
  @ApiScopes('sessions:read')
  @ApiOperation({ summary: 'List sessions (newest first) with filters and cursor pagination' })
  async list(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(V1SessionsQuery)) q: z.infer<typeof V1SessionsQuery>) {
    let participantId = q.participantId;
    if (q.externalId || q.email) {
      const p = await this.prisma.participant.findFirst({
        where: { workspaceId: ws.workspaceId, ...(q.externalId ? { externalId: q.externalId } : {}), ...(q.email ? { email: q.email } : {}) },
        select: { id: true },
      });
      if (!p) return { data: [], nextCursor: null };
      if (participantId && participantId !== p.id) return { data: [], nextCursor: null };
      participantId = p.id;
    }
    if (q.cursor) {
      // A cursor from another workspace must not be usable to probe ids.
      const id = Buffer.from(q.cursor, 'base64url').toString('utf8');
      const ok = await this.prisma.session.count({ where: { id, workspaceId: ws.workspaceId } });
      if (!ok) throw Errors.badRequest('Invalid cursor');
    }
    const query: SessionListQuery = {
      limit: q.limit,
      cursor: q.cursor,
      scenarioId: q.scenarioId,
      versionId: q.versionId,
      participantId,
      state: q.state,
      channel: q.channel,
      analysisStatus: q.analysisStatus,
      from: q.from,
      to: q.to,
    } as SessionListQuery;
    return this.review.list(ws.workspaceId, query);
  }

  @Get(':id')
  @ApiScopes('sessions:read')
  @ApiOperation({ summary: 'Get a session: state, version, participant, timing and usage' })
  async get(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    const s = await this.find(ws.workspaceId, id);
    const usage = await this.prisma.usageLedger.groupBy({
      by: ['kind', 'provider', 'unit'],
      where: { workspaceId: ws.workspaceId, sessionId: s.id },
      _sum: { quantity: true, costMicros: true },
    });
    const info = (s.providerInfo ?? {}) as Record<string, any>;
    return jsonSafe({
      id: s.id,
      state: s.state,
      stateReason: s.stateReason,
      endedBy: s.endedBy,
      channel: s.channel,
      scenario: s.scenario,
      scenarioVersionId: s.scenarioVersionId,
      versionNumber: s.scenarioVersion.version,
      participant: s.participant,
      variables: s.variables,
      metadata: s.metadata,
      timing: { createdAt: s.createdAt, startedAt: s.startedAt, endedAt: s.endedAt, durationMs: s.durationMs, maxDurationSec: s.maxDurationSec },
      analysisStatus: s.analysisStatus,
      analysisError: s.analysisError,
      errorCode: s.errorCode,
      errorMessage: s.errorMessage,
      runtime: { voiceMode: info.voiceMode ?? null, llmProvider: info.llm?.provider ?? null, simulated: !!info.simulated, simulatedParts: info.simulatedParts ?? [] },
      usage: {
        totalCostMicros: usage.reduce((a, u) => a + Number(u._sum.costMicros ?? 0), 0),
        items: usage.map((u) => ({ kind: u.kind, provider: u.provider, unit: u.unit, quantity: u._sum.quantity ?? 0, costMicros: Number(u._sum.costMicros ?? 0) })),
      },
    });
  }

  @Get(':id/transcript')
  @ApiScopes('sessions:read')
  @ApiOperation({ summary: 'Transcript turns in order' })
  async transcript(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    const s = await this.find(ws.workspaceId, id);
    const turns = await this.prisma.transcriptTurn.findMany({ where: { sessionId: s.id }, orderBy: { seq: 'asc' }, take: 10_000 });
    return {
      sessionId: s.id,
      state: s.state,
      data: turns.map((t) => ({
        seq: t.seq,
        speaker: t.speaker,
        text: t.text,
        startedAtMs: t.startedAtMs,
        endedAtMs: t.endedAtMs,
        interrupted: t.interrupted,
        source: t.source,
        createdAt: t.createdAt,
      })),
    };
  }

  @Post()
  @ApiScopes('sessions:write')
  @ApiOperation({ summary: 'Create a session for a participant; returns a one-time participant URL' })
  async create(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Body(new ZodPipe(V1CreateSessionBody)) body: z.infer<typeof V1CreateSessionBody>) {
    const key = apiKeyOf(req);
    const scenario = await this.prisma.scenario.findFirst({ where: { id: body.scenarioId, workspaceId: ws.workspaceId, deletedAt: null }, select: { id: true } });
    if (!scenario) throw Errors.notFound('Scenario');
    const { session, sessionToken } = await this.sessions.createSession({
      workspaceId: ws.workspaceId,
      scenarioId: scenario.id,
      versionId: body.versionId ?? null,
      channel: 'API',
      participant: { externalId: body.participant.externalId ?? null, email: body.participant.email ?? null, name: body.participant.name ?? null },
      variables: body.variables,
      metadata: { ...body.metadata, createdByApiKeyId: key.apiKeyId },
    });
    await this.audit.log({ workspaceId: ws.workspaceId, principal: key, action: 'session.created_via_api', targetType: 'session', targetId: session.id });
    const web = env.WEB_PUBLIC_URL.replace(/\/$/, '');
    return {
      sessionId: session.id,
      state: session.state,
      scenarioVersionId: session.scenarioVersionId,
      participantId: session.participantId,
      sessionToken,
      url: `${web}/live/${session.id}#t=${sessionToken}`,
      tokenExpiresAt: new Date(session.createdAt.getTime() + SESSION_TOKEN_TTL_MS),
    };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiScopes('sessions:write')
  @ApiOperation({ summary: 'Cancel a session that has not started yet' })
  async cancel(@CurrentWorkspace() ws: WorkspaceContext, @Req() req: FastifyRequest, @Param('id') id: string) {
    const key = apiKeyOf(req);
    const s = await this.find(ws.workspaceId, id);
    if (s.state === 'CANCELLED') return { id: s.id, state: s.state };
    if (!(CANCELLABLE as readonly string[]).includes(s.state)) {
      throw new AppError(409, 'session_not_cancellable', `A session in state ${s.state} cannot be cancelled (only ${CANCELLABLE.join(', ')})`);
    }
    const res = await this.prisma.session.updateMany({
      where: { id: s.id, workspaceId: ws.workspaceId, state: { in: [...CANCELLABLE] } },
      data: { state: 'CANCELLED', stateReason: 'cancelled_via_api', endedBy: 'admin', endedAt: new Date(), resumeExpiresAt: new Date() },
    });
    if (!res.count) throw new AppError(409, 'session_not_cancellable', 'The session changed state; fetch it again');
    await this.prisma.sessionEvent.create({ data: { sessionId: s.id, type: 'state.changed', payload: { from: s.state, to: 'CANCELLED', reason: 'cancelled_via_api', apiKeyId: key.apiKeyId } } });
    await this.audit.log({ workspaceId: ws.workspaceId, principal: key, action: 'session.cancelled_via_api', targetType: 'session', targetId: s.id });
    this.events.emit('session.terminal', { sessionId: s.id, workspaceId: ws.workspaceId, state: 'CANCELLED' });
    return { id: s.id, state: 'CANCELLED' };
  }

  // ───────────── analysis ─────────────

  @Get(':id/evaluation')
  @ApiScopes('analysis:read')
  @ApiOperation({ summary: 'Current rubric evaluation with criterion scores and transcript evidence' })
  async evaluation(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    const d = await this.review.detail(ws.workspaceId, id, 'REVIEWER');
    if (!d.evaluation) throw new AppError(404, 'not_found', `No evaluation yet (analysis status: ${d.processing.status})`);
    return { sessionId: id, analysisStatus: d.processing.status, ...d.evaluation };
  }

  @Get(':id/extraction')
  @ApiScopes('analysis:read')
  @ApiOperation({ summary: 'Extracted structured variables' })
  async extraction(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    const d = await this.review.detail(ws.workspaceId, id, 'REVIEWER');
    return { sessionId: id, analysisStatus: d.processing.status, data: d.extraction };
  }

  @Get(':id/report')
  @ApiScopes('analysis:read')
  @ApiOperation({ summary: 'Generated session report' })
  async report(@CurrentWorkspace() ws: WorkspaceContext, @Param('id') id: string) {
    const d = await this.review.detail(ws.workspaceId, id, 'REVIEWER');
    if (!d.report) throw new AppError(404, 'not_found', `No report yet (analysis status: ${d.processing.status})`);
    return { sessionId: id, analysisStatus: d.processing.status, report: d.report };
  }
}
