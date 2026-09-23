import { err, failure, ok, type Result } from '../../../shared';
import type { NotificationCursor } from '../domain/ports';

/**
 * Inbox cursors are opaque to clients: base64url of the position the next
 * page starts after. Opaque so the key behind a page can change without
 * breaking a client that merely hands a cursor back.
 */
const INVALID = failure(
  'validation',
  'notifications.cursor_invalid',
  'That page cursor is not valid.',
);

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

export function decodeNotificationCursor(
  raw: string | undefined,
): Result<NotificationCursor | undefined> {
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
      const createdAt = new Date(parsed[0]);
      if (!Number.isNaN(createdAt.getTime())) return ok({ createdAt, id: parsed[1] });
    }
  } catch {
    // Falls through: whatever it was, it was not one of ours.
  }
  return err(INVALID);
}
