import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentPrincipal, CurrentUser, Public, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { PaginationQuery } from '../../common/http/pagination';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AccessService, EmbedStartBody, MintTokenInput, ParticipantStartBody } from './access.service';
import { CreateGrantBody, GrantsService, SharedStartBody, UpdateGrantBody } from './grants.service';
import { PublicRunService, StartBody } from './public-run.service';
import { CreateLinkBody, ShareLinksService, UpdateLinkBody } from './share-links.service';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

@ApiTags('access')
@Controller('workspaces/:workspaceId/scenarios/:scenarioId/links')
@RequireCapability('scenarios.share')
export class ShareLinksController {
  constructor(private readonly links: ShareLinksService) {}

  @Get()
  list(@Param('workspaceId') ws: string, @Param('scenarioId') sid: string) {
    return this.links.list(ws, sid);
  }

  @Post()
  create(@Param('workspaceId') ws: string, @Param('scenarioId') sid: string, @Body(new ZodPipe(CreateLinkBody)) body: CreateLinkBody, @CurrentPrincipal() p: Principal) {
    return this.links.create(ws, sid, body, p);
  }

  @Patch(':linkId')
  update(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') sid: string,
    @Param('linkId') id: string,
    @Body(new ZodPipe(UpdateLinkBody)) body: UpdateLinkBody,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.links.update(ws, sid, id, body, p);
  }

  @Delete(':linkId')
  revoke(@Param('workspaceId') ws: string, @Param('scenarioId') sid: string, @Param('linkId') id: string, @CurrentPrincipal() p: Principal) {
    return this.links.revoke(ws, sid, id, p);
  }
}

@ApiTags('access')
@Controller('workspaces/:workspaceId/scenarios/:scenarioId/access')
@RequireCapability('scenarios.share')
export class ScenarioAccessController {
  constructor(private readonly links: ShareLinksService) {}

  @Get()
  summary(@Param('workspaceId') ws: string, @Param('scenarioId') sid: string) {
    return this.links.accessSummary(ws, sid);
  }
}

@ApiTags('access')
@Controller('workspaces/:workspaceId/scenarios/:scenarioId/grants')
@RequireCapability('scenarios.share')
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Get()
  list(@Param('workspaceId') ws: string, @Param('scenarioId') sid: string) {
    return this.grants.list(ws, sid);
  }

  @Post()
  create(@Param('workspaceId') ws: string, @Param('scenarioId') sid: string, @Body(new ZodPipe(CreateGrantBody)) body: CreateGrantBody, @CurrentPrincipal() p: Principal) {
    return this.grants.create(ws, sid, body, p);
  }

  @Patch(':grantId')
  update(
    @Param('workspaceId') ws: string,
    @Param('scenarioId') sid: string,
    @Param('grantId') id: string,
    @Body(new ZodPipe(UpdateGrantBody)) body: z.infer<typeof UpdateGrantBody>,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.grants.update(ws, sid, id, body, p);
  }

  @Delete(':grantId')
  revoke(@Param('workspaceId') ws: string, @Param('scenarioId') sid: string, @Param('grantId') id: string, @CurrentPrincipal() p: Principal) {
    return this.grants.revoke(ws, sid, id, p);
  }
}

const TokenListQuery = PaginationQuery.extend({ scenarioId: z.string().max(64).optional(), purpose: z.enum(['EMBED', 'PARTICIPANT']).optional() });

@ApiTags('access')
@Controller('workspaces/:workspaceId/access-tokens')
@RequireCapability('scenarios.share')
export class AccessTokensController {
  constructor(private readonly access: AccessService) {}

  @Get()
  list(@Param('workspaceId') ws: string, @Query(new ZodPipe(TokenListQuery)) q: z.infer<typeof TokenListQuery>) {
    return this.access.list(ws, q);
  }

  /** The plaintext token is only in this response. */
  @Post()
  create(@Param('workspaceId') ws: string, @Body(new ZodPipe(MintTokenInput)) body: MintTokenInput, @CurrentPrincipal() p: Principal) {
    return this.access.mintToken(ws, body, p);
  }

  @Delete(':tokenId')
  revoke(@Param('workspaceId') ws: string, @Param('tokenId') id: string, @CurrentPrincipal() p: Principal) {
    return this.access.revoke(ws, id, p);
  }
}

/** Unauthenticated participant entry points. All rate-limited; all checks happen at use time. */
@ApiTags('public')
@Controller('public')
@Public()
export class PublicAccessController {
  constructor(
    private readonly run: PublicRunService,
    private readonly access: AccessService,
  ) {}

  @Get('links/:token')
  linkLanding(@Param('token') token: string, @Req() req: FastifyRequest) {
    return this.run.linkLanding(token, req.ip);
  }

  @Post('links/:token/sessions')
  startFromLink(@Param('token') token: string, @Body(new ZodPipe(StartBody)) body: StartBody, @Req() req: FastifyRequest) {
    return this.run.startFromLink(token, body, req.ip);
  }

  @Get('scenarios/:scenarioId')
  publicScenario(@Param('scenarioId') id: string, @Req() req: FastifyRequest) {
    return this.run.publicLanding(id, req.ip);
  }

  @Post('scenarios/:scenarioId/sessions')
  startPublic(@Param('scenarioId') id: string, @Body(new ZodPipe(StartBody.omit({ passcode: true }))) body: StartBody, @Req() req: FastifyRequest) {
    return this.run.startPublic(id, body, req.ip);
  }

  @Get('embed/token-info')
  embedInfo(@Headers('authorization') auth: string | undefined, @Req() req: FastifyRequest) {
    return this.access.embedTokenInfo(auth, req.ip);
  }

  @Post('embed/sessions')
  startEmbed(
    @Headers('authorization') auth: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Body(new ZodPipe(EmbedStartBody)) body: EmbedStartBody,
    @Req() req: FastifyRequest,
  ) {
    return this.access.startEmbedSession(auth, origin, body, req.ip);
  }

  @Get('participant-tokens/info')
  participantInfo(@Headers('authorization') auth: string | undefined, @Req() req: FastifyRequest) {
    return this.access.participantTokenInfo(auth, req.ip);
  }

  @Post('participant-tokens/sessions')
  startParticipant(
    @Headers('authorization') auth: string | undefined,
    @Body(new ZodPipe(ParticipantStartBody)) body: z.infer<typeof ParticipantStartBody>,
    @Req() req: FastifyRequest,
  ) {
    return this.access.startParticipantSession(auth, body, req.ip);
  }
}

/** Grantee side: scenarios shared with the logged-in user. */
@ApiTags('access')
@Controller()
export class SharedWithMeController {
  constructor(private readonly grants: GrantsService) {}

  @Get('me/shared-scenarios')
  list(@CurrentUser() user: UserPrincipal) {
    return this.grants.sharedWithMe(user);
  }

  @Post('shared/scenarios/:scenarioId/sessions')
  @HttpCode(201)
  start(@CurrentUser() user: UserPrincipal, @Param('scenarioId') sid: string, @Body(new ZodPipe(SharedStartBody)) body: z.infer<typeof SharedStartBody>) {
    return this.grants.startShared(user, sid, body);
  }

  @Get('shared/scenarios/:scenarioId/sessions')
  sessions(@CurrentUser() user: UserPrincipal, @Param('scenarioId') sid: string, @Query(new ZodPipe(PaginationQuery)) q: PaginationQuery) {
    return this.grants.sharedSessions(user, sid, q);
  }
}
