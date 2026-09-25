import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { PROTOCOL_VERSION, WS_CLOSE_CODES, type ClientMessage, type ServerMessage } from '@cf/shared';
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import { AppError } from '../../common/http/errors';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import type { EngineConnection, EngineTransport } from './engine/transport';
import { ClientMessageSchema } from './protocol-schema';
import { RuntimeService } from './runtime.service';

const HELLO_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Token bucket: sustained messages/second and burst. */
const RATE_PER_SEC = 40;
const RATE_BURST = 120;

function clientIp(req?: IncomingMessage): string {
  const xf = req?.headers['x-forwarded-for'];
  const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
  return first || req?.socket?.remoteAddress || 'unknown';
}

/**
 * Participant live channel: `ws(s)://<api>/ws/session`, protocol in @cf/shared protocol.ts.
 * The first message must be `hello` with the session token; afterwards messages are validated,
 * size- and rate-limited, and forwarded to the session engine through an EngineTransport.
 */
@WebSocketGateway({ path: '/ws/session', maxPayload: MAX_MESSAGE_BYTES })
export class RuntimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger('WsSession');

  constructor(
    private readonly runtime: RuntimeService,
    private readonly rateLimit: RateLimitService,
  ) {}

  handleConnection(client: WebSocket, req?: IncomingMessage) {
    const ip = clientIp(req);
    let conn: EngineConnection | null = null;
    let authenticating = false;
    let closed = false;
    let tokens = RATE_BURST;
    let lastRefill = Date.now();
    let violations = 0;

    const send = (msg: ServerMessage) => {
      if (client.readyState !== client.OPEN) return;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.close(WS_CLOSE_CODES.RATE_LIMITED, 'client too slow');
        return;
      }
      client.send(JSON.stringify(msg));
    };
    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      try {
        client.close(code, reason.slice(0, 100));
      } catch {
        client.terminate();
      }
    };
    const transport: EngineTransport = { kind: 'websocket', send, close };

    const helloTimer = setTimeout(() => {
      if (!conn) {
        send({ type: 'error', code: 'auth_timeout', message: 'Send hello first', fatal: true });
        close(WS_CLOSE_CODES.AUTH_FAILED, 'hello timeout');
      }
    }, HELLO_TIMEOUT_MS);

    client.on('message', (data: RawData, isBinary: boolean) => {
      // Rate limit (token bucket).
      const now = Date.now();
      tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC);
      lastRefill = now;
      if (tokens < 1) {
        violations++;
        send({ type: 'error', code: 'rate_limited', message: 'Too many messages', fatal: violations > 20 });
        if (violations > 20) close(WS_CLOSE_CODES.RATE_LIMITED, 'rate limited');
        return;
      }
      tokens -= 1;

      if (isBinary) {
        send({ type: 'error', code: 'bad_request', message: 'Binary frames are not supported', fatal: false });
        return;
      }
      const raw = data.toString();
      if (raw.length > MAX_MESSAGE_BYTES) {
        send({ type: 'error', code: 'too_large', message: 'Message too large', fatal: false });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        send({ type: 'error', code: 'bad_request', message: 'Invalid JSON', fatal: false });
        return;
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        send({ type: 'error', code: 'bad_request', message: `Invalid message${first ? `: ${first.path.join('.')} ${first.message}` : ''}`, fatal: false });
        return;
      }
      const msg = parsed.data as ClientMessage;

      if (!conn) {
        if (msg.type === 'ping') return send({ type: 'pong', t: msg.t });
        if (msg.type !== 'hello') {
          send({ type: 'error', code: 'auth_required', message: 'Send hello first', fatal: false });
          return;
        }
        if (authenticating) return;
        authenticating = true;
        void this.authenticate(msg, ip, transport).then(
          (c) => {
            authenticating = false;
            clearTimeout(helloTimer);
            if (closed) {
              c.detach('closed_during_auth');
              return;
            }
            conn = c;
          },
          (e) => {
            authenticating = false;
            clearTimeout(helloTimer);
            const code = e instanceof AppError && e.getStatus() === 429 ? WS_CLOSE_CODES.RATE_LIMITED : e instanceof AppError && e.getStatus() === 400 ? WS_CLOSE_CODES.PROTOCOL_ERROR : WS_CLOSE_CODES.AUTH_FAILED;
            const message = e instanceof AppError ? e.message : 'Could not open the session';
            if (!(e instanceof AppError)) this.logger.error(`hello failed: ${(e as Error)?.stack ?? e}`);
            send({ type: 'error', code: e instanceof AppError ? e.code : 'internal_error', message, fatal: true });
            close(code, message);
          },
        );
        return;
      }
      if (msg.type === 'hello') return; // already authenticated
      conn.receive(msg);
    });

    client.on('close', () => {
      closed = true;
      clearTimeout(helloTimer);
      conn?.detach('socket_closed');
    });
    client.on('error', () => undefined);
  }

  private async authenticate(msg: Extract<ClientMessage, { type: 'hello' }>, ip: string, transport: EngineTransport) {
    await this.rateLimit.enforce(`ws:hello:ip:${ip}`, 60, 60, 'Too many connection attempts');
    if (msg.protocol !== PROTOCOL_VERSION) {
      throw new AppError(400, 'protocol_mismatch', `Unsupported protocol version ${msg.protocol} (server speaks ${PROTOCOL_VERSION}); please reload`);
    }
    // Session tokens carry 256 bits of randomness; the per-IP hello limit above bounds guessing further.
    return this.runtime.attach(msg.sessionId, msg.token, transport, { lastSeq: msg.lastSeq, clientInstanceId: msg.clientInstanceId });
  }
}
