import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, JsonRequest, LlmContentBlock, LlmMessage, LlmProvider, LlmStreamEvent } from './llm.types';

/** Effort is supported on the 4.6+ generation; Haiku 4.5 and older reject it. */
function supportsEffort(model: string) {
  return !/haiku|-4-5|-4-1|-4-0|-3-/.test(model);
}
/** Sampling params were removed on Opus 4.7+/Sonnet 5/Fable; keep them only for models that accept them. */
function supportsTemperature(model: string) {
  return /haiku|-4-6|-4-5/.test(model);
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b): Anthropic.ContentBlockParam => {
            if (b.type === 'text') return { type: 'text', text: b.text };
            if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
            return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
          }),
  }));
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly simulated = false;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly effort: { live: 'low' | 'medium' | 'high' } = { live: 'low' }) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async *streamChat(model: string, req: ChatRequest): AsyncGenerator<LlmStreamEvent> {
    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: req.maxTokens ?? 4096,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(req.messages),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      ...(supportsTemperature(model) && req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(supportsEffort(model) ? ({ output_config: { effort: this.effort.live } } as object) : {}),
    };
    const stream = this.client.messages.stream(params, { signal: req.signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const content: LlmContentBlock[] = [];
    for (const block of final.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      if (block.type === 'tool_use') {
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
        content.push({ type: 'tool_use', id: block.id, name: block.name, input });
        yield { type: 'tool_call', id: block.id, name: block.name, input };
      }
    }
    yield {
      type: 'done',
      stopReason: final.stop_reason ?? 'end_turn',
      content,
      usage: {
        provider: 'anthropic',
        model,
        inputTokens: final.usage.input_tokens + (final.usage.cache_creation_input_tokens ?? 0),
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      },
    };
  }

  async completeJson(model: string, req: JsonRequest) {
    const stream = this.client.messages.stream(
      {
        model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        ...(supportsEffort(model) ? { output_config: { effort: 'high', format: { type: 'json_schema', schema: req.jsonSchema } } } : {}),
      } as Anthropic.MessageStreamParams,
      { signal: req.signal },
    );
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('The model declined to produce this analysis');
    const text = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      json: parseJsonLoose(text),
      usage: {
        provider: 'anthropic' as const,
        model,
        inputTokens: final.usage.input_tokens + (final.usage.cache_creation_input_tokens ?? 0),
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}

/** Parse JSON, tolerating a fenced code block (older models without structured output). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ?? trimmed.match(/(\{[\s\S]*\})/);
    if (m) return JSON.parse(m[1]!);
    throw new Error('Model did not return valid JSON');
  }
}
