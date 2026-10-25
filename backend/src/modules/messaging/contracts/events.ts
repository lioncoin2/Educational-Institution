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
  messageDeleted: 'messaging.message.deleted',
  messageEdited: 'messaging.message.edited',
  messagePinned: 'messaging.message.pinned',
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

/**
 * A moderator deleted a message (Q51/Q23). Ids and a sequence only — never the
 * body, and never WHO deleted it: the moderator is in the audit trail, not on
 * any subscriber's stream. A reader learns the message is now a tombstone by
 * re-reading it; the realtime frame built from this carries no more than this.
 */
export type MessageDeleted = DomainEvent<
  typeof MessagingEvents.messageDeleted,
  {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  }
>;

/**
 * A community chat's single pin changed (ADR 0043): the new authoritative
 * pinned message id, or null when unpinned. An id only — never the message's
 * body, never who pinned it (that is in the audit trail). The event's
 * `occurredAt` is the server's change time, which a subscriber uses to drop a
 * stale event; the authoritative state is always the conversation's own, which
 * a client re-reads on reconnect.
 */
export type MessagePinned = DomainEvent<
  typeof MessagingEvents.messagePinned,
  {
    readonly conversationId: string;
    readonly pinnedMessageId: string | null;
    /**
     * The conversation's pin version AFTER this change (ADR 0043 §realtime): a
     * total order, so a subscriber accepts a strictly newer version and two
     * same-instant changes are never ambiguous. Read from the committed row.
     */
    readonly pinVersion: number;
  }
>;

/**
 * An author edited their own message's text (ADR 0045). Ids and a sequence
 * only — never the old or new text: a subscriber that shows the message (the
 * realtime relay, notifications at read time) renders it through messaging's
 * contracts, under messaging's visibility rules. `occurredAt` is the edit's
 * `editedAt`.
 */
export type MessageEdited = DomainEvent<
  typeof MessagingEvents.messageEdited,
  {
    readonly conversationId: string;
    readonly messageId: string;
    readonly sequence: number;
  }
>;

export type MessagingEvent =
  | ConversationCreated
  | ParticipantAdded
  | ParticipantRemoved
  | MessageSent
  | MessageRead
  | MessageDeleted
  | MessageEdited
  | MessagePinned;
