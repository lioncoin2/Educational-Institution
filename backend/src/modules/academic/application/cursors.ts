import { err, failure, ok, type Result } from '../../../shared';
import type { Keyset } from '../domain/ports';

/**
 * Page cursors are opaque to clients: base64url of the (instant, id) the next
 * page continues from. Opaque, so the key behind a list can change without
 * breaking a client that merely hands a cursor back.
 */
const INVALID = failure('validation', 'academic.cursor_invalid', 'That page cursor is not valid.');

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
      /^[A-Za-z0-9_-]{1,128}$/.test(parsed[1])
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
