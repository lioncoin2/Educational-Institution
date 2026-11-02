import { Injectable } from '@nestjs/common';

import { hasResponded, isOpenAssignment, type Assignment } from '../domain/assignment';
import type { AssignmentFilter, AssignmentRepository } from '../domain/ports';
import type { Report, ReportVersion } from '../domain/report';
import type { TaskEventRecord } from '../domain/task-event';
import { InMemoryTasksState } from './in-memory-tasks-state';

const notCompleted = (a: Assignment) => a.status === 'PENDING' || a.status === 'ACKNOWLEDGED';

const FILTERS: Readonly<Record<AssignmentFilter, (a: Assignment) => boolean>> = {
  ALL: () => true,
  RESPONDED: (a) => isOpenAssignment(a) && hasResponded(a),
  NOT_RESPONDED: (a) => isOpenAssignment(a) && !hasResponded(a),
  COMPLETED: (a) => a.status === 'COMPLETED',
  NOT_COMPLETED: notCompleted,
};

/** One addressee's acts in memory — same guarantees as `DrizzleAssignmentRepository`. */
@Injectable()
export class InMemoryAssignmentRepository implements AssignmentRepository {
  constructor(private readonly state: InMemoryTasksState) {}

  async findById(id: string): Promise<Assignment | null> {
    return this.state.assignments.get(id) ?? null;
  }

  async listByTask(
    taskId: string,
    filter: AssignmentFilter,
    afterId: string | null,
    limit: number,
  ): Promise<readonly Assignment[]> {
    return this.state
      .assignmentsOf(taskId)
      .filter((a) => FILTERS[filter](a) && (afterId === null || a.id > afterId))
      .slice(0, limit);
  }

  async findOpenFor(taskId: string, recipientId: string): Promise<Assignment | null> {
    return (
      this.state
        .assignmentsOf(taskId)
        .find((a) => a.recipientId === recipientId && isOpenAssignment(a)) ?? null
    );
  }

  async nonResponders(taskId: string): Promise<readonly Assignment[]> {
    return this.state.assignmentsOf(taskId).filter(FILTERS.NOT_RESPONDED);
  }

  async openNotCompleted(taskId: string): Promise<readonly Assignment[]> {
    return this.state.assignmentsOf(taskId).filter(notCompleted);
  }

  async acknowledge(next: Assignment, event: TaskEventRecord): Promise<boolean> {
    if (this.state.assignments.get(next.id)?.status !== 'PENDING') return false;
    this.state.assignments.set(next.id, next);
    this.state.appendEvents([event]);
    return true;
  }

  async complete(
    next: Assignment,
    report: { readonly report: Report; readonly version: ReportVersion } | null,
    events: readonly TaskEventRecord[],
  ): Promise<boolean> {
    const stored = this.state.assignments.get(next.id);
    if (stored === undefined || !notCompleted(stored)) return false;
    this.state.assignments.set(next.id, {
      ...stored,
      status: 'COMPLETED',
      completedAt: next.completedAt,
    });
    if (report !== null) {
      this.state.reports.set(report.report.id, report.report);
      this.state.versions.set(report.report.id, [report.version]);
    }
    this.state.appendEvents(events);
    return true;
  }

  async reassign(closed: Assignment, opened: Assignment, event: TaskEventRecord): Promise<boolean> {
    const stored = this.state.assignments.get(closed.id);
    if (stored === undefined || !isOpenAssignment(stored)) return false;
    const alreadyHolds = this.state
      .assignmentsOf(opened.taskId)
      .some((a) => a.recipientId === opened.recipientId && isOpenAssignment(a));
    if (alreadyHolds) return false;
    this.state.assignments.set(closed.id, {
      ...stored,
      status: 'REASSIGNED',
      reassignedTo: closed.reassignedTo,
      reassignedAt: closed.reassignedAt,
      reassignedBy: closed.reassignedBy,
    });
    this.state.assignments.set(opened.id, opened);
    this.state.appendEvents([event]);
    return true;
  }
}
