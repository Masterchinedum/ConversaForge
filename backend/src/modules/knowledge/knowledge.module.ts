import { Module } from '@nestjs/common';
import { EMBEDDING_PROVIDER, NoopEmbeddingProvider } from './embeddings';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

export { KnowledgeService } from './knowledge.service';
export { formatKnowledgeResultsForModel, citationLabel, type KnowledgeSearchResult } from './knowledge.format';

/**
 * Knowledge base (workstream G). Exports KnowledgeService:
 *   search(workspaceId, documentIds, query, topK) → KnowledgeSearchResult[]  (workspace-scoped FTS)
 *   extractText(buffer, mimeType)                 → { text, pageCount }      (untrusted files)
 * Use formatKnowledgeResultsForModel(results) before handing excerpts to a model.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, { provide: EMBEDDING_PROVIDER, useClass: NoopEmbeddingProvider }],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
