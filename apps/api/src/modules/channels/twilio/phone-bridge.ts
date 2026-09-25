import type { ClientMessage, ServerMessage } from '@cf/shared';
import { decodeMulaw, EnergyVad, encodeMulaw, frames, pcmBytesToSamples, pcmToWav, resample } from '../audio/audio';

/**
 * Bridges one Twilio Media Stream (μ-law 8 kHz, bidirectional) to a session engine:
 *
 *   caller audio → energy VAD → server STT → participant.final ─┐
 *                                                                ├─ EngineConnection (workstream B)
 *   Twilio media ← μ-law ← server TTS (per sentence) ← agent.delta/end
 *
 * Barge-in: caller speech while agent audio is playing → Twilio `clear` + agent.playback interrupted.
 * Playback tracking: a Twilio `mark` after each agent turn → agent.playback completed.
 * Everything here is real audio processing; if speech providers are missing the call is failed
 * with provider_unavailable before the bridge starts.
 */

export interface SpeechStt {
  transcribe(audio: Buffer, mimeType: string, opts: { language?: string }): Promise<{ text: string; confidence: number | null; durationSec: number; provider: string; model: string }>;
}
export interface SpeechTts {
  readonly id: 'openai' | 'elevenlabs';
  synthesize(text: string, opts: { voice?: string; speed?: number; format?: 'mp3' | 'pcm' | 'ulaw' }): Promise<{ audio: Buffer; mimeType: string; characters: number; provider: string; model: string }>;
}

export interface EngineConnectionLike {
  receive(msg: ClientMessage): void;
  detach(reason?: string): void;
}

export interface BridgeSetup {
  sessionId: string;
  workspaceId: string;
  language: string;
  voice: { voiceId: string; speed: number };
  allowBargeIn: boolean;
  endOfTurnSilenceMs: number;
  transferEnabled: boolean;
  stt: SpeechStt;
  tts: SpeechTts;
}

export interface BridgeHooks {
  /** Send a JSON message to Twilio over the media-stream socket. */
  toTwilio(msg: Record<string, unknown>): void;
  /** Close the media-stream socket (ends <Connect>; the call hangs up since no TwiML follows). */
  closeSocket(reason: string): void;
  recordUsage(kind: 'STT_SECONDS' | 'TTS_CHARACTERS', provider: string, model: string, quantity: number, key: string): void;
  onTransferRequested(): void;
  /** The caller hung up (stream stopped) while the session was still live. */
  onCallerHangup(): void;
  log(level: 'log' | 'warn' | 'error', msg: string): void;
}

const MARK_PREFIX = 't:';
const MAX_SEGMENT_CHARS = 280;

export function splitSentences(buffer: string, final: boolean): { segments: string[]; rest: string } {
  const segments: string[] = [];
  let rest = buffer;
  const re = /[.!?…]+["')\]]*\s+|\n+/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    const end = m.index + m[0].length;
    const seg = rest.slice(lastIdx, end).trim();
    if (seg) segments.push(seg);
    lastIdx = end;
  }
  rest = rest.slice(lastIdx);
  // Very long run without punctuation: cut at the last comma/space to keep latency bounded.
  while (rest.length > MAX_SEGMENT_CHARS) {
    const cut = Math.max(rest.lastIndexOf(', ', MAX_SEGMENT_CHARS), rest.lastIndexOf(' ', MAX_SEGMENT_CHARS));
    const at = cut > 40 ? cut + 1 : MAX_SEGMENT_CHARS;
    segments.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (final && rest.trim()) {
    segments.push(rest.trim());
    rest = '';
  }
  return { segments: segments.filter(Boolean), rest };
}

interface TurnPlayback {
  turnId: string;
  text: string;
  pending: string;
  charsQueued: number;
  charsSent: number;
  audioMs: number;
  startedAt: number | null;
  ended: boolean;
  interrupted: boolean;
  chain: Promise<void>;
  seg: number;
}

export class PhoneBridge {
  private conn: EngineConnectionLike | null = null;
  private streamSid: string | null = null;
  private readonly vad: EnergyVad;
  private sttChain: Promise<void> = Promise.resolve();
  private utteranceNo = 0;
  private turn: TurnPlayback | null = null;
  private readonly pendingMarks = new Set<string>();
  private ending = false;
  private stopped = false;
  private endTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly setup: BridgeSetup,
    private readonly hooks: BridgeHooks,
  ) {
    this.vad = new EnergyVad({
      sampleRate: 8000,
      threshold: 700,
      startMs: 120,
      endSilenceMs: Math.min(3000, Math.max(500, setup.endOfTurnSilenceMs)),
      maxUtteranceMs: 30_000,
      minUtteranceMs: 250,
    });
  }

  /** Engine-facing transport. */
  readonly transport = {
    kind: 'phone',
    send: (msg: ServerMessage) => this.onEngineMessage(msg),
    close: (_code: number, reason: string) => this.finishCall(reason),
  };

  bind(conn: EngineConnectionLike, streamSid: string) {
    this.conn = conn;
    this.streamSid = streamSid;
    conn.receive({ type: 'start' });
  }

  /** Agent audio has actually started playing for the current turn and has not finished. */
  get isPlaying() {
    const t = this.turn;
    if (!t || t.interrupted || t.startedAt === null) return false;
    return this.pendingMarks.size > 0 || !t.ended || t.charsQueued > t.charsSent;
  }

  // ───────────── Twilio → engine ─────────────

  onTwilioMedia(payloadB64: string) {
    if (!this.conn || this.stopped) return;
    const pcm = decodeMulaw(Buffer.from(payloadB64, 'base64'));
    for (const ev of this.vad.push(pcm)) {
      if (ev.type === 'speech_start') {
        this.conn.receive({ type: 'participant.speaking', speaking: true });
        if (this.setup.allowBargeIn && this.isPlaying) this.bargeIn();
      } else if (ev.type === 'speech_end') {
        this.conn.receive({ type: 'participant.speaking', speaking: false });
        this.transcribe(ev.audio);
      } else {
        this.conn.receive({ type: 'participant.speaking', speaking: false });
      }
    }
  }

  onTwilioMark(name: string) {
    if (!name.startsWith(MARK_PREFIX)) return;
    this.pendingMarks.delete(name);
    const turnId = name.slice(MARK_PREFIX.length);
    this.conn?.receive({ type: 'agent.playback', turnId, event: 'completed' });
    if (this.ending && this.pendingMarks.size === 0) this.finishCall('agent ended the call');
  }

  onTwilioDtmf(digit: string) {
    if (digit === '0' && this.setup.transferEnabled && !this.ending) {
      this.hooks.log('log', `Caller pressed 0 on ${this.setup.sessionId}: transferring`);
      this.hooks.onTransferRequested();
    }
  }

  /** Twilio `stop` or socket closed. */
  async onTwilioStop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    const last = this.vad.flush();
    if (last?.type === 'speech_end') this.transcribe(last.audio);
    await this.sttChain.catch(() => undefined);
    if (this.endTimer) clearTimeout(this.endTimer);
    const conn = this.conn;
    this.conn = null;
    conn?.detach(reason);
    if (!this.ending) this.hooks.onCallerHangup();
  }

  private transcribe(audio: Int16Array) {
    const n = ++this.utteranceNo;
    const wav = pcmToWav(audio, 8000);
    this.sttChain = this.sttChain.then(async () => {
      try {
        const r = await this.setup.stt.transcribe(wav, 'audio/wav', { language: this.setup.language });
        this.hooks.recordUsage('STT_SECONDS', r.provider, r.model, r.durationSec, `phone:${this.setup.sessionId}:stt:${n}`);
        const text = r.text.trim();
        if (!text || !this.conn) return;
        this.conn.receive({
          type: 'participant.final',
          clientTurnId: `ph_${this.setup.sessionId}_${n}`,
          text: text.slice(0, 4000),
          confidence: r.confidence ?? undefined,
          source: 'server_stt',
        });
      } catch (e: any) {
        this.hooks.log('warn', `STT failed for ${this.setup.sessionId}#${n}: ${e?.message}`);
      }
    }).catch(() => undefined);
  }

  private bargeIn() {
    const t = this.turn;
    if (!t || t.interrupted) return;
    t.interrupted = true;
    this.toTwilio({ event: 'clear', streamSid: this.streamSid });
    for (const m of [...this.pendingMarks]) this.pendingMarks.delete(m);
    const elapsed = t.startedAt ? Date.now() - t.startedAt : 0;
    const spokenChars = t.audioMs > 0 ? Math.min(t.charsSent, Math.round((elapsed / t.audioMs) * t.charsSent)) : 0;
    this.conn?.receive({ type: 'agent.playback', turnId: t.turnId, event: 'interrupted', spokenChars });
  }

  // ───────────── engine → Twilio ─────────────

  private onEngineMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'agent.start':
        this.turn = { turnId: msg.turnId, text: '', pending: '', charsQueued: 0, charsSent: 0, audioMs: 0, startedAt: null, ended: false, interrupted: false, chain: Promise.resolve(), seg: 0 };
        return;
      case 'agent.delta': {
        const t = this.ensureTurn(msg.turnId);
        t.text += msg.text;
        t.pending += msg.text;
        const { segments, rest } = splitSentences(t.pending, false);
        t.pending = rest;
        for (const s of segments) this.speak(t, s);
        return;
      }
      case 'agent.end': {
        const t = this.ensureTurn(msg.turnId);
        if (!t.text && msg.text) t.pending = msg.text; // non-streamed turn (scripted/simulator)
        else if (msg.text && msg.text.length > t.text.length && msg.text.startsWith(t.text)) t.pending += msg.text.slice(t.text.length);
        t.text = msg.text || t.text;
        const { segments } = splitSentences(t.pending, true);
        t.pending = '';
        for (const s of segments) this.speak(t, s);
        t.ended = true;
        t.chain = t.chain.then(() => {
          if (t.interrupted || msg.interrupted) return;
          if (t.audioMs === 0) {
            // Nothing was played (empty text or TTS failure): don't make the engine wait for a mark.
            this.conn?.receive({ type: 'agent.playback', turnId: t.turnId, event: 'completed' });
            if (this.ending && this.pendingMarks.size === 0) this.finishCall('agent ended the call');
            return;
          }
          const mark = `${MARK_PREFIX}${t.turnId}`;
          this.pendingMarks.add(mark);
          this.toTwilio({ event: 'mark', streamSid: this.streamSid, mark: { name: mark } });
        }).catch((e) => this.hooks.log('error', `Mark failed for ${this.setup.sessionId}: ${e?.message ?? e}`));
        return;
      }
      case 'agent.cancel': {
        if (this.turn?.turnId === msg.turnId && !this.turn.interrupted) {
          this.turn.interrupted = true;
          this.toTwilio({ event: 'clear', streamSid: this.streamSid });
          this.pendingMarks.clear();
        }
        return;
      }
      case 'end':
        this.ending = true;
        // Let queued audio finish (mark), but never keep the line open for more than ~20 s.
        void (this.turn?.chain ?? Promise.resolve()).then(() => {
          if (this.pendingMarks.size === 0) this.finishCall(`ended: ${msg.reason}`);
        });
        this.endTimer = setTimeout(() => this.finishCall('end timeout'), 20_000);
        return;
      case 'error':
        if (msg.fatal) this.finishCall(`fatal: ${msg.code}`);
        return;
      default:
        // welcome/state/timer/tool UI messages have no phone representation.
        return;
    }
  }

  private ensureTurn(turnId: string): TurnPlayback {
    if (!this.turn || this.turn.turnId !== turnId) {
      this.turn = { turnId, text: '', pending: '', charsQueued: 0, charsSent: 0, audioMs: 0, startedAt: null, ended: false, interrupted: false, chain: Promise.resolve(), seg: 0 };
    }
    return this.turn;
  }

  private speak(t: TurnPlayback, text: string) {
    const seg = ++t.seg;
    t.charsQueued += text.length;
    const synth = this.synthesize(text); // start synthesis now, play in order
    synth.catch(() => undefined); // handled when awaited below; avoid an unhandled rejection meanwhile
    t.chain = t.chain.then(async () => {
      let mulaw: Buffer | null = null;
      try {
        const r = await synth;
        mulaw = r.mulaw;
        this.hooks.recordUsage('TTS_CHARACTERS', r.provider, r.model, text.length, `phone:${this.setup.sessionId}:tts:${t.turnId}:${seg}`);
      } catch (e: any) {
        this.hooks.log('warn', `TTS failed for ${this.setup.sessionId}: ${e?.message}`);
      }
      if (!mulaw || t.interrupted || this.stopped) return;
      if (t.startedAt === null) {
        t.startedAt = Date.now();
        this.conn?.receive({ type: 'agent.playback', turnId: t.turnId, event: 'started' });
      }
      for (const f of frames(mulaw)) this.toTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: f.toString('base64') } });
      t.audioMs += (mulaw.length / 8000) * 1000;
      t.charsSent += text.length;
    }).catch((e) => this.hooks.log('error', `Playback failed for ${this.setup.sessionId}: ${e?.message ?? e}`));
  }

  private async synthesize(text: string): Promise<{ mulaw: Buffer; provider: string; model: string }> {
    const tts = this.setup.tts;
    if (tts.id === 'elevenlabs') {
      const r = await tts.synthesize(text, { voice: this.setup.voice.voiceId, speed: this.setup.voice.speed, format: 'ulaw' });
      return { mulaw: r.audio, provider: r.provider, model: r.model };
    }
    // OpenAI "pcm" = 24 kHz 16-bit little-endian mono.
    const r = await tts.synthesize(text, { voice: this.setup.voice.voiceId, speed: this.setup.voice.speed, format: 'pcm' });
    const pcm = resample(pcmBytesToSamples(r.audio), 24_000, 8000);
    return { mulaw: encodeMulaw(pcm), provider: r.provider, model: r.model };
  }

  private toTwilio(msg: Record<string, unknown>) {
    if (!this.streamSid || this.stopped) return;
    this.hooks.toTwilio(msg);
  }

  private finishCall(reason: string) {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.ending = true;
    this.hooks.closeSocket(reason);
  }
}
