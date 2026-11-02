import { DrizzleAssignmentRepository } from '../../src/modules/tasks/infrastructure/drizzle-assignment-repository';
import { DrizzleReportRepository } from '../../src/modules/tasks/infrastructure/drizzle-report-repository';
import { DrizzleTaskEventLog } from '../../src/modules/tasks/infrastructure/drizzle-task-event-log';
import { DrizzleTaskReadModel } from '../../src/modules/tasks/infrastructure/drizzle-task-read-model';
import { DrizzleTaskRepository } from '../../src/modules/tasks/infrastructure/drizzle-task-repository';
import { DrizzleTaskStatistics } from '../../src/modules/tasks/infrastructure/drizzle-task-statistics';
import { DrizzleTemplateRepository } from '../../src/modules/tasks/infrastructure/drizzle-template-repository';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';
import { describeTasksContract } from '../support/tasks-contract-suite';
import type { TasksPorts } from '../support/tasks-harness';

/**
 * The tasks engine's contract suite on a real Postgres (ADR 0052): the same
 * behaviour the in-memory twins pass, now through the Drizzle adapters,
 * migrations 0034–0035, the CHECK constraints, the unique indexes and the
 * archive rule as one guarded UPDATE. One scratch database for the file; every
 * test publishes its own tasks, so they do not see each other's assertions.
 */
describeWithPostgres('tasks engine on Postgres', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await scratchDatabase();
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  const ports = async (): Promise<TasksPorts> => {
    // A fresh slate per test: the engine's tables only, children first.
    await scratch.pool.query(
      `TRUNCATE tasks_events, tasks_report_reviews, tasks_report_versions, tasks_reports,
                tasks_assignments, tasks_revisions, tasks, tasks_templates`,
    );
    const db = scratch.db;
    return {
      tasks: new DrizzleTaskRepository(db),
      assignments: new DrizzleAssignmentRepository(db),
      reports: new DrizzleReportRepository(db),
      log: new DrizzleTaskEventLog(db),
      templates: new DrizzleTemplateRepository(db),
      reads: new DrizzleTaskReadModel(db),
      statistics: new DrizzleTaskStatistics(db),
    };
  };

  describeTasksContract('Postgres', ports);

  it('seeds the three task permissions with the provisional grants (migration 0035)', async () => {
    const rows = await scratch.pool.query<{ role_code: string; permission_code: string }>(
      `select role_code, permission_code from role_permissions
        where permission_code like 'tasks.%' order by permission_code, role_code`,
    );
    expect(rows.rows.map((r) => `${r.permission_code}:${r.role_code}`)).toEqual([
      'tasks.manage:ADMIN',
      'tasks.manage:OWNER',
      'tasks.respond:ADMIN',
      'tasks.respond:ASSISTANT_TEACHER',
      'tasks.respond:OWNER',
      'tasks.respond:SUPERVISOR',
      'tasks.respond:TEACHER',
      'tasks.template:OWNER',
    ]);
  });
});
