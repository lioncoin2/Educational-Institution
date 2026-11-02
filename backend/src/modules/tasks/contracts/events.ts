import type { DomainEvent } from '../../../shared';

/**
 * The tasks engine's facts (ADR 0052 §11), published after the act and its audit
 * entry. Ids only — never a title, an instruction, a report's text or a name.
 * `aggregateId = taskId`, so one task's facts form one ordered stream. Class R:
 * the tables are the truth; a consumer tolerates duplicates.
 */
export const TasksEvents = {
  published: 'tasks.task.published',
  updated: 'tasks.task.updated',
  cancelled: 'tasks.task.cancelled',
  reminded: 'tasks.task.reminded',
  reassigned: 'tasks.assignment.reassigned',
  acknowledged: 'tasks.assignment.acknowledged',
  completed: 'tasks.assignment.completed',
  reportSubmitted: 'tasks.report.submitted',
  reportChangesRequested: 'tasks.report.changes_requested',
  reportApproved: 'tasks.report.approved',
} as const;

/** A fact addressed to a set of addressees: who it concerns, by id. */
export interface TaskAudienceFact {
  readonly taskId: string;
  readonly actorId: string;
  readonly recipientUserIds: readonly string[];
}

/** A recipient's response, announced to the task's publisher. */
export interface TaskResponseFact {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly recipientId: string;
  readonly publisherId: string;
}

export interface TaskReassignedFact {
  readonly taskId: string;
  readonly actorId: string;
  readonly previousRecipientId: string;
  readonly newRecipientId: string;
}

export interface ReportSubmittedFact {
  readonly taskId: string;
  readonly reportId: string;
  readonly authorId: string;
  readonly publisherId: string;
  /** True when this is a later version (an edit after submission). */
  readonly resubmission: boolean;
}

export interface ReportDecisionFact {
  readonly taskId: string;
  readonly reportId: string;
  readonly authorId: string;
  /** Null when approved automatically. */
  readonly reviewerId: string | null;
}

export type TaskPublished = DomainEvent<typeof TasksEvents.published, TaskAudienceFact>;
export type TaskUpdated = DomainEvent<typeof TasksEvents.updated, TaskAudienceFact>;
export type TaskCancelled = DomainEvent<typeof TasksEvents.cancelled, TaskAudienceFact>;
export type TaskReminded = DomainEvent<typeof TasksEvents.reminded, TaskAudienceFact>;
export type TaskReassigned = DomainEvent<typeof TasksEvents.reassigned, TaskReassignedFact>;
export type TaskAcknowledged = DomainEvent<typeof TasksEvents.acknowledged, TaskResponseFact>;
export type TaskCompleted = DomainEvent<typeof TasksEvents.completed, TaskResponseFact>;
export type ReportSubmitted = DomainEvent<typeof TasksEvents.reportSubmitted, ReportSubmittedFact>;
export type ReportChangesRequested = DomainEvent<
  typeof TasksEvents.reportChangesRequested,
  ReportDecisionFact
>;
export type ReportApproved = DomainEvent<typeof TasksEvents.reportApproved, ReportDecisionFact>;

export type TasksEvent =
  | TaskPublished
  | TaskUpdated
  | TaskCancelled
  | TaskReminded
  | TaskReassigned
  | TaskAcknowledged
  | TaskCompleted
  | ReportSubmitted
  | ReportChangesRequested
  | ReportApproved;
