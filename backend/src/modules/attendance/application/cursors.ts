import { err, ok, type Result } from '../../../shared';
import { AttendanceRefusals } from './attendance-settings';

/**
 * Opaque page cursors for attendance's keyset reads (attendance.md §7). Base64url
 * of the position the next page continues from, so the key behind a list can
 * change without breaking a client that merely hands a cursor back.
 *
 * Two shapes, because the two listings have different keys:
 *   - the community list is ordered `(observedAt, id)` (newest first);
 *   - a snapshot's entries are ordered by `userId`.
 *
 * `decode*` throws `RangeError` on a malformed cursor; the repository port
 * returns `Page` (no error channel), so it decodes a cursor only after the view
 * use case has validated it. That validation is `validate*Cursor` below: a
 * Result-returning check the use case runs first, mapping a bad cursor to
 * `attendance.cursor_invalid` (422, §15.2) before any repository call — the
 * house pattern (communities/live decode in the application layer). The opaque
 * cursor is then passed to the repository unchanged.
 */

export interface SnapshotKeyset {
  readonly observedAt: Date;
  readonly id: string;
}

export function encodeSnapshotCursor(key: SnapshotKeyset): string {
  return Buffer.from(JSON.stringify([key.observedAt.toISOString(), key.id])).toString('base64url');
}

export function decodeSnapshotCursor(raw: string): SnapshotKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new RangeError('malformed attendance snapshot cursor');
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 2 &&
    typeof parsed[0] === 'string' &&
    typeof parsed[1] === 'string'
  ) {
    const observedAt = new Date(parsed[0]);
    if (!Number.isNaN(observedAt.getTime())) return { observedAt, id: parsed[1] };
  }
  throw new RangeError('malformed attendance snapshot cursor');
}

export function encodeEntryCursor(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

export function decodeEntryCursor(raw: string): string {
  const userId = Buffer.from(raw, 'base64url').toString('utf8');
  if (userId.length === 0) throw new RangeError('malformed attendance entry cursor');
  return userId;
}

/**
 * Validate a community-list cursor before the repository sees it (§15.2). An
 * absent cursor is the first page (valid); a present one that does not decode is
 * `attendance.cursor_invalid` (422). The use case passes the opaque cursor to
 * the repository unchanged once this returns ok.
 */
export function validateSnapshotCursor(raw: string | undefined): Result<void> {
  if (raw === undefined) return ok(undefined);
  try {
    decodeSnapshotCursor(raw);
    return ok(undefined);
  } catch {
    return err(AttendanceRefusals.cursorInvalid);
  }
}

/** Validate a participant-entries cursor before the repository sees it (§15.2). */
export function validateEntryCursor(raw: string | undefined): Result<void> {
  if (raw === undefined) return ok(undefined);
  try {
    decodeEntryCursor(raw);
    return ok(undefined);
  } catch {
    return err(AttendanceRefusals.cursorInvalid);
  }
}
