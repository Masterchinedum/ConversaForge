import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { UsageCoreModule } from '../usage/usage.service';
import { DraftAssistantService } from './draft-assistant.service';
import { PublicGalleryController, WorkspaceGalleryController } from './gallery.controller';
import { GalleryService } from './gallery.service';
import { ScenariosController } from './scenarios.controller';
import { ScenariosService } from './scenarios.service';
import { StudioAgentService } from './studio-agent.service';

/**
 * Workstream A — scenario library, editor backend, versions, drafting assistant, templates & gallery.
 * Exports ScenariosService (getRunnableVersion) for the runtime/access/courses modules.
 */
@Module({
  imports: [UsageCoreModule, KnowledgeModule],
  controllers: [ScenariosController, PublicGalleryController, WorkspaceGalleryController],
  providers: [ScenariosService, DraftAssistantService, StudioAgentService, GalleryService],
  exports: [ScenariosService, GalleryService],
})
export class ScenariosModule {}
