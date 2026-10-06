import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import { domainEvent, type DomainEvent, type Principal } from '../../../shared';
import { CommunityEvents } from '../../communities/contracts';
import { CommunityNotificationTranslator } from './community-notification.translator';

describe('community notifications', () => {
  let h: NotificationsHarness;
  let translator: CommunityNotificationTranslator;
  let owner: Principal;
  let ali: Principal;

  const C = 'community-1';

  beforeEach(async () => {
    h = await notificationsHarness();
    owner = h.messaging.person('TEACHER', 'الأستاذ أحمد');
    ali = h.messaging.person('STUDENT', 'علي');
    translator = new CommunityNotificationTranslator(h.bus, h.dispatcher);
    translator.onModuleInit();
  });

  afterEach(async () => {
    translator.onModuleDestroy();
    await h.cleanup();
  });

  const publish = async (event: DomainEvent): Promise<void> => {
    await h.bus.publish([event]);
    await translator.idle();
  };

  const memberAdded = (over: Record<string, unknown> = {}): DomainEvent =>
    domainEvent(
      CommunityEvents.memberAdded,
      C,
      {
        communityId: C,
        userId: ali.userId,
        membershipId: 'm-1',
        source: 'ADDED',
        addedBy: owner.userId,
        invitationId: null,
        membershipVersion: 1,
        ...over,
      },
      h.clock.now(),
    );

  it('member.added → one notification to the member, pointing at the community by id', async () => {
    await publish(memberAdded());
    expect(await h.inbox(ali)).toEqual([
      expect.objectContaining({
        type: 'COMMUNITY_MEMBER_ADDED',
        category: 'COMMUNITY',
        titleKey: 'notification.community_member_added.title',
        bodyKey: 'notification.community_member_added.body',
        params: {},
        target: { kind: 'community', communityId: C },
      }),
    ]);
    expect(await h.inbox(owner)).toEqual([]);
  });

  it('member.removed REMOVED → notifies the removed member', async () => {
    await publish(
      domainEvent(
        CommunityEvents.memberRemoved,
        C,
        {
          communityId: C,
          userId: ali.userId,
          membershipId: 'm-1',
          reason: 'REMOVED',
          removedBy: owner.userId,
          membershipVersion: 2,
        },
        h.clock.now(),
      ),
    );
    expect((await h.inbox(ali)).map((n) => n.type)).toEqual(['COMMUNITY_MEMBER_REMOVED']);
  });

  it('member.removed LEFT → no notification (the person’s own act)', async () => {
    await publish(
      domainEvent(
        CommunityEvents.memberRemoved,
        C,
        {
          communityId: C,
          userId: ali.userId,
          membershipId: 'm-1',
          reason: 'LEFT',
          removedBy: null,
          membershipVersion: 2,
        },
        h.clock.now(),
      ),
    );
    expect(await h.inbox(ali)).toEqual([]);
    expect(h.published.published).toEqual([]);
  });

  it('capability.granted → notifies the grantee, naming the capability', async () => {
    await publish(
      domainEvent(
        CommunityEvents.capabilityGranted,
        C,
        {
          communityId: C,
          grantId: 'g-1',
          membershipId: 'm-1',
          userId: ali.userId,
          capability: 'community.members.view',
          grantedBy: owner.userId,
        },
        h.clock.now(),
      ),
    );
    expect(await h.inbox(ali)).toEqual([
      expect.objectContaining({
        type: 'COMMUNITY_CAPABILITY_GRANTED',
        category: 'COMMUNITY',
        params: { capability: 'community.members.view' },
        target: { kind: 'community', communityId: C },
      }),
    ]);
  });

  it('capability.revoked → notifies the affected member', async () => {
    await publish(
      domainEvent(
        CommunityEvents.capabilityRevoked,
        C,
        {
          communityId: C,
          grantId: 'g-1',
          membershipId: 'm-1',
          userId: ali.userId,
          capability: 'community.members.view',
          revokedBy: owner.userId,
        },
        h.clock.now(),
      ),
    );
    expect((await h.inbox(ali)).map((n) => n.type)).toEqual(['COMMUNITY_CAPABILITY_REVOKED']);
  });

  it('ownership.transferred → notifies the new owner', async () => {
    await publish(
      domainEvent(
        CommunityEvents.ownershipTransferred,
        C,
        {
          communityId: C,
          fromUserId: owner.userId,
          toUserId: ali.userId,
          transferredBy: owner.userId,
          basis: 'owner',
          endedGrantIds: [],
        },
        h.clock.now(),
      ),
    );
    expect((await h.inbox(ali)).map((n) => n.type)).toEqual(['COMMUNITY_OWNERSHIP_TRANSFERRED']);
    expect(await h.inbox(owner)).toEqual([]);
  });

  it('does not announce a direct self-add (addedBy === userId)', async () => {
    await publish(memberAdded({ addedBy: ali.userId }));
    expect(await h.inbox(ali)).toEqual([]);
  });

  it('announces a link self-join (addedBy null) to the joiner', async () => {
    await publish(memberAdded({ source: 'INVITATION', addedBy: null, invitationId: 'inv-1' }));
    expect((await h.inbox(ali)).map((n) => n.type)).toEqual(['COMMUNITY_MEMBER_ADDED']);
  });

  it('is created once however often the same fact is delivered', async () => {
    const fact = memberAdded();
    await Promise.all([translator.translate(fact), translator.translate(fact)]);
    await translator.translate(fact);
    expect((await h.inbox(ali)).filter((n) => n.type === 'COMMUNITY_MEMBER_ADDED')).toHaveLength(1);
  });

  it('does not collapse distinct grants (different grant ids)', async () => {
    await publish(
      domainEvent(
        CommunityEvents.capabilityGranted,
        C,
        {
          communityId: C,
          grantId: 'g-1',
          membershipId: 'm-1',
          userId: ali.userId,
          capability: 'community.members.view',
          grantedBy: owner.userId,
        },
        h.clock.now(),
      ),
    );
    await publish(
      domainEvent(
        CommunityEvents.capabilityGranted,
        C,
        {
          communityId: C,
          grantId: 'g-2',
          membershipId: 'm-1',
          userId: ali.userId,
          capability: 'community.chat.post',
          grantedBy: owner.userId,
        },
        h.clock.now(),
      ),
    );
    expect(
      (await h.inbox(ali)).filter((n) => n.type === 'COMMUNITY_CAPABILITY_GRANTED'),
    ).toHaveLength(2);
  });

  it('ignores a malformed fact instead of guessing', async () => {
    await translator.translate(
      domainEvent(CommunityEvents.memberAdded, C, { communityId: C, userId: 42 }, h.clock.now()),
    );
    await translator.translate(domainEvent(CommunityEvents.memberAdded, C, null, h.clock.now()));
    expect(await h.inbox(ali)).toEqual([]);
    expect(h.published.published).toEqual([]);
  });

  it('leaves the dispatcher to skip an account that may not sign in', async () => {
    h.messaging.directory.deactivate(ali.userId);
    await publish(memberAdded());
    expect(await h.inbox(ali)).toEqual([]);
  });

  it('leaves the existing messaging notifications working', async () => {
    const group = await h.messaging.group(owner, [ali]);
    await h.settle();
    await h.messaging.text(owner, group.id, 'السلام عليكم');
    await h.settle();
    expect((await h.inbox(ali)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toHaveLength(1);
  });
});
