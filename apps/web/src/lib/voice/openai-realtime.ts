/**
 * OpenAIRealtimeAdapter — speech-to-speech with OpenAI Realtime over WebRTC.
 *
 * Flow (OpenAI Realtime GA, WebRTC):
 *   1. Our server mints an ephemeral client secret (`POST /v1/realtime/client_secrets`, session config
 *      incl. instructions/tools/voice/transcription is set server-side) → `POST .../realtime-token`.
 *   2. Browser: RTCPeerConnection + mic track + data channel "oai-events"; createOffer; POST the SDP to
 *      `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ephemeral>` and
 *      `Content-Type: application/sdp`; the response body is the answer SDP.
 *   3. Remote audio track → <audio autoplay>. Events arrive on the data channel.
 * We mirror transcripts to our server (`realtime.transcript`) and forward function calls
 * (`realtime.tool_call`); the server executes tools and returns `realtime.tool_result`, which we send
 * back as a `function_call_output` item followed by `response.create`.
 */

import { fetchRealtimeToken } from '../live/runtime-api';
import { Emitter, type VoiceClient, type VoiceClientOptions, type VoiceEvents } from './types';

export function hasWebRtc(): boolean {
  return typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined';
}

export class OpenAIRealtimeAdapter extends Emitter<VoiceEvents> implements VoiceClient {
  readonly mode = 'realtime' as const;
  readonly listens = true;
  readonly speaks = true;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private userText = new Map<string, string>();
  private agentText = new Map<string, string>();
  private reported = new Set<string>();
  private truncated = new Set<string>();
  private currentAgentItem: string | null = null;
  private agentAudible = false;
  private pendingCalls = new Set<string>();
  private seenCalls = new Set<string>();
  private ptt: boolean;
  private stopped = false;

  constructor(
    private o: VoiceClientOptions,
    private opts: { agentSpeaksFirst: boolean },
  ) {
    super();
    this.ptt = o.turnTaking.mode === 'push_to_talk';
  }

  async start(): Promise<void> {
    if (!hasWebRtc()) {
      this.emit('error', { code: 'unsupported', message: 'WebRTC is not available in this browser.', fallback: true });
      throw new Error('WebRTC unavailable');
    }
    const mic = this.o.micStream?.getAudioTracks()[0];
    if (!mic || !this.o.micStream) {
      this.emit('error', { code: 'no_device', message: 'A microphone is required for realtime voice.', fallback: true });
      throw new Error('No microphone');
    }
    let creds;
    try {
      creds = await fetchRealtimeToken(this.o.sessionId, this.o.token);
    } catch (e: any) {
      this.emit('error', {
        code: 'provider_unavailable',
        message: e?.status === 503 ? 'Realtime voice is not configured on the server.' : 'Could not start realtime voice.',
        fallback: true,
      });
      throw e;
    }

    const pc = new RTCPeerConnection();
    this.pc = pc;
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', '');
    this.audioEl = audioEl;
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      audioEl.srcObject = stream;
      void audioEl.play().catch(() => undefined);
      // Mix the agent voice into the call recording (not into the speakers — the <audio> plays it).
      if (this.o.audioContext && this.o.recordingSink) {
        try {
          this.remoteSource = this.o.audioContext.createMediaStreamSource(stream);
          this.remoteSource.connect(this.o.recordingSink);
        } catch {
          /* recording mix is best-effort */
        }
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.stopped) return;
      if (pc.connectionState === 'failed') {
        this.emit('error', { code: 'realtime_failed', message: 'The realtime voice connection failed.', fallback: true });
      } else if (pc.connectionState === 'disconnected') {
        this.emit('notice', 'Realtime voice connection is unstable…');
      }
    };
    pc.addTrack(mic, this.o.micStream);

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (e) => this.onEvent(e.data);
    dc.onopen = () => {
      if (this.ptt) this.applyTurnDetection();
      const queued = this.outbox;
      this.outbox = [];
      for (const raw of queued) dc.send(raw);
      // Normally the server sends the opening instruction (realtime.instruction); this is only for
      // callers that want the model to speak first without one.
      if (this.opts.agentSpeaksFirst && !queued.length) this.send({ type: 'response.create' });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // The model and session config are bound to the ephemeral secret server-side.
    const res = await fetch(creds.callsUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${creds.clientSecret}`, 'Content-Type': 'application/sdp' },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.emit('error', {
        code: 'realtime_failed',
        message: `Realtime call setup failed (${res.status}).`,
        fallback: true,
      });
      throw new Error(`Realtime SDP exchange failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  private outbox: string[] = [];

  /** Send on the data channel; events issued before it opens (e.g. the server's opening instruction) are queued. */
  private send(ev: Record<string, unknown>) {
    const raw = JSON.stringify(ev);
    if (this.dc?.readyState === 'open') this.dc.send(raw);
    else if (!this.stopped && this.outbox.length < 50) this.outbox.push(raw);
  }

  private applyTurnDetection() {
    // Push-to-talk: disable server VAD; we commit the buffer on release.
    this.send({
      type: 'session.update',
      session: { type: 'realtime', audio: { input: { turn_detection: this.ptt ? null : { type: 'semantic_vad' } } } },
    });
  }

  private onEvent(raw: string) {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.emit('speaking', true);
        if (this.agentAudible && this.currentAgentItem) this.truncated.add(this.currentAgentItem);
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('speaking', false);
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const t = (this.userText.get(ev.item_id) ?? '') + (ev.delta ?? '');
        this.userText.set(ev.item_id, t);
        this.emit('partial', t, ev.item_id);
        this.emit('realtimeDelta', { itemId: ev.item_id, role: 'user', text: t });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(ev.transcript ?? '').trim();
        this.userText.delete(ev.item_id);
        if (text) this.report(ev.item_id, 'user', text);
        break;
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta': {
        this.currentAgentItem = ev.item_id;
        const t = (this.agentText.get(ev.item_id) ?? '') + (ev.delta ?? '');
        this.agentText.set(ev.item_id, t);
        this.emit('realtimeDelta', { itemId: ev.item_id, role: 'assistant', text: t });
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done': {
        const text = String(ev.transcript ?? ev.text ?? this.agentText.get(ev.item_id) ?? '').trim();
        this.agentText.delete(ev.item_id);
        if (text) this.report(ev.item_id, 'assistant', text, this.truncated.has(ev.item_id));
        break;
      }
      case 'conversation.item.truncated':
        this.truncated.add(ev.item_id);
        break;
      case 'output_audio_buffer.started':
        this.setAgentAudible(true);
        if (ev.response_id) this.emit('playback', ev.response_id, 'started', 0);
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.setAgentAudible(false);
        break;
      case 'response.output_item.done':
        if (ev.item?.type === 'function_call') this.toolCall(ev.item.call_id, ev.item.name, ev.item.arguments);
        break;
      case 'response.function_call_arguments.done':
        this.toolCall(ev.call_id, ev.name, ev.arguments);
        break;
      case 'error':
        console.warn('[realtime] error event', ev.error?.message ?? ev);
        break;
      default:
        break;
    }
  }

  private report(itemId: string, role: 'user' | 'assistant', text: string, interrupted?: boolean) {
    const key = `${role}:${itemId}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.emit('realtimeTranscript', { itemId, role, text, interrupted: interrupted || undefined });
  }

  private toolCall(callId: string | undefined, name: string | undefined, args: string | undefined) {
    if (!callId || !name || this.seenCalls.has(callId)) return;
    this.seenCalls.add(callId);
    this.pendingCalls.add(callId);
    this.emit('realtimeToolCall', { callId, name, arguments: args ?? '{}' });
  }

  sendToolResult(callId: string, output: string) {
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    this.pendingCalls.delete(callId);
    if (this.pendingCalls.size === 0) this.send({ type: 'response.create' });
  }

  /** Server-side instruction (timed nudge / wrap-up / closing) injected as a system message. */
  sendInstruction(text: string, respond?: boolean) {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
    if (respond && this.pendingCalls.size === 0) this.send({ type: 'response.create' });
  }

  private setAgentAudible(a: boolean) {
    if (a === this.agentAudible) return;
    this.agentAudible = a;
    this.emit('agentSpeaking', a);
  }

  stop(): void {
    this.stopped = true;
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.getSenders().forEach((s) => this.pc?.removeTrack(s)); // never stop the shared mic track
      this.pc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.remoteSource?.disconnect();
    } catch {
      /* ignore */
    }
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
    }
    this.pc = null;
    this.dc = null;
  }

  setMuted(_muted: boolean): void {
    // The controller disables the shared mic track; nothing reaches OpenAI while muted.
  }

  setPaused(paused: boolean): void {
    if (paused) this.cancelSpeech('local');
    if (this.audioEl) this.audioEl.muted = paused;
  }

  speak(): void {
    // Agent speech comes from the model directly.
  }

  cancelSpeech(_reason?: 'barge_in' | 'server' | 'local'): void {
    if (this.currentAgentItem && this.agentAudible) this.truncated.add(this.currentAgentItem);
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
    this.setAgentAudible(false);
  }

  commitNow(): void {
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
  }

  setPushToTalk(enabled: boolean): void {
    this.ptt = enabled;
    this.applyTurnDetection();
  }

  setTalking(held: boolean): void {
    if (!this.ptt) return;
    if (held) {
      if (this.agentAudible && this.o.turnTaking.allowBargeIn) this.cancelSpeech('barge_in');
      this.send({ type: 'input_audio_buffer.clear' });
      this.emit('speaking', true);
    } else {
      this.emit('speaking', false);
      this.commitNow();
    }
  }
}
