import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import { ApiScopes, CurrentPrincipal, CurrentUser, CurrentWorkspace, Public, RequireCapability } from '../../common/auth/decorators';
import type { Principal, WorkspaceContext } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { ZodPipe } from '../../common/http/zod.pipe';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { SessionsService } from '../runtime/sessions.service';
import { AnalysisService } from './analysis.service';
import { contentDisposition } from './csv';
import { ExportService } from './export.service';
import { ParticipantReportService } from './participant-report.service';
import { PIPELINE_STEPS, type PipelineStep } from './pipeline.types';
import { ReviewService, SessionListQuery } from './review.service';

const ReviewBody = z.object({ note: z.string().max(4000).optional() });
const IdParam = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

function sid(id: string) {
  if (!IdParam.safeParse(id).success) throw Errors.notFound('Session');
  return id;
}

/** Reviewer-facing session list, detail, review sign-off, reprocessing, deletion and exports. */
@ApiTags('sessions')
@Controller('workspaces/:workspaceId/sessions')
export class SessionReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly analysis: AnalysisService,
    private readonly exports: ExportService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @RequireCapability('sessions.review')
  @ApiScopes('sessions:read')
  list(@CurrentWorkspace() ws: WorkspaceContext, @Query(new ZodPipe(SessionListQuery)) q: SessionListQuery) {
    return this.review.list(ws.workspaceId, q);
  }

  @Get('facets')
  @RequireCapability('sessions.review')
  @ApiScopes('sessions:read')
  facets(@CurrentWorkspace() ws: WorkspaceContext) {
    return this.review.facets(ws.workspaceId);
  }

  @Get('export.csv')
  @RequireCapability('exports.download')
  @ApiScopes('analysis:read')
  async exportList(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodPipe(SessionListQuery)) q: SessionListQuery,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.rateLimit.enforce(`export:list:${ws.workspaceId}`, 30, 60);
    const out = await this.exports.sessionsCsv(ws.workspaceId, q);
    const { cursor: _c, limit: _l, ...filters } = q;
    await this.audit.log({
      workspaceId: ws.workspaceId,
      principal,
      action: 'sessions.exported',
      targetType: 'session',
      metadata: { format: 'csv', rows: out.count, filters },
      ip: req.ip,
    });
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', contentDisposition(out.fileName))
      .header('Cache-Control', 'no-store')
      .send(out.body);
  }

  @Get(':sessionId')
  @RequireCapability('sessions.review')
  @ApiScopes('sessions:read')
  detail(@CurrentWorkspace() ws: WorkspaceContext, @Param('sessionId') sessionId: string) {
    return this.review.detail(ws.workspaceId, sid(sessionId), ws.role);
  }

  /** Evaluation + extraction only (for API consumers). */
  @Get(':sessionId/analysis')
  @RequireCapability('sessions.review')
  @ApiScopes('analysis:read')
  async analysisOnly(@CurrentWorkspace() ws: WorkspaceContext, @Param('sessionId') sessionId: string) {
    const d = await this.review.detail(ws.workspaceId, sid(sessionId), 'REVIEWER');
    return {
      sessionId: d.session.id,
      scenarioVersionId: d.version.id,
      versionNumber: d.version.number,
      processing: d.processing,
      evaluation: d.evaluation,
      extraction: d.extraction,
    };
  }

  @Post(':sessionId/reprocess')
  @HttpCode(202)
  @RequireCapability('sessions.review')
  @ApiScopes('sessions:write')
  async reprocess(@CurrentWorkspace() ws: WorkspaceContext, @CurrentPrincipal() principal: Principal, @Param('sessionId') sessionId: string) {
    await this.rateLimit.enforce(`reprocess:${sid(sessionId)}`, 5, 300, 'This session was reprocessed recently; please wait a few minutes');
    const r = await this.analysis.reprocess(sessionId, ws.workspaceId);
    await this.audit.log({ workspaceId: ws.workspaceId, principal, action: 'session.reprocessed', targetType: 'session', targetId: sessionId, metadata: { generation: r.generation } });
    return r;
  }

  @Post(':sessionId/steps/:step/retry')
  @HttpCode(202)
  @RequireCapability('sessions.review')
  @ApiScopes('sessions:write')
  async retry(@CurrentWorkspace() ws: WorkspaceContext, @CurrentPrincipal() principal: Principal, @Param('sessionId') sessionId: string, @Param('step') step: string) {
    if (!(PIPELINE_STEPS as readonly string[]).includes(step)) throw Errors.notFound('Processing step');
    const r = await this.analysis.retryStep(ws.workspaceId, sid(sessionId), step as PipelineStep);
    await this.audit.log({ workspaceId: ws.workspaceId, principal, action: 'session.step_retried', targetType: 'session', targetId: sessionId, metadata: { step } });
    return r;
  }

  @Post(':sessionId/review')
  @RequireCapability('sessions.review')
  review_(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>,
  ) {
    return this.review.review(ws.workspaceId, sid(sessionId), principal, body.note);
  }

  @Delete(':sessionId')
  @RequireCapability('sessions.delete')
  @ApiScopes('sessions:write')
  remove(@CurrentWorkspace() ws: WorkspaceContext, @CurrentPrincipal() principal: Principal, @Param('sessionId') sessionId: string) {
    return this.review.remove(ws.workspaceId, sid(sessionId), principal);
  }

  @Get(':sessionId/export.pdf')
  @RequireCapability('exports.download')
  @ApiScopes('analysis:read')
  async exportPdf(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.rateLimit.enforce(`export:pdf:${ws.workspaceId}`, 60, 60);
    const d = await this.review.detail(ws.workspaceId, sid(sessionId), 'REVIEWER');
    const out = await this.exports.sessionPdf(d);
    await this.audit.log({ workspaceId: ws.workspaceId, principal, action: 'session.exported', targetType: 'session', targetId: sessionId, metadata: { format: 'pdf' }, ip: req.ip });
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', contentDisposition(out.fileName))
      .header('Cache-Control', 'no-store')
      .send(out.body);
  }

  @Get(':sessionId/export.csv')
  @RequireCapability('exports.download')
  @ApiScopes('analysis:read')
  async exportTranscript(
    @CurrentWorkspace() ws: WorkspaceContext,
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const d = await this.review.detail(ws.workspaceId, sid(sessionId), 'REVIEWER');
    const out = this.exports.transcriptCsv(d);
    await this.audit.log({ workspaceId: ws.workspaceId, principal, action: 'session.exported', targetType: 'session', targetId: sessionId, metadata: { format: 'csv' }, ip: req.ip });
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', contentDisposition(out.fileName))
      .header('Cache-Control', 'no-store')
      .send(out.body);
  }
}

/** Participant-facing reports: by session token (anonymous) or as the logged-in participant. */
@ApiTags('participant')
@Controller()
export class ParticipantReportController {
  constructor(
    private readonly reports: ParticipantReportService,
    private readonly sessions: SessionsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Get('runtime/sessions/:sessionId/report')
  async byToken(@Param('sessionId') sessionId: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.rateLimit.enforce(`report:ip:${req.ip}`, 120, 60);
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) throw Errors.unauthorized('Session token required');
    const session = await this.sessions.verifySessionToken(sid(sessionId), token);
    reply.header('Cache-Control', 'no-store');
    return this.reports.forSession(session);
  }

  @Get('me/sessions')
  mine(
    @CurrentUser() user: Extract<Principal, { kind: 'user' }>,
    @Query(
      new ZodPipe(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(200).optional(),
          workspaceId: z.string().max(64).optional(),
        }),
      ),
    )
    q: { limit: number; cursor?: string; workspaceId?: string },
  ) {
    return this.reports.listForUser(user.userId, q);
  }

  @Get('me/sessions/:sessionId/report')
  myReport(@CurrentUser() user: Extract<Principal, { kind: 'user' }>, @Param('sessionId') sessionId: string) {
    return this.reports.forUser(user.userId, sid(sessionId));
  }
}
