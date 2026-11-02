import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, ne, type SQL } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { TaskAudience } from '../domain/audience';
import type {
  ExportRow,
  ResponseTotals,
  TaskFilter,
  TaskStatistics,
  TaskStatisticsResult,
} from '../domain/read-ports';
import { toTotals, totalsColumns } from './response-totals-sql';
import { toAssignment, toReport, toTask } from './row-mapping';
import { tasks, tasksAssignments, tasksReports } from './schema';
import { assignmentConditions, taskConditions } from './task-filter-sql';

const NO_TOTALS: ResponseTotals = Object.freeze({
  tasks: 0,
  tasksArchived: 0,
  assignments: 0,
  responded: 0,
  completed: 0,
  reportsApproved: 0,
  reportsChangesRequested: 0,
  reportsPending: 0,
});

/** Every counted row: a filtered task's (not reassigned-away) assignment, with its report. */
const assignmentsOfTasks = eq(tasksAssignments.taskId, tasks.id);
const reportOfAssignment = eq(tasksReports.assignmentId, tasksAssignments.id);

/**
 * The dashboard and the export on Postgres (ADR 0052 §12): aggregates over the
 * filtered tasks' assignments, computed in SQL. People are listed by id, never
 * ranked (roadmap §12).
 */
@Injectable()
export class DrizzleTaskStatistics implements TaskStatistics {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async summarize(filter: TaskFilter, personLimit: number): Promise<TaskStatisticsResult> {
    const where = and(taskConditions(filter), assignmentConditions(filter));
    const [totals, byAudience, byCommunity, byPerson] = await Promise.all([
      this.totals(where),
      this.byAudience(where),
      this.byCommunity(where),
      this.byPerson(where, personLimit),
    ]);
    return { totals, byAudience, byCommunity, byPerson };
  }

  async exportRows(filter: TaskFilter, limit: number): Promise<readonly ExportRow[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .innerJoin(tasksAssignments, assignmentsOfTasks)
      .leftJoin(tasksReports, reportOfAssignment)
      .where(
        and(
          taskConditions(filter),
          assignmentConditions(filter),
          ne(tasksAssignments.status, 'REASSIGNED'),
        ),
      )
      .orderBy(desc(tasks.createdAt), asc(tasks.id), asc(tasksAssignments.recipientId))
      .limit(limit);
    return rows.map((row) => ({
      task: toTask(row.tasks),
      assignment: toAssignment(row.tasks_assignments),
      report: row.tasks_reports === null ? null : toReport(row.tasks_reports),
    }));
  }

  private async totals(where: SQL | undefined): Promise<ResponseTotals> {
    const [row] = await this.db
      .select(totalsColumns)
      .from(tasks)
      .innerJoin(tasksAssignments, assignmentsOfTasks)
      .leftJoin(tasksReports, reportOfAssignment)
      .where(where);
    return row === undefined ? NO_TOTALS : toTotals(row);
  }

  private async byAudience(where: SQL | undefined): Promise<TaskStatisticsResult['byAudience']> {
    const rows = await this.db
      .select({ audience: tasksAssignments.audience, ...totalsColumns })
      .from(tasks)
      .innerJoin(tasksAssignments, assignmentsOfTasks)
      .leftJoin(tasksReports, reportOfAssignment)
      .where(where)
      .groupBy(tasksAssignments.audience)
      .orderBy(asc(tasksAssignments.audience));
    return rows.map(({ audience, ...row }) => ({
      audience: audience as TaskAudience,
      ...toTotals(row),
    }));
  }

  private async byCommunity(where: SQL | undefined): Promise<TaskStatisticsResult['byCommunity']> {
    const rows = await this.db
      .select({ communityId: tasks.communityId, ...totalsColumns })
      .from(tasks)
      .innerJoin(tasksAssignments, assignmentsOfTasks)
      .leftJoin(tasksReports, reportOfAssignment)
      .where(and(where, isNotNull(tasks.communityId)))
      .groupBy(tasks.communityId)
      .orderBy(asc(tasks.communityId));
    return rows.map(({ communityId, ...row }) => ({
      communityId: communityId ?? '',
      ...toTotals(row),
    }));
  }

  private async byPerson(
    where: SQL | undefined,
    limit: number,
  ): Promise<TaskStatisticsResult['byPerson']> {
    const rows = await this.db
      .select({ personId: tasksAssignments.recipientId, ...totalsColumns })
      .from(tasks)
      .innerJoin(tasksAssignments, assignmentsOfTasks)
      .leftJoin(tasksReports, reportOfAssignment)
      .where(where)
      .groupBy(tasksAssignments.recipientId)
      .orderBy(asc(tasksAssignments.recipientId))
      .limit(limit);
    return rows.map(({ personId, ...row }) => ({ personId, ...toTotals(row) }));
  }
}
