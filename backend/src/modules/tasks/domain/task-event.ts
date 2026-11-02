/**
 * The operation log (ADR 0052 §9; roadmap §7 "سجل العمليات"): one row per act,
 * who did it and when, with ids only. Written in the same transaction as the act
 * it records. Report text never enters it.
 */
export const TASK_EVENT_ACTIONS = [
  'TASK_PUBLISHED',
  'TASK_EDITED',
  'TASK_CANCELLED',
  'TASK_REOPENED',
  'TASK_ARCHIVED',
  'TASK_REMINDED',
  'ASSIGNMENT_ACKNOWLEDGED',
  'ASSIGNMENT_COMPLETED',
  'ASSIGNMENT_REASSIGNED',
  'REPORT_SUBMITTED',
  'REPORT_EDITED',
  'REPORT_DELETED',
  'REPORT_APPROVED',
  'REPORT_CHANGES_REQUESTED',
] as const;
export type TaskEventAction = (typeof TASK_EVENT_ACTIONS)[number];

export interface TaskEventRecord {
  readonly taskId: string;
  readonly action: TaskEventAction;
  /** Null only for the system (an automatic archive or approval). */
  readonly actorId: string | null;
  readonly assignmentId: string | null;
  readonly reportId: string | null;
  /** Ids, counts and codes only — never names, never report text. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: Date;
}

/** A stored log row: the record plus its position in the task's log. */
export interface TaskEventEntry extends TaskEventRecord {
  readonly sequence: number;
}
