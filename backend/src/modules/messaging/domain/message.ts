import { err, failure, ok, type Result } from '../../../shared';
import type { FileKind } from '../../files/contracts/file-kind';
import type { MessageType } from '../contracts/vocabulary';
import type { ConversationId, MessageId } from './ids';
import { MESSAGE_BODY_MAX_LENGTH } from './messaging-policy';

export type { MessageId } from './ids';

/** A reference to a stored file — metadata and bytes stay in the files module. */
export interface MessageAttachment {
  readonly fileAssetId: string;
  /** Order within the message; the schema allows several, V1 sends one. */
  readonly position: number;
}

/**
 * A message. Immutable once stored, except for the two lifecycle stamps the
 * schema reserves for later:
 *
 *   editedAt   set by a future edit; the body would change, the sequence never
 *   deletedAt  a future soft delete: the row stays, so ordering, read state and
 *              the audit trail stay intact; readers see a tombstone
 *
 * `sequence` is the order — assigned by the server, never by a client clock.
 */
export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly sequence: number;
  readonly senderId: string;
  readonly type: MessageType;
  /** The text, or a media caption. Null for media without one, and for tombstones. */
  readonly body: string | null;
  readonly replyToMessageId: MessageId | null;
  /** The sender's idempotency key: unique per sender within a conversation. */
  readonly clientMessageId: string;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly attachments: readonly MessageAttachment[];
}

/** Everything about a message except its sequence, which only the store assigns. */
export type MessageDraft = Omit<Message, 'sequence' | 'editedAt' | 'deletedAt'>;

/**
 * A client-generated id, retried verbatim until the send is acknowledged. A
 * UUID is ideal; anything opaque, URL-safe and long enough to be unique works.
 */
export const CLIENT_MESSAGE_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

/** Which stored-file kinds each media message accepts. */
export const ACCEPTED_FILE_KINDS: Readonly<
  Record<Exclude<MessageType, 'TEXT'>, readonly FileKind[]>
> = {
  VOICE: ['VOICE'],
  IMAGE: ['IMAGE'],
  FILE: ['DOCUMENT', 'AUDIO'],
};

const invalid = (code: string, message: string, details?: Record<string, unknown>) =>
  err(failure('validation', `messaging.${code}`, message, details));

export function validateClientMessageId(value: string): Result<string> {
  return CLIENT_MESSAGE_ID_SHAPE.test(value)
    ? ok(value)
    : invalid(
        'client_message_id_invalid',
        'clientMessageId must be 8–64 characters of letters, digits, "-" or "_".',
      );
}

/**
 * A body as stored: NFC, "\n" line endings, control characters removed
 * (tab and newline are kept), surrounding whitespace trimmed. Empty → null.
 * Direction marks are deliberately KEPT: mixed Arabic and Latin text needs
 * them to render correctly.
 */
export function normalizeBody(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

function boundedBody(raw: string | null | undefined): Result<string | null> {
  const body = normalizeBody(raw);
  if (body !== null && [...body].length > MESSAGE_BODY_MAX_LENGTH) {
    return invalid('body_too_long', `A message is at most ${MESSAGE_BODY_MAX_LENGTH} characters.`, {
      maxLength: MESSAGE_BODY_MAX_LENGTH,
    });
  }
  return ok(body);
}

interface DraftBase {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: string;
  readonly clientMessageId: string;
  readonly replyToMessageId: MessageId | null;
  readonly at: Date;
}

export function textDraft(input: DraftBase & { readonly body: string }): Result<MessageDraft> {
  const key = validateClientMessageId(input.clientMessageId);
  if (!key.ok) return key;
  const body = boundedBody(input.body);
  if (!body.ok) return body;
  if (body.value === null) return invalid('body_required', 'A text message needs text.');
  return ok(draft(input, 'TEXT', body.value, []));
}

/** A voice, image or file message: exactly one attachment, optional caption. */
export function mediaDraft(
  input: DraftBase & {
    readonly type: Exclude<MessageType, 'TEXT'>;
    readonly fileAssetId: string;
    readonly caption?: string | null;
  },
): Result<MessageDraft> {
  const key = validateClientMessageId(input.clientMessageId);
  if (!key.ok) return key;
  const caption = boundedBody(input.caption);
  if (!caption.ok) return caption;
  return ok(
    draft(input, input.type, caption.value, [{ fileAssetId: input.fileAssetId, position: 0 }]),
  );
}

function draft(
  input: DraftBase,
  type: MessageType,
  body: string | null,
  attachments: readonly MessageAttachment[],
): MessageDraft {
  return {
    id: input.id,
    conversationId: input.conversationId,
    senderId: input.senderId,
    type,
    body,
    replyToMessageId: input.replyToMessageId,
    clientMessageId: input.clientMessageId,
    createdAt: input.at,
    attachments,
  };
}

/**
 * Whether a retried send is the SAME message. A client that reuses a key for
 * different content has a bug — or is probing — and gets a conflict, never
 * someone else's message and never a silent overwrite.
 */
export function sameContent(stored: Message, draft: MessageDraft): boolean {
  return (
    stored.type === draft.type &&
    stored.body === draft.body &&
    stored.replyToMessageId === draft.replyToMessageId &&
    stored.attachments.length === draft.attachments.length &&
    stored.attachments.every(
      (attachment, index) => attachment.fileAssetId === draft.attachments[index]?.fileAssetId,
    )
  );
}

/** What a reader sees of a deleted message: that it existed, where, and by whom. */
export function asSeen(message: Message): Message {
  return message.deletedAt === null ? message : { ...message, body: null, attachments: [] };
}
