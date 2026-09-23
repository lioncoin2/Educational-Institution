import type { Conversation, ConversationId } from '../domain/conversation';
import type { Message, MessageAttachment, MessageId } from '../domain/message';
import type { Participant } from '../domain/participant';
import type { conversationParticipants, conversations, messages } from './schema';

type ConversationRow = typeof conversations.$inferSelect;
type ParticipantRow = typeof conversationParticipants.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id as ConversationId,
    type: row.type,
    title: row.title,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    directPair:
      row.directUserLow !== null && row.directUserHigh !== null
        ? { low: row.directUserLow, high: row.directUserHigh }
        : null,
    lastSequence: row.lastSequence,
    lastMessageAt: row.lastMessageAt,
    memberCount: row.memberCount,
  };
}

export function conversationRow(conversation: Conversation): ConversationRow {
  return {
    id: conversation.id,
    type: conversation.type,
    title: conversation.title,
    createdBy: conversation.createdBy,
    createdAt: conversation.createdAt,
    directUserLow: conversation.directPair?.low ?? null,
    directUserHigh: conversation.directPair?.high ?? null,
    lastSequence: conversation.lastSequence,
    lastMessageAt: conversation.lastMessageAt,
    memberCount: conversation.memberCount,
  };
}

export function toParticipant(row: ParticipantRow): Participant {
  return {
    conversationId: row.conversationId as ConversationId,
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    addedBy: row.addedBy,
    lastReadSequence: row.lastReadSequence,
    hiddenThroughSequence: row.hiddenThroughSequence,
  };
}

export function participantRow(participant: Participant): ParticipantRow {
  return {
    conversationId: participant.conversationId,
    userId: participant.userId,
    role: participant.role,
    joinedAt: participant.joinedAt,
    leftAt: participant.leftAt,
    addedBy: participant.addedBy,
    lastReadSequence: participant.lastReadSequence,
    hiddenThroughSequence: participant.hiddenThroughSequence,
  };
}

export function toMessage(row: MessageRow, attachments: readonly MessageAttachment[]): Message {
  return {
    id: row.id as MessageId,
    conversationId: row.conversationId as ConversationId,
    sequence: row.sequence,
    senderId: row.senderId,
    type: row.type,
    body: row.body,
    replyToMessageId: row.replyToMessageId as MessageId | null,
    clientMessageId: row.clientMessageId,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    attachments,
  };
}

/**
 * Raw-SQL values. Queries written as `sql` bypass Drizzle's column mapping:
 * node-postgres returns int8 as a string (it may exceed 2^53 in general, not
 * here) and Drizzle's driver config returns timestamptz as text.
 */
export function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Expected a number, got ${String(value)}`);
  return parsed;
}

export function date(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime()))
    throw new TypeError(`Expected a timestamp, got ${String(value)}`);
  return parsed;
}

export function dateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

export function str(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string');
  return value;
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}
