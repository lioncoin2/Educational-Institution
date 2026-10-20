import { domainEvent } from '../../../shared/domain-event';
import {
  MessagingEvents,
  type ConversationCreated,
  type MessageDeleted,
  type MessagePinned,
  type MessageRead,
  type MessageSent,
  type ParticipantAdded,
  type ParticipantRemoved,
} from '../contracts/events';
import type { Conversation } from './conversation';
import type { Message } from './message';
import type { Participant } from './participant';

export function conversationCreated(
  conversation: Conversation,
  correlationId?: string,
): ConversationCreated {
  return domainEvent(
    MessagingEvents.conversationCreated,
    conversation.id,
    {
      conversationId: conversation.id,
      conversationType: conversation.type,
      createdBy: conversation.createdBy,
      participantCount: conversation.memberCount,
    },
    conversation.createdAt,
    correlationId,
  );
}

export function participantAdded(
  participant: Participant,
  addedBy: string,
  correlationId?: string,
): ParticipantAdded {
  return domainEvent(
    MessagingEvents.participantAdded,
    participant.conversationId,
    {
      conversationId: participant.conversationId,
      userId: participant.userId,
      role: participant.role,
      addedBy,
    },
    participant.joinedAt,
    correlationId,
  );
}

export function participantRemoved(
  participant: Participant,
  removedBy: string,
  reason: 'left' | 'removed' | 'moderated',
  at: Date,
  correlationId?: string,
): ParticipantRemoved {
  return domainEvent(
    MessagingEvents.participantRemoved,
    participant.conversationId,
    { conversationId: participant.conversationId, userId: participant.userId, removedBy, reason },
    at,
    correlationId,
  );
}

/** Ids and codes only — the body never leaves messaging in an event. */
export function messageSent(
  conversation: Pick<Conversation, 'id' | 'type'>,
  message: Message,
  correlationId?: string,
): MessageSent {
  return domainEvent(
    MessagingEvents.messageSent,
    conversation.id,
    {
      conversationId: conversation.id,
      conversationType: conversation.type,
      messageId: message.id,
      sequence: message.sequence,
      senderId: message.senderId,
      messageType: message.type,
    },
    message.createdAt,
    correlationId,
  );
}

export function messageRead(
  conversationId: string,
  userId: string,
  lastReadSequence: number,
  at: Date,
  correlationId?: string,
): MessageRead {
  return domainEvent(
    MessagingEvents.messageRead,
    conversationId,
    { conversationId, userId, lastReadSequence },
    at,
    correlationId,
  );
}

/** Ids and a sequence only — the body, and who deleted it, stay in messaging. */
export function messageDeleted(
  conversation: Pick<Conversation, 'id'>,
  message: Message,
  correlationId?: string,
): MessageDeleted {
  return domainEvent(
    MessagingEvents.messageDeleted,
    conversation.id,
    { conversationId: conversation.id, messageId: message.id, sequence: message.sequence },
    message.deletedAt ?? message.createdAt,
    correlationId,
  );
}

/**
 * The conversation's single pin changed (ADR 0043): `pinnedMessageId` is the new
 * authoritative pin, or null when unpinned. `at` is the server's change time
 * (the pin's timestamp), which carries through as the event's `occurredAt` so a
 * subscriber can drop a stale pin event. Published only after the change is
 * persisted, and only when it changed something (idempotent no-ops are silent).
 */
export function messagePinned(
  conversationId: string,
  pinnedMessageId: string | null,
  pinVersion: number,
  at: Date,
  correlationId?: string,
): MessagePinned {
  return domainEvent(
    MessagingEvents.messagePinned,
    conversationId,
    { conversationId, pinnedMessageId, pinVersion },
    at,
    correlationId,
  );
}
