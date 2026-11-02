import type { TaskAudience } from './audience';
import type { TaskContent, TaskSettings } from './task-config';

/**
 * One published task (ADR 0052 §3, §5): an independent assignment of work for a
 * day or period — never a standing obligation. Its content and settings are the
 * CURRENT revision; earlier revisions live in the revision history.
 *
 * Lifecycle: OPEN → CANCELLED. Archiving is independent of it: `archivedAt` is
 * set when the task is settled (every addressee done, every required report
 * approved) or cancelled, and cleared when the task is reopened.
 */
export const TASK_STATUSES = ['OPEN', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task extends TaskContent, TaskSettings {
  readonly id: string;
  readonly audiences: readonly TaskAudience[];
  /** An existing community the audience was narrowed to, or null for the whole audience. */
  readonly communityId: string | null;
  /** 1 as published; +1 per edit. Edits name the revision they change. */
  readonly revision: number;
  readonly status: TaskStatus;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
  readonly archivedAt: Date | null;
  /** The template it was published from, if any — provenance only. */
  readonly templateId: string | null;
  /** The earlier task it re-publishes, if any — provenance only. */
  readonly republishedFrom: string | null;
}

/** A revision as stored in the history: who changed what, and whether re-acknowledgement was asked. */
export interface TaskRevision extends TaskContent, TaskSettings {
  readonly taskId: string;
  readonly revision: number;
  readonly editedBy: string;
  readonly editedAt: Date;
  readonly requireReacknowledge: boolean;
}

/** Only an open, unarchived task takes responses, edits, reminders and reassignments. */
export function isActive(task: Task): boolean {
  return task.status === 'OPEN' && task.archivedAt === null;
}

/** An archived task — settled or cancelled — may be reopened; an active one may not. */
export function isReopenable(task: Task): boolean {
  return task.archivedAt !== null || task.status === 'CANCELLED';
}

/** The task with an edit applied, as the next revision. Pure; persistence records it. */
export function applyEdit(task: Task, change: TaskContent & TaskSettings, at: Date): Task {
  return { ...task, ...change, revision: task.revision + 1, updatedAt: at };
}

export function cancel(task: Task, by: string, at: Date): Task {
  return {
    ...task,
    status: 'CANCELLED',
    cancelledAt: at,
    cancelledBy: by,
    archivedAt: at,
    updatedAt: at,
  };
}

export function reopen(task: Task, at: Date): Task {
  return {
    ...task,
    status: 'OPEN',
    cancelledAt: null,
    cancelledBy: null,
    archivedAt: null,
    updatedAt: at,
  };
}

/** Revision 1 in the history: the task exactly as published. */
export function initialRevision(task: Task): TaskRevision {
  return {
    taskId: task.id,
    revision: 1,
    title: task.title,
    body: task.body,
    kind: task.kind,
    buttons: task.buttons,
    reportRequired: task.reportRequired,
    approvalMode: task.approvalMode,
    editedBy: task.createdBy,
    editedAt: task.createdAt,
    requireReacknowledge: false,
  };
}
