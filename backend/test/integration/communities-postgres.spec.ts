import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import { communityContractSuite } from '../support/communities-contract-suite';
import { META, communitiesHarness, type CommunitiesHarness } from '../support/communities-harness';
import {
  describeWithPostgres,
  scratchDatabase,
  tolerateTeardown,
  type ScratchDatabase,
} from '../support/postgres';

/**
 * Communities against a real Postgres: the constraints that back every
 * invariant, the races of §7.4 and §8.4 run for real, and the contract
 * suite the in-memory store also passes (mock parity).
 *
 * Races run through several store instances over one bigger pool: each
 * instance has its own admission mutex, exactly as separate API processes
 * would, so the database — not the in-process queue — decides every race.
 * Every connection runs under a statement_timeout, so a deadlock or a lock
 * that never frees fails the test instead of hanging it.
 */
describeWithPostgres('Communities in Postgres', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    scratch = await scratchDatabase();
    pool = tolerateTeardown(
      new Pool({ connectionString: scratch.url, max: 16, options: '-c statement_timeout=15000' }),
    );
    db = drizzle(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  const reset = async () => {
    await db.execute(sql`truncate community_members, community_invitations, communities`);
  };

  const postgresHarness = (): CommunitiesHarness =>
    communitiesHarness({
      store: new DrizzleCommunityRepository(db),
      readModel: new DrizzleCommunityReadModel(db),
    });

  const count = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number((await db.execute(query)).rows[0]?.n ?? 0);

  describe('the contracts, on Postgres (mock parity)', () => {
    communityContractSuite(async () => {
      await reset();
      return postgresHarness();
    });
  });

  describe('constraints', () => {
    let h: CommunitiesHarness;
    let communityId: string;

    beforeEach(async () => {
      await reset();
      h = postgresHarness();
      const admin = h.person('admin-1', ['ADMIN']);
      communityId = await h.community(admin);
    });

    const violated = async (statement: ReturnType<typeof sql>): Promise<string> => {
      try {
        await db.execute(statement);
      } catch (error) {
        const cause = (error as { cause?: { constraint?: string } }).cause;
        return cause?.constraint ?? (error as { constraint?: string }).constraint ?? 'unknown';
      }
      return 'no violation';
    };

    const stint = (id: string, fields: string) =>
      sql.raw(`insert into community_members (id, community_id, user_id, status, standing, source,
                 added_by, invitation_id, joined_at, ended_at, ended_by, version)
               values ('${id}', '${communityId}', ${fields})`);

    it('holds a second ACTIVE stint, a second owner and a reused version to account', async () => {
      expect(
        await violated(
          stint('dup', `'admin-1', 'ACTIVE', 'MEMBER', 'ADDED', null, null, now(), null, null, 99`),
        ),
      ).toBe('community_members_current_unique');
      expect(
        await violated(
          stint('owner2', `'u2', 'ACTIVE', 'OWNER', 'ADDED', null, null, now(), null, null, 98`),
        ),
      ).toBe('community_members_owner_unique');
      expect(
        await violated(
          stint('v1', `'u3', 'ACTIVE', 'MEMBER', 'ADDED', null, null, now(), null, null, 1`),
        ),
      ).toBe('community_members_version_unique');
    });

    it('keeps every stint row consistent with itself', async () => {
      const cases: [string, string][] = [
        [
          `'u', 'ACTIVE', 'MEMBER', 'ADDED', null, null, now(), now(), 'u', 50`,
          'community_members_ended_consistent',
        ],
        [
          `'u', 'LEFT', 'MEMBER', 'ADDED', null, null, now(), null, 'u', 51`,
          'community_members_ended_consistent',
        ],
        [
          `'u', 'REMOVED', 'MEMBER', 'ADDED', null, null, now(), now() - interval '1 day', 'x', 52`,
          'community_members_ended_after_joined',
        ],
        [
          `'u', 'ACTIVE', 'MEMBER', 'INVITATION', null, null, now(), null, null, 53`,
          'community_members_source_consistent',
        ],
        [
          `'u', 'LEFT', 'OWNER', 'ADDED', null, null, now(), now(), 'u', 54`,
          'community_members_owner_active',
        ],
        [
          `'u', 'LEFT', 'MEMBER', 'ADDED', null, null, now(), now(), 'someone-else', 55`,
          'community_members_left_by_self',
        ],
        [
          `'u', 'GONE', 'MEMBER', 'ADDED', null, null, now(), now(), 'u', 56`,
          'community_members_status_valid',
        ],
        [
          `'u', 'ACTIVE', 'MEMBER', 'SYNC', null, null, now(), null, null, 57`,
          'community_members_source_valid',
        ],
        [
          `'u', 'ACTIVE', 'MEMBER', 'ADDED', null, null, now(), null, null, 0`,
          'community_members_version_positive',
        ],
      ];
      for (const [fields, constraint] of cases) {
        expect(await violated(stint(`bad-${constraint}-${fields.length}`, fields))).toBe(
          constraint,
        );
      }
    });

    it('keeps communities and links within their bounds', async () => {
      expect(
        await violated(sql`update communities set member_count = -1 where id = ${communityId}`),
      ).toBe('communities_member_count_nonnegative');
      expect(
        await violated(sql`update communities set status = 'ARCHIVED' where id = ${communityId}`),
      ).toBe('communities_status_valid');
      expect(await violated(sql`update communities set title = '' where id = ${communityId}`)).toBe(
        'communities_title_length',
      );
      const { invitationId } = await h.link(h.person('admin-1', ['ADMIN']), communityId, {
        maxUses: 1,
      });
      expect(
        await violated(sql`update community_invitations set uses = 2 where id = ${invitationId}`),
      ).toBe('community_invitations_uses_within_limit');
      expect(
        await violated(
          sql`update community_invitations set token_hash = 'not-a-hash' where id = ${invitationId}`,
        ),
      ).toBe('community_invitations_token_hash_shape');
      expect(
        await violated(
          sql`update community_invitations set revoked_at = created_at - interval '1 second' where id = ${invitationId}`,
        ),
      ).toBe('community_invitations_revoked_after_created');
    });

    it('never lets a community with history be deleted', async () => {
      expect(await violated(sql`delete from communities where id = ${communityId}`)).toBe(
        'community_members_community_id_communities_id_fk',
      );
    });

    it('holds the remaining row CHECKs and the token-hash index to account', async () => {
      const admin = h.person('admin-1', ['ADMIN']);
      const { invitationId } = await h.link(admin, communityId);
      const [link] = (
        await db.execute(
          sql`select token_hash from community_invitations where id = ${invitationId}`,
        )
      ).rows as { token_hash: string }[];
      expect(
        await violated(sql`insert into community_invitations
          (id, community_id, token_hash, created_by, created_at, expires_at)
          values ('twin', ${communityId}, ${link?.token_hash ?? ''}, 'admin-1', now(), now() + interval '1 day')`),
      ).toBe('community_invitations_token_hash_unique');
      expect(
        await violated(
          sql`update community_invitations set expires_at = created_at where id = ${invitationId}`,
        ),
      ).toBe('community_invitations_expires_after_created');
      expect(
        await violated(
          sql`update community_invitations set max_uses = 0 where id = ${invitationId}`,
        ),
      ).toBe('community_invitations_max_uses_positive');
      expect(
        await violated(sql`update communities set lifecycle_version = 0 where id = ${communityId}`),
      ).toBe('communities_lifecycle_version_positive');
      expect(
        await violated(
          sql`update communities set membership_version = -1 where id = ${communityId}`,
        ),
      ).toBe('communities_membership_version_nonnegative');
      expect(
        await violated(
          sql`update communities set updated_at = created_at - interval '1 second' where id = ${communityId}`,
        ),
      ).toBe('communities_updated_after_created');
      expect(
        await violated(
          stint(
            'bad-standing',
            `'u9', 'ACTIVE', 'ADMIN', 'ADDED', null, null, now(), null, null, 77`,
          ),
        ),
      ).toBe('community_members_standing_valid');
      // The target of P3's composite grant key: unique on (id, community_id, user_id).
      const key = await db.execute(sql`
        select pg_get_constraintdef(oid) as definition from pg_constraint
         where conname = 'community_members_stint_key'`);
      expect(key.rows).toEqual([{ definition: 'UNIQUE (id, community_id, user_id)' }]);
    });

    it('holds no foreign key into any other module’s tables', async () => {
      const keys = await db.execute(sql`
        select conrelid::regclass::text as source, confrelid::regclass::text as target
          from pg_constraint
         where contype = 'f'
           and conrelid::regclass::text in ('communities', 'community_members', 'community_invitations')
         order by 1, 2`);
      expect(keys.rows).toEqual([
        { source: 'community_invitations', target: 'communities' },
        { source: 'community_members', target: 'communities' },
        { source: 'community_members', target: 'community_invitations' },
      ]);
    });
  });

  describe('races', () => {
    /** Several processes' worth of stores: each has its own admission mutex. */
    let stores: DrizzleCommunityRepository[];
    let h: CommunitiesHarness;
    let communityId: string;
    let ownerStintId: string;

    // The lock order should make deadlocks impossible. A retried victim
    // succeeds and hides in every outcome, so the retries are counted instead.
    afterEach(() => {
      expect(
        [...stores, h.store as DrizzleCommunityRepository].map((each) => each.deadlockRetries),
      ).toEqual(new Array(stores.length + 1).fill(0));
    });

    beforeEach(async () => {
      await reset();
      stores = Array.from({ length: 6 }, () => new DrizzleCommunityRepository(db));
      h = postgresHarness();
      const admin = h.person('admin-1', ['ADMIN']);
      communityId = await h.community(admin);
      const read = await h.store.authorityOf(communityId, 'admin-1');
      ownerStintId = read.stint?.id ?? '';
    });

    const owner = () => ({ kind: 'owner' as const, userId: 'admin-1', membershipId: ownerStintId });
    const store = (i: number) => stores[i % stores.length];
    const at = () => h.clock.now();

    const invariants = async () => {
      const [row] = (
        await db.execute(sql`
          select c.member_count as counted,
                 (select count(*) from community_members m
                   where m.community_id = c.id and m.status = 'ACTIVE')::int as actual,
                 c.membership_version as allocated,
                 (select max(version) from community_members m where m.community_id = c.id) as top
            from communities c where c.id = ${communityId}`)
      ).rows as { counted: number; actual: number; allocated: string; top: string }[];
      expect(Number(row?.counted)).toBe(row?.actual);
      expect(Number(row?.allocated)).toBe(Number(row?.top));
    };

    const redeem = (i: number, invitationId: string, userId: string) =>
      store(i).redeem({
        invitationId,
        communityId,
        userId,
        creatorUserId: 'admin-1',
        stintId: `stint-${userId}-${i}-${Math.random().toString(36).slice(2)}`,
        at: at(),
      });

    it('twenty simultaneous redemptions by one person: one member, one use', async () => {
      const { invitationId } = await h.link(h.person('admin-1', ['ADMIN']), communityId);
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) => redeem(i, invitationId, 'double-clicker')),
      );
      expect(outcomes.filter((o) => o.kind === 'joined')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'already_member')).toHaveLength(19);
      expect(
        await count(sql`select uses as n from community_invitations where id = ${invitationId}`),
      ).toBe(1);
      await invariants();
    });

    it('fifty people for the last ten places: exactly ten join, forty are told it is exhausted', async () => {
      const { invitationId } = await h.link(h.person('admin-1', ['ADMIN']), communityId, {
        maxUses: 10,
      });
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, (_, i) => redeem(i, invitationId, `racer-${i}`)),
      );
      expect(outcomes.filter((o) => o.kind === 'joined')).toHaveLength(10);
      expect(outcomes.filter((o) => o.kind === 'exhausted')).toHaveLength(40);
      expect(
        await count(sql`select uses as n from community_invitations where id = ${invitationId}`),
      ).toBe(10);
      await invariants();
    });

    it('a revocation racing fifty redemptions: uses equal joins, and nobody joins after it', async () => {
      const { invitationId } = await h.link(h.person('admin-1', ['ADMIN']), communityId);
      const redemptions = Array.from({ length: 50 }, (_, i) =>
        redeem(i, invitationId, `racer-${i}`),
      );
      const revocation = store(99).revokeInvitation({
        communityId,
        invitationId,
        actor: owner(),
        revokedBy: 'admin-1',
        at: at(),
      });
      const [revoked, ...outcomes] = await Promise.all([revocation, ...redemptions]);
      expect(revoked?.kind).toBe('revoked');
      const joined = outcomes.filter((o) => o.kind === 'joined').length;
      expect(joined + outcomes.filter((o) => o.kind === 'revoked').length).toBe(50);
      expect(
        await count(sql`select uses as n from community_invitations where id = ${invitationId}`),
      ).toBe(joined);
      expect(
        await count(sql`select count(*)::int as n from community_members
                         where invitation_id = ${invitationId}`),
      ).toBe(joined);
      await invariants();
    });

    it('a lock racing redemptions and adds: nothing joins after the lock commits', async () => {
      const { invitationId } = await h.link(h.person('admin-1', ['ADMIN']), communityId);
      const redemptions = Array.from({ length: 30 }, (_, i) =>
        redeem(i, invitationId, `racer-${i}`),
      );
      const adds = Array.from({ length: 10 }, (_, i) =>
        store(i).addMembers({
          communityId,
          userIds: [`added-${i}-a`, `added-${i}-b`],
          actor: owner(),
          addedBy: 'admin-1',
          at: at(),
          newId: () => `added-stint-${i}-${Math.random().toString(36).slice(2)}`,
        }),
      );
      const lock = store(98).changeStatus({
        communityId,
        to: 'LOCKED',
        actor: owner(),
        actorUserId: 'admin-1',
        at: at(),
      });
      const [locked, ...outcomes] = await Promise.all([lock, ...redemptions, ...adds]);
      if (locked?.kind !== 'changed') throw new Error(`the lock did not change: ${locked?.kind}`);
      // The lock and every join serialize on the community row: the version
      // the lock saw is the last one ever allocated — nothing joined after it.
      expect(
        await count(sql`select membership_version as n from communities where id = ${communityId}`),
      ).toBe(locked.community.membershipVersion);
      // Whatever joined, joined before the lock: the lock's version bump is
      // the last write, and every refusal consumed nothing.
      const joined = outcomes.filter((o) => o.kind === 'joined').length;
      expect(
        await count(sql`select uses as n from community_invitations where id = ${invitationId}`),
      ).toBe(joined);
      const refusedAfterLock = outcomes.filter((o) => o.kind === 'locked').length;
      expect(joined + refusedAfterLock + outcomes.filter((o) => o.kind === 'added').length).toBe(
        40,
      );
      // A locked community accepts nobody now.
      expect((await redeem(0, invitationId, 'latecomer')).kind).toBe('locked');
      await invariants();
    });

    it('ten simultaneous locks: one change, one version, one audit entry, ten answers', async () => {
      const admin = h.person('admin-1', ['ADMIN']);
      h.journal.clear();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          h.status.execute({ principal: admin, communityId, to: 'LOCKED', meta: META }),
        ),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect(h.journal.actions()).toEqual(['communities.community.locked']);
      expect(
        await count(sql`select lifecycle_version as n from communities where id = ${communityId}`),
      ).toBe(2);
      // …and the same through separate processes.
      const direct = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store(i).changeStatus({
            communityId,
            to: 'OPEN',
            actor: owner(),
            actorUserId: 'admin-1',
            at: at(),
          }),
        ),
      );
      expect(direct.filter((outcome) => outcome.kind === 'changed')).toHaveLength(1);
      expect(
        await count(sql`select lifecycle_version as n from communities where id = ${communityId}`),
      ).toBe(3);
    });

    it('never deadlocks: overlapping adds, removals, redemptions, leaves, locks and unlocks', async () => {
      const { invitationId } = await h.link(h.person('admin-1', ['ADMIN']), communityId);
      const people = Array.from({ length: 24 }, (_, i) => `p-${String(i).padStart(2, '0')}`);
      // Everyone starts in; the storm then moves them in and out at once.
      await store(0).addMembers({
        communityId,
        userIds: people,
        actor: owner(),
        addedBy: 'admin-1',
        at: at(),
        newId: () => `seed-${Math.random().toString(36).slice(2)}`,
      });
      const work: Promise<{ kind: string }>[] = [];
      for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < people.length; i += 1) {
          const person = people[i] ?? '';
          const other = people[(i * 7 + round) % people.length] ?? '';
          const s = store(i + round);
          switch ((i + round) % 5) {
            case 0:
              // Overlapping batches, in opposite orders.
              work.push(
                s.addMembers({
                  communityId,
                  userIds: round % 2 === 0 ? [person, other] : [other, person],
                  actor: owner(),
                  addedBy: 'admin-1',
                  at: at(),
                  newId: () => `storm-${Math.random().toString(36).slice(2)}`,
                }),
              );
              break;
            case 1:
              work.push(
                s.removeMember({
                  communityId,
                  userId: other,
                  actor: owner(),
                  removedBy: 'admin-1',
                  at: at(),
                }),
              );
              break;
            case 2:
              work.push(s.leave({ communityId, userId: person, at: at() }));
              break;
            case 3:
              work.push(redeem(i, invitationId, person));
              break;
            default:
              work.push(
                s.changeStatus({
                  communityId,
                  to: round % 2 === 0 ? 'LOCKED' : 'OPEN',
                  actor: owner(),
                  actorUserId: 'admin-1',
                  at: at(),
                }),
              );
          }
        }
      }
      const outcomes = await Promise.all(work);
      expect(outcomes).toHaveLength(72);
      // Nothing gave up: a deadlock victim would have reported `conflict`.
      expect(outcomes.filter((outcome) => outcome.kind === 'conflict')).toEqual([]);
      await invariants();
    }, 60_000);

    it('changesSince never skips a version while writers commit — joins, leaves and removals', async () => {
      // Twenty already in: the storm ends some of their stints, raising those
      // rows' versions, while forty others join.
      const early = Array.from({ length: 20 }, (_, i) => `e-${i}`);
      await store(0).addMembers({
        communityId,
        userIds: early,
        actor: owner(),
        addedBy: 'admin-1',
        at: at(),
        newId: () => `early-${Math.random().toString(36).slice(2)}`,
      });
      const writers: Promise<{ kind: string }>[] = [
        ...Array.from({ length: 40 }, (_, i) =>
          store(i).addMembers({
            communityId,
            userIds: [`w-${i}`],
            actor: owner(),
            addedBy: 'admin-1',
            at: at(),
            newId: () => `feed-${i}-${Math.random().toString(36).slice(2)}`,
          }),
        ),
        ...early.map((userId, i) =>
          i % 2 === 0
            ? store(i).leave({ communityId, userId, at: at() })
            : store(i).removeMember({
                communityId,
                userId,
                actor: owner(),
                removedBy: 'admin-1',
                at: at(),
              }),
        ),
      ];
      // A reader follows the feed while the storm commits.
      const applied = new Map<string, boolean>();
      let after = 0;
      let done = false;
      const settle = Promise.all(writers).then(() => {
        done = true;
      });
      for (;;) {
        const page = await h.membership.changesSince(communityId, after, 5);
        for (const state of page?.states ?? []) applied.set(state.userId, state.active);
        after = page?.throughVersion ?? after;
        if (done && page?.hasMore === false) {
          const tail = await h.membership.changesSince(communityId, after, 1000);
          for (const state of tail?.states ?? []) applied.set(state.userId, state.active);
          break;
        }
      }
      await settle;
      const active = (
        await db.execute(sql`select user_id from community_members
                              where community_id = ${communityId} and status = 'ACTIVE'`)
      ).rows.map((row) => row.user_id as string);
      expect(
        [...applied.entries()]
          .filter(([, isActive]) => isActive)
          .map(([userId]) => userId)
          .sort(),
      ).toEqual(active.sort());
    });
  });

  describe('the use cases, on Postgres', () => {
    it('create, add, redeem, leave, remove and lock end as they do in memory', async () => {
      await reset();
      const h = postgresHarness();
      const admin = h.person('admin-1', ['ADMIN']);
      const id = await h.community(admin);
      for (const s of ['s1', 's2', 's3']) h.person(s, ['STUDENT']);
      await h.addPeople(admin, id, 's1');
      const { token } = await h.link(admin, id, { maxUses: 2 });
      const joined = await h.redeem.execute({
        principal: h.person('s2', ['STUDENT']),
        token,
        meta: META,
      });
      expect(joined).toMatchObject({ ok: true, value: { kind: 'joined' } });
      const again = await h.redeem.execute({
        principal: h.person('s2', ['STUDENT']),
        token,
        meta: META,
      });
      expect(again).toMatchObject({ ok: true, value: { kind: 'already_member' } });
      await h.leave.execute({
        principal: h.person('s2', ['STUDENT']),
        communityId: id,
        meta: META,
      });
      await h.remove.execute({ principal: admin, communityId: id, userId: 's1', meta: META });
      expect(
        await h.redeem.execute({ principal: h.person('s1', ['STUDENT']), token, meta: META }),
      ).toMatchObject({ ok: false, error: { code: 'communities.rejoin_requires_manager' } });
      await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META });
      expect(
        await h.redeem.execute({ principal: h.person('s3', ['STUDENT']), token, meta: META }),
      ).toMatchObject({ ok: false, error: { code: 'communities.community_locked' } });
      const view = await h.get.execute({ principal: admin, communityId: id, meta: META });
      expect(view).toMatchObject({
        ok: true,
        value: { memberCount: 1, status: 'LOCKED', lifecycleVersion: 2 },
      });
      expect(h.journal.actions()).toEqual([
        'communities.community.created',
        'communities.member.added',
        'communities.invitation.created',
        'communities.member.joined',
        'communities.member.left',
        'communities.member.removed',
        'communities.community.locked',
      ]);
    });
  });
});
