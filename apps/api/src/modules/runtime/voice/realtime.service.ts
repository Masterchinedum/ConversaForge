import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { ScenarioConfig } from '@cf/shared';
import { env } from '../../../config/env';
import { Errors } from '../../../common/http/errors';
import { LlmService } from '../../../common/llm/llm.service';
import type { LlmToolSpec } from '../../../common/llm/llm.types';

export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

export interface RealtimeCredentials {
  provider: 'openai';
  model: string;
  /** Ephemeral client secret (ek_…) — the browser uses it as the Bearer token for the SDP exchange. */
  clientSecret: string;
  expiresAt: number;
  /** POST the SDP offer here with `Authorization: Bearer <clientSecret>`, `Content-Type: application/sdp`. */
  callsUrl: string;
  voice: string;
}

/**
 * OpenAI Realtime (GA API) — server-side minting of short-lived client secrets. The real API key never
 * leaves the server; the session is pre-configured with the compiled instructions and tool definitions.
 *   POST /v1/realtime/client_secrets { expires_after, session: { type: 'realtime', model, instructions, audio, tools } }
 *   → { value, expires_at, session }
 * The browser then connects over WebRTC by POSTing its SDP offer to /v1/realtime/calls.
 */
@Injectable()
export class RealtimeService {
  constructor(private readonly llm: LlmService) {}

  async mint(input: {
    workspaceId: string;
    model: string;
    instructions: string;
    tools: LlmToolSpec[];
    config: ScenarioConfig;
  }): Promise<RealtimeCredentials> {
    const secret = await this.llm.providerSecret(input.workspaceId, 'openai');
    if (!secret) {
      throw Errors.unavailable('OpenAI Realtime is not configured. Set OPENAI_API_KEY (or add a workspace OpenAI connection).', { missing: 'OPENAI_API_KEY' });
    }
    const client = new OpenAI({ apiKey: secret.secret, timeout: 20_000, maxRetries: 1 });
    const voice = REALTIME_VOICES.includes(input.config.persona.voice.voiceId) ? input.config.persona.voice.voiceId : 'marin';
    const tt = input.config.conversation.turnTaking;
    const res = await client.realtime.clientSecrets.create({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model: input.model || env.OPENAI_REALTIME_MODEL,
        instructions: input.instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe', language: input.config.basics.language.slice(0, 2).toLowerCase() },
            noise_reduction: { type: 'near_field' },
            // Semantic VAD with low eagerness lets participants pause to think without being cut off.
            turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: tt.allowBargeIn },
          },
          output: { voice, ...(input.config.persona.voice.speed !== 1 ? { speed: Math.min(1.5, Math.max(0.25, input.config.persona.voice.speed)) } : {}) },
        },
        tools: input.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.inputSchema })),
        tool_choice: 'auto',
      },
    });
    return {
      provider: 'openai',
      model: input.model || env.OPENAI_REALTIME_MODEL,
      clientSecret: res.value,
      expiresAt: res.expires_at,
      callsUrl: OPENAI_REALTIME_CALLS_URL,
      voice,
    };
  }
}
