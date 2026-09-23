import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import { META, communitiesHarness, type CommunitiesHarness } from '../support/communities-harness';
import {
  describeWithPostgres,
  scratchDatabase,
  tolerateTeardown,
  type ScratchDatabase,
} from '../support/postgres';

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly Plans?: readonly PlanNode[];
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
}

/**
 * Membership at 30,000 and 100,000 (§9, §16): nothing depends on 30,000,
 * and no read slows with size or with history.
 *
 * The fixture is bulk-inserted: about 900,000 stint rows, most of them ended
 * stints (churn) that the ACTIVE-only partial indexes never carry. Account
 * ids are hashes, spread through the id space as production's uuids are, so
 * one community's members interleave with everyone else's — the planner sees
 * the distribution it will see in production. Every read path is pinned by
 * EXPLAIN on the statement the adapter actually sends (captured by a query
 * spy), never on a copy of it.
 */
describeWithPostgres('Communities at scale', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let db: Database;
  const statements: { query: string; params: unknown[] }[] = [];
  let h: CommunitiesHarness;
  let store: DrizzleCommunityRepository;
  let readModel: DrizzleCommunityReadModel;

  beforeAll(async () => {
    scratch = await scratchDatabase();
    pool = tolerateTeardown(new Pool({ connectionString: scratch.url, max: 4 }));
    db = drizzle(pool, {
      logger: {
        logQuery(query: string, params: unknown[]) {
          statements.push({ query, params });
        },
      },
    });
    await db.execute(sql`
      insert into communities (id, title, status, lifecycle_version, membership_version,
                               member_count, created_by, created_at, updated_at)
      values ('c-30k', 'ثلاثون ألفاً', 'OPEN', 1, 300000, 30000, md5('c-30k:1'), now(), now()),
             ('c-100k', 'مئة ألف', 'OPEN', 1, 600000, 100000, md5('c-100k:1'), now(), now()),
             ('c-30', 'ثلاثون', 'OPEN', 1, 30, 30, md5('c-30:1'), now(), now())`);
    // ACTIVE members: the owner first, joins one second apart.
    for (const [community, size] of [
      ['c-30k', 30_000],
      ['c-100k', 100_000],
      ['c-30', 30],
    ] as const) {
      await db.execute(sql`
        insert into community_members (id, community_id, user_id, status, standing, source,
                                       added_by, joined_at, version)
        select ${`${community}-m-`} || g, ${community}, md5(${`${community}:`} || g),
               'ACTIVE', case when g = 1 then 'OWNER' else 'MEMBER' end, 'ADDED',
               md5(${`${community}:1`}), now() - make_interval(secs => ${size} - g), g
          from generate_series(1, ${size}) g`);
    }
    // Churn: people who joined and left long ago — history the partial indexes never hold.
    for (const [community, churn, from] of [
      ['c-30k', 270_000, 30_000],
      ['c-100k', 500_000, 100_000],
    ] as const) {
      await db.execute(sql`
        insert into community_members (id, community_id, user_id, status, standing, source,
                                       added_by, joined_at, ended_at, ended_by, version)
        select ${`${community}-h-`} || g, ${community}, md5(${`gone-${community}:`} || g),
               'LEFT', 'MEMBER', 'ADDED', 'someone', now() - interval '400 days',
               now() - interval '300 days', md5(${`gone-${community}:`} || g), ${from} + g
          from generate_series(1, ${churn}) g`);
    }
    // One person in many small communities: "my communities".
    await db.execute(sql`
      insert into communities (id, title, status, lifecycle_version, membership_version,
                               member_count, created_by, created_at, updated_at)
      select 'small-' || g, 'حلقة ' || g, 'OPEN', 1, 1, 1, 'u-many',
             now() - make_interval(secs => g), now()
        from generate_series(1, 500) g`);
    await db.execute(sql`
      insert into community_members (id, community_id, user_id, status, standing, source,
                                     added_by, joined_at, version)
      select 'small-m-' || g, 'small-' || g, 'u-many', 'ACTIVE', 'OWNER', 'ADDED', 'u-many',
             now() - make_interval(secs => g), 1
        from generate_series(1, 500) g`);
    // Delegation in the 30,000: 2,000 members may remove, 1,000 of them also
    // moderate live sessions — and 20,000 grants of the past, ended, that the
    // ACTIVE-only grant indexes never carry.
    await db.execute(sql`
      insert into communities_capability_grants (id, community_id, membership_id, user_id,
                                                 capability, granted_by, granted_at)
      select 'g-remove-' || g, 'c-30k', 'c-30k-m-' || g, md5('c-30k:' || g),
             'community.members.remove', md5('c-30k:1'), now()
        from generate_series(2, 2001) g`);
    await db.execute(sql`
      insert into communities_capability_grants (id, community_id, membership_id, user_id,
                                                 capability, granted_by, granted_at)
      select 'g-live-' || g, 'c-30k', 'c-30k-m-' || g, md5('c-30k:' || g),
             'community.live.moderate', md5('c-30k:1'), now()
        from generate_series(2, 1001) g`);
    await db.execute(sql`
      insert into communities_capability_grants (id, community_id, membership_id, user_id,
                                                 capability, granted_by, granted_at, ended_at,
                                                 ended_by, end_reason)
      select 'g-ended-' || g, 'c-30k', 'c-30k-m-' || g, md5('c-30k:' || g),
             'community.lock', md5('c-30k:1'), now() - interval '90 days',
             now() - interval '30 days', md5('c-30k:1'), 'revoked'
        from generate_series(2, 20001) g`);
    await db.execute(sql`analyze communities`);
    await db.execute(sql`analyze community_members`);
    await db.execute(sql`analyze communities_capability_grants`);

    store = new DrizzleCommunityRepository(db);
    readModel = new DrizzleCommunityReadModel(db);
    h = communitiesHarness({ store, readModel });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(() => {
    statements.length = 0;
  });

  /** Members of a community in join order — the fixture's ids are hashes. */
  async function memberIds(communityId: string, from: number, count: number): Promise<string[]> {
    const rows = await pool.query<{ user_id: string }>(
      `select user_id from community_members
        where community_id = $1 and status = 'ACTIVE'
        order by version offset $2 limit $3`,
      [communityId, from, count],
    );
    return rows.rows.map((row) => row.user_id);
  }

  /** EXPLAIN every statement a call sent; return the nodes that touched our tables. */
  async function plansOf(call: () => Promise<unknown>): Promise<PlanNode[]> {
    statements.length = 0;
    await call();
    const sent = [...statements];
    expect(sent.length).toBeGreaterThan(0);
    const nodes: PlanNode[] = [];
    for (const { query, params } of sent) {
      const explained = await pool.query(`explain (format json) ${query}`, params);
      const plan = (explained.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0];
      if (plan !== undefined) walk(plan.Plan, (node) => nodes.push(node));
    }
    return nodes;
  }

  const seqScans = (nodes: readonly PlanNode[]) =>
    nodes.filter((node) => node['Node Type'] === 'Seq Scan').map((node) => node['Relation Name']);

  const indexes = (nodes: readonly PlanNode[]) =>
    new Set(nodes.map((node) => node['Index Name']).filter((name) => name !== undefined));

  it('holds the fixture it claims: 30,000 and 100,000 members, ~900,000 stints', async () => {
    const [row] = (
      await db.execute(sql`
        select (select count(*) from community_members)::int as stints,
               (select count(*) from community_members
                 where community_id = 'c-30k' and status = 'ACTIVE')::int as thirty,
               (select count(*) from community_members
                 where community_id = 'c-100k' and status = 'ACTIVE')::int as hundred`)
    ).rows;
    expect(row).toEqual({ stints: 900_530, thirty: 30_000, hundred: 100_000 });
    expect(
      (
        await db.execute(sql`
          select count(*) filter (where ended_at is null)::int as active,
                 count(*) filter (where ended_at is not null)::int as ended
            from communities_capability_grants`)
      ).rows[0],
    ).toEqual({ active: 3_000, ended: 20_000 });
  });

  it('authorizes a delegate with one more probe — on ACTIVE grants only', async () => {
    // The 500th member: a stint holding two ACTIVE grants and one ended one.
    const user = await pool.query<{ user_id: string }>(
      `select user_id from community_members where id = 'c-30k-m-500'`,
    );
    const userId = user.rows[0]?.user_id ?? '';
    const read = await store.authorityOf('c-30k', userId);
    expect(read.stint?.grants.map((grant) => grant.capability).sort()).toEqual([
      'community.live.moderate',
      'community.members.remove',
    ]);
    const nodes = await plansOf(() => store.authorityOf('c-30k', userId));
    expect(seqScans(nodes)).toEqual([]);
    const probe = nodes.find((node) => node['Relation Name'] === 'communities_capability_grants');
    expect(probe?.['Index Name']).toBe('communities_capability_grants_active_unique');
    expect(probe?.['Index Cond']).toMatch(/membership_id/u);
  });

  it('pages a capability’s holders on the ACTIVE-grant and one-owner indexes', async () => {
    const [middle] = (
      await pool.query<{ user_id: string }>(
        `select user_id from communities_capability_grants
          where community_id = 'c-30k' and capability = 'community.members.remove'
          order by user_id offset 1000 limit 1`,
      )
    ).rows;
    for (const afterUserId of [undefined, middle?.user_id]) {
      const nodes = await plansOf(() =>
        readModel.holderCandidates('c-30k', 'community.members.remove', {
          afterUserId,
          limit: 1001,
        }),
      );
      expect(seqScans(nodes)).toEqual([]);
      expect(indexes(nodes)).toContain('communities_capability_grants_active_by_community');
      expect(indexes(nodes)).toContain('community_members_owner_unique');
    }
    const first = await readModel.holderCandidates('c-30k', 'community.members.remove', {
      limit: 5000,
    });
    // Every grantee and the owner, once each — and nobody whose grant ended.
    expect(first).toHaveLength(2001);
    expect(new Set(first).size).toBe(2001);
  });

  it('lists the owner’s grant page on the ACTIVE-grant index, from the middle', async () => {
    const [middle] = (
      await pool.query<{ user_id: string }>(
        `select user_id from communities_capability_grants
          where community_id = 'c-30k' and ended_at is null
            and capability = 'community.members.remove'
          order by user_id offset 500 limit 1`,
      )
    ).rows;
    const nodes = await plansOf(() =>
      readModel.grants('c-30k', {
        after: { capability: 'community.members.remove', userId: middle?.user_id ?? '' },
        limit: 201,
      }),
    );
    expect(seqScans(nodes)).toEqual([]);
    expect(indexes(nodes)).toContain('communities_capability_grants_active_by_community');
  });

  it.each([['c-30k'], ['c-100k']])(
    'authorizes in %s with two index probes keyed by the community and the person',
    async (community) => {
      const [user] = await memberIds(community, 15_000, 1);
      const nodes = await plansOf(() => store.authorityOf(community, user ?? ''));
      expect(seqScans(nodes)).toEqual([]);
      expect(indexes(nodes)).toContain('communities_pkey');
      // Either index keyed by (community, person) is one bounded probe; the
      // planner picks by how many other communities the person is in.
      const probe = nodes.find((node) => node['Relation Name'] === 'community_members');
      expect(['community_members_current_unique', 'community_members_user_idx']).toContain(
        probe?.['Index Name'],
      );
      expect(probe?.['Index Cond']).toMatch(/user_id/u);
      expect(probe?.['Index Cond']).toMatch(/community_id/u);
    },
  );

  it('pages the roster from the middle of 30,000 on the roster index', async () => {
    const [middle] = await readModel.latestStints('c-30k', await memberIds('c-30k', 15_000, 1));
    const nodes = await plansOf(() =>
      readModel.roster('c-30k', {
        after: { at: middle?.joinedAt ?? new Date(), id: middle?.userId ?? '' },
        limit: 201,
      }),
    );
    expect(seqScans(nodes)).toEqual([]);
    expect(indexes(nodes)).toContain('community_members_roster_idx');
  });

  it('answers statesOf for 1,000 people without scanning 300,000 rows', async () => {
    const ids = await memberIds('c-30k', 5_000, 1000);
    const nodes = await plansOf(() => h.membership.statesOf('c-30k', ids));
    expect(seqScans(nodes)).toEqual([]);
    expect([...indexes(nodes)].some((name) => (name ?? '').startsWith('community_members_'))).toBe(
      true,
    );
  });

  it('walks 30,000 members in exactly 30 pages, each once, on the ACTIVE-only index', async () => {
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { userIds: readonly string[]; nextCursor: string | null } =
        await h.membership.members('c-30k', { cursor, limit: 1000 });
      walked.push(...page.userIds);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(30);
    // Each member exactly once: 30,000 returned, 30,000 distinct.
    expect(walked).toHaveLength(30_000);
    expect(new Set(walked).size).toBe(30_000);

    const [first] = await memberIds('c-30k', 0, 1);
    for (const pageCursor of [null, first ?? null]) {
      const nodes = await plansOf(() =>
        h.membership.members('c-30k', {
          cursor:
            pageCursor === null ? null : Buffer.from(`m1:${pageCursor}`).toString('base64url'),
          limit: 1000,
        }),
      );
      expect(seqScans(nodes)).toEqual([]);
      expect(indexes(nodes)).toContain('community_members_current_unique');
    }
  });

  it('lists my communities on the per-person index', async () => {
    const nodes = await plansOf(() => readModel.myCommunities('u-many', { limit: 31 }));
    expect(seqScans(nodes)).toEqual([]);
    expect(indexes(nodes)).toContain('community_members_user_idx');
  });

  it('follows the changefeed of 100,000 on the version index', async () => {
    const nodes = await plansOf(() => h.membership.changesSince('c-100k', 590_000, 1000));
    expect(seqScans(nodes)).toEqual([]);
    expect(indexes(nodes)).toContain('community_members_version_unique');
  });

  it('never counts in a request path, and sends a fixed number of statements per page', async () => {
    const [ownerId] = await memberIds('c-30k', 0, 1);
    const owner = h.person(ownerId ?? '', ['ADMIN']);
    let cursor: string | undefined;
    const perPage: number[] = [];
    const describeCalls = h.accounts.describeCalls;
    for (let page = 0; page < 3; page += 1) {
      statements.length = 0;
      const result = await h.members.execute({
        principal: owner,
        communityId: 'c-30k',
        cursor,
        limit: 200,
        meta: META,
      });
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.items).toHaveLength(200);
      perPage.push(statements.length);
      expect(statements.some(({ query }) => /count\s*\(/iu.test(query))).toBe(false);
      cursor = result.value.nextCursor ?? undefined;
    }
    // The permit, then the page: two statements, whatever the page.
    expect(perPage).toEqual([2, 2, 2]);
    // And one directory call per page — never one per row.
    expect(h.accounts.describeCalls - describeCalls).toBe(3);

    const many = h.person('u-many', ['ADMIN']);
    statements.length = 0;
    const mine = await h.list.execute({ principal: many, scope: 'mine', limit: 100, meta: META });
    expect(mine.ok && mine.value.items.length).toBe(100);
    expect(statements).toHaveLength(1);
    expect(statements.some(({ query }) => /count\s*\(/iu.test(query))).toBe(false);
  });

  it('authorizes as fast at 30,000 members as at 30', async () => {
    const time = async (community: string, users: readonly string[]) => {
      const samples: number[] = [];
      for (let i = 0; i < 300; i += 1) {
        const started = process.hrtime.bigint();
        await store.authorityOf(community, users[i % users.length] ?? '');
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      return p99(samples.slice(50)); // after warm-up
    };
    const small = await time('c-30', await memberIds('c-30', 0, 30));
    const large = await time('c-30k', await memberIds('c-30k', 0, 30_000));
    // Two index probes either way; the tolerance absorbs a shared test machine.
    expect(large).toBeLessThan(Math.max(small * 5, small + 10));
  });
});
