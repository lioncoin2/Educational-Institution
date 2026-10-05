/**
 * Opaque page cursors for attendance's keyset reads (attendance.md §7). Base64url
 * of the position the next page continues from, so the key behind a list can
 * change without breaking a client that merely hands a cursor back.
 *
 * Two shapes, because the two listings have different keys:
 *   - the community list is ordered `(observedAt, id)` (newest first);
 *   - a snapshot's entries are ordered by `userId`.
 *
 * `decode*` throws `RangeError` on a malformed cursor; the committed repository
 * port returns `Page` (no error channel), so the mapping of a bad cursor to
 * `attendance.cursor_invalid` (422, §15.2) is the view use case's concern when
 * that slice lands — this codec only round-trips a valid cursor.
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
