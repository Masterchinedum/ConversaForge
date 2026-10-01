import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Session } from '@prisma/client';
import { UPLOAD_LIMITS, isTerminal, type ScenarioConfig, type SessionState } from '@cf/shared';
import { createHash } from 'node:crypto';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { UsageService } from '../usage/usage.service';
import type { ConsentRecord } from './runtime.types';

const MAX_RECORDINGS_PER_SESSION = 6;
const MAX_PARTS = 5000;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
/** Uploads may finish shortly after the session ends (last chunks in flight). */
const POST_END_GRACE_MS = 15 * 60_000;

export function baseMime(ct: string | undefined | null): string {
  return String(ct ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Chunked recording uploads for a live session: create → PUT parts (idempotent per part number) →
 * complete (parts concatenated into one object, asset READY, retention set). Only allowed when the
 * participant consented to that kind of recording and the scenario records it.
 */
@Injectable()
export class RecordingsService {
  private readonly logger = new Logger('Recordings');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
  ) {}

  private assertWritable(session: Session) {
    if (session.state === 'CREATED' || session.state === 'READY') throw Errors.conflict('The session has not started');
    if (isTerminal(session.state as SessionState)) {
      const ended = session.endedAt?.getTime() ?? 0;
      if (session.state !== 'COMPLETED' && session.state !== 'ABANDONED') throw Errors.conflict('The session has ended');
      if (Date.now() - ended > POST_END_GRACE_MS) throw Errors.conflict('The session has ended');
    }
  }

  async create(session: Session, config: ScenarioConfig, body: { kind: 'audio' | 'video'; mimeType: string }) {
    this.assertWritable(session);
    const consent = (session.consent ?? {}) as Partial<ConsentRecord>;
    const mime = baseMime(body.mimeType);
    if (body.kind === 'audio' && !(config.recording.audio && consent.recordAudio === true)) {
      throw Errors.forbidden('Audio recording is not enabled or the participant did not consent');
    }
    if (body.kind === 'video' && !(config.recording.video && consent.recordVideo === true)) {
      throw Errors.forbidden('Video recording is not enabled or the participant did not consent');
    }
    if (!(UPLOAD_LIMITS.recordingPart.mimeTypes as readonly string[]).includes(mime)) {
      throw Errors.validation(`Unsupported recording type ${mime}`, { allowed: UPLOAD_LIMITS.recordingPart.mimeTypes });
    }
    const count = await this.prisma.mediaAsset.count({
      where: { sessionId: session.id, workspaceId: session.workspaceId, kind: { in: ['RECORDING_AUDIO', 'RECORDING_VIDEO'] }, deletedAt: null },
    });
    if (count >= MAX_RECORDINGS_PER_SESSION) throw Errors.conflict('Too many recordings for this session');
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
    const asset = await this.prisma.mediaAsset.create({
      data: {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        kind: body.kind === 'video' ? 'RECORDING_VIDEO' : 'RECORDING_AUDIO',
        storageKey: this.storage.key(session.workspaceId, 'sessions', session.id, 'recordings', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${ext}`),
        fileName: `recording-${session.id}.${ext}`,
        mimeType: mime,
        status: 'UPLOADING',
        metadata: { source: 'participant' },
      },
    });
    await this.prisma.sessionEvent.create({ data: { sessionId: session.id, type: 'recording.created', payload: { assetId: asset.id, kind: body.kind, mimeType: mime } } });
    return { assetId: asset.id };
  }

  private async asset(session: Session, assetId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, sessionId: session.id, workspaceId: session.workspaceId, kind: { in: ['RECORDING_AUDIO', 'RECORDING_VIDEO'] }, deletedAt: null },
    });
    if (!asset) throw Errors.notFound('Recording');
    return asset;
  }

  async putPart(session: Session, assetId: string, partNumber: number, body: Buffer, contentType: string | undefined) {
    this.assertWritable(session);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) throw Errors.validation('Invalid part number');
    if (!Buffer.isBuffer(body) || body.length === 0) throw Errors.validation('Empty part');
    if (body.length > UPLOAD_LIMITS.recordingPart.maxBytes) throw Errors.validation(`Part too large (max ${UPLOAD_LIMITS.recordingPart.maxBytes} bytes)`);
    const ct = baseMime(contentType);
    if (ct && ct !== 'application/octet-stream' && !(UPLOAD_LIMITS.recordingPart.mimeTypes as readonly string[]).includes(ct)) {
      throw Errors.validation(`Unsupported content type ${ct}`);
    }
    const asset = await this.asset(session, assetId);
    if (asset.status !== 'UPLOADING') throw Errors.conflict('This recording is already complete');
    const agg = await this.prisma.mediaUploadPart.aggregate({ where: { assetId, partNumber: { not: partNumber } }, _sum: { sizeBytes: true } });
    if ((agg._sum.sizeBytes ?? 0) + body.length > MAX_TOTAL_BYTES) throw Errors.validation('Recording is too large');
    const key = `${asset.storageKey}.part${String(partNumber).padStart(5, '0')}`;
    await this.storage.put(key, body, asset.mimeType);
    await this.prisma.mediaUploadPart.upsert({
      where: { assetId_partNumber: { assetId, partNumber } },
      create: { assetId, partNumber, storageKey: key, sizeBytes: body.length },
      update: { storageKey: key, sizeBytes: body.length },
    });
    return { assetId, partNumber, sizeBytes: body.length };
  }

  async complete(session: Session, config: ScenarioConfig, assetId: string, body: { durationMs?: number }) {
    const asset = await this.asset(session, assetId);
    if (asset.status === 'READY') return { assetId, status: 'READY', sizeBytes: Number(asset.sizeBytes) };
    this.assertWritable(session);
    const parts = await this.prisma.mediaUploadPart.findMany({ where: { assetId }, orderBy: { partNumber: 'asc' } });
    if (!parts.length) throw Errors.validation('No parts were uploaded');
    const missing = parts.findIndex((p, i) => p.partNumber !== i + 1);
    if (missing !== -1) throw Errors.validation(`Missing part ${missing + 1}`);
    const buffers: Buffer[] = [];
    for (const p of parts) {
      this.storage.assertWorkspaceKey(session.workspaceId, p.storageKey);
      buffers.push(await this.storage.get(p.storageKey));
    }
    const all = Buffer.concat(buffers);
    await this.storage.put(asset.storageKey, all, asset.mimeType);
    const retentionUntil = new Date(Date.now() + config.recording.retentionDays * 86400_000);
    const updated = await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: 'READY',
        sizeBytes: BigInt(all.length),
        sha256: createHash('sha256').update(all).digest('hex'),
        durationMs: typeof body.durationMs === 'number' && body.durationMs > 0 ? Math.min(Math.round(body.durationMs), 24 * 3600_000) : null,
        retentionUntil,
        metadata: { ...(asset.metadata as Prisma.JsonObject), parts: parts.length },
      },
    });
    for (const p of parts) await this.storage.delete(p.storageKey).catch(() => undefined);
    await this.prisma.mediaUploadPart.deleteMany({ where: { assetId } });
    await this.usage
      .record({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        kind: 'STORAGE_BYTES',
        provider: 'storage',
        quantity: all.length,
        unit: 'bytes',
        idempotencyKey: `media:${asset.id}:bytes`,
      })
      .catch((e) => this.logger.warn(`storage usage failed: ${e.message}`));
    await this.prisma.sessionEvent.create({ data: { sessionId: session.id, type: 'recording.completed', payload: { assetId, bytes: all.length, parts: parts.length } } });
    return { assetId, status: updated.status, sizeBytes: all.length };
  }
}
