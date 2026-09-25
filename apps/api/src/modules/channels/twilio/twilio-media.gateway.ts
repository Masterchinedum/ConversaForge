import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UsageService } from '../../usage/usage.service';
import { RuntimeService } from '../../runtime/runtime.service';
import { parseVersionConfig } from '../../runtime/sessions.service';
import { SpeechService } from '../../runtime/voice/speech.service';
import { PhoneService } from '../phone.service';
import { PhoneBridge } from './phone-bridge';
import { normalizePhone, SIP_RE } from './twiml';

const START_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Twilio Media Streams endpoint: `wss://<API_PUBLIC_URL host>/ws/twilio` (referenced from the TwiML
 * <Connect><Stream>). Authentication: the `start` message's customParameters carry the session id and
 * the participant session token (cfs_…), verified by RuntimeService.attach; the Twilio CallSid must
 * match the session's externalRef.
 */
@WebSocketGateway({ path: '/ws/twilio', maxPayload: MAX_MESSAGE_BYTES })
export class TwilioMediaGateway implements OnGatewayConnection {
  private readonly logger = new Logger('TwilioMedia');

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly phone: PhoneService,
  ) {}

  handleConnection(client: WebSocket, _req?: IncomingMessage) {
    let bridge: PhoneBridge | null = null;
    let starting = false;
    let closed = false;
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      try {
        client.close(1000, reason.slice(0, 100));
      } catch {
        client.terminate();
      }
    };
    const startTimer = setTimeout(() => {
      if (!bridge) close('no start message');
    }, START_TIMEOUT_MS);

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg?.event) {
        case 'start':
          if (bridge || starting) return;
          starting = true;
          void this.start(client, msg, close)
            .then((b) => {
              bridge = b;
              if (!b) close('rejected');
            })
            .catch((e) => {
              this.logger.error(`Media stream start failed: ${e?.message}`);
              close('error');
            })
            .finally(() => clearTimeout(startTimer));
          return;
        case 'media':
          if (msg.media?.track && msg.media.track !== 'inbound') return;
          if (typeof msg.media?.payload === 'string') bridge?.onTwilioMedia(msg.media.payload);
          return;
        case 'mark':
          if (typeof msg.mark?.name === 'string') bridge?.onTwilioMark(msg.mark.name);
          return;
        case 'dtmf':
          if (typeof msg.dtmf?.digit === 'string') bridge?.onTwilioDtmf(msg.dtmf.digit);
          return;
        case 'stop':
          void bridge?.onTwilioStop('caller_hung_up');
          return;
        default:
          return; // connected, etc.
      }
    });
    client.on('close', () => {
      clearTimeout(startTimer);
      closed = true;
      void bridge?.onTwilioStop('stream_closed');
    });
    client.on('error', () => undefined);
  }

  private async start(client: WebSocket, msg: any, close: (reason: string) => void): Promise<PhoneBridge | null> {
    const params = msg?.start?.customParameters ?? {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const token = typeof params.token === 'string' ? params.token : '';
    const streamSid = typeof msg?.start?.streamSid === 'string' ? msg.start.streamSid : typeof msg?.streamSid === 'string' ? msg.streamSid : '';
    const callSid = typeof msg?.start?.callSid === 'string' ? msg.start.callSid : '';
    if (!sessionId || !token || !streamSid) return null;

    const runtime = this.moduleRef.get(RuntimeService, { strict: false });
    const speechSvc = this.moduleRef.get(SpeechService, { strict: false });
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, deletedAt: null } });
    if (!session || !['PHONE_INBOUND', 'PHONE_OUTBOUND'].includes(session.channel)) return null;
    if (session.externalRef && callSid && session.externalRef !== callSid) {
      this.logger.warn(`CallSid mismatch for session ${sessionId}`);
      return null;
    }
    const version = await this.prisma.scenarioVersion.findFirst({ where: { id: session.scenarioVersionId, workspaceId: session.workspaceId } });
    const config = parseVersionConfig(version?.config);
    const info = (session.providerInfo ?? {}) as { stt?: string; tts?: string };

    let stt, tts;
    try {
      stt = await speechSvc.stt(session.workspaceId, info.stt);
      tts = await speechSvc.tts(session.workspaceId, info.tts);
    } catch (e: any) {
      // Never simulate a phone conversation: fail the session with a labeled reason.
      try {
        const engine = await runtime.getEngine(sessionId);
        await engine.fail('provider_unavailable', e?.message ?? 'Server speech providers are not configured');
      } catch {
        /* already terminal */
      }
      return null;
    }

    const transferTarget = (config.channels.phone.transferNumber ?? '').trim();
    const bridge: PhoneBridge = new PhoneBridge(
      {
        sessionId,
        workspaceId: session.workspaceId,
        language: config.basics.language,
        voice: { voiceId: config.persona.voice.voiceId, speed: config.persona.voice.speed },
        allowBargeIn: config.conversation.turnTaking.allowBargeIn,
        endOfTurnSilenceMs: config.conversation.turnTaking.endOfTurnSilenceMs,
        transferEnabled: !!(normalizePhone(transferTarget) || SIP_RE.test(transferTarget)),
        stt,
        tts,
      },
      {
        toTwilio: (m) => {
          if (client.readyState === client.OPEN) client.send(JSON.stringify(m));
        },
        closeSocket: (reason) => close(reason),
        recordUsage: (kind, provider, model, quantity, key) =>
          void this.usage
            .record({ workspaceId: session.workspaceId, sessionId, kind, provider, model, quantity, unit: kind === 'STT_SECONDS' ? 'seconds' : 'characters', idempotencyKey: key })
            .catch((e) => this.logger.warn(`usage record failed: ${e?.message}`)),
        onTransferRequested: () =>
          void this.phone.transferCall(session.workspaceId, sessionId, 'caller_dtmf').catch((e) => this.logger.warn(`Transfer failed for ${sessionId}: ${e?.message}`)),
        onCallerHangup: () =>
          void runtime
            .getEngine(sessionId)
            .then((engine) => engine.closeSession('caller_hung_up', 'participant'))
            .catch((e) => this.logger.warn(`Close after hangup failed for ${sessionId}: ${e?.message}`)),
        log: (level, m) => this.logger[level](m),
      },
    );
    let conn;
    try {
      conn = await runtime.attach(sessionId, token, bridge.transport as any, { clientInstanceId: `twilio:${streamSid}` });
    } catch (e: any) {
      this.logger.warn(`Media stream for ${sessionId} rejected: ${e?.message}`);
      return null;
    }
    bridge.bind(conn, streamSid);
    this.logger.log(`Media stream ${streamSid} bridged to session ${sessionId} (stt ${stt.id}, tts ${tts.id})`);
    return bridge;
  }
}
