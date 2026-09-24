import { Logger } from '@nestjs/common';

import { err, failure, ok, type Principal } from '../../../shared';
import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import type { CommunityHead } from '../../communities/contracts/membership';
import { Permissions } from '../../identity/contracts/permissions';
import { Roles } from '../../identity/domain/role';
import type { ConversationId } from '../domain/conversation';
import { COMMUNITY_CHATS_OPENED_PER_USER } from './community-chat-settings';
import { MAX_PAGES_PER_PASS } from './community-chat-sync';
import { CONVERSATION_RESOURCE } from './messaging-settings';

const NOT_FOUND = 'messaging.conversation_not_found';

/**
 * Community chats over the real authorization and contracts of both modules
 * (community-chat.md §17, application level): who may read, who may post,
 * how membership changes reach the chat, and what happens when Communities
 * cannot answer. Communities' wake-ups reach messaging only when a test
 * delivers them, so each test says whether the projection has caught up.
 */
describe('community chats', () => {
  let h: MessagingHarness;
  let admin: Principal; // creates the community, so owns it
  let teacher: Principal; // may be delegated `community.chat.post`
  let student: Principal; // a plain member: reads, never posts
  let outsider: Principal; // a member of nothing
  let communityId: string;
  let keys = 0;

  const send = (principal: Principal, conversationId: string, body = 'السلام عليكم') =>
    h.sendText.execute({
      principal,
      conversationId,
      clientMessageId: `client-key-${(keys += 1).toString().padStart(6, '0')}`,
      body,
      meta: META,
    });

  /** Every current member the projection holds, walked a page at a time. */
  async function projected(conversationId: string): Promise<string[]> {
    const ids: string[] = [];
    let afterUserId: string | undefined;
    for (;;) {
      const page = await h.readModel.listMemberIds(conversationId as ConversationId, {
        limit: 2,
        afterUserId,
      });
      ids.push(...page.userIds);
      if (page.next === null) return ids;
      afterUserId = page.next;
    }
  }

  /** Every ACTIVE member Communities holds. */
  async function authority(community: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { userIds: readonly string[]; nextCursor: string | null } =
        await h.communities.membership.members(community, { cursor, limit: 2 });
      ids.push(...page.userIds);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return ids;
  }

  /** The rebuild warns by design (§7.6); the tests that expect one keep the output clean. */
  const warnQuietly = () =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  async function head(community: string): Promise<CommunityHead> {
    const [found] = await h.communities.membership.heads([community]);
    if (found === undefined) throw new Error('no such community');
    return found;
  }

  beforeEach(async () => {
    h = await messagingHarness();
    admin = h.person(Roles.admin, 'المشرفة');
    teacher = h.person(Roles.teacher, 'المعلمة');
    student = h.person(Roles.student, 'الطالبة');
    outsider = h.person(Roles.student, 'غريبة');
    communityId = await h.community(admin, [teacher, student]);
    await h.deliverCommunityEvents();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await h.cleanup();
  });

  describe('opening one from its community', () => {
    it('gives a member the ordinary view: CHANNEL, the community’s id and title, no management', async () => {
      const chat = await h.openCommunityChat(student, communityId);
      expect(chat).toMatchObject({
        type: 'CHANNEL',
        communityId,
        title: 'حلقة التجويد',
        memberCount: 3,
        myRole: 'MEMBER',
        canPost: false,
        canManageMembers: false,
        counterpartUserId: null,
      });
      // The stored title stays NULL: the name is Communities', read when viewed.
      const stored = await h.repository.findConversation(chat.id as ConversationId);
      expect(stored).toMatchObject({ title: null, communityId, type: 'CHANNEL' });
    });

    it('is one conversation per community, however many open it at once', async () => {
      const opened = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          h.openCommunityChat([admin, teacher, student][i % 3], communityId),
        ),
      );
      expect(new Set(opened.map((chat) => chat.id)).size).toBe(1);
      expect(await h.readModel.communityChatsFor([communityId])).toHaveLength(1);
    });

    it('answers an unknown community, a non-member and an unreadable one alike — and creates nothing', async () => {
      const other = await h.community(admin);
      const asNonMember = expectErr(
        await h.communityChat.execute({ principal: outsider, communityId: other }),
      );
      const unknown = expectErr(
        await h.communityChat.execute({ principal: outsider, communityId: 'no-such-community' }),
      );
      jest
        .spyOn(h.communities.authorization, 'authorize')
        .mockResolvedValueOnce(
          err(failure('precondition_failed', 'communities.community_locked', 'Not now.')),
        );
      const unreadable = expectErr(
        await h.communityChat.execute({ principal: student, communityId }),
      );
      expect(asNonMember).toEqual(unknown);
      expect(unreadable).toEqual(unknown);
      expect(unknown).toMatchObject({ kind: 'not_found', code: NOT_FOUND });
      expect(await h.readModel.communityChat('no-such-community')).toBeNull();
    });

    it('serves someone who joined a moment ago, before the projection has heard of it', async () => {
      const newcomer = h.person(Roles.student, 'جديدة');
      await h.communities.addPeople(admin, communityId, newcomer.userId);
      // No wake-up delivered: the projection does not know them yet.
      const chat = await h.openCommunityChat(newcomer, communityId);
      const row = await h.repository.findParticipant(chat.id as ConversationId, newcomer.userId);
      const [state] = await h.communities.membership.statesOf(communityId, [newcomer.userId]);
      expect(row).toMatchObject({
        leftAt: null,
        role: 'MEMBER',
        addedBy: null,
        sourceVersion: state?.version,
        sourceMembershipId: state?.membershipId,
      });
    });

    it('asks identity again with the conversation named, as every conversation-scoped read does', async () => {
      const chat = await h.openCommunityChat(student, communityId);
      const authorize = jest.spyOn(h.authorization, 'authorize');
      expectOk(await h.communityChat.execute({ principal: student, communityId }));
      expect(authorize).toHaveBeenCalledWith(student, Permissions.messaging.read, {
        resourceType: CONVERSATION_RESOURCE,
        resourceId: chat.id,
      });
      // Identity's answer about that conversation stands, whatever Communities says.
      authorize.mockImplementation((_principal, _permission, context) =>
        context?.resourceId === chat.id
          ? err(failure('forbidden', 'identity.forbidden', 'Not this conversation.'))
          : ok(undefined),
      );
      expect(
        expectErr(await h.communityChat.execute({ principal: student, communityId })),
      ).toMatchObject({ kind: 'forbidden', code: 'identity.forbidden' });
    });

    it('limits how often one person may look a community’s chat up', async () => {
      for (let i = 0; i < COMMUNITY_CHATS_OPENED_PER_USER.limit; i++) {
        await h.openCommunityChat(student, communityId);
      }
      expect(
        expectErr(await h.communityChat.execute({ principal: student, communityId })),
      ).toMatchObject({
        kind: 'rate_limited',
        code: 'messaging.too_many_community_chat_lookups',
      });
    });
  });

  describe('reading — Communities is asked on every request', () => {
    let chatId: string;

    beforeEach(async () => {
      chatId = (await h.openCommunityChat(admin, communityId)).id;
      expectOk(await send(admin, chatId, 'أهلاً'));
    });

    it('lets a member through every conversation route', async () => {
      const statesOf = jest.spyOn(h.communities.membership, 'statesOf');
      expectOk(await h.getConversation.execute({ principal: student, conversationId: chatId }));
      const page = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: chatId }),
      );
      expect(page.items.map((message) => message.body)).toEqual(['أهلاً']);
      expectOk(
        await h.markRead.execute({
          principal: student,
          conversationId: chatId,
          sequence: 1,
          meta: META,
        }),
      );
      expectOk(await h.delivery.position(student, chatId));
      // A row that agrees with the permit: nothing but the permit is asked.
      expect(statesOf).not.toHaveBeenCalled();
    });

    it('refuses a non-member on every route with the 404 of a missing conversation', async () => {
      await h.sync.idle();
      const passes = h.sync.passes;
      const statesOf = jest.spyOn(h.communities.membership, 'statesOf');
      const refusals = [
        await h.getConversation.execute({ principal: outsider, conversationId: chatId }),
        await h.listMessages.execute({ principal: outsider, conversationId: chatId }),
        await h.markRead.execute({
          principal: outsider,
          conversationId: chatId,
          sequence: 1,
          meta: META,
        }),
        await h.listParticipants.execute({ principal: outsider, conversationId: chatId }),
        await send(outsider, chatId),
        await h.delivery.position(outsider, chatId),
      ];
      for (const refusal of refusals) expect(expectErr(refusal).code).toBe(NOT_FOUND);
      const missing = expectErr(
        await h.getConversation.execute({ principal: outsider, conversationId: 'no-such-chat' }),
      );
      expect(expectErr(refusals[0])).toEqual(missing);
      // No row to check: probing costs Communities and the sync nothing more.
      await h.sync.idle();
      expect(statesOf).not.toHaveBeenCalled();
      expect(h.sync.passes).toBe(passes);
    });

    it('creates nothing for a non-member, however often they try', async () => {
      for (let i = 0; i < 100; i++) {
        await h.getConversation.execute({ principal: outsider, conversationId: chatId });
        await h.listMessages.execute({ principal: outsider, conversationId: chatId });
      }
      for (let i = 0; i < 50; i++) {
        await h.communityChat.execute({ principal: outsider, communityId });
      }
      await h.sync.idle();
      expect(
        await h.repository.findParticipant(chatId as ConversationId, outsider.userId),
      ).toBeNull();
      expect(await projected(chatId)).not.toContain(outsider.userId);
    });

    it('refuses a removed member at once — before the projection hears of it — and syncs', async () => {
      expectOk(
        await h.communities.remove.execute({
          principal: admin,
          communityId,
          userId: student.userId,
          meta: META,
        }),
      );
      // The wake-up is not delivered: the projection still says "member".
      expect(
        (await h.repository.findParticipant(chatId as ConversationId, student.userId))?.leftAt,
      ).toBeNull();
      expect(
        expectErr(await h.getConversation.execute({ principal: student, conversationId: chatId }))
          .code,
      ).toBe(NOT_FOUND);
      expect(expectErr(await send(student, chatId)).code).toBe(NOT_FOUND);
      // The refusal scheduled a sync, which applied the removal — Communities
      // knows that change, so nothing is rebuilt.
      await h.sync.idle();
      expect(
        (await h.repository.findParticipant(chatId as ConversationId, student.userId))?.leftAt,
      ).not.toBeNull();
      expect(await projected(chatId)).toEqual((await authority(communityId)).sort());
      expect(h.reconciler.reconciliations).toBe(0);
    });

    it('refuses a member who left, and lets them back by link with a new window and watermark', async () => {
      expectOk(await h.communities.leave.execute({ principal: student, communityId, meta: META }));
      await h.deliverCommunityEvents();
      expect(
        expectErr(await h.listMessages.execute({ principal: student, conversationId: chatId }))
          .code,
      ).toBe(NOT_FOUND);
      const before = await h.repository.findParticipant(chatId as ConversationId, student.userId);

      expectOk(await send(admin, chatId, 'بعد مغادرتها'));
      const { token } = await h.communities.link(admin, communityId);
      expectOk(await h.communities.redeem.execute({ principal: student, token, meta: META }));
      await h.deliverCommunityEvents();

      const after = await h.repository.findParticipant(chatId as ConversationId, student.userId);
      expect(after?.leftAt).toBeNull();
      expect(after?.sourceMembershipId).not.toBe(before?.sourceMembershipId);
      // A new watermark at the last message; under FULL (Q52) the whole history is visible.
      expect(after).toMatchObject({ lastReadSequence: 2, hiddenThroughSequence: 0 });
      const page = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: chatId }),
      );
      expect(page.items.map((message) => message.body)).toEqual(['أهلاً', 'بعد مغادرتها']);
    });

    it('keeps a removed member out of the link path; re-added by the owner, they read again', async () => {
      expectOk(
        await h.communities.remove.execute({
          principal: admin,
          communityId,
          userId: student.userId,
          meta: META,
        }),
      );
      const { token } = await h.communities.link(admin, communityId);
      expect(
        (await h.communities.redeem.execute({ principal: student, token, meta: META })).ok,
      ).toBe(false);
      expect(
        expectErr(await h.getConversation.execute({ principal: student, conversationId: chatId }))
          .code,
      ).toBe(NOT_FOUND);
      await h.communities.addPeople(admin, communityId, student.userId);
      expectOk(await h.getConversation.execute({ principal: student, conversationId: chatId }));
    });

    it('keeps the projection equal to the authority once the wake-ups arrive — duplicated or reordered', async () => {
      const more = [h.person(Roles.student), h.person(Roles.student), h.person(Roles.teacher)];
      await h.communities.addPeople(admin, communityId, ...more.map((person) => person.userId));
      expectOk(
        await h.communities.remove.execute({
          principal: admin,
          communityId,
          userId: more[0].userId,
          meta: META,
        }),
      );
      const events = h.communities.journal.events.slice();
      await h.bus.publish([...events].reverse());
      await h.bus.publish(events);
      await h.deliverCommunityEvents();
      expect(await projected(chatId)).toEqual((await authority(communityId)).sort());
      const chat = await h.readModel.communityChat(communityId);
      expect(chat?.projectedVersion).toBe((await head(communityId)).membershipVersion);
      const stored = await h.repository.findConversation(chatId as ConversationId);
      expect(stored?.memberCount).toBe((await authority(communityId)).length);
    });
  });

  describe('posting — Communities’ rule, asked on every send', () => {
    let chatId: string;

    beforeEach(async () => {
      chatId = (await h.openCommunityChat(admin, communityId)).id;
    });

    it('lets the owner post, and shows them canPost', async () => {
      expectOk(await send(admin, chatId));
      expect(
        expectOk(await h.getConversation.execute({ principal: admin, conversationId: chatId }))
          .canPost,
      ).toBe(true);
    });

    it('refuses a member without the capability with 403 — the projected role is never asked', async () => {
      expect(expectErr(await send(student, chatId))).toMatchObject({
        kind: 'forbidden',
        code: 'messaging.posting_not_allowed',
      });
    });

    it('lets a delegated poster post, and stops them the moment the grant is revoked', async () => {
      const [grantId] = await h.communities.delegate(
        admin,
        communityId,
        teacher.userId,
        'community.chat.post',
      );
      expectOk(await send(teacher, chatId));
      expect(
        expectOk(await h.getConversation.execute({ principal: teacher, conversationId: chatId }))
          .canPost,
      ).toBe(true);

      expectOk(
        await h.communities.revokeGrant.execute({
          principal: admin,
          communityId,
          grantId: grantId ?? '',
          meta: META,
        }),
      );
      expect(expectErr(await send(teacher, chatId)).code).toBe('messaging.posting_not_allowed');
      // Reading goes on: the grant was about posting only.
      expectOk(await h.listMessages.execute({ principal: teacher, conversationId: chatId }));
    });

    it('stops all posting while LOCKED — reading goes on — and resumes on unlock (PROVISIONAL, Q46)', async () => {
      const [grantId] = await h.communities.delegate(
        admin,
        communityId,
        teacher.userId,
        'community.chat.post',
      );
      expect(grantId).not.toBe('');
      expectOk(
        await h.communities.status.execute({
          principal: admin,
          communityId,
          to: 'LOCKED',
          meta: META,
        }),
      );
      for (const poster of [admin, teacher]) {
        expect(expectErr(await send(poster, chatId)).code).toBe('messaging.posting_not_allowed');
      }
      expectOk(await h.listMessages.execute({ principal: student, conversationId: chatId }));
      expect(
        expectOk(await h.getConversation.execute({ principal: admin, conversationId: chatId }))
          .canPost,
      ).toBe(false);

      expectOk(
        await h.communities.status.execute({
          principal: admin,
          communityId,
          to: 'OPEN',
          meta: META,
        }),
      );
      expectOk(await send(admin, chatId));
      expectOk(await send(teacher, chatId));
    });

    it('follows ownership: the new owner posts, the former owner no longer does', async () => {
      const versionBefore = (await head(communityId)).membershipVersion;
      expectOk(
        await h.communities.transfer.execute({
          principal: admin,
          communityId,
          userId: teacher.userId,
          meta: META,
        }),
      );
      expectOk(await send(teacher, chatId));
      expect(expectErr(await send(admin, chatId)).code).toBe('messaging.posting_not_allowed');
      // Belonging did not change, so neither did the projection.
      expect((await head(communityId)).membershipVersion).toBe(versionBefore);
      expect(await projected(chatId)).toEqual((await authority(communityId)).sort());
    });

    it('raises message.sent typed CHANNEL — and no other event, and no audit entry', async () => {
      h.events.published.length = 0;
      const sent = expectOk(await send(admin, chatId));
      expect(h.events.published.map((event) => event.name)).toEqual(['messaging.message.sent']);
      expect(h.events.published[0]?.payload).toMatchObject({
        conversationId: chatId,
        conversationType: 'CHANNEL',
        messageId: sent.message.id,
      });
      expect(h.audit.entries).toEqual([]);
    });
  });

  describe('the capacity switch (§11.2)', () => {
    it('refuses posts above maxServedMembers with 412 and canPost false; reading goes on; at the switch, posts go through', async () => {
      await h.cleanup();
      h = await messagingHarness({ settings: { maxServedMembers: 3 } });
      admin = h.person(Roles.admin);
      teacher = h.person(Roles.teacher);
      student = h.person(Roles.student);
      const fourth = h.person(Roles.student);
      communityId = await h.community(admin, [teacher, student, fourth]);
      await h.deliverCommunityEvents();
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      h.events.published.length = 0;

      expect(expectErr(await send(admin, chatId))).toMatchObject({
        kind: 'precondition_failed',
        code: 'messaging.community_chat_over_capacity',
      });
      expect(
        expectOk(await h.getConversation.execute({ principal: admin, conversationId: chatId }))
          .canPost,
      ).toBe(false);
      expectOk(await h.listMessages.execute({ principal: student, conversationId: chatId }));
      expectOk(
        await h.markRead.execute({
          principal: student,
          conversationId: chatId,
          sequence: 0,
          meta: META,
        }),
      );
      expect(h.events.published.filter((event) => event.name === 'messaging.message.sent')).toEqual(
        [],
      );

      expectOk(
        await h.communities.remove.execute({
          principal: admin,
          communityId,
          userId: fourth.userId,
          meta: META,
        }),
      );
      await h.deliverCommunityEvents();
      expectOk(await send(admin, chatId));
    });

    it('refuses a non-poster with 403 first: only a poster learns the chat is over the switch', async () => {
      await h.cleanup();
      h = await messagingHarness({ settings: { maxServedMembers: 1 } });
      admin = h.person(Roles.admin);
      student = h.person(Roles.student);
      communityId = await h.community(admin, [student]);
      await h.deliverCommunityEvents();
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      expect(expectErr(await send(student, chatId)).code).toBe('messaging.posting_not_allowed');
    });
  });

  describe('membership stays Communities’', () => {
    it('refuses to add, remove or leave with 412 — even for an OWNER-role account holding every permission', async () => {
      const owner = h.person(Roles.owner, 'المالكة');
      const community = await h.community(owner, [student]);
      await h.deliverCommunityEvents();
      const chatId = (await h.openCommunityChat(owner, community)).id;
      const MANAGED = 'messaging.membership_managed_by_community';

      expect(
        expectErr(
          await h.addParticipants.execute({
            principal: owner,
            conversationId: chatId,
            userIds: [outsider.userId],
            meta: META,
          }),
        ),
      ).toMatchObject({ kind: 'precondition_failed', code: MANAGED });
      // The owner route and the messaging.manage route alike.
      expect(
        expectErr(
          await h.removeParticipant.execute({
            principal: owner,
            conversationId: chatId,
            userId: student.userId,
            meta: META,
          }),
        ).code,
      ).toBe(MANAGED);
      expect(
        expectErr(await h.leave.execute({ principal: student, conversationId: chatId, meta: META }))
          .code,
      ).toBe(MANAGED);
      expect(
        expectErr(await h.leave.execute({ principal: owner, conversationId: chatId, meta: META }))
          .code,
      ).toBe(MANAGED);
      expect(await projected(chatId)).toContain(student.userId);
    });

    it('answers a moderator who is not a member with 404, not 412', async () => {
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      const moderator = h.person(Roles.owner, 'مشرفة المحادثات');
      expect(moderator.permissions.has(Permissions.messaging.manage)).toBe(true);
      expect(
        expectErr(
          await h.removeParticipant.execute({
            principal: moderator,
            conversationId: chatId,
            userId: student.userId,
            meta: META,
          }),
        ).code,
      ).toBe(NOT_FOUND);
    });

    it('never lists a community chat’s members, not even to its owner', async () => {
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      for (const principal of [admin, student]) {
        expect(
          expectErr(await h.listParticipants.execute({ principal, conversationId: chatId })),
        ).toMatchObject({ kind: 'forbidden', code: 'messaging.members_hidden' });
      }
    });

    it('materializes and applies silently: no messaging event, no audit entry', async () => {
      h.events.published.length = 0;
      await h.openCommunityChat(admin, communityId);
      await h.communities.addPeople(admin, communityId, h.person(Roles.student).userId);
      await h.deliverCommunityEvents();
      expect(h.events.published).toEqual([]);
      expect(h.audit.entries).toEqual([]);
    });
  });

  describe('the conversation list', () => {
    it('shows a member their community chat with its title and their posting right', async () => {
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      const [item] = expectOk(await h.listConversations.execute({ principal: student })).items;
      expect(item).toMatchObject({
        id: chatId,
        communityId,
        title: 'حلقة التجويد',
        canPost: false,
      });
      const [own] = expectOk(await h.listConversations.execute({ principal: admin })).items;
      expect(own).toMatchObject({ id: chatId, canPost: true });
    });

    it('drops a chat Communities no longer lets them read, and syncs it', async () => {
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      expectOk(
        await h.communities.remove.execute({
          principal: admin,
          communityId,
          userId: student.userId,
          meta: META,
        }),
      );
      expect(expectOk(await h.listConversations.execute({ principal: student })).items).toEqual([]);
      await h.sync.idle();
      expect(await projected(chatId)).not.toContain(student.userId);
    });

    it('asks Communities three times per page, whatever the number of chats — and never for a page without one', async () => {
      // Someone in no community: their page holds a direct conversation only.
      const loner = h.person(Roles.student);
      await h.direct(teacher, loner);
      const authorizeEach = jest.spyOn(h.communities.authorization, 'authorizeEach');
      const describe = jest.spyOn(h.communities.directory, 'describe');
      expect(expectOk(await h.listConversations.execute({ principal: loner })).items).toHaveLength(
        1,
      );
      expect(authorizeEach).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();

      for (let i = 0; i < 5; i++) {
        await h.openCommunityChat(loner, await h.community(admin, [loner]));
      }
      await h.deliverCommunityEvents();
      authorizeEach.mockClear();
      describe.mockClear();
      const page = expectOk(await h.listConversations.execute({ principal: loner }));
      expect(page.items.filter((item) => item.communityId !== null)).toHaveLength(5);
      expect(authorizeEach).toHaveBeenCalledTimes(2);
      expect(authorizeEach.mock.calls.map((call) => call[2]).sort()).toEqual([
        'community.chat.post',
        'community.chat.read',
      ]);
      expect(describe).toHaveBeenCalledTimes(1);
    });
  });

  describe('recipients for delivery (§7.3)', () => {
    let chatId: string;

    beforeEach(async () => {
      chatId = (await h.openCommunityChat(admin, communityId)).id;
    });

    const recipients = async (options: { readersOnly?: boolean } = {}) =>
      (await h.recipients.list(chatId, { limit: 1000, ...options })).userIds;

    it('are the projection, when it is current', async () => {
      expect([...(await recipients())].sort()).toEqual(
        [admin.userId, teacher.userId, student.userId].sort(),
      );
    });

    it('leave out a member Communities removed before the projection heard of it', async () => {
      expectOk(
        await h.communities.remove.execute({
          principal: admin,
          communityId,
          userId: student.userId,
          meta: META,
        }),
      );
      expect(await recipients()).not.toContain(student.userId);
      expect(await recipients({ readersOnly: true })).not.toContain(student.userId);
      await h.sync.idle();
      expect(await projected(chatId)).not.toContain(student.userId);
      // A removal the projection has not applied yet is lag, not loss.
      expect(h.reconciler.reconciliations).toBe(0);
    });

    it('leave out a member whose role lost part of the read ceiling — whatever readersOnly says — as HTTP does', async () => {
      const chat = await h.readModel.communityChat(communityId);
      expect(chat?.projectedVersion).toBe((await head(communityId)).membershipVersion);
      const lost = [...student.permissions].filter(
        (permission) => permission !== Permissions.communities.read,
      ) as (typeof Permissions.messaging.read)[];
      h.directory.setPermissions(student.userId, lost);

      expect(await recipients()).not.toContain(student.userId);
      expect(await recipients({ readersOnly: true })).not.toContain(student.userId);
      expect(await recipients()).toContain(teacher.userId);

      const narrowed: Principal = { ...student, permissions: new Set(lost) };
      expect(
        expectErr(await h.getConversation.execute({ principal: narrowed, conversationId: chatId }))
          .code,
      ).toBe(NOT_FOUND);
      // Refused while still a member: the row agrees with Communities, so
      // nothing is rebuilt.
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(0);
    });

    it('are nobody for an unknown community, or one whose chat is not readable now', async () => {
      const heads = jest.spyOn(h.communities.membership, 'heads');
      heads.mockResolvedValueOnce([]);
      expect(await recipients()).toEqual([]);
      const current = await head(communityId);
      heads.mockResolvedValueOnce([
        { ...current, effects: { ...current.effects, chatReadable: false } },
      ]);
      expect(await h.recipients.list(chatId, { limit: 1000 })).toEqual({
        userIds: [],
        nextCursor: null,
      });
    });

    it('are exactly today’s page for a conversation messaging owns — Communities is never asked', async () => {
      const group = await h.group(teacher, [student]);
      const heads = jest.spyOn(h.communities.membership, 'heads');
      const page = await h.recipients.list(group.id, { limit: 1000 });
      expect([...page.userIds].sort()).toEqual([teacher.userId, student.userId].sort());
      expect(heads).not.toHaveBeenCalled();
    });
  });

  describe('when Communities cannot answer', () => {
    let chatId: string;

    beforeEach(async () => {
      chatId = (await h.openCommunityChat(admin, communityId)).id;
    });

    it('fails every community-chat request closed with 503 — and leaves other conversations alone', async () => {
      const group = await h.group(teacher, [student]);
      jest
        .spyOn(h.communities.authorization, 'authorize')
        .mockRejectedValue(new Error('store down'));
      jest
        .spyOn(h.communities.authorization, 'authorizeEach')
        .mockRejectedValue(new Error('store down'));

      const refusals = [
        await h.communityChat.execute({ principal: student, communityId }),
        await h.getConversation.execute({ principal: student, conversationId: chatId }),
        await h.listMessages.execute({ principal: student, conversationId: chatId }),
        await send(admin, chatId),
        await h.delivery.position(student, chatId),
      ];
      for (const refusal of refusals) {
        expect(expectErr(refusal)).toMatchObject({ kind: 'unavailable', code: 'unavailable' });
      }
      expectOk(await h.getConversation.execute({ principal: student, conversationId: group.id }));
      expectOk(await send(teacher, group.id));
    });

    it('lists everything else, leaving the community chats out until Communities answers again', async () => {
      const group = await h.group(teacher, [student]);
      const authorizeEach = jest
        .spyOn(h.communities.authorization, 'authorizeEach')
        .mockRejectedValue(new Error('store down'));

      // A community chat's row alone is never an answer (§19): left out, not shown.
      const down = expectOk(await h.listConversations.execute({ principal: student }));
      expect(down.items.map((item) => item.id)).toEqual([group.id]);

      authorizeEach.mockRestore();
      const back = expectOk(await h.listConversations.execute({ principal: student }));
      expect(back.items.map((item) => item.id).sort()).toEqual([group.id, chatId].sort());
    });

    it('shows a chat it cannot describe untitled and closed to posting — a send still asks its own permit', async () => {
      jest.spyOn(h.communities.directory, 'describe').mockRejectedValue(new Error('store down'));
      const view = expectOk(
        await h.getConversation.execute({ principal: admin, conversationId: chatId }),
      );
      expect(view).toMatchObject({ communityId, title: null, canPost: false });
      // `canPost` is only ever a hint: the owner's permit still answers.
      expectOk(await send(admin, chatId));
    });

    it('lets the recipient walk throw for the relay to log, and the sweeper skip its tick', async () => {
      // The head answers and the page's check does not: no page goes out unchecked.
      const statesOf = jest
        .spyOn(h.communities.membership, 'statesOf')
        .mockRejectedValue(new Error('store down'));
      await expect(h.recipients.list(chatId, { limit: 1000 })).rejects.toThrow('store down');
      statesOf.mockRestore();
      jest.spyOn(h.communities.membership, 'heads').mockRejectedValue(new Error('store down'));
      jest.spyOn(h.communities.membership, 'listHeads').mockRejectedValue(new Error('store down'));
      await expect(h.recipients.list(chatId, { limit: 1000 })).rejects.toThrow('store down');
      await expect(h.sweeper.tick()).resolves.toBeNull();
    });
  });

  describe('keeping the projection current (§7.5)', () => {
    it('coalesces a storm of wake-ups: 100 during one pass cost at most two', async () => {
      await h.openCommunityChat(admin, communityId);
      const wakeUp = h.communities.journal.events.find(
        (event) => event.name === 'communities.member.added',
      );
      if (wakeUp === undefined) throw new Error('expected a member.added event');
      const before = h.sync.passes;
      await Promise.all(Array.from({ length: 100 }, () => h.bus.publish([wakeUp])));
      await h.sync.idle();
      expect(h.sync.passes - before).toBeLessThanOrEqual(2);
      expect(h.sync.passes - before).toBeGreaterThanOrEqual(1);
    });

    it('lets the sweeper materialize a chat whose every wake-up was lost, and converge it', async () => {
      const lost = await h.community(admin, [student, teacher]);
      // Nothing delivered: no chat exists for it yet.
      expect(await h.readModel.communityChat(lost)).toBeNull();
      const report = await h.sweeper.tick();
      expect(report?.behind).toBeGreaterThanOrEqual(1);
      await h.sync.idle();
      const chat = await h.readModel.communityChat(lost);
      expect(chat?.projectedVersion).toBe((await head(lost)).membershipVersion);
      expect(await projected(chat?.conversationId ?? '')).toEqual((await authority(lost)).sort());
    });

    it('lets the sweeper hand a projection that is ahead to the reconciler, which rebuilds it', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const chat = await h.openCommunityChat(admin, communityId);
      const { membershipVersion } = await head(communityId);
      // As after Communities was restored from a backup: the projection holds
      // a join the authority lost, and versions the authority will reuse.
      await h.repository.applyCommunityMembership({
        conversationId: chat.id as ConversationId,
        states: [
          {
            userId: 'ghost',
            membershipId: 'lost-stint',
            active: true,
            joinedAt: new Date(),
            version: membershipVersion + 5,
          },
        ],
        advance: { from: membershipVersion, to: membershipVersion + 5 },
        at: h.clock.now(),
      });

      const report = await h.sweeper.tick();
      expect(report).toMatchObject({ ahead: 1 });
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(1);
      expect((await h.readModel.communityChat(communityId))?.projectedVersion).toBe(
        membershipVersion,
      );
      expect(await projected(chat.id)).toEqual((await authority(communityId)).sort());
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ communityId, head: membershipVersion }),
        'community chat projection rebuilt from Communities',
      );
      expect(h.audit.entries).toEqual([]);

      // The versions the authority allocates next are applied again.
      const newcomer = h.person(Roles.student);
      await h.communities.addPeople(admin, communityId, newcomer.userId);
      await h.deliverCommunityEvents();
      expect(await projected(chat.id)).toEqual((await authority(communityId)).sort());
    });

    it('yields the worker after MAX_PAGES_PER_PASS pages: a community behind a long backlog is served next', async () => {
      const other = await h.community(admin, [teacher]);
      await h.deliverCommunityEvents();
      await h.openCommunityChat(admin, other);
      await h.openCommunityChat(admin, communityId);
      const start = (await h.readModel.communityChat(communityId))?.projectedVersion ?? 0;
      const current = await head(communityId);
      const end = start + 2 * MAX_PAGES_PER_PASS + 50;
      const real = h.communities.membership.changesSince.bind(h.communities.membership);
      const calls: string[] = [];
      // A backlog of 250 pages — one version each — in one community.
      jest
        .spyOn(h.communities.membership, 'changesSince')
        .mockImplementation(async (id, after, limit) => {
          calls.push(id);
          if (id !== communityId) return real(id, after, limit);
          return {
            states: [],
            head: { ...current, membershipVersion: end },
            throughVersion: Math.min(after + 1, end),
            hasMore: after + 1 < end,
          };
        });

      h.sync.schedule(communityId);
      h.sync.schedule(other); // arrives while the backlog's first pass runs
      await h.sync.idle();

      // The other community waited for one pass, not for the whole backlog…
      const waited = calls.slice(0, calls.indexOf(other));
      expect(waited).toHaveLength(MAX_PAGES_PER_PASS);
      expect(waited.every((id) => id === communityId)).toBe(true);
      // …and the backlog was still served in full, in passes of at most that.
      expect(calls.filter((id) => id === communityId)).toHaveLength(end - start);
      expect((await h.readModel.communityChat(communityId))?.projectedVersion).toBe(end);
    });
  });

  describe('after Communities was restored behind the projection (§7.6)', () => {
    let chatId: ConversationId;
    /** The head Communities was restored to: every version above it was lost. */
    let restored: number;
    let ghost: Principal; // joined only in the lost versions

    beforeEach(async () => {
      chatId = (await h.openCommunityChat(admin, communityId)).id as ConversationId;
      restored = (await head(communityId)).membershipVersion;
      ghost = h.person(Roles.student, 'شبح');
    });

    /**
     * What the projection applied from versions Communities then lost:
     * written as the sync (advancing the projected version to `through`) or
     * as a repair on access (`through` null, the projected version kept).
     */
    async function applyLost(
      states: readonly {
        readonly userId: string;
        readonly membershipId: string;
        readonly active: boolean;
        readonly version: number;
      }[],
      through: number | null,
    ): Promise<void> {
      await h.repository.applyCommunityMembership({
        conversationId: chatId,
        states: states.map((state) => ({ ...state, joinedAt: h.clock.now() })),
        advance: through === null ? null : { from: restored, to: through },
        at: h.clock.now(),
      });
    }

    /**
     * Communities hands the lost versions out again — `count` real joins —
     * and their wake-ups arrive before any sweep: the projected version
     * matches the head, so nothing looks behind or ahead.
     */
    async function reuseLostVersions(count: number): Promise<Principal[]> {
      const newcomers = Array.from({ length: count }, () => h.person(Roles.student));
      await h.communities.addPeople(admin, communityId, ...newcomers.map((p) => p.userId));
      await h.deliverCommunityEvents();
      const { membershipVersion } = await head(communityId);
      expect(membershipVersion).toBe(restored + count);
      expect((await h.readModel.communityChat(communityId))?.projectedVersion).toBe(
        membershipVersion,
      );
      expect(await h.sweeper.tick()).toMatchObject({ behind: 0, ahead: 0 });
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(0);
      return newcomers;
    }

    async function lostJoinAndRemoval(): Promise<void> {
      const [stint] = await h.communities.membership.statesOf(communityId, [student.userId]);
      if (stint === undefined) throw new Error('expected the student’s stint');
      // H+1: the ghost joined. H+2: the student was removed.
      await applyLost(
        [
          { userId: ghost.userId, membershipId: 'lost-stint', active: true, version: restored + 1 },
          {
            userId: student.userId,
            membershipId: stint.membershipId,
            active: false,
            version: restored + 2,
          },
        ],
        restored + 2,
      );
    }

    it('never delivers to someone Communities does not know — and rebuilds, though the head caught up', async () => {
      warnQuietly();
      await lostJoinAndRemoval();
      const newcomers = await reuseLostVersions(2);

      // The ghost is on the projection's page, and left out of it.
      const page = await h.recipients.list(chatId, { limit: 1000 });
      expect(page.userIds).not.toContain(ghost.userId);
      expect([...page.userIds].sort()).toEqual([admin.userId, teacher.userId].sort());

      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(1);
      expect(await projected(chatId)).toEqual((await authority(communityId)).sort());
      const rebuilt = await h.recipients.list(chatId, { limit: 1000 });
      expect([...rebuilt.userIds].sort()).toEqual(
        [admin, teacher, student, ...newcomers].map((person) => person.userId).sort(),
      );
      expect(h.audit.entries).toEqual([]);
    });

    it('lets a member shut out by a change Communities lost back in, once the rebuild they caused has run', async () => {
      warnQuietly();
      await lostJoinAndRemoval();
      await reuseLostVersions(2);

      // Communities vouches for the student, but the lost removal at H+2
      // outranks any repair: refused now, and a rebuild asked for.
      const apply = jest.spyOn(h.repository, 'applyCommunityMembership');
      expect(
        expectErr(await h.getConversation.execute({ principal: student, conversationId: chatId }))
          .code,
      ).toBe(NOT_FOUND);
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(1);
      // No repair was attempted — it could not have won, and it would have
      // taken the conversation lock for nothing. Only the rebuild wrote.
      const repairs = apply.mock.calls.filter(
        ([input]) => input.advance === null && input.override !== true,
      );
      expect(repairs).toEqual([]);
      expectOk(await h.getConversation.execute({ principal: student, conversationId: chatId }));
      expect(await projected(chatId)).toEqual((await authority(communityId)).sort());
    });

    it('keeps a rebuild asked for when it fails, and runs it on the next pass', async () => {
      warnQuietly();
      await lostJoinAndRemoval();
      await reuseLostVersions(2);
      const reconcile = jest
        .spyOn(h.reconciler, 'reconcile')
        .mockRejectedValueOnce(new Error('store down'));

      expect((await h.recipients.list(chatId, { limit: 1000 })).userIds).not.toContain(
        ghost.userId,
      );
      await h.sync.idle();
      expect(reconcile).toHaveBeenCalledTimes(1);

      // The next pass, whatever wakes it, rebuilds first.
      h.sync.schedule(communityId);
      await h.sync.idle();
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(await projected(chatId)).toEqual((await authority(communityId)).sort());
    });

    it('rebuilds a repaired row above the projected version once its version is handed out again', async () => {
      warnQuietly();
      // Repair on access wrote the ghost's join at H+1 before any sync: the
      // projected version stayed at H, so no sweep ever sees it ahead.
      await applyLost(
        [{ userId: ghost.userId, membershipId: 'lost-stint', active: true, version: restored + 1 }],
        null,
      );
      const [newcomer] = await reuseLostVersions(1);

      const page = await h.recipients.list(chatId, { limit: 1000 });
      expect(page.userIds).not.toContain(ghost.userId);
      expect(page.userIds).toContain(newcomer?.userId);
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(1);
      expect(await h.repository.findParticipant(chatId, ghost.userId)).toMatchObject({
        leftAt: expect.any(Date),
      });
      expect(await projected(chatId)).toEqual((await authority(communityId)).sort());
    });

    it('checks a row ahead of the stint Communities vouches for, and rebuilds when Communities never made that change', async () => {
      warnQuietly();
      // A rejoin Communities lost: the student's row claims a stint it never had.
      await applyLost(
        [
          {
            userId: student.userId,
            membershipId: 'lost-rejoin',
            active: true,
            version: restored + 1,
          },
        ],
        restored + 1,
      );
      await reuseLostVersions(1);

      // Admitted — the permit decides, and the student is a member.
      expectOk(await h.getConversation.execute({ principal: student, conversationId: chatId }));
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(1);
      const [stint] = await h.communities.membership.statesOf(communityId, [student.userId]);
      expect(await h.repository.findParticipant(chatId, student.userId)).toMatchObject({
        leftAt: null,
        sourceVersion: stint?.version,
        sourceMembershipId: stint?.membershipId,
      });
    });

    it('only syncs for a row ahead of the permit when the change is one Communities made since', async () => {
      const stale = await h.communities.authorization.authorize(
        student,
        communityId,
        'community.chat.read',
      );
      // The student leaves and rejoins by link; the projection applies both.
      expectOk(await h.communities.leave.execute({ principal: student, communityId, meta: META }));
      const { token } = await h.communities.link(admin, communityId);
      expectOk(await h.communities.redeem.execute({ principal: student, token, meta: META }));
      await h.deliverCommunityEvents();

      // A permit read just before those changes: the row is ahead of its stint.
      jest.spyOn(h.communities.authorization, 'authorize').mockResolvedValueOnce(stale);
      expectOk(await h.getConversation.execute({ principal: student, conversationId: chatId }));
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(0);
    });

    it('rebuilds at most once a pass when Communities keeps reporting a head below the projection — and says so', async () => {
      warnQuietly();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const real = h.communities.membership.changesSince.bind(h.communities.membership);
      jest
        .spyOn(h.communities.membership, 'changesSince')
        .mockImplementation(async (id, after, limit) => {
          const changes = await real(id, after, limit);
          // Whatever the projection holds, the head reported is one below it.
          return changes === null
            ? null
            : { ...changes, head: { ...changes.head, membershipVersion: after - 1 } };
        });

      h.sync.schedule(communityId);
      await h.sync.idle();
      expect(h.reconciler.reconciliations).toBe(1);
      expect(error).toHaveBeenCalledWith(
        { communityId },
        'community chat projection still ahead after a rebuild',
      );
    });
  });
});
