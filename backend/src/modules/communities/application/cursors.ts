import { err, failure, ok, type Result } from '../../../shared';
import type { Keyset } from '../domain/ports';

/**
 * Page cursors are opaque to clients: base64url of the (instant, id) the next
 * page continues from — so the key behind a list can change without breaking
 * a client that merely hands a cursor back.
 */
const INVALID = failure(
  'validation',
  'communities.cursor_invalid',
  'That page cursor is not valid.',
);

const ID_SHAPE = /^[A-Za-z0-9:_-]{1,128}$/;

export function encodeCursor(key: Keyset): string {
  return Buffer.from(JSON.stringify([key.at.toISOString(), key.id])).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Result<Keyset | undefined> {
  if (raw === undefined) return ok(undefined);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      ID_SHAPE.test(parsed[1])
    ) {
      const at = new Date(parsed[0]);
      if (!Number.isNaN(at.getTime())) return ok({ at, id: parsed[1] });
    }
  } catch {
    // Falls through: whatever it was, it was not one of ours.
  }
  return err(INVALID);
}

/**
 * One page from `limit + 1` rows: the extra row only says whether there is
 * more, and the cursor is the position of the last row shown.
 */
export function paged<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => Keyset,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}

/**
 * The membership contract's cursor: the last user id returned, opaque. A
 * cursor this contract did not issue is a programming error in the caller,
 * so it throws a RangeError rather than failing a request.
 */
const MEMBER_CURSOR_PREFIX = 'm1:';

export function encodeMemberCursor(userId: string): string {
  return Buffer.from(`${MEMBER_CURSOR_PREFIX}${userId}`).toString('base64url');
}

export function decodeMemberCursor(raw: string): string {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const userId = decoded.slice(MEMBER_CURSOR_PREFIX.length);
  if (!decoded.startsWith(MEMBER_CURSOR_PREFIX) || !ID_SHAPE.test(userId)) {
    throw new RangeError('That member cursor was not issued by COMMUNITY_MEMBERSHIP.');
  }
  return userId;
}
