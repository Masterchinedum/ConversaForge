import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { RuntimeModule } from '../runtime/runtime.module';
import {
  AccessTokensController,
  GrantsController,
  PublicAccessController,
  ScenarioAccessController,
  SharedWithMeController,
  ShareLinksController,
} from './access.controllers';
import { AccessService } from './access.service';
import { GrantsService } from './grants.service';
import { PublicRunService } from './public-run.service';
import { ShareLinksService } from './share-links.service';

/**
 * Workstream E — access & sharing: share links, grants, access/embed tokens, passcodes, attempt
 * limits and the public run flows. Exports AccessService (mintToken) for the developer API (H).
 */
@Module({
  imports: [RuntimeModule, AdminModule],
  controllers: [ScenarioAccessController, ShareLinksController, GrantsController, AccessTokensController, PublicAccessController, SharedWithMeController],
  providers: [ShareLinksService, GrantsService, PublicRunService, AccessService],
  exports: [AccessService, ShareLinksService, GrantsService],
})
export class AccessModule {}
