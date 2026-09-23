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
  MESSAGE_RECIPIENTS,
  MessagingEvents,
  type MessageRecipients,
  type MessageSent,
} from '../../messaging/contracts';
import { MAX_RECIPIENTS_PER_REQUEST } from '../contracts';
import { NotificationDispatcher } from './notification-dispatcher';

export const NEW_MESSAGE_TEMPLATE = 'messaging.new_message';

/**
 * The translator from messaging's facts to notifications — and the only
 * code in this module that knows messaging exists.
 *
 * A new message notifies every CURRENT member except its sender, walked a
 * page at a time through messaging's recipients contract, so a
 * 10,000-member channel costs ten bounded queries, not one unbounded one.
 * The notification carries ids only; its text is the template's.
 *
 * The in-process bus awaits subscribers, so the fan-out is detached here: a
 * send returns when its message is stored, never when ten thousand people
 * have been notified. A crash mid-fan-out loses notifications, not messages
 * — the durable path is the transactional outbox (events.md).
 */
@Injectable()
export class MessageSentNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageSentNotifier.name);
  private unsubscribe: Unsubscribe | null = null;

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(MESSAGE_RECIPIENTS) private readonly recipients: MessageRecipients,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.subscriber.subscribe(MessagingEvents.messageSent, (event) => {
      void this.notify(event).catch((error: unknown) =>
        this.logger.error(
          { event: event.name, aggregateId: event.aggregateId, err: error },
          'new-message notification failed',
        ),
      );
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Awaitable, for tests and for a future durable consumer. */
  async notify(event: DomainEvent): Promise<void> {
    const payload = messageSentPayload(event);
    if (payload === null) {
      this.logger.warn({ event: event.name }, 'ignoring a malformed message.sent event');
      return;
    }

    let cursor: string | null = null;
    do {
      const page = await this.recipients.list(payload.conversationId, {
        excludeUserId: payload.senderId,
        visibleSequence: payload.sequence,
        cursor,
        limit: MAX_RECIPIENTS_PER_REQUEST,
      });
      await this.dispatcher.send({
        recipientUserIds: page.userIds,
        template: NEW_MESSAGE_TEMPLATE,
        params: {
          conversationId: payload.conversationId,
          conversationType: payload.conversationType,
          messageId: payload.messageId,
          messageType: payload.messageType,
          senderId: payload.senderId,
        },
        collapseKey: `messaging:${payload.conversationId}`,
      });
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
}

/** Events cross a module boundary: check the shape rather than trust a cast. */
function messageSentPayload(event: DomainEvent): MessageSent['payload'] | null {
  const payload = event.payload as Partial<Record<keyof MessageSent['payload'], unknown>> | null;
  if (
    event.name !== MessagingEvents.messageSent ||
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.conversationId !== 'string' ||
    typeof payload.messageId !== 'string' ||
    typeof payload.senderId !== 'string' ||
    typeof payload.conversationType !== 'string' ||
    typeof payload.messageType !== 'string' ||
    typeof payload.sequence !== 'number'
  ) {
    return null;
  }
  return payload as MessageSent['payload'];
}
