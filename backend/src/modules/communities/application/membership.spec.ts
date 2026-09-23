import type { Principal } from '../../../shared';
import {
  META,
  codeOf,
  communitiesHarness,
  type CommunitiesHarness,
} from '../../../../test/support/communities-harness';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

describe('adding members', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let id: string;

  beforeEach(async () => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    for (const student of ['s1', 's2', 's3']) h.person(student, ['STUDENT']);
    id = await h.community(admin);
    h.journal.clear();
  });

  const add = (userIds: string[], principal = admin) =>
    h.add.execute({ principal, communityId: id, userIds, meta: META });

  it('adds whoever is not a member yet — one audit entry and one event per newcomer', async () => {
    const first = unwrap(await add(['s1', 's2']));
    expect(first).toEqual({ view: { added: ['s1', 's2'], unchanged: [] }, anyAdded: true });
    const again = unwrap(await add(['s2', 's3']));
    expect(again).toEqual({ view: { added: ['s3'], unchanged: ['s2'] }, anyAdded: true });
    const nothing = unwrap(await add(['s1', 's3']));
    expect(nothing).toEqual({ view: { added: [], unchanged: ['s1', 's3'] }, anyAdded: false });

    expect(h.journal.order).toEqual([
      'audit:communities.member.added',
      'event:communities.member.added',
      'audit:communities.member.added',
      'event:communities.member.added',
      'audit:communities.member.added',
      'event:communities.member.added',
    ]);
    expect(h.journal.events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        userId: 's1',
        source: 'ADDED',
        addedBy: 'admin-1',
        membershipVersion: 2,
      }),
      expect.objectContaining({ userId: 's2', membershipVersion: 3 }),
      expect.objectContaining({ userId: 's3', membershipVersion: 4 }),
    ]);
    const view = unwrap(await h.get.execute({ principal: admin, communityId: id, meta: META }));
    expect(view.memberCount).toBe(4);
  });

  it('refuses the whole request when anyone named cannot join, naming only them', async () => {
    h.accounts.suspend('s2');
    const refused = await add(['s1', 's2', 'nobody']);
    expect(refused).toMatchObject({
      ok: false,
      error: {
        kind: 'validation',
        code: 'communities.members_not_eligible',
        details: { userIds: ['s2', 'nobody'] },
      },
    });
    expect(h.journal.entries).toHaveLength(0);
  });

  it('lets a manager re-add someone they removed', async () => {
    unwrap(await add(['s1']));
    unwrap(await h.remove.execute({ principal: admin, communityId: id, userId: 's1', meta: META }));
    expect(unwrap(await add(['s1'])).view.added).toEqual(['s1']);
    const [state] = await h.membership.statesOf(id, ['s1']);
    expect(state).toMatchObject({ active: true, version: 4 });
  });
});

describe('removing and leaving', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let student: Principal;
  let id: string;

  beforeEach(async () => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    student = h.person('s1', ['STUDENT']);
    id = await h.community(admin);
    await h.addPeople(admin, id, 's1');
    h.journal.clear();
  });

  it('removes a member once; removing again is not found', async () => {
    unwrap(await h.remove.execute({ principal: admin, communityId: id, userId: 's1', meta: META }));
    expect(h.journal.order).toEqual([
      'audit:communities.member.removed',
      'event:communities.member.removed',
    ]);
    expect(h.journal.events[0]?.payload).toMatchObject({
      userId: 's1',
      reason: 'REMOVED',
      removedBy: 'admin-1',
      membershipVersion: 3,
    });
    expect(
      codeOf(
        await h.remove.execute({ principal: admin, communityId: id, userId: 's1', meta: META }),
      ),
    ).toBe('communities.member_not_found');
    // The removed member now sees the community as a stranger does.
    expect(codeOf(await h.get.execute({ principal: student, communityId: id, meta: META }))).toBe(
      'communities.community_not_found',
    );
  });

  it('never removes the owner, and the owner cannot leave', async () => {
    expect(
      codeOf(
        await h.remove.execute({
          principal: admin,
          communityId: id,
          userId: 'admin-1',
          meta: META,
        }),
      ),
    ).toBe('communities.owner_not_removable');
    expect(codeOf(await h.leave.execute({ principal: admin, communityId: id, meta: META }))).toBe(
      'communities.owner_cannot_leave',
    );
    const overseer = h.person('owner-role', ['OWNER']);
    expect(
      codeOf(
        await h.remove.execute({
          principal: overseer,
          communityId: id,
          userId: 'admin-1',
          meta: META,
        }),
      ),
    ).toBe('communities.owner_not_removable');
  });

  it('lets a member leave, recorded as their own act', async () => {
    unwrap(await h.leave.execute({ principal: student, communityId: id, meta: META }));
    expect(h.journal.entries).toEqual([
      expect.objectContaining({
        actorUserId: 's1',
        action: 'communities.member.left',
        metadata: expect.objectContaining({
          authority: expect.objectContaining({
            basis: 'membership',
            act: 'community.view',
          }) as unknown,
        }) as unknown,
      }),
    ]);
    expect(h.journal.events[0]?.payload).toMatchObject({ reason: 'LEFT', removedBy: 's1' });
    expect(codeOf(await h.leave.execute({ principal: student, communityId: id, meta: META }))).toBe(
      'communities.community_not_found',
    );
  });

  it('removes while LOCKED — management stays open', async () => {
    unwrap(await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META }));
    unwrap(await h.remove.execute({ principal: admin, communityId: id, userId: 's1', meta: META }));
  });
});

describe('the roster', () => {
  it('pages every member exactly once, oldest first, with names from the directory only', async () => {
    const h = communitiesHarness();
    const admin = h.person('admin-1', ['ADMIN']);
    const id = await h.community(admin);
    const students = Array.from({ length: 23 }, (_, i) => `student-${String(i).padStart(2, '0')}`);
    for (const student of students) h.person(student, ['STUDENT']);
    // Several joins in the same instant: the user id breaks the tie.
    await h.addPeople(admin, id, ...students.slice(0, 10));
    h.clock.advance(1);
    await h.addPeople(admin, id, ...students.slice(10));
    h.accounts.suspend('student-05');

    const seen: string[] = [];
    const describeCalls = h.accounts.describeCalls;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = unwrap(
        await h.members.execute({
          principal: admin,
          communityId: id,
          cursor,
          limit: 5,
          meta: META,
        }),
      );
      pages += 1;
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(['active', 'displayName', 'joinedAt', 'userId']);
        seen.push(item.userId);
        if (item.userId === 'student-05') expect(item.active).toBe(false);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(['admin-1', ...students]);
    expect(pages).toBe(5);
    // One directory call per page — never one per row.
    expect(h.accounts.describeCalls - describeCalls).toBe(pages);
  });
});
