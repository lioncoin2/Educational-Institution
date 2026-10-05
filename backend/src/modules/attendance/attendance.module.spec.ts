import { MODULE_METADATA } from '@nestjs/common/constants';

import { APP_CONFIG, loadConfig, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { LiveModule } from '../live/live.module';
import { AttendanceController } from './api/attendance.controller';
import { AttendanceAccess } from './application/attendance-access';
import { AttendanceJournal } from './application/attendance-journal';
import { RecordAttendanceSnapshotUseCase } from './application/record-attendance-snapshot.use-case';
import { ATTENDANCE_SNAPSHOT_REPOSITORY } from './domain/ports';
import { DrizzleAttendanceSnapshotRepository } from './infrastructure/drizzle-attendance-repository';
import { InMemoryAttendanceSnapshotRepository } from './infrastructure/in-memory-attendance-repository';
import { AttendanceModule, attendanceSnapshotRepositoryFor } from './attendance.module';

interface Declared {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory?: unknown;
}

function imports(): unknown[] {
  return Reflect.getMetadata(MODULE_METADATA.IMPORTS, AttendanceModule) as unknown[];
}

function providers(): unknown[] {
  return Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AttendanceModule) as unknown[];
}

function controllers(): unknown[] {
  return (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AttendanceModule) as unknown[]) ?? [];
}

function moduleExports(): unknown[] {
  return (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AttendanceModule) as unknown[]) ?? [];
}

function declaredFor(token: unknown): Declared {
  const found = providers().find(
    (provider): provider is Declared =>
      typeof provider === 'object' && provider !== null && (provider as Declared).provide === token,
  );
  if (found === undefined)
    throw new Error(`AttendanceModule declares no provider for ${String(token)}`);
  return found;
}

describe('the Attendance module', () => {
  it('imports Identity, Communities and Live — and nothing else', () => {
    expect(imports()).toEqual([IdentityModule, CommunitiesModule, LiveModule]);
  });

  it('exposes exactly the attendance controller', () => {
    expect(controllers()).toEqual([AttendanceController]);
  });

  it('provides the authorization gate, the journal and the record use case', () => {
    expect(providers()).toEqual(
      expect.arrayContaining([
        AttendanceAccess,
        AttendanceJournal,
        RecordAttendanceSnapshotUseCase,
      ]),
    );
  });

  it('binds the snapshot repository from the configuration, with the database handle', () => {
    const repository = declaredFor(ATTENDANCE_SNAPSHOT_REPOSITORY);
    expect(repository.inject).toEqual([APP_CONFIG, DATABASE]);
    expect(repository.useFactory).toBe(attendanceSnapshotRepositoryFor);
  });

  it('exports nothing — a leaf module', () => {
    expect(moduleExports()).toEqual([]);
  });

  describe('the repository it binds', () => {
    it('is the in-memory twin when no database is configured (mock mode)', () => {
      const repo = attendanceSnapshotRepositoryFor(loadConfig({}), {} as Database);
      expect(repo).toBeInstanceOf(InMemoryAttendanceSnapshotRepository);
    });

    it('is the Drizzle repository when a database is configured', () => {
      const base = loadConfig({});
      const config: AppConfig = { ...base, database: { ...base.database, configured: true } };
      const repo = attendanceSnapshotRepositoryFor(config, {} as Database);
      expect(repo).toBeInstanceOf(DrizzleAttendanceSnapshotRepository);
    });
  });

  it('wires the record use case acyclically — its collaborators come from imports and globals', () => {
    // AttendanceAccess (→ Communities), the repository factory and the journal
    // are declared here; LIVE_SESSIONS and LIVE_PRESENCE come from LiveModule
    // and ACCOUNT_DIRECTORY (the controller's, for the view) from IdentityModule
    // — none of which imports Attendance, so the graph is acyclic and uses no
    // forwardRef. The clock, id generator, rate limiter, audit log and event
    // publisher are global platform providers.
    expect(imports()).toContain(IdentityModule);
    expect(imports()).toContain(CommunitiesModule);
    expect(imports()).toContain(LiveModule);
    expect(controllers()).toContain(AttendanceController);
    expect(providers()).toContain(RecordAttendanceSnapshotUseCase);
    expect(providers()).toContain(AttendanceAccess);
    expect(providers()).toContain(AttendanceJournal);
  });
});
