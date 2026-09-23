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

/** Every key an event payload may carry (§11) — ids, codes and versions only. */
const ALLOWED_PAYLOAD_KEYS = new Set([
  'communityId',
  'createdBy',
  'lockedBy',
  'unlockedBy',
  'lifecycleVersion',
  'userId',
  'membershipId',
  'source',
  'addedBy',
  'invitationId',
  'membershipVersion',
  'reason',
  'removedBy',
  'revokedBy',
]);

describe('creating a community', () => {
  let h: CommunitiesHarness;
  let admin: Principal;

  beforeEach(() => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
  });

  it('makes the creator its owner and first member, and says what they may do', async () => {
    const view = unwrap(
      await h.create.execute({ principal: admin, title: '  حلقة التجويد  ', meta: META }),
    );
    expect(view).toMatchObject({
      title: 'حلقة التجويد',
      status: 'OPEN',
      lifecycleVersion: 1,
      memberCount: 1,
      me: {
        standing: 'OWNER',
        capabilities: [
          'community.members.view',
          'community.members.invite',
          'community.members.remove',
          'community.lock',
          'community.chat.post',
          'community.live.start',
          'community.live.moderate',
        ],
        participation: [
          'community.view',
          'community.chat.read',
          'community.live.join',
          'community.live.raise_hand',
        ],
      },
    });
    const states = await h.membership.statesOf(view.id, ['admin-1']);
    expect(states).toEqual([
      expect.objectContaining({ userId: 'admin-1', active: true, version: 1 }),
    ]);
  });

  it('audits once, then announces the community and its owner — in that order', async () => {
    const view = unwrap(await h.create.execute({ principal: admin, title: 'حلقة', meta: META }));
    expect(h.journal.order).toEqual([
      'audit:communities.community.created',
      'event:communities.community.created',
      'event:communities.member.added',
    ]);
    expect(h.journal.entries[0]).toMatchObject({
      actorUserId: 'admin-1',
      resourceType: 'communities.community',
      resourceId: view.id,
      correlationId: 'test-request',
    });
    // No title anywhere in the journal.
    expect(JSON.stringify([h.journal.entries, h.journal.events])).not.toContain('حلقة');
  });

  it('refuses whoever may not create, a bad title, and too many creations', async () => {
    const teacher = h.person('teacher-1', ['TEACHER']);
    expect(codeOf(await h.create.execute({ principal: teacher, title: 'x', meta: META }))).toBe(
      'identity.permission_denied',
    );
    expect(codeOf(await h.create.execute({ principal: admin, title: '  ', meta: META }))).toBe(
      'communities.title_invalid',
    );
    // The refused title above counted too: 1 + 19 = the limit of 20.
    for (let i = 0; i < 19; i += 1) await h.community(admin, `c${i}`);
    const refused = await h.create.execute({ principal: admin, title: 'one too many', meta: META });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        kind: 'rate_limited',
        code: 'communities.too_many_communities',
        details: { retryAfterSeconds: expect.any(Number) as number },
      },
    });
  });
});

describe('seeing communities', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let student: Principal;

  beforeEach(() => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    student = h.person('student-1', ['STUDENT']);
  });

  it('shows a member the community, its count and themself — never the roster', async () => {
    const id = await h.community(admin);
    await h.addPeople(admin, id, 'student-1');
    const view = unwrap(await h.get.execute({ principal: student, communityId: id, meta: META }));
    expect(view).toMatchObject({
      memberCount: 2,
      me: {
        standing: 'MEMBER',
        capabilities: [],
        participation: [
          'community.view',
          'community.chat.read',
          'community.live.join',
          'community.live.raise_hand',
        ],
      },
    });
    expect(view.me.joinedAt).toEqual(h.clock.now());
  });

  it('lists my communities newest join first, across pages, each with its own me block', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await h.community(admin, `حلقة ${i}`);
      h.clock.advance(60);
      await h.addPeople(admin, id, 'student-1');
      ids.push(id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = unwrap(
        await h.list.execute({ principal: student, scope: 'mine', cursor, limit: 2, meta: META }),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) {
        expect(item.me.standing).toBe('MEMBER');
        seen.push(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual([...ids].reverse());
  });

  it('lists every community to an overseer only, and audits that it did', async () => {
    await h.community(admin, 'a');
    await h.community(admin, 'b');
    expect(codeOf(await h.list.execute({ principal: student, scope: 'all', meta: META }))).toBe(
      'identity.permission_denied',
    );
    const overseer = h.person('owner-role', ['OWNER']);
    h.journal.clear();
    const page = unwrap(await h.list.execute({ principal: overseer, scope: 'all', meta: META }));
    expect(page.items.map((item) => item.title)).toEqual(['b', 'a']);
    expect(page.items[0]?.me).toMatchObject({ standing: null, participation: ['community.view'] });
    expect(h.journal.actions()).toEqual(['communities.oversight.read']);
  });

  it('refuses a forged cursor', async () => {
    expect(
      codeOf(
        await h.list.execute({ principal: student, scope: 'mine', cursor: 'nope', meta: META }),
      ),
    ).toBe('communities.cursor_invalid');
  });
});

describe('locking and unlocking', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let id: string;

  beforeEach(async () => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    id = await h.community(admin);
    h.journal.clear();
  });

  it('changes the community once, however many times it is asked', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(h.journal.order).toEqual([
      'audit:communities.community.locked',
      'event:communities.community.locked',
    ]);
    const view = unwrap(await h.get.execute({ principal: admin, communityId: id, meta: META }));
    expect(view).toMatchObject({ status: 'LOCKED', lifecycleVersion: 2 });
    expect(h.journal.events[0]?.payload).toEqual({
      communityId: id,
      lockedBy: 'admin-1',
      lifecycleVersion: 2,
    });
    expect(h.journal.entries[0]?.metadata).toEqual({
      lifecycleVersion: 2,
      authority: {
        act: 'community.lock',
        basis: 'owner',
        membershipId: expect.any(String) as string,
        grantId: null,
      },
    });
  });

  it('closes what LOCKED closes, keeps management open, and can always be undone', async () => {
    unwrap(await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META }));
    const locked = unwrap(await h.get.execute({ principal: admin, communityId: id, meta: META }));
    expect(locked.me.capabilities).toEqual([
      'community.members.view',
      'community.members.remove',
      'community.lock',
      'community.live.moderate',
    ]);
    h.person('student-1', ['STUDENT']);
    expect(
      codeOf(
        await h.add.execute({
          principal: admin,
          communityId: id,
          userIds: ['student-1'],
          meta: META,
        }),
      ),
    ).toBe('communities.community_locked');
    expect(codeOf(await h.invite.execute({ principal: admin, communityId: id, meta: META }))).toBe(
      'communities.community_locked',
    );

    const reopened = unwrap(
      await h.status.execute({ principal: admin, communityId: id, to: 'OPEN', meta: META }),
    );
    expect(reopened).toMatchObject({ status: 'OPEN', lifecycleVersion: 3 });
    expect(h.journal.eventNames()).toEqual([
      'communities.community.locked',
      'communities.community.unlocked',
    ]);
  });

  it('keeps every event payload to ids, codes and versions', async () => {
    h.person('student-1', ['STUDENT']);
    await h.addPeople(admin, id, 'student-1');
    const { invitationId } = await h.link(admin, id);
    unwrap(await h.revoke.execute({ principal: admin, communityId: id, invitationId, meta: META }));
    unwrap(await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META }));
    unwrap(await h.status.execute({ principal: admin, communityId: id, to: 'OPEN', meta: META }));
    unwrap(
      await h.remove.execute({
        principal: admin,
        communityId: id,
        userId: 'student-1',
        meta: META,
      }),
    );
    expect(new Set(h.journal.eventNames())).toEqual(
      new Set([
        'communities.member.added',
        'communities.invitation.created',
        'communities.invitation.revoked',
        'communities.community.locked',
        'communities.community.unlocked',
        'communities.member.removed',
      ]),
    );
    for (const event of h.journal.events) {
      expect(event.aggregateId).toBe(id);
      for (const key of Object.keys(event.payload as object)) {
        expect({ event: event.name, key, allowed: ALLOWED_PAYLOAD_KEYS.has(key) }).toEqual({
          event: event.name,
          key,
          allowed: true,
        });
      }
    }
  });
});

describe('when the store reports a lost basis or a conflict', () => {
  it('asks the permit again — and answers 409 conflict when it still passes', async () => {
    const h = communitiesHarness();
    const admin = h.person('admin-1', ['ADMIN']);
    const id = await h.community(admin);
    h.journal.clear();
    jest.spyOn(h.store, 'changeStatus').mockResolvedValueOnce({ kind: 'basis_lost' });
    const raced = await h.status.execute({
      principal: admin,
      communityId: id,
      to: 'LOCKED',
      meta: META,
    });
    expect(raced).toMatchObject({
      ok: false,
      error: { kind: 'conflict', code: 'communities.conflict' },
    });
    jest.spyOn(h.store, 'addMembers').mockResolvedValueOnce({ kind: 'conflict' });
    h.person('s1', ['STUDENT']);
    expect(
      codeOf(
        await h.add.execute({ principal: admin, communityId: id, userIds: ['s1'], meta: META }),
      ),
    ).toBe('communities.conflict');
    // Nothing was recorded for either.
    expect(h.journal.entries).toEqual([]);
    expect(h.journal.events).toEqual([]);
  });
});
