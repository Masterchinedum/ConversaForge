import OpenAI from 'openai';
import type { ChatRequest, JsonRequest, LlmContentBlock, LlmMessage, LlmProvider, LlmStreamEvent } from './llm.types';
import { parseJsonLoose } from './anthropic.provider';

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAIMessages(system: string, messages: LlmMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content } as OAIMessage);
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use') as Extract<LlmContentBlock, { type: 'tool_use' }>[];
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        else if (b.type === 'text') out.push({ role: 'user', content: b.text });
      }
    }
  }
  return out;
}

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly simulated = false;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async *streamChat(model: string, req: ChatRequest): AsyncGenerator<LlmStreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
          : {}),
      },
      { signal: req.signal },
    );
    let text = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish = 'stop';
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        yield { type: 'text', text: choice.delta.content };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
    }
    const content: LlmContentBlock[] = text ? [{ type: 'text', text }] : [];
    for (const c of calls.values()) {
      let input: Record<string, unknown> = {};
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = { __invalid_json: c.args };
      }
      content.push({ type: 'tool_use', id: c.id, name: c.name, input });
      yield { type: 'tool_call', id: c.id, name: c.name, input };
    }
    yield {
      type: 'done',
      stopReason: finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn',
      content,
      usage: { provider: 'openai', model, ...usage },
    };
  }

  async completeJson(model: string, req: JsonRequest) {
    const res = await this.client.chat.completions.create(
      {
        model,
        max_completion_tokens: req.maxTokens ?? 16000,
        messages: toOpenAIMessages(req.system, req.messages),
        response_format: { type: 'json_schema', json_schema: { name: 'result', schema: req.jsonSchema, strict: false } },
      },
      { signal: req.signal },
    );
    return {
      json: parseJsonLoose(res.choices[0]?.message?.content ?? ''),
      usage: {
        provider: 'openai' as const,
        model,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
    };
  }
}
