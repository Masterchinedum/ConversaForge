/**
 * Test-only wiring for workstream G integration specs (real Postgres, local storage in a temp dir,
 * stubbed queue). Enable with G_TEST_DATABASE_URL=postgresql://…/conversaforge_test_g (the DB must
 * be synced: prisma db push + prisma/sql/post-push.sql). Not used at runtime.
 */
import { PrismaClient } from '@prisma/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export const G_TEST_DB: string | null =
  process.env.G_TEST_DATABASE_URL ?? (process.env.DATABASE_URL?.includes('conversaforge_test_g') ? process.env.DATABASE_URL : null);

export function prepareEnv() {
  if (!G_TEST_DB) throw new Error('G_TEST_DATABASE_URL is not set');
  process.env.DATABASE_URL = G_TEST_DB;
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_DIR = mkdtempSync(path.join(tmpdir(), 'cf-g-storage-'));
  process.env.ENCRYPTION_KEY ??= 'test-encryption-key-test-encryption-key-0123456789';
  process.env.SIGNING_SECRET ??= 'test-signing-secret-test-signing-secret-0123456789';
  process.env.ALLOW_SIMULATOR = 'true';
  // Never pick up real provider keys during tests.
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'RECALL_API_KEY']) {
    process.env[k] = '';
  }
}

export async function createGTestContext() {
  prepareEnv();
  // Import lazily so env is prepared first.
  const { CryptoService } = await import('../../common/crypto/crypto.service');
  const { StorageService } = await import('../../common/storage/storage.service');
  const { AuditService } = await import('../../common/audit/audit.service');
  const { DomainEvents } = await import('../../common/events/domain-events');
  const { UsageService } = await import('../usage/usage.service');
  const { LlmService } = await import('../../common/llm/llm.service');
  const { KnowledgeService } = await import('./knowledge.service');
  const { NoopEmbeddingProvider } = await import('./embeddings');
  const { ProvidersService } = await import('../providers/providers.service');
  const { CustomFunctionsService } = await import('../providers/custom-functions.service');

  const prisma = new PrismaClient({ datasources: { db: { url: G_TEST_DB! } } }) as any;
  const crypto = new CryptoService();
  const storage = new StorageService(crypto);
  const audit = new AuditService(prisma);
  const events = new DomainEvents();
  const usage = new UsageService(prisma, events);
  const llm = new LlmService(prisma, crypto);
  const enqueued: Array<{ queue: string; name: string; data: any; opts: any }> = [];
  const queue = {
    enqueued,
    enqueue: async (q: string, name: string, data: any, opts: any) => {
      enqueued.push({ queue: q, name, data, opts });
    },
    process: () => undefined,
  } as any;
  const knowledge = new KnowledgeService(prisma, storage, queue, audit, usage, events, new NoopEmbeddingProvider());
  const providers = new ProvidersService(prisma, crypto, audit, llm);
  const functions = new CustomFunctionsService(prisma, crypto, audit);

  const suffix = Math.random().toString(36).slice(2, 8);
  async function workspace(name: string) {
    return prisma.workspace.create({ data: { name, slug: `g-${name.toLowerCase()}-${suffix}-${Math.random().toString(36).slice(2, 6)}` } });
  }
  const principal = { kind: 'user' as const, userId: 'u_test', email: 't@example.com', name: 'T', authSessionId: 's', isSuperAdmin: false };

  return { prisma, crypto, storage, audit, usage, llm, queue, knowledge, providers, functions, workspace, principal };
}
