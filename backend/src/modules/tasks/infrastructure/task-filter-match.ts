import { hasResponded, isOpenAssignment, type Assignment } from '../domain/assignment';
import type { TaskCounts, TaskFilter } from '../domain/read-ports';
import type { Report } from '../domain/report';
import type { Task } from '../domain/task';
import type { InMemoryTasksState } from './in-memory-tasks-state';

/**
 * The common filters (ADR 0052 §12) as predicates over the in-memory state —
 * the twin of `task-filter-sql.ts`, kept to the same meaning by the adapter
 * tests that run both.
 */
export function taskMatches(task: Task, filter: TaskFilter, state: InMemoryTasksState): boolean {
  const text = filter.text?.trim().toLowerCase() ?? '';
  if (filter.from !== undefined && task.createdAt < filter.from) return false;
  if (filter.to !== undefined && task.createdAt >= filter.to) return false;
  if (filter.audience !== undefined && !task.audiences.includes(filter.audience)) return false;
  if (filter.communityId !== undefined && task.communityId !== filter.communityId) return false;
  if (filter.kind !== undefined && task.kind !== filter.kind) return false;
  if (filter.state !== undefined && stateOf(task) !== filter.state) return false;
  if (
    filter.personId !== undefined &&
    !state.assignmentsOf(task.id).some((a) => a.recipientId === filter.personId)
  ) {
    return false;
  }
  if (
    filter.reportStatus !== undefined &&
    ![...state.reportsByAssignment(task.id).values()].some((r) => r.status === filter.reportStatus)
  ) {
    return false;
  }
  if (
    text !== '' &&
    !task.title.toLowerCase().includes(text) &&
    !task.body.toLowerCase().includes(text)
  ) {
    return false;
  }
  return true;
}

export function assignmentMatches(assignment: Assignment, filter: TaskFilter): boolean {
  if (filter.audience !== undefined && assignment.audience !== filter.audience) return false;
  if (filter.personId !== undefined && assignment.recipientId !== filter.personId) return false;
  return true;
}

export function stateOf(task: Task): 'ACTIVE' | 'ARCHIVED' | 'CANCELLED' {
  if (task.status === 'CANCELLED') return 'CANCELLED';
  return task.archivedAt === null ? 'ACTIVE' : 'ARCHIVED';
}

/** The response counts over assignments — the twin of `response-totals-sql.ts`. */
export function countResponses(
  assignments: readonly Assignment[],
  reports: ReadonlyMap<string, Report>,
): TaskCounts {
  const live = assignments.filter(isOpenAssignment);
  const statusOf = (a: Assignment) => reports.get(a.id)?.status;
  return {
    targets: live.length,
    responded: live.filter(hasResponded).length,
    completed: live.filter((a) => a.status === 'COMPLETED').length,
    reportsPending: live.filter((a) => statusOf(a) === 'PENDING_REVIEW').length,
    reportsApproved: live.filter((a) => statusOf(a) === 'APPROVED').length,
    reportsChangesRequested: live.filter((a) => statusOf(a) === 'CHANGES_REQUESTED').length,
  };
}

/** Newest first by (at, id). */
export function newestFirst<T>(key: (item: T) => { at: Date; id: string }) {
  return (a: T, b: T): number => {
    const x = key(a);
    const y = key(b);
    return y.at.getTime() - x.at.getTime() || y.id.localeCompare(x.id);
  };
}

/** Strictly after a newest-first keyset position. */
export function isAfter(
  item: { at: Date; id: string },
  after: { at: Date; id: string } | null,
): boolean {
  if (after === null) return true;
  const t = item.at.getTime();
  const u = after.at.getTime();
  return t < u || (t === u && item.id < after.id);
}
