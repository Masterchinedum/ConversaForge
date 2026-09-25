/**
 * Raw PCM capture from the mic with a short pre-roll ring buffer, encoded to 16 kHz mono WAV.
 * Used by the server STT pipeline: VAD decides when an utterance segment starts/ends, and the pre-roll
 * keeps the first syllable that the VAD needed to detect speech.
 */

export class PcmCapture {
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  private recording: Float32Array[] | null = null;
  private readonly maxPreroll: number;

  constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    prerollMs = 450,
  ) {
    this.maxPreroll = Math.round((ctx.sampleRate * prerollMs) / 1000);
  }

  start() {
    if (this.node) return;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but universally available and needs no worklet module file.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      if (this.recording) this.recording.push(data);
      else {
        this.preroll.push(data);
        this.prerollSamples += data.length;
        while (this.prerollSamples - (this.preroll[0]?.length ?? 0) > this.maxPreroll) {
          this.prerollSamples -= this.preroll.shift()!.length;
        }
      }
    };
    // Must be connected to run; route through a muted gain so nothing is audible.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
  }

  get isRecording() {
    return this.recording !== null;
  }

  beginSegment() {
    if (this.recording) return;
    this.recording = [...this.preroll];
    this.preroll = [];
    this.prerollSamples = 0;
  }

  /** Finish the current segment and return it as WAV (null if nothing was captured). */
  endSegment(): { wav: Blob; durationMs: number } | null {
    const chunks = this.recording;
    this.recording = null;
    if (!chunks || !chunks.length) return null;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    const durationMs = (total / this.ctx.sampleRate) * 1000;
    return { wav: encodeWav(downsample(pcm, this.ctx.sampleRate, 16000), 16000), durationMs };
  }

  cancelSegment() {
    this.recording = null;
  }

  stop() {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* ignore */
    }
    if (this.node) this.node.onaudioprocess = null;
    this.node = null;
    this.source = null;
    this.sink = null;
    this.recording = null;
  }
}

export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
