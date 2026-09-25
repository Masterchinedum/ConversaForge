import type { LlmProviderId } from '@cf/shared';

export type LlmPurpose = 'live' | 'analysis' | 'assistant' | 'memory';

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmContentBlock[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema object. */
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  provider: LlmProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface ChatRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Deterministic stand-in used ONLY by the local development simulator (no model configured).
   * Features supply their own rule-based behavior so the flow can be exercised end-to-end.
   */
  simulate?: () => { text: string; toolCalls?: Array<{ name: string; input: Record<string, unknown> }> };
}

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; stopReason: string; usage: LlmUsage; content: LlmContentBlock[] };

export interface JsonRequest {
  system: string;
  messages: LlmMessage[];
  /** JSON Schema of the expected object (sent to providers that support structured output). */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Simulator stand-in (see ChatRequest.simulate). Results are flagged `simulated` wherever stored. */
  simulate?: () => unknown;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  readonly simulated: boolean;
  streamChat(model: string, req: ChatRequest): AsyncGenerator<LlmStreamEvent>;
  completeJson(model: string, req: JsonRequest): Promise<{ json: unknown; usage: LlmUsage }>;
}

export interface ResolvedLlm {
  provider: LlmProvider;
  model: string;
  simulated: boolean;
  /** Where the credential came from. */
  source: 'workspace' | 'environment' | 'simulator';
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
  }
}
