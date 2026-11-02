import { failure, type Failure } from '../../../shared';

/**
 * The tasks engine's stable refusals (`tasks.<reason>`), each defined once.
 * Validation refusals that belong to a rule live with that rule in the domain.
 */
export const TASK_NOT_FOUND: Failure = failure(
  'not_found',
  'tasks.task_not_found',
  'No such task.',
);

export const ASSIGNMENT_NOT_FOUND: Failure = failure(
  'not_found',
  'tasks.assignment_not_found',
  'No such task for you.',
);

export const REPORT_NOT_FOUND: Failure = failure(
  'not_found',
  'tasks.report_not_found',
  'No such report.',
);

export const TEMPLATE_NOT_FOUND: Failure = failure(
  'not_found',
  'tasks.template_not_found',
  'No such template.',
);

export const TASK_NOT_ACTIVE: Failure = failure(
  'precondition_failed',
  'tasks.task_not_active',
  'This task is cancelled or archived.',
);

export const TASK_NOT_REOPENABLE: Failure = failure(
  'precondition_failed',
  'tasks.task_not_reopenable',
  'Only an archived or cancelled task can be reopened.',
);

export const REVISION_CONFLICT: Failure = failure(
  'conflict',
  'tasks.revision_conflict',
  'The task was changed meanwhile; read it again.',
);

export const CHANGED_MEANWHILE: Failure = failure(
  'conflict',
  'tasks.changed_meanwhile',
  'Someone else acted on this meanwhile; read it again.',
);

export const AUDIENCE_INVALID: Failure = failure(
  'validation',
  'tasks.audience_invalid',
  'Choose at least one of: TEACHERS, SUPERVISORS, ADMINISTRATION.',
);

export const NO_RECIPIENTS: Failure = failure(
  'precondition_failed',
  'tasks.no_recipients',
  'Nobody in the chosen audience can receive this task.',
);

export const COMMUNITY_NOT_FOUND: Failure = failure(
  'not_found',
  'tasks.community_not_found',
  'No such community.',
);

export const REASSIGN_TARGET_INVALID: Failure = failure(
  'validation',
  'tasks.reassign_target_invalid',
  'The new holder must be an active member of the task’s audience who does not already hold it.',
);

export const SETTINGS_INVALID: Failure = failure(
  'validation',
  'tasks.settings_invalid',
  'Unknown task kind, button or approval mode.',
);

export const SETTINGS_LOCKED: Failure = failure(
  'precondition_failed',
  'tasks.settings_locked',
  'Buttons, the report requirement and the approval mode cannot change once someone has responded.',
);

export const ASSIGNMENT_NOT_PENDING: Failure = failure(
  'precondition_failed',
  'tasks.assignment_not_pending',
  'Only a task someone has not completed can be handed to another person.',
);
