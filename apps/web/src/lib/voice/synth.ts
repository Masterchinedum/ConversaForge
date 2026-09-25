/**
 * Agent speech via the browser's speechSynthesis, with per-turn chunk queues and spoken-character
 * tracking (boundary events) so barge-in can report how much the participant actually heard.
 *
 * Note: speechSynthesis output is produced by the OS/browser and cannot be captured into a
 * MediaRecorder, so recordings made in browser-speech mode contain only the participant's side.
 */

import { Emitter } from './types';

interface SynthEvents {
  playback: (turnId: string, event: 'started' | 'completed' | 'interrupted', spokenChars: number) => void;
  audible: (playing: boolean) => void;
}

interface Chunk {
  turnId: string;
  text: string;
  offset: number;
  last: boolean;
}

interface TurnState {
  chars: number;
  spoken: number;
  started: boolean;
  final: boolean;
  done: boolean;
  queued: number;
}

export function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** Pick a voice: explicit voiceId (name match) → exact lang → same language prefix → default. */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string, voiceId?: string): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  if (voiceId) {
    const id = voiceId.toLowerCase();
    const byName =
      voices.find((v) => v.name.toLowerCase() === id || v.voiceURI.toLowerCase() === id) ??
      voices.find((v) => v.name.toLowerCase().includes(id));
    if (byName) return byName;
  }
  const l = lang.toLowerCase();
  const exact = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === l);
  const pool = exact.length ? exact : voices.filter((v) => v.lang.toLowerCase().startsWith(l.split('-')[0]!));
  if (!pool.length) return voices.find((v) => v.default) ?? null;
  // Prefer natural/online voices where the browser offers them.
  return pool.find((v) => /natural|neural|google|premium|enhanced/i.test(v.name)) ?? pool.find((v) => v.default) ?? pool[0]!;
}

export class SynthSpeaker extends Emitter<SynthEvents> {
  private queue: Chunk[] = [];
  private speaking: Chunk | null = null;
  private turns = new Map<string, TurnState>();
  private voice: SpeechSynthesisVoice | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private disposed = false;
  private generation = 0;

  constructor(
    private lang: string,
    private voiceId: string,
    private rate: number,
  ) {
    super();
    if (!hasSpeechSynthesis()) return;
    const load = () => {
      this.voice = pickVoice(window.speechSynthesis.getVoices(), this.lang, this.voiceId);
    };
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  get available() {
    return hasSpeechSynthesis();
  }

  isPlaying() {
    return this.speaking !== null;
  }

  speak(turnId: string, text: string, final = false) {
    if (!hasSpeechSynthesis() || this.disposed) return;
    let t = this.turns.get(turnId);
    if (!t) {
      t = { chars: 0, spoken: 0, started: false, final: false, done: false, queued: 0 };
      this.turns.set(turnId, t);
    }
    if (t.done) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) {
      this.queue.push({ turnId, text: clean, offset: t.chars, last: false });
      t.chars += clean.length + 1;
      t.queued++;
    }
    if (final) {
      t.final = true;
      if (t.queued === 0 && !this.isCurrentTurn(turnId)) this.finishTurn(turnId, 'completed');
    }
    this.pump();
  }

  private isCurrentTurn(turnId: string) {
    return this.speaking?.turnId === turnId || this.queue.some((c) => c.turnId === turnId);
  }

  private pump() {
    if (this.speaking || this.paused || this.disposed) return;
    const next = this.queue.shift();
    if (!next) {
      this.setKeepAlive(false);
      this.emit('audible', false);
      return;
    }
    const t = this.turns.get(next.turnId);
    if (!t || t.done) return this.pump();
    this.speaking = next;
    const gen = ++this.generation;
    const u = new SpeechSynthesisUtterance(next.text);
    u.lang = this.lang;
    if (this.voice) u.voice = this.voice;
    u.rate = Math.min(2, Math.max(0.5, this.rate || 1));
    const onDone = (ok: boolean) => {
      if (gen !== this.generation) return;
      this.clearWatchdog();
      const tt = this.turns.get(next.turnId);
      this.speaking = null;
      if (tt && !tt.done) {
        tt.spoken = Math.max(tt.spoken, next.offset + next.text.length);
        tt.queued--;
        if (tt.final && tt.queued <= 0) this.finishTurn(next.turnId, 'completed');
      }
      if (!ok) this.emit('audible', false);
      this.pump();
    };
    u.onstart = () => {
      if (gen !== this.generation) return;
      const tt = this.turns.get(next.turnId);
      if (tt && !tt.started) {
        tt.started = true;
        this.emit('playback', next.turnId, 'started', 0);
      }
      this.emit('audible', true);
    };
    u.onboundary = (e) => {
      if (gen !== this.generation) return;
      const tt = this.turns.get(next.turnId);
      if (tt) tt.spoken = Math.max(tt.spoken, next.offset + (e.charIndex ?? 0));
    };
    u.onend = () => onDone(true);
    u.onerror = (e) => {
      // 'interrupted'/'canceled' come from our own cancel(); anything else: move on.
      if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('[voice] speech synthesis error', e.error);
      onDone(false);
    };
    // Some platforms (headless, missing voices) never fire onend: don't hang the turn.
    const expectedMs = (next.text.length / (14 * u.rate)) * 1000 + 4000;
    this.watchdog = setTimeout(() => {
      if (gen !== this.generation) return;
      const tt = this.turns.get(next.turnId);
      if (tt && !tt.started) {
        tt.started = true;
        this.emit('playback', next.turnId, 'started', 0);
      }
      onDone(true);
    }, expectedMs);
    this.setKeepAlive(true);
    window.speechSynthesis.speak(u);
  }

  private finishTurn(turnId: string, how: 'completed' | 'interrupted') {
    const t = this.turns.get(turnId);
    if (!t || t.done) return;
    t.done = true;
    if (!t.started && how === 'completed') {
      // Nothing was audible (e.g. empty text) — still report a start/complete pair for the server.
      this.emit('playback', turnId, 'started', 0);
    }
    const spoken = how === 'completed' ? Math.max(0, t.chars - 1) : Math.min(t.spoken, Math.max(0, t.chars - 1));
    if (t.started || how === 'completed') this.emit('playback', turnId, how, spoken);
  }

  /** Stop all speech. Returns the interrupted turn (if audio had started). */
  cancel(): { turnId: string; spokenChars: number } | null {
    if (!hasSpeechSynthesis()) return null;
    const current = this.speaking;
    this.generation++;
    this.clearWatchdog();
    const affected = new Set<string>(this.queue.map((c) => c.turnId));
    if (current) affected.add(current.turnId);
    this.queue = [];
    this.speaking = null;
    window.speechSynthesis.cancel();
    this.setKeepAlive(false);
    this.emit('audible', false);
    let result: { turnId: string; spokenChars: number } | null = null;
    for (const id of affected) {
      const t = this.turns.get(id);
      if (!t || t.done) continue;
      if (t.started) result = { turnId: id, spokenChars: Math.min(t.spoken, Math.max(0, t.chars - 1)) };
      t.done = true;
      if (t.started) this.emit('playback', id, 'interrupted', result?.turnId === id ? result.spokenChars : t.spoken);
    }
    return result;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (!hasSpeechSynthesis()) return;
    if (paused) window.speechSynthesis.pause();
    else {
      window.speechSynthesis.resume();
      this.pump();
    }
  }

  private setKeepAlive(on: boolean) {
    if (on && !this.keepAlive) {
      // Chrome silently stops long utterances after ~15 s unless nudged.
      this.keepAlive = setInterval(() => {
        if (!this.paused && window.speechSynthesis.speaking) window.speechSynthesis.resume();
      }, 10000);
    } else if (!on && this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  dispose() {
    this.cancel();
    this.disposed = true;
    this.clear();
  }
}

/** Heuristic: is this recognized text just the agent's own voice leaking into the mic? */
export function isLikelyEcho(recognized: string, agentText: string): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
  const rec = words(recognized);
  if (!rec.length) return true;
  const agent = new Set(words(agentText));
  if (!agent.size) return false;
  const hits = rec.filter((w) => agent.has(w)).length;
  return hits / rec.length >= 0.7;
}

/**
 * Split streamed agent text into speakable chunks at sentence boundaries so speech can start
 * before the whole reply has arrived.
 */
export class SentenceChunker {
  private buf = '';
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    const re = /[^.!?…]*[.!?…]+["')\]]*\s+/y;
    let m: RegExpExecArray | null;
    let consumed = 0;
    re.lastIndex = 0;
    while ((m = re.exec(this.buf))) {
      const s = m[0].trim();
      if (s) out.push(s);
      consumed = re.lastIndex;
    }
    this.buf = this.buf.slice(consumed);
    // Very long clause without punctuation: flush at a comma to keep latency down.
    if (this.buf.length > 220) {
      const cut = this.buf.lastIndexOf(', ');
      if (cut > 40) {
        out.push(this.buf.slice(0, cut + 1).trim());
        this.buf = this.buf.slice(cut + 2);
      }
    }
    return out;
  }
  flush(): string {
    const s = this.buf.trim();
    this.buf = '';
    return s;
  }
}
