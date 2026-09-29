/**
 * GeminiLiveAdapter — speech-to-speech with the Google Gemini Live API, straight from the browser.
 *
 * Flow (verified against @google/genai 2.24.0 type declarations + the js-genai `live_ephemeral.ts` sample):
 *   1. Our server mints a single-use ephemeral token (`ai.authTokens.create`, v1alpha) with the whole Live
 *      setup locked in (compiled instructions, tools, voice, transcription, VAD, barge-in) →
 *      `POST …/realtime-token` returns `{ provider:'google', token:'auth_tokens/…', model, connectConfig }`.
 *      The real API key and the prompt never reach the browser.
 *   2. `new GoogleGenAI({ apiKey: token, apiVersion: 'v1alpha' }).live.connect({ model, config, callbacks })`
 *      — the SDK opens `wss://generativelanguage.googleapis.com/ws/…BidiGenerateContentConstrained?access_token=…`.
 *   3. Mic → PCM16 mono 16 kHz base64 → `sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } })`.
 *      While the agent is audible the mic is gated (see MicGate): through speakers the agent's own voice
 *      would come back as an "interruption". The local energy VAD (raised threshold while the agent plays)
 *      opens the gate when the participant really talks, sending the pre-roll first; the agent is ducked
 *      and, if the participant keeps talking over an already finished turn, cut.
 *      Model audio arrives as `serverContent.modelTurn.parts[].inlineData` (PCM16 24 kHz) and plays through a
 *      WebAudio queue with a small jitter buffer (gapless, instant stop, mixed into the call recording).
 *   4. `serverContent.inputTranscription` / `outputTranscription` → transcripts mirrored to our server as
 *      `realtime.transcript` (stable item ids, exactly once); `interrupted` → barge-in (playback stops, the
 *      agent turn is reported interrupted with an estimate of what was heard); `turnComplete` ends a turn.
 *   5. `toolCall.functionCalls` → `realtime.tool_call`; the server executes/authorizes the tool and returns
 *      `realtime.tool_result`, sent back with `sendToolResponse({ functionResponses })`.
 *   6. `realtime.instruction` (opening line, nudges, wrap-up, closing) → a client-content text turn. Client
 *      content interrupts whatever the model is generating, so instructions wait until the model is idle:
 *      not generating or expected to, its audio finished playing, and the participant not mid-sentence.
 *   7. `sessionResumptionUpdate` handles + `goAway` → reconnect with a fresh token that resumes the session;
 *      without a handle, a fresh session whose instructions carry the transcript so far.
 */

import type { LiveServerMessage, Session } from '@google/genai';
import { fetchGeminiToken, type GeminiLiveCredentials } from '../live/runtime-api';
import { AudioPlayer, base64ToBytes } from './audio-player';
import { MicGate } from './mic-gate';
import { downsample } from './pcm-capture';
import { Emitter, type VoiceClient, type VoiceClientOptions, type VoiceEvents } from './types';
import { EnergyVad } from './vad';

export const GEMINI_INPUT_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RECONNECTS = 3;
/** After the model starts answering, late input-transcription chunks are still merged for this long. */
const USER_FINALIZE_GRACE_MS = 1200;
/** A participant utterance that never gets an answer is committed after this much transcription silence. */
const USER_IDLE_FINALIZE_MS = 3500;
/** The mic stays gated this long after the agent's audio ends (room reverb, echo-canceller tail). */
const GATE_HANGOVER_MS = 300;
/** Pre-roll kept while gated (100 ms chunks): what the VAD needed before it was sure the participant spoke. */
const PREROLL_CHUNKS = 5;
/** Client content (instructions) waits this long after the participant's last transcribed words. */
const INPUT_SETTLE_MS = 2500;
/** A response we asked for that never starts stops holding instructions after this. */
const RESPONSE_WAIT_MS = 8000;
/** While busy for reasons that end with an event, re-check the instruction queue at this interval. */
const BUSY_RECHECK_MS = 250;
/** Sustained participant speech over the tail of an agent turn cuts the playback after this. */
const TAIL_CUT_MS = 1200;
const INSTRUCTION_PREFIX = '[Session runtime instruction — not said by the participant. Follow it; never read it aloud.]';

export function hasGeminiLiveSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    (typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined')
  );
}

/** Float32 [-1,1] → little-endian PCM16 → base64. */
export function floatToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Gemini's transcriptions can carry placeholder tokens for non-speech (`<no speech>`, `{pause}`, `<noise>`,
 * `[silence]`) and interrupted fragments that are only punctuation ("..."). Neither is something anyone
 * said: strip the tokens, and treat text without a letter or digit as empty.
 */
export function cleanTranscript(text: string): string {
  const cleaned = text
    .replace(/<[^<>\n]{1,40}>/g, ' ')
    .replace(/\{[^{}\n]{1,40}\}/g, ' ')
    .replace(/\[[^\]\n]{1,40}\]/g, ' ')
    // A token still arriving in pieces ("<no" … " speech>"): hide the open part until it is complete.
    .replace(/[<{[][^<>{}[\]\n]{0,40}$/, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : '';
}

/** Cut text to about `chars`, at a word boundary (what the participant actually heard). */
export function heardText(text: string, chars: number): string {
  if (chars >= text.length) return text;
  const cut = text.slice(0, Math.max(0, chars));
  const i = cut.lastIndexOf(' ');
  return (i > 0 ? cut.slice(0, i) : cut).trim();
}

const WORKLET = `
class CfPcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('cf-pcm-tap', CfPcmTap);
`;

/**
 * Streams the microphone as ~100 ms PCM16 16 kHz chunks. AudioWorklet when available (off the main
 * thread), ScriptProcessor otherwise. Routed through a muted gain so nothing is audible.
 */
class MicStreamer {
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private sink: GainNode | null = null;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private readonly chunkSamples: number;

  constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    private onChunk: (b64: string) => void,
  ) {
    this.chunkSamples = Math.round(ctx.sampleRate / 10);
  }

  async start() {
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
    let node: AudioNode | null = null;
    if (typeof AudioWorkletNode !== 'undefined' && this.ctx.audioWorklet) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        try {
          // Some browsers never settle addModule (e.g. blocked blob: modules); don't hang the call on it.
          await Promise.race([
            this.ctx.audioWorklet.addModule(url),
            new Promise((_, reject) => setTimeout(() => reject(new Error('audioWorklet timeout')), 2000)),
          ]);
        } finally {
          URL.revokeObjectURL(url);
        }
        const w = new AudioWorkletNode(this.ctx, 'cf-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        w.port.onmessage = (e) => this.push(e.data as Float32Array);
        node = w;
      } catch (e) {
        node = null; // CSP, old browser, or a worklet thread that never starts → ScriptProcessor
        console.warn('[gemini-live] audio worklet unavailable; capturing with ScriptProcessor', e);
      }
    }
    if (!node) {
      const sp = this.ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => this.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      node = sp;
    }
    this.node = node;
    this.source.connect(node);
    node.connect(this.sink);
  }

  private push(data: Float32Array) {
    this.pending.push(data);
    this.pendingLen += data.length;
    if (this.pendingLen < this.chunkSamples) return;
    const all = new Float32Array(this.pendingLen);
    let off = 0;
    for (const c of this.pending) {
      all.set(c, off);
      off += c.length;
    }
    // Send whole 100 ms chunks; keep the remainder for the next one.
    let start = 0;
    for (; start + this.chunkSamples <= all.length; start += this.chunkSamples) {
      this.onChunk(floatToPcm16Base64(downsample(all.subarray(start, start + this.chunkSamples), this.ctx.sampleRate, GEMINI_INPUT_RATE)));
    }
    const rest = all.slice(start);
    this.pending = rest.length ? [rest] : [];
    this.pendingLen = rest.length;
  }

  stop() {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* ignore */
    }
    if (this.node instanceof ScriptProcessorNode) this.node.onaudioprocess = null;
    else if (this.node && 'port' in this.node) (this.node as AudioWorkletNode).port.onmessage = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.pending = [];
    this.pendingLen = 0;
  }
}

interface Item {
  id: string;
  text: string;
  timer?: ReturnType<typeof setTimeout>;
  /** The model has started answering this utterance (later chunks are still merged for a short grace). */
  answered?: boolean;
  /** A (non-empty) caption/row for this item has been shown. */
  shown?: boolean;
}

interface AgentItem extends Item {
  /** Chars heard when playback was stopped locally (pause / typing / talked over); the turn is reported interrupted. */
  cutAt?: number;
  audio: boolean;
}

export class GeminiLiveAdapter extends Emitter<VoiceEvents> implements VoiceClient {
  readonly mode = 'realtime' as const;
  readonly label = 'Google Gemini Live';
  readonly listens = true;
  readonly speaks = true;

  private session: Session | null = null;
  /** Increments per Live connection; events from older connections are ignored. */
  private gen = 0;
  private connId = '';
  private seq = 0;
  private ready = false;
  private player: AudioPlayer | null = null;
  private mic: MicStreamer | null = null;
  private vad: EnergyVad | null = null;
  private gate = new MicGate(PREROLL_CHUNKS);
  private gateTimer: ReturnType<typeof setTimeout> | null = null;
  private userSpeaking = false;
  private user: Item | null = null;
  private agent: AgentItem | null = null;
  /** The last reported agent turn (its audio may still be playing). */
  private lastAgent: { id: string; text: string } | null = null;
  private reported = new Set<string>();
  private generating = false;
  /** We asked the model for a response (client content / tool results): hold instructions until it starts. */
  private awaitingResponseUntil = 0;
  private lastInputAt = 0;
  private instructions: Array<{ text: string; respond: boolean }> = [];
  private instructionTimer: ReturnType<typeof setTimeout> | null = null;
  private tailCutTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCalls = new Map<string, string>();
  private seenCalls = new Set<string>();
  private responses: Array<{ id?: string; name: string; response: Record<string, unknown> }> = [];
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeHandle: string | null = null;
  private reconnecting = false;
  private muted = false;
  private paused = false;
  private ptt: boolean;
  private talking = false;
  private streamEnded = false;
  private agentAudible = false;
  private stopped = false;

  constructor(private o: VoiceClientOptions) {
    super();
    this.ptt = o.turnTaking.mode === 'push_to_talk';
  }

  async start(): Promise<void> {
    const ctx = this.o.audioContext;
    if (!hasGeminiLiveSupport() || !ctx) {
      this.emit('error', { code: 'unsupported', message: 'This browser cannot run live voice.', fallback: true });
      throw new Error('Gemini Live unsupported');
    }
    if (!this.o.micStream?.getAudioTracks()[0]) {
      this.emit('error', { code: 'no_device', message: 'A microphone is required for live voice.', fallback: true });
      throw new Error('No microphone');
    }
    let creds: GeminiLiveCredentials;
    try {
      creds = await fetchGeminiToken(this.o.sessionId, this.o.token);
    } catch (e: any) {
      this.emit('error', {
        code: 'provider_unavailable',
        message: e?.status === 503 ? 'Live voice is not configured on the server.' : 'Could not start live voice.',
        fallback: true,
      });
      throw e;
    }
    if (this.stopped) return;
    this.player = new AudioPlayer(ctx, this.o.recordingSink);
    this.player.on('audible', (a) => this.setAgentAudible(a));
    try {
      await this.open(creds);
    } catch (e) {
      this.emit('error', { code: 'realtime_failed', message: 'The live voice connection could not be established.', fallback: true });
      throw e;
    }
    if (this.stopped) return; // stopped while connecting: nothing else to set up
    this.mic = new MicStreamer(ctx, this.o.micStream!, (b64) => this.sendAudio(b64));
    await this.mic.start();
    this.vad = new EnergyVad(ctx, this.o.micStream!, {
      onLevel: (l) => this.emit('level', l),
      onSpeechStart: ({ duringAgent }) => this.onLocalSpeech(true, duringAgent),
      onSpeechEnd: () => this.onLocalSpeech(false, false),
    });
    this.vad.start();
    this.applyListening();
  }

  // ───────────────────────────── connection ─────────────────────────────

  private async open(creds: GeminiLiveCredentials): Promise<void> {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: creds.token, apiVersion: creds.apiVersion || 'v1alpha' });
    const gen = ++this.gen;
    this.connId = Math.random().toString(36).slice(2, 8);
    this.seq = 0;
    this.ready = false;
    let timedOut = false;
    const connecting = ai.live.connect({
      model: creds.model,
      // Mirrors the values locked in the token (the constrained endpoint ignores client changes).
      config: { ...(creds.connectConfig as object) },
      callbacks: {
        onmessage: (m: LiveServerMessage) => {
          if (gen === this.gen) this.onMessage(m);
        },
        onerror: (e: ErrorEvent) => {
          if (gen === this.gen) console.warn('[gemini-live] socket error', e?.message ?? e);
        },
        onclose: (e: CloseEvent) => {
          if (gen !== this.gen || this.stopped) return;
          console.warn('[gemini-live] closed', e?.code, e?.reason);
          void this.reconnect(`closed ${e?.code ?? ''}`);
        },
      },
    });
    const session = await Promise.race([
      connecting,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error('Gemini Live connect timeout'));
        }, CONNECT_TIMEOUT_MS),
      ),
    ]).catch((e) => {
      void connecting.then((s) => timedOut && s.close()).catch(() => undefined);
      throw e;
    });
    if (this.stopped) {
      session.close();
      return;
    }
    this.session = session;
    if (this.ready) this.flushInstructions(); // setupComplete may have been delivered before connect() resolved
    // The server acknowledges the (locked) setup; if that message is slow, don't block audio forever.
    setTimeout(() => gen === this.gen && this.markReady(), 4000);
  }

  private markReady() {
    if (this.ready) return;
    this.ready = true;
    this.streamEnded = false;
    this.flushInstructions();
  }

  private async reconnect(reason: string) {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    const old = this.session;
    this.session = null;
    this.ready = false;
    this.gen++; // ignore anything the old connection still delivers
    // Commit what was said so far; an unfinished agent turn counts as interrupted where the audio stops.
    this.finalizeUser();
    if (this.agent) this.reportAgent(this.agent.cutAt !== undefined); // buffered audio keeps playing
    this.generating = false;
    this.awaitingResponseUntil = 0;
    this.clearTailCut();
    this.gate.release(0);
    this.pendingCalls.clear();
    this.responses = [];
    try {
      old?.close();
    } catch {
      /* already closed */
    }
    this.emit('notice', 'Reconnecting live voice…');
    for (let attempt = 1; attempt <= MAX_RECONNECTS && !this.stopped; attempt++) {
      try {
        const creds = await fetchGeminiToken(this.o.sessionId, this.o.token, this.resumeHandle ? { resumeHandle: this.resumeHandle } : { reconnect: true });
        await this.open(creds);
        this.reconnecting = false;
        return;
      } catch (e) {
        console.warn(`[gemini-live] reconnect ${attempt} failed (${reason})`, e);
        this.resumeHandle = null; // a stale handle may be the problem; fall back to a fresh session
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
    this.reconnecting = false;
    if (!this.stopped) {
      this.emit('error', { code: 'realtime_failed', message: 'The live voice connection was lost.', fallback: true });
    }
  }

  // ───────────────────────────── server messages ─────────────────────────────

  private onMessage(m: LiveServerMessage) {
    if (m.setupComplete) this.markReady();
    if (m.sessionResumptionUpdate) {
      const u = m.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.resumeHandle = u.newHandle;
    }
    if (m.goAway) {
      // The server will close this connection soon: move to a resumed one now.
      void this.reconnect(`goAway ${m.goAway.timeLeft ?? ''}`);
      return;
    }
    if (m.toolCall?.functionCalls?.length) this.onToolCalls(m.toolCall.functionCalls);
    if (m.toolCallCancellation?.ids?.length) {
      for (const id of m.toolCallCancellation.ids) this.pendingCalls.delete(id);
      this.responses = this.responses.filter((r) => !r.id || !m.toolCallCancellation!.ids!.includes(r.id));
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interimInputTranscription?.text) this.onInterimInput(sc.interimInputTranscription.text);
    if (sc.inputTranscription?.text) this.onInputText(sc.inputTranscription.text, !!sc.inputTranscription.finished);
    else if (sc.inputTranscription?.finished) this.finalizeUser();
    if (sc.interrupted) this.onInterrupted();
    if (sc.outputTranscription?.text) this.onOutputText(sc.outputTranscription.text);
    for (const part of sc.modelTurn?.parts ?? []) {
      const d = part.inlineData;
      if (d?.data && (d.mimeType ?? '').startsWith('audio/')) this.onAudio(d.data, d.mimeType!);
    }
    if (sc.turnComplete) this.onTurnComplete();
  }

  private newId(kind: 'u' | 'a') {
    return `g${this.connId}_${++this.seq}_${kind}`;
  }

  /** Low-latency caption while the participant is still talking (never stored: the final chunks replace it). */
  private onInterimInput(text: string) {
    this.lastInputAt = Date.now();
    if (!this.user) this.user = { id: this.newId('u'), text: '' };
    const shown = cleanTranscript(`${this.user.text} ${text}`);
    if (shown) this.emit('partial', shown, this.user.id);
  }

  private onInputText(text: string, finished: boolean) {
    this.lastInputAt = Date.now();
    if (!this.user) this.user = { id: this.newId('u'), text: '' };
    const u = this.user;
    u.text += text;
    const shown = cleanTranscript(u.text);
    if (shown) {
      this.emit('partial', shown, u.id);
      u.shown = true;
    }
    // (An utterance whose text turns out to be nothing but placeholders hides its row again.)
    if (shown || u.shown) this.emit('realtimeDelta', { itemId: u.id, role: 'user', text: shown });
    if (finished) return this.finalizeUser();
    // No answer yet: commit after a quiet period; once the agent answers, a short grace applies instead.
    if (u.timer) clearTimeout(u.timer);
    u.timer = setTimeout(() => this.finalizeUser(), u.answered ? USER_FINALIZE_GRACE_MS : USER_IDLE_FINALIZE_MS);
  }

  /** Commit the utterance the current agent turn answers (never one that started during the agent turn). */
  private finalizeAnsweredUser() {
    if (this.user?.answered) this.finalizeUser();
  }

  private finalizeUser() {
    const u = this.user;
    if (!u) return;
    this.user = null;
    if (u.timer) clearTimeout(u.timer);
    const text = cleanTranscript(u.text);
    this.emit('partial', '', u.id); // the caption is replaced by the committed row
    if (text) this.report(u.id, 'user', text);
    else if (u.shown) this.emit('realtimeDelta', { itemId: u.id, role: 'user', text: '' });
  }

  private ensureAgent(): AgentItem {
    if (!this.agent) {
      this.agent = { id: this.newId('a'), text: '', audio: false };
      this.generating = true;
      this.awaitingResponseUntil = 0;
      // The participant's utterance is complete once the model answers (allow late transcription chunks).
      if (this.user) {
        const u = this.user;
        u.answered = true;
        if (u.timer) clearTimeout(u.timer);
        u.timer = setTimeout(() => this.user === u && this.finalizeUser(), USER_FINALIZE_GRACE_MS);
      }
    }
    return this.agent;
  }

  private onOutputText(text: string) {
    const a = this.ensureAgent();
    a.text += text;
    const shown = cleanTranscript(a.text);
    this.player?.setTurnText(a.id, shown.length);
    if (shown) a.shown = true;
    if (shown || a.shown) this.emit('realtimeDelta', { itemId: a.id, role: 'assistant', text: shown });
  }

  private onAudio(b64: string, mime: string) {
    const a = this.ensureAgent();
    if (this.paused || a.cutAt !== undefined || !this.player) return; // stopped locally: drop the rest
    a.audio = true;
    void this.player.enqueue(a.id, base64ToBytes(b64), mime, false);
  }

  /** Barge-in reported by Gemini: stop playback immediately; the turn keeps only what was heard. */
  private onInterrupted() {
    this.finalizeAnsweredUser();
    this.clearTailCut();
    const a = this.agent;
    if (a) {
      const stopped = this.player?.stopAll();
      if (a.cutAt === undefined) a.cutAt = stopped && stopped.turnId === a.id ? stopped.spokenChars : a.audio ? 0 : a.text.length;
      this.reportAgent(true);
    }
    this.generating = false;
    this.awaitingResponseUntil = 0;
    this.setAgentAudible(false);
  }

  private onTurnComplete() {
    // After an interruption the agent turn was already reported; the barge-in utterance stays open.
    if (this.agent) {
      this.player?.end(this.agent.id);
      this.reportAgent(this.agent.cutAt !== undefined);
    }
    this.generating = false;
    this.awaitingResponseUntil = 0;
    this.flushInstructions();
  }

  private reportAgent(interrupted: boolean) {
    const a = this.agent;
    if (!a) return;
    this.agent = null;
    this.finalizeAnsweredUser(); // participant first, then the agent's answer (server orders by arrival)
    const full = cleanTranscript(a.text);
    this.lastAgent = { id: a.id, text: full };
    const text = interrupted && a.cutAt !== undefined ? heardText(full, a.cutAt) : full;
    if (text) this.report(a.id, 'assistant', text, interrupted || undefined);
    else if (a.shown) this.emit('realtimeDelta', { itemId: a.id, role: 'assistant', text: '' }); // nothing said: hide the row
  }

  /** Mirror a finished transcript item to our server exactly once. */
  private report(itemId: string, role: 'user' | 'assistant', text: string, interrupted?: boolean) {
    if (this.reported.has(itemId)) return;
    this.reported.add(itemId);
    this.emit('realtimeTranscript', { itemId, role, text, ...(interrupted ? { interrupted: true } : {}) });
  }

  // ───────────────────────────── tools ─────────────────────────────

  private onToolCalls(calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>) {
    for (const fc of calls) {
      if (!fc.name) continue;
      const callId = fc.id || `gcall_${this.connId}_${++this.seq}`;
      if (this.seenCalls.has(callId)) continue;
      this.seenCalls.add(callId);
      this.pendingCalls.set(callId, fc.name);
      this.emit('realtimeToolCall', { callId, name: fc.name, arguments: JSON.stringify(fc.args ?? {}) });
    }
  }

  /** Server result for a relayed call. Responses for one tool-call batch are sent together. */
  sendToolResult(callId: string, output: string): void {
    const name = this.pendingCalls.get(callId);
    if (!name) return;
    this.pendingCalls.delete(callId);
    this.responses.push({ ...(callId.startsWith('gcall_') ? {} : { id: callId }), name, response: { output } });
    if (this.pendingCalls.size === 0) this.flushToolResponses();
    else if (!this.responseTimer) this.responseTimer = setTimeout(() => this.flushToolResponses(), 8000);
  }

  private flushToolResponses() {
    if (this.responseTimer) clearTimeout(this.responseTimer);
    this.responseTimer = null;
    if (!this.responses.length || !this.session) return;
    const functionResponses = this.responses;
    this.responses = [];
    try {
      this.session.sendToolResponse({ functionResponses });
      this.awaitingResponseUntil = Date.now() + RESPONSE_WAIT_MS; // the model continues its turn
    } catch (e) {
      console.warn('[gemini-live] tool response failed', e);
    }
  }

  // ───────────────────────────── instructions & text ─────────────────────────────

  /** Server instruction (opening line, nudge, wrap-up, closing) as a clearly framed client text turn. */
  sendInstruction(text: string, respond?: boolean): void {
    this.instructions.push({ text, respond: !!respond });
    this.flushInstructions();
  }

  /**
   * How long client content must wait: the model is generating (or we asked it to), its audio is still
   * playing here, or the participant is talking / just finished. 0 = send now.
   */
  private busyForMs(): number {
    if (this.generating || this.userSpeaking || this.gate.agentAudible || this.player?.isPlaying()) return BUSY_RECHECK_MS;
    const now = Date.now();
    return Math.max(0, this.lastInputAt + INPUT_SETTLE_MS - now, this.awaitingResponseUntil - now);
  }

  private flushInstructions() {
    if (!this.instructions.length || !this.session || !this.ready || this.pendingCalls.size) return;
    const wait = this.busyForMs();
    if (wait > 0) {
      // Client content interrupts a running generation: wait for a quiet moment (re-checked on events too).
      if (!this.instructionTimer) {
        this.instructionTimer = setTimeout(() => {
          this.instructionTimer = null;
          this.flushInstructions();
        }, wait);
      }
      return;
    }
    const queued = this.instructions;
    this.instructions = [];
    queued.forEach((ins, i) => {
      const respond = ins.respond || (i === queued.length - 1 && queued.some((q) => q.respond));
      this.sendText(`${INSTRUCTION_PREFIX}\n${ins.text}`, i === queued.length - 1 ? respond : false);
    });
  }

  /** Typed participant input in live mode: the model hears it as a user turn. */
  sendUserText(text: string): void {
    this.cancelSpeech('local');
    this.sendText(text, true);
  }

  private sendText(text: string, turnComplete: boolean) {
    try {
      this.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete });
      if (turnComplete) this.awaitingResponseUntil = Date.now() + RESPONSE_WAIT_MS;
    } catch (e) {
      console.warn('[gemini-live] client content failed', e);
    }
  }

  // ───────────────────────────── audio in ─────────────────────────────

  private listening(): boolean {
    return !this.stopped && !this.muted && !this.paused && (!this.ptt || this.talking);
  }

  private sendAudio(b64: string) {
    if (!this.session || !this.ready || !this.listening()) return;
    for (const chunk of this.gate.offer(b64)) this.transmit(chunk);
  }

  private transmit(b64: string) {
    if (!this.session || !this.ready) return;
    this.streamEnded = false;
    try {
      this.session.sendRealtimeInput({ audio: { data: b64, mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } });
    } catch {
      /* socket closing; reconnect handles it */
    }
  }

  /** Tell Gemini the audio stream paused (mute / pause / push-to-talk release) so it can close the turn. */
  private endAudioStream() {
    if (this.streamEnded || !this.session || !this.ready) return;
    this.streamEnded = true;
    try {
      this.session.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      /* ignore */
    }
  }

  private applyListening() {
    this.vad?.setEnabled(this.listening());
    if (!this.listening()) this.endAudioStream();
  }

  /** The local VAD's view of the participant (raised threshold + longer confirmation while the agent plays). */
  private onLocalSpeech(speaking: boolean, duringAgent: boolean) {
    if (speaking && !this.listening()) return;
    if (this.userSpeaking === speaking) return;
    this.userSpeaking = speaking;
    this.gate.userSpeaking = speaking;
    this.emit('speaking', speaking);
    if (speaking) {
      if (duringAgent || this.gate.agentAudible) this.openGate('speech');
      return;
    }
    this.player?.duck(false);
    this.clearTailCut();
    // The agent kept talking (no interruption came back): let the model close the participant's activity.
    if (this.gate.closed) this.endAudioStream();
    this.flushInstructions();
  }

  private openGate(reason: 'speech' | 'agent_done') {
    let chunks: string[];
    if (reason === 'speech') {
      chunks = this.gate.release();
      if (this.player?.isPlaying() && this.o.turnTaking.allowBargeIn) {
        // Yield like a person would: get quieter at once; if the participant keeps going, stop.
        this.player.duck(true);
        this.armTailCut();
      }
    } else {
      // Only keep a little pre-roll when energy was already rising (a quick reply overlapping the agent's
      // last word); otherwise the tail is just echo.
      chunks = this.gate.release((this.vad?.state.aboveMs ?? 0) > 0 ? 3 : 0);
    }
    for (const c of chunks) this.transmit(c);
  }

  private armTailCut() {
    this.clearTailCut();
    this.tailCutTimer = setTimeout(() => {
      this.tailCutTimer = null;
      this.cutTail();
    }, TAIL_CUT_MS);
  }

  private clearTailCut() {
    if (this.tailCutTimer) clearTimeout(this.tailCutTimer);
    this.tailCutTimer = null;
  }

  /** The participant has been talking over the agent for a while: stop the playback and record what was heard. */
  private cutTail() {
    if (!this.userSpeaking || !this.player?.isPlaying()) return;
    if (this.agent) {
      this.cancelSpeech('barge_in'); // the turn is reported cut when it completes
      return;
    }
    const stopped = this.player.stopAll();
    this.setAgentAudible(false);
    const last = this.lastAgent;
    if (stopped && last && stopped.turnId === last.id) {
      // Already reported in full: the server updates the saved turn with what was actually heard.
      const text = heardText(last.text, stopped.spokenChars);
      if (text) this.emit('realtimeTranscript', { itemId: last.id, role: 'assistant', text, interrupted: true });
    }
  }

  private setAgentAudible(a: boolean) {
    if (a) {
      if (this.gateTimer) clearTimeout(this.gateTimer);
      this.gateTimer = null;
      this.gate.agentAudible = true;
      this.vad?.setAgentPlaying(true);
    } else if (this.gate.agentAudible && !this.gateTimer) {
      // Keep the gate shut a moment longer: the room and the echo canceller need time to settle.
      this.gateTimer = setTimeout(() => {
        this.gateTimer = null;
        this.gate.agentAudible = false;
        this.vad?.setAgentPlaying(false);
        this.openGate('agent_done');
        this.flushInstructions();
      }, GATE_HANGOVER_MS);
    }
    if (a === this.agentAudible) return;
    this.agentAudible = a;
    this.emit('agentSpeaking', a);
  }

  // ───────────────────────────── VoiceClient ─────────────────────────────

  stop(): void {
    this.stopped = true;
    this.gen++;
    if (this.user?.timer) clearTimeout(this.user.timer);
    if (this.responseTimer) clearTimeout(this.responseTimer);
    if (this.instructionTimer) clearTimeout(this.instructionTimer);
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.instructionTimer = null;
    this.gateTimer = null;
    this.clearTailCut();
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.mic?.stop();
    this.vad?.stop();
    this.player?.dispose();
    this.mic = null;
    this.vad = null;
    this.player = null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyListening();
  }

  setPaused(paused: boolean): void {
    if (paused) this.cancelSpeech('local');
    this.paused = paused;
    this.applyListening();
  }

  speak(): void {
    // Agent speech comes from the model directly.
  }

  cancelSpeech(_reason?: 'barge_in' | 'server' | 'local'): void {
    const a = this.agent;
    const stopped = this.player?.stopAll();
    if (a && a.cutAt === undefined && (a.audio || stopped)) a.cutAt = stopped && stopped.turnId === a.id ? stopped.spokenChars : 0;
    this.clearTailCut();
    this.setAgentAudible(false);
  }

  commitNow(): void {
    // "I'm done answering": flush Gemini's activity detection so it answers now.
    this.endAudioStream();
    this.streamEnded = false;
  }

  setPushToTalk(enabled: boolean): void {
    this.ptt = enabled;
    this.applyListening();
  }

  setTalking(held: boolean): void {
    if (!this.ptt) return;
    this.talking = held;
    this.gate.forced = held;
    if (held) {
      if (this.agentAudible && this.o.turnTaking.allowBargeIn) this.cancelSpeech('barge_in');
      this.emit('speaking', true);
    } else {
      this.emit('speaking', false);
    }
    this.applyListening();
  }

  /** Test/diagnostics hook. */
  debugState() {
    return {
      ready: this.ready,
      generating: this.generating,
      agentAudible: this.agentAudible,
      playing: this.player?.isPlaying() ?? false,
      player: this.player?.getStats() ?? null,
      gateClosed: this.gate.closed,
      userSpeaking: this.userSpeaking,
      preroll: this.gate.buffered,
      resumeHandle: this.resumeHandle,
      queuedInstructions: this.instructions.length,
      pendingCalls: [...this.pendingCalls.keys()],
    };
  }
}
