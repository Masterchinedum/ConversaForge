/**
 * WebSocket session connection: hello/welcome handshake, heartbeats, automatic reconnect with
 * exponential backoff + jitter, resume from `lastSeq`, and at-least-once delivery of committed
 * participant turns (unacknowledged finals are resent with the same clientTurnId; the server dedupes).
 */

import { PROTOCOL_VERSION, WS_CLOSE_CODES, type ClientMessage, type ServerMessage } from '@cf/shared';
import { Emitter } from '../voice/types';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'offline' | 'closed';

export type FatalKind = 'auth' | 'superseded' | 'terminal' | 'protocol' | 'gave_up';

interface ConnEvents {
  status: (status: ConnStatus, info: { attempt: number; nextRetryMs?: number }) => void;
  message: (msg: ServerMessage) => void;
  fatal: (kind: FatalKind, message: string) => void;
}

export interface ConnectionOptions {
  url: string;
  sessionId: string;
  token: string;
  clientInstanceId: string;
  pingIntervalMs?: number;
  /** Consider the socket dead if nothing arrives for this long. */
  staleAfterMs?: number;
  maxAttempts?: number;
  /** Test hook: WebSocket constructor. */
  WebSocketImpl?: typeof WebSocket;
}

type FinalMsg = Extract<ClientMessage, { type: 'participant.final' }>;

/** Messages that must not be lost across a reconnect (sent in order after the next welcome). */
const DURABLE: ReadonlySet<ClientMessage['type']> = new Set(['control', 'tool.response', 'tool.update', 'tool.open', 'agent.playback', 'realtime.transcript', 'realtime.tool_call']);

export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(15000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.5 + rand()));
}

export class SessionConnection extends Emitter<ConnEvents> {
  private ws: WebSocket | null = null;
  private status: ConnStatus = 'idle';
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private welcomed = false;
  private closedByUs = false;
  private fatalKind: FatalKind | null = null;
  private pendingFinals = new Map<string, FinalMsg>();
  private outbox: ClientMessage[] = [];
  lastSeq = 0;
  private readonly o: Required<Omit<ConnectionOptions, 'WebSocketImpl'>> & { WebSocketImpl?: typeof WebSocket };
  private onlineHandler = () => {
    if (this.status === 'offline' || this.status === 'reconnecting') this.reconnectNow();
  };
  private offlineHandler = () => {
    if (this.status === 'open' || this.status === 'reconnecting') this.ws?.close(4000, 'offline');
  };

  constructor(opts: ConnectionOptions) {
    super();
    this.o = { pingIntervalMs: 15000, staleAfterMs: 40000, maxAttempts: 40, ...opts };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
    }
  }

  get currentStatus() {
    return this.status;
  }

  get isOpen() {
    return this.status === 'open' && this.welcomed;
  }

  get unackedFinals(): FinalMsg[] {
    return [...this.pendingFinals.values()];
  }

  connect() {
    this.closedByUs = false;
    this.fatalKind = null;
    this.open();
  }

  /** After SUPERSEDED: take the session back from the other tab. */
  takeOver() {
    this.attempt = 0;
    this.connect();
  }

  reconnectNow() {
    if (this.closedByUs || this.fatalKind) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws && this.ws.readyState <= 1) {
      try {
        this.ws.close(4000, 'reconnect');
      } catch {
        /* ignore */
      }
      return;
    }
    this.open();
  }

  private setStatus(s: ConnStatus, nextRetryMs?: number) {
    this.status = s;
    this.emit('status', s, { attempt: this.attempt, nextRetryMs });
  }

  private open() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.welcomed = false;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.o.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      const hello: ClientMessage = {
        type: 'hello',
        sessionId: this.o.sessionId,
        token: this.o.token,
        protocol: PROTOCOL_VERSION,
        clientInstanceId: this.o.clientInstanceId,
        ...(this.lastSeq > 0 ? { lastSeq: this.lastSeq } : {}),
      };
      ws.send(JSON.stringify(hello));
      this.startPing();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      this.welcomed = false;
      this.onClose(ev.code, ev.reason);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(msg: ServerMessage) {
    if (msg.type === 'welcome') {
      this.welcomed = true;
      this.attempt = 0;
      for (const t of msg.transcript) {
        this.lastSeq = Math.max(this.lastSeq, t.seq);
        if (t.clientTurnId) this.pendingFinals.delete(t.clientTurnId);
      }
      this.setStatus('open');
      this.emit('message', msg);
      this.flush();
      return;
    }
    if (msg.type === 'turn.saved') {
      this.lastSeq = Math.max(this.lastSeq, msg.turn.seq);
      if (msg.turn.clientTurnId) this.pendingFinals.delete(msg.turn.clientTurnId);
    }
    if (msg.type === 'pong') return;
    this.emit('message', msg);
  }

  private flush() {
    // Unacknowledged finals first (the server dedupes on clientTurnId), then durable messages in order.
    for (const f of this.pendingFinals.values()) this.raw(f);
    const queued = this.outbox;
    this.outbox = [];
    for (const m of queued) this.raw(m);
  }

  private raw(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a message. Durable messages are queued while disconnected; transient ones are dropped. */
  send(msg: ClientMessage) {
    if (msg.type === 'participant.final') {
      this.pendingFinals.set(msg.clientTurnId, msg);
      if (this.welcomed) this.raw(msg);
      return;
    }
    if (this.welcomed && this.raw(msg)) return;
    if (DURABLE.has(msg.type)) {
      this.outbox.push(msg);
      if (this.outbox.length > 200) this.outbox.shift();
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws) return;
      if (Date.now() - this.lastMessageAt > this.o.staleAfterMs) {
        // Half-open connection: force a reconnect.
        try {
          this.ws.close(4000, 'stale');
        } catch {
          /* ignore */
        }
        return;
      }
      this.raw({ type: 'ping', t: Date.now() });
    }, this.o.pingIntervalMs);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onClose(code: number, reason: string) {
    if (this.closedByUs) {
      this.setStatus('closed');
      return;
    }
    switch (code) {
      case WS_CLOSE_CODES.AUTH_FAILED:
        return this.fail('auth', reason || 'This session link is invalid or has expired.');
      case WS_CLOSE_CODES.SESSION_TERMINAL:
        return this.fail('terminal', reason || 'This session has ended.');
      case WS_CLOSE_CODES.SUPERSEDED:
        return this.fail('superseded', reason || 'This session was opened in another tab.');
      case WS_CLOSE_CODES.PROTOCOL_ERROR:
        return this.fail('protocol', reason || 'The connection was rejected (protocol error).');
      case WS_CLOSE_CODES.RATE_LIMITED:
        this.attempt = Math.max(this.attempt, 4);
        return this.scheduleReconnect();
      default:
        return this.scheduleReconnect();
    }
  }

  private fail(kind: FatalKind, message: string) {
    this.fatalKind = kind;
    this.setStatus('closed');
    this.emit('fatal', kind, message);
  }

  private scheduleReconnect() {
    if (this.closedByUs || this.fatalKind) return;
    this.attempt++;
    if (this.attempt > this.o.maxAttempts) return this.fail('gave_up', 'We could not reconnect to the session.');
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const delay = backoffDelay(this.attempt - 1);
    this.setStatus(offline ? 'offline' : 'reconnecting', delay);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  /** Close for good (call ended or page leaving). */
  close() {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopPing();
    try {
      this.ws?.close(1000, 'client closed');
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      window.removeEventListener('offline', this.offlineHandler);
    }
    this.setStatus('closed');
  }

  /** Testing hook: drop the socket as if the network failed. */
  simulateDrop() {
    try {
      this.ws?.close(4000, 'simulated drop');
    } catch {
      /* ignore */
    }
  }
}
