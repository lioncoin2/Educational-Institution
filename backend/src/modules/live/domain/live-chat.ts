import { err, failure, ok, type Id, type Result } from '../../../shared';

export type LiveChatMessageId = Id<'LiveChatMessage'>;

/** The most characters one live-chat message holds (whole code points). */
export const LIVE_CHAT_BODY_MAX = 500;

/** A client's idempotency key for a post: the same shape messaging accepts. */
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/u;

/** Control characters and the direction overrides/isolates — line breaks are kept. */
const DISALLOWED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;

/**
 * One message of a live session's own chat (owner decision F, ADR 0047) —
 * Live's record, never a community-chat message: it lives and ends with its
 * session, and nothing of it reaches the community's conversation history.
 *
 * `position` orders a session's chat: assigned by the store as the message
 * is written, increasing within the session (in Postgres a sequence — gaps
 * mean nothing). `createdAt` is the server's clock.
 */
export interface LiveChatMessage {
  readonly id: LiveChatMessageId;
  readonly sessionId: string;
  readonly senderId: string;
  readonly clientMessageId: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly position: number;
}

/** A message as a post asks the store to write it — the store assigns its position. */
export type LiveChatDraft = Omit<LiveChatMessage, 'position'>;

/**
 * A session's chat switch (decision F): open to every participant by
 * default; a moderator locks it, and then only moderators may post. The
 * version rises by one on every real change, so a client applies only a
 * newer one.
 */
export interface LiveChatState {
  readonly locked: boolean;
  readonly lockVersion: number;
}

const invalid = (code: string, message: string, details?: Record<string, unknown>) =>
  err(failure('validation', `live.${code}`, message, details));

/**
 * The text of a post: trimmed, without control characters or direction
 * overrides (a line break is kept), 1 to LIVE_CHAT_BODY_MAX code points.
 */
export function liveChatBody(raw: string): Result<string> {
  const body = raw.replace(DISALLOWED, ' ').trim();
  if (body.length === 0) return invalid('chat_body_required', 'A chat message needs text.');
  if ([...body].length > LIVE_CHAT_BODY_MAX) {
    return invalid(
      'chat_body_too_long',
      `A chat message is at most ${LIVE_CHAT_BODY_MAX} characters.`,
      { maxLength: LIVE_CHAT_BODY_MAX },
    );
  }
  return ok(body);
}

export function validClientMessageId(value: string): Result<string> {
  return CLIENT_MESSAGE_ID.test(value)
    ? ok(value)
    : invalid(
        'chat_client_message_id_invalid',
        'clientMessageId must be 8–64 characters of A–Z, a–z, 0–9, _ or -.',
      );
}
