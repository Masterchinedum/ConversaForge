import { createServer, type Server } from 'node:http';
import { GoogleProvider, mapFinishReason, toGeminiContents } from './google.provider';
import { LlmService } from './llm.service';
import type { LlmStreamEvent } from './llm.types';

/**
 * Google Gemini text provider against a local mock of the Gemini REST API (the real SDK talks to it via
 * GEMINI_BASE_URL). Verifies the wire request (system parts, function declarations, function responses,
 * structured output) and the mapping back to LlmStreamEvents (text, tool calls, usage, stop reasons).
 */

type Handler = (req: { url: string; body: any }) => { status?: number; sse?: unknown[]; json?: unknown };

describe('GoogleProvider (mock Gemini API)', () => {
  let server: Server;
  let handler: Handler;
  const requests: Array<{ url: string; key: string | undefined; body: any }> = [];
  const prevBase = process.env.GEMINI_BASE_URL;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data || '{}');
        requests.push({ url: req.url ?? '', key: req.headers['x-goog-api-key'] as string | undefined, body });
        const out = handler({ url: req.url ?? '', body });
        if (out.sse) {
          res.writeHead(out.status ?? 200, { 'content-type': 'text/event-stream' });
          for (const ev of out.sse) res.write(`data: ${JSON.stringify(ev)}\r\n\r\n`);
          res.end();
        } else {
          res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.json ?? {}));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => {
    server.close();
    if (prevBase === undefined) delete process.env.GEMINI_BASE_URL;
    else process.env.GEMINI_BASE_URL = prevBase;
  });
  beforeEach(() => (requests.length = 0));

  async function collect(gen: AsyncGenerator<LlmStreamEvent>) {
    const out: LlmStreamEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it('streams text + function calls, sends both system blocks and JSON-schema tools, reports usage', async () => {
    handler = () => ({
      sse: [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Thought…', thought: true }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Tell me ' }] } }] },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'more.', thoughtSignature: 'sig-1' }, { functionCall: { name: 'update_progress', args: { currentTopicId: 'intro' } } }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, thoughtsTokenCount: 4, cachedContentTokenCount: 20 },
        },
      ],
    });
    const p = new GoogleProvider('AIza-test-key-123');
    const events = await collect(
      p.streamChat('gemini-2.5-flash', {
        system: 'STABLE',
        systemDynamic: 'DYNAMIC',
        messages: [{ role: 'user', content: '<participant>Hi</participant>' }],
        tools: [{ name: 'update_progress', description: 'Track progress', inputSchema: { type: 'object', properties: { currentTopicId: { type: 'string' } } } }],
        maxTokens: 300,
        temperature: 0.5,
      }),
    );
    expect(requests[0]!.url).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(requests[0]!.key).toBe('AIza-test-key-123');
    const body = requests[0]!.body;
    expect(body.systemInstruction.parts).toEqual([{ text: 'STABLE' }, { text: 'DYNAMIC' }]);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '<participant>Hi</participant>' }] }]);
    expect(body.tools[0].functionDeclarations[0]).toEqual({
      name: 'update_progress',
      description: 'Track progress',
      parametersJsonSchema: { type: 'object', properties: { currentTopicId: { type: 'string' } } },
    });
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 300, temperature: 0.5 });

    expect(events.filter((e) => e.type === 'text').map((e: any) => e.text)).toEqual(['Tell me ', 'more.']); // thoughts not spoken
    const call = events.find((e) => e.type === 'tool_call') as any;
    expect(call).toMatchObject({ name: 'update_progress', input: { currentTopicId: 'intro' } });
    expect(call.id).toMatch(/^gfc_/); // Gemini returned no id → synthesized locally
    const done = events.at(-1) as Extract<LlmStreamEvent, { type: 'done' }>;
    expect(done.stopReason).toBe('tool_use');
    expect(done.usage).toEqual({ provider: 'google', model: 'gemini-2.5-flash', inputTokens: 120, outputTokens: 12, cacheReadTokens: 20 });
    expect(done.raw?.provider).toBe('google');
    expect(done.raw?.content).toEqual(expect.arrayContaining([{ text: 'more.', thoughtSignature: 'sig-1' }]));

    // Tool continuation: the model turn is replayed verbatim (thought signature kept) and the result is a
    // functionResponse named after the call (no id, since Gemini did not send one).
    handler = () => ({ sse: [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Great.' }] }, finishReason: 'STOP' }] }] });
    await collect(
      p.streamChat('gemini-2.5-flash', {
        system: 'STABLE',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: done.content, raw: done.raw },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'Progress recorded.' }] },
        ],
      }),
    );
    const cont = requests[1]!.body.contents;
    expect(cont[1]).toEqual({ role: 'model', parts: done.raw!.content });
    expect(cont[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'update_progress', response: { output: 'Progress recorded.' } } }] });
  });

  it('maps provider tool-call ids, errors and text-only history without raw content', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'call_9', name: 'knowledge_search', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_9', content: 'boom', isError: true }] },
    ]);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'Let me check.' }, { functionCall: { id: 'call_9', name: 'knowledge_search', args: { query: 'x' } } }],
    });
    expect(contents[2]!.parts![0]).toEqual({ functionResponse: { id: 'call_9', name: 'knowledge_search', response: { error: 'boom' } } });
  });

  it('maps finish reasons (max tokens, safety → refusal, blocked prompt)', async () => {
    expect(mapFinishReason('MAX_TOKENS', false, false)).toBe('max_tokens');
    expect(mapFinishReason('SAFETY', false, false)).toBe('refusal');
    expect(mapFinishReason('STOP', false, true)).toBe('refusal');
    expect(mapFinishReason('STOP', false, false)).toBe('end_turn');
    handler = () => ({ sse: [{ promptFeedback: { blockReason: 'SAFETY' } }] });
    const events = await collect(new GoogleProvider('k').streamChat('gemini-2.5-flash', { system: 's', messages: [{ role: 'user', content: 'x' }] }));
    expect((events.at(-1) as any).stopReason).toBe('refusal');
  });

  it('completeJson uses structured output (responseMimeType + responseJsonSchema) and parses the JSON', async () => {
    handler = () => ({
      json: {
        candidates: [{ content: { role: 'model', parts: [{ text: '{"score": 4, "evidence": ["a"]}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30 },
      },
    });
    const schema = { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] };
    const out = await new GoogleProvider('k').completeJson('gemini-2.5-pro', { system: 'Grade it.', messages: [{ role: 'user', content: 'transcript' }], jsonSchema: schema });
    expect(requests[0]!.url).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(requests[0]!.body.systemInstruction).toEqual({ parts: [{ text: 'Grade it.' }], role: 'user' });
    expect(requests[0]!.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: schema });
    expect(out.json).toEqual({ score: 4, evidence: ['a'] });
    expect(out.usage).toMatchObject({ provider: 'google', inputTokens: 900, outputTokens: 30 });
  });

  it('LlmService.resolve: google preferred first, and in the fallback order after anthropic/openai', async () => {
    const conns = [
      { id: 'c1', provider: 'google', encryptedSecret: 'enc:google', config: { liveModel: 'gemini-2.5-flash-lite' }, createdAt: new Date() },
      { id: 'c2', provider: 'openai', encryptedSecret: 'enc:openai', config: {}, createdAt: new Date() },
    ];
    const prisma: any = { providerConnection: { findMany: async ({ where }: any) => conns.filter((c) => where.provider.in.includes(c.provider)) } };
    const crypto: any = { decrypt: (s: string) => s.replace('enc:', 'key-') };
    const svc = new LlmService(prisma, crypto);
    const g = await svc.resolve('ws', 'live', 'google');
    expect(g.provider.id).toBe('google');
    expect(g.model).toBe('gemini-2.5-flash-lite'); // workspace connection's liveModel
    expect(g.source).toBe('workspace');
    expect((await svc.resolve('ws', 'analysis', 'google', 'gemini-3-pro-preview')).model).toBe('gemini-3-pro-preview');
    // No preference: anthropic (none) → openai → google.
    expect((await svc.resolve('ws', 'live')).provider.id).toBe('openai');
    conns.splice(1, 1);
    const only = await svc.resolve('ws', 'analysis', 'anthropic');
    expect(only.provider.id).toBe('google');
    expect(only.model).toBe(process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-pro');
  });
});
