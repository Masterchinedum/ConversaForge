/**
 * BrowserSpeechAdapter — Web Speech API recognition + speechSynthesis for the agent's voice.
 *
 * Robustness notes:
 *  - Recognition sessions end on their own (Chrome cuts continuous recognition after ~60 s, on network
 *    hiccups, after long silence). We restart automatically with backoff while we still want to listen.
 *  - Without barge-in we stop recognition while the agent speaks (otherwise it transcribes the agent).
 *  - With barge-in we keep listening and use an adaptive energy VAD (sustained ~300 ms above a raised
 *    threshold) plus an echo filter (recognized words mostly contained in the agent's current text)
 *    so the agent's own voice leaking into the mic does not count as an interruption.
 *  - End of turn is decided by EndOfTurnDetector (silence + "still thinking" grace), not by the
 *    recognizer's isFinal flag.
 */

import { EndOfTurnDetector } from './end-of-turn';
import { EnergyVad } from './vad';
import { isLikelyEcho, SynthSpeaker } from './synth';
import { Emitter, type SpeakOptions, type VoiceClient, type VoiceClientOptions, type VoiceEvents } from './types';
import { randomId } from '../live/token';

type SR = any; // SpeechRecognition is not in TS's DOM lib.

export function getSpeechRecognitionCtor(): (new () => SR) | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const PARTIAL_THROTTLE_MS = 250;

export class BrowserSpeechAdapter extends Emitter<VoiceEvents> implements VoiceClient {
  readonly mode = 'browser' as const;
  readonly listens = true;
  readonly speaks = true;

  private rec: SR | null = null;
  private running = false;
  private startedFlag = false;
  private muted = false;
  private paused = false;
  private ptt = false;
  private talking = false;
  private agentAudible = false;
  private agentAudibleUntil = 0;
  private agentTexts = new Map<string, string>();
  private currentAgentTurn: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private errorTimes: number[] = [];
  private fatal = false;
  private detector: EndOfTurnDetector;
  private vad: EnergyVad | null = null;
  private synth: SynthSpeaker;
  private clientTurnId: string | null = null;
  private lastPartialAt = 0;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private speakingFlag = false;
  private pttReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: VoiceClientOptions) {
    super();
    this.ptt = o.turnTaking.mode === 'push_to_talk';
    this.detector = new EndOfTurnDetector(
      { silenceMs: o.turnTaking.endOfTurnSilenceMs, graceMs: o.turnTaking.thinkingPauseGraceMs },
      {
        onCommit: (text, info) => {
          const id = this.clientTurnId ?? randomId();
          this.clientTurnId = null;
          this.flushPartialTimer();
          const base = this.o.sessionStartedAt();
          this.emit('final', text, {
            clientTurnId: id,
            startedAtMs: Math.max(0, Math.round(info.startedAt - base)),
            endedAtMs: Math.max(0, Math.round(info.endedAt - base)),
            confidence: info.confidence,
            source: 'browser_stt',
          });
        },
        onThinking: (w) => this.emit('thinking', w),
      },
    );
    this.synth = new SynthSpeaker(o.language, o.voice.voiceId, o.voice.speed);
    this.synth.on('playback', (turnId, ev, chars) => this.emit('playback', turnId, ev, chars));
    this.synth.on('audible', (a) => this.onAgentAudible(a));
  }

  async start(): Promise<void> {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      const err = { code: 'unsupported' as const, message: 'Speech recognition is not available in this browser.', fallback: true };
      this.emit('error', err);
      throw new Error(err.message);
    }
    this.startedFlag = true;
    if (this.o.micStream && this.o.audioContext) {
      this.vad = new EnergyVad(this.o.audioContext, this.o.micStream, {
        onLevel: (l) => this.emit('level', l),
        onSpeechStart: ({ duringAgent }) => {
          this.setSpeaking(true);
          this.detector.setVoiceActive(true);
          if (duringAgent && this.agentAudible && this.o.turnTaking.allowBargeIn) this.cancelSpeech('barge_in');
        },
        onSpeechEnd: () => {
          this.setSpeaking(false);
          this.detector.setVoiceActive(false);
        },
      });
      this.vad.start();
    }
    this.rec = this.createRecognition(Ctor);
    this.apply();
  }

  private createRecognition(Ctor: new () => SR): SR {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = this.o.language || 'en-US';
    r.maxAlternatives = 1;
    r.onstart = () => {
      this.running = true;
    };
    r.onend = () => {
      this.running = false;
      // Recognizer ended mid-utterance: keep what it had heard.
      if (this.pendingInterim) {
        this.detector.addFinal(this.pendingInterim);
        this.pendingInterim = '';
      }
      this.scheduleRestart();
    };
    r.onerror = (e: any) => this.onRecError(e?.error ?? 'unknown');
    r.onresult = (e: any) => this.onResult(e);
    r.onspeechstart = () => {
      if (!this.vad) {
        this.setSpeaking(true);
        this.detector.setVoiceActive(true);
      }
    };
    r.onspeechend = () => {
      if (!this.vad) {
        this.setSpeaking(false);
        this.detector.setVoiceActive(false);
      }
    };
    return r;
  }

  private pendingInterim = '';

  private onResult(e: any) {
    let interim = '';
    const finals: Array<{ text: string; confidence: number }> = [];
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alt = res[0];
      if (!alt) continue;
      if (res.isFinal) finals.push({ text: alt.transcript, confidence: alt.confidence });
      else interim += alt.transcript;
    }
    const agentRecentlyAudible = this.agentAudible || Date.now() < this.agentAudibleUntil;
    const agentText = this.recentAgentText();
    const accept = (text: string) => {
      if (!text.trim()) return false;
      if (agentRecentlyAudible && agentText && isLikelyEcho(text, agentText)) return false;
      return true;
    };
    for (const f of finals) {
      if (!accept(f.text)) continue;
      this.ensureTurnId();
      this.detector.addFinal(f.text, f.confidence);
    }
    if (accept(interim)) {
      this.ensureTurnId();
      this.pendingInterim = interim;
      this.detector.setInterim(interim);
    } else {
      this.pendingInterim = '';
      if (!interim) this.detector.setInterim('');
    }
    // Words that are clearly not echo while the agent talks → participant is interrupting.
    const heard = [...finals.map((f) => f.text), interim].filter((t) => accept(t)).join(' ');
    if (this.agentAudible && this.o.turnTaking.allowBargeIn && heard.trim().split(/\s+/).filter(Boolean).length >= 2) {
      this.cancelSpeech('barge_in');
    }
    if (this.detector.hasContent) this.schedulePartial();
  }

  private ensureTurnId() {
    if (!this.clientTurnId) this.clientTurnId = randomId();
  }

  private schedulePartial() {
    const now = Date.now();
    const wait = Math.max(0, PARTIAL_THROTTLE_MS - (now - this.lastPartialAt));
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      this.lastPartialAt = Date.now();
      const text = this.detector.text;
      if (text && this.clientTurnId) this.emit('partial', text, this.clientTurnId);
    }, wait);
  }

  private flushPartialTimer() {
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
  }

  private recentAgentText(): string {
    if (this.currentAgentTurn) return this.agentTexts.get(this.currentAgentTurn) ?? '';
    return [...this.agentTexts.values()].slice(-1)[0] ?? '';
  }

  private onRecError(code: string) {
    if (code === 'no-speech' || code === 'aborted') return; // onend restarts
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.fatal = true;
      this.emit('error', {
        code: code === 'not-allowed' ? 'mic_denied' : 'provider_unavailable',
        message:
          code === 'not-allowed'
            ? 'Microphone access for speech recognition was blocked.'
            : 'The browser speech service is not available here.',
        fallback: true,
      });
      return;
    }
    if (code === 'audio-capture') {
      this.fatal = true;
      this.emit('error', { code: 'no_device', message: 'No microphone could be used for speech recognition.', fallback: true });
      return;
    }
    if (code === 'language-not-supported' || code === 'bad-grammar') {
      this.fatal = true;
      this.emit('error', { code: 'unsupported', message: `Speech recognition does not support ${this.o.language}.`, fallback: true });
      return;
    }
    // network and other transient errors: back off; give up after repeated failures.
    const now = Date.now();
    this.errorTimes = [...this.errorTimes.filter((t) => now - t < 30000), now];
    if (this.errorTimes.length >= 6) {
      this.fatal = true;
      this.emit('error', {
        code: 'network',
        message: 'The browser speech service keeps failing (network). Switching to typing.',
        fallback: true,
      });
    }
  }

  private wantListening(): boolean {
    if (!this.startedFlag || this.fatal || this.muted || this.paused) return false;
    if (this.ptt && !this.talking) return false;
    if (this.agentAudible && !this.o.turnTaking.allowBargeIn && !this.ptt) return false;
    return true;
  }

  private apply() {
    if (!this.rec) return;
    const want = this.wantListening();
    if (want && !this.running) this.safeStart();
    else if (!want && this.running) {
      try {
        // abort() drops pending results (used while the agent talks); stop() keeps them.
        if (this.agentAudible && !this.o.turnTaking.allowBargeIn) this.rec.abort();
        else this.rec.stop();
      } catch {
        /* ignore */
      }
    }
    this.vad?.setEnabled(!this.muted && !this.paused && (!this.ptt || this.talking));
  }

  private safeStart() {
    if (!this.rec || this.running) return;
    try {
      this.rec.start();
      this.running = true;
    } catch {
      // InvalidStateError: already started — onstart/onend will sort it out.
    }
  }

  private scheduleRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (!this.wantListening()) return;
    const backoff = Math.min(5000, 150 * 2 ** Math.max(0, this.errorTimes.length - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wantListening()) this.safeStart();
    }, this.errorTimes.length ? backoff : 120);
  }

  private onAgentAudible(a: boolean) {
    if (a === this.agentAudible) return;
    this.agentAudible = a;
    if (!a) this.agentAudibleUntil = Date.now() + 1200;
    this.vad?.setAgentPlaying(a);
    this.emit('agentSpeaking', a);
    this.apply();
    if (!a) this.scheduleRestart();
  }

  private setSpeaking(s: boolean) {
    if (s === this.speakingFlag) return;
    this.speakingFlag = s;
    this.emit('speaking', s);
  }

  stop(): void {
    this.startedFlag = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.pttReleaseTimer) clearTimeout(this.pttReleaseTimer);
    this.flushPartialTimer();
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = null;
    this.running = false;
    this.vad?.stop();
    this.vad = null;
    this.detector.dispose();
    this.synth.dispose();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.setSpeaking(false);
    this.apply();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.cancelSpeech('local');
      this.detector.commitNow();
      this.setSpeaking(false);
    }
    this.apply();
  }

  speak(turnId: string, text: string, opts?: SpeakOptions): void {
    this.currentAgentTurn = turnId;
    this.agentTexts.set(turnId, `${this.agentTexts.get(turnId) ?? ''} ${text}`.trim());
    if (this.agentTexts.size > 10) this.agentTexts.delete(this.agentTexts.keys().next().value!);
    this.synth.speak(turnId, text, opts?.final);
  }

  cancelSpeech(_reason?: 'barge_in' | 'server' | 'local'): void {
    this.synth.cancel(); // emits playback 'interrupted' via the synth listener
    this.onAgentAudible(false);
  }

  commitNow(): void {
    this.detector.commitNow();
  }

  setPushToTalk(enabled: boolean): void {
    this.ptt = enabled;
    this.talking = false;
    this.apply();
  }

  setTalking(held: boolean): void {
    if (!this.ptt) return;
    if (held === this.talking) return;
    this.talking = held;
    if (held) {
      if (this.pttReleaseTimer) clearTimeout(this.pttReleaseTimer);
      if (this.agentAudible && this.o.turnTaking.allowBargeIn) this.cancelSpeech('barge_in');
      this.setSpeaking(true);
      this.apply();
    } else {
      this.setSpeaking(false);
      this.apply(); // stop() → recognizer flushes final results, then we commit
      this.pttReleaseTimer = setTimeout(() => {
        if (this.pendingInterim) {
          this.detector.addFinal(this.pendingInterim);
          this.pendingInterim = '';
        }
        this.detector.commitNow();
      }, 700);
    }
  }
}
