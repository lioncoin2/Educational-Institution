import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { Roles } from '../../identity/domain/role';
import { MessagingEvents } from '../contracts/events';
import { MessagingAudit } from './messaging-settings';

describe('conversation membership', () => {
  let h: MessagingHarness;
  beforeEach(async () => {
    h = await messagingHarness();
  });
  afterEach(() => h.cleanup());

  const add = (
    principal: ReturnType<MessagingHarness['person']>,
    conversationId: string,
    userIds: string[],
    role?: 'MEMBER' | 'PUBLISHER',
  ) => h.addParticipants.execute({ principal, conversationId, userIds, role, meta: META });
  const remove = (
    principal: ReturnType<MessagingHarness['person']>,
    conversationId: string,
    userId: string,
  ) => h.removeParticipant.execute({ principal, conversationId, userId, meta: META });

  describe('adding', () => {
    it('lets the owner add people, recording each addition', async () => {
      const teacher = h.person(Roles.teacher);
      const group = await h.group(teacher, []);
      const a = h.person(Roles.student);
      const b = h.person(Roles.student);

      expect(expectOk(await add(teacher, group.id, [a.userId, b.userId, a.userId]))).toEqual({
        added: [a.userId, b.userId],
        unchanged: [],
      });
      // Adding someone already in is a no-op, not an error.
      expect(expectOk(await add(teacher, group.id, [a.userId]))).toEqual({
        added: [],
        unchanged: [a.userId],
      });

      expect(
        h.audit.entries
          .filter((entry) => entry.action === MessagingAudit.participantAdded)
          .map((entry) => entry.metadata),
      ).toEqual([
        { userId: a.userId, role: 'MEMBER' },
        { userId: b.userId, role: 'MEMBER' },
      ]);
      expect(
        h.events.published.filter((e) => e.name === MessagingEvents.participantAdded),
      ).toHaveLength(2);
      const view = expectOk(
        await h.getConversation.execute({ principal: teacher, conversationId: group.id }),
      );
      expect(view.memberCount).toBe(3);
    });

    it('refuses a member who is not the owner', async () => {
      const teacher = h.person(Roles.teacher);
      const member = h.person(Roles.teacher);
      const group = await h.group(teacher, [member]);
      const result = await add(member, group.id, [h.person(Roles.student).userId]);
      expect(expectErr(result).code).toBe('messaging.not_conversation_owner');
    });

    it('never changes who is in a direct conversation', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(teacher, student);
      const result = await add(teacher, dm.id, [h.person(Roles.student).userId]);
      expect(expectErr(result).code).toBe('messaging.direct_membership_fixed');
    });

    it('lets channels add publishers, and groups only members', async () => {
      const admin = h.person(Roles.admin);
      const teacher = h.person(Roles.teacher);
      const channel = expectOk(
        await h.createChannel.execute({
          principal: admin,
          title: 'News',
          memberIds: [],
          publisherIds: [],
          meta: META,
        }),
      );
      expectOk(await add(admin, channel.id, [teacher.userId], 'PUBLISHER'));
      await h.text(teacher, channel.id, 'posting as a publisher');

      const group = await h.group(teacher, []);
      expect(
        expectErr(await add(teacher, group.id, [h.person(Roles.student).userId], 'PUBLISHER')).code,
      ).toBe('messaging.role_not_assignable');
    });

    it('refuses ineligible people', async () => {
      const teacher = h.person(Roles.teacher);
      const group = await h.group(teacher, []);
      const inactive = h.person(Roles.student);
      h.directory.deactivate(inactive.userId);
      expect(expectErr(await add(teacher, group.id, [inactive.userId])).code).toBe(
        'messaging.participant_not_eligible',
      );
    });

    it('refuses the owner once they no longer hold the right to run groups', async () => {
      const teacher = h.person(Roles.teacher);
      const group = await h.group(teacher, []);
      const demoted = { ...teacher, permissions: new Set(['messaging.read', 'messaging.send']) };
      expect(expectErr(await add(demoted, group.id, [h.person(Roles.student).userId])).code).toBe(
        'identity.permission_denied',
      );
    });
  });

  describe('removing and leaving', () => {
    it('lets the owner remove a member, who then loses all access', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      await h.text(teacher, group.id, 'before removal');

      expectOk(await remove(teacher, group.id, student.userId));
      expect(h.audit.last(MessagingAudit.participantRemoved)).toMatchObject({
        actorUserId: teacher.userId,
        metadata: { userId: student.userId },
      });
      expect(
        expectErr(await h.listMessages.execute({ principal: student, conversationId: group.id }))
          .code,
      ).toBe('messaging.conversation_not_found');
      expect(expectOk(await h.listConversations.execute({ principal: student })).items).toEqual([]);
    });

    it('protects the owner, and sends a would-be self-removal to "leave"', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      expect(expectErr(await remove(teacher, group.id, teacher.userId)).code).toBe(
        'messaging.use_leave',
      );
      expect(
        expectErr(
          await h.leave.execute({ principal: teacher, conversationId: group.id, meta: META }),
        ).code,
      ).toBe('messaging.owner_cannot_leave');
    });

    it('lets a member leave a group, and rejoining starts a new window', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      await h.text(teacher, group.id, 'one');

      expectOk(await h.leave.execute({ principal: student, conversationId: group.id, meta: META }));
      expect(h.audit.actions()).toContain(MessagingAudit.participantLeft);
      await h.text(teacher, group.id, 'said while they were away');

      expectOk(await add(teacher, group.id, [student.userId]));
      await h.text(teacher, group.id, 'welcome back');
      const page = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: group.id }),
      );
      expect(page.items.map((m) => m.body)).toEqual(['welcome back']);
    });

    it('never lets anyone leave or empty a direct conversation', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(teacher, student);
      expect(
        expectErr(await h.leave.execute({ principal: student, conversationId: dm.id, meta: META }))
          .code,
      ).toBe('messaging.direct_membership_fixed');
      expect(expectErr(await remove(teacher, dm.id, student.userId)).code).toBe(
        'messaging.direct_membership_fixed',
      );
    });

    it('lets a moderator remove without being a member — audited as moderation', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const owner = h.person(Roles.owner); // holds messaging.manage

      expectOk(await remove(owner, group.id, student.userId));
      expect(h.audit.last(MessagingAudit.moderationParticipantRemoved)).toMatchObject({
        actorUserId: owner.userId,
        metadata: { userId: student.userId, role: 'MEMBER' },
      });
      const removed = h.events.published.find((e) => e.name === MessagingEvents.participantRemoved);
      expect(removed?.payload).toMatchObject({ reason: 'moderated', removedBy: owner.userId });
      // Moderation removes; it cannot remove the owner…
      expect(expectErr(await remove(owner, group.id, teacher.userId)).code).toBe(
        'messaging.owner_not_removable',
      );
    });

    it('refuses a plain member, and reports a stranger as not found', async () => {
      const teacher = h.person(Roles.teacher);
      const a = h.person(Roles.student);
      const b = h.person(Roles.student);
      const group = await h.group(teacher, [a, b]);
      expect(expectErr(await remove(a, group.id, b.userId)).code).toBe(
        'messaging.not_conversation_owner',
      );
      const stranger = h.person(Roles.teacher);
      expect(expectErr(await remove(stranger, group.id, b.userId)).code).toBe(
        'messaging.conversation_not_found',
      );
    });
  });
});
