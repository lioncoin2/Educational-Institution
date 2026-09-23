import { expectOk } from '../../../../test/support/identity-harness';
import {
  fcmToken,
  messageRequest,
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';
import { NotificationAuditActions } from './notification-settings';

describe('push delivery', () => {
  let h: NotificationsHarness;
  let teacher: Principal;
  let ali: Principal;

  beforeEach(async () => {
    h = await notificationsHarness();
    teacher = h.messaging.person('TEACHER', 'الأستاذ أحمد');
    ali = h.messaging.person('STUDENT', 'علي');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('sends a stored notification through the provider port — keys and a target, no names, no text', async () => {
    await h.device(ali, fcmToken(1));
    const direct = await h.messaging.direct(teacher, ali);
    await h.settle();
    h.push.sent.length = 0;
    await h.messaging.text(teacher, direct.id, 'موعد التسميع السابعة');
    await h.settle();

    const notification = (await h.inbox(ali)).find((n) => n.type === 'MESSAGE_RECEIVED');
    expect(h.push.sent).toEqual([
      {
        device: {
          id: expect.any(String),
          platform: 'ANDROID',
          provider: 'FCM',
          token: fcmToken(1),
        },
        message: {
          notificationId: notification?.id,
          type: 'MESSAGE_RECEIVED',
          titleKey: 'notification.message_received.title',
          bodyKey: 'notification.message_received.body_private',
          bodyArgs: [],
          target: { kind: 'conversation', conversationId: direct.id },
          threadKey: `conversation:${direct.id}`,
        },
      },
    ]);
    const wire = JSON.stringify(h.push.sent);
    expect(wire).not.toContain('الأستاذ أحمد');
    expect(wire).not.toContain('التسميع');
  });

  it('sends a notification once, however often its fact arrived', async () => {
    await h.device(ali, fcmToken(1));
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.settle();
    expect(h.push.sendsTo(fcmToken(1))).toBe(1);
  });

  it('sends nothing to someone who turned push off — whose inbox still has it', async () => {
    await h.device(ali, fcmToken(1));
    expectOk(
      await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', push: false }),
    );
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.settle();
    expect(h.push.sent).toEqual([]);
    expect(await h.inbox(ali)).toHaveLength(1);
  });

  it('keeps the notification whatever the provider does — rejects, throws, or is down', async () => {
    await h.device(ali, fcmToken(1));
    await h.device(ali, fcmToken(2));
    await h.device(ali, fcmToken(3));
    h.push.answer(fcmToken(1), { kind: 'rejected', reason: 'payload too large' });
    h.push.throwFor(fcmToken(2));
    h.push.answer(fcmToken(3), { kind: 'retryable', reason: 'unavailable' });

    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.settle();

    const inbox = await h.inbox(ali);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.readAt).toBeNull();
    expect(await h.unread(ali)).toEqual({ count: 1, capped: false });
  });

  it('retries a transient failure a few times, then gives up — and never retries a permanent one', async () => {
    await h.device(ali, fcmToken(1));
    await h.device(ali, fcmToken(2));
    await h.device(ali, fcmToken(3));
    h.push.answer(fcmToken(1), { kind: 'retryable', reason: 'throttled' });
    h.push.answer(fcmToken(2), { kind: 'rejected', reason: 'bad payload' });
    h.push.answer(
      fcmToken(3),
      { kind: 'retryable', reason: '503', retryAfterSeconds: 0 },
      { kind: 'delivered' },
    );

    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.settle();

    expect(h.push.sendsTo(fcmToken(1))).toBe(3); // maxAttempts
    expect(h.push.sendsTo(fcmToken(2))).toBe(1);
    expect(h.push.sendsTo(fcmToken(3))).toBe(2);
  });

  it('treats an adapter that throws as a transient failure, bounded by the same limit', async () => {
    await h.device(ali, fcmToken(1));
    h.push.throwFor(fcmToken(1));
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.settle();
    expect(h.push.sendsTo(fcmToken(1))).toBe(3);
  });

  it('switches off a device whose token the provider says is dead, and audits it', async () => {
    const id = await h.device(ali, fcmToken(1));
    h.push.answer(fcmToken(1), { kind: 'invalid_token', reason: 'UNREGISTERED' });
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.settle();
    expect(await h.devices.enabledForUsers([ali.userId])).toEqual([]);
    expect(h.audit.last(NotificationAuditActions.deviceDisabled)).toMatchObject({
      actorUserId: null,
      resourceId: id,
      metadata: {
        userId: ali.userId,
        platform: 'ANDROID',
        provider: 'FCM',
        reason: 'invalid_token',
      },
    });

    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-2')]);
    await h.settle();
    expect(h.push.sendsTo(fcmToken(1))).toBe(1); // never again

    // Registering it again (the app got the same token back) switches it on.
    await h.device(ali, fcmToken(1));
    expect(await h.devices.enabledForUsers([ali.userId])).toHaveLength(1);
  });

  it('skips a notification already read before push got to it', async () => {
    await h.device(ali, fcmToken(1));
    h.pushDelivery.onModuleDestroy(); // hold push back
    const [stored] = (await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')])).created;
    expectOk(await h.markRead.execute({ principal: ali, notificationId: stored?.id ?? '' }));
    const [event] = h.eventsNamed('notifications.notification.created');
    if (event !== undefined) h.pushDelivery.schedule(event);
    await h.pushDelivery.idle();
    expect(h.push.sent).toEqual([]);
  });

  it('looks up a whole page of recipients’ devices at once', async () => {
    const people = Array.from({ length: 200 }, (_, i) => h.messaging.person('STUDENT', `s${i}`));
    for (const [i, person] of people.entries()) await h.device(person, fcmToken(`p${i}`));
    const lookups = jest.spyOn(h.devices, 'enabledForUsers');
    await h.dispatcher.dispatch(people.map((person) => messageRequest(person.userId, 'm-1')));
    await h.settle();
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(h.push.sent).toHaveLength(200);
  });
});
