import { MessagingNotificationTranslator } from '../../src/modules/notifications/application/messaging-notification.translator';
import { PushDelivery } from '../../src/modules/notifications/application/push-delivery';
import { NotificationRealtimeRelay } from '../../src/modules/realtime/application/notification-relay';
import { fcmToken } from '../support/notifications-harness';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

interface WireNotification {
  readonly id: string;
  readonly type: string;
  readonly category: string;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params: Record<string, unknown>;
  readonly target: Record<string, string>;
  readonly createdAt: string;
  readonly readAt: string | null;
}

/**
 * Notifications over HTTP (and the realtime socket), the application exactly
 * as the server runs it with in-memory persistence. Postgres, concurrency and
 * the connected/disconnected/reconnected scenario are in
 * test/integration/notifications-realtime.spec.ts.
 */
describe('notifications API', () => {
  let r: RealtimeApi;
  let teacher: Account;
  let bilal: Account;
  let khalid: Account;
  let outsider: Account;

  beforeAll(async () => {
    r = await startRealtimeApi();
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذ عبدالله');
    bilal = await r.provision('bilal', 'STUDENT', 'بلال');
    khalid = await r.provision('khalid', 'STUDENT', 'خالد');
    outsider = await r.provision('outsider', 'STUDENT', 'زائر');
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  /** Everything the application has scheduled — translation, push, live delivery — done. */
  async function settle(): Promise<void> {
    await r.api.app.get(MessagingNotificationTranslator).idle();
    await r.api.app.get(PushDelivery).idle();
    await r.api.app.get(NotificationRealtimeRelay).idle();
  }

  async function inbox(account: Account): Promise<WireNotification[]> {
    const response = await r.api.call('GET', '/notifications?limit=50', { token: account.token });
    expect(response.status).toBe(200);
    return response.body.items as WireNotification[];
  }

  async function unread(account: Account) {
    return (await r.api.call('GET', '/notifications/unread-count', { token: account.token })).body;
  }

  async function setStatus(account: Account, status: string): Promise<void> {
    const response = await r.api.call('POST', `/admin/users/${account.id}/status`, {
      token: r.owner.token,
      body: { status },
    });
    expect(response.status).toBe(200);
  }

  it('refuses every route to an anonymous caller', async () => {
    for (const [method, path] of [
      ['GET', '/notifications'],
      ['GET', '/notifications/unread-count'],
      ['POST', '/notifications/some-id/read'],
      ['POST', '/notifications/read-all'],
      ['GET', '/notifications/preferences'],
      ['PATCH', '/notifications/preferences'],
      ['POST', '/notifications/devices'],
      ['DELETE', '/notifications/devices/some-id'],
    ] as const) {
      const body = method === 'GET' ? undefined : {};
      expect((await r.api.call(method, path, { body })).status).toBe(401);
    }
  });

  describe('a message becomes a notification', () => {
    let group: string;

    beforeAll(async () => {
      group = await r.group(teacher, [bilal, khalid], 'حلقة الفجر');
      await settle();
    });

    it('in the inbox of each member but the sender, with keys, params and a target', async () => {
      const before = (await inbox(bilal)).length;
      await r.send(teacher, group, 'واجب اليوم: سورة الملك');
      await settle();
      const [newest, ...rest] = await inbox(bilal);
      expect(rest).toHaveLength(before);
      expect(newest).toEqual({
        id: expect.any(String),
        type: 'MESSAGE_RECEIVED',
        category: 'MESSAGES',
        titleKey: 'notification.message_received.title',
        bodyKey: 'notification.message_received.body',
        params: {
          senderDisplayName: 'الأستاذ عبدالله',
          messageType: 'TEXT',
          conversationType: 'GROUP',
        },
        target: { kind: 'conversation', conversationId: group },
        createdAt: expect.any(String),
        readAt: null,
      });
      expect(JSON.stringify(newest)).not.toContain('سورة الملك');
      expect((await inbox(teacher)).some((n) => n.type === 'MESSAGE_RECEIVED')).toBe(false);
    });

    it('counts unread, marks one read idempotently, and marks the rest read', async () => {
      const count = await unread(bilal);
      expect(count).toEqual({ count: expect.any(Number), capped: false });
      const [newest] = await inbox(bilal);
      const first = await r.api.call('POST', `/notifications/${newest?.id}/read`, {
        token: bilal.token,
      });
      expect(first.status).toBe(200);
      expect(first.body.readAt).toEqual(expect.any(String));
      const again = await r.api.call('POST', `/notifications/${newest?.id}/read`, {
        token: bilal.token,
      });
      expect(again.body.readAt).toBe(first.body.readAt);
      expect((await unread(bilal)).count).toBe((count.count as number) - 1);

      const all = await r.api.call('POST', '/notifications/read-all', {
        token: bilal.token,
        body: { throughId: newest?.id },
      });
      expect(all.status).toBe(200);
      expect(all.body).toEqual({ markedRead: expect.any(Number), complete: true });
      expect(await unread(bilal)).toEqual({ count: 0, capped: false });
    });

    it('lets nobody read, mark or page past another person’s notification', async () => {
      const [alis] = await inbox(khalid);
      const read = await r.api.call('POST', `/notifications/${alis?.id}/read`, {
        token: outsider.token,
      });
      expect(read.status).toBe(404);
      expect(read.body).toMatchObject({ error: { code: 'notifications.notification_not_found' } });
      const all = await r.api.call('POST', '/notifications/read-all', {
        token: outsider.token,
        body: { throughId: alis?.id },
      });
      expect(all.status).toBe(404);
      expect(await inbox(outsider)).toEqual([]);
      expect((await inbox(khalid))[0]?.readAt).toBeNull();
    });

    it('pages with an opaque cursor, and refuses one it did not make', async () => {
      for (let i = 0; i < 3; i++) await r.send(teacher, group, `رسالة ${i}`);
      await settle();
      const first = await r.api.call('GET', '/notifications?limit=2', { token: khalid.token });
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await r.api.call(
        'GET',
        `/notifications?limit=2&cursor=${first.body.nextCursor as string}`,
        { token: khalid.token },
      );
      const ids = [
        ...(first.body.items as WireNotification[]),
        ...(second.body.items as WireNotification[]),
      ].map((n) => n.id);
      expect(new Set(ids).size).toBe(4);
      const forged = await r.api.call('GET', '/notifications?cursor=forged', {
        token: khalid.token,
      });
      expect(forged.status).toBe(422);
      expect(
        (await r.api.call('GET', '/notifications?limit=500', { token: khalid.token })).status,
      ).toBe(400);
    });
  });

  // A notification is an address, never a key: opening it runs messaging's
  // own authorization, exactly as if the id had been typed.
  describe('opening what a notification points at', () => {
    it('works while the person may see it, and is refused once they may not', async () => {
      const group = await r.group(teacher, [bilal], 'مجموعة المراجعة');
      await r.send(teacher, group, 'مراجعة الجزء الأول');
      await settle();
      const notification = (await inbox(bilal)).find(
        (n) => n.target.conversationId === group && n.type === 'MESSAGE_RECEIVED',
      );
      const path = `/messaging/conversations/${notification?.target.conversationId}`;
      expect((await r.api.call('GET', path, { token: bilal.token })).status).toBe(200);

      await r.removeMember(teacher, group, bilal.id);

      // The notification is still his to read…
      expect((await inbox(bilal)).some((n) => n.id === notification?.id)).toBe(true);
      // …but it opens nothing any more.
      expect((await r.api.call('GET', path, { token: bilal.token })).status).toBe(404);
      expect((await r.api.call('GET', `${path}/messages`, { token: bilal.token })).status).toBe(
        404,
      );
    });
  });

  describe('accounts that may not sign in', () => {
    it.each(['SUSPENDED', 'DISABLED'])(
      'get nothing new while %s — and keep the history they had',
      async (status) => {
        const member = await r.provision(`member-${status.toLowerCase()}`, 'STUDENT');
        const group = await r.group(teacher, [member], `مجموعة ${status}`);
        await r.send(teacher, group, 'قبل الإيقاف');
        await settle();
        const before = await inbox(member);
        expect(before.some((n) => n.type === 'MESSAGE_RECEIVED')).toBe(true);

        await setStatus(member, status);
        await r.send(teacher, group, 'أثناء الإيقاف');
        await settle();

        await setStatus(member, 'ACTIVE');
        const back = await r.anotherDevice(member); // its sessions ended with the status change
        const after = await inbox(back);
        expect(after.map((n) => n.id)).toEqual(before.map((n) => n.id));
      },
    );
  });

  describe('preferences', () => {
    it('read and change one’s own, and refuse what is not a category', async () => {
      const read = await r.api.call('GET', '/notifications/preferences', { token: khalid.token });
      expect(read.body).toEqual({
        categories: [{ category: 'MESSAGES', inApp: true, realtime: true, push: true }],
      });
      const changed = await r.api.call('PATCH', '/notifications/preferences', {
        token: khalid.token,
        body: { category: 'MESSAGES', push: false },
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toEqual({
        categories: [{ category: 'MESSAGES', inApp: true, realtime: true, push: false }],
      });
      const other = await r.api.call('GET', '/notifications/preferences', { token: bilal.token });
      expect(other.body).toEqual(read.body);

      expect(
        (
          await r.api.call('PATCH', '/notifications/preferences', {
            token: khalid.token,
            body: { category: 'EVERYTHING', push: false },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await r.api.call('PATCH', '/notifications/preferences', {
            token: khalid.token,
            body: { category: 'MESSAGES', push: false, userId: bilal.id },
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('devices', () => {
    it('register the caller’s device, never echo its token, and let only its owner remove it', async () => {
      const token = fcmToken('api-1');
      const registered = await r.api.call('POST', '/notifications/devices', {
        token: bilal.token,
        body: { platform: 'ANDROID', provider: 'FCM', token },
      });
      expect(registered.status).toBe(200);
      expect(registered.body).toEqual({
        id: expect.any(String),
        platform: 'ANDROID',
        provider: 'FCM',
        createdAt: expect.any(String),
        lastSeenAt: expect.any(String),
      });
      const id = registered.body.id as string;

      // A request cannot name another account at all.
      expect(
        (
          await r.api.call('POST', '/notifications/devices', {
            token: bilal.token,
            body: { platform: 'ANDROID', provider: 'FCM', token, userId: khalid.id },
          })
        ).status,
      ).toBe(400);
      expect(
        (await r.api.call('DELETE', `/notifications/devices/${id}`, { token: khalid.token }))
          .status,
      ).toBe(404);
      expect(
        (await r.api.call('DELETE', `/notifications/devices/${id}`, { token: bilal.token })).status,
      ).toBe(204);
      expect(
        (await r.api.call('DELETE', `/notifications/devices/${id}`, { token: bilal.token })).status,
      ).toBe(404);

      expect(
        (
          await r.api.call('POST', '/notifications/devices', {
            token: bilal.token,
            body: { platform: 'ANDROID', provider: 'APNS', token: 'a'.repeat(64) },
          })
        ).status,
      ).toBe(422);
      // Across every response this API has given, the token never appeared.
      expect(r.api.transcript.join('\n')).not.toContain(token);
    });
  });

  describe('live', () => {
    it('reaches the recipient’s open connection at once — and nobody else’s', async () => {
      const group = await r.group(teacher, [bilal], 'مجموعة مباشرة');
      await settle();
      const bilalsSocket = await r.connect(bilal);
      const outsidersSocket = await r.connect(outsider);
      try {
        const message = await r.send(teacher, group, 'هل أنتم مستعدون؟');
        const frame = await bilalsSocket.waitFor(
          (f) =>
            f.type === 'notification.created' &&
            (f.notification as WireNotification).target.conversationId === group,
        );
        expect(frame).toMatchObject({
          version: 1,
          notification: {
            type: 'MESSAGE_RECEIVED',
            params: { senderDisplayName: 'الأستاذ عبدالله' },
            readAt: null,
          },
        });
        await bilalsSocket.waitFor((f) => f.type === 'message.sent' && f.messageId === message.id);
        await settle();
        expect(outsidersSocket.ofType('notification.created')).toEqual([]);

        const id = (frame.notification as WireNotification).id;
        const other = await r.connect(await r.anotherDevice(bilal));
        await r.api.call('POST', `/notifications/${id}/read`, { token: bilal.token });
        await other.waitFor((f) => f.type === 'notification.read' && f.notificationId === id);
        await other.close();
      } finally {
        await bilalsSocket.close();
        await outsidersSocket.close();
      }
    });
  });
});
