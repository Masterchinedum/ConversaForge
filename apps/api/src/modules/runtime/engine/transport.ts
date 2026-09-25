import type { ClientMessage, ServerMessage } from '@cf/shared';

/**
 * Transport-agnostic bridge between a participant connection and a session engine.
 *
 * The browser WebSocket gateway is one implementation; workstream H can bridge phone calls
 * (e.g. Twilio media streams + server STT/TTS) by implementing this interface and calling
 * `RuntimeService.attach(sessionId, sessionToken, transport)`:
 *
 *   const conn = await runtime.attach(sessionId, token, {
 *     kind: 'phone',
 *     send: (msg) => { ...speak agent.delta/agent.end via server TTS, ignore UI-only messages... },
 *     close: (code, reason) => { ...hang up... },
 *   });
 *   conn.receive({ type: 'start' });
 *   conn.receive({ type: 'participant.final', clientTurnId, text, source: 'server_stt' });
 *   conn.receive({ type: 'agent.playback', turnId, event: 'completed' });
 *   ...
 *   conn.detach();   // caller hung up → session goes RECONNECTING, then ABANDONED/COMPLETED
 */
export interface EngineTransport {
  /** e.g. 'websocket' | 'phone' | 'meeting' — logged only. */
  readonly kind: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface EngineConnection {
  readonly sessionId: string;
  /** Deliver a client message to the engine (validated and rate-limited by the caller). */
  receive(msg: ClientMessage): void;
  /** The underlying connection went away. */
  detach(reason?: string): void;
}
