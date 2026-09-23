import { expectOk } from '../../../../test/support/identity-harness';
import {
  messageRequest,
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';
import { NotificationEvents, type NotificationCreated } from '../contracts/events';

describe('the notification dispatcher', () => {
  let h: NotificationsHarness;
  let ali: Principal;
  let sara: Principal;

  beforeEach(async () => {
    h = await notificationsHarness();
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  const created = () => h.eventsNamed(NotificationEvents.created) as NotificationCreated[];

  it('stores each request as an unread notification and announces each one once', async () => {
    const outcome = await h.dispatcher.dispatch([
      messageRequest(ali.userId, 'm-1'),
      messageRequest(sara.userId, 'm-1'),
    ]);
    expect(outcome).toMatchObject({ duplicates: 0, invalid: 0, inactive: 0, optedOut: 0 });
    expect(outcome.created).toHaveLength(2);

    const [mine] = await h.inbox(ali);
    expect(mine).toMatchObject({
      recipientUserId: ali.userId,
      type: 'MESSAGE_RECEIVED',
      category: 'MESSAGES',
      titleKey: 'notification.message_received.title',
      target: { kind: 'conversation', conversationId: 'c-1' },
      readAt: null,
    });
    expect(created().map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        {
          notificationId: mine?.id,
          recipientUserId: ali.userId,
          type: 'MESSAGE_RECEIVED',
          channels: { realtime: true, push: true },
        },
      ]),
    );
    // Per recipient: one person's notifications are one ordered stream.
    expect(
      created()
        .map((event) => event.aggregateId)
        .sort(),
    ).toEqual([ali.userId, sara.userId].sort());
  });

  // At-least-once delivery: the same fact twice is one notification, and
  // nothing downstream (realtime, push) hears about it twice.
  it('stores a fact delivered twice once, and announces it once', async () => {
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    const again = await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    expect(again).toMatchObject({ created: [], duplicates: 1 });
    expect(await h.inbox(ali)).toHaveLength(1);
    expect(created()).toHaveLength(1);
  });

  it('stores one notification when the same fact arrives concurrently', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')])),
    );
    expect(outcomes.reduce((sum, outcome) => sum + outcome.created.length, 0)).toBe(1);
    expect(await h.inbox(ali)).toHaveLength(1);
    expect(created()).toHaveLength(1);
  });

  it('keeps each recipient to their own notification', async () => {
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    expect(await h.inbox(ali)).toHaveLength(1);
    expect(await h.inbox(sara)).toEqual([]);
  });

  it('treats a repeat inside one batch as a duplicate, not a second row', async () => {
    const outcome = await h.dispatcher.dispatch([
      messageRequest(ali.userId, 'm-1'),
      messageRequest(ali.userId, 'm-1'),
    ]);
    expect(outcome).toMatchObject({ duplicates: 1 });
    expect(outcome.created).toHaveLength(1);
  });

  // Suspended and disabled both mean "may not sign in": identity says
  // `active: false`, and nothing new is stored for them.
  it('creates nothing new for an account that may not sign in, and keeps what it had', async () => {
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    h.messaging.directory.deactivate(ali.userId);

    const outcome = await h.dispatcher.dispatch([
      messageRequest(ali.userId, 'm-2'),
      messageRequest(sara.userId, 'm-2'),
    ]);
    expect(outcome).toMatchObject({ inactive: 1 });
    expect(outcome.created.map((n) => n.recipientUserId)).toEqual([sara.userId]);
    expect((await h.inbox(ali)).map((n) => n.id)).toHaveLength(1);
  });

  it('creates nothing for an account identity does not know', async () => {
    const outcome = await h.dispatcher.dispatch([messageRequest('nobody-at-all', 'm-1')]);
    expect(outcome).toMatchObject({ created: [], inactive: 1 });
  });

  describe('preferences', () => {
    it('store nothing for someone who turned the category off', async () => {
      expectOk(
        await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', inApp: false }),
      );
      const outcome = await h.dispatcher.dispatch([
        messageRequest(ali.userId, 'm-1'),
        messageRequest(sara.userId, 'm-1'),
      ]);
      expect(outcome).toMatchObject({ optedOut: 1 });
      expect(await h.inbox(ali)).toEqual([]);
      expect(await h.inbox(sara)).toHaveLength(1);
    });

    it('with push off, still store the notification — and say push is not wanted', async () => {
      expectOk(
        await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', push: false }),
      );
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      expect(await h.inbox(ali)).toHaveLength(1);
      expect(created()[0]?.payload.channels).toEqual({ realtime: true, push: false });
    });

    it('with realtime off, still store it — and say realtime is not wanted', async () => {
      expectOk(
        await h.updatePreferences.execute({
          principal: ali,
          category: 'MESSAGES',
          realtime: false,
        }),
      );
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      expect(await h.inbox(ali)).toHaveLength(1);
      expect(created()[0]?.payload.channels).toEqual({ realtime: false, push: true });
    });
  });

  it('refuses an invalid request without losing the valid ones beside it', async () => {
    const outcome = await h.dispatcher.dispatch([
      { ...messageRequest(ali.userId, 'm-1'), target: { kind: 'assignment', assignmentId: 'a' } },
      messageRequest(sara.userId, 'm-1'),
    ]);
    expect(outcome).toMatchObject({ invalid: 1 });
    expect(outcome.created.map((n) => n.recipientUserId)).toEqual([sara.userId]);
  });

  it('refuses an unbounded batch — callers page their audiences', async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => messageRequest(`u${i}`, 'm-1'));
    await expect(h.dispatcher.dispatch(tooMany)).rejects.toThrow(RangeError);
  });

  it('asks identity about a whole batch at once, not recipient by recipient', async () => {
    const people = Array.from({ length: 300 }, (_, i) => h.messaging.person('STUDENT', `s${i}`));
    const describe = jest.spyOn(h.messaging.directory, 'describe');
    const preferences = jest.spyOn(h.preferences, 'forUsers');
    await h.dispatcher.dispatch(people.map((p) => messageRequest(p.userId, 'm-1')));
    expect(describe).toHaveBeenCalledTimes(1);
    expect(preferences).toHaveBeenCalledTimes(1);
  });
});
