import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UPLOAD_LIMITS } from '@cf/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiScopes, CurrentPrincipal, CurrentUser, CurrentWorkspace, Public, RequireCapability } from '../../common/auth/decorators';
import type { Principal, WorkspaceContext } from '../../common/auth/principal';
import { AppError, Errors } from '../../common/http/errors';
import { PaginationQuery } from '../../common/http/pagination';
import { ZodPipe } from '../../common/http/zod.pipe';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AccountService } from './account.service';
import { AuditLogService, AuditQuery } from './audit-log.service';
import { BillingService } from './billing.service';
import { BrandingService, UpdateBrandingBody } from './branding.service';
import { ChangeRoleBody, InviteBody, MembersService } from './members.service';
import { DataRequestBody, PrivacyService } from './privacy.service';
import { AddTeamMemberBody, TeamBody, TeamsService } from './teams.service';
import { LedgerQuery, QuotaBody, UsageAdminService } from './usage-admin.service';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

function sendCsv(reply: FastifyReply, name: string, csv: string) {
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${name}"`);
  reply.header('Cache-Control', 'no-store');
  reply.send(csv);
}

// ───────────────────────── members & invitations ─────────────────────────

@ApiTags('organization')
@Controller('workspaces/:workspaceId')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('members')
  @RequireCapability('sessions.review')
  @ApiScopes('org:read')
  list(@Param('workspaceId') ws: string) {
    return this.members.list(ws);
  }

  @Patch('members/:membershipId')
  @RequireCapability('members.manage')
  changeRole(
    @Param('workspaceId') ws: string,
    @Param('membershipId') id: string,
    @Body(new ZodPipe(ChangeRoleBody)) body: z.infer<typeof ChangeRoleBody>,
    @CurrentUser() user: UserPrincipal,
    @CurrentWorkspace() ctx: WorkspaceContext,
  ) {
    return this.members.changeRole(ws, id, body.role, user, ctx);
  }

  @Delete('members/:membershipId')
  @RequireCapability('members.manage')
  remove(@Param('workspaceId') ws: string, @Param('membershipId') id: string, @CurrentUser() user: UserPrincipal, @CurrentWorkspace() ctx: WorkspaceContext) {
    return this.members.remove(ws, id, user, ctx);
  }

  /** Any member may leave (except the last owner, and nobody leaves a personal workspace). */
  @Post('leave')
  @HttpCode(200)
  leave(@Param('workspaceId') ws: string, @CurrentUser() user: UserPrincipal) {
    return this.members.leave(ws, user);
  }

  @Get('invitations')
  @RequireCapability('members.manage')
  invitations(@Param('workspaceId') ws: string, @Query('all') all?: string) {
    return this.members.listInvitations(ws, all === 'true');
  }

  @Post('invitations')
  @RequireCapability('members.manage')
  invite(@Param('workspaceId') ws: string, @Body(new ZodPipe(InviteBody)) body: z.infer<typeof InviteBody>, @CurrentUser() user: UserPrincipal, @CurrentWorkspace() ctx: WorkspaceContext) {
    return this.members.invite(ws, body, user, ctx);
  }

  @Post('invitations/:invitationId/resend')
  @RequireCapability('members.manage')
  resend(@Param('workspaceId') ws: string, @Param('invitationId') id: string, @CurrentUser() user: UserPrincipal, @CurrentWorkspace() ctx: WorkspaceContext) {
    return this.members.resend(ws, id, user, ctx);
  }

  @Delete('invitations/:invitationId')
  @RequireCapability('members.manage')
  revokeInvitation(@Param('workspaceId') ws: string, @Param('invitationId') id: string, @CurrentUser() user: UserPrincipal, @CurrentWorkspace() ctx: WorkspaceContext) {
    return this.members.revokeInvitation(ws, id, user, ctx);
  }
}

/** Invitation links (/invite/<token>): public preview, accept requires login. */
@ApiTags('organization')
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly members: MembersService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Get(':token')
  async preview(@Param('token') token: string, @Req() req: FastifyRequest) {
    await this.rateLimit.enforce(`invite:preview:${req.ip}`, 60, 3600);
    return this.members.preview(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  async accept(@Param('token') token: string, @CurrentUser() user: UserPrincipal) {
    await this.rateLimit.enforce(`invite:accept:${user.userId}`, 20, 3600);
    return this.members.accept(token, user);
  }
}

// ───────────────────────── teams ─────────────────────────

@ApiTags('organization')
@Controller('workspaces/:workspaceId/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequireCapability('sessions.review')
  list(@Param('workspaceId') ws: string) {
    return this.teams.list(ws);
  }

  @Get('candidates')
  @RequireCapability('members.manage')
  candidates(@Param('workspaceId') ws: string, @Query('q') q?: string) {
    return this.teams.candidates(ws, q);
  }

  @Get(':teamId')
  @RequireCapability('sessions.review')
  get(@Param('workspaceId') ws: string, @Param('teamId') id: string) {
    return this.teams.get(ws, id);
  }

  @Post()
  @RequireCapability('members.manage')
  create(@Param('workspaceId') ws: string, @Body(new ZodPipe(TeamBody)) body: z.infer<typeof TeamBody>, @CurrentPrincipal() p: Principal) {
    return this.teams.create(ws, body.name, p);
  }

  @Patch(':teamId')
  @RequireCapability('members.manage')
  rename(@Param('workspaceId') ws: string, @Param('teamId') id: string, @Body(new ZodPipe(TeamBody)) body: z.infer<typeof TeamBody>, @CurrentPrincipal() p: Principal) {
    return this.teams.rename(ws, id, body.name, p);
  }

  @Delete(':teamId')
  @RequireCapability('members.manage')
  remove(@Param('workspaceId') ws: string, @Param('teamId') id: string, @CurrentPrincipal() p: Principal) {
    return this.teams.remove(ws, id, p);
  }

  @Post(':teamId/members')
  @RequireCapability('members.manage')
  addMember(
    @Param('workspaceId') ws: string,
    @Param('teamId') id: string,
    @Body(new ZodPipe(AddTeamMemberBody)) body: z.infer<typeof AddTeamMemberBody>,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.teams.addMember(ws, id, body, p);
  }

  @Delete(':teamId/members/:participantId')
  @RequireCapability('members.manage')
  removeMember(@Param('workspaceId') ws: string, @Param('teamId') id: string, @Param('participantId') pid: string, @CurrentPrincipal() p: Principal) {
    return this.teams.removeMember(ws, id, pid, p);
  }
}

// ───────────────────────── branding ─────────────────────────

@ApiTags('organization')
@Controller('workspaces/:workspaceId/branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get(@Param('workspaceId') ws: string) {
    return this.branding.get(ws);
  }

  @Patch()
  @RequireCapability('branding.manage')
  update(@Param('workspaceId') ws: string, @Body(new ZodPipe(UpdateBrandingBody)) body: UpdateBrandingBody, @CurrentPrincipal() p: Principal) {
    return this.branding.update(ws, body, p);
  }

  @Post('logo')
  @RequireCapability('branding.manage')
  async uploadLogo(@Param('workspaceId') ws: string, @Req() req: FastifyRequest, @CurrentPrincipal() p: Principal) {
    const r = req as FastifyRequest & { isMultipart?: () => boolean; file?: (o?: unknown) => Promise<any> };
    if (!r.isMultipart?.() || !r.file) throw new AppError(415, 'unsupported_media_type', 'Upload the logo as multipart/form-data (field "file")');
    const part = await r.file({ limits: { fileSize: UPLOAD_LIMITS.branding.maxBytes, files: 1 } });
    if (!part) throw Errors.validation('No file uploaded');
    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      throw new AppError(413, 'payload_too_large', `Logo must be at most ${UPLOAD_LIMITS.branding.maxBytes / 1024 / 1024} MB`);
    }
    if (part.file?.truncated) throw new AppError(413, 'payload_too_large', `Logo must be at most ${UPLOAD_LIMITS.branding.maxBytes / 1024 / 1024} MB`);
    return this.branding.uploadLogo(ws, { buffer, fileName: part.filename }, p);
  }

  @Delete('logo')
  @RequireCapability('branding.manage')
  removeLogo(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal) {
    return this.branding.removeLogo(ws, p);
  }
}

/** Branding is public by nature (shown on participant pages and in emails). */
@ApiTags('public')
@Controller('public/branding')
@Public()
export class PublicBrandingController {
  constructor(
    private readonly branding: BrandingService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // NB: the param is deliberately not called `workspaceId` — that name triggers the membership guard.
  @Get(':wsId')
  async get(@Param('wsId') ws: string, @Req() req: FastifyRequest) {
    await this.rateLimit.enforce(`pub:branding:${req.ip}`, 600, 3600);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ws)) throw Errors.notFound('Workspace');
    return this.branding.publicBranding(ws);
  }

  @Get(':wsId/logo')
  async logo(@Param('wsId') ws: string, @Res() reply: FastifyReply) {
    const logo = await this.branding.logo(ws);
    if (!logo) throw Errors.notFound('Logo');
    reply.header('Content-Type', logo.mimeType);
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'");
    reply.send(logo.buffer);
  }
}

// ───────────────────────── audit ─────────────────────────

@ApiTags('organization')
@Controller('workspaces/:workspaceId/audit')
@RequireCapability('audit.view')
export class AuditController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  list(@Param('workspaceId') ws: string, @Query(new ZodPipe(AuditQuery)) q: AuditQuery) {
    return this.audit.list(ws, q);
  }

  @Get('export.csv')
  async export(@Param('workspaceId') ws: string, @Query(new ZodPipe(AuditQuery)) q: AuditQuery, @Res() reply: FastifyReply) {
    sendCsv(reply, `audit-${ws}-${new Date().toISOString().slice(0, 10)}.csv`, await this.audit.exportCsv(ws, q));
  }
}

// ───────────────────────── usage, quotas, alerts, billing ─────────────────────────

@ApiTags('usage')
@Controller('workspaces/:workspaceId')
export class UsageController {
  constructor(
    private readonly usage: UsageAdminService,
    private readonly billing: BillingService,
  ) {}

  @Get('usage/summary')
  @RequireCapability('usage.view')
  @ApiScopes('usage:read')
  summary(@Param('workspaceId') ws: string) {
    return this.usage.summary(ws);
  }

  @Get('usage/ledger')
  @RequireCapability('usage.view')
  @ApiScopes('usage:read')
  ledger(@Param('workspaceId') ws: string, @Query(new ZodPipe(LedgerQuery)) q: LedgerQuery) {
    return this.usage.ledger(ws, q);
  }

  @Get('usage/export.csv')
  @RequireCapability('usage.view')
  async export(@Param('workspaceId') ws: string, @Query(new ZodPipe(LedgerQuery)) q: LedgerQuery, @Res() reply: FastifyReply) {
    sendCsv(reply, `usage-${ws}-${new Date().toISOString().slice(0, 10)}.csv`, await this.usage.exportCsv(ws, q));
  }

  @Get('usage/sessions/:sessionId')
  @RequireCapability('usage.view')
  sessionCost(@Param('workspaceId') ws: string, @Param('sessionId') sid: string) {
    return this.usage.sessionCost(ws, sid);
  }

  @Get('quotas')
  @RequireCapability('usage.view')
  quotas(@Param('workspaceId') ws: string) {
    return this.usage.listQuotas(ws);
  }

  @Put('quotas')
  @RequireCapability('usage.manage')
  upsertQuota(@Param('workspaceId') ws: string, @Body(new ZodPipe(QuotaBody)) body: QuotaBody, @CurrentPrincipal() p: Principal) {
    return this.usage.upsertQuota(ws, body, p);
  }

  @Delete('quotas/:quotaId')
  @RequireCapability('usage.manage')
  deleteQuota(@Param('workspaceId') ws: string, @Param('quotaId') id: string, @CurrentPrincipal() p: Principal) {
    return this.usage.deleteQuota(ws, id, p);
  }

  @Get('usage/alerts')
  @RequireCapability('usage.view')
  alerts(@Param('workspaceId') ws: string, @Query('open') open?: string) {
    return this.usage.listAlerts(ws, open !== 'true');
  }

  @Post('usage/alerts/:alertId/acknowledge')
  @HttpCode(200)
  @RequireCapability('usage.view')
  acknowledge(@Param('workspaceId') ws: string, @Param('alertId') id: string, @CurrentPrincipal() p: Principal) {
    return this.usage.acknowledge(ws, id, p);
  }

  @Get('billing')
  @RequireCapability('usage.view')
  billingInfo(@Param('workspaceId') ws: string) {
    return this.billing.get(ws);
  }
}

// ───────────────────────── privacy ─────────────────────────

@ApiTags('privacy')
@Controller('workspaces/:workspaceId/privacy')
@RequireCapability('workspace.manage')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get('requests')
  list(@Param('workspaceId') ws: string, @Query(new ZodPipe(PaginationQuery)) q: PaginationQuery) {
    return this.privacy.list(ws, q);
  }

  @Post('requests')
  create(@Param('workspaceId') ws: string, @Body(new ZodPipe(DataRequestBody)) body: DataRequestBody, @CurrentPrincipal() p: Principal) {
    return this.privacy.create(ws, body, p);
  }

  @Get('requests/:requestId')
  get(@Param('workspaceId') ws: string, @Param('requestId') id: string) {
    return this.privacy.get(ws, id);
  }

  @Post('requests/:requestId/download')
  @HttpCode(200)
  download(@Param('workspaceId') ws: string, @Param('requestId') id: string, @CurrentPrincipal() p: Principal) {
    return this.privacy.downloadUrl(ws, id, p);
  }
}

// ───────────────────────── account ─────────────────────────

@ApiTags('auth')
@Controller('auth/sessions')
export class AccountSessionsController {
  constructor(private readonly account: AccountService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() user: UserPrincipal) {
    return this.account.listSessions(user);
  }

  /** Revoke every session except the current one. */
  @Delete()
  revokeOthers(@CurrentUser() user: UserPrincipal) {
    return this.account.revokeOthers(user);
  }

  @Delete(':sessionId')
  revoke(@CurrentUser() user: UserPrincipal, @Param('sessionId') id: string) {
    return this.account.revokeSession(user, id);
  }
}
