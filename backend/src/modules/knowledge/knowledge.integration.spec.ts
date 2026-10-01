import { createGTestContext, G_TEST_DB } from './g-test-context';
import { buildDocx, buildPdf } from './knowledge.test-helpers';

/**
 * Knowledge integration (real Postgres FTS). Run with:
 *   G_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_test_g npx jest src/modules/knowledge
 */
const d = G_TEST_DB ? describe : describe.skip;

d('KnowledgeService (integration)', () => {
  let ctx: Awaited<ReturnType<typeof createGTestContext>>;
  let wsA: { id: string };
  let wsB: { id: string };

  beforeAll(async () => {
    ctx = await createGTestContext();
    wsA = await ctx.workspace('A');
    wsB = await ctx.workspace('B');
  });
  afterAll(async () => {
    await ctx?.prisma.workspace.deleteMany({ where: { id: { in: [wsA?.id, wsB?.id].filter(Boolean) } } });
    await ctx?.prisma.knowledgeDocument.deleteMany({ where: { workspaceId: { in: [wsA?.id, wsB?.id].filter(Boolean) } } });
    await ctx?.prisma.$disconnect();
  });

  async function uploadAndIngest(workspaceId: string, buffer: Buffer, fileName: string, mimeType: string, title?: string) {
    const doc = await ctx.knowledge.createFromUpload(workspaceId, ctx.principal, { buffer, fileName, mimeType, title });
    expect(doc.status).toBe('QUEUED');
    const res = await ctx.knowledge.ingest(workspaceId, doc.id);
    return { doc, res };
  }

  it('uploads a real PDF, stores it tenant-prefixed, enqueues, ingests with page numbers and records storage usage once', async () => {
    const pdf = await buildPdf([
      'Acme Returns Policy. Customers may return unused items within 30 days of delivery for a full refund.',
      'Warranty. Acme covers manufacturing defects for two years. Batteries are excluded from the warranty.',
    ]);
    const { doc, res } = await uploadAndIngest(wsA.id, pdf, '../../Acme Policy.pdf', 'application/pdf');
    expect(ctx.queue.enqueued.at(-1)).toMatchObject({ queue: 'knowledge-ingest', opts: { jobId: `knowledge_${doc.id}` } });
    expect(res.status).toBe('COMPLETED');

    const stored = await ctx.knowledge.get(wsA.id, doc.id);
    expect(stored).toMatchObject({ status: 'COMPLETED', pageCount: 2, fileName: 'Acme Policy.pdf', title: 'Acme Policy', mimeType: 'application/pdf' });
    expect(stored.chunkCount).toBeGreaterThanOrEqual(1);
    const asset = await ctx.prisma.mediaAsset.findFirst({ where: { workspaceId: wsA.id, kind: 'KNOWLEDGE_DOCUMENT', metadata: { path: ['knowledgeDocumentId'], equals: doc.id } } });
    expect(asset.storageKey).toBe(`ws/${wsA.id}/knowledge/${doc.id}/Acme_Policy.pdf`);

    const hits = await ctx.knowledge.search(wsA.id, [doc.id], 'warranty batteries', 3);
    expect(hits[0]).toMatchObject({ documentId: doc.id, documentTitle: 'Acme Policy', page: 2 });
    expect(hits[0]!.snippet).toMatch(/«/);
    expect(hits[0]!.score).toBeGreaterThan(0);

    // Re-ingest is idempotent: same chunk count, usage recorded only once.
    const again = await ctx.knowledge.ingest(wsA.id, doc.id);
    expect(again.chunkCount).toBe(stored.chunkCount);
    expect(await ctx.prisma.knowledgeChunk.count({ where: { documentId: doc.id } })).toBe(stored.chunkCount);
    expect(await ctx.prisma.usageLedger.count({ where: { idempotencyKey: `storage:knowledge:${doc.id}` } })).toBe(1);
  }, 60_000);

  it('ingests DOCX and pasted Markdown text', async () => {
    const { doc } = await uploadAndIngest(wsA.id, buildDocx(['Onboarding handbook', 'Every new hire receives a laptop and a mentor in week one.']), 'handbook.docx', 'application/octet-stream');
    expect((await ctx.knowledge.get(wsA.id, doc.id)).mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect((await ctx.knowledge.search(wsA.id, [doc.id], 'mentor laptop', 2))[0]?.documentId).toBe(doc.id);

    const md = await ctx.knowledge.createFromText(wsA.id, ctx.principal, { title: 'Pricing FAQ', text: '# Pricing\n\nThe Pro plan costs 49 dollars per seat.\n\n# Discounts\n\nNonprofits receive 30 percent off.', format: 'markdown' });
    await ctx.knowledge.ingest(wsA.id, md.id);
    const hit = (await ctx.knowledge.search(wsA.id, [md.id], 'nonprofit discount', 2))[0];
    expect(hit).toMatchObject({ documentId: md.id, heading: 'Pricing', page: null });
  }, 60_000);

  it('never returns chunks across workspaces, even when given another workspace’s document id', async () => {
    const a = await uploadAndIngest(wsA.id, Buffer.from('The zebra protocol requires three approvals.'), 'zebra-a.txt', 'text/plain');
    const b = await uploadAndIngest(wsB.id, Buffer.from('The zebra protocol in workspace B is secret.'), 'zebra-b.txt', 'text/plain');

    // A scoped to its own doc → only A.
    const own = await ctx.knowledge.search(wsA.id, [a.doc.id], 'zebra protocol', 5);
    expect(own.map((h) => h.documentId)).toEqual([a.doc.id]);
    // A asking for B's document id → nothing (all fallbacks included).
    expect(await ctx.knowledge.search(wsA.id, [b.doc.id], 'zebra protocol', 5)).toEqual([]);
    expect(await ctx.knowledge.search(wsA.id, [b.doc.id], 'zebra', 5)).toEqual([]);
    expect(await ctx.knowledge.search(wsA.id, [b.doc.id], 'secret', 5)).toEqual([]);
    expect(await ctx.knowledge.search(wsA.id, [a.doc.id, b.doc.id], 'zebra', 5)).toEqual([expect.objectContaining({ documentId: a.doc.id })]);
    // Unscoped (search tester) → still only the caller's workspace.
    const all = await ctx.knowledge.search(wsA.id, null, 'zebra', 10);
    expect(all.every((h) => h.documentId !== b.doc.id)).toBe(true);
    // B's own view works.
    expect((await ctx.knowledge.search(wsB.id, [b.doc.id], 'zebra', 5))[0]?.documentId).toBe(b.doc.id);
    // Cross-workspace get/delete/chunks are 404s.
    await expect(ctx.knowledge.get(wsA.id, b.doc.id)).rejects.toMatchObject({ status: 404 });
    await expect(ctx.knowledge.remove(wsA.id, ctx.principal, b.doc.id)).rejects.toMatchObject({ status: 404 });
    await expect(ctx.knowledge.chunks(wsA.id, b.doc.id)).rejects.toMatchObject({ status: 404 });
    // Empty document list → no results (a scenario with no documents gets nothing).
    expect(await ctx.knowledge.search(wsA.id, [], 'zebra', 5)).toEqual([]);
  }, 60_000);

  it('scopes results to the given document ids and falls back when the AND-query has no match', async () => {
    const x = await uploadAndIngest(wsA.id, Buffer.from('Kiwi shipping takes five business days.'), 'kiwi.txt', 'text/plain');
    const y = await uploadAndIngest(wsA.id, Buffer.from('Kiwi returns are free of charge.'), 'kiwi2.txt', 'text/plain');
    expect((await ctx.knowledge.search(wsA.id, [y.doc.id], 'kiwi', 5)).map((h) => h.documentId)).toEqual([y.doc.id]);
    // "kiwi shipping returns" matches neither chunk with AND semantics → OR fallback finds both.
    const or = await ctx.knowledge.search(wsA.id, [x.doc.id, y.doc.id], 'kiwi shipping returns', 5);
    expect(new Set(or.map((h) => h.documentId))).toEqual(new Set([x.doc.id, y.doc.id]));
    // Stop-word/symbol query → literal ILIKE fallback.
    const hamlet = await uploadAndIngest(wsA.id, Buffer.from('Hamlet asks whether to be or not to be.'), 'hamlet.txt', 'text/plain');
    expect((await ctx.knowledge.search(wsA.id, [hamlet.doc.id], 'not to be', 5))[0]?.snippet).toContain('«not to be»');
    expect(await ctx.knowledge.search(wsB.id, [hamlet.doc.id], 'not to be', 5)).toEqual([]);
    // Hostile query syntax does not throw.
    expect(await ctx.knowledge.search(wsA.id, [x.doc.id], `') OR 1=1 -- & | ! :*`, 5)).toBeInstanceOf(Array);
  }, 60_000);

  it('rejects bad uploads (magic bytes, NUL bytes, oversize) with clear errors', async () => {
    await expect(
      ctx.knowledge.createFromUpload(wsA.id, ctx.principal, { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), fileName: 'x.pdf', mimeType: 'application/pdf' }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      ctx.knowledge.createFromUpload(wsA.id, ctx.principal, { buffer: Buffer.from('abc\u0000def'), fileName: 'x.txt', mimeType: 'text/plain' }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      ctx.knowledge.createFromUpload(wsA.id, ctx.principal, { buffer: Buffer.alloc(26 * 1024 * 1024, 0x61), fileName: 'big.txt', mimeType: 'text/plain' }),
    ).rejects.toMatchObject({ status: 413 });
  }, 60_000);

  it('marks image-only PDFs as FAILED with a readable error', async () => {
    const { doc, res } = await uploadAndIngest(wsA.id, await buildPdf(['']), 'scan.pdf', 'application/pdf');
    expect(res.status).toBe('FAILED');
    expect((await ctx.knowledge.get(wsA.id, doc.id)).error).toMatch(/scanned|no text/i);
  }, 60_000);

  it('lists referencing scenarios; delete removes chunks + storage and hides the doc from search', async () => {
    const { doc } = await uploadAndIngest(wsA.id, Buffer.from('Quokka onboarding checklist for managers.'), 'quokka.txt', 'text/plain');
    const scenario = await ctx.prisma.scenario.create({ data: { workspaceId: wsA.id, slug: `s-${doc.id}`, name: 'Manager training', type: 'coaching' } });
    const version = await ctx.prisma.scenarioVersion.create({
      data: { scenarioId: scenario.id, workspaceId: wsA.id, version: 1, config: { knowledge: { documentIds: [doc.id] } }, configHash: 'x' },
    });
    await ctx.prisma.scenario.update({ where: { id: scenario.id }, data: { latestVersionId: version.id, latestVersionNumber: 1 } });

    const listed = await ctx.knowledge.list(wsA.id, {});
    const row = listed.data.find((r) => r.id === doc.id)!;
    expect(row.referencedBy).toEqual([expect.objectContaining({ scenarioId: scenario.id, name: 'Manager training', published: true, version: 1 })]);

    const asset = await ctx.prisma.mediaAsset.findFirst({ where: { workspaceId: wsA.id, metadata: { path: ['knowledgeDocumentId'], equals: doc.id } } });
    expect(await ctx.storage.driver.exists(asset.storageKey)).toBe(true);
    const del = await ctx.knowledge.remove(wsA.id, ctx.principal, doc.id);
    expect(del.referencedBy).toHaveLength(1);
    expect(await ctx.storage.driver.exists(asset.storageKey)).toBe(false);
    expect(await ctx.prisma.knowledgeChunk.count({ where: { documentId: doc.id } })).toBe(0);
    expect(await ctx.knowledge.search(wsA.id, [doc.id], 'quokka', 5)).toEqual([]);
    await expect(ctx.knowledge.get(wsA.id, doc.id)).rejects.toMatchObject({ status: 404 });
    // Ingest after delete is a no-op (job may still be queued).
    expect((await ctx.knowledge.ingest(wsA.id, doc.id)).status).toBe('SKIPPED');
  }, 60_000);

  it('extractText (runtime document_upload) returns text + page count and rejects binaries', async () => {
    const out = await ctx.knowledge.extractText(await buildPdf(['Page one text', 'Page two text']), 'application/pdf');
    expect(out.pageCount).toBe(2);
    expect(out.text).toContain('[Page 2]');
    await expect(ctx.knowledge.extractText(Buffer.from([0, 1, 2, 3]), 'text/plain')).rejects.toMatchObject({ status: 422 });
  }, 60_000);

  it('paginates the chunk preview', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} describes the llama grooming procedure in detail.`).join('\n\n');
    const md = await ctx.knowledge.createFromText(wsA.id, ctx.principal, { title: 'Llamas', text: long });
    await ctx.knowledge.ingest(wsA.id, md.id);
    const p1 = await ctx.knowledge.chunks(wsA.id, md.id, { offset: 0, limit: 2 });
    expect(p1.data).toHaveLength(2);
    expect(p1.total).toBeGreaterThan(2);
    expect(p1.nextOffset).toBe(2);
    expect(p1.data[0]!.ordinal).toBe(0);
  }, 60_000);
});
