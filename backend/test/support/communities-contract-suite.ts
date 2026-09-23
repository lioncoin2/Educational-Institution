import type { Principal } from '../../src/shared';
import type { CommunityCapability } from '../../src/modules/communities/contracts/capabilities';
import type { GrantKey } from '../../src/modules/communities/domain/ports';
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
          removerCeilings: new Set(),
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
        creatorCapability: 'community.members.invite',
        stintId: 'never-joined',
        at: h.clock.now(),
      });

      expect(outcome).toEqual({ kind: 'creator_lost' });
      expect((await h.readModel.findInvitation(id, invitationId))?.uses).toBe(0);
      expect(await h.readModel.latestStints(id, ['joiner'])).toEqual([]);
      expect(await h.readModel.communities([id])).toEqual(before);
    });
  });

  describe('delegation (P3)', () => {
    let teacher: Principal;
    let ownerStint: string;

    beforeEach(async () => {
      teacher = h.person('teacher-1', ['TEACHER']);
      h.person('teacher-2', ['TEACHER']);
      await h.addPeople(admin, id, 'teacher-1', 'teacher-2');
      ownerStint = (await h.store.authorityOf(id, 'admin-1')).stint?.id ?? '';
    });

    const owner = () => ({ userId: 'admin-1', membershipId: ownerStint });

    it('grants a batch at once, reports repeats unchanged, and writes nothing twice', async () => {
      const first = await h.store.grant({
        communityId: id,
        owner: owner(),
        granteeUserId: 'teacher-1',
        capabilities: ['community.lock', 'community.members.view'],
        at: h.clock.now(),
        newId: () => h.ids.next(),
      });
      if (first.kind !== 'granted') throw new Error(first.kind);
      // Created in the vocabulary's order, whatever order they were named in.
      expect(first.created.map((grant) => grant.capability)).toEqual([
        'community.members.view',
        'community.lock',
      ]);
      expect(first.unchanged).toEqual([]);

      const again = await h.store.grant({
        communityId: id,
        owner: owner(),
        granteeUserId: 'teacher-1',
        capabilities: ['community.lock', 'community.live.start'],
        at: h.clock.now(),
        newId: () => h.ids.next(),
      });
      if (again.kind !== 'granted') throw new Error(again.kind);
      expect(again.created.map((grant) => grant.capability)).toEqual(['community.live.start']);
      expect(again.unchanged.map((grant) => grant.id)).toEqual([
        first.created.find((grant) => grant.capability === 'community.lock')?.id,
      ]);
      expect(
        (await h.readModel.grants(id, { userId: 'teacher-1', limit: 10 })).map(
          (grant) => grant.capability,
        ),
      ).toEqual(['community.live.start', 'community.lock', 'community.members.view']);
    });

    it('refuses a grantee who is not an ACTIVE member, or is the owner — writing nothing', async () => {
      h.person('outsider', ['TEACHER']);
      for (const granteeUserId of ['outsider', 'admin-1']) {
        expect(
          await h.store.grant({
            communityId: id,
            owner: owner(),
            granteeUserId,
            capabilities: ['community.lock'],
            at: h.clock.now(),
            newId: () => h.ids.next(),
          }),
        ).toEqual({ kind: 'grantee_ineligible' });
      }
      expect(await h.readModel.grants(id, { limit: 10 })).toEqual([]);
    });

    it('refuses grants, revocations and transfers resting on a stale owner stint', async () => {
      const [grantId] = await h.delegate(admin, id, 'teacher-1', 'community.lock');
      const stale = { userId: 'admin-1', membershipId: 'no-such-stint' };
      expect(
        await h.store.grant({
          communityId: id,
          owner: stale,
          granteeUserId: 'teacher-2',
          capabilities: ['community.lock'],
          at: h.clock.now(),
          newId: () => h.ids.next(),
        }),
      ).toEqual({ kind: 'basis_lost' });
      expect(
        await h.store.revokeGrant({
          communityId: id,
          grantId: grantId ?? '',
          owner: stale,
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'basis_lost' });
      expect(
        await h.store.transfer({
          communityId: id,
          toUserId: 'teacher-2',
          actor: { kind: 'owner', ...stale },
          transferredBy: 'admin-1',
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'owner_conflict' });
      expect((await h.readModel.grants(id, { limit: 10 })).map((grant) => grant.userId)).toEqual([
        'teacher-1',
      ]);
      expect((await h.store.authorityOf(id, 'admin-1')).stint?.standing).toBe('OWNER');
    });

    it('revokes once, answers a repeat unchanged, and never reaches into another community', async () => {
      const [grantId] = await h.delegate(admin, id, 'teacher-1', 'community.lock');
      h.clock.advance(-60); // a lagging clock never ends a grant before it began
      const revoked = await h.store.revokeGrant({
        communityId: id,
        grantId: grantId ?? '',
        owner: owner(),
        at: h.clock.now(),
      });
      if (revoked.kind !== 'revoked') throw new Error(revoked.kind);
      expect(revoked.grant).toMatchObject({ endReason: 'revoked', endedBy: 'admin-1' });
      expect(revoked.grant.endedAt?.getTime()).toBe(revoked.grant.grantedAt.getTime());
      expect(
        await h.store.revokeGrant({
          communityId: id,
          grantId: grantId ?? '',
          owner: owner(),
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'unchanged', grant: revoked.grant });

      const other = await h.community(admin, 'أخرى');
      const otherOwner = (await h.store.authorityOf(other, 'admin-1')).stint?.id ?? '';
      expect(
        await h.store.revokeGrant({
          communityId: other,
          grantId: grantId ?? '',
          owner: { userId: 'admin-1', membershipId: otherOwner },
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'not_found' });
    });

    it('bases an act on an ACTIVE grant only, re-verified by the store', async () => {
      const [lockGrant, viewGrant] = await h.delegate(
        admin,
        id,
        'teacher-1',
        'community.lock',
        'community.members.view',
      );
      const read = await h.store.authorityOf(id, 'teacher-1');
      expect(read.stint?.grants.map((grant) => grant.capability).sort()).toEqual([
        'community.lock',
        'community.members.view',
      ]);
      const delegate = {
        kind: 'grant' as const,
        userId: 'teacher-1',
        membershipId: read.stint?.id ?? '',
        grantId: lockGrant ?? '',
        capability: 'community.lock' as const,
      };
      // Naming a grant of another capability is no basis at all.
      expect(
        await h.store.changeStatus({
          communityId: id,
          to: 'LOCKED',
          actor: { ...delegate, grantId: viewGrant ?? '' },
          actorUserId: 'teacher-1',
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'basis_lost' });
      await h.store.revokeGrant({
        communityId: id,
        grantId: lockGrant ?? '',
        owner: owner(),
        at: h.clock.now(),
      });
      expect(
        await h.store.changeStatus({
          communityId: id,
          to: 'LOCKED',
          actor: delegate,
          actorUserId: 'teacher-1',
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'basis_lost' });
      expect((await h.readModel.communities([id]))[0]?.status).toBe('OPEN');
    });

    it('bounds a delegate’s removals by R6 — dormant grants included — and never removes the owner', async () => {
      h.person('student-1', ['STUDENT']);
      await h.addPeople(admin, id, 'student-1');
      const [removeGrant] = await h.delegate(admin, id, 'teacher-1', 'community.members.remove');
      await h.delegate(admin, id, 'teacher-2', 'community.lock');
      const remover = {
        kind: 'grant' as const,
        userId: 'teacher-1',
        membershipId: (await h.store.authorityOf(id, 'teacher-1')).stint?.id ?? '',
        grantId: removeGrant ?? '',
        capability: 'community.members.remove' as const,
      };
      const everything = new Set<CommunityCapability>([
        'community.members.remove',
        'community.lock',
        'community.members.view',
      ]);
      const removal = (userId: string, removerCeilings: ReadonlySet<CommunityCapability>) =>
        h.store.removeMember({
          communityId: id,
          userId,
          actor: remover,
          removerCeilings,
          removedBy: 'teacher-1',
          at: h.clock.now(),
        });

      // teacher-2 holds community.lock; teacher-1 does not.
      expect(await removal('teacher-2', everything)).toEqual({ kind: 'holds_more' });
      expect(await removal('admin-1', everything)).toEqual({ kind: 'owner' });
      // Holding a capability's ceiling is not holding the capability.
      const removed = await removal('student-1', new Set());
      expect(removed).toMatchObject({ kind: 'removed', endedGrants: [] });

      // Once teacher-1 holds community.lock too, teacher-2 is removable — and their grants end with them.
      await h.delegate(admin, id, 'teacher-1', 'community.lock');
      const second = await removal('teacher-2', everything);
      if (second.kind !== 'removed') throw new Error(second.kind);
      expect(second.endedGrants.map((grant) => [grant.capability, grant.endReason])).toEqual([
        ['community.lock', 'membership_ended'],
      ]);
      expect(await h.readModel.grants(id, { userId: 'teacher-2', limit: 10 })).toEqual([]);
    });

    it('ends a leaver’s grants with the stint, and a rejoin revives none', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.lock', 'community.members.view');
      const left = await h.store.leave({ communityId: id, userId: 'teacher-1', at: h.clock.now() });
      if (left.kind !== 'left') throw new Error(left.kind);
      expect(left.endedGrants.map((grant) => grant.endReason)).toEqual([
        'membership_ended',
        'membership_ended',
      ]);
      await h.addPeople(admin, id, 'teacher-1');
      expect((await h.store.authorityOf(id, 'teacher-1')).stint?.grants).toEqual([]);
      expect(await h.readModel.grants(id, { limit: 10 })).toEqual([]);
    });

    it('transfers ownership: demotes, promotes, and ends the new owner’s own grants', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.lock');
      const [kept] = await h.delegate(admin, id, 'teacher-2', 'community.members.view');
      const moved = await h.store.transfer({
        communityId: id,
        toUserId: 'teacher-1',
        actor: { kind: 'owner', ...owner() },
        transferredBy: 'admin-1',
        at: h.clock.now(),
      });
      if (moved.kind !== 'transferred') throw new Error(moved.kind);
      expect([moved.from.userId, moved.from.standing, moved.to.userId, moved.to.standing]).toEqual([
        'admin-1',
        'MEMBER',
        'teacher-1',
        'OWNER',
      ]);
      expect(moved.endedGrants.map((grant) => [grant.capability, grant.endReason])).toEqual([
        ['community.lock', 'ownership_changed'],
      ]);
      // Grants survive a transfer — except the new owner's own.
      expect((await h.readModel.grants(id, { limit: 10 })).map((grant) => grant.id)).toEqual([
        kept,
      ]);
      // Naming the owner again changes nothing; a non-member is refused.
      expect(
        await h.store.transfer({
          communityId: id,
          toUserId: 'teacher-1',
          actor: { kind: 'oversight' },
          transferredBy: null,
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'unchanged' });
      expect(
        await h.store.transfer({
          communityId: id,
          toUserId: 'nobody',
          actor: { kind: 'oversight' },
          transferredBy: null,
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'target_not_member' });
      expect(
        await h.store.transfer({
          communityId: 'no-such-community',
          toUserId: 'teacher-1',
          actor: { kind: 'oversight' },
          transferredBy: null,
          at: h.clock.now(),
        }),
      ).toEqual({ kind: 'not_found' });
    });

    it('admits through a delegate’s link only while the delegate’s grant stands', async () => {
      const [inviteGrant] = await h.delegate(admin, id, 'teacher-1', 'community.members.invite');
      const { invitationId } = await h.link(teacher, id);
      const redeem = (userId: string) =>
        h.store.redeem({
          invitationId,
          communityId: id,
          userId,
          creatorUserId: 'teacher-1',
          creatorCapability: 'community.members.invite',
          stintId: `stint-${userId}`,
          at: h.clock.now(),
        });
      expect((await redeem('joiner-1')).kind).toBe('joined');
      await h.store.revokeGrant({
        communityId: id,
        grantId: inviteGrant ?? '',
        owner: owner(),
        at: h.clock.now(),
      });
      expect(await redeem('joiner-2')).toEqual({ kind: 'creator_lost' });
      expect((await h.readModel.findInvitation(id, invitationId))?.uses).toBe(1);
    });

    it('lists grants by capability then holder, keyset-paged and filtered', async () => {
      await h.delegate(admin, id, 'teacher-2', 'community.lock', 'community.chat.post');
      await h.delegate(admin, id, 'teacher-1', 'community.lock', 'community.live.moderate');
      const seen: string[] = [];
      let after: GrantKey | undefined;
      for (;;) {
        const page = await h.readModel.grants(id, { after, limit: 3 });
        seen.push(...page.map((grant) => `${grant.capability}/${grant.userId}`));
        const last = page[page.length - 1];
        if (page.length < 3 || last === undefined) break;
        after = { capability: last.capability, userId: last.userId };
      }
      expect(seen).toEqual([
        'community.chat.post/teacher-2',
        'community.live.moderate/teacher-1',
        'community.lock/teacher-1',
        'community.lock/teacher-2',
      ]);
      expect(
        (await h.readModel.grants(id, { capability: 'community.lock', limit: 10 })).map(
          (grant) => grant.userId,
        ),
      ).toEqual(['teacher-1', 'teacher-2']);
    });
  });

  describe('COMMUNITY_CAPABILITY_HOLDERS', () => {
    it('lists the owner and effective grantees — never the dormant, the departed or overseers', async () => {
      for (const userId of ['t-a', 't-b', 't-c', 't-d', 't-e']) h.person(userId, ['TEACHER']);
      h.person('overseer', ['OWNER']); // holds communities.manage, never a stint here
      await h.addPeople(admin, id, 't-a', 't-b', 't-c', 't-d', 't-e');
      for (const userId of ['t-a', 't-b', 't-c', 't-d']) {
        await h.delegate(admin, id, userId, 'community.members.remove');
      }
      await h.delegate(admin, id, 't-e', 'community.lock'); // another capability
      h.accounts.setRoles('t-b', ['STUDENT']); // dormant: lost communities.moderate
      h.accounts.suspend('t-c'); // dormant: cannot sign in
      await h.remove.execute({ principal: admin, communityId: id, userId: 't-d', meta: META });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { userIds: readonly string[]; nextCursor: string | null } =
          await h.holders.list(id, 'community.members.remove', { cursor, limit: 1 });
        seen.push(...page.userIds);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null);
      expect(seen).toEqual(['admin-1', 't-a']);
      // One candidate per page — some pages come back empty after filtering.
      expect(pages).toBeGreaterThan(seen.length);
      expect(await h.holders.list('no-such-community', 'community.lock', { limit: 10 })).toEqual({
        userIds: [],
        nextCursor: null,
      });
    });

    it('throws RangeError on a bad limit, a forged cursor or an unknown capability', async () => {
      await expect(h.holders.list(id, 'community.lock', { limit: 0 })).rejects.toThrow(RangeError);
      await expect(h.holders.list(id, 'community.lock', { limit: 1001 })).rejects.toThrow(
        RangeError,
      );
      await expect(
        h.holders.list(id, 'community.lock', { cursor: 'forged', limit: 5 }),
      ).rejects.toThrow(RangeError);
      await expect(h.holders.list(id, 'community.view' as never, { limit: 5 })).rejects.toThrow(
        RangeError,
      );
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
