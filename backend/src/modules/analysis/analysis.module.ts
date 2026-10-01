import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module';
import { ParticipantReportController, SessionReviewController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { ExportService } from './export.service';
import { ParticipantReportService } from './participant-report.service';
import { ReviewService } from './review.service';
import { PipelineStepsService } from './steps.service';

/**
 * Workstream D — post-session pipeline (finalize → score → extract → report → notify), reviewer
 * session list/detail/exports and participant reports.
 * Exports AnalysisService (reprocess/retryStep), ReviewService (list/detail for the REST API) and
 * ParticipantReportService (learner pages).
 */
@Module({
  imports: [RuntimeModule],
  controllers: [SessionReviewController, ParticipantReportController],
  providers: [AnalysisService, PipelineStepsService, ReviewService, ExportService, ParticipantReportService],
  exports: [AnalysisService, ReviewService, ExportService, ParticipantReportService],
})
export class AnalysisModule {}
