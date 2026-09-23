import { InProcessEventBus } from '../../../platform/events/event-bus';
import { domainEvent } from '../../../shared';
import {
  MessagingEvents,
  type MessageRecipients,
  type RecipientPage,
} from '../../messaging/contracts';
import { MAX_RECIPIENTS_PER_REQUEST } from '../contracts';
import type { NotificationDelivery, OutboundNotification } from '../domain/ports';
import { MessageSentNotifier, NEW_MESSAGE_TEMPLATE } from './message-sent.notifier';
import { NotificationDispatcher } from './notification-dispatcher';

class RecordingDelivery implements NotificationDelivery {
  readonly delivered: OutboundNotification[] = [];
  async deliver(notification: OutboundNotification): Promise<void> {
    this.delivered.push(notification);
  }
}

/** A conversation's members, paged exactly as the messaging contract pages them. */
class FakeRecipients implements MessageRecipients {
  readonly calls: { cursor: string | null | undefined; limit: number }[] = [];
  constructor(private readonly members: readonly string[]) {}

  async list(
    _conversationId: string,
    options: { excludeUserId?: string; cursor?: string | null; limit: number },
  ): Promise<RecipientPage> {
    this.calls.push({ cursor: options.cursor, limit: options.limit });
    const ids = this.members.filter((id) => id !== options.excludeUserId);
    const start =
      options.cursor === null || options.cursor === undefined ? 0 : Number(options.cursor);
    const page = ids.slice(start, start + options.limit);
    const end = start + page.length;
    return { userIds: page, nextCursor: end < ids.length ? String(end) : null };
  }
}

const sent = (payload: Record<string, unknown>) =>
  domainEvent(MessagingEvents.messageSent, 'c-1', payload, new Date('2026-09-01T08:00:00Z'));

const PAYLOAD = {
  conversationId: 'c-1',
  conversationType: 'GROUP',
  messageId: 'm-1',
  sequence: 7,
  senderId: 'sender',
  messageType: 'TEXT',
};

function notifier(members: readonly string[]) {
  const bus = new InProcessEventBus();
  const recipients = new FakeRecipients(members);
  const delivery = new RecordingDelivery();
  const subject = new MessageSentNotifier(bus, recipients, new NotificationDispatcher(delivery));
  return { bus, recipients, delivery, subject };
}

describe('new-message notifications', () => {
  it('notifies every current member except the sender, with ids only', async () => {
    const { subject, delivery } = notifier(['sender', 'a', 'b']);
    await subject.notify(sent(PAYLOAD));
    expect(delivery.delivered).toEqual([
      {
        recipientUserIds: ['a', 'b'],
        template: NEW_MESSAGE_TEMPLATE,
        params: {
          conversationId: 'c-1',
          conversationType: 'GROUP',
          messageId: 'm-1',
          messageType: 'TEXT',
          senderId: 'sender',
        },
        collapseKey: 'messaging:c-1',
      },
    ]);
  });

  // A 10,000-member channel is walked in bounded pages, never loaded whole.
  it('walks a large audience a page at a time', async () => {
    const members = Array.from({ length: 2500 }, (_, i) => `u${i}`);
    const { subject, delivery, recipients } = notifier(['sender', ...members]);
    await subject.notify(sent(PAYLOAD));
    expect(delivery.delivered.map((n) => n.recipientUserIds.length)).toEqual([1000, 1000, 500]);
    expect(recipients.calls.every((call) => call.limit === MAX_RECIPIENTS_PER_REQUEST)).toBe(true);
    expect(new Set(delivery.delivered.flatMap((n) => n.recipientUserIds)).size).toBe(2500);
  });

  it('ignores a malformed event instead of guessing', async () => {
    const { subject, delivery } = notifier(['a']);
    await subject.notify(sent({ ...PAYLOAD, messageId: 42 }));
    await subject.notify(sent(null as unknown as Record<string, unknown>));
    expect(delivery.delivered).toEqual([]);
  });

  it('subscribes to the bus, and never holds up the publisher', async () => {
    const { bus, subject, delivery } = notifier(['sender', 'a']);
    subject.onModuleInit();
    await bus.publish([sent(PAYLOAD)]);
    // Detached: the publish returned before delivery; let it run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivery.delivered).toHaveLength(1);

    subject.onModuleDestroy();
    await bus.publish([sent(PAYLOAD)]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivery.delivered).toHaveLength(1);
  });

  it('delivers nothing when there is nobody to tell', async () => {
    const { subject, delivery } = notifier(['sender']);
    await subject.notify(sent(PAYLOAD));
    expect(delivery.delivered).toEqual([]);
  });
});

describe('the dispatcher', () => {
  it('deduplicates recipients and refuses an unbounded request', async () => {
    const delivery = new RecordingDelivery();
    const dispatcher = new NotificationDispatcher(delivery);
    await dispatcher.send({ recipientUserIds: ['a', 'a', 'b'], template: 't', params: {} });
    expect(delivery.delivered[0]?.recipientUserIds).toEqual(['a', 'b']);

    const tooMany = Array.from({ length: MAX_RECIPIENTS_PER_REQUEST + 1 }, (_, i) => `u${i}`);
    await expect(
      dispatcher.send({ recipientUserIds: tooMany, template: 't', params: {} }),
    ).rejects.toThrow(RangeError);
  });
});
