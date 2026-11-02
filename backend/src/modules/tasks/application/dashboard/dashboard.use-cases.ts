import { Inject, Injectable } from '@nestjs/common';

import { ok, type Principal, type Result } from '../../../../shared';
import {
  TASK_STATISTICS,
  type ExportRow,
  type TaskFilter,
  type TaskStatistics,
  type TaskStatisticsResult,
} from '../../domain/read-ports';
import { PersonNames } from '../person-names';
import { TasksAccess } from '../tasks-access';

/** People shown on the dashboard at most; the rest are reached by the person filter. */
export const DASHBOARD_PEOPLE_MAX = 500;

/** Rows an export carries at most — a larger period is exported in parts. */
export const EXPORT_ROWS_MAX = 5_000;

/**
 * The owner's and the administration's dashboard (roadmap §12): rates and
 * counts over the filtered tasks, compared by audience and community, with each
 * person's detail — listed, never ranked.
 */
@Injectable()
export class TaskDashboardUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_STATISTICS) private readonly statistics: TaskStatistics,
    private readonly names: PersonNames,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly filter: TaskFilter;
  }): Promise<Result<TaskStatisticsResult & { readonly names: ReadonlyMap<string, string> }>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const result = await this.statistics.summarize(command.filter, DASHBOARD_PEOPLE_MAX);
    const names = await this.names.of(result.byPerson.map((row) => row.personId));
    return ok({ ...result, names });
  }
}

/** The rows of an export (roadmap §13), exactly the chosen filters; the format is the edge's. */
@Injectable()
export class ExportTasksUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_STATISTICS) private readonly statistics: TaskStatistics,
    private readonly names: PersonNames,
  ) {}

  async execute(command: { readonly principal: Principal; readonly filter: TaskFilter }): Promise<
    Result<{
      readonly rows: readonly ExportRow[];
      readonly names: ReadonlyMap<string, string>;
      readonly truncated: boolean;
    }>
  > {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const fetched = await this.statistics.exportRows(command.filter, EXPORT_ROWS_MAX + 1);
    const rows = fetched.slice(0, EXPORT_ROWS_MAX);
    const names = await this.names.of(
      rows.flatMap((row) => [row.assignment.recipientId, row.task.createdBy]),
    );
    return ok({ rows, names, truncated: fetched.length > EXPORT_ROWS_MAX });
  }
}
