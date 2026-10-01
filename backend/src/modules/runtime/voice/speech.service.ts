import { Injectable, Logger } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { env } from '../../../config/env';
import { Errors } from '../../../common/http/errors';
import { LlmService } from '../../../common/llm/llm.service';

/**
 * Server-side speech adapters (used by the phone bridge and by browsers that prefer server voices).
 * Credentials come from workspace provider connections first, then server env.
 */
export interface TtsResult {
  audio: Buffer;
  mimeType: string;
  characters: number;
  provider: 'openai' | 'elevenlabs';
  model: string;
}
export interface TtsProvider {
  readonly id: 'openai' | 'elevenlabs';
  synthesize(text: string, opts: { voice?: string; speed?: number; instructions?: string; format?: 'mp3' | 'pcm' | 'ulaw' }): Promise<TtsResult>;
}
export interface SttResult {
  text: string;
  confidence: number | null;
  /** Audio duration in seconds (reported by the provider or estimated). */
  durationSec: number;
  durationEstimated: boolean;
  provider: 'openai' | 'deepgram';
  model: string;
}
export interface SttProvider {
  readonly id: 'openai' | 'deepgram';
  transcribe(audio: Buffer, mimeType: string, opts: { language?: string }): Promise<SttResult>;
}

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const FETCH_TIMEOUT_MS = 30_000;

/** Rough duration estimate for compressed speech audio when a provider does not report it. */
function estimateSeconds(bytes: number, mimeType: string) {
  const bytesPerSec = /wav|pcm|l16/.test(mimeType) ? 32_000 : /mulaw|ulaw|basic/.test(mimeType) ? 8000 : 4000;
  return Math.max(1, Math.round(bytes / bytesPerSec));
}

export class OpenAITts implements TtsProvider {
  readonly id = 'openai' as const;
  constructor(private readonly apiKey: string) {}
  async synthesize(text: string, opts: { voice?: string; speed?: number; instructions?: string; format?: 'mp3' | 'pcm' | 'ulaw' }): Promise<TtsResult> {
    const client = new OpenAI({ apiKey: this.apiKey, timeout: FETCH_TIMEOUT_MS, maxRetries: 1 });
    const model = env.OPENAI_TTS_MODEL;
    const voice = opts.voice && OPENAI_VOICES.includes(opts.voice) ? opts.voice : 'alloy';
    const format = opts.format === 'pcm' ? 'pcm' : 'mp3';
    const res = await client.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: format,
      ...(opts.instructions && /gpt-4o/.test(model) ? { instructions: opts.instructions.slice(0, 500) } : {}),
      ...(opts.speed && opts.speed !== 1 ? { speed: Math.min(4, Math.max(0.25, opts.speed)) } : {}),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, mimeType: format === 'pcm' ? 'audio/pcm' : 'audio/mpeg', characters: text.length, provider: 'openai', model };
  }
}

export class ElevenLabsTts implements TtsProvider {
  readonly id = 'elevenlabs' as const;
  constructor(private readonly apiKey: string) {}
  async synthesize(text: string, opts: { voice?: string; speed?: number; format?: 'mp3' | 'pcm' | 'ulaw' }): Promise<TtsResult> {
    const voiceId = opts.voice && /^[a-zA-Z0-9]{10,40}$/.test(opts.voice) ? opts.voice : DEFAULT_ELEVENLABS_VOICE;
    const model = 'eleven_flash_v2_5';
    const outputFormat = opts.format === 'ulaw' ? 'ulaw_8000' : opts.format === 'pcm' ? 'pcm_16000' : 'mp3_44100_128';
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'audio/*' },
      body: JSON.stringify({
        text,
        model_id: model,
        ...(opts.speed && opts.speed !== 1 ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, opts.speed)) } } : {}),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status})`);
    const audio = Buffer.from(await res.arrayBuffer());
    const mimeType = opts.format === 'ulaw' ? 'audio/basic' : opts.format === 'pcm' ? 'audio/pcm' : 'audio/mpeg';
    return { audio, mimeType, characters: text.length, provider: 'elevenlabs', model };
  }
}

export class OpenAIStt implements SttProvider {
  readonly id = 'openai' as const;
  constructor(private readonly apiKey: string) {}
  async transcribe(audio: Buffer, mimeType: string, opts: { language?: string }): Promise<SttResult> {
    const client = new OpenAI({ apiKey: this.apiKey, timeout: FETCH_TIMEOUT_MS, maxRetries: 1 });
    const model = env.OPENAI_STT_MODEL;
    const ext = /webm/.test(mimeType) ? 'webm' : /ogg/.test(mimeType) ? 'ogg' : /mp4|m4a|aac/.test(mimeType) ? 'mp4' : /wav/.test(mimeType) ? 'wav' : /mpeg|mp3/.test(mimeType) ? 'mp3' : 'webm';
    const file = await toFile(audio, `audio.${ext}`, { type: mimeType });
    const res = await client.audio.transcriptions.create({
      file,
      model,
      ...(opts.language ? { language: opts.language.slice(0, 2).toLowerCase() } : {}),
    });
    const usage = (res as any).usage;
    const reported = usage?.type === 'duration' && typeof usage.seconds === 'number' ? usage.seconds : null;
    return {
      text: String(res.text ?? '').trim(),
      confidence: null,
      durationSec: reported ?? estimateSeconds(audio.length, mimeType),
      durationEstimated: reported === null,
      provider: 'openai',
      model,
    };
  }
}

export class DeepgramStt implements SttProvider {
  readonly id = 'deepgram' as const;
  constructor(private readonly apiKey: string) {}
  async transcribe(audio: Buffer, mimeType: string, opts: { language?: string }): Promise<SttResult> {
    const model = 'nova-3';
    const qs = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true' });
    if (opts.language) qs.set('language', opts.language);
    const res = await fetch(`https://api.deepgram.com/v1/listen?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': mimeType || 'application/octet-stream' },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Deepgram STT failed (${res.status})`);
    const json = (await res.json()) as any;
    const alt = json?.results?.channels?.[0]?.alternatives?.[0];
    const duration = typeof json?.metadata?.duration === 'number' ? json.metadata.duration : null;
    return {
      text: String(alt?.transcript ?? '').trim(),
      confidence: typeof alt?.confidence === 'number' ? alt.confidence : null,
      durationSec: duration ?? estimateSeconds(audio.length, mimeType),
      durationEstimated: duration === null,
      provider: 'deepgram',
      model,
    };
  }
}

@Injectable()
export class SpeechService {
  private readonly logger = new Logger('Speech');
  constructor(private readonly llm: LlmService) {}

  /** Pick a server TTS provider: the preferred one if configured, else any configured one. Throws 503 naming the credential. */
  async tts(workspaceId: string, preferred?: string | null): Promise<TtsProvider> {
    const order = preferred === 'elevenlabs' ? ['elevenlabs', 'openai'] : ['openai', 'elevenlabs'];
    for (const p of order) {
      const s = await this.llm.providerSecret(workspaceId, p);
      if (!s) continue;
      return p === 'openai' ? new OpenAITts(s.secret) : new ElevenLabsTts(s.secret);
    }
    throw Errors.unavailable('Server text-to-speech is not configured. Set OPENAI_API_KEY or ELEVENLABS_API_KEY (or add a workspace provider connection).', {
      missing: ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY'],
    });
  }

  async stt(workspaceId: string, preferred?: string | null): Promise<SttProvider> {
    const order = preferred === 'deepgram' ? ['deepgram', 'openai'] : ['openai', 'deepgram'];
    for (const p of order) {
      const s = await this.llm.providerSecret(workspaceId, p);
      if (!s) continue;
      return p === 'openai' ? new OpenAIStt(s.secret) : new DeepgramStt(s.secret);
    }
    throw Errors.unavailable('Server speech-to-text is not configured. Set OPENAI_API_KEY or DEEPGRAM_API_KEY (or add a workspace provider connection).', {
      missing: ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY'],
    });
  }
}
