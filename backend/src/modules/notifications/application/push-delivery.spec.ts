import { Logger } from '@nestjs/common';

import { expectOk } from '../../../../test/support/identity-harness';
import { META } from '../../../../test/support/messaging-harness';
import {
  fcmToken,
  messageRequest,
  notificationsHarness,
  sessionOn,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';
import { NotificationAuditActions } from './notification-settings';

describe('push delivery', () => {
  let h: NotificationsHarness;
  let teacher: Principal;
  let ali: Principal;
  let sara: Principal;

  beforeEach(async () => {
    h = await notificationsHarness();
    teacher = h.messaging.person('TEACHER', 'الأستاذ أحمد');
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await h.cleanup();
  });

  it('sends a stored notification through the provider port — keys and a target, no names, no text', async () => {
    await h.device(ali, fcmToken(1));
    const direct = await h.messaging.direct(teacher, ali);
    await h.settle();
    h.push.sent.length = 0;
    h.clock.advance(60); // past the "new conversation" push's minute
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

  it('gives up rather than retry sooner than a throttling provider asks', async () => {
    await h.device(ali, fcmToken(1));
    await h.device(ali, fcmToken(2));
    // FAST_PUSH holds a retry for at most 5 ms: 1 s is longer, 0.004 s is not.
    h.push.answer(fcmToken(1), { kind: 'retryable', reason: '429', retryAfterSeconds: 1 });
    h.push.answer(
      fcmToken(2),
      { kind: 'retryable', reason: '429', retryAfterSeconds: 0.004 },
      { kind: 'delivered' },
    );

    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.settle();

    expect(h.push.sendsTo(fcmToken(1))).toBe(1);
    expect(h.push.sendsTo(fcmToken(2))).toBe(2);
    expect(await h.inbox(ali)).toHaveLength(1);
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

    // Another conversation, so the per-thread minute is not what holds it back.
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-2', 'c-2')]);
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

  it('buzzes again for the next message once the conversation was read — however soon', async () => {
    await h.device(ali, fcmToken(1));
    const direct = await h.messaging.direct(teacher, ali);
    await h.settle();
    h.clock.advance(60);
    h.push.sent.length = 0;

    const first = await h.messaging.text(teacher, direct.id, 'السلام عليكم');
    await h.settle();
    // Ali reads it, answers, and puts the phone down…
    expectOk(
      await h.messaging.markRead.execute({
        principal: ali,
        conversationId: direct.id,
        sequence: first.message.sequence,
        meta: META,
      }),
    );
    await h.messaging.text(teacher, direct.id, 'وعليكم السلام'); // …seconds later
    await h.settle();
    expect(h.push.sendsTo(fcmToken(1))).toBe(2);
  });

  it('pushes a burst in one thread to a person once — the inbox still has every notification', async () => {
    await h.device(ali, fcmToken(1));
    await h.device(sara, fcmToken(2));
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-2')]); // the same conversation
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-3', 'c-2')]); // another one
    await h.dispatcher.dispatch([messageRequest(sara.userId, 'm-1')]); // another person
    await h.settle();
    expect(
      h.push.sent
        .map(
          (send) =>
            `${send.device.token === fcmToken(1) ? 'ali' : 'sara'} ${send.message.threadKey}`,
        )
        .sort(),
    ).toEqual(['ali conversation:c-1', 'ali conversation:c-2', 'sara conversation:c-1']);

    h.clock.advance(15); // past the window, the conversation may buzz again
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-4')]);
    await h.settle();
    expect(h.push.sendsTo(fcmToken(1))).toBe(3);
    expect(await h.inbox(ali)).toHaveLength(4);
  });

  describe('only while the device’s session is live (ADR 0058)', () => {
    it('sends nothing to a device whose session ended — and forgets it, audited', async () => {
      const ended = await h.device(ali, fcmToken(1));
      await h.device(ali, fcmToken(2)); // another phone, still signed in
      h.sessions.end(sessionOn(ali, fcmToken(1)));

      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      await h.settle();

      expect(h.push.sent.map((send) => send.device.token)).toEqual([fcmToken(2)]);
      expect((await h.devices.enabledForUsers([ali.userId])).map((d) => d.token)).toEqual([
        fcmToken(2),
      ]);
      expect(h.push.unregistered.map((device) => device.id)).toEqual([ended]);
      expect(h.audit.last(NotificationAuditActions.deviceSessionEnded)).toEqual({
        actorUserId: null,
        action: 'notifications.device.session_ended',
        resourceType: 'notifications.device',
        resourceId: ended,
        at: h.clock.now(),
        metadata: {
          userId: ali.userId,
          platform: 'ANDROID',
          provider: 'FCM',
          reason: 'session_ended',
        },
      });
      expect(JSON.stringify(h.audit.entries)).not.toContain(fcmToken(1));
      expect(await h.inbox(ali)).toHaveLength(1);
    });

    it('keeps a device signed in again while its old session was being checked', async () => {
      const id = await h.device(ali, fcmToken(1), 'ANDROID', 'old-session');
      h.sessions.end('old-session');
      const ask = h.sessions.activeAmong.bind(h.sessions);
      jest.spyOn(h.sessions, 'activeAmong').mockImplementationOnce(async (refs) => {
        await h.device(ali, fcmToken(1), 'ANDROID', 'new-session'); // meanwhile
        return ask(refs);
      });

      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      await h.settle();

      expect(h.push.sent).toEqual([]); // this page saw only the ended session
      expect(
        (await h.devices.enabledForUsers([ali.userId])).map((d) => [d.id, d.sessionId]),
      ).toEqual([[id, 'new-session']]);
      expect(h.audit.last(NotificationAuditActions.deviceSessionEnded)).toBeUndefined();
    });

    it('sends nothing — and forgets nothing — when identity cannot say which sessions are live', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await h.device(ali, fcmToken(1));
      h.sessions.failing = new Error('identity unavailable');

      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      await h.settle();

      expect(h.push.sent).toEqual([]);
      expect(await h.devices.enabledForUsers([ali.userId])).toHaveLength(1);
      expect(await h.inbox(ali)).toHaveLength(1);
    });

    it('retries only while the session is live and the notification unread', async () => {
      await h.device(ali, fcmToken(1));
      await h.device(ali, fcmToken(2));
      // Both fail once; before the retries, one session ends and…
      h.push.answer(fcmToken(1), { kind: 'retryable', reason: '503' }, { kind: 'delivered' });
      h.push.answer(fcmToken(2), { kind: 'retryable', reason: '503' }, { kind: 'delivered' });
      const ask = h.sessions.activeAmong.bind(h.sessions);
      let first = true;
      jest.spyOn(h.sessions, 'activeAmong').mockImplementation(async (refs) => {
        if (!first) h.sessions.end(sessionOn(ali, fcmToken(1)));
        first = false;
        return ask(refs);
      });
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      await h.settle();
      expect(h.push.sendsTo(fcmToken(1))).toBe(1); // its retry withheld: signed out
      expect(h.push.sendsTo(fcmToken(2))).toBe(2);
      expect(h.audit.last(NotificationAuditActions.deviceSessionEnded)?.metadata).toMatchObject({
        reason: 'session_ended',
      });

      // …and a notification read before its retry is not announced again.
      h.push.answer(fcmToken(2), { kind: 'retryable', reason: '503' }, { kind: 'delivered' });
      h.pushDelivery.onModuleDestroy(); // hold push back
      const [stored] = (await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-2', 'c-2')]))
        .created;
      const [event] = h.eventsNamed('notifications.notification.created').slice(-1);
      if (event !== undefined) h.pushDelivery.schedule(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expectOk(await h.markRead.execute({ principal: ali, notificationId: stored?.id ?? '' }));
      await h.pushDelivery.idle();
      expect(h.push.sendsTo(fcmToken(2))).toBe(3); // the first try only
    });

    it('asks identity a thousand sessions at a time', async () => {
      const people = Array.from({ length: 101 }, (_, i) => h.messaging.person('STUDENT', `s${i}`));
      for (const [i, person] of people.entries()) {
        for (let d = 0; d < 10; d++) await h.device(person, fcmToken(`p${i}d${d}`));
      }
      await h.dispatcher.dispatch(people.map((person) => messageRequest(person.userId, 'm-1')));
      await h.settle();
      expect(h.sessions.lookups.map((refs) => refs.length)).toEqual([1000, 10]);
      expect(h.push.sent).toHaveLength(1010);
    });
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
