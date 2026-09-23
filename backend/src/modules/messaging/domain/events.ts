import { domainEvent } from '../../../shared/domain-event';
import {
  MessagingEvents,
  type ConversationCreated,
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
