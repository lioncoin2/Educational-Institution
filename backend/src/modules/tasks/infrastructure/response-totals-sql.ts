import { sql } from 'drizzle-orm';

import type { ResponseTotals, TaskCounts } from '../domain/read-ports';
import { tasks, tasksAssignments as a, tasksReports as r } from './schema';

/**
 * The response counts over a set of assignments (left-joined to their reports
 * on `tasks_reports.assignment_id`),
 * as aggregate expressions — the one definition shared by a task's counts and
 * the dashboard's totals. A reassigned (closed) assignment is never counted:
 * whoever took it over is.
 */
const live = sql`${a.status} <> 'REASSIGNED'`;

export const countColumns = {
  targets: sql<number>`count(*) filter (where ${live})::int`,
  responded: sql<number>`count(*) filter (where ${live} and (${a.acknowledgedAt} is not null or ${a.completedAt} is not null))::int`,
  completed: sql<number>`count(*) filter (where ${a.status} = 'COMPLETED')::int`,
  reportsPending: sql<number>`count(${r.id}) filter (where ${live} and ${r.status} = 'PENDING_REVIEW')::int`,
  reportsApproved: sql<number>`count(${r.id}) filter (where ${live} and ${r.status} = 'APPROVED')::int`,
  reportsChangesRequested: sql<number>`count(${r.id}) filter (where ${live} and ${r.status} = 'CHANGES_REQUESTED')::int`,
};

export const totalsColumns = {
  tasks: sql<number>`count(distinct ${tasks.id})::int`,
  tasksArchived: sql<number>`count(distinct ${tasks.id}) filter (where ${tasks.archivedAt} is not null)::int`,
  ...countColumns,
};

export const EMPTY_COUNTS: TaskCounts = Object.freeze({
  targets: 0,
  responded: 0,
  completed: 0,
  reportsPending: 0,
  reportsApproved: 0,
  reportsChangesRequested: 0,
});

/** Renames the counted `targets` to the dashboard's `assignments`. */
export function toTotals(
  row: TaskCounts & { tasks: number; tasksArchived: number },
): ResponseTotals {
  return {
    tasks: row.tasks,
    tasksArchived: row.tasksArchived,
    assignments: row.targets,
    responded: row.responded,
    completed: row.completed,
    reportsApproved: row.reportsApproved,
    reportsChangesRequested: row.reportsChangesRequested,
    reportsPending: row.reportsPending,
  };
}
