/**
 * Telephony audio helpers: G.711 μ-law ⇄ 16-bit PCM, resampling to 8 kHz, WAV wrapping and a small
 * energy-based voice activity detector used to cut caller utterances for server speech-to-text.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

const DECODE_TABLE = Int16Array.from({ length: 256 }, (_, i) => mulawToLinear(i));

/** μ-law bytes → Int16 PCM samples. */
export function decodeMulaw(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = DECODE_TABLE[buf[i]!]!;
  return out;
}

/** Int16 PCM samples → μ-law bytes. */
export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]!);
  return out;
}

/** Little-endian 16-bit PCM bytes → samples. */
export function pcmBytesToSamples(buf: Buffer): Int16Array {
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/**
 * Downsample by an integer-ish ratio with a box filter (averaging) — adequate anti-aliasing for
 * speech going to an 8 kHz phone line (e.g. 24 kHz TTS output → 8 kHz).
 */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = i * ratio;
    const end = Math.min(pcm.length, (i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = Math.floor(start); j < end; j++) {
      sum += pcm[j]!;
      count++;
    }
    out[i] = count ? Math.round(sum / count) : 0;
  }
  return out;
}

/** Wrap 16-bit mono PCM in a WAV container (for speech-to-text uploads). */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(pcm[i]!, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / pcm.length);
}

/** Split a μ-law buffer into 20 ms Twilio media frames (160 bytes at 8 kHz). */
export function frames(buf: Buffer, frameBytes = 160): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += frameBytes) out.push(buf.subarray(i, i + frameBytes));
  return out;
}

export interface VadOptions {
  sampleRate: number;
  /** RMS above this is voice (8 kHz telephone speech is typically 500–5000). */
  threshold: number;
  /** Consecutive voiced time before speech starts (ms). */
  startMs: number;
  /** Silence after speech that ends the utterance (ms). */
  endSilenceMs: number;
  /** Hard cap on a single utterance (ms). */
  maxUtteranceMs: number;
  /** Utterances shorter than this are discarded as noise (ms). */
  minUtteranceMs: number;
}

export type VadEvent = { type: 'speech_start' } | { type: 'speech_end'; audio: Int16Array; durationMs: number } | { type: 'discarded' };

/**
 * Streaming energy VAD. Feed PCM chunks; get speech_start / speech_end events with the utterance audio
 * (including ~200 ms of pre-roll so the first syllable is not clipped).
 */
export class EnergyVad {
  private speaking = false;
  private voicedMs = 0;
  private silenceMs = 0;
  private utterance: Int16Array[] = [];
  private utteranceMs = 0;
  private preroll: Int16Array[] = [];
  private prerollMs = 0;

  constructor(private readonly opts: VadOptions) {}

  get isSpeaking() {
    return this.speaking;
  }

  push(chunk: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    const ms = (chunk.length / this.opts.sampleRate) * 1000;
    const voiced = rms(chunk) >= this.opts.threshold;
    if (!this.speaking) {
      this.preroll.push(chunk);
      this.prerollMs += ms;
      while (this.prerollMs > 200 && this.preroll.length > 1) {
        const first = this.preroll.shift()!;
        this.prerollMs -= (first.length / this.opts.sampleRate) * 1000;
      }
      this.voicedMs = voiced ? this.voicedMs + ms : 0;
      if (this.voicedMs >= this.opts.startMs) {
        this.speaking = true;
        this.utterance = [...this.preroll];
        this.utteranceMs = this.prerollMs;
        this.preroll = [];
        this.prerollMs = 0;
        this.silenceMs = 0;
        events.push({ type: 'speech_start' });
      }
      return events;
    }
    this.utterance.push(chunk);
    this.utteranceMs += ms;
    this.silenceMs = voiced ? 0 : this.silenceMs + ms;
    if (this.silenceMs >= this.opts.endSilenceMs || this.utteranceMs >= this.opts.maxUtteranceMs) {
      events.push(this.finish());
    }
    return events;
  }

  /** Force the end of the current utterance (e.g. call ended). */
  flush(): VadEvent | null {
    return this.speaking ? this.finish() : null;
  }

  private finish(): VadEvent {
    const total = this.utterance.reduce((a, c) => a + c.length, 0);
    const audio = new Int16Array(total);
    let o = 0;
    for (const c of this.utterance) {
      audio.set(c, o);
      o += c.length;
    }
    const durationMs = this.utteranceMs;
    const speechMs = durationMs - this.silenceMs;
    this.speaking = false;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.utterance = [];
    this.utteranceMs = 0;
    if (speechMs < this.opts.minUtteranceMs) return { type: 'discarded' };
    return { type: 'speech_end', audio, durationMs };
  }
}
