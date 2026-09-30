/**
 * Voice adapter selection: ClientRuntimeConfig (voiceMode / stt / tts) + browser capabilities.
 */

import type { ClientRuntimeConfig, RealtimeProviderId } from '@cf/shared';
import { BrowserSpeechAdapter, getSpeechRecognitionCtor } from './browser-speech';
import { GeminiLiveAdapter } from './gemini-live';
import { hasWebRtc, OpenAIRealtimeAdapter } from './openai-realtime';
import { ServerPipelineAdapter } from './server-pipeline';
import { BrowserSpeaker, ServerSpeaker, type AgentSpeaker } from './speaker';
import { hasSpeechSynthesis } from './synth';
import { TypedAdapter } from './typed';
import { VOICE_MODE_LABELS, type VoiceClient, type VoiceClientOptions, type VoiceMode } from './types';

export * from './types';
export { isOwnTestSession, liveAudioMode, markOwnTestSession, setLiveAudioMode, type LiveAudioMode } from './audio-mode';

export interface BrowserCapabilities {
  secureContext: boolean;
  getUserMedia: boolean;
  speechRecognition: boolean;
  speechSynthesis: boolean;
  mediaRecorder: boolean;
  webrtc: boolean;
  audioContext: boolean;
  /** WebSocket (Gemini Live); treated as available when omitted. */
  websocket?: boolean;
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
    websocket: typeof WebSocket !== 'undefined',
    audioContext: typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined',
  };
}

export interface VoicePlan {
  mode: VoiceMode;
  /** How agent speech is produced. */
  output: 'browser' | 'server' | 'realtime' | 'none';
  /** Live provider for mode 'realtime' (the session's primary, or its backup after a failure). */
  realtimeProvider?: RealtimeProviderId;
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
    // Live providers in order: the session's primary (Gemini Live by default), then its backup (OpenAI).
    const primary = config.realtime?.provider ?? 'openai';
    const candidates = [primary, ...(config.realtime?.backup ? [config.realtime.backup.provider] : [])];
    const supports = (p: RealtimeProviderId) => (p === 'google' ? caps.audioContext && caps.websocket !== false : caps.webrtc);
    const usable = candidates.find((p) => supports(p) && !un.has(`realtime:${p}`) && !un.has('realtime'));
    if (usable) {
      return {
        mode: 'realtime',
        output: 'realtime',
        realtimeProvider: usable,
        ...(usable !== primary && !un.has(`realtime:${primary}`) ? { reason: `${voiceLabel('realtime', null, primary)} is not supported in this browser.` } : {}),
      };
    }
    const failed = candidates.some((p) => un.has(`realtime:${p}`)) || un.has('realtime');
    reasons.push(
      failed
        ? 'Live voice is unavailable right now.'
        : primary === 'google'
          ? 'This browser cannot play live audio (WebAudio/WebSocket missing).'
          : 'This browser does not support WebRTC.',
    );
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
      return (plan.realtimeProvider ?? config.realtime?.provider) === 'google' ? new GeminiLiveAdapter(o) : new OpenAIRealtimeAdapter(o, extra);
    case 'server':
      return new ServerPipelineAdapter(o, createSpeaker(plan, config, o));
    case 'browser':
      return new BrowserSpeechAdapter(o, createSpeaker(plan, config, o));
    default:
      return new TypedAdapter(createSpeaker(plan, config, o));
  }
}

/**
 * Which capability to mark unavailable when an adapter reports a fallback error. A failed live provider is
 * marked on its own, so the re-plan tries the backup live provider before browser/server speech.
 */
export function unavailableKeyFor(mode: VoiceMode, code: string, realtimeProvider?: RealtimeProviderId): string[] {
  if (code === 'tts_failed') return ['server_tts'];
  if (mode === 'realtime') return [realtimeProvider ? `realtime:${realtimeProvider}` : 'realtime'];
  if (mode === 'server') return code === 'provider_unavailable' ? ['server_stt', 'server_tts'] : ['server_stt'];
  if (mode === 'browser') return ['browser_stt'];
  return [];
}

/** "Voice:" label for a mode; live voice names the provider actually used. */
export function voiceLabel(
  mode: VoiceMode,
  config?: Pick<ClientRuntimeConfig, 'realtime'> | null,
  provider: RealtimeProviderId | undefined = config?.realtime?.provider,
): string {
  if (mode === 'realtime') return provider === 'google' ? 'Google Gemini Live' : 'OpenAI Realtime';
  return VOICE_MODE_LABELS[mode];
}
