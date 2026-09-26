import type { Principal, Result } from '../../../shared';
import {
  META,
  communitiesHarness,
  type CommunitiesHarness,
} from '../../../../test/support/communities-harness';
import { COMMUNITY_OPERATIONS, type CommunityOperation } from '../contracts/capabilities';

/**
 * One community, set up the same way for every case: an ADMIN creates it
 * (owner), a STUDENT, two TEACHERs and a second ADMIN are members, one link
 * exists. Each case then shapes it and names whose `me` block is read.
 */
async function world(shape: (w: World) => Promise<Principal>): Promise<{
  readonly h: CommunitiesHarness;
  readonly id: string;
  readonly viewer: Principal;
  readonly invitationId: string;
  readonly grantId: string;
}> {
  const h = communitiesHarness();
  const admin = h.person('admin-1', ['ADMIN']);
  const id = await h.community(admin);
  for (const [userId, role] of [
    ['student-1', 'STUDENT'],
    ['teacher-1', 'TEACHER'],
    ['teacher-2', 'TEACHER'],
    ['admin-2', 'ADMIN'],
  ] as const) {
    h.person(userId, [role]);
  }
  await h.addPeople(admin, id, 'student-1', 'teacher-1', 'teacher-2', 'admin-2');
  const { invitationId } = await h.link(admin, id);
  const [grantId = ''] = await h.delegate(admin, id, 'teacher-2', 'community.lock');
  const viewer = await shape({ h, id, admin });
  return { h, id, viewer, invitationId, grantId };
}

interface World {
  readonly h: CommunitiesHarness;
  readonly id: string;
  readonly admin: Principal;
}

const lock = async ({ h, id, admin }: World) => {
  const locked = await h.status.execute({
    principal: admin,
    communityId: id,
    to: 'LOCKED',
    meta: META,
  });
  if (!locked.ok) throw new Error(locked.error.code);
};

const handOver = async ({ h, id, admin }: World, to: string) => {
  const moved = await h.transfer.execute({
    principal: admin,
    communityId: id,
    userId: to,
    meta: META,
  });
  if (!moved.ok) throw new Error(moved.error.code);
};

/**
 * Each operation, as its own route performs it — the answer `me` must
 * agree with. Every attempt runs in a world of its own: most of them change
 * it.
 */
const ROUTES: Record<
  CommunityOperation,
  (w: Awaited<ReturnType<typeof world>>) => Promise<readonly Result<unknown>[]>
> = {
  'community.invitations.manage': async ({ h, id, viewer, invitationId }) => [
    await h.invitations.execute({ principal: viewer, communityId: id, meta: META }),
    await h.revoke.execute({ principal: viewer, communityId: id, invitationId, meta: META }),
  ],
  'community.grants.manage': async ({ h, id, viewer, grantId }) => [
    await h.grant.execute({
      principal: viewer,
      communityId: id,
      userId: 'teacher-2',
      capabilities: ['community.members.view'],
      meta: META,
    }),
    await h.revokeGrant.execute({ principal: viewer, communityId: id, grantId, meta: META }),
  ],
  'community.ownership.transfer': async ({ h, id, viewer }) => [
    await h.transfer.execute({
      principal: viewer,
      communityId: id,
      userId: 'teacher-2',
      meta: META,
    }),
  ],
  'community.leave': async ({ h, id, viewer }) => [
    await h.leave.execute({ principal: viewer, communityId: id, meta: META }),
  ],
};

const CASES: readonly {
  readonly who: string;
  readonly shape: (w: World) => Promise<Principal>;
  readonly operations: readonly CommunityOperation[];
}[] = [
  {
    who: 'the owner',
    shape: async ({ admin }) => admin,
    operations: [
      'community.invitations.manage',
      'community.grants.manage',
      'community.ownership.transfer',
    ],
  },
  {
    who: 'the owner, while LOCKED',
    shape: async (w) => {
      await lock(w);
      return w.admin;
    },
    operations: [
      'community.invitations.manage',
      'community.grants.manage',
      'community.ownership.transfer',
    ],
  },
  {
    who: 'a teacher the ownership was handed to',
    shape: async (w) => {
      await handOver(w, 'teacher-1');
      return w.h.person('teacher-1', ['TEACHER']);
    },
    operations: [
      'community.invitations.manage',
      'community.grants.manage',
      'community.ownership.transfer',
    ],
  },
  {
    who: 'an owner whose role no longer holds communities.moderate',
    shape: async (w) => {
      await handOver(w, 'teacher-1');
      return w.h.person('teacher-1', ['STUDENT']);
    },
    operations: [],
  },
  {
    who: 'a member',
    shape: async ({ h }) => h.person('student-1', ['STUDENT']),
    operations: ['community.leave'],
  },
  {
    who: 'a member, while LOCKED',
    shape: async (w) => {
      await lock(w);
      return w.h.person('student-1', ['STUDENT']);
    },
    operations: ['community.leave'],
  },
  {
    who: 'a delegate holding community.members.invite',
    shape: async (w) => {
      await w.h.delegate(w.admin, w.id, 'teacher-1', 'community.members.invite');
      return w.h.person('teacher-1', ['TEACHER']);
    },
    operations: ['community.invitations.manage', 'community.leave'],
  },
  {
    // `me.capabilities` loses community.members.invite while LOCKED; the
    // link-management override does not.
    who: 'that delegate, while LOCKED',
    shape: async (w) => {
      await w.h.delegate(w.admin, w.id, 'teacher-1', 'community.members.invite');
      await lock(w);
      return w.h.person('teacher-1', ['TEACHER']);
    },
    operations: ['community.invitations.manage', 'community.leave'],
  },
  {
    who: 'an overseer who is not a member',
    shape: async ({ h }) => h.person('owner-role', ['OWNER']),
    operations: ['community.invitations.manage', 'community.ownership.transfer'],
  },
  {
    who: 'an overseer who is an ordinary member',
    shape: async ({ h }) => h.person('admin-2', ['ADMIN']),
    operations: ['community.invitations.manage', 'community.ownership.transfer', 'community.leave'],
  },
  {
    who: 'the former owner, after handing ownership over',
    shape: async (w) => {
      await handOver(w, 'teacher-1');
      return w.admin;
    },
    operations: ['community.invitations.manage', 'community.ownership.transfer', 'community.leave'],
  },
];

/**
 * `me.operations` (§6.6): the operations that are not acts, reported so a
 * client never works one out from standing or roles. Each is decided by the
 * rule its route uses — so what `me` lists is exactly what the route then
 * does, for owners, members, delegates and overseers, OPEN or LOCKED.
 */
describe('me.operations', () => {
  it('names the operations in the vocabulary’s order, and nothing else', () => {
    expect(COMMUNITY_OPERATIONS).toEqual([
      'community.invitations.manage',
      'community.grants.manage',
      'community.ownership.transfer',
      'community.leave',
    ]);
  });

  describe.each(CASES)('for $who', ({ shape, operations }) => {
    it('lists exactly these operations', async () => {
      const { h, id, viewer } = await world(shape);
      const view = await h.get.execute({ principal: viewer, communityId: id, meta: META });
      if (!view.ok) throw new Error(view.error.code);
      expect(view.value.me.operations).toEqual(operations);
    });

    it.each(COMMUNITY_OPERATIONS)(
      'lists %s exactly when its route allows it',
      async (operation) => {
        const w = await world(shape);
        const view = await w.h.get.execute({ principal: w.viewer, communityId: w.id, meta: META });
        if (!view.ok) throw new Error(view.error.code);
        const answers = await ROUTES[operation](w);
        const allowed = answers.every((answer) => answer.ok);
        const refused = answers.every((answer) => !answer.ok);
        // A route pair (list and revoke; grant and revoke) answers alike.
        expect(allowed || refused).toBe(true);
        expect(view.value.me.operations.includes(operation)).toBe(allowed);
      },
    );
  });

  it('comes back from the list, the lock and the transfer as it does from the community', async () => {
    const h = communitiesHarness();
    const admin = h.person('admin-1', ['ADMIN']);
    h.person('teacher-1', ['TEACHER']);
    const id = await h.community(admin);
    await h.addPeople(admin, id, 'teacher-1');

    const listed = await h.list.execute({ principal: admin, scope: 'mine', meta: META });
    const locked = await h.status.execute({
      principal: admin,
      communityId: id,
      to: 'LOCKED',
      meta: META,
    });
    const moved = await h.transfer.execute({
      principal: admin,
      communityId: id,
      userId: 'teacher-1',
      meta: META,
    });
    if (!listed.ok || !locked.ok || !moved.ok) throw new Error('refused');
    expect(listed.value.items[0]?.me.operations).toEqual([
      'community.invitations.manage',
      'community.grants.manage',
      'community.ownership.transfer',
    ]);
    expect(locked.value.me.operations).toEqual(listed.value.items[0]?.me.operations);
    // The transfer answers as the caller now stands: a member, still an overseer.
    expect(moved.value.me.operations).toEqual([
      'community.invitations.manage',
      'community.ownership.transfer',
      'community.leave',
    ]);
  });
});
