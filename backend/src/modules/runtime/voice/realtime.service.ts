import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { ActivityHandling, Behavior, EndSensitivity, Modality, type GoogleGenAI, type LiveConnectConfig } from '@google/genai';
import type { RealtimeProviderId, ScenarioConfig } from '@cf/shared';
import { env } from '../../../config/env';
import { Errors } from '../../../common/http/errors';
import { LlmService } from '../../../common/llm/llm.service';
import { geminiClient } from '../../../common/llm/google.provider';
import type { LlmToolSpec } from '../../../common/llm/llm.types';
import { UPDATE_PROGRESS_TOOL } from '../tools/tool-registry';

export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

/**
 * Gemini prebuilt voice names (`speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`). The SDK types
 * this as a free string; the list is Google's documented prebuilt voice set (not verifiable offline).
 * Unknown names are never sent — the model's default voice is used instead.
 */
export const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

/**
 * Added to the scenario's end-of-turn silence for Gemini. Its activity detection is purely silence-based
 * (OpenAI's semantic VAD hears that "so, um…" is unfinished), so thinking pauses need extra room.
 */
export const GEMINI_THINKING_PAD_MS = 800;

/** Ephemeral-token lifetimes for Gemini Live (single use; resuming a session does not consume a use). */
export const GEMINI_TOKEN = {
  /** Messages on a session opened with the token are rejected after this (the client reconnects with a fresh token). */
  expireSeconds: 30 * 60,
  /** The browser must open the Live session within this window. */
  newSessionSeconds: 2 * 60,
  uses: 1,
};

export interface OpenAIRealtimeCredentials {
  provider: 'openai';
  model: string;
  /** Ephemeral client secret (ek_…) — the browser uses it as the Bearer token for the SDP exchange. */
  clientSecret: string;
  expiresAt: number;
  /** POST the SDP offer here with `Authorization: Bearer <clientSecret>`, `Content-Type: application/sdp`. */
  callsUrl: string;
  voice: string;
}

/** What the browser needs to open a Gemini Live session. Never contains the real API key or the prompt. */
export interface GeminiLiveCredentials {
  provider: 'google';
  model: string;
  /** Ephemeral auth token name (`auth_tokens/…`), used by the browser SDK as `apiKey` with apiVersion v1alpha. */
  token: string;
  apiVersion: 'v1alpha';
  /** Epoch seconds after which the session is closed by Google. */
  expiresAt: number;
  /** Epoch seconds by which the browser must connect. */
  newSessionExpiresAt: number;
  voice: string | null;
  /**
   * Non-secret LiveConnectConfig the browser passes to `live.connect`. It mirrors values that are locked
   * server-side in the token (system instruction and tools are locked but not echoed to the browser).
   */
  connectConfig: {
    responseModalities: ['AUDIO'];
    inputAudioTranscription: { languageCodes?: string[] };
    outputAudioTranscription: Record<string, never>;
    sessionResumption: { handle?: string };
  };
  audio: { inputMimeType: 'audio/pcm;rate=16000'; inputSampleRate: 16000; outputSampleRate: 24000 };
  /** True when the token resumes a previous Live session (`sessionResumption.handle`). */
  resumed: boolean;
}

export type RealtimeCredentials = OpenAIRealtimeCredentials | GeminiLiveCredentials;

export interface MintInput {
  workspaceId: string;
  provider: RealtimeProviderId;
  model: string;
  instructions: string;
  tools: LlmToolSpec[];
  config: ScenarioConfig;
  /** Gemini Live session-resumption handle from the previous connection (reconnect / goAway). */
  resumeHandle?: string;
}

/**
 * Server-side minting of short-lived live-model credentials. The real API key never leaves the server and
 * the session configuration (compiled instructions, tools, voice, transcription, turn-taking) is bound to
 * the credential server-side so the browser cannot change it.
 *
 * OpenAI Realtime (GA):
 *   POST /v1/realtime/client_secrets { expires_after, session: { type: 'realtime', model, instructions, audio, tools } }
 *   → { value, expires_at, session }; the browser POSTs its SDP offer to /v1/realtime/calls.
 *
 * Google Gemini Live (Gemini Developer API, @google/genai `ai.authTokens.create`, v1alpha):
 *   { uses: 1, expireTime, newSessionExpireTime, liveConnectConstraints: { model, config } } with no
 *   `lockAdditionalFields` → the SDK sends `bidiGenerateContentSetup` without a field mask, which locks the
 *   whole setup to the token's values (the browser's setup message is ignored). The browser connects with
 *   `new GoogleGenAI({ apiKey: token.name, apiVersion: 'v1alpha' }).live.connect(...)`, which the SDK routes
 *   to `BidiGenerateContentConstrained?access_token=…`.
 */
@Injectable()
export class RealtimeService {
  /** Test seam: build the Google client (the default uses GEMINI_BASE_URL / the public endpoint). */
  googleClientFactory: (apiKey: string) => GoogleGenAI = (apiKey) => geminiClient(apiKey, 'v1alpha');

  constructor(private readonly llm: LlmService) {}

  async mint(input: MintInput): Promise<RealtimeCredentials> {
    return input.provider === 'google' ? this.mintGoogle(input) : this.mintOpenAI(input);
  }

  private async mintOpenAI(input: MintInput): Promise<OpenAIRealtimeCredentials> {
    const secret = await this.llm.providerSecret(input.workspaceId, 'openai', 'REALTIME');
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

  private async mintGoogle(input: MintInput): Promise<GeminiLiveCredentials> {
    const secret = await this.llm.providerSecret(input.workspaceId, 'google', 'REALTIME');
    if (!secret) {
      throw Errors.unavailable('Google Gemini Live is not configured. Set GEMINI_API_KEY (or add a workspace Google connection).', { missing: 'GEMINI_API_KEY' });
    }
    const model = input.model || env.GEMINI_LIVE_MODEL;
    const liveConfig = geminiLiveConfig(input.config, input.instructions, input.tools, {
      voice: typeof secret.config.voice === 'string' ? secret.config.voice : undefined,
      model,
      resumeHandle: input.resumeHandle,
    });
    const now = Date.now();
    const expireTime = new Date(now + GEMINI_TOKEN.expireSeconds * 1000);
    const newSessionExpireTime = new Date(now + GEMINI_TOKEN.newSessionSeconds * 1000);
    const ai = this.googleClientFactory(secret.secret);
    const token = await ai.authTokens.create({
      config: {
        uses: GEMINI_TOKEN.uses,
        expireTime: expireTime.toISOString(),
        newSessionExpireTime: newSessionExpireTime.toISOString(),
        // No lockAdditionalFields: the whole setup below is locked into the token.
        liveConnectConstraints: { model, config: liveConfig },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });
    if (!token?.name) throw Errors.unavailable('Google Gemini Live did not return a session token.', { provider: 'google' });
    return {
      provider: 'google',
      model,
      token: token.name,
      apiVersion: 'v1alpha',
      expiresAt: Math.floor(expireTime.getTime() / 1000),
      newSessionExpiresAt: Math.floor(newSessionExpireTime.getTime() / 1000),
      voice: liveConfig.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName ?? null,
      connectConfig: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: liveConfig.inputAudioTranscription ?? {},
        outputAudioTranscription: {},
        sessionResumption: input.resumeHandle ? { handle: input.resumeHandle } : {},
      },
      audio: { inputMimeType: 'audio/pcm;rate=16000', inputSampleRate: 16000, outputSampleRate: 24000 },
      resumed: !!input.resumeHandle,
    };
  }
}

/** Case-insensitive match against the documented Gemini prebuilt voices. */
export function geminiVoice(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    const v = GEMINI_VOICES.find((g) => g.toLowerCase() === String(c ?? '').trim().toLowerCase());
    if (v) return v;
  }
  return undefined;
}

/**
 * The LiveConnectConfig locked into a Gemini ephemeral token: audio responses, the compiled instructions,
 * the same function tools the OpenAI path exposes (as `functionDeclarations` with JSON-schema parameters),
 * input/output transcription, VAD tuned for thinking pauses, barge-in policy, session resumption and
 * context-window compression (audio sessions are otherwise capped at ~15 minutes).
 */
export function geminiLiveConfig(
  config: ScenarioConfig,
  instructions: string,
  tools: LlmToolSpec[],
  opts: { voice?: string; model: string; resumeHandle?: string },
): LiveConnectConfig {
  const tt = config.conversation.turnTaking;
  const voiceName = geminiVoice(config.persona.voice.voiceId, opts.voice);
  // Native-audio models choose the output language themselves; half-cascade models accept a language code.
  const nativeAudio = /native-audio/i.test(opts.model);
  const speechConfig = {
    ...(voiceName ? { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } : {}),
    ...(!nativeAudio && config.basics.language ? { languageCode: config.basics.language } : {}),
  };
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: instructions }] },
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.inputSchema,
                // Progress bookkeeping follows the spoken reply. As a blocking call the model waits for the
                // result and then generates again — re-asking the question it just asked, every turn. Non-
                // blocking + a SILENT response (sent by the browser) only adds it to the context.
                ...(t.name === UPDATE_PROGRESS_TOOL ? { behavior: Behavior.NON_BLOCKING } : {}),
              })),
            },
          ],
        }
      : {}),
    ...(Object.keys(speechConfig).length ? { speechConfig } : {}),
    // Without a hint the transcriber guesses the language per utterance, and accented English can come
    // back as Spanish or another language.
    inputAudioTranscription: config.basics.language ? { languageCodes: [config.basics.language] } : {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        // Start of speech: Google's default sensitivity. The browser streams the mic continuously with its
        // echo canceller on, as Google's reference clients do.
        // End of speech is detected less eagerly and after a longer silence, so thinking pauses are not cut off.
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        silenceDurationMs: Math.max(500, Math.min(3000, tt.endOfTurnSilenceMs + GEMINI_THINKING_PAD_MS)),
      },
      activityHandling: tt.allowBargeIn ? ActivityHandling.START_OF_ACTIVITY_INTERRUPTS : ActivityHandling.NO_INTERRUPTION,
    },
    sessionResumption: opts.resumeHandle ? { handle: opts.resumeHandle } : {},
    contextWindowCompression: { slidingWindow: {} },
  };
}
