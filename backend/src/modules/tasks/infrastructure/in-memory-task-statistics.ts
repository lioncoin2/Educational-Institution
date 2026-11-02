import { Injectable } from '@nestjs/common';

import { isOpenAssignment, type Assignment } from '../domain/assignment';
import type {
  ExportRow,
  ResponseTotals,
  TaskFilter,
  TaskStatistics,
  TaskStatisticsResult,
} from '../domain/read-ports';
import type { Report } from '../domain/report';
import type { Task } from '../domain/task';
import { InMemoryTasksState } from './in-memory-tasks-state';
import { assignmentMatches, countResponses, taskMatches } from './task-filter-match';

interface Counted {
  readonly task: Task;
  readonly assignment: Assignment;
}

/** The dashboard and the export in memory — the twin of `DrizzleTaskStatistics`. */
@Injectable()
export class InMemoryTaskStatistics implements TaskStatistics {
  constructor(private readonly state: InMemoryTasksState) {}

  async summarize(filter: TaskFilter, personLimit: number): Promise<TaskStatisticsResult> {
    const rows = this.counted(filter);
    const groups = <K extends string>(keyOf: (row: Counted) => K | null) => {
      const byKey = new Map<K, Counted[]>();
      for (const row of rows) {
        const key = keyOf(row);
        if (key !== null) byKey.set(key, [...(byKey.get(key) ?? []), row]);
      }
      return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
    };
    return {
      totals: this.totals(rows),
      byAudience: groups((r) => r.assignment.audience).map(([audience, g]) => ({
        audience,
        ...this.totals(g),
      })),
      byCommunity: groups((r) => r.task.communityId).map(([communityId, g]) => ({
        communityId,
        ...this.totals(g),
      })),
      byPerson: groups((r) => r.assignment.recipientId)
        .slice(0, personLimit)
        .map(([personId, g]) => ({ personId, ...this.totals(g) })),
    };
  }

  async exportRows(filter: TaskFilter, limit: number): Promise<readonly ExportRow[]> {
    return this.counted(filter)
      .filter((row) => isOpenAssignment(row.assignment))
      .sort(
        (a, b) =>
          b.task.createdAt.getTime() - a.task.createdAt.getTime() ||
          a.task.id.localeCompare(b.task.id) ||
          a.assignment.recipientId.localeCompare(b.assignment.recipientId),
      )
      .slice(0, limit)
      .map((row) => ({ ...row, report: this.state.reportOf(row.assignment.id) ?? null }));
  }

  /** Every filtered task's assignment matching the filter's audience and person. */
  private counted(filter: TaskFilter): Counted[] {
    const rows: Counted[] = [];
    for (const task of this.state.tasks.values()) {
      if (!taskMatches(task, filter, this.state)) continue;
      for (const assignment of this.state.assignmentsOf(task.id)) {
        if (assignmentMatches(assignment, filter)) rows.push({ task, assignment });
      }
    }
    return rows;
  }

  private totals(rows: readonly Counted[]): ResponseTotals {
    const reports = new Map<string, Report>();
    for (const { assignment } of rows) {
      const report = this.state.reportOf(assignment.id);
      if (report !== undefined) reports.set(assignment.id, report);
    }
    const counts = countResponses(
      rows.map((r) => r.assignment),
      reports,
    );
    const taskIds = new Set(rows.map((r) => r.task.id));
    const archived = new Set(rows.filter((r) => r.task.archivedAt !== null).map((r) => r.task.id));
    return {
      tasks: taskIds.size,
      tasksArchived: archived.size,
      assignments: counts.targets,
      responded: counts.responded,
      completed: counts.completed,
      reportsApproved: counts.reportsApproved,
      reportsChangesRequested: counts.reportsChangesRequested,
      reportsPending: counts.reportsPending,
    };
  }
}
