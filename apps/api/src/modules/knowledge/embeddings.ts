/**
 * Optional semantic search extension point.
 *
 * Retrieval today is PostgreSQL full-text search (tsvector + GIN, ts_rank_cd). Semantic search can be
 * added later without touching callers:
 *   1. `CREATE EXTENSION vector;` and add `embedding vector(<dims>)` to "KnowledgeChunk" in
 *      prisma/sql/post-push.sql (Prisma sees it as Unsupported, like `tsv`), plus an HNSW index.
 *   2. Implement EmbeddingProvider (e.g. OpenAI text-embedding-3-small or Voyage) and bind it to
 *      EMBEDDING_PROVIDER in KnowledgeModule.
 *   3. In the ingest worker, embed chunks in batches, record EMBEDDING_TOKENS usage, and
 *      in KnowledgeService.search combine FTS rank with cosine similarity (reciprocal-rank fusion).
 * The default provider is a no-op, so the FTS path is used.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly enabled: boolean;
  readonly dimensions: number;
  embed(workspaceId: string, texts: string[]): Promise<number[][] | null>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'none';
  readonly enabled = false;
  readonly dimensions = 0;
  async embed(): Promise<null> {
    return null;
  }
}
