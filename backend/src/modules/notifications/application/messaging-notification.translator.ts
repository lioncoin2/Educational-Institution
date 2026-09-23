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
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import {
  MAX_RECIPIENT_PAGE,
  MESSAGE_RECIPIENTS,
  MessagingEvents,
  type ConversationCreated,
  type MessageRecipients,
  type MessageSent,
  type ParticipantAdded,
} from '../../messaging/contracts';
import type { NotificationParams } from '../contracts/targets';
import type { NotificationType } from '../contracts/vocabulary';
import { bodyKeyOf, titleKeyOf } from '../domain/catalog';
import type { NotificationRequest } from '../domain/notification';
import { NotificationLimits } from '../domain/notification-policy';
import { plainText } from '../domain/text';
import { NotificationDispatcher } from './notification-dispatcher';

/**
 * Messaging's facts, translated into notification requests — the only code
 * in this module that knows messaging exists. Messaging knows nothing of it.
 *
 *   messaging.message.sent         MESSAGE_RECEIVED for every member who may
 *                                  read the message now, except its sender
 *   messaging.conversation.created CONVERSATION_CREATED for every member it
 *                                  was created with, except its creator
 *   messaging.participant.added    ADDED_TO_CONVERSATION for the person added
 *                                  (not when they added themselves)
 *
 * Who may read is messaging's answer, asked at translation time through
 * MESSAGE_RECIPIENTS — current members, whose history window includes the
 * message, whose accounts may read messages — never a copy of membership
 * kept here. A 10,000-member channel is walked a page of 1,000 at a time.
 *
 * What a notification says: who did it and what kind of thing happened —
 * never the message's text. The sender's name is identity's, fetched once
 * per fact.
 *
 * The in-process bus awaits its subscribers, so translation is detached from
 * the publisher (a send returns when the message is stored) and chained per
 * conversation, so one conversation's notifications are created in the order
 * its facts were published. A crash mid-way loses notifications, never
 * messages; a fact delivered twice creates nothing twice (the dedupe keys).
 */
@Injectable()
export class MessagingNotificationTranslator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingNotificationTranslator.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(MESSAGE_RECIPIENTS) private readonly recipients: MessageRecipients,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    for (const name of [
      MessagingEvents.messageSent,
      MessagingEvents.conversationCreated,
      MessagingEvents.participantAdded,
    ]) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Queues translation behind the conversation's earlier facts, and returns at once. */
  schedule(event: DomainEvent): void {
    const key = event.aggregateId;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.translate(event))
      .catch((error: unknown) =>
        this.logger.error(
          { event: event.name, aggregateId: event.aggregateId, err: error },
          'notification translation failed',
        ),
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Resolves once everything scheduled so far is translated — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Translates one fact now. Awaitable, for tests and a future durable consumer. */
  async translate(event: DomainEvent): Promise<void> {
    switch (event.name) {
      case MessagingEvents.messageSent: {
        const payload = messageSentPayload(event);
        if (payload === null) return this.malformed(event);
        const params = await this.withActor('senderDisplayName', payload.senderId, {
          messageType: payload.messageType,
          conversationType: payload.conversationType,
        });
        return this.toReaders(
          payload.conversationId,
          { excludeUserId: payload.senderId, visibleSequence: payload.sequence },
          (userId) =>
            request('MESSAGE_RECEIVED', userId, payload.conversationId, params, [
              'message',
              payload.messageId,
              'user',
              userId,
            ]),
          event.correlationId,
        );
      }
      case MessagingEvents.conversationCreated: {
        const payload = conversationCreatedPayload(event);
        if (payload === null) return this.malformed(event);
        const params = await this.withActor('actorDisplayName', payload.createdBy, {
          conversationType: payload.conversationType,
        });
        return this.toReaders(
          payload.conversationId,
          { excludeUserId: payload.createdBy },
          (userId) =>
            request('CONVERSATION_CREATED', userId, payload.conversationId, params, [
              'conversation',
              payload.conversationId,
              'created',
              'user',
              userId,
            ]),
          event.correlationId,
        );
      }
      case MessagingEvents.participantAdded: {
        const payload = participantAddedPayload(event);
        if (payload === null) return this.malformed(event);
        if (payload.addedBy === payload.userId) return;
        const params = await this.withActor('actorDisplayName', payload.addedBy, {});
        return this.toReaders(
          payload.conversationId,
          { onlyUserIds: [payload.userId] },
          (userId) =>
            request('ADDED_TO_CONVERSATION', userId, payload.conversationId, params, [
              'conversation',
              payload.conversationId,
              'added',
              userId,
              String(event.occurredAt.getTime()),
            ]),
          event.correlationId,
        );
      }
      default:
        return;
    }
  }

  /**
   * Every member who may read the conversation now (narrowed by `filter`),
   * a page at a time, each page one dispatch.
   */
  private async toReaders(
    conversationId: string,
    filter: {
      readonly excludeUserId?: string;
      readonly visibleSequence?: number;
      readonly onlyUserIds?: readonly string[];
    },
    requestFor: (userId: string) => NotificationRequest,
    correlationId: string | undefined,
  ): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await this.recipients.list(conversationId, {
        ...filter,
        readersOnly: true,
        cursor,
        limit: MAX_RECIPIENT_PAGE,
      });
      if (page.userIds.length > 0) {
        await this.dispatcher.dispatch(page.userIds.map(requestFor), correlationId);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  /** `params` plus the actor's display name under `name`, when the account still has one. */
  private async withActor(
    name: 'senderDisplayName' | 'actorDisplayName',
    userId: string,
    params: Record<string, string>,
  ): Promise<NotificationParams> {
    const [account] = await this.directory.describe([userId]);
    const displayName =
      account === undefined
        ? ''
        : plainText(account.displayName, NotificationLimits.maxParamTextLength);
    return displayName.length === 0 ? params : { [name]: displayName, ...params };
  }

  private malformed(event: DomainEvent): void {
    this.logger.warn({ event: event.name }, 'ignoring a malformed messaging event');
  }
}

function request(
  type: NotificationType,
  recipientUserId: string,
  conversationId: string,
  params: NotificationParams,
  dedupeParts: readonly string[],
): NotificationRequest {
  return {
    recipientUserId,
    type,
    titleKey: titleKeyOf(type),
    bodyKey: bodyKeyOf(type),
    params,
    target: { kind: 'conversation', conversationId },
    dedupeKey: dedupeParts.join(':'),
  };
}

// Events cross a module boundary: their shape is checked, not assumed.

type Fields<T> = Partial<Record<keyof T, unknown>>;

function fieldsOf<T>(event: DomainEvent, name: string): Fields<T> | null {
  const payload = event.payload;
  if (event.name !== name || payload === null || typeof payload !== 'object') return null;
  return payload;
}

const isSequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function messageSentPayload(event: DomainEvent): MessageSent['payload'] | null {
  const p = fieldsOf<MessageSent['payload']>(event, MessagingEvents.messageSent);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.messageId !== 'string' ||
    typeof p.senderId !== 'string' ||
    typeof p.conversationType !== 'string' ||
    typeof p.messageType !== 'string' ||
    !isSequence(p.sequence)
  ) {
    return null;
  }
  return p as MessageSent['payload'];
}

function conversationCreatedPayload(event: DomainEvent): ConversationCreated['payload'] | null {
  const p = fieldsOf<ConversationCreated['payload']>(event, MessagingEvents.conversationCreated);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.conversationType !== 'string' ||
    typeof p.createdBy !== 'string'
  ) {
    return null;
  }
  return p as ConversationCreated['payload'];
}

function participantAddedPayload(event: DomainEvent): ParticipantAdded['payload'] | null {
  const p = fieldsOf<ParticipantAdded['payload']>(event, MessagingEvents.participantAdded);
  if (
    p === null ||
    typeof p.conversationId !== 'string' ||
    typeof p.userId !== 'string' ||
    typeof p.addedBy !== 'string'
  ) {
    return null;
  }
  return p as ParticipantAdded['payload'];
}
