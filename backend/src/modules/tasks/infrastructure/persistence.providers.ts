import type { Provider, Type } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import {
  ASSIGNMENT_REPOSITORY,
  REPORT_REPOSITORY,
  TASK_EVENT_LOG,
  TASK_REPOSITORY,
  TEMPLATE_REPOSITORY,
} from '../domain/ports';
import { TASK_READ_MODEL, TASK_STATISTICS } from '../domain/read-ports';
import { DrizzleAssignmentRepository } from './drizzle-assignment-repository';
import { DrizzleReportRepository } from './drizzle-report-repository';
import { DrizzleTaskEventLog } from './drizzle-task-event-log';
import { DrizzleTaskReadModel } from './drizzle-task-read-model';
import { DrizzleTaskRepository } from './drizzle-task-repository';
import { DrizzleTaskStatistics } from './drizzle-task-statistics';
import { DrizzleTemplateRepository } from './drizzle-template-repository';
import { InMemoryAssignmentRepository } from './in-memory-assignment-repository';
import { InMemoryReportRepository } from './in-memory-report-repository';
import { InMemoryTaskEventLog } from './in-memory-task-event-log';
import { InMemoryTaskReadModel } from './in-memory-task-read-model';
import { InMemoryTaskRepository } from './in-memory-task-repository';
import { InMemoryTaskStatistics } from './in-memory-task-statistics';
import { InMemoryTasksState } from './in-memory-tasks-state';
import { InMemoryTemplateRepository } from './in-memory-template-repository';

/** Each port: the Postgres adapter when a database is configured, its in-memory twin otherwise. */
function port(token: symbol, postgres: Type<unknown>, memory: Type<unknown>): Provider[] {
  return [
    postgres,
    memory,
    {
      provide: token,
      inject: [APP_CONFIG, postgres, memory],
      useFactory: (config: AppConfig, real: unknown, twin: unknown) =>
        config.database.configured ? real : twin,
    },
  ];
}

/** Every persistence provider of the tasks module (ADR 0052 §1). */
export const TASKS_PERSISTENCE_PROVIDERS: Provider[] = [
  InMemoryTasksState,
  ...port(TASK_REPOSITORY, DrizzleTaskRepository, InMemoryTaskRepository),
  ...port(ASSIGNMENT_REPOSITORY, DrizzleAssignmentRepository, InMemoryAssignmentRepository),
  ...port(REPORT_REPOSITORY, DrizzleReportRepository, InMemoryReportRepository),
  ...port(TASK_EVENT_LOG, DrizzleTaskEventLog, InMemoryTaskEventLog),
  ...port(TEMPLATE_REPOSITORY, DrizzleTemplateRepository, InMemoryTemplateRepository),
  ...port(TASK_READ_MODEL, DrizzleTaskReadModel, InMemoryTaskReadModel),
  ...port(TASK_STATISTICS, DrizzleTaskStatistics, InMemoryTaskStatistics),
];
