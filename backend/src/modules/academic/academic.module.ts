import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { IdentityModule } from '../identity/identity.module';
import { MyAcademicController } from './api/my-academic.controller';
import { AcademicRelationshipsController } from './api/relationships.controller';
import { AcademicStructureController } from './api/structure.controller';
import { AcademicAccess } from './application/academic-access';
import { AcademicJournal } from './application/academic-journal';
import { AcademicPeople } from './application/academic-people';
import { AcademicRelationshipsService } from './application/academic-relationships.service';
import {
  GetCatalogueUseCase,
  GetHalaqaUseCase,
  GetProgramUseCase,
  GetSectionUseCase,
} from './application/catalogue.use-cases';
import {
  EndEnrollmentUseCase,
  EnrollStudentUseCase,
  ListHalaqaStudentsUseCase,
  ListStudentEnrollmentsUseCase,
} from './application/enrollment.use-cases';
import {
  GetMyAcademicUseCase,
  ListMyEnrollmentsUseCase,
  ListMyTeachingUseCase,
} from './application/my-academic.use-cases';
import {
  DevelopmentStructureSeed,
  SeedInstitutionStructureUseCase,
} from './application/seed-structure.use-case';
import {
  ChangeHalaqaStatusUseCase,
  ChangeProgramStatusUseCase,
  ChangeSectionStatusUseCase,
  CreateHalaqaUseCase,
  CreateProgramUseCase,
  CreateSectionUseCase,
  UpdateHalaqaUseCase,
  UpdateProgramUseCase,
  UpdateSectionUseCase,
} from './application/structure.use-cases';
import {
  AssignTeacherUseCase,
  EndTeacherAssignmentUseCase,
  ListHalaqaTeachersUseCase,
  ListTeacherAssignmentsUseCase,
} from './application/teaching.use-cases';
import { ACADEMIC_RELATIONSHIPS } from './contracts/relationships';
import {
  ACADEMIC_READ_MODEL,
  ACADEMIC_REPOSITORY,
  type AcademicReadModel,
  type AcademicRepository,
} from './domain/ports';
import { DrizzleAcademicReadModel } from './infrastructure/drizzle-academic-read-model';
import { DrizzleAcademicRepository } from './infrastructure/drizzle-academic-repository';
import { InMemoryAcademicStore } from './infrastructure/in-memory-academic-store';

/**
 * Academic — the institution's academic structure and who is in it: sections,
 * programs, halaqat, teacher assignments and enrollments.
 *
 * It depends on identity's contracts (may this principal…? who is this
 * account, and may it study or teach?) and on nothing else. It stores account
 * ids, never accounts. It publishes `academic.*` facts and exports one thing:
 * `ACADEMIC_RELATIONSHIPS` — who is in a halaqa now — for the modules that will
 * act per halaqa (attendance, assignments, a teacher's workspace).
 *
 * Without a database it runs on one in-memory store, seeded at boot from the
 * institution profile; with Postgres, seeding is an explicit command.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AcademicStructureController, AcademicRelationshipsController, MyAcademicController],
  providers: [
    // Without a database, one in-memory store serves both ports, so what is
    // written is what is read.
    InMemoryAcademicStore,
    {
      provide: ACADEMIC_REPOSITORY,
      inject: [APP_CONFIG, DATABASE, InMemoryAcademicStore],
      useFactory: (config: AppConfig, db: Database, memory: InMemoryAcademicStore) =>
        (config.database.configured
          ? new DrizzleAcademicRepository(db)
          : memory) satisfies AcademicRepository,
    },
    {
      provide: ACADEMIC_READ_MODEL,
      inject: [APP_CONFIG, DATABASE, InMemoryAcademicStore],
      useFactory: (config: AppConfig, db: Database, memory: InMemoryAcademicStore) =>
        (config.database.configured
          ? new DrizzleAcademicReadModel(db)
          : memory) satisfies AcademicReadModel,
    },

    AcademicAccess,
    AcademicPeople,
    AcademicJournal,
    GetCatalogueUseCase,
    GetSectionUseCase,
    GetProgramUseCase,
    GetHalaqaUseCase,
    CreateSectionUseCase,
    UpdateSectionUseCase,
    ChangeSectionStatusUseCase,
    CreateProgramUseCase,
    UpdateProgramUseCase,
    ChangeProgramStatusUseCase,
    CreateHalaqaUseCase,
    UpdateHalaqaUseCase,
    ChangeHalaqaStatusUseCase,
    EnrollStudentUseCase,
    EndEnrollmentUseCase,
    ListHalaqaStudentsUseCase,
    ListStudentEnrollmentsUseCase,
    AssignTeacherUseCase,
    EndTeacherAssignmentUseCase,
    ListHalaqaTeachersUseCase,
    ListTeacherAssignmentsUseCase,
    GetMyAcademicUseCase,
    ListMyEnrollmentsUseCase,
    ListMyTeachingUseCase,
    SeedInstitutionStructureUseCase,
    {
      provide: DevelopmentStructureSeed,
      inject: [APP_CONFIG, SeedInstitutionStructureUseCase],
      useFactory: (config: AppConfig, seed: SeedInstitutionStructureUseCase) =>
        new DevelopmentStructureSeed(!config.database.configured, seed),
    },
    { provide: ACADEMIC_RELATIONSHIPS, useClass: AcademicRelationshipsService },
  ],
  exports: [ACADEMIC_RELATIONSHIPS],
})
export class AcademicModule {}
