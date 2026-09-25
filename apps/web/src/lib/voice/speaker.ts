/**
 * Agent speech output abstraction, so any input method (browser STT, server STT) can be combined with
 * any output method (browser speechSynthesis, server TTS through WebAudio).
 */

import { ApiError, synthesize } from '../live/runtime-api';
import { AudioPlayer, base64ToBytes } from './audio-player';
import { SynthSpeaker } from './synth';
import { Emitter, type VoiceError } from './types';

export interface SpeakerEvents {
  playback: (turnId: string, event: 'started' | 'completed' | 'interrupted', spokenChars: number) => void;
  audible: (playing: boolean) => void;
  error: (e: VoiceError) => void;
  notice: (message: string) => void;
}

export interface AgentSpeaker {
  readonly kind: 'browser' | 'server';
  speak(turnId: string, text: string, final?: boolean): void;
  cancel(): void;
  setPaused(paused: boolean): void;
  handleServerAudio?(msg: { turnId: string; seq: number; mime: string; data: string; final?: boolean }): void;
  on<E extends keyof SpeakerEvents>(event: E, fn: SpeakerEvents[E]): () => void;
  dispose(): void;
}

export class BrowserSpeaker extends Emitter<SpeakerEvents> implements AgentSpeaker {
  readonly kind = 'browser' as const;
  private synth: SynthSpeaker;
  constructor(lang: string, voiceId: string, rate: number) {
    super();
    this.synth = new SynthSpeaker(lang, voiceId, rate);
    this.synth.on('playback', (id, ev, n) => this.emit('playback', id, ev, n));
    this.synth.on('audible', (a) => this.emit('audible', a));
  }
  speak(turnId: string, text: string, final?: boolean) {
    this.synth.speak(turnId, text, final);
  }
  cancel() {
    this.synth.cancel();
  }
  setPaused(p: boolean) {
    this.synth.setPaused(p);
  }
  dispose() {
    this.synth.dispose();
    this.clear();
  }
}

const SERVER_AUDIO_WAIT_MS = 450;

/** Server TTS: plays `agent.audio` chunks streamed over the WebSocket, else fetches `POST /tts`. */
export class ServerSpeaker extends Emitter<SpeakerEvents> implements AgentSpeaker {
  readonly kind = 'server' as const;
  private player: AudioPlayer;
  private turnText = new Map<string, string>();
  private serverAudioTurns = new Set<string>();
  private ttsTurns = new Set<string>();
  private ttsAbort = new Map<string, AbortController>();
  private disposed = false;
  private paused = false;

  constructor(
    ctx: AudioContext,
    recordingSink: AudioNode | null | undefined,
    private sessionId: string,
    private token: string,
  ) {
    super();
    this.player = new AudioPlayer(ctx, recordingSink);
    this.player.on('playback', (id, ev, n) => this.emit('playback', id, ev, n));
    this.player.on('audible', (a) => this.emit('audible', a));
  }

  speak(turnId: string, text: string, final?: boolean) {
    this.turnText.set(turnId, `${this.turnText.get(turnId) ?? ''} ${text}`.trim());
    this.player.setTurnText(turnId, this.turnText.get(turnId)!.length);
    if (!final) return;
    setTimeout(() => {
      if (this.disposed || this.paused || this.serverAudioTurns.has(turnId) || this.ttsTurns.has(turnId)) return;
      void this.requestTts(turnId);
    }, SERVER_AUDIO_WAIT_MS);
  }

  private async requestTts(turnId: string) {
    const text = this.turnText.get(turnId);
    if (!text) return;
    this.ttsTurns.add(turnId);
    const ctrl = new AbortController();
    this.ttsAbort.set(turnId, ctrl);
    try {
      const { bytes, mime } = await synthesize(this.sessionId, this.token, text, ctrl.signal);
      if (ctrl.signal.aborted || this.disposed) return;
      await this.player.enqueue(turnId, bytes, mime, true);
      this.player.end(turnId);
    } catch (e) {
      if (ctrl.signal.aborted || this.disposed) return;
      if (e instanceof ApiError && (e.status === 503 || e.status === 501 || e.status === 404)) {
        this.emit('error', { code: 'tts_failed', message: 'Server voice is not configured; using the browser voice.', fallback: true });
      } else {
        this.emit('notice', 'The agent’s voice could not be played for this reply — see the captions.');
      }
      // Report the reply as delivered (on screen) so the conversation continues.
      this.emit('playback', turnId, 'started', 0);
      this.emit('playback', turnId, 'completed', text.length);
    } finally {
      this.ttsAbort.delete(turnId);
    }
  }

  handleServerAudio(msg: { turnId: string; seq: number; mime: string; data: string; final?: boolean }) {
    if (this.disposed || this.ttsTurns.has(msg.turnId)) return;
    this.serverAudioTurns.add(msg.turnId);
    void this.player.enqueue(msg.turnId, msg.data ? base64ToBytes(msg.data) : new Uint8Array(0), msg.mime, !!msg.final);
    if (msg.final) this.player.end(msg.turnId);
  }

  cancel() {
    for (const c of this.ttsAbort.values()) c.abort();
    this.ttsAbort.clear();
    this.player.stopAll();
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) this.cancel();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.player.dispose();
    this.clear();
  }
}
