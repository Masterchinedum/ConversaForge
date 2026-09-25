import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { ProviderResolverService } from './voice/provider-resolver.service';

/**
 * Live session runtime (workstream B).
 * Exports SessionsService (createSession / verifySessionToken) for access, courses, developer and channels.
 */
@Module({
  controllers: [SessionsController],
  providers: [SessionsService, ProviderResolverService],
  exports: [SessionsService],
})
export class RuntimeModule {}
