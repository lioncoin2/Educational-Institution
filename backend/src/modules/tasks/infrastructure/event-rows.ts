import type { TaskEventRecord } from '../domain/task-event';
import { tasksEvents } from './schema';
import type { Executor } from './transaction';

/**
 * Writes an act's operation-log rows on the act's own transaction, so an act and
 * its record of who did it are stored together or not at all (ADR 0052 §1, §9).
 */
export async function insertEvents(
  executor: Executor,
  events: readonly TaskEventRecord[],
): Promise<void> {
  if (events.length === 0) return;
  await executor.insert(tasksEvents).values(
    events.map((event) => ({
      taskId: event.taskId,
      action: event.action,
      actorId: event.actorId,
      assignmentId: event.assignmentId,
      reportId: event.reportId,
      detail: { ...event.detail },
      occurredAt: event.occurredAt,
    })),
  );
}
