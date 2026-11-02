/**
 * Tasks persistence ports — the READ side: lists, search, the dashboard and the
 * export (ADR 0052 §12). Read-only; computed by the store over the filtered set
 * so large staffs and long histories never travel to the application layer.
 */

import type { Assignment } from './assignment';
import type { TaskAudience } from './audience';
import type { Report, ReportStatus } from './report';
import type { Task } from './task';
import type { ReportCategory, TaskKind } from './task-config';

export const TASK_READ_MODEL = Symbol('TASK_READ_MODEL');
export const TASK_STATISTICS = Symbol('TASK_STATISTICS');

/** Where a task stands for lists and filters. */
export type TaskState = 'ACTIVE' | 'ARCHIVED' | 'CANCELLED';

/** The common filters of search, the dashboard and the export (roadmap §12, §13, §15). */
export interface TaskFilter {
  /** Published at or after / before (exclusive). */
  readonly from?: Date;
  readonly to?: Date;
  readonly audience?: TaskAudience;
  readonly communityId?: string;
  /** An addressee: tasks they hold or held. */
  readonly personId?: string;
  readonly kind?: TaskKind;
  readonly state?: TaskState;
  readonly reportStatus?: ReportStatus;
  /** Matched literally, case-insensitively, against title and instructions. */
  readonly text?: string;
}

/** Keyset for newest-first lists. */
export interface CreatedKeyset {
  readonly createdAt: Date;
  readonly id: string;
}

export interface TaskCounts {
  /** Open (not reassigned) assignments. */
  readonly targets: number;
  readonly responded: number;
  readonly completed: number;
  readonly reportsPending: number;
  readonly reportsApproved: number;
  readonly reportsChangesRequested: number;
}

export interface TaskSummary {
  readonly task: Task;
  readonly counts: TaskCounts;
}

/** A recipient's view of one of their tasks. */
export interface MyTaskItem {
  readonly assignment: Assignment;
  readonly task: Task;
  readonly report: Report | null;
}

export interface ReportSummary {
  readonly report: Report;
  readonly taskTitle: string;
  readonly taskKind: TaskKind;
  readonly audience: TaskAudience;
}

export interface TaskReadModel {
  listTasks(
    filter: TaskFilter,
    after: CreatedKeyset | null,
    limit: number,
  ): Promise<readonly TaskSummary[]>;
  countsOf(taskId: string): Promise<TaskCounts>;
  /** OPEN = still to do (active task, assignment not completed); DONE = the rest. */
  listMine(
    recipientId: string,
    scope: 'OPEN' | 'DONE',
    after: CreatedKeyset | null,
    limit: number,
  ): Promise<readonly MyTaskItem[]>;
  listReports(
    filter: TaskFilter & { readonly category?: ReportCategory },
    after: { readonly updatedAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly ReportSummary[]>;
}

/** Totals over a set of assignments; rates are derived by the caller. */
export interface ResponseTotals {
  readonly tasks: number;
  readonly tasksArchived: number;
  readonly assignments: number;
  readonly responded: number;
  readonly completed: number;
  readonly reportsApproved: number;
  readonly reportsChangesRequested: number;
  readonly reportsPending: number;
}

export interface TaskStatisticsResult {
  readonly totals: ResponseTotals;
  readonly byAudience: readonly ({ readonly audience: TaskAudience } & ResponseTotals)[];
  /** Tasks narrowed to a community, grouped by it. */
  readonly byCommunity: readonly ({ readonly communityId: string } & ResponseTotals)[];
  /** Per person — alphabetical by id, never ranked (roadmap §12). */
  readonly byPerson: readonly ({ readonly personId: string } & ResponseTotals)[];
}

/** One row of the export: one assignment of one task, with its report state. */
export interface ExportRow {
  readonly task: Task;
  readonly assignment: Assignment;
  readonly report: Report | null;
}

export interface TaskStatistics {
  summarize(filter: TaskFilter, personLimit: number): Promise<TaskStatisticsResult>;
  exportRows(filter: TaskFilter, limit: number): Promise<readonly ExportRow[]>;
}
