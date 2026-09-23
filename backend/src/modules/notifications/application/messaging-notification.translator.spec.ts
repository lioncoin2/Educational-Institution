import { expectOk } from '../../../../test/support/identity-harness';
import { META } from '../../../../test/support/messaging-harness';
import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import { domainEvent, type DomainEvent, type Principal } from '../../../shared';
import { MessagingEvents } from '../../messaging/contracts';

describe('messaging notifications', () => {
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
    await h.cleanup();
  });

  const lastEvent = (name: string): DomainEvent => {
    const event = [...h.messaging.events.published].reverse().find((e) => e.name === name);
    if (event === undefined) throw new Error(`no ${name} published`);
    return event;
  };

  describe('a new message', () => {
    it('notifies every member who may read it — never its sender', async () => {
      const group = await h.messaging.group(teacher, [ali, sara]);
      await h.settle();
      const sent = await h.messaging.text(teacher, group.id, 'السلام عليكم، الدرس غدًا');
      await h.settle();

      for (const student of [ali, sara]) {
        const received = (await h.inbox(student)).filter((n) => n.type === 'MESSAGE_RECEIVED');
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          titleKey: 'notification.message_received.title',
          bodyKey: 'notification.message_received.body',
          params: {
            senderDisplayName: 'الأستاذ أحمد',
            messageType: 'TEXT',
            conversationType: 'GROUP',
          },
          target: { kind: 'conversation', conversationId: group.id },
        });
      }
      // No "you sent a message" — on any of the sender's devices.
      expect((await h.inbox(teacher)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toEqual([]);
      expect(sent.message.id).toBeDefined();
    });

    it('never carries what the message said', async () => {
      const direct = await h.messaging.direct(teacher, ali);
      await h.messaging.text(teacher, direct.id, 'رقم الغرفة السرّي 4417');
      await h.settle();
      const everything = JSON.stringify(await h.inbox(ali));
      expect(everything).not.toContain('4417');
      expect(JSON.stringify(h.published.published)).not.toContain('4417');
    });

    it('is created once however often the fact is delivered', async () => {
      const direct = await h.messaging.direct(teacher, ali);
      await h.messaging.text(teacher, direct.id, 'مرحبا');
      await h.settle();
      const fact = lastEvent(MessagingEvents.messageSent);
      await Promise.all([h.translator.translate(fact), h.translator.translate(fact)]);
      await h.translator.translate(fact);
      expect((await h.inbox(ali)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toHaveLength(1);
    });

    it('skips someone who joined after it was sent — they cannot open it', async () => {
      const group = await h.messaging.group(teacher, [ali]);
      await h.messaging.text(teacher, group.id, 'قبل انضمام سارة');
      const before = lastEvent(MessagingEvents.messageSent);
      await h.settle();
      expectOk(
        await h.messaging.addParticipants.execute({
          principal: teacher,
          conversationId: group.id,
          userIds: [sara.userId],
          meta: META,
        }),
      );
      // Redelivered after she joined: she still may not see it.
      await h.translator.translate(before);
      expect((await h.inbox(sara)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toEqual([]);
    });

    it('skips someone removed before it was translated', async () => {
      const group = await h.messaging.group(teacher, [ali, sara]);
      await h.settle();
      h.translator.onModuleDestroy(); // hold translation back
      await h.messaging.text(teacher, group.id, 'بعد قليل');
      const fact = lastEvent(MessagingEvents.messageSent);
      expectOk(
        await h.messaging.removeParticipant.execute({
          principal: teacher,
          conversationId: group.id,
          userId: sara.userId,
          meta: META,
        }),
      );
      await h.translator.translate(fact);
      expect((await h.inbox(sara)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toEqual([]);
      expect((await h.inbox(ali)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toHaveLength(1);
    });

    it('skips a member whose account may not sign in — suspended or disabled', async () => {
      const group = await h.messaging.group(teacher, [ali, sara]);
      await h.settle();
      h.messaging.directory.deactivate(sara.userId);
      await h.messaging.text(teacher, group.id, 'تذكير');
      await h.settle();
      expect((await h.inbox(sara)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toEqual([]);
      expect((await h.inbox(ali)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toHaveLength(1);
    });

    it('skips a member whose roles no longer let them read messages', async () => {
      const group = await h.messaging.group(teacher, [ali, sara]);
      await h.settle();
      h.messaging.directory.add(sara.userId, [], { displayName: 'سارة' });
      await h.messaging.text(teacher, group.id, 'تذكير');
      await h.settle();
      expect((await h.inbox(sara)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toEqual([]);
    });

    it('walks a large channel a page at a time', async () => {
      const readers = Array.from({ length: 2500 }, (_, i) =>
        h.messaging.person('STUDENT', `طالب ${i}`),
      );
      const admin = h.messaging.person('ADMIN', 'الإدارة');
      const channel = expectOk(
        await h.messaging.createChannel.execute({
          principal: admin,
          title: 'إعلانات المعهد',
          memberIds: readers.slice(0, 150).map((r) => r.userId),
          publisherIds: [],
          meta: META,
        }),
      );
      for (let i = 150; i < readers.length; i += 150) {
        expectOk(
          await h.messaging.addParticipants.execute({
            principal: admin,
            conversationId: channel.id,
            userIds: readers.slice(i, i + 150).map((r) => r.userId),
            meta: META,
          }),
        );
      }
      await h.settle();
      const dispatch = jest.spyOn(h.dispatcher, 'dispatch');
      await h.messaging.text(admin, channel.id, 'عطلة يوم الخميس');
      await h.settle();

      const sizes = dispatch.mock.calls.map(([requests]) => requests.length);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(2500);
      const [first, last] = [readers[0], readers[2499]] as [Principal, Principal];
      for (const reader of [first, last]) {
        expect((await h.inbox(reader)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toHaveLength(
          1,
        );
      }
    }, 60_000);
  });

  describe('a new conversation', () => {
    it('tells the people it was started with — not the person who started it', async () => {
      const direct = await h.messaging.direct(teacher, ali);
      await h.settle();
      expect(await h.inbox(ali)).toEqual([
        expect.objectContaining({
          type: 'CONVERSATION_CREATED',
          params: { actorDisplayName: 'الأستاذ أحمد', conversationType: 'DIRECT' },
          target: { kind: 'conversation', conversationId: direct.id },
        }),
      ]);
      expect(await h.inbox(teacher)).toEqual([]);
    });
  });

  describe('being added to a conversation', () => {
    it('tells the person added, and nobody else', async () => {
      const group = await h.messaging.group(teacher, [ali]);
      await h.settle();
      expectOk(
        await h.messaging.addParticipants.execute({
          principal: teacher,
          conversationId: group.id,
          userIds: [sara.userId],
          meta: META,
        }),
      );
      await h.settle();
      expect(await h.inbox(sara)).toEqual([
        expect.objectContaining({
          type: 'ADDED_TO_CONVERSATION',
          params: { actorDisplayName: 'الأستاذ أحمد' },
          target: { kind: 'conversation', conversationId: group.id },
        }),
      ]);
      expect((await h.inbox(ali)).map((n) => n.type)).toEqual(['CONVERSATION_CREATED']);
    });

    it('is not announced to someone already removed again when it is translated', async () => {
      const group = await h.messaging.group(teacher, [ali]);
      await h.settle();
      h.translator.onModuleDestroy();
      expectOk(
        await h.messaging.addParticipants.execute({
          principal: teacher,
          conversationId: group.id,
          userIds: [sara.userId],
          meta: META,
        }),
      );
      const added = lastEvent(MessagingEvents.participantAdded);
      expectOk(
        await h.messaging.removeParticipant.execute({
          principal: teacher,
          conversationId: group.id,
          userId: sara.userId,
          meta: META,
        }),
      );
      await h.translator.translate(added);
      expect(await h.inbox(sara)).toEqual([]);
    });
  });

  it('ignores a malformed fact instead of guessing', async () => {
    const malformed = domainEvent(
      MessagingEvents.messageSent,
      'c-1',
      { conversationId: 'c-1', messageId: 42 },
      h.clock.now(),
    );
    await h.translator.translate(malformed);
    await h.translator.translate(
      domainEvent(MessagingEvents.messageSent, 'c-1', null, h.clock.now()),
    );
    expect(h.published.published).toEqual([]);
  });

  it('never holds up the publisher, and stops listening when the module stops', async () => {
    const direct = await h.messaging.direct(teacher, ali);
    const translate = jest.spyOn(h.translator, 'translate');
    await h.messaging.text(teacher, direct.id, 'مرحبا');
    // The send has returned; translation runs detached from it.
    await h.settle();
    expect(translate).toHaveBeenCalled();

    h.translator.onModuleDestroy();
    translate.mockClear();
    await h.messaging.text(teacher, direct.id, 'مرة أخرى');
    await h.settle();
    expect(translate).not.toHaveBeenCalled();
  });
});
