/**
 * Opaque keyset cursors for the tasks engine's lists — base64url of
 * `[instantISO, id]` for newest-first lists, or of `[id]` / `[sequence]` for
 * id- and log-ordered ones. Keyset (never offset) keeps later pages cheap.
 */

import { err, failure, ok, type Result } from '../../../shared';

const CURSOR_INVALID = failure(
  'validation',
  'tasks.cursor_invalid',
  'The page cursor is not valid.',
);

export interface InstantKeyset {
  readonly at: Date;
  readonly id: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(raw: string): unknown {
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
}

export function encodeInstantCursor(key: InstantKeyset): string {
  return encode([key.at.toISOString(), key.id]);
}

export function decodeInstantCursor(raw: string | undefined): Result<InstantKeyset | null> {
  if (raw === undefined || raw === '') return ok(null);
  try {
    const parsed = decode(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) return err(CURSOR_INVALID);
    const [iso, id] = parsed as unknown[];
    if (typeof iso !== 'string' || typeof id !== 'string') return err(CURSOR_INVALID);
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? err(CURSOR_INVALID) : ok({ at, id });
  } catch {
    return err(CURSOR_INVALID);
  }
}

export function encodeIdCursor(id: string): string {
  return encode([id]);
}

export function decodeIdCursor(raw: string | undefined): Result<string | null> {
  if (raw === undefined || raw === '') return ok(null);
  try {
    const parsed = decode(raw);
    return Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string'
      ? ok(parsed[0])
      : err(CURSOR_INVALID);
  } catch {
    return err(CURSOR_INVALID);
  }
}

export function encodeSequenceCursor(sequence: number): string {
  return encode([sequence]);
}

export function decodeSequenceCursor(raw: string | undefined): Result<number | null> {
  if (raw === undefined || raw === '') return ok(null);
  try {
    const parsed = decode(raw);
    return Array.isArray(parsed) && parsed.length === 1 && Number.isInteger(parsed[0])
      ? ok(parsed[0] as number)
      : err(CURSOR_INVALID);
  } catch {
    return err(CURSOR_INVALID);
  }
}

/**
 * `limit + 1` fetched rows → a page of at most `limit`, with the cursor of the
 * last kept row when more exist. The extra row is only a lookahead.
 */
export function page<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (last: T) => string,
): { readonly items: readonly T[]; readonly nextCursor?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  return { items, nextCursor: cursorOf(items[items.length - 1]) };
}
