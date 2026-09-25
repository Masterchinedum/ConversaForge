/**
 * Voice adapter selection: ClientRuntimeConfig (voiceMode / stt / tts) + browser capabilities.
 */

import type { ClientRuntimeConfig } from '@cf/shared';
import { BrowserSpeechAdapter, getSpeechRecognitionCtor } from './browser-speech';
import { hasWebRtc, OpenAIRealtimeAdapter } from './openai-realtime';
import { ServerPipelineAdapter } from './server-pipeline';
import { BrowserSpeaker, ServerSpeaker, type AgentSpeaker } from './speaker';
import { hasSpeechSynthesis } from './synth';
import { TypedAdapter } from './typed';
import type { VoiceClient, VoiceClientOptions, VoiceMode } from './types';

export * from './types';

export interface BrowserCapabilities {
  secureContext: boolean;
  getUserMedia: boolean;
  speechRecognition: boolean;
  speechSynthesis: boolean;
  mediaRecorder: boolean;
  webrtc: boolean;
  audioContext: boolean;
}

export function detectCapabilities(): BrowserCapabilities {
  if (typeof window === 'undefined') {
    return {
      secureContext: false,
      getUserMedia: false,
      speechRecognition: false,
      speechSynthesis: false,
      mediaRecorder: false,
      webrtc: false,
      audioContext: false,
    };
  }
  return {
    secureContext: window.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    speechRecognition: !!getSpeechRecognitionCtor(),
    speechSynthesis: hasSpeechSynthesis(),
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    webrtc: hasWebRtc(),
    audioContext: typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined',
  };
}

export interface VoicePlan {
  mode: VoiceMode;
  /** How agent speech is produced. */
  output: 'browser' | 'server' | 'realtime' | 'none';
  /** Why we did not use the configured mode (shown as a notice). */
  reason?: string;
}

/**
 * Decide the adapter. `unavailable` holds modes that failed at runtime (e.g. 503 from the server,
 * speech service errors) so a re-plan falls back further.
 */
export function planVoice(
  config: ClientRuntimeConfig,
  caps: BrowserCapabilities,
  opts: { hasMic: boolean; unavailable?: Set<string>; preferTyped?: boolean },
): VoicePlan {
  const un = opts.unavailable ?? new Set<string>();
  const serverTtsWanted = config.tts === 'openai' || config.tts === 'elevenlabs';
  const output = (): VoicePlan['output'] => {
    if (config.tts === 'none') return 'none';
    if (serverTtsWanted && caps.audioContext && !un.has('server_tts')) return 'server';
    if (caps.speechSynthesis && !un.has('browser_tts')) return 'browser';
    return 'none';
  };
  const reasons: string[] = [];
  if (opts.preferTyped) return { mode: 'typed', output: output(), reason: 'You chose to type.' };
  if (!opts.hasMic) reasons.push('No microphone is available, so you can type your answers.');

  if (opts.hasMic && config.voiceMode === 'realtime') {
    if (caps.webrtc && !un.has('realtime')) return { mode: 'realtime', output: 'realtime' };
    reasons.push(un.has('realtime') ? 'Realtime voice is unavailable right now.' : 'This browser does not support WebRTC.');
  }
  if (opts.hasMic && (config.stt === 'openai' || config.stt === 'deepgram')) {
    if (caps.audioContext && !un.has('server_stt')) return { mode: 'server', output: output(), reason: reasons[0] };
    reasons.push('Server speech recognition is unavailable right now.');
  }
  if (opts.hasMic && config.stt !== 'typed') {
    if (caps.speechRecognition && !un.has('browser_stt')) {
      return { mode: 'browser', output: output(), reason: reasons[0] };
    }
    reasons.push(
      un.has('browser_stt')
        ? 'The browser speech service is not working, so you can type instead.'
        : 'This browser does not support speech recognition (try Chrome or Edge), so you can type instead.',
    );
  }
  return { mode: 'typed', output: output(), reason: config.stt === 'typed' ? undefined : reasons[0] };
}

export function createSpeaker(plan: VoicePlan, config: ClientRuntimeConfig, o: VoiceClientOptions): AgentSpeaker | null {
  if (plan.output === 'server' && o.audioContext) return new ServerSpeaker(o.audioContext, o.recordingSink, o.sessionId, o.token);
  if (plan.output === 'browser') return new BrowserSpeaker(config.language, config.voice.voiceId, config.voice.speed);
  return null;
}

export function createVoiceClient(
  plan: VoicePlan,
  config: ClientRuntimeConfig,
  o: VoiceClientOptions,
  extra: { agentSpeaksFirst: boolean },
): VoiceClient {
  switch (plan.mode) {
    case 'realtime':
      return new OpenAIRealtimeAdapter(o, extra);
    case 'server':
      return new ServerPipelineAdapter(o, createSpeaker(plan, config, o));
    case 'browser':
      return new BrowserSpeechAdapter(o, createSpeaker(plan, config, o));
    default:
      return new TypedAdapter(createSpeaker(plan, config, o));
  }
}

/** Which capability to mark unavailable when an adapter reports a fallback error. */
export function unavailableKeyFor(mode: VoiceMode, code: string): string[] {
  if (code === 'tts_failed') return ['server_tts'];
  if (mode === 'realtime') return ['realtime'];
  if (mode === 'server') return code === 'provider_unavailable' ? ['server_stt', 'server_tts'] : ['server_stt'];
  if (mode === 'browser') return ['browser_stt'];
  return [];
}
