import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ApiScopes, CurrentPrincipal, CurrentWorkspace, RequireCapability } from '../../common/auth/decorators';
import { userIdOf, type Principal, type WorkspaceContext } from '../../common/auth/principal';
import { AuditService } from '../../common/audit/audit.service';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AnalyticsQuery, AnalyticsService } from './analytics.service';

/**
 * Analytics. Any member may call the summary; members without `analytics.view` get their own stats only
 * (the service forces an own-data filter). The CSV export needs `exports.download`.
 */
@ApiTags('analytics')
@Controller('workspaces/:workspaceId/analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  @Get('summary')
  @ApiScopes('analytics:read')
  summary(
    @Param('workspaceId') ws: string,
    @Query(new ZodPipe(AnalyticsQuery)) q: AnalyticsQuery,
    @CurrentPrincipal() p: Principal,
    @CurrentWorkspace() w: WorkspaceContext,
  ) {
    return this.analytics.summary(ws, q, { role: w.role, userId: userIdOf(p) });
  }

  @Get('export.csv')
  @RequireCapability('exports.download')
  @ApiScopes('analytics:read')
  async export(
    @Param('workspaceId') ws: string,
    @Query(new ZodPipe(AnalyticsQuery)) q: AnalyticsQuery,
    @CurrentPrincipal() p: Principal,
    @CurrentWorkspace() w: WorkspaceContext,
    @Res() reply: FastifyReply,
  ) {
    const { csv, rows } = await this.analytics.exportCsv(ws, q, { role: w.role, userId: userIdOf(p) });
    await this.audit.log({
      workspaceId: ws,
      principal: p,
      action: 'analytics.exported',
      targetType: 'workspace',
      targetId: ws,
      metadata: { rows, filters: { from: q.from, to: q.to, scenarioId: q.scenarioId, teamId: q.teamId, channel: q.channel, participantId: q.participantId } },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="sessions-${stamp}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(csv);
  }
}
