import { expectOk } from '../../../../test/support/identity-harness';
import {
  messageRequest,
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import { FakeLink } from '../../../../test/support/realtime-harness';
import { domainEvent, type Principal } from '../../../shared';
import { NotificationEvents } from '../../notifications/contracts';
import type { Connection } from '../domain/connection';
import { ConnectionManager } from './connection-manager';
import { NotificationRealtimeRelay } from './notification-relay';

const AT = new Date('2026-09-01T08:00:00.000Z');

describe('realtime notifications', () => {
  let h: NotificationsHarness;
  let connections: ConnectionManager;
  let relay: NotificationRealtimeRelay;
  let ali: Principal;
  let sara: Principal;
  let counter = 0;

  /** A live connection for `who`, as the sessions would register it after `auth`. */
  function connect(who: Principal): FakeLink {
    counter += 1;
    const link = new FakeLink();
    const connection: Connection = {
      connectionId: `conn-${counter}`,
      userId: who.userId,
      sessionId: `session-${who.userId}`,
      authenticatedAt: AT,
      expiresAt: new Date(AT.getTime() + 900_000),
      validatedAt: AT,
      lastSeenAt: AT,
      remoteAddress: '203.0.113.9',
      link,
    };
    connections.register(connection);
    return link;
  }

  beforeEach(async () => {
    h = await notificationsHarness();
    connections = new ConnectionManager();
    relay = new NotificationRealtimeRelay(h.bus, h.reader, connections);
    relay.onModuleInit();
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
  });

  afterEach(async () => {
    relay.onModuleDestroy();
    await h.cleanup();
  });

  async function settle(): Promise<void> {
    await h.settle();
    await relay.idle();
  }

  it('delivers a new notification to every connection of its recipient — and nobody else', async () => {
    const phone = connect(ali);
    const tablet = connect(ali);
    const saras = connect(sara);
    const teacher = h.messaging.person('TEACHER', 'الأستاذ أحمد');
    const teachers = connect(teacher);

    const [stored] = (await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')])).created;
    await settle();

    for (const link of [phone, tablet]) {
      expect(link.ofType('notification.created')).toEqual([
        {
          type: 'notification.created',
          version: 1,
          eventId: `notification.created:${stored?.id}`,
          occurredAt: stored?.createdAt.toISOString(),
          notification: {
            id: stored?.id,
            type: 'MESSAGE_RECEIVED',
            category: 'MESSAGES',
            titleKey: 'notification.message_received.title',
            bodyKey: 'notification.message_received.body',
            params: { senderDisplayName: 'أحمد', messageType: 'TEXT', conversationType: 'GROUP' },
            target: { kind: 'conversation', conversationId: 'c-1' },
            createdAt: stored?.createdAt.toISOString(),
            readAt: null,
          },
        },
      ]);
    }
    // Never by role, permission or channel: the recipient, and only them.
    expect(saras.frames).toEqual([]);
    expect(teachers.frames).toEqual([]);
  });

  it('puts nothing on the wire that the inbox does not show — no recipient, no dedupe key', async () => {
    const link = connect(ali);
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await settle();
    const raw = JSON.stringify(link.frames);
    expect(raw).not.toContain('dedupe');
    expect(raw).not.toContain('message:m-1');
    expect(raw).not.toContain('recipientUserId');
  });

  it('delivers nothing live to someone who turned realtime off — the inbox still has it', async () => {
    const link = connect(ali);
    expectOk(
      await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', realtime: false }),
    );
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await settle();
    expect(link.frames).toEqual([]);
    expect(await h.inbox(ali)).toHaveLength(1);
  });

  it('asks for nothing when the recipient is not connected — the inbox is where it waits', async () => {
    connect(sara);
    const reads = jest.spyOn(h.reader, 'forDelivery');
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
    await settle();
    expect(reads).not.toHaveBeenCalled();
    expect(await h.inbox(ali)).toHaveLength(1);
  });

  it('renders a whole page of recipients with one read', async () => {
    const people = Array.from({ length: 300 }, (_, i) => h.messaging.person('STUDENT', `s${i}`));
    const links = people.map((person) => connect(person));
    const reads = jest.spyOn(h.reader, 'forDelivery');
    await h.dispatcher.dispatch(people.map((person) => messageRequest(person.userId, 'm-1')));
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(links.every((link) => link.ofType('notification.created').length === 1)).toBe(true);
  });

  it('tells the owner’s other devices when one is read, or everything is', async () => {
    const phone = connect(ali);
    const saras = connect(sara);
    const [stored] = (await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')])).created;
    await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-2')]);
    await settle();

    const read = expectOk(
      await h.markRead.execute({ principal: ali, notificationId: stored?.id ?? '' }),
    );
    expectOk(await h.markAllRead.execute({ principal: ali }));
    await settle();

    expect(phone.ofType('notification.read')).toEqual([
      {
        type: 'notification.read',
        version: 1,
        eventId: `notification.read:${stored?.id}`,
        occurredAt: read.readAt?.toISOString(),
        notificationId: stored?.id,
        readAt: read.readAt?.toISOString(),
      },
    ]);
    expect(phone.ofType('notification.read_all')).toEqual([
      expect.objectContaining({
        type: 'notification.read_all',
        throughCreatedAt: h.clock.now().toISOString(),
        throughId: null,
      }),
    ]);
    expect(saras.frames).toEqual([]);
  });

  it('renders what is stored when it goes out — read already, if it was', async () => {
    const link = connect(ali);
    relay.onModuleDestroy(); // hold delivery back
    const [stored] = (await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')])).created;
    expectOk(await h.markRead.execute({ principal: ali, notificationId: stored?.id ?? '' }));
    const [created] = h.eventsNamed(NotificationEvents.created);
    if (created !== undefined) relay.schedule(created);
    await relay.idle();
    const [frame] = link.ofType('notification.created');
    expect((frame?.notification as { readAt: string | null }).readAt).not.toBeNull();
  });

  it('ignores a malformed event instead of guessing', async () => {
    const link = connect(ali);
    relay.schedule(domainEvent(NotificationEvents.created, ali.userId, { notificationId: 7 }, AT));
    relay.schedule(domainEvent(NotificationEvents.read, ali.userId, null, AT));
    relay.schedule(
      domainEvent(NotificationEvents.allRead, ali.userId, { recipientUserId: ali.userId }, AT),
    );
    await relay.idle();
    expect(link.frames).toEqual([]);
  });
});
