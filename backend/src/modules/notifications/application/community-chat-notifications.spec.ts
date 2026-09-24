import type { Principal } from '../../../shared';
import { expectOk } from '../../../../test/support/identity-harness';
import { META } from '../../../../test/support/messaging-harness';
import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import { Permissions, type Permission } from '../../identity/contracts/permissions';
import { Roles } from '../../identity/domain/role';

/**
 * Notifications for a community chat come from the existing translator,
 * unchanged (community-chat.md §12.4): it walks MESSAGE_RECIPIENTS, which for
 * a community chat Communities narrows — so a notification never becomes a
 * way around Communities' answer.
 */
describe('notifications for a community chat', () => {
  let h: NotificationsHarness;
  let owner: Principal;
  let member: Principal;
  let removed: Principal;
  let narrowed: Principal;
  let communityId: string;
  let chatId: string;

  beforeEach(async () => {
    h = await notificationsHarness();
    owner = h.messaging.person(Roles.admin, 'المشرفة');
    member = h.messaging.person(Roles.student, 'الطالبة');
    removed = h.messaging.person(Roles.student, 'المُزالة');
    narrowed = h.messaging.person(Roles.student, 'المقيَّدة');
    communityId = await h.messaging.community(owner, [member, removed, narrowed]);
    await h.messaging.deliverCommunityEvents();
    chatId = (await h.messaging.openCommunityChat(owner, communityId)).id;
  });
  afterEach(() => h.cleanup());

  it('reaches readers only: not a member Communities removed, nor one whose role lost communities.read', async () => {
    // While members and readers, all three are told.
    await h.messaging.text(owner, chatId, 'قبل');
    await h.settle();
    for (const person of [member, removed, narrowed]) {
      expect((await h.inbox(person)).map((item) => item.type)).toEqual(['MESSAGE_RECEIVED']);
    }

    expectOk(
      await h.messaging.communities.remove.execute({
        principal: owner,
        communityId,
        userId: removed.userId,
        meta: META,
      }),
    );
    // Not delivered: the projection still lists `removed` as current.
    const lost = [...narrowed.permissions].filter(
      (permission) => permission !== Permissions.communities.read,
    ) as Permission[];
    h.messaging.directory.setPermissions(narrowed.userId, lost);

    await h.messaging.text(owner, chatId, 'موعد الحلقة');
    await h.settle();

    expect(await h.inbox(member)).toHaveLength(2);
    expect(await h.inbox(removed)).toHaveLength(1);
    expect(await h.inbox(narrowed)).toHaveLength(1);
    expect(await h.inbox(owner)).toEqual([]);
  });

  it('creates no ADDED_TO_CONVERSATION or CONVERSATION_CREATED notification for anyone', async () => {
    const newcomer = h.messaging.person(Roles.student);
    await h.messaging.communities.addPeople(owner, communityId, newcomer.userId);
    await h.messaging.deliverCommunityEvents();
    await h.settle();
    for (const person of [owner, member, newcomer]) {
      expect(await h.inbox(person)).toEqual([]);
    }
  });
});
