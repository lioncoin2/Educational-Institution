import { sql } from 'drizzle-orm';

import { domainEvent } from '../../src/shared';
import { MessagingEvents } from '../../src/modules/messaging/contracts';
import { MessagingNotificationTranslator } from '../../src/modules/notifications/application/messaging-notification.translator';
import { PushDelivery } from '../../src/modules/notifications/application/push-delivery';
import { NotificationRealtimeRelay } from '../../src/modules/realtime/application/notification-relay';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import { ConversationMirror, type Frame, type TestSocket } from '../support/realtime-client';

interface WireNotification {
  readonly id: string;
  readonly type: string;
  readonly target: Record<string, string>;
  readonly readAt: string | null;
}

/**
 * The whole notification path on the real stack, in the three situations a
 * phone is actually in:
 *
 *   BUSINESS EVENT (messaging.message.sent, after Postgres has the message)
 *     → NOTIFICATION TRANSLATOR → IDEMPOTENT PERSISTENCE (Postgres)
 *     → notifications.notification.created
 *         → REALTIME (the same socket as messages) → the app
 *         → PUSH (the configured provider — logging, in V1)
 *   and back: the app opens the notification's target through messaging's
 *   ordinary, authorized HTTP API.
 *
 *   1. B is connected when A writes.
 *   2. B is gone when A writes again.
 *   3. B comes back: messages by catch-up, the notification from the inbox,
 *      nothing twice.
 */
describeWithPostgres('notifications on Postgres, end to end over realtime', () => {
  let scratch: ScratchDatabase;
  let r: RealtimeApi;
  let a: Account;
  let b: Account;
  let group: string;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  async function settle(): Promise<void> {
    await r.api.app.get(MessagingNotificationTranslator).idle();
    await r.api.app.get(PushDelivery).idle();
    await r.api.app.get(NotificationRealtimeRelay).idle();
    await r.relay.idle();
  }

  async function unread(account: Account) {
    return (await r.api.call('GET', '/notifications/unread-count', { token: account.token })).body;
  }

  async function inbox(account: Account): Promise<WireNotification[]> {
    return (await r.api.call('GET', '/notifications', { token: account.token })).body
      .items as WireNotification[];
  }

  const messageNotificationsFor = (userId: string) =>
    rows<{ id: string; dedupe_key: string }>(sql`
      select id, dedupe_key from notifications
      where recipient_user_id = ${userId} and type = 'MESSAGE_RECEIVED' order by created_at`);

  beforeAll(async () => {
    scratch = await scratchDatabase();
    r = await startRealtimeApi({ DATABASE_URL: scratch.url });
    a = await r.provision('nr-teacher', 'TEACHER', 'الأستاذ عبدالله');
    b = await r.provision('nr-student', 'STUDENT', 'بلال');
    group = await r.group(a, [b], 'حلقة التجويد');
    await settle();
    // Being put in the group is itself a notification; start the count from here.
    await r.api.call('POST', '/notifications/read-all', { token: b.token, body: {} });
  }, 120_000);

  afterAll(async () => {
    await r?.close();
    await scratch?.drop();
  });

  it('delivers, persists, reconnects and deduplicates — the whole scenario', async () => {
    const mirror = new ConversationMirror(group, (after) => r.messagesAfter(b, group, after));
    mirror.baselineAt(0);

    // ── 1. B is connected; A sends ─────────────────────────────────────────
    let bSocket: TestSocket = await r.connect(b);
    const first = await r.send(a, group, 'السلام عليكم، ابدؤوا بالمراجعة');

    const [storedMessage] = await rows<{ id: string }>(
      sql`select id from messages where id = ${first.id}`,
    );
    expect(storedMessage?.id).toBe(first.id); // the message is persisted

    const liveMessage = await bSocket.waitFor(
      (f) => f.type === 'message.sent' && f.messageId === first.id,
    );
    expect(mirror.receive(liveMessage)).toBe('merged'); // B has the message live

    const liveNotification = await bSocket.waitFor((f: Frame) => f.type === 'notification.created');
    const notification = liveNotification.notification as WireNotification;
    expect(notification).toMatchObject({
      type: 'MESSAGE_RECEIVED',
      target: { kind: 'conversation', conversationId: group },
      readAt: null,
    });
    await settle();
    const persisted = await messageNotificationsFor(b.id);
    expect(persisted.map((n) => n.id)).toEqual([notification.id]); // the notification is persisted
    expect(persisted[0]?.dedupe_key).toBe(`message:${first.id}:user:${b.id}`);
    expect(await unread(b)).toEqual({ count: 1, capped: false }); // the badge went up

    // Opening it: marked read, then its target opened through messaging's own API.
    const opened = await r.api.call('POST', `/notifications/${notification.id}/read`, {
      token: b.token,
    });
    expect(opened.status).toBe(200);
    expect(opened.body.readAt).toEqual(expect.any(String));
    expect(await unread(b)).toEqual({ count: 0, capped: false });
    const target = await r.api.call(
      'GET',
      `/messaging/conversations/${notification.target.conversationId}`,
      { token: b.token },
    );
    expect(target.status).toBe(200);
    expect(target.body.id).toBe(group);

    // ── 2. B disconnects; A sends again ────────────────────────────────────
    bSocket.kill();
    const second = await r.send(a, group, 'هل راجعتم الجزء الثاني؟');
    await settle();
    expect(await rows(sql`select id from messages where id = ${second.id}`)).toHaveLength(1); // the message is persisted
    expect((await messageNotificationsFor(b.id)).map((n) => n.dedupe_key)).toEqual([
      `message:${first.id}:user:${b.id}`,
      `message:${second.id}:user:${b.id}`,
    ]); // so is the notification, with nobody connected to receive it

    // ── 3. B reconnects ────────────────────────────────────────────────────
    bSocket = await r.connect(b);
    bSocket.send({ type: 'subscribe', conversationId: group, id: 'resync' });
    expect(await bSocket.waitFor((f) => f.type === 'subscribed')).toMatchObject({
      conversationId: group,
      lastSequence: 2,
    });
    await mirror.catchUp(); // the missed message, over HTTP
    expect(mirror.messages.map((m) => m.id)).toEqual([first.id, second.id]);

    const [waiting, older] = await inbox(b);
    expect(waiting).toMatchObject({ type: 'MESSAGE_RECEIVED', readAt: null }); // waiting in the inbox
    expect(older?.id).toBe(notification.id);
    expect(await unread(b)).toEqual({ count: 1, capped: false });

    // The same fact delivered again — an outbox retry, a replay — changes nothing.
    await r.api.app.get(MessagingNotificationTranslator).translate(
      domainEvent(
        MessagingEvents.messageSent,
        group,
        {
          conversationId: group,
          conversationType: 'GROUP',
          messageId: second.id,
          sequence: 2,
          senderId: a.id,
          messageType: 'TEXT',
        },
        new Date(),
      ),
    );
    await settle();
    expect(await messageNotificationsFor(b.id)).toHaveLength(2);
    expect(bSocket.ofType('notification.created')).toEqual([]); // nothing announced twice
    expect(await unread(b)).toEqual({ count: 1, capped: false });

    await bSocket.close();
  }, 60_000);
});
