import { isOpenAssignment, type Assignment } from './assignment';
import { isSettled, type Report } from './report';
import type { Task } from './task';

/**
 * The archive rule (ADR 0052 §5; roadmap §15): an open task is settled — and
 * moves to the archive — when it has at least one addressee still holding it,
 * every one of them has completed, and, when a report is required, every one
 * of their reports is approved. Reassigned (closed) assignments do not count:
 * the person who took them over does.
 *
 * This is the rule's one definition. The in-memory store applies it directly;
 * the Postgres adapter applies it as one guarded UPDATE, and the integration
 * suite pins the two to the same answers.
 */
export function isTaskSettled(
  task: Task,
  assignments: readonly Assignment[],
  reportsByAssignment: ReadonlyMap<string, Report>,
): boolean {
  if (task.status !== 'OPEN' || task.archivedAt !== null) return false;
  const open = assignments.filter(isOpenAssignment);
  if (open.length === 0) return false;
  return open.every((assignment) => {
    if (assignment.status !== 'COMPLETED') return false;
    if (!task.reportRequired) return true;
    const report = reportsByAssignment.get(assignment.id);
    return report !== undefined && isSettled(report);
  });
}
