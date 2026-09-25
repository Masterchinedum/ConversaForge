/**
 * ServerPipelineAdapter — the browser captures audio, the server does STT with a real provider.
 *
 *  - Energy VAD on the mic stream splits speech into segments; each segment (with pre-roll) is encoded
 *    as 16 kHz mono WAV and sent to `POST /stt`. Recognized text feeds the same EndOfTurnDetector used
 *    by browser speech, so thinking pauses are respected. (We capture PCM rather than MediaRecorder
 *    webm so the pre-roll keeps the first syllable and every segment is an independently decodable file.)
 *  - Agent speech goes through an AgentSpeaker: server TTS (WebSocket `agent.audio` chunks or
 *    `POST /tts`, played through WebAudio → instant interruption + recording mix) or browser speech.
 *  - When the server answers 503 (provider not configured) we raise a fallback error so the controller
 *    switches to browser speech or typing and shows a notice.
 */

import { ApiError, transcribe } from '../live/runtime-api';
import { randomId } from '../live/token';
import { EndOfTurnDetector } from './end-of-turn';
import { PcmCapture } from './pcm-capture';
import type { AgentSpeaker } from './speaker';
import { Emitter, type SpeakOptions, type VoiceClient, type VoiceClientOptions, type VoiceEvents } from './types';
import { EnergyVad } from './vad';

const MIN_SEGMENT_MS = 250;

export class ServerPipelineAdapter extends Emitter<VoiceEvents> implements VoiceClient {
  readonly mode = 'server' as const;
  readonly listens = true;
  readonly speaks: boolean;

  private vad: EnergyVad | null = null;
  private capture: PcmCapture | null = null;
  private detector: EndOfTurnDetector;
  private clientTurnId: string | null = null;
  private pending = new Set<Promise<void>>();
  private muted = false;
  private paused = false;
  private ptt: boolean;
  private talking = false;
  private started = false;
  private agentAudible = false;
  private sttFailures = 0;
  private unsubs: Array<() => void> = [];

  constructor(
    private o: VoiceClientOptions,
    private speaker: AgentSpeaker | null,
  ) {
    super();
    this.speaks = !!speaker;
    this.ptt = o.turnTaking.mode === 'push_to_talk';
    this.detector = new EndOfTurnDetector(
      { silenceMs: o.turnTaking.endOfTurnSilenceMs, graceMs: o.turnTaking.thinkingPauseGraceMs },
      {
        onCommit: (text, info) => this.emitFinal(text, info.startedAt, info.endedAt, info.confidence),
        onThinking: (w) => this.emit('thinking', w),
      },
    );
    if (speaker) {
      this.unsubs.push(
        speaker.on('playback', (id, ev, n) => this.emit('playback', id, ev, n)),
        speaker.on('audible', (a) => this.onAgentAudible(a)),
        speaker.on('error', (e) => this.emit('error', e)),
        speaker.on('notice', (m) => this.emit('notice', m)),
      );
    }
  }

  async start(): Promise<void> {
    const ctx = this.o.audioContext;
    if (!ctx || !this.o.micStream) {
      this.emit('error', { code: 'no_device', message: 'A microphone is required for voice.', fallback: true });
      throw new Error('No microphone/audio context');
    }
    this.started = true;
    this.capture = new PcmCapture(ctx, this.o.micStream);
    this.capture.start();
    this.vad = new EnergyVad(ctx, this.o.micStream, {
      onLevel: (l) => this.emit('level', l),
      onSpeechStart: ({ duringAgent }) => this.onSpeechStart(duringAgent),
      onSpeechEnd: () => this.onSpeechEnd(),
    });
    this.vad.start();
    this.applyVad();
  }

  private listening(): boolean {
    return this.started && !this.muted && !this.paused && (!this.ptt || this.talking);
  }

  private applyVad() {
    this.vad?.setEnabled(this.listening());
  }

  private onSpeechStart(duringAgent: boolean) {
    if (!this.listening() || this.ptt) return; // push-to-talk segments follow the button
    if (duringAgent && this.agentAudible) {
      if (!this.o.turnTaking.allowBargeIn) return; // ignore (likely echo) while the agent talks
      this.cancelSpeech('barge_in');
    }
    this.emit('speaking', true);
    this.detector.setVoiceActive(true);
    if (!this.clientTurnId) this.clientTurnId = randomId();
    this.capture?.beginSegment();
  }

  private onSpeechEnd() {
    if (this.ptt || !this.capture?.isRecording) return;
    this.emit('speaking', false);
    const seg = this.capture.endSegment();
    this.detector.setVoiceActive(false);
    if (!seg || seg.durationMs < MIN_SEGMENT_MS) return;
    this.sendSegment(seg.wav);
  }

  private sendSegment(wav: Blob) {
    const turnIdAtSend = this.clientTurnId ?? (this.clientTurnId = randomId());
    const p = (async () => {
      try {
        const { text, confidence } = await transcribe(this.o.sessionId, this.o.token, wav, this.o.language);
        this.sttFailures = 0;
        if (!text) return;
        if (!this.clientTurnId) this.clientTurnId = turnIdAtSend;
        this.detector.addFinal(text, confidence);
        this.emit('partial', this.detector.text, this.clientTurnId);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 503 || e.status === 501 || e.status === 404)) {
          this.emit('error', {
            code: 'provider_unavailable',
            message: 'Server speech recognition is not configured.',
            fallback: true,
          });
          return;
        }
        this.sttFailures++;
        if (this.sttFailures >= 3) {
          this.emit('error', { code: 'stt_failed', message: 'Speech recognition keeps failing.', fallback: true });
        } else {
          this.emit('notice', 'We could not transcribe the last thing you said — please repeat it.');
        }
      }
    })();
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private emitFinal(text: string, startedAt: number, endedAt: number, confidence?: number) {
    const id = this.clientTurnId ?? randomId();
    this.clientTurnId = null;
    const base = this.o.sessionStartedAt();
    this.emit('final', text, {
      clientTurnId: id,
      startedAtMs: Math.max(0, Math.round(startedAt - base)),
      endedAtMs: Math.max(0, Math.round(endedAt - base)),
      confidence,
      source: 'server_stt',
    });
  }

  private onAgentAudible(a: boolean) {
    if (a === this.agentAudible) return;
    this.agentAudible = a;
    this.vad?.setAgentPlaying(a);
    this.emit('agentSpeaking', a);
  }

  stop(): void {
    this.started = false;
    this.vad?.stop();
    this.capture?.stop();
    this.speaker?.dispose(); // may emit a final 'interrupted' playback event
    this.unsubs.forEach((u) => u());
    this.detector.dispose();
  }

  setMuted(muted: boolean): void {
    if (muted) this.onSpeechEnd();
    this.muted = muted;
    this.applyVad();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.speaker?.setPaused(paused);
    if (paused) this.commitNow();
    this.applyVad();
  }

  speak(turnId: string, text: string, opts?: SpeakOptions): void {
    this.speaker?.speak(turnId, text, opts?.final);
  }

  handleServerAudio(msg: { turnId: string; seq: number; mime: string; data: string; final?: boolean }) {
    this.speaker?.handleServerAudio?.(msg);
  }

  cancelSpeech(_reason?: 'barge_in' | 'server' | 'local'): void {
    this.speaker?.cancel();
    this.onAgentAudible(false);
  }

  commitNow(): void {
    this.onSpeechEnd();
    if (!this.pending.size) {
      this.detector.commitNow();
      return;
    }
    void Promise.allSettled([...this.pending]).then(() => this.detector.commitNow());
  }

  setPushToTalk(enabled: boolean): void {
    this.ptt = enabled;
    this.talking = false;
    this.applyVad();
  }

  setTalking(held: boolean): void {
    if (!this.ptt || held === this.talking) return;
    this.talking = held;
    this.applyVad();
    if (held) {
      if (this.agentAudible && this.o.turnTaking.allowBargeIn) this.cancelSpeech('barge_in');
      if (!this.clientTurnId) this.clientTurnId = randomId();
      this.emit('speaking', true);
      this.detector.setVoiceActive(true);
      this.capture?.beginSegment();
    } else {
      this.emit('speaking', false);
      const seg = this.capture?.endSegment();
      this.detector.setVoiceActive(false);
      if (seg && seg.durationMs >= MIN_SEGMENT_MS) this.sendSegment(seg.wav);
      if (!this.pending.size) this.detector.commitNow();
      else void Promise.allSettled([...this.pending]).then(() => this.detector.commitNow());
    }
  }
}
