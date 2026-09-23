import { Logger } from '@nestjs/common';

import { expectOk } from '../../../../test/support/identity-harness';
import { META } from '../../../../test/support/messaging-harness';
import {
  realtimeHarness,
  type Client,
  type Frame,
  type Person,
  type RealtimeHarness,
} from '../../../../test/support/realtime-harness';
import { domainEvent } from '../../../shared';
import { Roles } from '../../identity/domain/role';
import { MessagingEvents } from '../../messaging/contracts/events';

const sentTo = (client: Client) => client.link.ofType('message.sent');

describe('messaging events, delivered in real time', () => {
  let h: RealtimeHarness;
  let teacher: Person;
  let studentB: Person;
  let studentC: Person;
  let groupId: string;

  beforeEach(async () => {
    h = await realtimeHarness();
    teacher = await h.person(Roles.teacher, 'الأستاذ عبدالله');
    studentB = await h.person(Roles.student, 'الطالب بلال');
    studentC = await h.person(Roles.student, 'الطالب خالد');
    groupId = (await h.messaging.group(teacher.principal, [studentB.principal, studentC.principal]))
      .id;
  });
  afterEach(() => h.cleanup());

  const send = async (from: Person, body: string, key?: string) =>
    (await h.messaging.text(from.principal, groupId, body, key)).message;

  describe('message.sent', () => {
    it('reaches every member’s connections — each of a member’s devices — and nobody else', async () => {
      const outsider = await h.person(Roles.student);
      const elsewhere = await h.person(Roles.student);
      await h.messaging.group(teacher.principal, [elsewhere.principal], 'another circle');
      const bPhone = await h.connect(studentB.accessToken);
      const bWeb = await h.connect(studentB.accessToken);
      const c = await h.connect(studentC.accessToken);
      const stranger = await h.connect(outsider.accessToken);
      const other = await h.connect(elsewhere.accessToken);

      const message = await send(teacher, 'السلام عليكم');
      await h.settle();

      for (const client of [bPhone, bWeb, c]) {
        expect(sentTo(client).map((frame) => frame.messageId)).toEqual([message.id]);
      }
      expect(sentTo(stranger)).toEqual([]);
      expect(sentTo(other)).toEqual([]);
    });

    it('carries a versioned envelope with the message exactly as the timeline shows it', async () => {
      const b = await h.connect(studentB.accessToken);
      const message = await send(teacher, 'درس اليوم: سورة الملك');
      await h.settle();

      const [frame] = sentTo(b);
      expect(frame).toEqual({
        type: 'message.sent',
        version: 1,
        eventId: `message.sent:${message.id}`,
        occurredAt: message.createdAt.toISOString(),
        conversationId: groupId,
        conversationType: 'GROUP',
        messageId: message.id,
        sequence: 1,
        message: {
          id: message.id,
          conversationId: groupId,
          sequence: 1,
          senderId: teacher.userId,
          type: 'TEXT',
          body: 'درس اليوم: سورة الملك',
          replyToMessageId: null,
          clientMessageId: null,
          createdAt: message.createdAt.toISOString(),
          editedAt: null,
          deletedAt: null,
          attachments: [],
        },
        sender: { userId: teacher.userId, displayName: 'الأستاذ عبدالله' },
      });
    });

    // The sender's own devices get the message too — the phone that sent it
    // reconciles its optimistic copy, the laptop learns about it — and only
    // they see the clientMessageId that makes the reconciliation exact.
    it('reaches the sender’s own devices, with their clientMessageId; others never see it', async () => {
      const teacherPhone = await h.connect(teacher.accessToken);
      const teacherLaptop = await h.connect(teacher.accessToken);
      const b = await h.connect(studentB.accessToken);

      const message = await send(teacher, 'مرحبا', 'optimistic-key-01');
      await h.settle();

      for (const client of [teacherPhone, teacherLaptop]) {
        const [frame] = sentTo(client);
        expect(frame?.messageId).toBe(message.id);
        expect((frame?.message as Frame).clientMessageId).toBe('optimistic-key-01');
      }
      expect((sentTo(b)[0]?.message as Frame).clientMessageId).toBeNull();
      expect(JSON.stringify(b.link.frames)).not.toContain('optimistic-key-01');
    });

    it('carries a file as a reference and a summary — no link, no signature, no storage key', async () => {
      const b = await h.connect(studentB.accessToken);
      const photo = await h.messaging.files.upload(teacher.principal, {
        kind: 'IMAGE',
        contentType: 'image/png',
      });
      expectOk(
        await h.messaging.sendImage.execute({
          principal: teacher.principal,
          conversationId: groupId,
          clientMessageId: 'photo-key-000001',
          fileAssetId: photo.id,
          meta: META,
        }),
      );
      await h.settle();

      const attachment = ((sentTo(b)[0]?.message as Frame).attachments as Frame[])[0];
      expect(attachment).toMatchObject({ fileAssetId: photo.id, available: true, kind: 'IMAGE' });
      expect(JSON.stringify(b.link.frames)).not.toMatch(/https?:|sig=|image\/20\d\d|storageKey/);
    });

    it('stops at the moment of removal: a removed member receives nothing sent after it', async () => {
      const b = await h.connect(studentB.accessToken);
      await send(teacher, 'before');
      expectOk(
        await h.messaging.removeParticipant.execute({
          principal: teacher.principal,
          conversationId: groupId,
          userId: studentB.userId,
          meta: META,
        }),
      );
      await send(teacher, 'after');
      await h.settle();

      expect(sentTo(b).map((frame) => (frame.message as Frame).body)).toEqual(['before']);
      // Removal took nothing but this conversation away.
      expect(b.link.closed).toBeNull();
    });

    it('does not reach someone added after it was sent — the group hides earlier history', async () => {
      const late = await h.person(Roles.student);
      const lateClient = await h.connect(late.accessToken);
      const early = await send(teacher, 'before they joined');
      const event = h.messaging.events.published.find(
        (e) => e.name === MessagingEvents.messageSent,
      )!;
      expectOk(
        await h.messaging.addParticipants.execute({
          principal: teacher.principal,
          conversationId: groupId,
          userIds: [late.userId],
          meta: META,
        }),
      );
      // The event for the earlier message is delivered after they joined.
      await h.relay.relay(event);

      expect(sentTo(lateClient)).toEqual([]);
      expect(early.sequence).toBe(1);
    });

    it('does not even ask who the members are when nobody is connected', async () => {
      const list = jest.spyOn(h.messaging.recipients, 'list');
      await send(teacher, 'into the void');
      await h.settle();
      expect(list).not.toHaveBeenCalled();
    });

    it('delivers one conversation’s events in the order they were published', async () => {
      const b = await h.connect(studentB.accessToken);
      const original = h.messaging.delivery.message.bind(h.messaging.delivery);
      let first = true;
      jest.spyOn(h.messaging.delivery, 'message').mockImplementation(async (...args) => {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 30)); // the first is slow
        }
        return original(...args);
      });
      await send(teacher, 'one');
      await send(teacher, 'two');
      await send(teacher, 'three');
      await h.settle();

      expect(sentTo(b).map((frame) => frame.sequence)).toEqual([1, 2, 3]);
    });

    it('gives a fact delivered twice the same eventId, so a client drops the copy', async () => {
      const b = await h.connect(studentB.accessToken);
      await send(teacher, 'once');
      await h.settle();
      const event = h.messaging.events.published.find(
        (e) => e.name === MessagingEvents.messageSent,
      )!;
      await h.relay.relay(event); // redelivery — e.g. a retrying outbox

      const [a, again] = sentTo(b);
      expect(again).toEqual(a);
    });
  });

  describe('message.read', () => {
    it("tells the reader's own devices how far they have read — and nobody else", async () => {
      const bPhone = await h.connect(studentB.accessToken);
      const bWeb = await h.connect(studentB.accessToken);
      const t = await h.connect(teacher.accessToken);
      const c = await h.connect(studentC.accessToken);
      await send(teacher, 'one');
      await send(teacher, 'two');
      expectOk(
        await h.messaging.markRead.execute({
          principal: studentB.principal,
          conversationId: groupId,
          sequence: 2,
          meta: META,
        }),
      );
      await h.settle();

      for (const client of [bPhone, bWeb]) {
        expect(client.link.ofType('message.read')).toEqual([
          {
            type: 'message.read',
            version: 1,
            eventId: `message.read:${groupId}:${studentB.userId}:2`,
            occurredAt: expect.any(String),
            conversationId: groupId,
            userId: studentB.userId,
            lastReadSequence: 2,
          },
        ]);
      }
      expect(t.link.ofType('message.read')).toEqual([]);
      expect(c.link.ofType('message.read')).toEqual([]);
    });
  });

  describe('membership', () => {
    it('tells everyone a conversation was created with — and nobody else', async () => {
      const t = await h.connect(teacher.accessToken);
      const b = await h.connect(studentB.accessToken);
      const c = await h.connect(studentC.accessToken);
      const created = await h.messaging.group(teacher.principal, [studentB.principal], 'جديدة');
      await h.settle();

      for (const client of [t, b]) {
        expect(client.link.ofType('conversation.created')).toEqual([
          {
            type: 'conversation.created',
            version: 1,
            eventId: `conversation.created:${created.id}`,
            occurredAt: expect.any(String),
            conversationId: created.id,
            conversationType: 'GROUP',
          },
        ]);
      }
      expect(c.link.ofType('conversation.created')).toEqual([]);
    });

    it('tells a person they were added — and nobody else', async () => {
      const newcomer = await h.person(Roles.student);
      const n = await h.connect(newcomer.accessToken);
      const b = await h.connect(studentB.accessToken);
      expectOk(
        await h.messaging.addParticipants.execute({
          principal: teacher.principal,
          conversationId: groupId,
          userIds: [newcomer.userId],
          meta: META,
        }),
      );
      await h.settle();

      expect(n.link.ofType('participant.added')).toEqual([
        expect.objectContaining({
          type: 'participant.added',
          version: 1,
          conversationId: groupId,
          userId: newcomer.userId,
          role: 'MEMBER',
        }),
      ]);
      expect(b.link.ofType('participant.added')).toEqual([]);
    });

    it('tells a person they were removed, with no content — and nobody else', async () => {
      const b = await h.connect(studentB.accessToken);
      const c = await h.connect(studentC.accessToken);
      expectOk(
        await h.messaging.removeParticipant.execute({
          principal: teacher.principal,
          conversationId: groupId,
          userId: studentB.userId,
          meta: META,
        }),
      );
      await h.settle();

      expect(b.link.ofType('participant.removed')).toEqual([
        {
          type: 'participant.removed',
          version: 1,
          eventId: expect.stringMatching(/^participant\.removed:/),
          occurredAt: expect.any(String),
          conversationId: groupId,
          userId: studentB.userId,
          reason: 'removed',
        },
      ]);
      expect(c.link.ofType('participant.removed')).toEqual([]);
    });
  });

  describe('failure', () => {
    it('never lets a delivery failure touch the stored message', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const b = await h.connect(studentB.accessToken);
      jest
        .spyOn(h.messaging.delivery, 'message')
        .mockRejectedValueOnce(new Error('rendering failed'));

      const sent = expectOk(
        await h.messaging.sendText.execute({
          principal: teacher.principal,
          conversationId: groupId,
          clientMessageId: 'survives-0000001',
          body: 'still stored',
          meta: META,
        }),
      );
      await h.settle();

      expect(sent.created).toBe(true);
      const page = expectOk(
        await h.messaging.listMessages.execute({
          principal: studentB.principal,
          conversationId: groupId,
        }),
      );
      expect(page.items.map((m) => m.body)).toEqual(['still stored']);
      expect(sentTo(b)).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);

      // The next event is delivered as usual.
      await send(teacher, 'next');
      await h.settle();
      expect(sentTo(b).map((frame) => frame.sequence)).toEqual([2]);
      logged.mockRestore();
    });

    it('ignores a malformed event instead of guessing', async () => {
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const b = await h.connect(studentB.accessToken);
      await h.relay.relay(
        domainEvent(MessagingEvents.messageSent, groupId, { conversationId: groupId }, new Date()),
      );
      expect(b.link.frames.filter((frame) => frame.type !== 'ready')).toEqual([]);
      expect(warned).toHaveBeenCalledTimes(1);
      warned.mockRestore();
    });
  });
});
