import type { MessageView, PersonView } from '../../messaging/contracts/message-view';
import type { ConversationPosition } from '../../messaging/contracts/message-delivery';
import type { ConversationType, ParticipantRole } from '../../messaging/contracts/vocabulary';
import { PROTOCOL_VERSION, type RealtimeErrorCode } from '../domain/protocol';

/**
 * Server → client frames, version 1. Every one is built here, field by field,
 * from messaging's contract views and the event's identifiers — never by
 * spreading a domain event or a stored row onto the wire, so nothing the
 * contract does not name (an audit field, a storage key, a signed URL, a
 * token) can reach a client by accident.
 *
 * Each builder returns the serialized frame: an event is serialized once and
 * the same string is sent to every connection that receives it.
 */

/** A message exactly as the HTTP API renders one (`MessageResponse`). */
interface WireMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly senderId: string;
  readonly type: string;
  readonly body: string | null;
  readonly replyToMessageId: string | null;
  readonly clientMessageId: string | null;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly attachments: readonly {
    readonly fileAssetId: string;
    readonly available: boolean;
    readonly kind: string | null;
    readonly contentType: string | null;
    readonly byteSize: number | null;
    readonly displayName: string | null;
    readonly durationMs: number | null;
    readonly width: number | null;
    readonly height: number | null;
  }[];
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

function wireMessage(message: MessageView): WireMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    sequence: message.sequence,
    senderId: message.senderId,
    type: message.type,
    body: message.body,
    replyToMessageId: message.replyToMessageId,
    clientMessageId: message.clientMessageId,
    createdAt: message.createdAt.toISOString(),
    editedAt: iso(message.editedAt),
    deletedAt: iso(message.deletedAt),
    attachments: message.attachments.map((attachment) => {
      const file = attachment.file;
      return {
        fileAssetId: attachment.fileAssetId,
        available: file !== null,
        kind: file?.kind ?? null,
        contentType: file?.contentType ?? null,
        byteSize: file?.byteSize ?? null,
        displayName: file?.displayName ?? null,
        durationMs: file?.durationMs ?? null,
        width: file?.width ?? null,
        height: file?.height ?? null,
      };
    }),
  };
}

const frame = (body: Record<string, unknown>): string =>
  JSON.stringify({ ...body, version: PROTOCOL_VERSION });

const withId = (id: string | undefined) => (id === undefined ? {} : { id });

// ── Replies ────────────────────────────────────────────────────────────────

export function readyFrame(input: {
  readonly connectionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly heartbeatSeconds: number;
  readonly id?: string;
}): string {
  return frame({
    type: 'ready',
    connectionId: input.connectionId,
    userId: input.userId,
    expiresAt: input.expiresAt.toISOString(),
    heartbeatSeconds: input.heartbeatSeconds,
    ...withId(input.id),
  });
}

export function subscribedFrame(position: ConversationPosition, id?: string): string {
  return frame({
    type: 'subscribed',
    conversationId: position.conversationId,
    lastSequence: position.lastSequence,
    lastReadSequence: position.lastReadSequence,
    ...withId(id),
  });
}

export function pongFrame(id?: string): string {
  return frame({ type: 'pong', ...withId(id) });
}

export function errorFrame(
  code: RealtimeErrorCode,
  message: string,
  extra: {
    readonly id?: string;
    readonly conversationId?: string;
    retryAfterSeconds?: number;
  } = {},
): string {
  return frame({
    type: 'error',
    code,
    message,
    ...withId(extra.id),
    ...(extra.conversationId === undefined ? {} : { conversationId: extra.conversationId }),
    ...(extra.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extra.retryAfterSeconds }),
  });
}

// ── Events ─────────────────────────────────────────────────────────────────
//
// `eventId` is derived from the fact itself, not generated: the same fact
// delivered twice — by a retrying outbox one day — carries the same id, so a
// client can drop the second copy by id alone.

export function messageSentFrame(input: {
  readonly occurredAt: Date;
  readonly conversationType: ConversationType;
  readonly message: MessageView;
  readonly sender: PersonView | null;
}): string {
  const message = input.message;
  return frame({
    type: 'message.sent',
    eventId: `message.sent:${message.id}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: message.conversationId,
    conversationType: input.conversationType,
    messageId: message.id,
    sequence: message.sequence,
    message: wireMessage(message),
    sender:
      input.sender === null
        ? { userId: message.senderId, displayName: null }
        : { userId: input.sender.userId, displayName: input.sender.displayName },
  });
}

export function conversationCreatedFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly conversationType: ConversationType;
}): string {
  return frame({
    type: 'conversation.created',
    eventId: `conversation.created:${input.conversationId}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    conversationType: input.conversationType,
  });
}

export function messageReadFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly userId: string;
  readonly lastReadSequence: number;
}): string {
  return frame({
    type: 'message.read',
    eventId: `message.read:${input.conversationId}:${input.userId}:${input.lastReadSequence}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    userId: input.userId,
    lastReadSequence: input.lastReadSequence,
  });
}

export function participantAddedFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly userId: string;
  readonly role: ParticipantRole;
}): string {
  return frame({
    type: 'participant.added',
    eventId: `participant.added:${input.conversationId}:${input.userId}:${input.occurredAt.getTime()}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    userId: input.userId,
    role: input.role,
  });
}

export function participantRemovedFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly userId: string;
  readonly reason: 'left' | 'removed' | 'moderated';
}): string {
  return frame({
    type: 'participant.removed',
    eventId: `participant.removed:${input.conversationId}:${input.userId}:${input.occurredAt.getTime()}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    userId: input.userId,
    reason: input.reason,
  });
}
