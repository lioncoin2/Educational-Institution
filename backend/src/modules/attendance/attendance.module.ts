import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { LiveModule } from '../live/live.module';
import { AttendanceController } from './api/attendance.controller';
import { AttendanceAccess } from './application/attendance-access';
import { AttendanceJournal } from './application/attendance-journal';
import { GetAttendanceSnapshotUseCase } from './application/get-attendance-snapshot.use-case';
import { ListCommunitySnapshotsUseCase } from './application/list-community-snapshots.use-case';
import { ListSnapshotEntriesUseCase } from './application/list-snapshot-entries.use-case';
import { RecordAttendanceSnapshotUseCase } from './application/record-attendance-snapshot.use-case';
import { ATTENDANCE_SNAPSHOT_REPOSITORY, type AttendanceSnapshotRepository } from './domain/ports';
import { DrizzleAttendanceSnapshotRepository } from './infrastructure/drizzle-attendance-repository';
import { InMemoryAttendanceSnapshotRepository } from './infrastructure/in-memory-attendance-repository';

/** Postgres when a database is configured; otherwise the in-memory twin (mock mode). */
export function attendanceSnapshotRepositoryFor(
  config: AppConfig,
  db: Database,
): AttendanceSnapshotRepository {
  return config.database.configured
    ? new DrizzleAttendanceSnapshotRepository(db)
    : new InMemoryAttendanceSnapshotRepository();
}

/**
 * Attendance — live-session attendance snapshots (docs/architecture/attendance.md,
 * P9). A **leaf** module: nothing imports it except `app.module` (ADR 0020
 * decision 1), so it exports nothing.
 *
 * It wires the record-snapshot path: `AttendanceAccess` (authorization, §11.3),
 * the snapshot repository (Drizzle in Postgres, the in-memory twin in mock
 * mode), `AttendanceJournal` (audit then event) and
 * `RecordAttendanceSnapshotUseCase`.
 *
 * It imports `CommunitiesModule` for `COMMUNITY_AUTHORIZATION` (through
 * `AttendanceAccess`), `LiveModule` for `LIVE_SESSIONS` and `LIVE_PRESENCE`, and
 * `IdentityModule` for `ACCOUNT_DIRECTORY` — the API layer resolves the
 * recorder's name at view time (§6.3). Contracts only (§4, live.md §13); none
 * of them imports Attendance, so the graph stays acyclic and needs no
 * `forwardRef`. The clock, id generator, rate limiter, audit log and event
 * publisher are global (platform).
 *
 * `AttendanceController` carries the record route (`POST …/snapshots`) and the
 * three read routes — the community list, one snapshot, and its participants —
 * each `@Authenticated()` and backed by one use case (record, list-community,
 * get, list-entries). Controllers only transport input and format output; the
 * decision is always community standing through `AttendanceAccess`.
 */
@Module({
  imports: [IdentityModule, CommunitiesModule, LiveModule],
  controllers: [AttendanceController],
  providers: [
    AttendanceAccess,
    AttendanceJournal,
    {
      provide: ATTENDANCE_SNAPSHOT_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: attendanceSnapshotRepositoryFor,
    },
    RecordAttendanceSnapshotUseCase,
    ListCommunitySnapshotsUseCase,
    GetAttendanceSnapshotUseCase,
    ListSnapshotEntriesUseCase,
  ],
})
export class AttendanceModule {}
