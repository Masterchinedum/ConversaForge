/**
 * TypedAdapter — text-only participant input. Agent replies are shown as captions and, when a
 * speaker is available (browser speechSynthesis or server TTS), also spoken aloud.
 */

import type { AgentSpeaker } from './speaker';
import { Emitter, type SpeakOptions, type VoiceClient, type VoiceEvents } from './types';

export class TypedAdapter extends Emitter<VoiceEvents> implements VoiceClient {
  readonly mode = 'typed' as const;
  readonly listens = false;
  readonly speaks: boolean;
  private chars = new Map<string, number>();
  private unsubs: Array<() => void> = [];
  private muted = false;

  constructor(private speaker: AgentSpeaker | null) {
    super();
    this.speaks = !!speaker;
    if (speaker) {
      this.unsubs.push(
        speaker.on('playback', (id, ev, n) => this.emit('playback', id, ev, n)),
        speaker.on('audible', (a) => this.emit('agentSpeaking', a)),
        speaker.on('notice', (m) => this.emit('notice', m)),
        // A failing voice in typed mode is not fatal: captions remain.
        speaker.on('error', (e) => this.emit('notice', e.message)),
      );
    }
  }

  async start(): Promise<void> {
    /* nothing to acquire */
  }

  stop(): void {
    this.speaker?.dispose(); // may emit a final 'interrupted' playback event
    this.unsubs.forEach((u) => u());
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setPaused(paused: boolean): void {
    this.speaker?.setPaused(paused);
  }

  speak(turnId: string, text: string, opts?: SpeakOptions): void {
    if (this.speaker) {
      this.speaker.speak(turnId, text, opts?.final);
      return;
    }
    const n = (this.chars.get(turnId) ?? 0) + (text ? text.length + 1 : 0);
    this.chars.set(turnId, n);
    if (opts?.final) {
      // Text only: report the turn as delivered (read on screen) so the server does not wait on playback.
      this.chars.delete(turnId);
      this.emit('playback', turnId, 'started', 0);
      this.emit('playback', turnId, 'completed', Math.max(0, n - 1));
    }
  }

  handleServerAudio(msg: { turnId: string; seq: number; mime: string; data: string; final?: boolean }) {
    this.speaker?.handleServerAudio?.(msg);
  }

  cancelSpeech(): void {
    this.speaker?.cancel();
  }

  commitNow(): void {
    /* typed input is committed by the text box */
  }

  setPushToTalk(): void {
    /* n/a */
  }

  setTalking(): void {
    /* n/a */
  }

  get isMuted() {
    return this.muted;
  }
}
