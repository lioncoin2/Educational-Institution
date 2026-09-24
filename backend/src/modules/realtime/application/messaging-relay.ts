import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  EVENT_SUBSCRIBER,
  type DomainEvent,
  type EventSubscriber,
  type Unsubscribe,
} from '../../../shared';
import {
  MESSAGE_DELIVERY,
  MESSAGE_RECIPIENTS,
  MessagingEvents,
  type ConversationCreated,
  type MessageDelivery,
  type MessageRead,
  type MessageRecipients,
  type MessageSent,
  type ParticipantAdded,
  type ParticipantRemoved,
} from '../../messaging/contracts';
import { ConnectionManager } from './connection-manager';
import {
  conversationCreatedFrame,
  messageReadFrame,
  messageSentFrame,
  participantAddedFrame,
  participantRemovedFrame,
} from './envelopes';
import { onlineAudience } from './online-audience';

/**
 * Messaging's facts, delivered to the people entitled to them who are
 * connected right now.
 *
 *   conversation.created every member it was created with: a conversation
 *                        to show, before anything has been said in it
 *   message.sent         every CURRENT member who can see the message —
 *                        asked of messaging at delivery time, so a removal
 *                        that has committed is already in effect — the
 *                        sender's own devices included, with the
 *                        clientMessageId that reconciles their optimistic send
 *   message.read         the reader's own devices: their read mark moved.
 *                        Nobody else — whether others may see how far someone
 *                        has read is an open question (Q25)
 *   participant.added    the person added: a conversation to show
 *   participant.removed  the person removed: a conversation to put away. It
 *                        carries no content, and nothing of the conversation
 *                        reaches them after it
 *
 * Nothing here is a messaging rule: who is a member, who may see which
 * sequence and what a message looks like are messaging's answers.
 *
 * Delivery is detached from the publisher (the in-process bus awaits its
 * subscribers; a send must return when the message is stored, not when a
 * channel's audience has been told) and serialized per conversation, so one
 * conversation's events leave in the order they were published. The database
 * stays the truth: whatever is lost here — a crash, a closed socket — a
 * client recovers by sequence over HTTP.
 */
@Injectable()
export class MessagingRealtimeRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingRealtimeRelay.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  /** The tail of each conversation's delivery chain. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(MESSAGE_RECIPIENTS) private readonly recipients: MessageRecipients,
    @Inject(MESSAGE_DELIVERY) private readonly delivery: MessageDelivery,
    private readonly connections: ConnectionManager,
  ) {}

  onModuleInit(): void {
    for (const name of [
      MessagingEvents.conversationCreated,
      MessagingEvents.messageSent,
      MessagingEvents.messageRead,
      MessagingEvents.participantAdded,
      MessagingEvents.participantRemoved,
    ]) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Queues delivery behind the conversation's earlier events, and returns at once. */
  schedule(event: DomainEvent): void {
    // Nobody is connected to this instance: nothing to deliver, nothing to ask.
    if (this.connections.count() === 0) return;
    const key = event.aggregateId;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.relay(event))
      .catch((error: unknown) =>
        this.logger.error(
          { event: event.name, aggregateId: event.aggregateId, err: error },
          'realtime delivery failed',
        ),
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Resolves once everything scheduled so far has been delivered — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Delivers one event now. Awaitable, for tests and for a future durable consumer. */
  async relay(event: DomainEvent): Promise<void> {
    switch (event.name) {
      case MessagingEvents.conversationCreated: {
        const payload = conversationCreatedPayload(event);
        if (payload === null) return this.malformed(event);
        const frame = conversationCreatedFrame({
          occurredAt: event.occurredAt,
          conversationId: payload.conversationId,
          conversationType: payload.conversationType,
        });
        this.connections.sendToUsers(await this.onlineMembers(payload.conversationId), frame);
        return;
      }
      case MessagingEvents.messageSent:
        return this.messageSent(event);
      case MessagingEvents.messageRead: {
        const payload = messageReadPayload(event);
        if (payload === null) return this.malformed(event);
        this.connections.sendToUser(
          payload.userId,
          messageReadFrame({ occurredAt: event.occurredAt, ...payload }),
        );
        return;
      }
      case MessagingEvents.participantAdded: {
        const payload = participantAddedPayload(event);
        if (payload === null) return this.malformed(event);
        this.connections.sendToUser(
          payload.userId,
          participantAddedFrame({
            occurredAt: event.occurredAt,
            conversationId: payload.conversationId,
            userId: payload.userId,
            role: payload.role,
          }),
        );
        return;
      }
      case MessagingEvents.participantRemoved: {
        const payload = participantRemovedPayload(event);
        if (payload === null) return this.malformed(event);
        this.connections.sendToUser(
          payload.userId,
          participantRemovedFrame({
            occurredAt: event.occurredAt,
            conversationId: payload.conversationId,
            userId: payload.userId,
            reason: payload.reason,
          }),
        );
        return;
      }
    }
  }

  private async messageSent(event: DomainEvent): Promise<void> {
    const payload = messageSentPayload(event);
    if (payload === null) return this.malformed(event);

    // Who, first: current members who can see this sequence and are
    // connected here. Only then render — once — if there is anyone to tell.
    const online = await this.onlineMembers(payload.conversationId, payload.sequence);
    if (online.length === 0) return;

    const rendered = await this.delivery.message(payload.conversationId, payload.messageId);
    if (rendered === null) return;
    const frameFor = (message: typeof rendered.forMembers) =>
      messageSentFrame({
        occurredAt: event.occurredAt,
        conversationType: payload.conversationType,
        message,
        sender: rendered.sender,
      });
    const toMembers = frameFor(rendered.forMembers);
    const toSender = frameFor(rendered.forSender);

    for (const userId of online) {
      this.connections.sendToUser(userId, userId === payload.senderId ? toSender : toMembers);
    }
  }

  /**
   * The conversation's current members — who can see `visibleSequence`,
   * when given — that are connected to this instance (gate G1). Messaging
   * still answers who belongs, page by page, and is only ever asked about the
   * people connected here: at most 1 + ⌈A/1000⌉ calls for A accounts online,
   * however large the channel, instead of every page of it.
   */
  private onlineMembers(conversationId: string, visibleSequence?: number): Promise<string[]> {
    return onlineAudience(this.connections.onlineUserIds(), (page) =>
      this.recipients.list(conversationId, {
        visibleSequence,
        onlyUserIds: page.onlyUserIds,
        cursor: page.cursor,
        limit: page.limit,
      }),
    );
  }

  private malformed(event: DomainEvent): void {
    this.logger.warn({ event: event.name }, 'ignoring a malformed messaging event');
  }
}

// Events cross a module boundary: their shape is checked, not assumed.

type Fields<T> = Partial<Record<keyof T, unknown>>;

function fieldsOf<T>(event: DomainEvent, name: string): Fields<T> | null {
  const payload = event.payload;
  if (event.name !== name || payload === null || typeof payload !== 'object') return null;
  return payload;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function conversationCreatedPayload(event: DomainEvent): ConversationCreated['payload'] | null {
  const p = fieldsOf<ConversationCreated['payload']>(event, MessagingEvents.conversationCreated);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.conversationType !== 'string'
  ) {
    return null;
  }
  return p as ConversationCreated['payload'];
}

function messageSentPayload(event: DomainEvent): MessageSent['payload'] | null {
  const p = fieldsOf<MessageSent['payload']>(event, MessagingEvents.messageSent);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.messageId !== 'string' ||
    typeof p.senderId !== 'string' ||
    typeof p.conversationType !== 'string' ||
    typeof p.messageType !== 'string' ||
    !isCount(p.sequence)
  ) {
    return null;
  }
  return p as MessageSent['payload'];
}

function messageReadPayload(event: DomainEvent): MessageRead['payload'] | null {
  const p = fieldsOf<MessageRead['payload']>(event, MessagingEvents.messageRead);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.userId !== 'string' ||
    !isCount(p.lastReadSequence)
  ) {
    return null;
  }
  return p as MessageRead['payload'];
}

function participantAddedPayload(event: DomainEvent): ParticipantAdded['payload'] | null {
  const p = fieldsOf<ParticipantAdded['payload']>(event, MessagingEvents.participantAdded);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.userId !== 'string' ||
    typeof p.role !== 'string'
  ) {
    return null;
  }
  return p as ParticipantAdded['payload'];
}

function participantRemovedPayload(event: DomainEvent): ParticipantRemoved['payload'] | null {
  const p = fieldsOf<ParticipantRemoved['payload']>(event, MessagingEvents.participantRemoved);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.userId !== 'string' ||
    (p.reason !== 'left' && p.reason !== 'removed' && p.reason !== 'moderated')
  ) {
    return null;
  }
  return p as ParticipantRemoved['payload'];
}
