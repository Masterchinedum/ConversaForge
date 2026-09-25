import { Body, Controller, Get, Headers, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma, type Session } from '@prisma/client';
import { UPLOAD_LIMITS, isTerminal, substituteVariables, type SessionState } from '@cf/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Public } from '../../common/auth/decorators';
import { AppError, Errors } from '../../common/http/errors';
import { ZodPipe } from '../../common/http/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { StorageService } from '../../common/storage/storage.service';
import { UsageService } from '../usage/usage.service';
import { ClientConfigService } from './client-config.service';
import { OptionalDepsService } from './optional-deps.service';
import { RecordingsService, baseMime } from './recordings.service';
import { RuntimeService } from './runtime.service';
import type { ConsentRecord, ProviderInfo } from './runtime.types';
import { SessionsService } from './sessions.service';
import { RealtimeService } from './voice/realtime.service';
import { SpeechService } from './voice/speech.service';

const ConsentBody = z.object({ recordAudio: z.boolean(), recordVideo: z.boolean(), analysis: z.boolean() }).strict();
const RecordingBody = z.object({ kind: z.enum(['audio', 'video']), mimeType: z.string().min(3).max(100) }).strict();
const CompleteBody = z.object({ durationMs: z.number().int().min(0).optional() }).strict();
const TtsBody = z.object({ text: z.string().min(1).max(1500), format: z.enum(['mp3', 'pcm']).optional() }).strict();
const STT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Participant-facing session endpoints. No user login: every call carries the per-session token
 * (`Authorization: Bearer cfs_…`) returned by createSession, verified in constant time.
 */
@ApiTags('runtime')
@Public()
@Controller('runtime/sessions/:sessionId')
export class ParticipantController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly runtime: RuntimeService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly clientConfig: ClientConfigService,
    private readonly recordings: RecordingsService,
    private readonly realtime: RealtimeService,
    private readonly speech: SpeechService,
    private readonly usage: UsageService,
    private readonly storage: StorageService,
    private readonly optional: OptionalDepsService,
  ) {}

  private async auth(sessionId: string, authorization: string | undefined): Promise<Session> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token) throw Errors.unauthorized('Session token required');
    return this.sessions.verifySessionToken(sessionId, token);
  }

  @Get()
  async bootstrap(@Param('sessionId') sessionId: string, @Headers('authorization') authz?: string) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:boot:${s.id}`, 120, 60);
    const { session, config, scenario } = await this.sessions.load(s.id);
    const variables = (session.variables ?? {}) as Record<string, string>;
    const pi = session.providerInfo as unknown as ProviderInfo;
    const consent = (session.consent ?? {}) as Partial<ConsentRecord>;
    const consentRequired = config.recording.audio || config.recording.video || config.analysis.enabled;
    const participant = await this.prisma.participant.findFirst({ where: { id: session.participantId, workspaceId: session.workspaceId }, select: { name: true } });
    return {
      session: {
        id: session.id,
        state: session.state,
        channel: session.channel,
        coachMode: session.coachMode,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        stateReason: session.stateReason,
        endedBy: session.endedBy,
        maxDurationSec: session.maxDurationSec,
        lastSeq: session.lastSeq,
        terminal: isTerminal(session.state as SessionState),
      },
      scenario: {
        id: scenario.id,
        name: config.basics.name || scenario.name,
        type: config.basics.type,
        description: config.basics.publicDescription || scenario.publicDescription || '',
        participantInstructions: substituteVariables(config.basics.participantInstructions, variables),
        targetDurationMinutes: config.basics.targetDurationMinutes,
        language: config.basics.language,
      },
      persona: { name: config.persona.name, role: config.persona.role, avatar: config.persona.avatar },
      participant: { name: participant?.name ?? null },
      consent: {
        required: consentRequired,
        given: !!consent.acceptedAt,
        recordAudio: config.recording.audio,
        recordVideo: config.recording.video,
        analysis: config.analysis.enabled,
        retentionDays: config.recording.retentionDays,
        notice: config.recording.consentNotice || defaultNotice(config.recording.audio, config.recording.video, config.analysis.enabled, config.recording.retentionDays),
        noticeVersion: this.sessions.noticeVersion(config),
        recorded: consent.acceptedAt ? consent : null,
      },
      report: {
        participantCanSeeTranscript: config.analysis.participantCanSeeTranscript,
        participantCanSeeFeedback: config.analysis.participantCanSeeFeedback,
        participantCanSeeScores: config.analysis.participantCanSeeScores,
      },
      config: await this.clientConfig.build(session, config),
      simulated: !!pi?.simulated,
      simulatedParts: pi?.simulatedParts ?? [],
      providerFallbacks: pi?.fallbacks ?? [],
    };
  }

  @Post('consent')
  async consent(
    @Param('sessionId') sessionId: string,
    @Body(new ZodPipe(ConsentBody)) body: z.infer<typeof ConsentBody>,
    @Headers('authorization') authz?: string,
  ) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:consent:${s.id}`, 20, 60);
    const { config } = await this.sessions.load(s.id);
    const record: ConsentRecord = {
      recordAudio: body.recordAudio && config.recording.audio,
      recordVideo: body.recordVideo && config.recording.video,
      // Declining analysis is recorded explicitly so the post-session pipeline skips it.
      analysis: body.analysis && config.analysis.enabled,
      acceptedAt: new Date().toISOString(),
      noticeVersion: this.sessions.noticeVersion(config),
      source: 'participant',
    };
    const engine = await this.runtime.getEngine(s.id);
    const updated = await engine.recordConsent(record);
    return { state: updated.state, consent: record };
  }

  @Post('realtime-token')
  async realtimeToken(@Param('sessionId') sessionId: string, @Headers('authorization') authz?: string) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:rtok:${s.id}`, 10, 60, 'Too many realtime token requests');
    if (isTerminal(s.state as SessionState)) throw Errors.conflict('The session has ended');
    const pi = s.providerInfo as unknown as ProviderInfo;
    if (pi?.voiceMode !== 'realtime') throw Errors.conflict('This session does not use realtime voice', { voiceMode: pi?.voiceMode, fallbacks: pi?.fallbacks });
    const { config } = await this.sessions.load(s.id);
    const engine = await this.runtime.getEngine(s.id);
    const setup = await engine.realtimeSetup();
    const creds = await this.realtime.mint({
      workspaceId: s.workspaceId,
      model: pi.realtime?.model ?? '',
      instructions: setup.instructions,
      tools: setup.tools,
      config,
    });
    await this.prisma.sessionEvent.create({ data: { sessionId: s.id, type: 'provider.realtime_token', payload: { model: creds.model, expiresAt: creds.expiresAt } } });
    return creds;
  }

  // ── Recordings ──

  @Post('recordings')
  async createRecording(
    @Param('sessionId') sessionId: string,
    @Body(new ZodPipe(RecordingBody)) body: z.infer<typeof RecordingBody>,
    @Headers('authorization') authz?: string,
  ) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:rec:${s.id}`, 20, 60);
    const { config } = await this.sessions.load(s.id);
    return this.recordings.create(s, config, body);
  }

  @Put('recordings/:assetId/parts/:n')
  async putPart(
    @Param('sessionId') sessionId: string,
    @Param('assetId') assetId: string,
    @Param('n') n: string,
    @Req() req: FastifyRequest,
    @Headers('authorization') authz?: string,
  ) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:part:${s.id}`, 240, 60);
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw Errors.validation('Send the chunk as a binary body (Content-Type: audio/webm, video/webm or application/octet-stream)');
    return this.recordings.putPart(s, assetId, parseInt(n, 10), body, req.headers['content-type']);
  }

  @Post('recordings/:assetId/complete')
  async complete(
    @Param('sessionId') sessionId: string,
    @Param('assetId') assetId: string,
    @Body(new ZodPipe(CompleteBody)) body: z.infer<typeof CompleteBody>,
    @Headers('authorization') authz?: string,
  ) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:recdone:${s.id}`, 30, 60);
    const { config } = await this.sessions.load(s.id);
    return this.recordings.complete(s, config, assetId, body ?? {});
  }

  // ── document_upload tool ──

  @Post('uploads')
  async upload(
    @Param('sessionId') sessionId: string,
    @Query('toolCallId') toolCallId: string | undefined,
    @Req() req: FastifyRequest,
    @Headers('authorization') authz?: string,
  ) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:upload:${s.id}`, 10, 300, 'Too many uploads');
    if (s.state !== 'ACTIVE' && s.state !== 'PAUSED') throw Errors.conflict('Uploads are only possible during an active session');
    const { config } = await this.sessions.load(s.id);
    const enabled = config.tools.enabled.some((t) => t.toolId === 'document_upload' && t.enabled);
    if (!enabled) throw Errors.forbidden('Document upload is not enabled for this scenario');
    if (!(req as any).isMultipart?.()) throw Errors.validation('Send the file as multipart/form-data (field "file")');
    const limits = UPLOAD_LIMITS.toolDocument;
    const file = await (req as any).file({ limits: { fileSize: limits.maxBytes, files: 1 } });
    if (!file) throw Errors.validation('No file uploaded');
    const mime = baseMime(file.mimetype);
    const fileName = String(file.filename ?? 'document').replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'document';
    const effectiveMime = mime === 'application/octet-stream' && /\.md$/i.test(fileName) ? 'text/markdown' : mime === 'application/octet-stream' && /\.txt$/i.test(fileName) ? 'text/plain' : mime;
    if (!(limits.mimeTypes as readonly string[]).includes(effectiveMime)) {
      file.file?.resume?.();
      throw Errors.validation(`Unsupported file type ${mime}`, { allowed: limits.mimeTypes });
    }
    const buf: Buffer = await file.toBuffer();
    if (file.file?.truncated || buf.length > limits.maxBytes) throw Errors.validation(`File too large (max ${Math.round(limits.maxBytes / 1024 / 1024)} MB)`);
    if (!buf.length) throw Errors.validation('Empty file');
    if (effectiveMime === 'application/pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw Errors.validation('The file is not a valid PDF');

    const assetId = randomUUID().replace(/-/g, '').slice(0, 24);
    const key = this.storage.key(s.workspaceId, 'sessions', s.id, 'uploads', `${assetId}-${fileName}`);
    await this.storage.put(key, buf, effectiveMime);
    let text = '';
    let pageCount: number | null = null;
    let extractError: string | null = null;
    try {
      const r = await this.extract(buf, effectiveMime, fileName);
      text = r.text;
      pageCount = r.pageCount ?? null;
    } catch (e) {
      // Invalid/unsupported documents are the participant's to fix; other failures degrade to "no text".
      if (e instanceof AppError && e.getStatus() < 500) {
        await this.storage.delete(key).catch(() => undefined);
        throw e;
      }
      extractError = (e as Error).message?.slice(0, 200) ?? 'extraction failed';
    }
    text = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const asset = await this.prisma.mediaAsset.create({
      data: {
        workspaceId: s.workspaceId,
        sessionId: s.id,
        kind: 'TOOL_UPLOAD',
        storageKey: key,
        fileName,
        mimeType: effectiveMime,
        sizeBytes: BigInt(buf.length),
        status: 'READY',
        retentionUntil: new Date(Date.now() + config.recording.retentionDays * 86400_000),
        metadata: { pageCount, chars: text.length, extractError, toolCallId: toolCallId ?? null } as Prisma.InputJsonValue,
      },
    });
    const engine = await this.runtime.getEngine(s.id);
    await engine.documentUploaded({ assetId: asset.id, fileName, text, toolCallId: toolCallId ? String(toolCallId).slice(0, 128) : null });
    return { assetId: asset.id, fileName, textPreview: text.slice(0, 500), chars: text.length, pageCount, ...(extractError ? { warning: 'Text could not be extracted from this file' } : {}) };
  }

  private async extract(buf: Buffer, mime: string, fileName: string): Promise<{ text: string; pageCount?: number | null }> {
    const ext = this.optional.extractor();
    if (ext) return ext.extractText(buf, mime, { fileName, maxChars: 200_000, maxBytes: UPLOAD_LIMITS.toolDocument.maxBytes });
    if (mime === 'text/plain' || mime === 'text/markdown') return { text: buf.toString('utf8').slice(0, 200_000), pageCount: null };
    if (mime === 'application/pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const r = await extractText(pdf, { mergePages: true });
      return { text: String(r.text ?? '').slice(0, 200_000), pageCount: r.totalPages };
    }
    return { text: '' };
  }

  // ── Server speech ──

  @Post('tts')
  async tts(
    @Param('sessionId') sessionId: string,
    @Body(new ZodPipe(TtsBody)) body: z.infer<typeof TtsBody>,
    @Res() reply: FastifyReply,
    @Headers('authorization') authz?: string,
  ) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:tts:${s.id}`, 60, 60, 'Too many speech requests');
    if (isTerminal(s.state as SessionState)) throw Errors.conflict('The session has ended');
    const { config } = await this.sessions.load(s.id);
    const pi = s.providerInfo as unknown as ProviderInfo;
    const provider = await this.speech.tts(s.workspaceId, pi?.tts);
    let out;
    try {
      out = await provider.synthesize(body.text, {
        voice: config.persona.voice.voiceId,
        speed: config.persona.voice.speed,
        instructions: `Speak as ${config.persona.role || 'a conversation partner'}; tone: ${config.instructions.tone}.`,
        format: body.format,
      });
    } catch (e) {
      await this.prisma.sessionEvent.create({ data: { sessionId: s.id, type: 'provider.tts_error', payload: { provider: provider.id, message: (e as Error).message.slice(0, 300) } } });
      throw Errors.unavailable('Text-to-speech failed; please retry');
    }
    await this.usage.record({
      workspaceId: s.workspaceId,
      sessionId: s.id,
      kind: 'TTS_CHARACTERS',
      provider: out.provider,
      model: out.model,
      quantity: out.characters,
      unit: 'characters',
      idempotencyKey: `tts:${s.id}:${randomUUID()}`,
    });
    reply.header('Content-Type', out.mimeType).header('Cache-Control', 'no-store').header('X-Provider', out.provider).send(out.audio);
  }

  @Post('stt')
  async stt(@Param('sessionId') sessionId: string, @Req() req: FastifyRequest, @Headers('authorization') authz?: string) {
    const s = await this.auth(sessionId, authz);
    await this.rateLimit.enforce(`rt:stt:${s.id}`, 120, 60, 'Too many transcription requests');
    if (isTerminal(s.state as SessionState)) throw Errors.conflict('The session has ended');
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw Errors.validation('Send the audio chunk as a binary body (Content-Type: audio/webm, audio/ogg, audio/wav, audio/mp4…)');
    if (body.length > STT_MAX_BYTES) throw Errors.validation(`Audio chunk too large (max ${STT_MAX_BYTES} bytes)`);
    const mime = baseMime(req.headers['content-type']) || 'audio/webm';
    const { config } = await this.sessions.load(s.id);
    const pi = s.providerInfo as unknown as ProviderInfo;
    const provider = await this.speech.stt(s.workspaceId, pi?.stt);
    let out;
    try {
      out = await provider.transcribe(body, mime, { language: config.basics.language.slice(0, 2) });
    } catch (e) {
      await this.prisma.sessionEvent.create({ data: { sessionId: s.id, type: 'provider.stt_error', payload: { provider: provider.id, message: (e as Error).message.slice(0, 300) } } });
      throw Errors.unavailable('Speech recognition failed; please retry');
    }
    await this.usage.record({
      workspaceId: s.workspaceId,
      sessionId: s.id,
      kind: 'STT_SECONDS',
      provider: out.provider,
      model: out.model,
      quantity: out.durationSec,
      unit: 'seconds',
      idempotencyKey: `stt:${s.id}:${randomUUID()}`,
      metadata: { estimated: out.durationEstimated },
    });
    return { text: out.text, confidence: out.confidence, durationSec: out.durationSec, provider: out.provider };
  }
}

function defaultNotice(audio: boolean, video: boolean, analysis: boolean, days: number): string {
  const parts: string[] = ['You are about to talk with an AI agent.'];
  const rec = [audio ? 'audio' : null, video ? 'video' : null].filter(Boolean).join(' and ');
  if (rec) parts.push(`With your permission, the ${rec} of this conversation will be recorded.`);
  parts.push('A transcript of the conversation is saved.');
  if (analysis) parts.push('With your permission, the transcript will be analyzed by AI to produce feedback, and reviewed by the organization that invited you.');
  parts.push(`Recordings and uploads are kept for up to ${days} days. You can decline recording and still take part.`);
  return parts.join(' ');
}
