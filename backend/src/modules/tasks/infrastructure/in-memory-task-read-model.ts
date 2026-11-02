import { Injectable } from '@nestjs/common';

import { isOpenAssignment } from '../domain/assignment';
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
import { InMemoryTasksState } from './in-memory-tasks-state';
import { countResponses, isAfter, newestFirst, stateOf, taskMatches } from './task-filter-match';

/** Lists, a recipient's tasks and the reports page in memory. */
@Injectable()
export class InMemoryTaskReadModel implements TaskReadModel {
  constructor(private readonly state: InMemoryTasksState) {}

  async listTasks(
    filter: TaskFilter,
    after: CreatedKeyset | null,
    limit: number,
  ): Promise<readonly TaskSummary[]> {
    const key = (s: TaskSummary) => ({ at: s.task.createdAt, id: s.task.id });
    const position = after && { at: after.createdAt, id: after.id };
    return [...this.state.tasks.values()]
      .filter((task) => taskMatches(task, filter, this.state))
      .map((task) => ({ task, counts: this.counts(task.id) }))
      .sort(newestFirst(key))
      .filter((s) => isAfter(key(s), position))
      .slice(0, limit);
  }

  async countsOf(taskId: string): Promise<TaskCounts> {
    return this.counts(taskId);
  }

  async listMine(
    recipientId: string,
    scope: 'OPEN' | 'DONE',
    after: CreatedKeyset | null,
    limit: number,
  ): Promise<readonly MyTaskItem[]> {
    const key = (i: MyTaskItem) => ({ at: i.assignment.createdAt, id: i.assignment.id });
    const position = after && { at: after.createdAt, id: after.id };
    const items: MyTaskItem[] = [];
    for (const assignment of this.state.assignments.values()) {
      if (assignment.recipientId !== recipientId || !isOpenAssignment(assignment)) continue;
      const task = this.state.tasks.get(assignment.taskId);
      if (task === undefined) continue;
      const open = assignment.status !== 'COMPLETED' && stateOf(task) === 'ACTIVE';
      if (open !== (scope === 'OPEN')) continue;
      items.push({ assignment, task, report: this.state.reportOf(assignment.id) ?? null });
    }
    return items
      .sort(newestFirst(key))
      .filter((i) => isAfter(key(i), position))
      .slice(0, limit);
  }

  async listReports(
    filter: TaskFilter & { readonly category?: ReportCategory },
    after: { readonly updatedAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly ReportSummary[]> {
    const taskFilter = {
      ...filter,
      reportStatus: undefined,
      personId: undefined,
      audience: undefined,
    };
    const key = (s: ReportSummary) => ({ at: s.report.updatedAt, id: s.report.id });
    const position = after && { at: after.updatedAt, id: after.id };
    const summaries: ReportSummary[] = [];
    for (const report of this.state.reports.values()) {
      const task = this.state.tasks.get(report.taskId);
      const assignment = this.state.assignments.get(report.assignmentId);
      if (task === undefined || assignment === undefined) continue;
      if (!taskMatches(task, taskFilter, this.state)) continue;
      if (filter.category !== undefined && report.category !== filter.category) continue;
      const wanted = filter.reportStatus ?? null;
      if (wanted === null ? report.status === 'DELETED' : report.status !== wanted) continue;
      if (filter.personId !== undefined && report.authorId !== filter.personId) continue;
      if (filter.audience !== undefined && assignment.audience !== filter.audience) continue;
      summaries.push({
        report,
        taskTitle: task.title,
        taskKind: task.kind,
        audience: assignment.audience,
      });
    }
    return summaries
      .sort(newestFirst(key))
      .filter((s) => isAfter(key(s), position))
      .slice(0, limit);
  }

  private counts(taskId: string): TaskCounts {
    return countResponses(this.state.assignmentsOf(taskId), this.state.reportsByAssignment(taskId));
  }
}
