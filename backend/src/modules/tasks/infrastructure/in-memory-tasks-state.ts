import { Injectable } from '@nestjs/common';

import type { Assignment } from '../domain/assignment';
import type { Report, ReportReview, ReportVersion } from '../domain/report';
import type { Task, TaskRevision } from '../domain/task';
import type { TaskEventEntry, TaskEventRecord } from '../domain/task-event';
import type { TaskTemplate } from '../domain/template';

/**
 * The tasks engine's tables held in memory — one shared state for every
 * in-memory port, so the twins see each other's writes exactly as the Postgres
 * adapters see one database. Values are immutable domain objects; a write
 * replaces one. Single-threaded, so each port method is atomic by construction.
 */
@Injectable()
export class InMemoryTasksState {
  readonly tasks = new Map<string, Task>();
  /** `${createdBy}\u0000${clientRequestId}` → task id. */
  readonly clientKeys = new Map<string, string>();
  readonly revisions = new Map<string, TaskRevision[]>();
  readonly assignments = new Map<string, Assignment>();
  readonly reports = new Map<string, Report>();
  readonly versions = new Map<string, ReportVersion[]>();
  readonly reviews = new Map<string, ReportReview[]>();
  readonly templates = new Map<string, TaskTemplate>();
  readonly events: TaskEventEntry[] = [];
  private sequence = 0;

  appendEvents(events: readonly TaskEventRecord[]): void {
    for (const event of events) this.events.push({ ...event, sequence: ++this.sequence });
  }

  assignmentsOf(taskId: string): Assignment[] {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.taskId === taskId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  reportOf(assignmentId: string): Report | undefined {
    return [...this.reports.values()].find((report) => report.assignmentId === assignmentId);
  }

  /** Each of a task's assignments' reports, by assignment id. */
  reportsByAssignment(taskId: string): Map<string, Report> {
    return new Map(
      [...this.reports.values()]
        .filter((report) => report.taskId === taskId)
        .map((report) => [report.assignmentId, report]),
    );
  }
}
