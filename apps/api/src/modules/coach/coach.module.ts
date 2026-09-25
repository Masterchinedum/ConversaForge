import { Module } from '@nestjs/common';
import { CoachController } from './coach.controller';
import { MemoryService } from './memory.service';

/**
 * Workstream F — coach profiles & learner memory.
 * Exports MemoryService: the runtime calls factsForSession(workspaceId, participantId, scenarioId, limit).
 */
@Module({
  controllers: [CoachController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class CoachModule {}
