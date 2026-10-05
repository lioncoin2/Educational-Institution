import { Module } from '@nestjs/common';

import { CommunitiesModule } from '../communities/communities.module';
import { AttendanceAccess } from './application/attendance-access';

/**
 * Attendance — live-session attendance snapshots (docs/architecture/attendance.md,
 * P9). A **leaf** module: nothing imports it except `app.module` (ADR 0020
 * decision 1), so it exports nothing.
 *
 * So far it holds only `AttendanceAccess` — the authorization gate (§11.3) that
 * asks `COMMUNITY_AUTHORIZATION` (from Communities) in the fixed fallback order,
 * using no `attendance.*` identity permission. The snapshot aggregate, its store,
 * the observation, the routes and the event are later P9 steps and are not here.
 *
 * It imports `CommunitiesModule` for `COMMUNITY_AUTHORIZATION`, and nothing of
 * Live or academic (the §4 firewall): the use cases that will consume
 * `AttendanceAccess` pass it the scope facts they read elsewhere.
 */
@Module({
  imports: [CommunitiesModule],
  providers: [AttendanceAccess],
})
export class AttendanceModule {}
