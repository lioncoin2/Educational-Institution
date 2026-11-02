/**
 * Tasks persistence ports — the WRITE side (ADR 0052 §1).
 *
 * Every write method is ONE act and is atomic: it writes the act's rows and its
 * operation-log rows in one transaction, guarded by conditional updates and the
 * database's unique constraints, and reports a lost race as an outcome rather
 * than an exception. A Drizzle adapter backs each port when a database is
 * configured, an in-memory twin otherwise — chosen in the module, never here.
 */

import type { Assignment } from './assignment';
import type { Report, ReportReview, ReportVersion } from './report';
import type { Task, TaskRevision } from './task';
import type { TaskEventEntry, TaskEventRecord } from './task-event';
import type { TaskTemplate } from './template';

export const TASK_REPOSITORY = Symbol('TASK_REPOSITORY');
export const ASSIGNMENT_REPOSITORY = Symbol('ASSIGNMENT_REPOSITORY');
export const REPORT_REPOSITORY = Symbol('REPORT_REPOSITORY');
export const TASK_EVENT_LOG = Symbol('TASK_EVENT_LOG');
export const TEMPLATE_REPOSITORY = Symbol('TEMPLATE_REPOSITORY');

/** A publish carrying a key its creator already used returns the existing task. */
export type PublishOutcome =
  | { readonly status: 'created'; readonly task: Task }
  | { readonly status: 'duplicate'; readonly task: Task };

export interface TaskRepository {
  /** Task + revision 1 + every assignment + the log row, at once; idempotent per (creator, key). */
  publish(input: {
    readonly task: Task;
    readonly assignments: readonly Assignment[];
    readonly clientRequestId: string | null;
    readonly event: TaskEventRecord;
  }): Promise<PublishOutcome>;

  findById(id: string): Promise<Task | null>;

  /**
   * The next revision, applied only if the stored task is still at
   * `next.revision - 1` (else `stale`). With `revision.requireReacknowledge`,
   * every open, not-completed assignment returns to PENDING in the same act.
   */
  edit(next: Task, revision: TaskRevision, event: TaskEventRecord): Promise<'saved' | 'stale'>;

  /** Every revision of the task, oldest first. */
  revisions(taskId: string): Promise<readonly TaskRevision[]>;

  /**
   * A lifecycle change (cancel, reopen), applied only if the stored status and
   * archive state are still those of `expected` (else false).
   */
  changeLifecycle(next: Task, expected: Task, event: TaskEventRecord): Promise<boolean>;

  /**
   * Archives the task if it is settled (`isTaskSettled`), logging it as the
   * system's act. True when this call archived it.
   */
  archiveIfSettled(taskId: string, at: Date): Promise<boolean>;
}

export type AssignmentFilter =
  'ALL' | 'RESPONDED' | 'NOT_RESPONDED' | 'COMPLETED' | 'NOT_COMPLETED';

export interface AssignmentRepository {
  findById(id: string): Promise<Assignment | null>;

  /** One task's assignments (closed ones included), in id order, after `afterId`. */
  listByTask(
    taskId: string,
    filter: AssignmentFilter,
    afterId: string | null,
    limit: number,
  ): Promise<readonly Assignment[]>;

  /** The person's current (not handed-over) assignment of a task, if any. */
  findOpenFor(taskId: string, recipientId: string): Promise<Assignment | null>;

  /** Open assignments with no response at all — who a reminder reaches. */
  nonResponders(taskId: string): Promise<readonly Assignment[]>;

  /** Open assignments not yet completed — who an edit or a cancellation concerns. */
  openNotCompleted(taskId: string): Promise<readonly Assignment[]>;

  /** PENDING → ACKNOWLEDGED (or COMPLETED when acknowledging completes). False if it moved. */
  acknowledge(next: Assignment, event: TaskEventRecord): Promise<boolean>;

  /**
   * → COMPLETED, with the first report (and its version) when one comes with it.
   * False if it was already completed or closed meanwhile.
   */
  complete(
    next: Assignment,
    report: { readonly report: Report; readonly version: ReportVersion } | null,
    events: readonly TaskEventRecord[],
  ): Promise<boolean>;

  /**
   * Closes `closed` and opens `opened` for the new addressee. False if `closed`
   * was closed meanwhile or the new addressee already holds the task.
   */
  reassign(closed: Assignment, opened: Assignment, event: TaskEventRecord): Promise<boolean>;
}

export interface ReportRepository {
  findById(id: string): Promise<Report | null>;
  findByAssignment(assignmentId: string): Promise<Report | null>;
  /** The reports of several assignments at once, by assignment id (absent = none). */
  findByAssignments(assignmentIds: readonly string[]): Promise<ReadonlyMap<string, Report>>;

  /** A new version; applied only if the stored report is still at `next.version - 1`. */
  writeVersion(
    next: Report,
    version: ReportVersion,
    event: TaskEventRecord,
  ): Promise<'saved' | 'stale'>;

  /** A decision about the current version, if it is still that version and still pending. */
  review(next: Report, review: ReportReview, event: TaskEventRecord): Promise<boolean>;

  /** DELETED (versions kept), if not already deleted. */
  softDelete(next: Report, event: TaskEventRecord): Promise<boolean>;

  versions(reportId: string): Promise<readonly ReportVersion[]>;
  reviews(reportId: string): Promise<readonly ReportReview[]>;
}

export interface TaskEventLog {
  /** An act that writes nothing else (a reminder). */
  append(event: TaskEventRecord): Promise<void>;

  /** The task's log, oldest first, after `afterSequence`. */
  list(
    taskId: string,
    afterSequence: number | null,
    limit: number,
  ): Promise<readonly TaskEventEntry[]>;
}

export interface TemplateRepository {
  create(template: TaskTemplate): Promise<void>;
  findById(id: string): Promise<TaskTemplate | null>;
  /** Newest first, keyset by (createdAt, id). */
  list(
    after: { readonly createdAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly TaskTemplate[]>;
  /** True when it existed. */
  delete(id: string): Promise<boolean>;
}
