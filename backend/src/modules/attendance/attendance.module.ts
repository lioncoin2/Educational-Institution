import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { CommunitiesModule } from '../communities/communities.module';
import { LiveModule } from '../live/live.module';
import { AttendanceAccess } from './application/attendance-access';
import { AttendanceJournal } from './application/attendance-journal';
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
 * `AttendanceAccess`) and `LiveModule` for `LIVE_SESSIONS` and `LIVE_PRESENCE`
 * — contracts only (§4, live.md §13); Live never imports Attendance, so the
 * graph stays acyclic and needs no `forwardRef`. The clock, id generator, rate
 * limiter, audit log and event publisher are global (platform). `IdentityModule`
 * is not needed here — it joins in the later API slice, with the controller and
 * routes, which are not part of this slice.
 */
@Module({
  imports: [CommunitiesModule, LiveModule],
  providers: [
    AttendanceAccess,
    AttendanceJournal,
    {
      provide: ATTENDANCE_SNAPSHOT_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: attendanceSnapshotRepositoryFor,
    },
    RecordAttendanceSnapshotUseCase,
  ],
})
export class AttendanceModule {}
