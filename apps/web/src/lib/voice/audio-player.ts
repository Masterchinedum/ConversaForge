/**
 * Agent audio playback through WebAudio (server TTS chunks / TTS responses).
 * Playing through an AudioContext (instead of speechSynthesis) lets us:
 *   - stop instantly on barge-in and estimate how much of the text was heard,
 *   - route the agent's voice into the call recording mix.
 */

import { Emitter } from './types';

interface TurnPlayback {
  turnId: string;
  textChars: number;
  sources: AudioBufferSourceNode[];
  scheduledUntil: number;
  startedAt: number | null;
  totalDuration: number;
  final: boolean;
  started: boolean;
  pendingDecode: number;
  /** Raw encoded chunks kept when individual chunks cannot be decoded (e.g. partial mp3 frames). */
  undecoded: Uint8Array[];
  undecodedMime: string;
  done: boolean;
}

interface PlayerEvents {
  playback: (turnId: string, event: 'started' | 'completed' | 'interrupted', spokenChars: number) => void;
  audible: (playing: boolean) => void;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parsePcmRate(mime: string): number | null {
  const m = /audio\/(?:pcm|l16)(?:.*rate=(\d+))?/i.exec(mime);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 24000;
}

export class AudioPlayer extends Emitter<PlayerEvents> {
  private out: GainNode;
  private turns = new Map<string, TurnPlayback>();
  private current: string | null = null;
  private audible = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private ctx: AudioContext,
    recordingSink?: AudioNode | null,
  ) {
    super();
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    if (recordingSink) this.out.connect(recordingSink);
    this.checkTimer = setInterval(() => this.poll(), 100);
  }

  setVolume(v: number) {
    this.out.gain.value = v;
  }

  private turn(turnId: string, textChars = 0): TurnPlayback {
    let t = this.turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        textChars,
        sources: [],
        scheduledUntil: 0,
        startedAt: null,
        totalDuration: 0,
        final: false,
        started: false,
        pendingDecode: 0,
        undecoded: [],
        undecodedMime: '',
        done: false,
      };
      this.turns.set(turnId, t);
    }
    if (textChars) t.textChars = Math.max(t.textChars, textChars);
    return t;
  }

  setTurnText(turnId: string, chars: number) {
    this.turn(turnId).textChars = chars;
  }

  /** Enqueue one encoded chunk (base64 or bytes) for a turn. */
  async enqueue(turnId: string, bytes: Uint8Array, mime: string, final: boolean) {
    const t = this.turn(turnId);
    if (t.done) return;
    if (final) t.final = true;
    const rate = parsePcmRate(mime);
    if (rate) {
      if (bytes.byteLength >= 2) this.schedule(t, this.pcmToBuffer(bytes, rate));
      this.poll();
      return;
    }
    if (bytes.byteLength === 0) {
      if (final && t.undecoded.length) await this.flushUndecoded(t);
      this.poll();
      return;
    }
    // If an earlier chunk could not be decoded, keep concatenating until the end.
    if (t.undecoded.length) {
      t.undecoded.push(bytes);
      if (final) await this.flushUndecoded(t);
      return;
    }
    t.pendingDecode++;
    try {
      const copy = bytes.slice().buffer;
      const buf = await this.ctx.decodeAudioData(copy);
      if (!t.done) this.schedule(t, buf);
    } catch {
      t.undecoded.push(bytes);
      t.undecodedMime = mime;
      if (final) await this.flushUndecoded(t);
    } finally {
      t.pendingDecode--;
      this.poll();
    }
  }

  private async flushUndecoded(t: TurnPlayback) {
    const total = t.undecoded.reduce((n, b) => n + b.byteLength, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const b of t.undecoded) {
      all.set(b, off);
      off += b.byteLength;
    }
    t.undecoded = [];
    t.pendingDecode++;
    try {
      const buf = await this.ctx.decodeAudioData(all.buffer);
      if (!t.done) this.schedule(t, buf);
    } catch (e) {
      console.warn('[voice] could not decode agent audio', e);
    } finally {
      t.pendingDecode--;
      this.poll();
    }
  }

  private pcmToBuffer(bytes: Uint8Array, rate: number): AudioBuffer {
    const samples = Math.floor(bytes.byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
    const buf = this.ctx.createBuffer(1, samples, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
    return buf;
  }

  private schedule(t: TurnPlayback, buf: AudioBuffer) {
    if (this.current && this.current !== t.turnId) {
      // A new turn supersedes anything still queued from an older one.
      const prev = this.turns.get(this.current);
      if (prev && !prev.done) this.finish(prev, 'interrupted');
    }
    this.current = t.turnId;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    const at = Math.max(now + 0.02, t.scheduledUntil);
    src.start(at);
    t.sources.push(src);
    t.scheduledUntil = at + buf.duration;
    t.totalDuration += buf.duration;
    if (t.startedAt === null) t.startedAt = at;
    if (!t.started) {
      t.started = true;
      this.emit('playback', t.turnId, 'started', 0);
    }
    this.setAudible(true);
  }

  /** Mark that no more audio will arrive for this turn. */
  end(turnId: string) {
    const t = this.turn(turnId);
    t.final = true;
    if (t.undecoded.length) void this.flushUndecoded(t);
    this.poll();
  }

  spokenChars(turnId: string): number {
    const t = this.turns.get(turnId);
    if (!t || t.startedAt === null || t.totalDuration <= 0) return 0;
    const played = Math.max(0, Math.min(this.ctx.currentTime, t.scheduledUntil) - t.startedAt);
    return Math.round(t.textChars * Math.min(1, played / t.totalDuration));
  }

  isPlaying(): boolean {
    return this.audible;
  }

  get currentTurnId(): string | null {
    return this.current;
  }

  /** Stop everything immediately. Returns the interrupted turn id (if any). */
  stopAll(): { turnId: string; spokenChars: number } | null {
    let result: { turnId: string; spokenChars: number } | null = null;
    for (const t of this.turns.values()) {
      if (t.done) continue;
      const wasAudible = t.started;
      const spoken = this.spokenChars(t.turnId);
      if (wasAudible) {
        result = { turnId: t.turnId, spokenChars: spoken };
        this.finish(t, 'interrupted');
      } else {
        t.done = true;
        this.stopSources(t);
      }
    }
    this.current = null;
    this.setAudible(false);
    return result;
  }

  private stopSources(t: TurnPlayback) {
    for (const s of t.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* already stopped */
      }
    }
    t.sources = [];
  }

  private finish(t: TurnPlayback, how: 'completed' | 'interrupted') {
    if (t.done) return;
    const spoken = how === 'completed' ? t.textChars : this.spokenChars(t.turnId);
    t.done = true;
    this.stopSources(t);
    if (this.current === t.turnId) this.current = null;
    if (t.started) this.emit('playback', t.turnId, how, spoken);
  }

  private poll() {
    const now = this.ctx.currentTime;
    let anyAudible = false;
    for (const t of this.turns.values()) {
      if (t.done) continue;
      if (t.started && now < t.scheduledUntil) anyAudible = true;
      if (t.final && t.pendingDecode === 0 && t.undecoded.length === 0 && t.started && now >= t.scheduledUntil - 0.01) {
        this.finish(t, 'completed');
      } else if (t.final && t.pendingDecode === 0 && t.undecoded.length === 0 && !t.started) {
        // Nothing playable arrived.
        t.done = true;
      }
    }
    this.setAudible(anyAudible);
    // Keep the map small.
    if (this.turns.size > 50) for (const [id, t] of this.turns) if (t.done) this.turns.delete(id);
  }

  private setAudible(a: boolean) {
    if (a === this.audible) return;
    this.audible = a;
    this.emit('audible', a);
  }

  dispose() {
    this.stopAll();
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    try {
      this.out.disconnect();
    } catch {
      /* ignore */
    }
    this.clear();
  }
}
