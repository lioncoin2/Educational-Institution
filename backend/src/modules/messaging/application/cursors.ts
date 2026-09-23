import { err, failure, ok, type Result } from '../../../shared';
import type { ConversationCursor } from '../domain/ports';

/**
 * Cursors are opaque to clients: base64url of what the query needs to resume.
 * Opaque so the key behind a page can change without breaking a client that
 * merely hands a cursor back.
 */
const INVALID = failure('validation', 'messaging.cursor_invalid', 'That page cursor is not valid.');

export function encodeConversationCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify([cursor.activityAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

export function decodeConversationCursor(
  raw: string | undefined,
): Result<ConversationCursor | undefined> {
  if (raw === undefined) return ok(undefined);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      parsed[1].length > 0 &&
      parsed[1].length <= 64
    ) {
      const activityAt = new Date(parsed[0]);
      if (!Number.isNaN(activityAt.getTime())) return ok({ activityAt, id: parsed[1] });
    }
  } catch {
    // Falls through: whatever it was, it was not one of ours.
  }
  return err(INVALID);
}

export function encodeMemberCursor(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

export function decodeMemberCursor(raw: string | null | undefined): Result<string | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  const userId = /^[A-Za-z0-9_-]{1,200}$/.test(raw)
    ? Buffer.from(raw, 'base64url').toString('utf8')
    : '';
  return userId.length > 0 && userId.length <= 128 ? ok(userId) : err(INVALID);
}
