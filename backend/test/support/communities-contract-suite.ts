import type { Principal } from '../../src/shared';
import { META, type CommunitiesHarness } from './communities-harness';

/**
 * What COMMUNITY_MEMBERSHIP and COMMUNITY_DIRECTORY promise their consumers,
 * as one suite — run against the in-memory store and against Postgres, so
 * the two adapters are held to exactly the same answers (mock parity).
 *
 * `makeHarness` returns a fresh, empty harness per test.
 */
export function communityContractSuite(
  makeHarness: () => Promise<CommunitiesHarness>,
  cleanup: () => Promise<void> = async () => undefined,
): void {
  let h: CommunitiesHarness;
  let admin: Principal;
  let id: string;

  beforeEach(async () => {
    h = await makeHarness();
    admin = h.person('admin-1', ['ADMIN']);
    id = await h.community(admin);
  });

  afterEach(cleanup);

  const people = (count: number, prefix = 'member') =>
    Array.from({ length: count }, (_, i) => {
      const userId = `${prefix}-${String(i).padStart(3, '0')}`;
      h.person(userId, ['STUDENT']);
      return userId;
    });

  describe('members()', () => {
    it('returns each ACTIVE member exactly once, in user-id order, across pages', async () => {
      const ids = people(25);
      await h.addPeople(admin, id, ...ids);
      await h.remove.execute({
        principal: admin,
        communityId: id,
        userId: ids[3] ?? '',
        meta: META,
      });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { userIds: readonly string[]; nextCursor: string | null } =
          await h.membership.members(id, { cursor, limit: 7 });
        seen.push(...page.userIds);
        cursor = page.nextCursor;
      } while (cursor !== null);
      const expected = ['admin-1', ...ids.filter((userId) => userId !== ids[3])].sort();
      expect(seen).toEqual(expected);
    });

    it('honours onlyUserIds and excludeUserId', async () => {
      const ids = people(5);
      await h.addPeople(admin, id, ...ids);
      const page = await h.membership.members(id, {
        onlyUserIds: [ids[0] ?? '', ids[2] ?? '', 'not-a-member', 'admin-1'],
        excludeUserId: 'admin-1',
        limit: 10,
      });
      expect(page).toEqual({ userIds: [ids[0], ids[2]], nextCursor: null });
    });

    it('throws RangeError on a cursor it did not issue, a bad limit or an oversized list', async () => {
      await expect(h.membership.members(id, { cursor: 'forged', limit: 5 })).rejects.toThrow(
        RangeError,
      );
      await expect(h.membership.members(id, { limit: 0 })).rejects.toThrow(RangeError);
      await expect(h.membership.members(id, { limit: 1001 })).rejects.toThrow(RangeError);
      await expect(
        h.membership.members(id, {
          onlyUserIds: Array.from({ length: 1001 }, (_, i) => `u${i}`),
          limit: 5,
        }),
      ).rejects.toThrow(RangeError);
    });
  });

  describe('statesOf()', () => {
    it('answers the latest stint by version — even when a rejoin’s clock reads earlier', async () => {
      const [rejoiner] = people(1);
      const who = rejoiner ?? '';
      const student = h.person(who, ['STUDENT']);
      const { token } = await h.link(admin, id);
      await h.redeem.execute({ principal: student, token, meta: META });
      h.clock.advance(3600);
      await h.leave.execute({ principal: student, communityId: id, meta: META });
      h.clock.advance(-7200); // the clock steps back two hours
      const rejoined = await h.redeem.execute({ principal: student, token, meta: META });
      expect(rejoined.ok).toBe(true);

      const [state] = await h.membership.statesOf(id, [who, 'never-a-member']);
      expect(state).toMatchObject({ userId: who, active: true, version: 4 });
      expect(await h.membership.statesOf(id, ['never-a-member'])).toEqual([]);
    });
  });

  describe('heads() and listHeads()', () => {
    it('omits unknown ids, and reads effects — never a raw status', async () => {
      await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META });
      const heads = await h.membership.heads([id, 'no-such-community']);
      expect(heads).toEqual([
        {
          communityId: id,
          membershipVersion: 1,
          lifecycleVersion: 2,
          effects: {
            acceptsMembers: false,
            chatReadable: true,
            chatPostingOpen: false,
            liveStartOpen: false,
            liveJoinOpen: true,
            runningLiveContinues: true,
          },
        },
      ]);
      expect(Object.keys(heads[0] ?? {})).not.toContain('status');
    });

    it('pages every community by id, exactly once', async () => {
      const created = [id];
      for (let i = 0; i < 6; i += 1) created.push(await h.community(admin, `c${i}`));
      const seen: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await h.membership.listHeads({ afterCommunityId: after, limit: 4 });
        seen.push(...page.items.map((head) => head.communityId));
        if (page.next === null) break;
        after = page.next;
      }
      expect(seen).toEqual([...created].sort());
    });
  });

  describe('changesSince()', () => {
    it('replays every change after a version, in order, collapsed to the latest per person', async () => {
      const [a, b, c] = people(3);
      await h.addPeople(admin, id, a ?? '', b ?? ''); // v2, v3
      await h.remove.execute({ principal: admin, communityId: id, userId: a ?? '', meta: META }); // v4
      await h.addPeople(admin, id, c ?? '', a ?? ''); // v5, v6

      const all = await h.membership.changesSince(id, 0, 100);
      expect(all?.hasMore).toBe(false);
      expect(all?.throughVersion).toBe(6);
      expect(all?.states.map((state) => [state.userId, state.active, state.version])).toEqual([
        ['admin-1', true, 1],
        [b, true, 3],
        [c, true, 5],
        [a, true, 6],
      ]);

      // Resuming from the middle sees exactly what changed after it.
      const later = await h.membership.changesSince(id, 3, 100);
      expect(later?.states.map((state) => [state.userId, state.version])).toEqual([
        [c, 5],
        [a, 6],
      ]);
      expect(await h.membership.changesSince('no-such-community', 0, 10)).toBeNull();
    });

    it('pages with hasMore and a throughVersion that resumes without gaps', async () => {
      const ids = people(9);
      await h.addPeople(admin, id, ...ids); // versions 2..10
      const seen: number[] = [];
      let after = 0;
      for (;;) {
        const page = await h.membership.changesSince(id, after, 4);
        if (page === null) throw new Error('unknown community');
        seen.push(...page.states.map((state) => state.version));
        after = page.throughVersion;
        if (!page.hasMore) break;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(after).toBe(10);
    });
  });

  describe('the store under a lost basis', () => {
    const stale = { kind: 'owner' as const, userId: 'admin-1', membershipId: 'no-such-stint' };

    it('refuses every owner act whose basis is gone, and writes nothing', async () => {
      const { invitationId } = await h.link(admin, id);
      h.person('s1', ['STUDENT']);
      const at = h.clock.now();
      const before = await h.readModel.communities([id]);

      expect(
        await h.store.changeStatus({
          communityId: id,
          to: 'LOCKED',
          actor: stale,
          actorUserId: 'admin-1',
          at,
        }),
      ).toEqual({ kind: 'basis_lost' });
      expect(
        await h.store.addMembers({
          communityId: id,
          userIds: ['s1'],
          actor: stale,
          addedBy: 'admin-1',
          at,
          newId: () => 'never-written',
        }),
      ).toEqual({ kind: 'basis_lost' });
      expect(
        await h.store.removeMember({
          communityId: id,
          userId: 'admin-1',
          actor: stale,
          removedBy: 'admin-1',
          at,
        }),
      ).toEqual({ kind: 'basis_lost' });
      // Revoking writes the link's row before the basis is re-read: it must be undone.
      expect(
        await h.store.revokeInvitation({
          communityId: id,
          invitationId,
          actor: stale,
          revokedBy: 'admin-1',
          at,
        }),
      ).toEqual({ kind: 'basis_lost' });
      expect((await h.readModel.findInvitation(id, invitationId))?.revokedAt).toBeNull();
      expect(
        await h.store.createInvitation({
          invitation: {
            id: 'never-created',
            communityId: id,
            tokenHash: 'c'.repeat(64),
            createdBy: 'admin-1',
            createdAt: at,
            expiresAt: new Date(at.getTime() + 3_600_000),
            maxUses: null,
            uses: 0,
            revokedAt: null,
            revokedBy: null,
          },
          actor: stale,
        }),
      ).toEqual({ kind: 'basis_lost' });

      expect(await h.readModel.communities([id])).toEqual(before);
      expect(await h.readModel.findInvitation(id, 'never-created')).toBeNull();
      expect(await h.readModel.latestStints(id, ['s1'])).toEqual([]);
    });

    it('undoes a link’s use when its creator no longer stands as owner', async () => {
      const { invitationId } = await h.link(admin, id);
      h.person('plain-member', ['STUDENT']);
      await h.addPeople(admin, id, 'plain-member');
      const before = await h.readModel.communities([id]);

      const outcome = await h.store.redeem({
        invitationId,
        communityId: id,
        userId: 'joiner',
        creatorUserId: 'plain-member',
        stintId: 'never-joined',
        at: h.clock.now(),
      });

      expect(outcome).toEqual({ kind: 'creator_lost' });
      expect((await h.readModel.findInvitation(id, invitationId))?.uses).toBe(0);
      expect(await h.readModel.latestStints(id, ['joiner'])).toEqual([]);
      expect(await h.readModel.communities([id])).toEqual(before);
    });
  });

  describe('the directory', () => {
    it('names communities by id, omitting unknown ids', async () => {
      expect(await h.directory.describe([id, 'nope'])).toEqual([
        { communityId: id, title: 'حلقة التجويد' },
      ]);
      await expect(
        h.directory.describe(Array.from({ length: 1001 }, (_, i) => `c${i}`)),
      ).rejects.toThrow(RangeError);
    });
  });
}
