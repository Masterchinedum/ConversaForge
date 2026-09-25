/**
 * One interface for every way a participant can talk to the agent in the browser:
 * browser speech (Web Speech API), a server STT/TTS pipeline, OpenAI Realtime over WebRTC, or typing.
 */

export type VoiceMode = 'browser' | 'server' | 'realtime' | 'typed';

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  browser: 'Browser speech',
  server: 'Server speech',
  realtime: 'OpenAI Realtime',
  typed: 'Typed',
};

export interface FinalMeta {
  startedAtMs: number;
  endedAtMs: number;
  confidence?: number;
  /** Client-generated id shared with the preceding partials (dedupe key on the server). */
  clientTurnId: string;
  source: 'browser_stt' | 'server_stt' | 'typed' | 'realtime' | 'simulated';
}

export type PlaybackEvent = 'started' | 'completed' | 'interrupted';

export interface VoiceEvents {
  /** Interim participant text for the current utterance (not yet committed). */
  partial: (text: string, clientTurnId: string) => void;
  /** A committed participant utterance. */
  final: (text: string, meta: FinalMeta) => void;
  /** Participant voice activity (VAD). */
  speaking: (speaking: boolean) => void;
  /** Agent audio playback lifecycle for a turn. */
  playback: (turnId: string, event: PlaybackEvent, spokenChars: number) => void;
  /** The participant paused mid-thought; UI shows "Listening… take your time". */
  thinking: (waiting: boolean) => void;
  /** The agent audio is currently audible (drives the avatar animation). */
  agentSpeaking: (speaking: boolean) => void;
  /** Mic input level 0..1 (≈15 Hz) for meters. */
  level: (level: number) => void;
  /** Non-fatal notices (e.g. "speech service unavailable; switched to typing"). */
  notice: (message: string) => void;
  error: (err: VoiceError) => void;
  /** Realtime adapter: transcript items and tool calls to mirror to the server. */
  realtimeTranscript: (e: { itemId: string; role: 'user' | 'assistant'; text: string; interrupted?: boolean }) => void;
  realtimeToolCall: (e: { callId: string; name: string; arguments: string }) => void;
  realtimeDelta: (e: { itemId: string; role: 'user' | 'assistant'; text: string }) => void;
}

export interface VoiceError {
  code:
    | 'mic_denied'
    | 'no_device'
    | 'insecure_context'
    | 'unsupported'
    | 'network'
    | 'provider_unavailable'
    | 'realtime_failed'
    | 'stt_failed'
    | 'tts_failed'
    | 'unknown';
  message: string;
  /** When true the controller should switch to another adapter (usually typed). */
  fallback?: boolean;
}

export interface SpeakOptions {
  /** No more text will follow for this turn (playback "completed" fires after this chunk). */
  final?: boolean;
}

export interface VoiceClient {
  readonly mode: VoiceMode;
  /** Whether this adapter captures the participant's voice (typed does not). */
  readonly listens: boolean;
  /** Whether agent speech is audible through this adapter. */
  readonly speaks: boolean;
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  /** Pause/resume capture and playback (session paused). */
  setPaused(paused: boolean): void;
  /** Queue agent speech for a turn. May be called several times per turn with successive chunks. */
  speak(turnId: string, text: string, opts?: SpeakOptions): void;
  /** Stop agent speech immediately (emits playback "interrupted" when something was playing). */
  cancelSpeech(reason?: 'barge_in' | 'server' | 'local'): void;
  /** Commit the current utterance now (push-to-talk release / "I'm done answering"). */
  commitNow(): void;
  /** Push-to-talk: only capture while held. */
  setPushToTalk(enabled: boolean): void;
  setTalking(held: boolean): void;
  /** Receive server-streamed agent audio (pipeline TTS over the WebSocket). */
  handleServerAudio?(msg: { turnId: string; seq: number; mime: string; data: string; final?: boolean }): void;
  /** Realtime adapter: return a tool result to the model. */
  sendToolResult?(callId: string, output: string): void;
  /** Realtime adapter: inject a server instruction (system message) and optionally request a response. */
  sendInstruction?(text: string, respond?: boolean): void;
  on<E extends keyof VoiceEvents>(event: E, fn: VoiceEvents[E]): () => void;
}

/** Tiny typed event emitter shared by adapters. */
export class Emitter<T extends { [K in keyof T]: (...args: any[]) => void }> {
  private handlers = new Map<keyof T, Set<(...args: any[]) => void>>();
  on<E extends keyof T>(event: E, fn: T[E]): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as any);
    return () => set!.delete(fn as any);
  }
  emit<E extends keyof T>(event: E, ...args: Parameters<T[E]>): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        // A misbehaving listener must not break audio handling.
        console.warn('[voice] listener error', e);
      }
    }
  }
  clear() {
    this.handlers.clear();
  }
}

export interface VoiceClientOptions {
  sessionId: string;
  token: string;
  language: string;
  voice: { provider: string; voiceId: string; speed: number };
  turnTaking: {
    mode: 'vad' | 'push_to_talk';
    endOfTurnSilenceMs: number;
    thinkingPauseGraceMs: number;
    allowBargeIn: boolean;
  };
  /** Microphone stream from the device check (owned by the caller; adapters never stop it). */
  micStream: MediaStream | null;
  /** Shared AudioContext (created on a user gesture). */
  audioContext: AudioContext | null;
  /** Node that agent audio should also be routed into (recording mix). */
  recordingSink?: AudioNode | null;
  /** Server-side TTS available (`POST /tts`). */
  serverTts?: boolean;
  /** Speak agent text with speechSynthesis in typed mode. */
  speakInTypedMode?: boolean;
  /** Session start epoch (ms) for relative utterance timestamps. */
  sessionStartedAt: () => number;
}
