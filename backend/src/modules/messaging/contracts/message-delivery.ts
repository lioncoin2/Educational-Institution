import type { Principal } from '../../../shared/principal';
import type { Result } from '../../../shared/result';
import type { MessageView, PersonView } from './message-view';

/** DI token. */
export const MESSAGE_DELIVERY = Symbol('MESSAGE_DELIVERY');

/** Where one member stands in one conversation. */
export interface ConversationPosition {
  readonly conversationId: string;
  /** The newest message in the conversation — what a client that is up to date has seen. */
  readonly lastSequence: number;
  /** How far this member has read. */
  readonly lastReadSequence: number;
}

/** One stored message, rendered once for every audience it may reach. */
export interface MessageForDelivery {
  /** As the sender's own devices see it — with its clientMessageId, so an optimistic send reconciles. */
  readonly forSender: MessageView;
  /** As every other member sees it. */
  readonly forMembers: MessageView;
  /** The sender's name, when the account still has one. */
  readonly sender: PersonView | null;
}

/**
 * Messaging's answers for modules that DELIVER what messaging stores —
 * realtime today. It decides nothing about transport, and the delivering
 * module decides nothing about messaging:
 *
 *   - who may receive a message is `MESSAGE_RECIPIENTS` (current members who
 *     can see its sequence), asked at delivery time;
 *   - what they receive is `message()`, rendered by the same views the HTTP
 *     timeline uses — so a message looks the same however it arrives, and the
 *     rule that only its sender sees its clientMessageId is applied here;
 *   - whether a person may follow a conversation is `position()`, which is
 *     the HTTP "open this conversation" decision, refusal included.
 */
export interface MessageDelivery {
  /**
   * A stored message, rendered for delivery; null when that conversation has
   * no such message. No principal: this serves trusted in-process delivery
   * code, which may hand the result only to recipients `MESSAGE_RECIPIENTS`
   * returned for the message's sequence.
   */
  message(conversationId: string, messageId: string): Promise<MessageForDelivery | null>;

  /**
   * The principal's position in a conversation they may read: `messaging.read`
   * AND current membership. Otherwise the same failure the HTTP API gives —
   * `messaging.conversation_not_found` whether the conversation is missing or
   * merely not theirs, so a guessed id tells nothing.
   */
  position(principal: Principal, conversationId: string): Promise<Result<ConversationPosition>>;
}
