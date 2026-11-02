import { err, failure, ok, type Result } from '../../../shared';
import type { TaskAudience } from './audience';
import { completionMethod, type TaskSettings } from './task-config';

/**
 * One addressee of one task (ADR 0052 §5): PENDING → ACKNOWLEDGED → COMPLETED,
 * or REASSIGNED — closed, its responses kept, a new assignment created for the
 * new addressee and linked both ways (roadmap §11).
 */
export const ASSIGNMENT_STATUSES = ['PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'REASSIGNED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export interface Assignment {
  readonly id: string;
  readonly taskId: string;
  readonly recipientId: string;
  /** Which audience addressed this person (the first that matched, in canonical order). */
  readonly audience: TaskAudience;
  readonly status: AssignmentStatus;
  readonly acknowledgedAt: Date | null;
  /** The task revision that was acknowledged — re-acknowledgement resets it. */
  readonly acknowledgedRevision: number | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  /** Set on the closed assignment when it was handed to someone else. */
  readonly reassignedTo: string | null;
  readonly reassignedAt: Date | null;
  readonly reassignedBy: string | null;
  /** Set on the new assignment: the one it replaced. */
  readonly replaces: string | null;
}

const NOT_YOURS_ANYMORE = failure(
  'precondition_failed',
  'tasks.assignment_closed',
  'This task was handed to someone else.',
);

/** Still the addressee's to act on — not handed over. */
export function isOpenAssignment(assignment: Assignment): boolean {
  return assignment.status !== 'REASSIGNED';
}

/** Has the addressee answered at all — the line between "responded" and "not responded". */
export function hasResponded(assignment: Assignment): boolean {
  return assignment.acknowledgedAt !== null || assignment.completedAt !== null;
}

/** Acknowledging needs the button and an open, not-yet-acknowledged assignment. */
export function checkAcknowledge(
  assignment: Assignment,
  settings: TaskSettings,
): Result<'acknowledge' | 'already'> {
  if (!isOpenAssignment(assignment)) return err(NOT_YOURS_ANYMORE);
  if (!settings.buttons.includes('ACKNOWLEDGE')) {
    return err(
      failure(
        'precondition_failed',
        'tasks.no_acknowledge',
        'This task has no acknowledge button.',
      ),
    );
  }
  if (assignment.acknowledgedAt !== null || assignment.status === 'COMPLETED') return ok('already');
  return ok('acknowledge');
}

/**
 * Completing follows the task's completion method. With an acknowledge button,
 * acknowledgement comes first (roadmap §3). A required report must come with it
 * — the use case checks the text; this checks the order and the method.
 */
export function checkComplete(
  assignment: Assignment,
  settings: TaskSettings,
  via: 'button' | 'report',
): Result<'complete' | 'already'> {
  if (!isOpenAssignment(assignment)) return err(NOT_YOURS_ANYMORE);
  if (assignment.status === 'COMPLETED') return ok('already');
  const method = completionMethod(settings);
  if (method === 'ACKNOWLEDGE') {
    return err(
      failure(
        'precondition_failed',
        'tasks.complete_by_acknowledge',
        'Acknowledging completes it.',
      ),
    );
  }
  if (via === 'button' && method !== 'BUTTON') {
    return err(
      failure('precondition_failed', 'tasks.no_complete_button', 'Submit the report to complete.'),
    );
  }
  if (settings.buttons.includes('ACKNOWLEDGE') && assignment.acknowledgedAt === null) {
    return err(
      failure('precondition_failed', 'tasks.acknowledge_first', 'Acknowledge the task first.'),
    );
  }
  return ok('complete');
}

/** Whether acknowledging, by itself, completes the assignment (no button, no report). */
export function acknowledgementCompletes(settings: TaskSettings): boolean {
  return completionMethod(settings) === 'ACKNOWLEDGE';
}
