import { Body, Controller, Delete, Get, Header, HttpCode, Injectable, OnModuleInit, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentPrincipal, Public, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { PaginationQuery, prismaPageArgs, toPage } from '../../common/http/pagination';
import { ZodPipe } from '../../common/http/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService } from '../../common/queue/queue.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { BatchesService, CreateBatchBody, StartBatchBody, UploadTargetsBody } from './batches.service';
import { ChannelProvidersService } from './channel-providers.service';
import { CreateMeetingBotBody, MeetingsService } from './meetings.service';
import { CreatePhoneNumberBody, PhoneNumbersService, UpdatePhoneNumberBody } from './phone-numbers.service';
import { OutboundCallBody, PhoneService, type OutboundCallInput, type TwilioParams } from './phone.service';

const TargetsQuery = PaginationQuery.extend({ status: z.enum(['PENDING', 'DIALING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'NO_ANSWER', 'SKIPPED']).optional() });

/** Channel administration (phone numbers, calls, batches, meeting bots). */
@ApiTags('channels')
@Controller('workspaces/:workspaceId/channels')
@RequireCapability('channels.manage')
export class ChannelsController {
  constructor(
    private readonly providers: ChannelProvidersService,
    private readonly numbers: PhoneNumbersService,
    private readonly phone: PhoneService,
    private readonly batches: BatchesService,
    private readonly meetings: MeetingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('availability')
  @ApiOperation({ summary: 'Which channel providers are configured (never simulated)' })
  availability(@Param('workspaceId') ws: string) {
    return this.providers.availability(ws);
  }

  // ── phone numbers ──
  @Get('phone-numbers')
  listNumbers(@Param('workspaceId') ws: string) {
    return this.numbers.list(ws);
  }
  @Post('phone-numbers')
  addNumber(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreatePhoneNumberBody)) body: z.infer<typeof CreatePhoneNumberBody>) {
    return this.numbers.create(ws, p, body);
  }
  @Patch('phone-numbers/:id')
  updateNumber(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(UpdatePhoneNumberBody)) body: z.infer<typeof UpdatePhoneNumberBody>) {
    return this.numbers.update(ws, p, id, body);
  }
  @Delete('phone-numbers/:id')
  removeNumber(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal) {
    return this.numbers.remove(ws, p, id);
  }

  // ── calls ──
  @Get('calls')
  @ApiOperation({ summary: 'Recent phone sessions' })
  async calls(@Param('workspaceId') ws: string, @Query(new ZodPipe(PaginationQuery)) q: PaginationQuery) {
    const rows = await this.prisma.session.findMany({
      where: { workspaceId: ws, deletedAt: null, channel: { in: ['PHONE_INBOUND', 'PHONE_OUTBOUND'] } },
      select: {
        id: true,
        channel: true,
        state: true,
        stateReason: true,
        errorCode: true,
        errorMessage: true,
        externalRef: true,
        startedAt: true,
        endedAt: true,
        durationMs: true,
        createdAt: true,
        scenario: { select: { id: true, name: true } },
        participant: { select: { id: true, name: true, externalId: true } },
      },
      ...prismaPageArgs(q),
    });
    return toPage(rows, q.limit);
  }
  @Post('calls')
  @ApiOperation({ summary: 'Place an outbound call (Twilio) that runs a scenario' })
  call(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(OutboundCallBody)) body: OutboundCallInput) {
    return this.phone.startOutboundCall(ws, p, body);
  }
  @Post('calls/:sessionId/transfer')
  @HttpCode(200)
  transfer(@Param('workspaceId') ws: string, @Param('sessionId') sessionId: string, @CurrentPrincipal() p: Principal) {
    return this.phone.transferCall(ws, sessionId, 'admin', p);
  }
  @Post('calls/:sessionId/hangup')
  @HttpCode(200)
  async hangup(@Param('workspaceId') ws: string, @Param('sessionId') sessionId: string) {
    await this.phone.hangup(ws, sessionId);
    return { ok: true };
  }

  // ── batches ──
  @Get('batches')
  listBatches(@Param('workspaceId') ws: string, @Query(new ZodPipe(PaginationQuery)) q: PaginationQuery) {
    return this.batches.list(ws, q);
  }
  @Post('batches')
  createBatch(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateBatchBody)) body: z.infer<typeof CreateBatchBody>) {
    return this.batches.create(ws, p, body);
  }
  @Get('batches/:id')
  getBatch(@Param('workspaceId') ws: string, @Param('id') id: string) {
    return this.batches.get(ws, id);
  }
  @Get('batches/:id/targets')
  targets(@Param('workspaceId') ws: string, @Param('id') id: string, @Query(new ZodPipe(TargetsQuery)) q: z.infer<typeof TargetsQuery>) {
    return this.batches.targets(ws, id, q);
  }
  @Post('batches/:id/targets')
  @HttpCode(200)
  @ApiOperation({ summary: 'Upload targets as CSV text (phone,name,email,external_id,<allowlisted variables>)' })
  upload(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(UploadTargetsBody)) body: z.infer<typeof UploadTargetsBody>) {
    return this.batches.uploadTargets(ws, p, id, body);
  }
  @Post('batches/:id/start')
  @HttpCode(200)
  start(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(StartBatchBody)) body: z.infer<typeof StartBatchBody>) {
    return this.batches.start(ws, p, id, body);
  }
  @Post('batches/:id/cancel')
  @HttpCode(200)
  cancelBatch(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal) {
    return this.batches.cancel(ws, p, id);
  }

  // ── meeting bots ──
  @Get('meeting-bots')
  listBots(@Param('workspaceId') ws: string, @Query(new ZodPipe(PaginationQuery)) q: PaginationQuery) {
    return this.meetings.list(ws, q);
  }
  @Post('meeting-bots')
  createBot(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateMeetingBotBody)) body: z.infer<typeof CreateMeetingBotBody>) {
    return this.meetings.create(ws, p, body);
  }
  @Get('meeting-bots/:id')
  getBot(@Param('workspaceId') ws: string, @Param('id') id: string) {
    return this.meetings.get(ws, id);
  }
  @Post('meeting-bots/:id/cancel')
  @HttpCode(200)
  cancelBot(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal) {
    return this.meetings.cancel(ws, p, id);
  }
}

function clientIp(req: FastifyRequest) {
  return req.ip || 'unknown';
}

/** Provider webhooks (Twilio voice/status, Recall.ai). Authenticated by provider signatures, not sessions. */
@ApiExcludeController()
@Controller('channels')
export class ChannelWebhooksController {
  constructor(
    private readonly phone: PhoneService,
    private readonly meetings: MeetingsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async limit(req: FastifyRequest) {
    await this.rateLimit.enforce(`chwh:ip:${clientIp(req)}`, 600, 60);
  }

  private signature(req: FastifyRequest) {
    const s = req.headers['x-twilio-signature'];
    return Array.isArray(s) ? s[0] : s;
  }

  @Public()
  @Post('twilio/voice')
  async voice(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    await this.limit(req);
    const r = await this.phone.handleInbound(req.url, (req.body ?? {}) as TwilioParams, this.signature(req));
    reply.status(r.status).header('Content-Type', r.status === 200 ? 'text/xml' : 'text/plain').send(r.body);
  }

  @Public()
  @Post('twilio/voice/outbound')
  async outbound(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Query('sessionId') sessionId: string) {
    await this.limit(req);
    const r = await this.phone.outboundTwiml(req.url, String(sessionId ?? '').slice(0, 64), (req.body ?? {}) as TwilioParams, this.signature(req));
    reply.status(r.status).header('Content-Type', r.status === 200 ? 'text/xml' : 'text/plain').send(r.body);
  }

  @Public()
  @Post('twilio/status')
  async status(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Query('sessionId') sessionId?: string) {
    await this.limit(req);
    const r = await this.phone.statusCallback(req.url, sessionId ? String(sessionId).slice(0, 64) : undefined, (req.body ?? {}) as TwilioParams, this.signature(req));
    reply.status(r.status).send();
  }

  @Public()
  @Post('recall/webhook')
  @Header('Cache-Control', 'no-store')
  async recall(@Req() req: FastifyRequest & { rawBody?: Buffer }, @Res() reply: FastifyReply, @Query() q: { bot?: string; token?: string }) {
    await this.limit(req);
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const r = await this.meetings.handleWebhook(q ?? {}, req.headers as Record<string, string | string[] | undefined>, raw, req.body);
    reply.status(r.status).send(r.status === 200 ? { ok: true } : { error: { code: 'unauthorized', message: 'Invalid webhook signature' } });
  }
}

/** QUEUES.channels processor: batch scheduler ticks and Recall bot polling. */
@Injectable()
export class ChannelsJobs implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly batches: BatchesService,
    private readonly meetings: MeetingsService,
  ) {}

  onModuleInit() {
    this.queue.process<{ batchId?: string; botId?: string }>(QUEUES.channels, async (job) => {
      if (job.name === 'batch_tick' && job.data.batchId) return this.batches.tick(job.data.batchId);
      if (job.name === 'recall_poll' && job.data.botId) return this.meetings.poll(job.data.botId);
      return undefined;
    }, 2);
  }
}
