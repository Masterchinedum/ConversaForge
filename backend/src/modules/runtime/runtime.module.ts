import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ClientConfigService } from './client-config.service';
import { OptionalDepsService } from './optional-deps.service';
import { ParticipantController } from './participant.controller';
import { RecordingsService } from './recordings.service';
import { RuntimeGateway } from './runtime.gateway';
import { RuntimeService } from './runtime.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { ToolRegistry } from './tools/tool-registry';
import { ProviderResolverService } from './voice/provider-resolver.service';
import { RealtimeService } from './voice/realtime.service';
import { SpeechService } from './voice/speech.service';

/** Binary request bodies accepted by the runtime (recording parts, STT audio chunks). */
const BINARY_TYPES = [
  'application/octet-stream',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'video/webm',
  'video/mp4',
];
const BINARY_BODY_LIMIT = 10 * 1024 * 1024;

/**
 * Live session runtime (workstream B).
 * Exports:
 *  - SessionsService: createSession / verifySessionToken (share links, embeds, courses, API, channels)
 *  - RuntimeService: attach(sessionId, token, EngineTransport) for non-browser transports (phone/meetings)
 *  - SpeechService: server TTS/STT adapters (phone bridge)
 */
@Module({
  controllers: [SessionsController, ParticipantController],
  providers: [
    SessionsService,
    ProviderResolverService,
    OptionalDepsService,
    ToolRegistry,
    ClientConfigService,
    RuntimeService,
    RuntimeGateway,
    RecordingsService,
    RealtimeService,
    SpeechService,
  ],
  exports: [SessionsService, RuntimeService, SpeechService],
})
export class RuntimeModule implements OnModuleInit {
  private readonly logger = new Logger('RuntimeModule');
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit() {
    const instance = this.adapterHost?.httpAdapter?.getInstance?.();
    if (!instance || typeof instance.addContentTypeParser !== 'function') return;
    for (const type of BINARY_TYPES) {
      try {
        if (instance.hasContentTypeParser?.(type)) continue;
        instance.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: BINARY_BODY_LIMIT }, (_req: unknown, body: Buffer, done: (e: Error | null, b?: Buffer) => void) =>
          done(null, body),
        );
      } catch (e) {
        this.logger.warn(`Could not register body parser for ${type}: ${(e as Error).message}`);
      }
    }
  }
}
