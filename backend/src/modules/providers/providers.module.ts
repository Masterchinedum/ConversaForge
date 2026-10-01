import { Module } from '@nestjs/common';
import { CustomFunctionsService } from './custom-functions.service';
import { CustomFunctionsController, ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

export { CustomFunctionsService } from './custom-functions.service';
export { ProvidersService } from './providers.service';

/**
 * Provider connections (BYO keys, encrypted) and custom functions (workstream G).
 * Exports CustomFunctionsService.execute(workspaceId, functionId, args, ctx) → { ok, status, result | error }.
 */
@Module({
  controllers: [ProvidersController, CustomFunctionsController],
  providers: [ProvidersService, CustomFunctionsService],
  exports: [ProvidersService, CustomFunctionsService],
})
export class ProvidersModule {}
