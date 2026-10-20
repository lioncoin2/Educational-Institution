import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { AcademicModule } from '../academic/academic.module';
import { IdentityModule } from '../identity/identity.module';
import { OperationsController } from './api/operations.controller';
import {
  CancelLessonUseCase,
  GetLessonUseCase,
  ListLessonsUseCase,
  RescheduleLessonUseCase,
  ScheduleLessonUseCase,
} from './application/lesson.use-cases';
import { OperationsAccess } from './application/operations-access';
import {
  INSTITUTION_TIMEZONE,
  LESSON_REPOSITORY,
  type InstitutionTimezone,
  type LessonRepository,
} from './domain/ports';
import { DrizzleLessonRepository } from './infrastructure/drizzle-lesson-repository';
import { InMemoryLessonStore } from './infrastructure/in-memory-lesson-store';

/**
 * Operations — scheduling of individual dated lessons (ADR 0042). It reaches
 * identity only for authorization and academic only through
 * `ACADEMIC_RELATIONSHIPS` (halaqa existence); it owns `operations_lessons`.
 * It exports nothing: no other module consumes scheduling yet.
 */
@Module({
  imports: [IdentityModule, AcademicModule],
  controllers: [OperationsController],
  providers: [
    InMemoryLessonStore,
    {
      provide: LESSON_REPOSITORY,
      inject: [APP_CONFIG, DATABASE, InMemoryLessonStore],
      useFactory: (
        config: AppConfig,
        db: Database,
        memory: InMemoryLessonStore,
      ): LessonRepository =>
        config.database.configured ? new DrizzleLessonRepository(db) : memory,
    },
    {
      provide: INSTITUTION_TIMEZONE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): InstitutionTimezone => ({
        default: () => config.institution.timezone,
      }),
    },
    OperationsAccess,
    ScheduleLessonUseCase,
    ListLessonsUseCase,
    GetLessonUseCase,
    RescheduleLessonUseCase,
    CancelLessonUseCase,
  ],
})
export class OperationsModule {}
