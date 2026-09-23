import type { DomainEvent } from '../../../shared/domain-event';
import type { ConversationType, MessageType, ParticipantRole } from './vocabulary';

/**
 * Facts messaging publishes, for any module to react to without importing it.
 *
 * Payloads carry identifiers and codes only. No message text, no file names,
 * no display names, nothing personal: an event is delivered to every
 * subscriber, logged by some, and — once there is an outbox — stored. A
 * subscriber that needs more asks messaging's contracts, which apply
 * messaging's rules.
 *
 * Every event's `aggregateId` is the conversation id, so per-conversation
 * order survives any future partitioned transport.
 */
export const MessagingEvents = {
  conversationCreated: 'messaging.conversation.created',
  participantAdded: 'messaging.participant.added',
  participantRemoved: 'messaging.participant.removed',
  messageSent: 'messaging.message.sent',
  messageRead: 'messaging.message.read',
} as const;

export type ConversationCreated = DomainEvent<
  typeof MessagingEvents.conversationCreated,
  {
    readonly conversationId: string;
    readonly conversationType: ConversationType;
    readonly createdBy: string;
    /** Initial members are implied by creation; no per-member events follow. */
    readonly participantCount: number;
  }
>;

export type ParticipantAdded = DomainEvent<
  typeof MessagingEvents.participantAdded,
  {
    readonly conversationId: string;
    readonly userId: string;
    readonly role: ParticipantRole;
    readonly addedBy: string;
  }
>;

export type ParticipantRemoved = DomainEvent<
  typeof MessagingEvents.participantRemoved,
  {
    readonly conversationId: string;
    readonly userId: string;
    readonly removedBy: string;
    /** `left` — by themselves; `removed` — by the owner; `moderated` — by a moderator. */
    readonly reason: 'left' | 'removed' | 'moderated';
  }
>;

export type MessageSent = DomainEvent<
  typeof MessagingEvents.messageSent,
  {
    readonly conversationId: string;
    readonly conversationType: ConversationType;
    readonly messageId: string;
    readonly sequence: number;
    readonly senderId: string;
    readonly messageType: MessageType;
  }
>;

export type MessageRead = DomainEvent<
  typeof MessagingEvents.messageRead,
  {
    readonly conversationId: string;
    readonly userId: string;
    readonly lastReadSequence: number;
  }
>;

export type MessagingEvent =
  ConversationCreated | ParticipantAdded | ParticipantRemoved | MessageSent | MessageRead;
