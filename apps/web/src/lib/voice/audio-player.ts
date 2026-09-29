/**
 * Agent audio playback through WebAudio (live-model PCM streams, server TTS chunks / TTS responses).
 * Playing through an AudioContext (instead of speechSynthesis or an <audio> element) lets us:
 *   - stop instantly on barge-in (with a short fade, so no click) and estimate how much text was heard,
 *   - duck the agent while the participant starts talking over it,
 *   - route the agent's voice into the call recording mix,
 *   - play a chunked stream gaplessly: chunks are resampled to the context rate with continuity across
 *     chunk boundaries (independently resampled chunks click at every seam), appended to one timeline,
 *     a small jitter buffer absorbs network arrival jitter before a turn starts (and after an underrun),
 *     and successive turns queue back to back instead of cutting each other off.
 */

import { Emitter } from './types';

/**
 * Audio queued before a turn starts playing (absorbs arrival jitter and a stream that starts slower than
 * real time); the end of the turn flushes early. A live model's first seconds can arrive at ~0.7× real time.
 */
export const PREBUFFER_S = 0.3;
/** After the queue ran dry mid-turn, wait for at least this much audio before resuming. */
export const REBUFFER_S = 0.3;
/** Each underrun grows the cushion for the rest of the session (learned jitter), up to this. */
const MAX_CUSHION_S = 1.0;
const CUSHION_STEP_S = 0.15;

export interface PlayerStats {
  /** Times audio arrived after the queue had run dry mid-turn (each one was an audible gap). */
  underruns: number;
  /** Buffers scheduled. */
  buffers: number;
  /** Seconds of audio received / scheduled. */
  receivedS: number;
  scheduledS: number;
  /** Current start cushion (grows after underruns). */
  cushionS: number;
}
/** Coalesce tiny chunks into buffers of at least this length while enough audio is queued ahead. */
const MIN_BUFFER_S = 0.06;
/** Queue depth below which pending audio is scheduled at once, however small. */
const LOW_WATER_S = 0.15;
/** Earliest a buffer is scheduled ahead of `currentTime`. */
const LEAD_S = 0.03;
/**
 * Pending audio is never held back longer than this after the last chunk arrived (a stream that stops
 * mid-turn still plays what arrived). Long enough that a merely slow stream keeps filling the cushion.
 */
const MAX_HOLD_MS = 1200;
const FADE_S = 0.02;
const POLL_MS = 50;
const DUCK_GAIN = 0.25;

interface TurnPlayback {
  turnId: string;
  textChars: number;
  sources: AudioBufferSourceNode[];
  /** Context time when this turn's first buffer starts playing. */
  startedAt: number | null;
  /** Context time up to which this turn's audio is scheduled. */
  scheduledUntil: number;
  scheduledDuration: number;
  /** Seconds received (scheduled + pending), for the heard-text estimate. */
  receivedDuration: number;
  final: boolean;
  started: boolean;
  pendingDecode: number;
  /** Raw encoded chunks kept when individual chunks cannot be decoded (e.g. partial mp3 frames). */
  undecoded: Uint8Array[];
  undecodedMime: string;
  done: boolean;
  /** Samples at the context rate waiting to be scheduled. */
  pending: Float32Array[];
  pendingSamples: number;
  lastEnqueueAt: number;
  resampler: Resampler | null;
  /** The queue ran dry and the next audio is being cushioned. */
  underrun: boolean;
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

/** Little-endian PCM16 → Float32 [-1, 1]. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const samples = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/**
 * Linear-interpolation resampler that keeps its state across calls, so a stream of short chunks is
 * resampled as one continuous signal: the last sample of the previous chunk anchors the first output
 * samples of the next one, and the fractional read position carries over.
 */
export class Resampler {
  private last = 0;
  /** Read position of the next output sample in input samples, where 0 is the previous chunk's last sample. */
  private pos = 1;

  constructor(
    readonly from: number,
    readonly to: number,
  ) {}

  process(input: Float32Array): Float32Array {
    const n = input.length;
    if (n === 0) return input;
    if (this.from === this.to) return input;
    const step = this.from / this.to;
    const out = new Float32Array(Math.max(0, Math.floor((n - this.pos) / step) + 2));
    const at = (i: number) => (i === 0 ? this.last : input[i - 1]!);
    let k = 0;
    let p = this.pos;
    for (; p <= n; p += step) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = at(i);
      out[k++] = frac > 0 ? a + (at(i + 1) - a) * frac : a;
    }
    this.pos = p - n;
    this.last = input[n - 1]!;
    return out.subarray(0, k);
  }
}

/** Mono mixdown of a decoded buffer (already at the context rate). */
function mixdown(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length);
  const n = buf.numberOfChannels;
  if (n === 1) {
    out.set(buf.getChannelData(0));
    return out;
  }
  for (let c = 0; c < n; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i]! / n;
  }
  return out;
}

export class AudioPlayer extends Emitter<PlayerEvents> {
  private out: GainNode;
  private duckNode: GainNode;
  private turns = new Map<string, TurnPlayback>();
  private current: string | null = null;
  private audible = false;
  private ducked = false;
  private volume = 1;
  /** Context time up to which audio (of any turn) is scheduled: the shared, gapless timeline. */
  private playhead = 0;
  private cushion = PREBUFFER_S;
  private stats: PlayerStats = { underruns: 0, buffers: 0, receivedS: 0, scheduledS: 0, cushionS: PREBUFFER_S };
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private ctx: AudioContext,
    recordingSink?: AudioNode | null,
  ) {
    super();
    this.duckNode = ctx.createGain();
    this.out = ctx.createGain();
    this.duckNode.connect(this.out);
    this.out.connect(ctx.destination);
    if (recordingSink) this.out.connect(recordingSink);
    this.checkTimer = setInterval(() => this.poll(), POLL_MS);
  }

  setVolume(v: number) {
    this.volume = v;
    this.out.gain.setValueAtTime(v, this.ctx.currentTime);
  }

  /** Lower the agent while the participant starts talking over it (restored on stopAll / duck(false)). */
  duck(on: boolean) {
    if (on === this.ducked) return;
    this.ducked = on;
    const g = this.duckNode.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(on ? DUCK_GAIN : 1, now, on ? 0.04 : 0.1);
  }

  private turn(turnId: string, textChars = 0): TurnPlayback {
    let t = this.turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        textChars,
        sources: [],
        startedAt: null,
        scheduledUntil: 0,
        scheduledDuration: 0,
        receivedDuration: 0,
        final: false,
        started: false,
        pendingDecode: 0,
        undecoded: [],
        undecodedMime: '',
        done: false,
        pending: [],
        pendingSamples: 0,
        lastEnqueueAt: 0,
        resampler: null,
        underrun: false,
      };
      this.turns.set(turnId, t);
    }
    if (textChars) t.textChars = Math.max(t.textChars, textChars);
    return t;
  }

  setTurnText(turnId: string, chars: number) {
    this.turn(turnId).textChars = chars;
  }

  /** Enqueue one chunk (raw PCM16 or an encoded format decodeAudioData understands) for a turn. */
  async enqueue(turnId: string, bytes: Uint8Array, mime: string, final: boolean) {
    const t = this.turn(turnId);
    if (t.done) return;
    if (final) t.final = true;
    const rate = parsePcmRate(mime);
    if (rate) {
      if (bytes.byteLength >= 2) {
        if (!t.resampler || t.resampler.from !== rate) t.resampler = new Resampler(rate, this.ctx.sampleRate);
        this.push(t, t.resampler.process(pcm16ToFloat(bytes)));
      }
      this.drain(t);
      return;
    }
    if (bytes.byteLength === 0) {
      if (final && t.undecoded.length) await this.flushUndecoded(t);
      this.drain(t);
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
      if (!t.done) this.push(t, mixdown(buf));
    } catch {
      t.undecoded.push(bytes);
      t.undecodedMime = mime;
      if (final) await this.flushUndecoded(t);
    } finally {
      t.pendingDecode--;
      this.drain(t);
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
      if (!t.done) this.push(t, mixdown(buf));
    } catch (e) {
      console.warn('[voice] could not decode agent audio', e);
    } finally {
      t.pendingDecode--;
      this.drain(t);
    }
  }

  private push(t: TurnPlayback, samples: Float32Array) {
    if (!samples.length) return;
    t.pending.push(samples);
    t.pendingSamples += samples.length;
    t.receivedDuration += samples.length / this.ctx.sampleRate;
    this.stats.receivedS += samples.length / this.ctx.sampleRate;
    t.lastEnqueueAt = performance.now();
  }

  getStats(): PlayerStats {
    return { ...this.stats, cushionS: this.cushion };
  }

  /**
   * Schedule pending audio: at once while audio is already queued (coalescing tiny chunks when there is
   * plenty ahead), otherwise only once a small cushion has built up so arrival jitter does not become
   * audible gaps. The end of a turn, or a stalled stream, flushes whatever is there.
   */
  private drain(t: TurnPlayback) {
    if (t.done) return;
    if (!t.pendingSamples) {
      this.poll();
      return;
    }
    const now = this.ctx.currentTime;
    const queued = Math.max(0, this.playhead - now);
    const pendingS = t.pendingSamples / this.ctx.sampleRate;
    const stalled = performance.now() - t.lastEnqueueAt >= MAX_HOLD_MS;
    if (queued <= 0.005 && t.started && !t.underrun) {
      // The queue ran dry mid-turn: an audible gap. Remember it and start later next time.
      t.underrun = true;
      this.stats.underruns++;
      this.cushion = Math.min(MAX_CUSHION_S, this.cushion + CUSHION_STEP_S);
    }
    if (!t.final && !stalled) {
      if (queued <= 0.005) {
        // Nothing is playing: start (or resume after an underrun) only with a cushion.
        if (pendingS < Math.max(t.started ? REBUFFER_S : 0, this.cushion)) return;
      } else if (pendingS < MIN_BUFFER_S && queued > LOW_WATER_S) {
        return; // plenty queued ahead: wait to coalesce
      }
    }
    t.underrun = false;
    this.schedule(t, this.takePending(t));
  }

  private takePending(t: TurnPlayback): Float32Array {
    const all = new Float32Array(t.pendingSamples);
    let off = 0;
    for (const c of t.pending) {
      all.set(c, off);
      off += c.length;
    }
    t.pending = [];
    t.pendingSamples = 0;
    return all;
  }

  private schedule(t: TurnPlayback, samples: Float32Array) {
    if (!samples.length) return;
    const buf = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.duckNode);
    const now = this.ctx.currentTime;
    const at = Math.max(now + LEAD_S, this.playhead);
    src.start(at);
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
      const i = t.sources.indexOf(src);
      if (i >= 0) t.sources.splice(i, 1);
    };
    t.sources.push(src);
    this.playhead = at + buf.duration;
    t.scheduledUntil = this.playhead;
    t.scheduledDuration += buf.duration;
    this.stats.buffers++;
    this.stats.scheduledS += buf.duration;
    if (t.startedAt === null) t.startedAt = at;
    if (!t.started) {
      t.started = true;
      // Earlier turns get no more audio: they finish when their queued audio ends.
      for (const o of this.turns.values()) if (o !== t && !o.done) o.final = true;
      this.current = t.turnId;
      this.emit('playback', t.turnId, 'started', 0);
    }
    this.setAudible(true);
  }

  /** Mark that no more audio will arrive for this turn. */
  end(turnId: string) {
    const t = this.turn(turnId);
    t.final = true;
    if (t.undecoded.length) void this.flushUndecoded(t);
    else this.drain(t);
  }

  spokenChars(turnId: string): number {
    const t = this.turns.get(turnId);
    if (!t || t.startedAt === null || t.receivedDuration <= 0) return 0;
    const played = Math.max(0, t.scheduledDuration - Math.max(0, t.scheduledUntil - this.ctx.currentTime));
    return Math.round(t.textChars * Math.min(1, played / t.receivedDuration));
  }

  isPlaying(): boolean {
    return this.audible;
  }

  get currentTurnId(): string | null {
    return this.current;
  }

  /** Stop everything immediately (short fade). Returns the turn that was audible (if any) and what was heard of it. */
  stopAll(): { turnId: string; spokenChars: number } | null {
    const now = this.ctx.currentTime;
    let result: { turnId: string; spokenChars: number } | null = null;
    let latest = -1;
    let fading = false;
    for (const t of this.turns.values()) {
      if (t.done) continue;
      if (t.started && t.startedAt !== null && t.startedAt <= now + LEAD_S && now < t.scheduledUntil) {
        fading = true;
        if (t.startedAt > latest) {
          latest = t.startedAt;
          result = { turnId: t.turnId, spokenChars: this.spokenChars(t.turnId) };
        }
      }
      if (t.started) this.finish(t, 'interrupted', now + FADE_S);
      else {
        t.done = true;
        t.pending = [];
        t.pendingSamples = 0;
        this.stopSources(t);
      }
    }
    if (fading) {
      const g = this.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(this.volume, now);
      g.linearRampToValueAtTime(0, now + FADE_S);
      g.setValueAtTime(this.volume, now + FADE_S + 0.005);
    }
    this.duck(false);
    this.playhead = 0;
    this.current = null;
    this.setAudible(false);
    return result;
  }

  private stopSources(t: TurnPlayback, at?: number) {
    for (const s of t.sources) {
      try {
        s.onended = null;
        s.stop(at ?? 0);
        if (at === undefined) s.disconnect();
        else setTimeout(() => s.disconnect(), 100);
      } catch {
        /* already stopped */
      }
    }
    t.sources = [];
  }

  private finish(t: TurnPlayback, how: 'completed' | 'interrupted', stopAt?: number) {
    if (t.done) return;
    const spoken = how === 'completed' ? t.textChars : this.spokenChars(t.turnId);
    t.done = true;
    t.pending = [];
    t.pendingSamples = 0;
    this.stopSources(t, stopAt);
    if (this.current === t.turnId) this.current = null;
    if (t.started) this.emit('playback', t.turnId, how, spoken);
  }

  private poll() {
    const now = this.ctx.currentTime;
    let anyAudible = false;
    for (const t of this.turns.values()) {
      if (t.done) continue;
      if (t.pendingSamples) this.drainLater(t);
      if (t.started && now < t.scheduledUntil) anyAudible = true;
      const idle = t.pendingDecode === 0 && t.undecoded.length === 0 && t.pendingSamples === 0;
      if (t.final && idle) {
        if (t.started && now >= t.scheduledUntil - 0.005) this.finish(t, 'completed');
        else if (!t.started) t.done = true; // nothing playable arrived
      }
    }
    this.setAudible(anyAudible);
    // Keep the map small.
    if (this.turns.size > 50) for (const [id, t] of this.turns) if (t.done) this.turns.delete(id);
  }

  /** drain() without re-entering poll() for a turn that has nothing pending. */
  private drainLater(t: TurnPlayback) {
    if (t.pendingSamples) this.drain(t);
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
      this.duckNode.disconnect();
      this.out.disconnect();
    } catch {
      /* ignore */
    }
    this.clear();
  }
}
