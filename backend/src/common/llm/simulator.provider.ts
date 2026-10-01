import type { ChatRequest, JsonRequest, LlmContentBlock, LlmProvider, LlmStreamEvent } from './llm.types';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

/**
 * LOCAL DEVELOPMENT SIMULATOR — not a language model.
 * Streams the feature-supplied deterministic response so the product can be exercised without
 * provider credentials. Every record produced through it is flagged `simulated` and labeled in the UI.
 */
export class SimulatorProvider implements LlmProvider {
  readonly id = 'simulator' as const;
  readonly simulated = true;

  async *streamChat(model: string, req: ChatRequest): AsyncGenerator<LlmStreamEvent> {
    const out = req.simulate?.() ?? { text: 'This is the local simulator. Configure an AI provider to have a real conversation.' };
    const words = out.text.split(/(\s+)/);
    for (const w of words) {
      if (!w) continue;
      await sleep(12, req.signal);
      yield { type: 'text', text: w };
    }
    const content: LlmContentBlock[] = out.text ? [{ type: 'text', text: out.text }] : [];
    for (const [i, c] of (out.toolCalls ?? []).entries()) {
      const id = `sim_${Date.now().toString(36)}_${i}`;
      content.push({ type: 'tool_use', id, name: c.name, input: c.input });
      yield { type: 'tool_call', id, name: c.name, input: c.input };
    }
    yield {
      type: 'done',
      stopReason: out.toolCalls?.length ? 'tool_use' : 'end_turn',
      content,
      usage: { provider: 'simulator', model, inputTokens: 0, outputTokens: 0 },
    };
  }

  async completeJson(model: string, req: JsonRequest) {
    if (!req.simulate) throw new Error('No simulator behavior defined for this request');
    return { json: req.simulate(), usage: { provider: 'simulator' as const, model, inputTokens: 0, outputTokens: 0 } };
  }
}
