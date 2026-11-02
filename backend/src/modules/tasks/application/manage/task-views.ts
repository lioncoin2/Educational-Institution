import type { Assignment } from '../../domain/assignment';
import type { TaskCounts } from '../../domain/read-ports';
import type { Report } from '../../domain/report';
import type { Task, TaskRevision } from '../../domain/task';
import type { TaskEventEntry } from '../../domain/task-event';

/** What the administration's screens are given (ADR 0052 §4, §12). */

export interface TaskOverview {
  readonly task: Task;
  readonly counts: TaskCounts;
}

export interface TaskDetail extends TaskOverview {
  readonly revisions: readonly TaskRevision[];
  readonly names: ReadonlyMap<string, string>;
}

/** One addressee on the follow-up page: their state and their report's. */
export interface TrackingRow {
  readonly assignment: Assignment;
  readonly report: Report | null;
}

export interface TrackingPage {
  readonly items: readonly TrackingRow[];
  readonly names: ReadonlyMap<string, string>;
  readonly nextCursor?: string;
}

export interface HistoryPage {
  readonly items: readonly TaskEventEntry[];
  readonly names: ReadonlyMap<string, string>;
  readonly nextCursor?: string;
}
