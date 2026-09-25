import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MeetingBot } from '@prisma/client';
import { createHash } from 'node:crypto';
import { isTerminal, type SessionState } from '@cf/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import { userIdOf, type Principal } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { DomainEvents } from '../../common/events/domain-events';
import { AppError, Errors } from '../../common/http/errors';
import { prismaPageArgs, toPage, type PaginationQuery } from '../../common/http/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService } from '../../common/queue/queue.service';
import { UsageService } from '../usage/usage.service';
import { parseVersionConfig, SessionsService } from '../runtime/sessions.service';
import { ChannelProvidersService, RECALL_MISSING, type RecallCreds } from './channel-providers.service';
import { transitionMeetingSession } from './meeting-session';
import { mapRecallStatus, meetingPlatform, utteranceFromTranscriptEvent, verifySvixSignature } from './recall/recall';

export const CreateMeetingBotBody = z
  .object({
    scenarioId: z.string().min(1).max(64),
    meetingUrl: z.string().trim().min(10).max(2000),
    joinAt: z.coerce.date().optional().nullable(),
    botName: z.string().trim().min(1).max(100).optional(),
    /** Transcript speakers with this display name are the evaluated participant; others are the counterpart. */
    evaluatedSpeakerName: z.string().trim().min(1).max(120).optional(),
    calendarEventId: z.string().trim().max(200).optional(),
  })
  .strict();

const POLL_INTERVAL_MS = 60_000;
const TERMINAL_BOT = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);

/**
 * Meeting bots via Recall.ai: a bot joins a Zoom / Google Meet / Teams meeting, streams real-time
 * transcript utterances to our webhook, and the resulting MEETING session is analysed by the normal
 * pipeline when the meeting ends. Without Recall credentials the bot is stored as BLOCKED with the
 * exact reason — never simulated.
 */
@Injectable()
export class MeetingsService {
  private readonly logger = new Logger('Meetings');
  fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly providers: ChannelProvidersService,
    private readonly sessions: SessionsService,
    private readonly events: DomainEvents,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
  ) {}


  endpointToken(botRowId: string) {
    return this.crypto.hmac(`recall-endpoint:${botRowId}`);
  }

  realtimeEndpointUrl(botRowId: string) {
    return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/channels/recall/webhook?bot=${encodeURIComponent(botRowId)}&token=${this.endpointToken(botRowId)}`;
  }

  private async recallFetch<T = any>(creds: RecallCreds, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.providers.recallUrl(creds, path), {
      method,
      headers: { Authorization: `Token ${creds.apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const detail = json?.detail ?? json?.message ?? (json ? JSON.stringify(json).slice(0, 300) : `HTTP ${res.status}`);
      throw new AppError(502, 'provider_error', `Recall.ai: ${detail}`, { status: res.status });
    }
    return json as T;
  }

  serialize(b: MeetingBot) {
    return {
      id: b.id,
      scenarioId: b.scenarioId,
      provider: b.provider,
      meetingUrl: b.meetingUrl,
      platform: meetingPlatform(b.meetingUrl),
      scheduledAt: b.scheduledAt,
      calendarEventId: b.calendarEventId,
      status: b.status,
      providerBotId: b.providerBotId,
      sessionId: b.sessionId,
      lastError: b.lastError,
      botName: b.botName,
      evaluatedSpeakerName: b.evaluatedSpeakerName,
      lastEventAt: b.lastEventAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }

  async list(workspaceId: string, q: PaginationQuery) {
    const rows = await this.prisma.meetingBot.findMany({ where: { workspaceId }, ...prismaPageArgs(q) });
    const page = toPage(rows, q.limit);
    return { data: page.data.map((b) => this.serialize(b)), nextCursor: page.nextCursor };
  }

  async get(workspaceId: string, id: string) {
    const b = await this.prisma.meetingBot.findFirst({ where: { id, workspaceId } });
    if (!b) throw Errors.notFound('Meeting bot');
    return this.serialize(b);
  }

  async create(workspaceId: string, principal: Principal, input: z.infer<typeof CreateMeetingBotBody>) {
    const platform = meetingPlatform(input.meetingUrl);
    if (!platform) {
      throw Errors.validation('Enter a Zoom, Google Meet or Microsoft Teams meeting link (https://…)', [{ path: 'meetingUrl', message: 'Unsupported meeting URL' }]);
    }
    if (input.joinAt && input.joinAt.getTime() < Date.now() - 60_000) throw Errors.validation('joinAt must be in the future', [{ path: 'joinAt', message: 'In the past' }]);
    const scenario = await this.prisma.scenario.findFirst({ where: { id: input.scenarioId, workspaceId, deletedAt: null } });
    if (!scenario) throw Errors.notFound('Scenario');
    if (!scenario.latestVersionId) throw Errors.conflict('Publish the scenario before sending a meeting bot');
    const version = await this.prisma.scenarioVersion.findFirst({ where: { id: scenario.latestVersionId, workspaceId } });
    const config = parseVersionConfig(version?.config);
    if (!config.channels.meeting.enabled) throw Errors.conflict('The meeting channel is disabled for this scenario (Channels → Meeting in the scenario editor)');

    const creds = await this.providers.recall(workspaceId);
    const pub = this.providers.publicUrlStatus();
    const blockedReason = !creds ? RECALL_MISSING : !pub.ok ? pub.reason : null;
    const bot = await this.prisma.meetingBot.create({
      data: {
        workspaceId,
        scenarioId: scenario.id,
        provider: 'recall',
        meetingUrl: input.meetingUrl,
        scheduledAt: input.joinAt ?? null,
        calendarEventId: input.calendarEventId ?? null,
        status: blockedReason ? 'BLOCKED' : 'SCHEDULED',
        lastError: blockedReason,
        botName: input.botName ?? (config.persona.name ? `${config.persona.name} (notetaker)` : 'ConversaForge notetaker'),
        evaluatedSpeakerName: input.evaluatedSpeakerName ?? null,
        createdById: userIdOf(principal),
      },
    });
    await this.audit.log({ workspaceId, principal, action: 'channel.meeting_bot_created', targetType: 'meeting_bot', targetId: bot.id, metadata: { platform, blocked: !!blockedReason } });
    if (blockedReason) return this.serialize(bot);

    const { session } = await this.sessions.createSession({
      workspaceId,
      scenarioId: scenario.id,
      channel: 'MEETING',
      participant: { externalId: `meeting:${bot.id}`, name: input.evaluatedSpeakerName ?? 'Meeting participants' },
      consent: { recordAudio: false, recordVideo: false, analysis: config.analysis.enabled, source: 'meeting_bot' },
      metadata: { meeting: { botId: bot.id, platform, url: input.meetingUrl, evaluatedSpeakerName: input.evaluatedSpeakerName ?? null } },
    });
    try {
      const res = await this.recallFetch<{ id: string }>(creds!, 'POST', '/bot/', {
        meeting_url: input.meetingUrl,
        bot_name: bot.botName,
        ...(input.joinAt ? { join_at: input.joinAt.toISOString() } : {}),
        recording_config: {
          transcript: { provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: config.basics.language.slice(0, 2).toLowerCase() } } },
          realtime_endpoints: [{ type: 'webhook', url: this.realtimeEndpointUrl(bot.id), events: ['transcript.data'] }],
        },
        metadata: { conversaforge_bot_id: bot.id, conversaforge_session_id: session.id, workspace_id: workspaceId },
      });
      const updated = await this.prisma.meetingBot.update({
        where: { id: bot.id },
        data: { providerBotId: res.id, sessionId: session.id, status: input.joinAt && input.joinAt.getTime() > Date.now() + 60_000 ? 'SCHEDULED' : 'JOINING' },
      });
      await this.prisma.session.update({ where: { id: session.id }, data: { externalRef: res.id } });
      await this.schedulePoll(bot.id, input.joinAt ? Math.max(POLL_INTERVAL_MS, input.joinAt.getTime() - Date.now()) : POLL_INTERVAL_MS);
      return this.serialize(updated);
    } catch (e: any) {
      await transitionMeetingSession(this.prisma, this.events, session.id, 'FAILED', 'meeting_bot_failed', { errorCode: 'provider_error', errorMessage: e?.message });
      const failed = await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { status: 'FAILED', sessionId: session.id, lastError: String(e?.message ?? e).slice(0, 500) } });
      return this.serialize(failed);
    }
  }

  async cancel(workspaceId: string, principal: Principal, id: string) {
    const bot = await this.prisma.meetingBot.findFirst({ where: { id, workspaceId } });
    if (!bot) throw Errors.notFound('Meeting bot');
    if (TERMINAL_BOT.has(bot.status)) return this.serialize(bot);
    const creds = await this.providers.recall(workspaceId);
    if (creds && bot.providerBotId) {
      try {
        if (bot.status === 'SCHEDULED') await this.recallFetch(creds, 'DELETE', `/bot/${encodeURIComponent(bot.providerBotId)}/`);
        else await this.recallFetch(creds, 'POST', `/bot/${encodeURIComponent(bot.providerBotId)}/leave_call/`);
      } catch (e: any) {
        this.logger.warn(`Recall cancel for ${bot.id} failed: ${e?.message}`);
      }
    }
    const updated = await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { status: 'CANCELLED' } });
    if (bot.sessionId) {
      const s = await this.prisma.session.findUnique({ where: { id: bot.sessionId } });
      if (s && !isTerminal(s.state as SessionState)) {
        await transitionMeetingSession(this.prisma, this.events, s.id, s.startedAt ? 'COMPLETED' : 'CANCELLED', 'meeting_bot_cancelled', { endedBy: 'admin' });
      }
    }
    await this.audit.log({ workspaceId, principal, action: 'channel.meeting_bot_cancelled', targetType: 'meeting_bot', targetId: bot.id });
    return this.serialize(updated);
  }

  // ───────────────────────── webhooks & polling ─────────────────────────

  /**
   * POST /api/channels/recall/webhook. Accepts (a) our per-bot realtime endpoint URL token, or
   * (b) a Svix signature made with RECALL_WEBHOOK_SECRET (bot status webhooks from the Recall dashboard).
   */
  async handleWebhook(query: { bot?: string; token?: string }, headers: Record<string, string | string[] | undefined>, rawBody: Buffer | string, body: any) {
    let bot: MeetingBot | null = null;
    if (query.bot && query.token) {
      const candidate = await this.prisma.meetingBot.findUnique({ where: { id: String(query.bot).slice(0, 64) } });
      if (candidate && this.crypto.safeEqual(String(query.token), this.endpointToken(candidate.id))) bot = candidate;
      else return { status: 401 };
    } else {
      const secret = env.RECALL_WEBHOOK_SECRET;
      if (!secret || !verifySvixSignature(secret, headers, rawBody)) return { status: 401 };
      const providerBotId = body?.data?.bot?.id;
      const rowId = body?.data?.bot?.metadata?.conversaforge_bot_id;
      bot = rowId
        ? await this.prisma.meetingBot.findFirst({ where: { id: String(rowId), providerBotId: String(providerBotId ?? '') } })
        : providerBotId
          ? await this.prisma.meetingBot.findFirst({ where: { providerBotId: String(providerBotId), provider: 'recall' } })
          : null;
      if (!bot) return { status: 200 }; // not ours (shared Recall account); acknowledge
    }
    const event = String(body?.event ?? '');
    if (event === 'transcript.data') {
      await this.ingestUtterance(bot, body);
    } else if (event.startsWith('bot.')) {
      const code = event.slice(4);
      await this.applyStatus(bot, code, body?.data?.data?.sub_code ?? null);
    }
    await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { lastEventAt: new Date() } });
    return { status: 200 };
  }

  async ingestUtterance(bot: MeetingBot, payload: any) {
    if (!bot.sessionId || (TERMINAL_BOT.has(bot.status) && bot.status !== 'COMPLETED')) return;
    const u = utteranceFromTranscriptEvent(payload);
    if (!u) return;
    if (u.botId && bot.providerBotId && u.botId !== bot.providerBotId) return;
    const session = await this.prisma.session.findUnique({ where: { id: bot.sessionId } });
    if (!session || session.workspaceId !== bot.workspaceId || isTerminal(session.state as SessionState)) return;
    if (session.state !== 'ACTIVE') {
      await transitionMeetingSession(this.prisma, this.events, session.id, 'ACTIVE', 'meeting_transcript_started');
      if (bot.status !== 'IN_CALL') await this.prisma.meetingBot.update({ where: { id: bot.id }, data: { status: 'IN_CALL' } });
    }
    const evaluated = bot.evaluatedSpeakerName?.trim().toLowerCase();
    const isParticipant = !evaluated || (u.speaker.name ?? '').trim().toLowerCase() === evaluated;
    const clientTurnId = 'rc_' + createHash('sha256').update(`${u.speaker.id}|${u.startMs}|${u.text}`).digest('hex').slice(0, 32);
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await this.prisma.transcriptTurn.findUnique({ where: { sessionId_clientTurnId: { sessionId: session.id, clientTurnId } } });
      if (exists) return;
      const last = await this.prisma.transcriptTurn.findFirst({ where: { sessionId: session.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
      const seq = (last?.seq ?? 0) + 1;
      try {
        await this.prisma.transcriptTurn.create({
          data: {
            sessionId: session.id,
            seq,
            speaker: isParticipant ? 'PARTICIPANT' : 'AGENT',
            text: u.text,
            clientTurnId,
            startedAtMs: u.startMs,
            endedAtMs: u.endMs,
            source: 'meeting_transcript',
            metadata: { speakerName: u.speaker.name, speakerId: u.speaker.id, isHost: u.speaker.isHost, role: isParticipant ? 'evaluated' : 'counterpart' } as Prisma.InputJsonValue,
          },
        });
        await this.prisma.session.updateMany({ where: { id: session.id, lastSeq: { lt: seq } }, data: { lastSeq: seq } });
        return;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
  }

  async applyStatus(bot: MeetingBot, code: string, subCode: string | null) {
    const mapped = mapRecallStatus(code);
    if (!mapped || bot.status === 'CANCELLED') return;
    if (bot.status === mapped && mapped !== 'COMPLETED') return;
    await this.prisma.meetingBot.update({
      where: { id: bot.id },
      data: { status: mapped, ...(mapped === 'FAILED' ? { lastError: `Recall.ai: ${code}${subCode ? ` (${subCode})` : ''}` } : {}) },
    });
    if (!bot.sessionId) return;
    const s = await this.prisma.session.findUnique({ where: { id: bot.sessionId } });
    if (!s || isTerminal(s.state as SessionState)) return;
    if (mapped === 'IN_CALL') await transitionMeetingSession(this.prisma, this.events, s.id, 'ACTIVE', `recall_${code}`);
    else if (mapped === 'COMPLETED') {
      const turns = await this.prisma.transcriptTurn.count({ where: { sessionId: s.id } });
      if (turns > 0 || s.startedAt) {
        await transitionMeetingSession(this.prisma, this.events, s.id, 'COMPLETED', `recall_${code}`, { endedBy: 'system' });
        const done = await this.prisma.session.findUnique({ where: { id: s.id } });
        if (done?.durationMs) {
          await this.usage.record({
            workspaceId: s.workspaceId,
            sessionId: s.id,
            kind: 'SESSION_SECONDS',
            provider: 'recall',
            quantity: Math.round(done.durationMs / 1000),
            unit: 'seconds',
            idempotencyKey: `meeting:${s.id}:duration`,
          });
        }
      } else {
        await transitionMeetingSession(this.prisma, this.events, s.id, 'CANCELLED', 'meeting_ended_without_transcript', { endedBy: 'system' });
      }
    } else if (mapped === 'FAILED') {
      await transitionMeetingSession(this.prisma, this.events, s.id, 'FAILED', `recall_${code}`, { errorCode: 'meeting_bot_failed', errorMessage: `Recall.ai bot ${code}${subCode ? ` (${subCode})` : ''}` });
    }
  }

  async schedulePoll(botId: string, delayMs = POLL_INTERVAL_MS) {
    await this.queue.enqueue(QUEUES.channels, 'recall_poll', { botId }, { jobId: `recall_poll_${botId}_${Math.floor((Date.now() + delayMs) / POLL_INTERVAL_MS)}`, delay: delayMs, attempts: 1 });
  }

  /** Poll Recall for the bot status (works without dashboard webhooks); reschedules itself until terminal. */
  async poll(botId: string) {
    const bot = await this.prisma.meetingBot.findUnique({ where: { id: botId } });
    if (!bot || TERMINAL_BOT.has(bot.status) || !bot.providerBotId) return;
    const creds = await this.providers.recall(bot.workspaceId);
    if (!creds) return;
    try {
      const data = await this.recallFetch<any>(creds, 'GET', `/bot/${encodeURIComponent(bot.providerBotId)}/`);
      const changes: Array<{ code: string; sub_code?: string | null }> = Array.isArray(data?.status_changes) ? data.status_changes : [];
      const last = changes[changes.length - 1];
      if (last?.code) await this.applyStatus(bot, last.code, last.sub_code ?? null);
    } catch (e: any) {
      this.logger.warn(`Recall poll for ${bot.id} failed: ${e?.message}`);
    }
    const fresh = await this.prisma.meetingBot.findUnique({ where: { id: botId } });
    if (fresh && !TERMINAL_BOT.has(fresh.status)) await this.schedulePoll(botId);
  }
}
