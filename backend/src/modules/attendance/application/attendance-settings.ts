import { failure } from '../../../shared';

/**
 * How `AttendanceAccess` reports a refusal (attendance.md §11.3). Each maps a
 * Communities answer to an attendance code and its HTTP status; **none uses an
 * `attendance.*` identity permission** — those stay reserved for operations'
 * `AttendanceRecord` (attendance.md §11.2), and a grep test forbids the strings
 * under `src/modules/attendance/`.
 */
export const AttendanceRefusals = {
  /** 404 — the record path: the same body as an unknown session. */
  sessionNotFound: failure('not_found', 'attendance.session_not_found', 'No such live session.'),
  /** 404 — the community-list path. */
  communityNotFound: failure('not_found', 'attendance.community_not_found', 'No such community.'),
  /** 404 — the single-snapshot path: a member without the view act is told this, never 403. */
  snapshotNotFound: failure('not_found', 'attendance.snapshot_not_found', 'No such snapshot.'),
  /** 422 — a page cursor that does not decode (attendance.md §15.2). */
  cursorInvalid: failure(
    'validation',
    'attendance.cursor_invalid',
    'That page cursor is not valid.',
  ),
  /** 403 — a member of the community who holds no act in the fallback order. */
  notAllowed: failure('forbidden', 'attendance.not_allowed', 'You may not do this here.'),
  /** 412 — the community is locked and the act is not permitted while locked. */
  communityNotOpen: failure(
    'precondition_failed',
    'attendance.community_not_open',
    'This community is not open.',
  ),
  /** 503 — Communities could not answer; the request fails closed. */
  unavailable: failure(
    'unavailable',
    'attendance.unavailable',
    'Attendance is temporarily unavailable.',
  ),
} as const;
