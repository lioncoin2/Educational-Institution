import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { Roles } from '../../identity/domain/role';
import { MessagingEvents } from '../contracts/events';
import { UNREAD_COUNT_CAP } from '../domain/messaging-policy';

describe('reading conversations', () => {
  let h: MessagingHarness;
  beforeEach(async () => {
    h = await messagingHarness();
  });
  afterEach(() => h.cleanup());

  describe('the conversation list', () => {
    it('lists only the caller’s conversations, most recently active first', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const stranger = h.person(Roles.teacher);
      const quiet = await h.group(teacher, [student], 'Quiet');
      h.clock.advance(60);
      const busy = await h.group(teacher, [student], 'Busy');
      h.clock.advance(60);
      await h.text(teacher, quiet.id, 'wakes up');
      await h.group(stranger, [], 'Not yours');

      const list = expectOk(await h.listConversations.execute({ principal: student }));
      expect(list.items.map((c) => c.title)).toEqual(['Quiet', 'Busy']);
      expect(list.items[0]).toMatchObject({
        unreadCount: 1,
        lastMessage: { sequence: 1, senderId: teacher.userId, type: 'TEXT', text: 'wakes up' },
      });
      expect(list.items.map((c) => c.id)).not.toContain(undefined);
      expect(list.items.map((c) => c.id)).toEqual([quiet.id, busy.id]);
    });

    it('pages with an opaque cursor, each conversation exactly once', async () => {
      const teacher = h.person(Roles.teacher);
      const titles: string[] = [];
      for (let i = 0; i < 7; i++) {
        titles.unshift(`G${i}`);
        await h.group(teacher, [], `G${i}`);
        h.clock.advance(1);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = expectOk(
          await h.listConversations.execute({ principal: teacher, cursor, limit: 3 }),
        );
        seen.push(...page.items.map((c) => c.title ?? ''));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual(titles);
    });

    it('refuses a cursor it did not issue', async () => {
      const teacher = h.person(Roles.teacher);
      for (const cursor of ['garbage', Buffer.from('["x"]').toString('base64url')]) {
        expect(
          expectErr(await h.listConversations.execute({ principal: teacher, cursor })).code,
        ).toBe('messaging.cursor_invalid');
      }
    });

    it('caps the unread count', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      await h.burst(teacher, group.id, UNREAD_COUNT_CAP + 20);
      const view = expectOk(
        await h.getConversation.execute({ principal: student, conversationId: group.id }),
      );
      expect(view.unreadCount).toBe(UNREAD_COUNT_CAP);
      expect(view.lastSequence).toBe(UNREAD_COUNT_CAP + 20);
    });
  });

  describe('the timeline', () => {
    async function withHistory(count: number) {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      await h.burst(teacher, group.id, count);
      return { teacher, student, group };
    }
    const sequences = (page: { items: readonly { sequence: number }[] }) =>
      page.items.map((m) => m.sequence);

    it('returns the latest page first, oldest to newest within it', async () => {
      const { student, group } = await withHistory(12);
      const page = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: group.id, limit: 5 }),
      );
      expect(sequences(page)).toEqual([8, 9, 10, 11, 12]);
      expect(page).toMatchObject({ hasOlder: true, hasNewer: false, lastReadSequence: 0 });
      expect(page.senders).toHaveLength(1);
    });

    it('walks back through all history with `before`, each message exactly once', async () => {
      const { student, group } = await withHistory(23);
      const seen: number[] = [];
      let before: number | undefined;
      for (;;) {
        const page = expectOk(
          await h.listMessages.execute({
            principal: student,
            conversationId: group.id,
            before,
            limit: 5,
          }),
        );
        seen.unshift(...sequences(page));
        if (!page.hasOlder) break;
        before = page.items[0]?.sequence;
      }
      expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    });

    it('catches up forward with `after`', async () => {
      const { student, group } = await withHistory(10);
      const page = expectOk(
        await h.listMessages.execute({
          principal: student,
          conversationId: group.id,
          after: 4,
          limit: 3,
        }),
      );
      expect(sequences(page)).toEqual([5, 6, 7]);
      expect(page).toMatchObject({ hasOlder: true, hasNewer: true });
      const rest = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: group.id, after: 7 }),
      );
      expect(sequences(rest)).toEqual([8, 9, 10]);
      expect(rest.hasNewer).toBe(false);
    });

    it('refuses contradictory or malformed cursors', async () => {
      const { student, group } = await withHistory(1);
      for (const cursor of [{ before: 3, after: 1 }, { before: -1 }, { after: 1.5 }]) {
        const result = await h.listMessages.execute({
          principal: student,
          conversationId: group.id,
          ...cursor,
        });
        expect(expectErr(result).code).toBe('messaging.cursor_invalid');
      }
    });

    // Q21, provisional: a group's earlier messages are not shown to newcomers.
    it("shows a group's newcomer only what was said after they joined", async () => {
      const { teacher, group } = await withHistory(5);
      const newcomer = h.person(Roles.student);
      expectOk(
        await h.addParticipants.execute({
          principal: teacher,
          conversationId: group.id,
          userIds: [newcomer.userId],
          meta: META,
        }),
      );
      await h.text(teacher, group.id, 'welcome');

      const page = expectOk(
        await h.listMessages.execute({ principal: newcomer, conversationId: group.id }),
      );
      expect(sequences(page)).toEqual([6]);
      expect(page.hasOlder).toBe(false);
      const older = expectOk(
        await h.listMessages.execute({ principal: newcomer, conversationId: group.id, before: 6 }),
      );
      expect(older.items).toEqual([]);
      const view = expectOk(
        await h.getConversation.execute({ principal: newcomer, conversationId: group.id }),
      );
      expect(view).toMatchObject({ unreadCount: 1, lastMessage: { sequence: 6 } });
    });

    it("shows a channel's newcomer the whole history, with nothing unread", async () => {
      const admin = h.person(Roles.admin);
      const channel = expectOk(
        await h.createChannel.execute({
          principal: admin,
          title: 'News',
          memberIds: [],
          publisherIds: [],
          meta: META,
        }),
      );
      await h.burst(admin, channel.id, 4);
      const student = h.person(Roles.student);
      expectOk(
        await h.addParticipants.execute({
          principal: admin,
          conversationId: channel.id,
          userIds: [student.userId],
          meta: META,
        }),
      );
      const page = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: channel.id }),
      );
      expect(sequences(page)).toEqual([1, 2, 3, 4]);
      const view = expectOk(
        await h.getConversation.execute({ principal: student, conversationId: channel.id }),
      );
      expect(view.unreadCount).toBe(0);
    });
  });

  describe('read state', () => {
    it('moves the watermark forward only, and never past the last message', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      await h.burst(teacher, group.id, 5);
      const read = (sequence: number) =>
        h.markRead.execute({ principal: student, conversationId: group.id, sequence, meta: META });

      expect(expectOk(await read(3))).toEqual({ lastReadSequence: 3 });
      expect(expectOk(await read(1))).toEqual({ lastReadSequence: 3 }); // a stale device
      expect(expectOk(await read(999))).toEqual({ lastReadSequence: 5 }); // the future
      const view = expectOk(
        await h.getConversation.execute({ principal: student, conversationId: group.id }),
      );
      expect(view).toMatchObject({ lastReadSequence: 5, unreadCount: 0 });
    });

    it('announces only real progress', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      await h.burst(teacher, group.id, 2);
      for (const sequence of [2, 2, 1]) {
        await h.markRead.execute({
          principal: student,
          conversationId: group.id,
          sequence,
          meta: META,
        });
      }
      const reads = h.events.published.filter((e) => e.name === MessagingEvents.messageRead);
      expect(reads.map((e) => e.payload)).toEqual([
        { conversationId: group.id, userId: student.userId, lastReadSequence: 2 },
      ]);
    });

    it('refuses a non-member and an invalid sequence', async () => {
      const teacher = h.person(Roles.teacher);
      const group = await h.group(teacher, []);
      const outsider = h.person(Roles.student);
      expect(
        expectErr(
          await h.markRead.execute({
            principal: outsider,
            conversationId: group.id,
            sequence: 1,
            meta: META,
          }),
        ).code,
      ).toBe('messaging.conversation_not_found');
      expect(
        expectErr(
          await h.markRead.execute({
            principal: teacher,
            conversationId: group.id,
            sequence: -1,
            meta: META,
          }),
        ).code,
      ).toBe('messaging.sequence_invalid');
    });
  });

  describe('participants', () => {
    it('lists a group’s members to its members, with names', async () => {
      const teacher = h.person(Roles.teacher, 'الأستاذ');
      const student = h.person(Roles.student, 'الطالب');
      const group = await h.group(teacher, [student]);
      const page = expectOk(
        await h.listParticipants.execute({ principal: student, conversationId: group.id }),
      );
      expect(page.items.map((p) => [p.displayName, p.role]).sort()).toEqual([
        ['الأستاذ', 'OWNER'],
        ['الطالب', 'MEMBER'],
      ]);
    });

    // Q22, provisional: a notice board does not publish its readers.
    it("hides a channel's subscribers from one another", async () => {
      const admin = h.person(Roles.admin);
      const student = h.person(Roles.student);
      const channel = expectOk(
        await h.createChannel.execute({
          principal: admin,
          title: 'News',
          memberIds: [student.userId],
          publisherIds: [],
          meta: META,
        }),
      );
      expect(
        expectErr(
          await h.listParticipants.execute({ principal: student, conversationId: channel.id }),
        ).code,
      ).toBe('messaging.members_hidden');
      expect(
        expectOk(await h.listParticipants.execute({ principal: admin, conversationId: channel.id }))
          .items,
      ).toHaveLength(2);
    });

    it('pages members by a stable key', async () => {
      const teacher = h.person(Roles.teacher);
      const students = Array.from({ length: 7 }, () => h.person(Roles.student));
      const group = await h.group(teacher, students);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = expectOk(
          await h.listParticipants.execute({
            principal: teacher,
            conversationId: group.id,
            cursor,
            limit: 3,
          }),
        );
        seen.push(...page.items.map((p) => p.userId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual([teacher, ...students].map((p) => p.userId).sort());
    });
  });
});
