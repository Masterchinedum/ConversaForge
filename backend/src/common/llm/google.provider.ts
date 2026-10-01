import { GoogleGenAI, type Content, type FunctionCall, type GenerateContentResponse, type Part } from '@google/genai';
import { env } from '../../config/env';
import { parseJsonLoose } from './anthropic.provider';
import type { ChatRequest, JsonRequest, LlmContentBlock, LlmMessage, LlmProvider, LlmStreamEvent, LlmUsage } from './llm.types';

/**
 * Google Gemini (Gemini Developer API) via the official `@google/genai` SDK (Apache-2.0).
 *
 * Verified against the SDK's TypeScript declarations (`@google/genai@2.24.0`, dist/genai.d.ts):
 *   - `ai.models.generateContentStream({ model, contents, config })` → AsyncGenerator<GenerateContentResponse>
 *   - config: `systemInstruction` (ContentUnion), `tools: [{ functionDeclarations: [{ name, description,
 *     parametersJsonSchema }] }]`, `maxOutputTokens`, `temperature`, `abortSignal`,
 *     `responseMimeType: 'application/json'` + `responseJsonSchema` (structured output)
 *   - response: `candidates[0].content.parts[]` (`text`, `thought`, `thoughtSignature`, `functionCall {id?, name,
 *     args}`), `candidates[0].finishReason` (STOP | MAX_TOKENS | SAFETY | …), `promptFeedback.blockReason`,
 *     `usageMetadata { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount }`
 *   - function results go back as a `user` content with `functionResponse { id?, name, response: { output | error } }`
 *     parts (same shape the SDK's own automatic function calling builds).
 * Model turns are replayed verbatim (`raw`) within a tool round so Gemini 3 thought signatures survive.
 */

export function geminiClient(apiKey: string, apiVersion?: string): GoogleGenAI {
  const baseUrl = env.GEMINI_BASE_URL || process.env.GEMINI_BASE_URL || undefined;
  return new GoogleGenAI({
    vertexai: false, // never pick up GOOGLE_GENAI_USE_VERTEXAI from the environment
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: { ...(baseUrl ? { baseUrl } : {}), ...(apiVersion ? { apiVersion } : {}), timeout: 180_000 },
  });
}

/** Ids we synthesize when Gemini returns a function call without an id (not sent back to Gemini). */
const SYNTH_PREFIX = 'gfc_';

function toolUseNames(messages: LlmMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  }
  return names;
}

export function toGeminiContents(messages: LlmMessage[]): Content[] {
  const names = toolUseNames(messages);
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.raw?.provider === 'google' && Array.isArray(m.raw.content) && m.raw.content.length) {
      out.push({ role: 'model', parts: m.raw.content as Part[] });
      continue;
    }
    if (typeof m.content === 'string') {
      if (m.content) out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      continue;
    }
    const parts: Part[] = [];
    for (const b of m.content) {
      if (b.type === 'text') {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === 'tool_use') {
        parts.push({ functionCall: { ...(b.id.startsWith(SYNTH_PREFIX) ? {} : { id: b.id }), name: b.name, args: b.input } });
      } else {
        const name = names.get(b.toolUseId) ?? 'tool';
        parts.push({
          functionResponse: {
            ...(b.toolUseId.startsWith(SYNTH_PREFIX) ? {} : { id: b.toolUseId }),
            name,
            response: b.isError ? { error: b.content } : { output: b.content },
          },
        });
      }
    }
    if (parts.length) out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

function usageOf(model: string, u: GenerateContentResponse['usageMetadata'] | undefined): LlmUsage {
  return {
    provider: 'google',
    model,
    inputTokens: (u?.promptTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0),
    // Thinking tokens are billed as output tokens.
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cacheReadTokens: u?.cachedContentTokenCount ?? 0,
  };
}

const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);

export function mapFinishReason(reason: string | undefined, hasCalls: boolean, blocked: boolean): string {
  if (blocked || (reason && REFUSAL_REASONS.has(reason))) return 'refusal';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (hasCalls) return 'tool_use';
  return 'end_turn';
}

export class GoogleProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly simulated = false;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string, client?: GoogleGenAI) {
    this.client = client ?? geminiClient(apiKey);
  }

  async *streamChat(model: string, req: ChatRequest): AsyncGenerator<LlmStreamEvent> {
    const systemParts: Part[] = [{ text: req.system }];
    // The per-request dynamic block is a second system part (Gemini has no cache breakpoints to protect).
    if (req.systemDynamic) systemParts.push({ text: req.systemDynamic });
    const stream = await this.client.models.generateContentStream({
      model,
      contents: toGeminiContents(req.messages),
      config: {
        systemInstruction: { parts: systemParts },
        maxOutputTokens: req.maxTokens ?? 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.tools?.length
          ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }] }
          : {}),
        ...(req.signal ? { abortSignal: req.signal } : {}),
      },
    });
    const rawParts: Part[] = [];
    let text = '';
    const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let finish: string | undefined;
    let blocked = false;
    let usage: GenerateContentResponse['usageMetadata'];
    let n = 0;
    for await (const chunk of stream) {
      if (req.signal?.aborted) break;
      if (chunk.promptFeedback?.blockReason) blocked = true;
      const cand = chunk.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        rawParts.push(part);
        if (part.thought) continue; // thought summaries are never spoken
        if (typeof part.text === 'string' && part.text) {
          text += part.text;
          yield { type: 'text', text: part.text };
        }
        if (part.functionCall) calls.push(this.call(part.functionCall, n++));
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
    const content: LlmContentBlock[] = text ? [{ type: 'text', text }] : [];
    for (const c of calls) {
      content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      yield { type: 'tool_call', id: c.id, name: c.name, input: c.input };
    }
    yield {
      type: 'done',
      stopReason: mapFinishReason(finish, calls.length > 0, blocked),
      content,
      raw: { provider: 'google', content: rawParts },
      usage: usageOf(model, usage),
    };
  }

  private call(fc: FunctionCall, n: number) {
    const input = fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args) ? (fc.args as Record<string, unknown>) : {};
    return { id: fc.id || `${SYNTH_PREFIX}${Date.now().toString(36)}_${n}`, name: fc.name ?? '', input };
  }

  async completeJson(model: string, req: JsonRequest) {
    const res = await this.client.models.generateContent({
      model,
      contents: toGeminiContents(req.messages),
      config: {
        systemInstruction: req.system,
        maxOutputTokens: req.maxTokens ?? 16000,
        responseMimeType: 'application/json',
        responseJsonSchema: req.jsonSchema,
        ...(req.signal ? { abortSignal: req.signal } : {}),
      },
    });
    const cand = res.candidates?.[0];
    if (res.promptFeedback?.blockReason || (cand?.finishReason && REFUSAL_REASONS.has(cand.finishReason))) {
      throw new Error('The model declined to produce this analysis');
    }
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    return { json: parseJsonLoose(text), usage: usageOf(model, res.usageMetadata) };
  }
}
