import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UPLOAD_LIMITS } from '@cf/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentPrincipal, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { parseOrThrow, ZodPipe } from '../../common/http/zod.pipe';
import { formatKnowledgeResultsForModel, citationLabel } from './knowledge.format';
import { KnowledgeService, tooLarge } from './knowledge.service';

const TextDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(2_000_000),
  format: z.enum(['text', 'markdown']).optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  q: z.string().max(100).optional(),
  status: z.enum(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
});

const ChunksQuery = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const SearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  documentIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  topK: z.number().int().min(1).max(20).default(5),
});

const UpdateSchema = z.object({ title: z.string().trim().min(1).max(200) });

/**
 * Knowledge base. All routes require `knowledge.manage` (CREATOR+): documents are workspace content
 * used to build scenarios; participants only reach them indirectly via the runtime's knowledge_search.
 */
@ApiTags('knowledge')
@Controller('workspaces/:workspaceId/knowledge')
@RequireCapability('knowledge.manage')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('documents')
  list(@Param('workspaceId') workspaceId: string, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.knowledge.list(workspaceId, q);
  }

  /** Multipart upload (`file` + optional `title` field) or JSON `{ title, text, format? }`. */
  @Post('documents')
  async create(@Param('workspaceId') workspaceId: string, @CurrentPrincipal() principal: Principal, @Req() req: FastifyRequest) {
    if (!(req as any).isMultipart?.()) {
      const body = parseOrThrow(TextDocumentSchema, req.body);
      return this.knowledge.createFromText(workspaceId, principal, body);
    }
    const max = UPLOAD_LIMITS.knowledgeDocument.maxBytes;
    const part = await (req as any).file({ limits: { fileSize: max, files: 1, fields: 5, fieldSize: 1024 } });
    if (!part) throw Errors.validation('No file was uploaded (expected a multipart field named "file")');
    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch (e: any) {
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413) {
        throw tooLarge(`File is too large (max ${Math.round(max / 1024 / 1024)} MB)`);
      }
      throw Errors.badRequest('Upload failed');
    }
    if (part.file?.truncated) throw tooLarge(`File is too large (max ${Math.round(max / 1024 / 1024)} MB)`);
    const titleField = part.fields?.title;
    const title = titleField && !Array.isArray(titleField) && 'value' in titleField ? String(titleField.value ?? '') : undefined;
    return this.knowledge.createFromUpload(workspaceId, principal, {
      buffer,
      fileName: part.filename,
      mimeType: part.mimetype,
      title,
    });
  }

  @Post('documents/text')
  createText(
    @Param('workspaceId') workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(TextDocumentSchema)) body: z.infer<typeof TextDocumentSchema>,
  ) {
    return this.knowledge.createFromText(workspaceId, principal, body);
  }

  @Get('documents/:documentId')
  get(@Param('workspaceId') workspaceId: string, @Param('documentId') id: string) {
    return this.knowledge.get(workspaceId, id);
  }

  @Get('documents/:documentId/chunks')
  chunks(@Param('workspaceId') workspaceId: string, @Param('documentId') id: string, @Query(new ZodPipe(ChunksQuery)) q: z.infer<typeof ChunksQuery>) {
    return this.knowledge.chunks(workspaceId, id, q);
  }

  @Patch('documents/:documentId')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('documentId') id: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>,
  ) {
    return this.knowledge.update(workspaceId, principal, id, body);
  }

  @Delete('documents/:documentId')
  remove(@Param('workspaceId') workspaceId: string, @Param('documentId') id: string, @CurrentPrincipal() principal: Principal) {
    return this.knowledge.remove(workspaceId, principal, id);
  }

  @Post('documents/:documentId/reprocess')
  @HttpCode(202)
  reprocess(@Param('workspaceId') workspaceId: string, @Param('documentId') id: string, @CurrentPrincipal() principal: Principal) {
    return this.knowledge.reprocess(workspaceId, principal, id);
  }

  /** Short-lived signed URL for the original file (issued only after the capability check above). */
  @Get('documents/:documentId/download')
  download(@Param('workspaceId') workspaceId: string, @Param('documentId') id: string) {
    return this.knowledge.downloadUrl(workspaceId, id);
  }

  /** Search tester: ranked excerpts with citations, plus the exact text a model would receive. */
  @Post('search')
  @HttpCode(200)
  async search(@Param('workspaceId') workspaceId: string, @Body(new ZodPipe(SearchSchema)) body: z.infer<typeof SearchSchema>) {
    const started = Date.now();
    const results = await this.knowledge.search(workspaceId, body.documentIds ?? null, body.query, body.topK);
    return {
      query: body.query,
      tookMs: Date.now() - started,
      results: results.map((r) => ({ ...r, citation: citationLabel(r) })),
      modelContext: formatKnowledgeResultsForModel(results),
    };
  }
}
