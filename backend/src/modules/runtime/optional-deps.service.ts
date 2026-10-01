import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

/**
 * Soft dependencies on other workstreams' services. The runtime must work when those modules are absent
 * or still placeholders, so they are looked up lazily by class via ModuleRef (strict: false) from a list
 * of candidate module paths, never imported statically.
 *
 * Contracts used (docs/ARCHITECTURE.md):
 *   KnowledgeService.search(workspaceId, documentIds, query, topK) → [{ chunkId, documentId, documentTitle, page, heading, text, score }]
 *   KnowledgeService.extractText(buffer, mimeType) → { text, pageCount }
 *   CustomFunctionsService.execute(workspaceId, functionId, args, ctx) → { ok, result | error }
 *   MemoryService.factsForSession(workspaceId, participantId, scenarioId, limit) → MemoryFact[]
 */
export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  page: number | null;
  heading: string | null;
  text: string;
  score: number;
}
export interface KnowledgeLike {
  search(workspaceId: string, documentIds: string[], query: string, topK: number): Promise<KnowledgeHit[]>;
  extractText?(
    buffer: Buffer,
    mimeType: string,
    opts?: { fileName?: string | null; maxChars?: number; maxBytes?: number },
  ): Promise<{ text: string; pageCount?: number | null }>;
}
export interface CustomFunctionsLike {
  execute(
    workspaceId: string,
    functionId: string,
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}
export interface MemoryLike {
  factsForSession(
    workspaceId: string,
    participantId: string,
    scenarioId: string,
    limit: number,
  ): Promise<Array<{ category?: string | null; content: string }>>;
}

const CANDIDATES = {
  knowledge: [
    ['../knowledge/knowledge.service', 'KnowledgeService'],
    ['../knowledge/knowledge-search.service', 'KnowledgeService'],
  ],
  customFunctions: [
    ['../providers/custom-functions.service', 'CustomFunctionsService'],
    ['../providers/functions.service', 'CustomFunctionsService'],
    ['../knowledge/custom-functions.service', 'CustomFunctionsService'],
    ['../providers/custom-function.service', 'CustomFunctionsService'],
  ],
  memory: [
    ['../coach/memory.service', 'MemoryService'],
    ['../coach/coach-memory.service', 'MemoryService'],
    ['../coach/coach.service', 'MemoryService'],
  ],
} as const;

@Injectable()
export class OptionalDepsService {
  private readonly logger = new Logger('RuntimeDeps');
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly moduleRef: ModuleRef) {}

  private lookup<T>(key: keyof typeof CANDIDATES, method: string): T | null {
    if (this.cache.has(key)) return (this.cache.get(key) as T) ?? null;
    let found: T | null = null;
    for (const [path, exportName] of CANDIDATES[key]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(path);
        const cls = mod?.[exportName];
        if (!cls) continue;
        const instance = this.moduleRef.get(cls, { strict: false });
        if (instance && typeof (instance as any)[method] === 'function') {
          found = instance as T;
          break;
        }
      } catch {
        /* module not present / provider not registered */
      }
    }
    // Only cache positive results so a later-registered provider is still picked up.
    if (found) {
      this.cache.set(key, found);
      this.logger.log(`Using ${key} integration`);
    }
    return found;
  }

  knowledge(): KnowledgeLike | null {
    return this.lookup<KnowledgeLike>('knowledge', 'search');
  }
  customFunctions(): CustomFunctionsLike | null {
    return this.lookup<CustomFunctionsLike>('customFunctions', 'execute');
  }
  memory(): MemoryLike | null {
    return this.lookup<MemoryLike>('memory', 'factsForSession');
  }
  /** Text extraction: KnowledgeService.extractText when available. */
  extractor(): Required<Pick<KnowledgeLike, 'extractText'>> | null {
    const k = this.lookup<KnowledgeLike>('knowledge', 'search');
    if (k && typeof k.extractText === 'function') return k as Required<Pick<KnowledgeLike, 'extractText'>>;
    return null;
  }
}
