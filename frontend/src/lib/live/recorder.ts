/**
 * Call recording: MediaRecorder over a WebAudio mix of the participant's mic and (when played through
 * WebAudio: server TTS or the OpenAI Realtime remote track) the agent's voice, plus the camera when
 * video recording is consented. 5 s timeslices are uploaded as numbered parts with retry/backoff;
 * part numbers are idempotent so a retried PUT never duplicates data.
 *
 * Browser speechSynthesis output cannot be captured, so in browser-speech mode the recording only
 * contains the participant's side (the transcript has both).
 */

import { ApiError, completeRecording, completeRecordingUrl, createRecording, putRecordingPart } from './runtime-api';

export const RECORDING_TIMESLICE_MS = 5000;
const MAX_PART_ATTEMPTS = 8;

export function pickRecordingMime(video: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = video
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of candidates) if (MediaRecorder.isTypeSupported?.(c)) return c;
  return null;
}

export interface RecorderCallbacks {
  onRecording?: (recording: boolean) => void;
  onError?: (message: string) => void;
  onProgress?: (info: { uploaded: number; pending: number; bytes: number }) => void;
}

export class CallRecorder {
  readonly sink: MediaStreamAudioDestinationNode;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private assetId: string | null = null;
  private partNo = 0;
  private queue: Array<{ n: number; blob: Blob }> = [];
  private uploading = false;
  private uploaded = 0;
  private bytes = 0;
  private startedAt = 0;
  private pausedMs = 0;
  private pausedAt: number | null = null;
  private stopped = false;
  private completed = false;
  private drainWaiters: Array<() => void> = [];
  private failedParts = 0;

  constructor(
    private readonly o: {
      sessionId: string;
      token: string;
      ctx: AudioContext;
      micStream: MediaStream;
      cameraStream?: MediaStream | null;
      video: boolean;
    },
    private readonly cb: RecorderCallbacks = {},
  ) {
    this.sink = o.ctx.createMediaStreamDestination();
  }

  get kind(): 'audio' | 'video' {
    return this.o.video && this.o.cameraStream?.getVideoTracks().length ? 'video' : 'audio';
  }

  /** start() was called (successfully or not). */
  started = false;

  get isRecording() {
    return this.recorder?.state === 'recording';
  }

  get id() {
    return this.assetId;
  }

  async start(): Promise<boolean> {
    if (this.started) return !!this.recorder;
    this.started = true;
    const video = this.kind === 'video';
    const mime = pickRecordingMime(video);
    if (!mime) {
      this.cb.onError?.('Recording is not supported in this browser; the call continues without a recording.');
      return false;
    }
    this.micSource = this.o.ctx.createMediaStreamSource(this.o.micStream);
    this.micSource.connect(this.sink);
    const tracks = [...this.sink.stream.getAudioTracks()];
    if (video) tracks.push(...this.o.cameraStream!.getVideoTracks());
    const stream = new MediaStream(tracks);
    try {
      const { assetId } = await createRecording(this.o.sessionId, this.o.token, {
        kind: video ? 'video' : 'audio',
        mimeType: mime.split(';')[0]!,
      });
      this.assetId = assetId;
    } catch (e) {
      this.cb.onError?.(
        e instanceof ApiError && e.status === 403
          ? 'Recording is not allowed for this session.'
          : 'The recording could not be started; the call continues without a recording.',
      );
      return false;
    }
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000, ...(video ? { videoBitsPerSecond: 600000 } : {}) });
    this.recorder = rec;
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      this.enqueue(e.data);
    };
    rec.onstart = () => this.cb.onRecording?.(true);
    rec.onresume = () => this.cb.onRecording?.(true);
    rec.onpause = () => this.cb.onRecording?.(false);
    rec.onstop = () => this.cb.onRecording?.(false);
    rec.onerror = () => {
      this.cb.onRecording?.(false);
      this.cb.onError?.('Recording stopped unexpectedly.');
    };
    this.startedAt = Date.now();
    rec.start(RECORDING_TIMESLICE_MS);
    return true;
  }

  private enqueue(blob: Blob) {
    this.partNo += 1;
    this.bytes += blob.size;
    this.queue.push({ n: this.partNo, blob });
    void this.pump();
  }

  private async pump() {
    if (this.uploading) return;
    this.uploading = true;
    try {
      while (this.queue.length && this.assetId) {
        const part = this.queue[0]!;
        const ok = await this.uploadWithRetry(part.n, part.blob);
        this.queue.shift();
        if (ok) this.uploaded++;
        else this.failedParts++;
        this.cb.onProgress?.({ uploaded: this.uploaded, pending: this.queue.length, bytes: this.bytes });
      }
    } finally {
      this.uploading = false;
      if (!this.queue.length) {
        const w = this.drainWaiters;
        this.drainWaiters = [];
        w.forEach((f) => f());
      }
    }
  }

  private async uploadWithRetry(n: number, blob: Blob): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
      try {
        await putRecordingPart(this.o.sessionId, this.o.token, this.assetId!, n, blob);
        return true;
      } catch (e) {
        // Client errors other than timeouts/rate limits/conflicts will not succeed on retry.
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![408, 409, 425, 429].includes(e.status)) {
          if (e.status === 409) return true; // already stored
          this.cb.onError?.(`A recording segment was rejected (${e.message}).`);
          return false;
        }
        const delay = Math.min(15000, 500 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.cb.onError?.('Part of the recording could not be uploaded (network).');
    return false;
  }

  pause() {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.pausedAt = Date.now();
    }
  }

  resume() {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      if (this.pausedAt) this.pausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }

  private durationMs() {
    if (!this.startedAt) return 0;
    const paused = this.pausedMs + (this.pausedAt ? Date.now() - this.pausedAt : 0);
    return Math.max(0, Date.now() - this.startedAt - paused);
  }

  /** Stop, flush remaining parts and mark the asset complete. */
  async stop(timeoutMs = 30000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const rec = this.recorder;
    const durationMs = this.durationMs();
    if (rec && rec.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        rec.addEventListener('stop', done, { once: true });
        try {
          rec.stop();
        } catch {
          resolve();
        }
        setTimeout(done, 3000);
      });
    }
    this.detach();
    if (!this.assetId) return;
    // Wait (bounded) for the upload queue to drain.
    await new Promise<void>((resolve) => {
      if (!this.queue.length && !this.uploading) return resolve();
      this.drainWaiters.push(resolve);
      setTimeout(resolve, timeoutMs);
    });
    if (this.completed) return;
    this.completed = true;
    try {
      await completeRecording(this.o.sessionId, this.o.token, this.assetId, { durationMs });
    } catch {
      this.cb.onError?.('The recording could not be finalized.');
    }
  }

  /**
   * Page is going away: best-effort flush with `keepalive` fetches (≤64 KB bodies are guaranteed to be
   * attempted by the browser), then `complete`.
   */
  stopOnUnload() {
    if (this.completed || !this.assetId) return;
    this.completed = true;
    this.stopped = true;
    try {
      if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    } catch {
      /* ignore */
    }
    const headers = { Authorization: `Bearer ${this.o.token}` };
    let budget = 60 * 1024;
    for (const part of this.queue) {
      if (part.blob.size > budget) break;
      budget -= part.blob.size;
      void fetch(`/api/runtime/sessions/${encodeURIComponent(this.o.sessionId)}/recordings/${encodeURIComponent(this.assetId)}/parts/${part.n}`, {
        method: 'PUT',
        body: part.blob,
        headers: { ...headers, 'Content-Type': part.blob.type.split(';')[0] || 'application/octet-stream' },
        keepalive: true,
      }).catch(() => undefined);
    }
    void fetch(completeRecordingUrl(this.o.sessionId, this.assetId), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMs: Math.round(this.durationMs()) }),
      keepalive: true,
    }).catch(() => undefined);
    this.detach();
  }

  private detach() {
    try {
      this.micSource?.disconnect();
    } catch {
      /* ignore */
    }
    this.micSource = null;
  }
}
