import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module';
import { CourseProgressService } from './course-progress.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { EnrollmentsService } from './enrollments.service';
import { LearnController, PublicCourseController } from './learn.controller';
import { LearnService } from './learn.service';

/**
 * Workstream F — courses, enrollments, progress (generation-scoped), Play All support, course share links.
 * Scenario items start sessions through the runtime's SessionsService.
 */
@Module({
  imports: [RuntimeModule],
  controllers: [CoursesController, LearnController, PublicCourseController],
  providers: [CoursesService, EnrollmentsService, LearnService, CourseProgressService],
  exports: [CoursesService, CourseProgressService],
})
export class CoursesModule {}
