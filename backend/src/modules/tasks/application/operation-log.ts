import type { TaskEventAction, TaskEventRecord } from '../domain/task-event';

/** One operation-log row (ADR 0052 §9): ids and codes only. */
export function logEntry(
  action: TaskEventAction,
  taskId: string,
  actorId: string | null,
  at: Date,
  refs: {
    readonly assignmentId?: string;
    readonly reportId?: string;
    readonly detail?: TaskEventRecord['detail'];
  } = {},
): TaskEventRecord {
  return {
    taskId,
    action,
    actorId,
    assignmentId: refs.assignmentId ?? null,
    reportId: refs.reportId ?? null,
    detail: refs.detail ?? {},
    occurredAt: at,
  };
}
