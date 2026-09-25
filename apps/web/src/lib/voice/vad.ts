/**
 * Energy-based voice activity detection on a mic stream (WebAudio AnalyserNode).
 *
 * - The noise floor adapts: while nobody speaks we track a slow average of RMS energy.
 * - Speech starts once energy stays above `floor × ratio` (and an absolute minimum) for `startMs`.
 * - While agent audio is playing we raise the bar (echo leaks into the mic even with AEC) and require
 *   sustained energy for `bargeInMs` (~300 ms), so the agent's own voice does not trigger barge-in.
 */

export interface VadOptions {
  /** ms of sustained energy before "speech started" (normal). */
  startMs?: number;
  /** ms of sustained energy before "speech started" while the agent is audible. */
  bargeInMs?: number;
  /** ms below threshold before "speech ended". */
  hangoverMs?: number;
  /** Threshold multiplier over the noise floor. */
  ratio?: number;
  /** Extra multiplier while the agent is speaking. */
  agentRatio?: number;
  /** Absolute RMS minimum (0..1) to count as speech. */
  minRms?: number;
  intervalMs?: number;
}

export interface VadCallbacks {
  onSpeechStart?: (info: { duringAgent: boolean }) => void;
  onSpeechEnd?: () => void;
  onLevel?: (level: number) => void;
}

export function computeRms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

/** Pure state machine so the thresholds can be unit-tested. */
export class VadState {
  floor = 0.004;
  private above = 0;
  private below = 0;
  speaking = false;
  agentPlaying = false;
  private agentFloor = 0;
  readonly o: Required<Omit<VadOptions, 'intervalMs'>>;

  constructor(opts: VadOptions = {}) {
    this.o = {
      startMs: opts.startMs ?? 150,
      bargeInMs: opts.bargeInMs ?? 300,
      hangoverMs: opts.hangoverMs ?? 450,
      ratio: opts.ratio ?? 3,
      agentRatio: opts.agentRatio ?? 2.2,
      minRms: opts.minRms ?? 0.012,
    };
  }

  threshold(): number {
    const base = Math.max(this.o.minRms, this.floor * this.o.ratio);
    if (!this.agentPlaying) return base;
    // While the agent talks, the echo sets a higher floor.
    return Math.max(base * this.o.agentRatio, this.agentFloor * this.o.ratio);
  }

  /** Feed one RMS sample observed `dtMs` after the previous one. Returns an edge if one occurred. */
  step(rms: number, dtMs: number): 'start' | 'end' | null {
    const th = this.threshold();
    if (!this.speaking) {
      if (this.agentPlaying) this.agentFloor = this.agentFloor * 0.97 + rms * 0.03;
      else this.floor = Math.min(0.2, Math.max(0.0005, this.floor * 0.98 + rms * 0.02));
    }
    if (rms > th) {
      this.above += dtMs;
      this.below = 0;
      const need = this.agentPlaying ? this.o.bargeInMs : this.o.startMs;
      if (!this.speaking && this.above >= need) {
        this.speaking = true;
        return 'start';
      }
    } else {
      this.below += dtMs;
      if (this.below > 60) this.above = 0;
      if (this.speaking && this.below >= this.o.hangoverMs) {
        this.speaking = false;
        return 'end';
      }
    }
    return null;
  }

  setAgentPlaying(p: boolean) {
    if (p && !this.agentPlaying) this.agentFloor = this.floor * 2;
    this.agentPlaying = p;
  }
}

export class EnergyVad {
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private last = 0;
  readonly state: VadState;
  private enabled = true;

  constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    private cb: VadCallbacks,
    private opts: VadOptions = {},
  ) {
    this.state = new VadState(opts);
  }

  start() {
    if (this.timer) return;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.buf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 30);
  }

  /** When disabled (muted/paused), levels read as 0 and an ongoing "speech" ends. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled && this.state.speaking) {
      this.state.speaking = false;
      this.cb.onSpeechEnd?.();
    }
  }

  setAgentPlaying(playing: boolean) {
    this.state.setAgentPlaying(playing);
  }

  get speaking() {
    return this.state.speaking;
  }

  private tick() {
    if (!this.analyser || !this.buf) return;
    const now = performance.now();
    const dt = Math.min(200, now - this.last);
    this.last = now;
    if (!this.enabled) {
      this.cb.onLevel?.(0);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.buf);
    const rms = computeRms(this.buf);
    this.cb.onLevel?.(Math.min(1, rms * 6));
    const wasAgent = this.state.agentPlaying;
    const edge = this.state.step(rms, dt);
    if (edge === 'start') this.cb.onSpeechStart?.({ duringAgent: wasAgent });
    else if (edge === 'end') this.cb.onSpeechEnd?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.analyser = null;
  }
}
