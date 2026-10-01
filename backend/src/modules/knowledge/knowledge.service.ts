import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { AuditService } from '../../common/audit/audit.service';
import { DomainEvents } from '../../common/events/domain-events';
import type { Principal } from '../../common/auth/principal';
import { userIdOf } from '../../common/auth/principal';
import { AppError, Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES, QueueService } from '../../common/queue/queue.service';
import { StorageService } from '../../common/storage/storage.service';
import { UsageService } from '../usage/usage.service';
import { chunkDocument } from './chunking';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embeddings';
import type { KnowledgeSearchResult } from './knowledge.format';
import {
  assertAllowedUpload,
  cleanText,
  extractDocument,
  ExtractionError,
  MAX_EXTRACTED_CHARS,
  MIME,
  sanitizeFileName,
  sniffDocument,
  storageSafeName,
} from './text-extraction';

export type { KnowledgeSearchResult } from './knowledge.format';

/** "Ready" is stored as ProcessingStatus.COMPLETED. */
export const KNOWLEDGE_READY = 'COMPLETED' as const;

const MAX_QUERY_CHARS = 500;
const MAX_TOPK = 20;
/** Documents per workspace (soft limit to protect the DB). */
const MAX_DOCUMENTS_PER_WORKSPACE = 1000;

interface IngestJob {
  workspaceId: string;
  documentId: string;
}

@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger('Knowledge');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    @Optional() private readonly events?: DomainEvents,
    @Optional() @Inject(EMBEDDING_PROVIDER) private readonly embeddings?: EmbeddingProvider,
  ) {}

  onModuleInit() {
    this.queue.process<IngestJob>(QUEUES.knowledge, (job) => this.handleIngestJob(job), 2);
  }

  // ───────────────────────────── Contract for other workstreams ─────────────────────────────

  /**
   * Full-text search over READY, non-deleted documents of ONE workspace, restricted to `documentIds`.
   * Document ids from other workspaces never match (the SQL filters both chunk and document by workspaceId).
   * Results are untrusted data — format them with `formatKnowledgeResultsForModel` before giving them to a model.
   */
  async search(workspaceId: string, documentIds: string[] | null | undefined, query: string, topK = 4): Promise<KnowledgeSearchResult[]> {
    const q = cleanText(String(query ?? '')).replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS).trim();
    if (!workspaceId || !q) return [];
    const ids = documentIds == null ? null : [...new Set(documentIds.filter((d) => typeof d === 'string' && d.length <= 64))].slice(0, 200);
    if (ids && !ids.length) return [];
    const k = Math.min(Math.max(1, Math.floor(topK) || 4), MAX_TOPK);

    const docFilter = ids ? Prisma.sql`AND c."documentId" = ANY(${ids}::text[])` : Prisma.empty;
    // Rank first (cheap), then build ts_headline snippets only for the top-k rows.
    const base = (tsquery: Prisma.Sql) => Prisma.sql`
      WITH q AS (SELECT ${tsquery} AS query),
      ranked AS (
        SELECT c.id, c."documentId", d.title AS "documentTitle", c.page, c.heading, c.text, c.ordinal,
               ts_rank_cd(c.tsv, q.query, 32)::float8 AS score
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        CROSS JOIN q
        WHERE c."workspaceId" = ${workspaceId}
          AND d."workspaceId" = ${workspaceId}
          AND d."deletedAt" IS NULL
          AND d.status = 'COMPLETED'
          ${docFilter}
          AND c.tsv @@ q.query
        ORDER BY score DESC, c."documentId", c.ordinal
        LIMIT ${k}
      )
      SELECT r.id AS "chunkId", r."documentId", r."documentTitle", r.page, r.heading, r.text, r.score,
             ts_headline('english', r.text, q.query,
               'StartSel=«, StopSel=», MaxWords=45, MinWords=15, ShortWord=2, MaxFragments=2, FragmentDelimiter= … ') AS snippet
      FROM ranked r CROSS JOIN q
      ORDER BY r.score DESC, r."documentId", r.ordinal`;

    type Row = Omit<KnowledgeSearchResult, 'score'> & { score: number | string };
    let rows = await this.prisma.$queryRaw<Row[]>(base(Prisma.sql`websearch_to_tsquery('english', ${q})`));

    if (!rows.length) {
      // websearch_to_tsquery ANDs all terms; fall back to OR-ing the (non-stopword) lexemes.
      const orQuery = await this.prisma.$queryRaw<Array<{ q: string | null }>>`
        SELECT NULLIF(replace(plainto_tsquery('english', ${q})::text, ' & ', ' | '), '') AS q`;
      const tsText = orQuery[0]?.q;
      if (tsText) rows = await this.prisma.$queryRaw<Row[]>(base(Prisma.sql`to_tsquery('english', ${tsText})`));
    }

    if (!rows.length && q.length >= 3) {
      // Stopword-only / symbol queries (e.g. "SKU-42", "the who") → literal substring match.
      const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      rows = await this.prisma.$queryRaw<Row[]>`
        SELECT c.id AS "chunkId", c."documentId", d.title AS "documentTitle", c.page, c.heading, c.text,
               '' AS snippet, 0.0001::float8 AS score
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        WHERE c."workspaceId" = ${workspaceId}
          AND d."workspaceId" = ${workspaceId}
          AND d."deletedAt" IS NULL
          AND d.status = 'COMPLETED'
          ${docFilter}
          AND c.text ILIKE ${like}
        ORDER BY c."documentId", c.ordinal
        LIMIT ${k}`;
      rows = rows.map((r) => ({ ...r, snippet: literalSnippet(r.text, q) }));
    }

    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      documentTitle: r.documentTitle,
      page: r.page ?? null,
      heading: r.heading ?? null,
      text: r.text,
      snippet: r.snippet || r.text.slice(0, 300),
      score: Number(r.score) || 0,
    }));
  }

  /**
   * Extract plain text from an untrusted uploaded file (PDF / DOCX / UTF-8 text). The type is sniffed
   * from the bytes; `mimeType` is only a hint. Parsing runs in a memory-capped worker with a timeout.
   * Throws AppError (422) with a readable message on unsupported/invalid/oversized input.
   */
  async extractText(
    buffer: Buffer,
    mimeType?: string | null,
    opts: { maxBytes?: number; timeoutMs?: number; fileName?: string | null; maxChars?: number } = {},
  ): Promise<{ text: string; pageCount: number | null; mimeType: string }> {
    try {
      const doc = await extractDocument(buffer, mimeType, { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs ?? 30_000, fileName: opts.fileName });
      let text = doc.pages
        .filter((p) => p.text)
        .map((p) => (doc.kind === 'pdf' && doc.pages.length > 1 ? `[Page ${p.page}]\n${p.text}` : p.text))
        .join('\n\n');
      if (opts.maxChars && text.length > opts.maxChars) text = text.slice(0, opts.maxChars);
      return { text, pageCount: doc.pageCount, mimeType: doc.mimeType };
    } catch (e) {
      if (e instanceof ExtractionError) {
        throw e.code === 'too_large' ? tooLarge(e.message) : Errors.validation(e.message, { code: e.code });
      }
      throw e;
    }
  }

  // ───────────────────────────── Documents ─────────────────────────────

  async createFromUpload(
    workspaceId: string,
    principal: Principal | null,
    file: { buffer: Buffer; fileName?: string | null; mimeType?: string | null; title?: string | null },
  ) {
    const fileName = sanitizeFileName(file.fileName);
    let detected: { kind: string; mimeType: string };
    try {
      detected = sniffDocument(file.buffer, file.mimeType, fileName);
      assertAllowedUpload(file.buffer.length, detected.mimeType);
    } catch (e) {
      if (e instanceof ExtractionError) {
        if (e.code === 'too_large') throw tooLarge(e.message);
        throw Errors.validation(e.message, { code: e.code });
      }
      throw e;
    }
    await this.assertDocumentQuota(workspaceId);

    const title = cleanTitle(file.title) || titleFromFileName(fileName);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const doc = await this.prisma.knowledgeDocument.create({
      data: { workspaceId, title, mimeType: detected.mimeType, status: 'QUEUED', createdById: userIdOf(principal) },
    });
    const key = this.storage.key(workspaceId, 'knowledge', doc.id, storageSafeName(fileName));
    try {
      await this.storage.put(key, file.buffer, detected.mimeType);
      const asset = await this.prisma.mediaAsset.create({
        data: {
          workspaceId,
          kind: 'KNOWLEDGE_DOCUMENT',
          storageKey: key,
          fileName,
          mimeType: detected.mimeType,
          sizeBytes: BigInt(file.buffer.length),
          sha256,
          status: 'READY',
          createdById: userIdOf(principal),
          metadata: { knowledgeDocumentId: doc.id },
        },
      });
      await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { assetId: asset.id } });
    } catch (e) {
      await this.prisma.knowledgeDocument.delete({ where: { id: doc.id } }).catch(() => undefined);
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
    await this.audit.log({
      workspaceId,
      principal,
      action: 'knowledge.document.upload',
      targetType: 'KnowledgeDocument',
      targetId: doc.id,
      metadata: { title, fileName, mimeType: detected.mimeType, sizeBytes: file.buffer.length },
    });
    await this.enqueueIngest(workspaceId, doc.id);
    this.events?.emit('knowledge.uploaded', { documentId: doc.id, workspaceId });
    return this.get(workspaceId, doc.id);
  }

  async createFromText(workspaceId: string, principal: Principal | null, input: { title: string; text: string; format?: 'text' | 'markdown' }) {
    const text = String(input.text ?? '');
    const bytes = Buffer.from(text, 'utf8');
    if (!cleanText(text)) throw Errors.validation('Text is empty');
    if (text.length > MAX_EXTRACTED_CHARS) throw Errors.validation(`Text is too long (max ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters)`);
    const title = cleanTitle(input.title) || 'Untitled text';
    const mimeType = input.format === 'markdown' ? MIME.md : MIME.txt;
    return this.createFromUpload(workspaceId, principal, {
      buffer: bytes,
      fileName: `${storageSafeName(title)}.${input.format === 'markdown' ? 'md' : 'txt'}`,
      mimeType,
      title,
    });
  }

  async list(workspaceId: string, opts: { limit?: number; cursor?: string; q?: string; status?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Prisma.KnowledgeDocumentWhereInput = {
      workspaceId,
      deletedAt: null,
      ...(opts.q ? { title: { contains: opts.q.slice(0, 100), mode: 'insensitive' } } : {}),
      ...(opts.status ? { status: opts.status as any } : {}),
    };
    const cursorId = opts.cursor ? Buffer.from(opts.cursor, 'base64url').toString('utf8') : undefined;
    const rows = await this.prisma.knowledgeDocument.findMany({
      where,
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const assets = await this.assetsFor(workspaceId, page.map((d) => d.assetId).filter(Boolean) as string[]);
    const refs = await this.referencingScenarios(workspaceId, page.map((d) => d.id));
    return {
      data: page.map((d) => this.present(d, assets.get(d.assetId ?? ''), refs.get(d.id) ?? [])),
      nextCursor: hasMore ? Buffer.from(page[page.length - 1]!.id, 'utf8').toString('base64url') : null,
    };
  }

  async get(workspaceId: string, id: string) {
    const d = await this.findDoc(workspaceId, id);
    const assets = await this.assetsFor(workspaceId, d.assetId ? [d.assetId] : []);
    const refs = await this.referencingScenarios(workspaceId, [d.id]);
    return this.present(d, assets.get(d.assetId ?? ''), refs.get(d.id) ?? []);
  }

  async chunks(workspaceId: string, id: string, opts: { offset?: number; limit?: number } = {}) {
    const d = await this.findDoc(workspaceId, id);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const [rows, total] = await Promise.all([
      this.prisma.knowledgeChunk.findMany({
        where: { workspaceId, documentId: d.id },
        orderBy: { ordinal: 'asc' },
        skip: offset,
        take: limit,
        select: { id: true, ordinal: true, page: true, heading: true, text: true, tokenCount: true },
      }),
      this.prisma.knowledgeChunk.count({ where: { workspaceId, documentId: d.id } }),
    ]);
    return { data: rows, total, offset, limit, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  async update(workspaceId: string, principal: Principal | null, id: string, input: { title?: string }) {
    const d = await this.findDoc(workspaceId, id);
    const title = input.title !== undefined ? cleanTitle(input.title) : undefined;
    if (title !== undefined && !title) throw Errors.validation('Title is required');
    await this.prisma.knowledgeDocument.update({ where: { id: d.id }, data: { ...(title ? { title } : {}) } });
    await this.audit.log({ workspaceId, principal, action: 'knowledge.document.update', targetType: 'KnowledgeDocument', targetId: d.id, metadata: { title } });
    return this.get(workspaceId, id);
  }

  async remove(workspaceId: string, principal: Principal | null, id: string) {
    const d = await this.findDoc(workspaceId, id);
    const refs = (await this.referencingScenarios(workspaceId, [d.id])).get(d.id) ?? [];
    const now = new Date();
    let storageKey: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeDocument.update({ where: { id: d.id }, data: { deletedAt: now, chunkCount: 0 } });
      await tx.knowledgeChunk.deleteMany({ where: { workspaceId, documentId: d.id } });
      if (d.assetId) {
        const asset = await tx.mediaAsset.findFirst({ where: { id: d.assetId, workspaceId } });
        if (asset) {
          storageKey = asset.storageKey;
          await tx.mediaAsset.update({ where: { id: asset.id }, data: { status: 'DELETED', deletedAt: now } });
        }
      }
    });
    if (storageKey) {
      try {
        this.storage.assertWorkspaceKey(workspaceId, storageKey);
        await this.storage.delete(storageKey);
      } catch (e: any) {
        this.logger.warn(`Could not delete storage object for knowledge document ${d.id}: ${e?.message}`);
      }
    }
    await this.audit.log({
      workspaceId,
      principal,
      action: 'knowledge.document.delete',
      targetType: 'KnowledgeDocument',
      targetId: d.id,
      metadata: { title: d.title, referencedBy: refs.map((r) => r.scenarioId) },
    });
    return { ok: true, referencedBy: refs };
  }

  async reprocess(workspaceId: string, principal: Principal | null, id: string) {
    const d = await this.findDoc(workspaceId, id);
    if (!d.assetId) throw Errors.badRequest('This document has no stored source to reprocess');
    if (d.status === 'PROCESSING') throw Errors.conflict('The document is already being processed');
    await this.prisma.knowledgeDocument.update({ where: { id: d.id }, data: { status: 'QUEUED', error: null } });
    await this.audit.log({ workspaceId, principal, action: 'knowledge.document.reprocess', targetType: 'KnowledgeDocument', targetId: d.id });
    await this.enqueueIngest(workspaceId, d.id, `r${Date.now()}`);
    return this.get(workspaceId, id);
  }

  async downloadUrl(workspaceId: string, id: string) {
    const d = await this.findDoc(workspaceId, id);
    if (!d.assetId) throw Errors.notFound('Original file');
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: d.assetId, workspaceId, deletedAt: null } });
    if (!asset) throw Errors.notFound('Original file');
    const ttl = 300;
    return { url: await this.storage.signedUrl(asset, ttl), expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), fileName: asset.fileName };
  }

  /** Which scenarios reference each document (latest published version and/or current draft). */
  async referencingScenarios(workspaceId: string, documentIds: string[]) {
    const out = new Map<string, Array<{ scenarioId: string; name: string; published: boolean; draft: boolean; version: number | null }>>();
    if (!documentIds.length) return out;
    const rows = await this.prisma.$queryRaw<Array<{ documentId: string; scenarioId: string; name: string; version: number | null; inPublished: boolean; inDraft: boolean }>>`
      SELECT ids.id AS "documentId", s.id AS "scenarioId", s.name, v.version,
             COALESCE((v.config->'knowledge'->'documentIds') ? ids.id, false) AS "inPublished",
             COALESCE((dr.config->'knowledge'->'documentIds') ? ids.id, false) AS "inDraft"
      FROM unnest(${documentIds}::text[]) AS ids(id)
      JOIN "Scenario" s ON s."workspaceId" = ${workspaceId} AND s."deletedAt" IS NULL
      LEFT JOIN "ScenarioVersion" v ON v.id = s."latestVersionId" AND v."workspaceId" = ${workspaceId}
      LEFT JOIN "ScenarioDraft" dr ON dr."scenarioId" = s.id
      WHERE COALESCE((v.config->'knowledge'->'documentIds') ? ids.id, false)
         OR COALESCE((dr.config->'knowledge'->'documentIds') ? ids.id, false)
      ORDER BY s.name`;
    for (const r of rows) {
      const list = out.get(r.documentId) ?? [];
      list.push({ scenarioId: r.scenarioId, name: r.name, published: r.inPublished, draft: r.inDraft, version: r.inPublished ? r.version : null });
      out.set(r.documentId, list);
    }
    return out;
  }

  // ───────────────────────────── Ingestion worker ─────────────────────────────

  async enqueueIngest(workspaceId: string, documentId: string, suffix?: string) {
    await this.queue.enqueue(
      QUEUES.knowledge,
      'ingest',
      { workspaceId, documentId } satisfies IngestJob,
      { jobId: suffix ? `knowledge_${documentId}_${suffix}` : `knowledge_${documentId}`, attempts: 3 },
    );
  }

  private async handleIngestJob(job: Job<IngestJob>) {
    const { workspaceId, documentId } = job.data;
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
    try {
      return await this.ingest(workspaceId, documentId);
    } catch (e: any) {
      if (!(e instanceof ExtractionError) && !isLastAttempt) {
        // Transient failure (DB/storage) → let BullMQ retry, but show it is still being worked on.
        await this.prisma.knowledgeDocument
          .updateMany({ where: { id: documentId, workspaceId }, data: { status: 'QUEUED', error: `Retrying after error: ${String(e?.message ?? e).slice(0, 200)}` } })
          .catch(() => undefined);
        throw e;
      }
      return undefined;
    }
  }

  /**
   * Idempotent ingestion: extract → chunk → replace chunks in a single transaction → mark READY.
   * Deterministic ExtractionErrors mark the document FAILED with a readable message (no retry).
   */
  async ingest(workspaceId: string, documentId: string): Promise<{ status: string; chunkCount: number }> {
    const doc = await this.prisma.knowledgeDocument.findFirst({ where: { id: documentId, workspaceId } });
    if (!doc || doc.deletedAt) return { status: 'SKIPPED', chunkCount: 0 };
    if (!doc.assetId) {
      await this.fail(doc.id, 'No source file is stored for this document');
      return { status: 'FAILED', chunkCount: 0 };
    }
    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: doc.assetId, workspaceId, deletedAt: null } });
    if (!asset) {
      await this.fail(doc.id, 'The source file is missing');
      return { status: 'FAILED', chunkCount: 0 };
    }
    await this.prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'PROCESSING', error: null } });

    const started = Date.now();
    try {
      this.storage.assertWorkspaceKey(workspaceId, asset.storageKey);
      const buf = await this.storage.get(asset.storageKey);
      const extracted = await extractDocument(buf, asset.mimeType, { fileName: asset.fileName });
      if (!extracted.charCount) {
        throw new ExtractionError(
          extracted.kind === 'pdf'
            ? 'No text could be extracted. The PDF may be scanned images only (OCR is not supported); upload a text-based PDF.'
            : 'The document contains no text',
          'empty',
        );
      }
      const chunks = chunkDocument(extracted.pages);
      const committed = await this.prisma.$transaction(
        async (tx) => {
          // Re-check inside the transaction: the document may have been deleted meanwhile.
          const cur = await tx.knowledgeDocument.findFirst({ where: { id: doc.id, workspaceId }, select: { deletedAt: true } });
          if (!cur || cur.deletedAt) return false;
          await tx.knowledgeChunk.deleteMany({ where: { documentId: doc.id } });
          // `tsv` is a GENERATED column (prisma/sql/post-push.sql); Prisma ignores Unsupported fields.
          for (let i = 0; i < chunks.length; i += 500) {
            await tx.knowledgeChunk.createMany({
              data: chunks.slice(i, i + 500).map((c) => ({
                documentId: doc.id,
                workspaceId,
                ordinal: c.ordinal,
                text: c.text,
                page: c.page,
                heading: c.heading ? c.heading.slice(0, 300) : null,
                tokenCount: c.tokenCount,
              })),
            });
          }
          await tx.knowledgeDocument.update({
            where: { id: doc.id },
            data: {
              status: KNOWLEDGE_READY,
              error: null,
              pageCount: extracted.pageCount,
              chunkCount: chunks.length,
              charCount: extracted.charCount,
              mimeType: extracted.mimeType,
            },
          });
          return true;
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      if (!committed) return { status: 'SKIPPED', chunkCount: 0 };
      await this.usage
        .record({
          workspaceId,
          kind: 'STORAGE_BYTES',
          provider: 'storage',
          quantity: Number(asset.sizeBytes),
          unit: 'bytes',
          idempotencyKey: `storage:knowledge:${doc.id}`,
          metadata: { documentId: doc.id, kind: 'knowledge_document' },
        })
        .catch((e) => this.logger.warn(`Usage record failed for ${doc.id}: ${e?.message}`));
      this.logger.log(`Ingested knowledge document ${doc.id}: ${chunks.length} chunks, ${extracted.charCount} chars in ${Date.now() - started} ms`);
      return { status: KNOWLEDGE_READY, chunkCount: chunks.length };
    } catch (e: any) {
      if (e instanceof ExtractionError) {
        await this.fail(doc.id, e.message);
        return { status: 'FAILED', chunkCount: 0 };
      }
      this.logger.error(`Knowledge ingest error for ${doc.id}: ${e?.message}`);
      await this.fail(doc.id, 'Processing failed due to an internal error. Try "Reprocess" again later.');
      throw e;
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async fail(documentId: string, message: string) {
    await this.prisma.knowledgeDocument.update({ where: { id: documentId }, data: { status: 'FAILED', error: message.slice(0, 500) } }).catch(() => undefined);
  }

  private async findDoc(workspaceId: string, id: string) {
    if (!id || id.length > 64) throw Errors.notFound('Document');
    const d = await this.prisma.knowledgeDocument.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!d) throw Errors.notFound('Document');
    return d;
  }

  private async assertDocumentQuota(workspaceId: string) {
    const n = await this.prisma.knowledgeDocument.count({ where: { workspaceId, deletedAt: null } });
    if (n >= MAX_DOCUMENTS_PER_WORKSPACE) {
      throw Errors.quota(`This workspace has reached the limit of ${MAX_DOCUMENTS_PER_WORKSPACE} knowledge documents. Delete unused documents first.`);
    }
  }

  private async assetsFor(workspaceId: string, ids: string[]) {
    const map = new Map<string, { fileName: string | null; sizeBytes: bigint; mimeType: string }>();
    if (!ids.length) return map;
    const rows = await this.prisma.mediaAsset.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, fileName: true, sizeBytes: true, mimeType: true },
    });
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  private present(
    d: Prisma.KnowledgeDocumentGetPayload<object>,
    asset: { fileName: string | null; sizeBytes: bigint } | undefined,
    referencedBy: Array<{ scenarioId: string; name: string; published: boolean; draft: boolean; version: number | null }>,
  ) {
    return {
      id: d.id,
      title: d.title,
      mimeType: d.mimeType,
      status: d.status,
      ready: d.status === KNOWLEDGE_READY,
      error: d.error,
      pageCount: d.pageCount,
      chunkCount: d.chunkCount,
      charCount: d.charCount,
      fileName: asset?.fileName ?? null,
      sizeBytes: asset ? Number(asset.sizeBytes) : null,
      hasSource: !!d.assetId,
      createdById: d.createdById,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      referencedBy,
    };
  }
}

/** HTTP 413 with the standard error envelope. */
export function tooLarge(message: string) {
  return new AppError(413, 'payload_too_large', message);
}

function cleanTitle(t: string | null | undefined): string {
  return cleanText(String(t ?? ''))
    .replace(/\s+/g, ' ')
    .slice(0, 200)
    .trim();
}

function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_]+/g, ' ').trim();
  return (base || 'Untitled document').slice(0, 200);
}

function literalSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 240);
  const start = Math.max(0, i - 100);
  const end = Math.min(text.length, i + q.length + 140);
  return `${start > 0 ? '… ' : ''}${text.slice(start, i)}«${text.slice(i, i + q.length)}»${text.slice(i + q.length, end)}${end < text.length ? ' …' : ''}`;
}
