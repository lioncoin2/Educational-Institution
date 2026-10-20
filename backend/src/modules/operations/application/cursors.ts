/**
 * Opaque keyset cursors for lesson lists — base64url of `[scheduledAtISO, id]`.
 * Keyset paging (not offset) keeps a growing table's later pages cheap and
 * deterministic; ordering is always (`scheduledAt`, `id`) ascending.
 */

import { err, failure, ok, type Result } from '../../../shared';
import type { Lesson } from '../domain/lesson';
import type { LessonKeyset } from '../domain/ports';

const CURSOR_INVALID = failure(
  'validation',
  'operations.cursor_invalid',
  'The page cursor is not valid.',
);

export function encodeLessonCursor(key: LessonKeyset): string {
  return Buffer.from(JSON.stringify([key.scheduledAt.toISOString(), key.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeLessonCursor(raw: string | undefined): Result<LessonKeyset | undefined> {
  if (raw === undefined || raw === '') return ok(undefined);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    ) {
      return err(CURSOR_INVALID);
    }
    const at = new Date(parsed[0]);
    if (Number.isNaN(at.getTime())) return err(CURSOR_INVALID);
    return ok({ scheduledAt: at, id: parsed[1] });
  } catch {
    return err(CURSOR_INVALID);
  }
}

/**
 * Turn `limit + 1` fetched rows into a page of at most `limit`, with a
 * `nextCursor` when more exist. The extra row is only a lookahead; it is never
 * returned.
 */
export function pagedLessons(
  rows: readonly Lesson[],
  limit: number,
): { readonly items: readonly Lesson[]; readonly nextCursor?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: encodeLessonCursor({ scheduledAt: last.scheduledAt, id: last.id }) };
}
