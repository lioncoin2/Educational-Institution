import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import { COMMUNITY_CAPABILITIES } from '../../src/modules/communities/contracts/capabilities';
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
    await db.execute(
      sql`truncate communities_capability_grants, community_members, community_invitations, communities`,
    );
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
           and conrelid::regclass::text in ('communities', 'community_members',
                                            'community_invitations', 'communities_capability_grants')
         order by 1, 2`);
      expect(keys.rows).toEqual([
        { source: 'communities_capability_grants', target: 'community_members' },
        { source: 'community_invitations', target: 'communities' },
        { source: 'community_members', target: 'communities' },
        { source: 'community_members', target: 'community_invitations' },
      ]);
    });

    describe('grants (P3)', () => {
      let memberStint: string;

      beforeEach(async () => {
        const admin = h.person('admin-1', ['ADMIN']);
        h.person('teacher-1', ['TEACHER']);
        await h.addPeople(admin, communityId, 'teacher-1');
        memberStint = (await h.store.authorityOf(communityId, 'teacher-1')).stint?.id ?? '';
      });

      const grantRow = (id: string, fields: string) =>
        sql.raw(`insert into communities_capability_grants (id, community_id, membership_id,
                   user_id, capability, granted_by, granted_at, ended_at, ended_by, end_reason)
                 values ('${id}', ${fields})`);

      it('binds a grant to its stint’s own community and person (the composite key)', async () => {
        const other = await h.community(h.person('admin-1', ['ADMIN']), 'أخرى');
        for (const fields of [
          // the stint of another community
          `'${other}', '${memberStint}', 'teacher-1', 'community.lock', 'admin-1', now(), null, null, null`,
          // someone else's stint
          `'${communityId}', '${memberStint}', 'admin-1', 'community.lock', 'x', now(), null, null, null`,
          // no stint at all
          `'${communityId}', 'no-such-stint', 'teacher-1', 'community.lock', 'admin-1', now(), null, null, null`,
        ]) {
          expect(await violated(grantRow(`bad-${fields.length}`, fields))).toBe(
            'communities_capability_grants_stint_fk',
          );
        }
      });

      it('keeps every grant row consistent with itself', async () => {
        const row = (rest: string) => `'${communityId}', '${memberStint}', 'teacher-1', ${rest}`;
        const cases: [string, string][] = [
          [
            row(`'community.lock', 'teacher-1', now(), null, null, null`),
            'communities_capability_grants_not_self',
          ],
          [
            row(`'community.attendance.record', 'admin-1', now(), null, null, null`),
            'communities_capability_grants_capability_valid',
          ],
          [
            row(`'community.lock', 'admin-1', now(), null, 'admin-1', null`),
            'communities_capability_grants_ended_by_needs_end',
          ],
          [
            row(`'community.lock', 'admin-1', now(), now() - interval '1 second', null, 'revoked'`),
            'communities_capability_grants_ended_after_granted',
          ],
          [
            row(`'community.lock', 'admin-1', now(), now(), null, 'expired'`),
            'communities_capability_grants_end_reason_valid',
          ],
          [
            row(`'community.lock', 'admin-1', now(), now(), null, null`),
            'communities_capability_grants_end_consistent',
          ],
          [
            row(`'community.lock', 'admin-1', now(), null, null, 'revoked'`),
            'communities_capability_grants_end_consistent',
          ],
        ];
        for (const [fields, constraint] of cases) {
          expect(await violated(grantRow(`bad-${constraint}-${fields.length}`, fields))).toBe(
            constraint,
          );
        }
      });

      it('allows one ACTIVE grant per stint and capability — and any number of ended ones', async () => {
        const fields = (end: string) =>
          `'${communityId}', '${memberStint}', 'teacher-1', 'community.lock', 'admin-1', now(), ${end}`;
        await db.execute(grantRow('ended-1', fields(`now(), 'admin-1', 'revoked'`)));
        await db.execute(grantRow('ended-2', fields(`now(), 'admin-1', 'revoked'`)));
        await db.execute(grantRow('active-1', fields('null, null, null')));
        expect(await violated(grantRow('active-2', fields('null, null, null')))).toBe(
          'communities_capability_grants_active_unique',
        );
        // A stint with grants is history: it cannot be deleted from under them.
        expect(await violated(sql`delete from community_members where id = ${memberStint}`)).toBe(
          'communities_capability_grants_stint_fk',
        );
      });

      it('lists in its capability CHECK exactly the delegable vocabulary', async () => {
        const [check] = (
          await db.execute(sql`
            select pg_get_constraintdef(oid) as definition from pg_constraint
             where conname = 'communities_capability_grants_capability_valid'`)
        ).rows as { definition: string }[];
        const listed = [...(check?.definition ?? '').matchAll(/'([a-z_.]+)'::text/gu)].map(
          (match) => match[1],
        );
        expect(listed).toEqual([...COMMUNITY_CAPABILITIES]);
      });
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
        creatorCapability: 'community.members.invite',
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
                  removerCeilings: new Set(),
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
                removerCeilings: new Set(),
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

  describe('delegation races (P3)', () => {
    let stores: DrizzleCommunityRepository[];
    let h: CommunitiesHarness;
    let communityId: string;
    let ownerStintId: string;

    afterEach(() => {
      expect(
        [...stores, h.store as DrizzleCommunityRepository].map((each) => each.deadlockRetries),
      ).toEqual(new Array(stores.length + 1).fill(0));
    });

    beforeEach(async () => {
      await reset();
      stores = Array.from({ length: 4 }, () => new DrizzleCommunityRepository(db));
      h = postgresHarness();
      communityId = await h.community(h.person('admin-1', ['ADMIN']));
      ownerStintId = (await h.store.authorityOf(communityId, 'admin-1')).stint?.id ?? '';
    });

    const admin = () => h.person('admin-1', ['ADMIN']);
    const owner = () => ({ userId: 'admin-1', membershipId: ownerStintId });
    const store = (i: number) => stores[i % stores.length];
    const at = () => h.clock.now();
    const stintOf = async (userId: string) =>
      (await h.store.authorityOf(communityId, userId)).stint?.id ?? '';
    const members = async (...userIds: string[]) => {
      for (const userId of userIds) h.person(userId, ['TEACHER']);
      await h.addPeople(admin(), communityId, ...userIds);
    };
    const delegateOf = async (userId: string, grantId: string) => ({
      kind: 'grant' as const,
      userId,
      membershipId: await stintOf(userId),
      grantId,
      capability: 'community.members.remove' as const,
    });

    /** No ACTIVE grant ever rests on an ended stint; exactly one ACTIVE owner. */
    const invariants = async () => {
      expect(
        await count(sql`select count(*)::int as n
                          from communities_capability_grants g
                          join community_members m on m.id = g.membership_id
                         where g.ended_at is null and m.status <> 'ACTIVE'`),
      ).toBe(0);
      expect(
        await count(sql`select count(*)::int as n from community_members
                         where community_id = ${communityId} and standing = 'OWNER'
                           and status = 'ACTIVE'`),
      ).toBe(1);
    };

    it('fifty identical grants: one row, one audit entry, one event', async () => {
      await members('teacher-1');
      h.journal.clear();
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          h.grant.execute({
            principal: admin(),
            communityId,
            userId: 'teacher-1',
            capabilities: ['community.lock'],
            meta: META,
          }),
        ),
      );
      expect(results.filter((r) => r.ok && r.value.anyCreated)).toHaveLength(1);
      expect(results.filter((r) => r.ok && !r.value.anyCreated)).toHaveLength(49);
      expect(await count(sql`select count(*)::int as n from communities_capability_grants`)).toBe(
        1,
      );
      expect(h.journal.actions()).toEqual(['communities.capability.granted']);
      expect(h.journal.eventNames()).toEqual(['communities.capability.granted']);
    });

    it('overlapping batches named in opposite orders never deadlock, and never double up', async () => {
      await members('teacher-1');
      const batches = [
        ['community.lock', 'community.members.view', 'community.members.remove'],
        ['community.members.remove', 'community.members.view', 'community.lock'],
      ] as const;
      const outcomes = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          store(i).grant({
            communityId,
            owner: owner(),
            granteeUserId: 'teacher-1',
            capabilities: batches[i % 2] ?? [],
            at: at(),
            newId: () => `grant-${i}-${Math.random().toString(36).slice(2)}`,
          }),
        ),
      );
      expect(outcomes.every((o) => o.kind === 'granted')).toBe(true);
      const created = outcomes.flatMap((o) => (o.kind === 'granted' ? o.created : []));
      expect(created).toHaveLength(3);
      expect(
        await count(sql`select count(*)::int as n from communities_capability_grants
                         where ended_at is null`),
      ).toBe(3);
    });

    it('a grant racing the grantee’s removal: refused, or granted and ended with the stint', async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `grantee-${i}`);
      await members(...ids);
      const outcomes = await Promise.all(
        ids.map(async (userId, i) => {
          const [granted, removed] = await Promise.all([
            store(i).grant({
              communityId,
              owner: owner(),
              granteeUserId: userId,
              capabilities: ['community.lock', 'community.chat.post'],
              at: at(),
              newId: () => `g-${userId}-${Math.random().toString(36).slice(2)}`,
            }),
            store(i + 1).removeMember({
              communityId,
              userId,
              actor: { kind: 'oversight' },
              removerCeilings: new Set(),
              removedBy: 'overseer',
              at: at(),
            }),
          ]);
          return { granted, removed };
        }),
      );
      for (const { granted, removed } of outcomes) {
        expect(removed.kind).toBe('removed');
        if (granted.kind === 'granted' && removed.kind === 'removed') {
          // Granted first: the removal found the grants and ended them with the stint.
          expect(removed.endedGrants.map((g) => g.id).sort()).toEqual(
            granted.created.map((g) => g.id).sort(),
          );
        } else {
          expect(granted).toEqual({ kind: 'grantee_ineligible' });
        }
      }
      await invariants();
    });

    it('a delegate’s removal racing the revocation of their grant: the act commits first, or is refused', async () => {
      const targets = Array.from({ length: 10 }, (_, i) => `target-${i}`);
      await members('delegate', ...targets);
      for (const [i, target] of targets.entries()) {
        const [grantId] = await h.delegate(
          admin(),
          communityId,
          'delegate',
          'community.members.remove',
        );
        const actor = await delegateOf('delegate', grantId ?? '');
        const [removal, revocation] = await Promise.all([
          store(i).removeMember({
            communityId,
            userId: target,
            actor,
            removerCeilings: new Set(['community.members.remove']),
            removedBy: 'delegate',
            at: at(),
          }),
          store(i + 1).revokeGrant({
            communityId,
            grantId: grantId ?? '',
            owner: owner(),
            at: at(),
          }),
        ]);
        // The revocation always happens; the removal either won the race or found its basis gone.
        expect(revocation.kind).toBe('revoked');
        expect(['removed', 'basis_lost']).toContain(removal.kind);
        const [state] = await h.membership.statesOf(communityId, [target]);
        expect(state?.active).toBe(removal.kind !== 'removed');
      }
      await invariants();
    });

    it('two delegates removing each other: never both', async () => {
      for (let round = 0; round < 8; round += 1) {
        const [a, b] = [`peer-a-${round}`, `peer-b-${round}`];
        await members(a, b);
        const [grantA] = await h.delegate(admin(), communityId, a, 'community.members.remove');
        const [grantB] = await h.delegate(admin(), communityId, b, 'community.members.remove');
        const ceilings = new Set(['community.members.remove'] as const);
        const [first, second] = await Promise.all([
          store(round).removeMember({
            communityId,
            userId: b,
            actor: await delegateOf(a, grantA ?? ''),
            removerCeilings: ceilings,
            removedBy: a,
            at: at(),
          }),
          store(round + 1).removeMember({
            communityId,
            userId: a,
            actor: await delegateOf(b, grantB ?? ''),
            removerCeilings: ceilings,
            removedBy: b,
            at: at(),
          }),
        ]);
        expect([first.kind, second.kind].sort()).toEqual(['basis_lost', 'removed']);
        const states = await h.membership.statesOf(communityId, [a, b]);
        expect(states.filter((state) => state.active)).toHaveLength(1);
      }
      await invariants();
    });

    it('a transfer racing its target’s removal: one owner, and the loser is told', async () => {
      const heirs = Array.from({ length: 8 }, (_, round) => `heir-${round}`);
      await members(...heirs); // while the admin still owns the community
      const outcomes: string[] = [];
      for (const [round, target] of heirs.entries()) {
        const current = (
          await db.execute(sql`select id, user_id from community_members
                                where community_id = ${communityId} and standing = 'OWNER'`)
        ).rows[0] as { id: string; user_id: string };
        const [moved, removed] = await Promise.all([
          store(round).transfer({
            communityId,
            toUserId: target,
            actor: { kind: 'owner', userId: current.user_id, membershipId: current.id },
            transferredBy: current.user_id,
            at: at(),
          }),
          store(round + 1).removeMember({
            communityId,
            userId: target,
            actor: { kind: 'oversight' },
            removerCeilings: new Set(),
            removedBy: 'overseer',
            at: at(),
          }),
        ]);
        outcomes.push(moved.kind);
        if (moved.kind === 'transferred') {
          expect(removed).toEqual({ kind: 'owner' });
        } else {
          expect(removed.kind).toBe('removed');
          expect(['owner_conflict', 'target_not_member']).toContain(moved.kind);
        }
        await invariants();
      }
      // Whichever won each round, the answers were only ever these.
      expect(
        outcomes.every((kind) =>
          ['transferred', 'owner_conflict', 'target_not_member'].includes(kind),
        ),
      ).toBe(true);
    });

    it('two transfers at once: exactly one owner, and the loser gets owner_conflict', async () => {
      const rounds = Array.from({ length: 8 }, (_, round) => [
        `candidate-a-${round}`,
        `candidate-b-${round}`,
      ]);
      await members(...rounds.flat()); // while the admin still owns the community
      for (const [round, [a, b]] of rounds.entries()) {
        const outcomes = await Promise.all(
          [a, b].map((toUserId, i) =>
            store(round + i).transfer({
              communityId,
              toUserId,
              actor: { kind: 'oversight' },
              transferredBy: 'overseer',
              at: at(),
            }),
          ),
        );
        expect(outcomes.map((o) => o.kind).sort()).toEqual(['owner_conflict', 'transferred']);
        await invariants();
      }
    });

    it('pages the holders of a capability exactly once while grants churn around them', async () => {
      const stable = Array.from({ length: 30 }, (_, i) => `stable-${String(i).padStart(2, '0')}`);
      const churners = Array.from({ length: 10 }, (_, i) => `churn-${i}`);
      await members(...stable, ...churners);
      for (const userId of stable) {
        await h.delegate(admin(), communityId, userId, 'community.live.moderate');
      }
      let churning = true;
      const churn = (async () => {
        for (let i = 0; churning; i += 1) {
          const userId = churners[i % churners.length] ?? '';
          const outcome = await store(i).grant({
            communityId,
            owner: owner(),
            granteeUserId: userId,
            capabilities: ['community.live.moderate'],
            at: at(),
            newId: () => `churn-${i}-${Math.random().toString(36).slice(2)}`,
          });
          if (outcome.kind === 'granted') {
            for (const grant of outcome.created) {
              await store(i + 1).revokeGrant({
                communityId,
                grantId: grant.id,
                owner: owner(),
                at: at(),
              });
            }
          }
        }
      })();
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { userIds: readonly string[]; nextCursor: string | null } =
          await h.holders.list(communityId, 'community.live.moderate', { cursor, limit: 3 });
        seen.push(...page.userIds);
        cursor = page.nextCursor;
      } while (cursor !== null);
      churning = false;
      await churn;
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.filter((userId) => !userId.startsWith('churn-'))).toEqual(['admin-1', ...stable]);
      await invariants();
    });
  });

  /**
   * The locks delegation rests on, pinned deterministically. A raw
   * transaction holds the community row, so a transaction that reaches step
   * 5 of the lock order parks there, still holding every lock it took
   * before; the other side then either waits on one of those locks — seen in
   * pg_stat_activity — or does not. Racing both and accepting either outcome
   * would pass with the lock deleted; these do not.
   */
  describe('the locks delegation rests on (deterministic interleavings)', () => {
    let stores: DrizzleCommunityRepository[];
    let h: CommunitiesHarness;
    let communityId: string;
    let ownerStintId: string;

    beforeEach(async () => {
      await reset();
      stores = [new DrizzleCommunityRepository(db), new DrizzleCommunityRepository(db)];
      h = postgresHarness();
      communityId = await h.community(h.person('admin-1', ['ADMIN']));
      ownerStintId = (await h.store.authorityOf(communityId, 'admin-1')).stint?.id ?? '';
      for (const userId of ['delegate', 'member', 'grantee']) h.person(userId, ['TEACHER']);
      await h.addPeople(admin(), communityId, 'delegate', 'member', 'grantee');
    });

    const admin = () => h.person('admin-1', ['ADMIN']);
    const owner = () => ({ userId: 'admin-1', membershipId: ownerStintId });
    const store = (i: number) => stores[i];
    const at = () => h.clock.now();

    /**
     * Runs `scenario` while a raw transaction holds `statement`'s rows, and
     * always ends that transaction afterwards — so a failing scenario never
     * leaves a lock behind for the rest of the suite.
     */
    const whileHolding = async (
      statement: string,
      params: unknown[],
      scenario: (release: () => Promise<void>) => Promise<void>,
    ): Promise<void> => {
      const client = await pool.connect();
      let open = true;
      const release = async () => {
        if (!open) return;
        open = false;
        await client.query('rollback');
      };
      try {
        await client.query('begin');
        await client.query(statement, params);
        await scenario(release);
      } finally {
        await release();
        client.release();
      }
    };

    /** A transaction that reaches step 5 parks here, still holding every lock it took before. */
    const communityRow = 'select id from communities where id = $1 for update';

    /** Resolves once at least `n` backends of this database wait on a lock; throws after 5 s. */
    const lockWaiters = async (n: number): Promise<void> => {
      for (let i = 0; i < 500; i += 1) {
        const waiting = await count(sql`select count(*)::int as n from pg_stat_activity
                                         where datname = current_database()
                                           and wait_event_type = 'Lock'`);
        if (waiting >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`fewer than ${n} backends ever waited on a lock`);
    };

    const settled = (promise: Promise<unknown>): (() => boolean) => {
      let done = false;
      promise.then(
        () => (done = true),
        () => (done = true),
      );
      return () => done;
    };

    it('a revocation waits for the delegate act resting on the grant — the act commits first', async () => {
      const [grantId] = await h.delegate(
        admin(),
        communityId,
        'delegate',
        'community.members.remove',
      );
      const delegateStint = (await h.store.authorityOf(communityId, 'delegate')).stint?.id ?? '';
      let removal: ReturnType<DrizzleCommunityRepository['removeMember']> | undefined;
      let revocation: ReturnType<DrizzleCommunityRepository['revokeGrant']> | undefined;
      await whileHolding(communityRow, [communityId], async (release) => {
        removal = store(0).removeMember({
          communityId,
          userId: 'member',
          actor: {
            kind: 'grant',
            userId: 'delegate',
            membershipId: delegateStint,
            grantId: grantId ?? '',
            capability: 'community.members.remove',
          },
          removerCeilings: new Set(['community.members.remove']),
          removedBy: 'delegate',
          at: at(),
        });
        await lockWaiters(1); // the removal, parked at the community row with its grant held
        revocation = store(1).revokeGrant({
          communityId,
          grantId: grantId ?? '',
          owner: owner(),
          at: at(),
        });
        const revoked = settled(revocation);
        await lockWaiters(2); // the revocation, waiting on the grant the removal holds
        expect(revoked()).toBe(false);
        await release();
      });
      expect((await removal)?.kind).toBe('removed');
      expect((await revocation)?.kind).toBe('revoked');
    });

    it('a grant waits for its grantee’s removal — and is refused, never left on an ended stint', async () => {
      let removal: ReturnType<DrizzleCommunityRepository['removeMember']> | undefined;
      let granting: ReturnType<DrizzleCommunityRepository['grant']> | undefined;
      await whileHolding(communityRow, [communityId], async (release) => {
        removal = store(0).removeMember({
          communityId,
          userId: 'grantee',
          actor: { kind: 'oversight' },
          removerCeilings: new Set(),
          removedBy: 'overseer',
          at: at(),
        });
        await lockWaiters(1); // the removal, parked with the grantee's stint FOR UPDATE
        granting = store(1).grant({
          communityId,
          owner: owner(),
          granteeUserId: 'grantee',
          capabilities: ['community.lock'],
          at: at(),
          newId: () => 'g-racing-the-removal',
        });
        await lockWaiters(2);
        await release();
      });
      expect((await removal)?.kind).toBe('removed');
      expect(await granting).toEqual({ kind: 'grantee_ineligible' });
      expect(await count(sql`select count(*)::int as n from communities_capability_grants`)).toBe(
        0,
      );
    });

    it('a revocation of a link creator’s grant waits for the redemption resting on it', async () => {
      const [inviteGrant] = await h.delegate(
        admin(),
        communityId,
        'delegate',
        'community.members.invite',
      );
      const { invitationId } = await h.link(h.person('delegate', ['TEACHER']), communityId);
      let redemption: ReturnType<DrizzleCommunityRepository['redeem']> | undefined;
      let revocation: ReturnType<DrizzleCommunityRepository['revokeGrant']> | undefined;
      await whileHolding(communityRow, [communityId], async (release) => {
        redemption = store(0).redeem({
          invitationId,
          communityId,
          userId: 'joiner',
          creatorUserId: 'delegate',
          creatorCapability: 'community.members.invite',
          stintId: 'stint-joiner',
          at: at(),
        });
        await lockWaiters(1); // the redemption, parked with the creator's grant held
        revocation = store(1).revokeGrant({
          communityId,
          grantId: inviteGrant ?? '',
          owner: owner(),
          at: at(),
        });
        const revoked = settled(revocation);
        await lockWaiters(2);
        expect(revoked()).toBe(false);
        await release();
      });
      expect((await redemption)?.kind).toBe('joined');
      expect((await revocation)?.kind).toBe('revoked');
    });

    it('a revocation waits for a grant that found the capability held — "unchanged" holds at commit', async () => {
      const [lockGrant] = await h.delegate(admin(), communityId, 'grantee', 'community.lock');
      const granteeStint = (await h.store.authorityOf(communityId, 'grantee')).stint?.id ?? '';
      let granting: ReturnType<DrizzleCommunityRepository['grant']> | undefined;
      let revocation: ReturnType<DrizzleCommunityRepository['revokeGrant']> | undefined;
      // An identical grant of members.view, in flight and uncommitted: the
      // batch below parks at its insert, after locking the grant it found held.
      await whileHolding(
        `insert into communities_capability_grants (id, community_id, membership_id, user_id,
                                                    capability, granted_by, granted_at)
         values ('g-in-flight', $1, $2, 'grantee', 'community.members.view', 'admin-1', now())`,
        [communityId, granteeStint],
        async (release) => {
          granting = store(0).grant({
            communityId,
            owner: owner(),
            granteeUserId: 'grantee',
            capabilities: ['community.lock', 'community.members.view'],
            at: at(),
            newId: () => 'g-second',
          });
          await lockWaiters(1); // the batch, waiting on the in-flight row
          revocation = store(1).revokeGrant({
            communityId,
            grantId: lockGrant ?? '',
            owner: owner(),
            at: at(),
          });
          const revoked = settled(revocation);
          await lockWaiters(2); // the revocation, waiting on the grant the batch found held
          expect(revoked()).toBe(false);
          await release(); // the in-flight grant rolls back
        },
      );
      const outcome = await granting;
      if (outcome?.kind !== 'granted') throw new Error(outcome?.kind);
      expect(outcome.created.map((grant) => grant.capability)).toEqual(['community.members.view']);
      expect(outcome.unchanged.map((grant) => grant.id)).toEqual([lockGrant]);
      expect((await revocation)?.kind).toBe('revoked');
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

    it('grant, act, go dormant, revoke and transfer end as they do in memory', async () => {
      await reset();
      const h = postgresHarness();
      const admin = h.person('admin-1', ['ADMIN']);
      const teacher = h.person('teacher-1', ['TEACHER']);
      h.person('teacher-2', ['TEACHER']);
      const id = await h.community(admin);
      await h.addPeople(admin, id, 'teacher-1', 'teacher-2');
      const [lockGrant] = await h.delegate(admin, id, 'teacher-1', 'community.lock');
      await h.delegate(admin, id, 'teacher-2', 'community.members.view');

      const locked = await h.status.execute({
        principal: teacher,
        communityId: id,
        to: 'LOCKED',
        meta: META,
      });
      expect(locked).toMatchObject({
        ok: true,
        value: { status: 'LOCKED', me: { capabilities: ['community.lock'] } },
      });
      const mine = await h.list.execute({ principal: teacher, scope: 'mine', meta: META });
      expect(mine).toMatchObject({
        ok: true,
        value: { items: [{ me: { capabilities: ['community.lock'] } }] },
      });

      h.accounts.setRoles('teacher-2', ['STUDENT']);
      const listed = await h.grants.execute({ principal: admin, communityId: id, meta: META });
      expect(listed.ok && listed.value.items.map((g) => [g.userId, g.dormant])).toEqual([
        ['teacher-1', false],
        ['teacher-2', true],
      ]);
      await h.revokeGrant.execute({
        principal: admin,
        communityId: id,
        grantId: lockGrant ?? '',
        meta: META,
      });
      const unlocked = await h.status.execute({
        principal: teacher,
        communityId: id,
        to: 'OPEN',
        meta: META,
      });
      expect(unlocked).toMatchObject({
        ok: false,
        error: { code: 'communities.capability_required' },
      });

      const moved = await h.transfer.execute({
        principal: admin,
        communityId: id,
        userId: 'teacher-1',
        meta: META,
      });
      expect(moved).toMatchObject({ ok: true, value: { me: { standing: 'MEMBER' } } });
      expect(h.journal.actions()).toEqual([
        'communities.community.created',
        'communities.member.added',
        'communities.member.added',
        'communities.capability.granted',
        'communities.capability.granted',
        'communities.community.locked',
        'communities.capability.revoked',
        'communities.ownership.transferred',
      ]);
    });
  });
});
