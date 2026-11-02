import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, not, type SQL } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type {
  CreatedKeyset,
  MyTaskItem,
  ReportSummary,
  TaskCounts,
  TaskFilter,
  TaskReadModel,
  TaskSummary,
} from '../domain/read-ports';
import type { ReportCategory } from '../domain/task-config';
import { countColumns, EMPTY_COUNTS } from './response-totals-sql';
import { toAssignment, toReport, toTask } from './row-mapping';
import { tasks, tasksAssignments, tasksReports } from './schema';
import { newestAfter, taskConditions } from './task-filter-sql';

/** Lists, a recipient's tasks and the reports page on Postgres (ADR 0052 §12). */
@Injectable()
export class DrizzleTaskReadModel implements TaskReadModel {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listTasks(
    filter: TaskFilter,
    after: CreatedKeyset | null,
    limit: number,
  ): Promise<readonly TaskSummary[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          taskConditions(filter),
          newestAfter(tasks.createdAt, tasks.id, after && { at: after.createdAt, id: after.id }),
        ),
      )
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(limit);
    const counts = await this.countsFor(rows.map((row) => row.id));
    return rows.map((row) => ({ task: toTask(row), counts: counts.get(row.id) ?? EMPTY_COUNTS }));
  }

  async countsOf(taskId: string): Promise<TaskCounts> {
    return (await this.countsFor([taskId])).get(taskId) ?? EMPTY_COUNTS;
  }

  async listMine(
    recipientId: string,
    scope: 'OPEN' | 'DONE',
    after: CreatedKeyset | null,
    limit: number,
  ): Promise<readonly MyTaskItem[]> {
    const open = and(
      inArray(tasksAssignments.status, ['PENDING', 'ACKNOWLEDGED']),
      eq(tasks.status, 'OPEN'),
      isNull(tasks.archivedAt),
    ) as SQL;
    const rows = await this.db
      .select()
      .from(tasksAssignments)
      .innerJoin(tasks, eq(tasks.id, tasksAssignments.taskId))
      .leftJoin(tasksReports, eq(tasksReports.assignmentId, tasksAssignments.id))
      .where(
        and(
          eq(tasksAssignments.recipientId, recipientId),
          ne(tasksAssignments.status, 'REASSIGNED'),
          scope === 'OPEN' ? open : not(open),
          newestAfter(
            tasksAssignments.createdAt,
            tasksAssignments.id,
            after && { at: after.createdAt, id: after.id },
          ),
        ),
      )
      .orderBy(desc(tasksAssignments.createdAt), desc(tasksAssignments.id))
      .limit(limit);
    return rows.map((row) => ({
      assignment: toAssignment(row.tasks_assignments),
      task: toTask(row.tasks),
      report: row.tasks_reports === null ? null : toReport(row.tasks_reports),
    }));
  }

  async listReports(
    filter: TaskFilter & { readonly category?: ReportCategory },
    after: { readonly updatedAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly ReportSummary[]> {
    const rows = await this.db
      .select()
      .from(tasksReports)
      .innerJoin(tasks, eq(tasks.id, tasksReports.taskId))
      .innerJoin(tasksAssignments, eq(tasksAssignments.id, tasksReports.assignmentId))
      .where(
        and(
          // Person, audience and status are about the report's own author and row.
          taskConditions({
            ...filter,
            reportStatus: undefined,
            personId: undefined,
            audience: undefined,
          }),
          filter.category === undefined ? undefined : eq(tasksReports.category, filter.category),
          // A deleted report is listed only when asked for by its status.
          filter.reportStatus === undefined
            ? ne(tasksReports.status, 'DELETED')
            : eq(tasksReports.status, filter.reportStatus),
          filter.personId === undefined ? undefined : eq(tasksReports.authorId, filter.personId),
          filter.audience === undefined
            ? undefined
            : eq(tasksAssignments.audience, filter.audience),
          newestAfter(
            tasksReports.updatedAt,
            tasksReports.id,
            after && { at: after.updatedAt, id: after.id },
          ),
        ),
      )
      .orderBy(desc(tasksReports.updatedAt), desc(tasksReports.id))
      .limit(limit);
    return rows.map((row) => ({
      report: toReport(row.tasks_reports),
      taskTitle: row.tasks.title,
      taskKind: toTask(row.tasks).kind,
      audience: toAssignment(row.tasks_assignments).audience,
    }));
  }

  /** The response counts of several tasks in one grouped query. */
  private async countsFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskCounts>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.db
      .select({ taskId: tasksAssignments.taskId, ...countColumns })
      .from(tasksAssignments)
      .leftJoin(tasksReports, eq(tasksReports.assignmentId, tasksAssignments.id))
      .where(inArray(tasksAssignments.taskId, [...taskIds]))
      .groupBy(tasksAssignments.taskId);
    return new Map(rows.map(({ taskId, ...counts }) => [taskId, counts]));
  }
}
