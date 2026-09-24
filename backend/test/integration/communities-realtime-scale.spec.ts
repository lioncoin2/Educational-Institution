import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import type { DomainEvent, Principal } from '../../src/shared';
import { CommunityEvents } from '../../src/modules/communities/contracts/events';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import type { UserId } from '../../src/modules/identity/domain/user';
import { DrizzleUserRepository } from '../../src/modules/identity/infrastructure/drizzle-user-repository';
import { META, communitiesHarness, type CommunitiesHarness } from '../support/communities-harness';
import { expectOk } from '../support/identity-harness';
import {
  describeWithPostgres,
  scratchDatabase,
  tolerateTeardown,
  type ScratchDatabase,
} from '../support/postgres';
import {
  communitiesRealtimeHarness,
  type CommunitiesRealtimeHarness,
  type FakeLink,
} from '../support/realtime-harness';

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Actual Loops'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly 'Rows Removed by Index Recheck'?: number;
  readonly Plans?: readonly PlanNode[];
}

/** The rows a node read, as EXPLAIN ANALYZE counts them: those it kept and those it threw away. */
const examined = (node: PlanNode) =>
  ((node['Actual Rows'] ?? 0) +
    (node['Rows Removed by Filter'] ?? 0) +
    (node['Rows Removed by Index Recheck'] ?? 0)) *
  (node['Actual Loops'] ?? 1);

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/**
 * A lock in a community of 30,000, told to the members connected here
 * (communities-live-attendance.md §16.1; ADR 0021 decision 7): measured on
 * Postgres, not assumed. The community holds 30,000 ACTIVE members and
 * 100,000 who left; half of its members also belong to another community of
 * 30,000, and 2,000 small communities fill the rest of the table — so the
 * planner sees production's shapes. Account ids are hashes, spread through
 * the id space as uuids are.
 *
 * The relay is asked by hand, alone, with a real ConnectionManager holding
 * the accounts online; every statement it sends is captured by a query spy
 * and EXPLAINed as sent.
 */
describeWithPostgres('community lock frames at 30,000 members', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let db: Database;
  const statements: { query: string; params: unknown[] }[] = [];
  let c: CommunitiesHarness;
  let h: CommunitiesRealtimeHarness;
  let owner: Principal;

  const member = (community: string, g: number) => md5(`${community}:${g}`);

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
      values ('c-30k', 'ثلاثون ألفاً', 'OPEN', 1, 130000, 30000, ${member('c-30k', 1)}, now(), now()),
             ('c-other', 'أخرى', 'OPEN', 1, 30000, 30000, ${member('c-30k', 15001)}, now(), now()),
             ('c-30', 'ثلاثون', 'OPEN', 1, 30, 30, ${member('c-30', 1)}, now(), now())`);
    await db.execute(sql`
      insert into communities (id, title, status, lifecycle_version, membership_version,
                               member_count, created_by, created_at, updated_at)
      select 'small-' || g, 'حلقة ' || g, 'OPEN', 1, 3, 3, md5('small:' || g || ':1'),
             now() - make_interval(secs => g), now()
        from generate_series(1, 2000) g`);
    // ACTIVE members: the owner first. c-other holds the second half of
    // c-30k's members and 15,000 of its own.
    for (const [community, from, size] of [
      ['c-30k', 1, 30_000],
      ['c-other', 15_001, 30_000],
      ['c-30', 1, 30],
    ] as const) {
      const prefix = community === 'c-other' ? 'c-30k' : community;
      await db.execute(sql`
        insert into community_members (id, community_id, user_id, status, standing, source,
                                       added_by, joined_at, version)
        select ${`${community}-m-`} || g, ${community}, md5(${`${prefix}:`} || g),
               'ACTIVE', case when g = ${from}::int then 'OWNER' else 'MEMBER' end, 'ADDED',
               md5(${`${prefix}:${from}`}), now() - make_interval(secs => g), g - ${from}::int + 1
          from generate_series(${from}::int, ${from + size - 1}::int) g`);
    }
    // Churn: 100,000 people who joined c-30k and left — history the partial
    // indexes never carry.
    await db.execute(sql`
      insert into community_members (id, community_id, user_id, status, standing, source,
                                     added_by, joined_at, ended_at, ended_by, version)
      select 'c-30k-h-' || g, 'c-30k', md5('gone-c-30k:' || g), 'LEFT', 'MEMBER', 'ADDED',
             'someone', now() - interval '400 days', now() - interval '300 days',
             md5('gone-c-30k:' || g), 30000 + g
        from generate_series(1, 100000) g`);
    await db.execute(sql`
      insert into community_members (id, community_id, user_id, status, standing, source,
                                     added_by, joined_at, version)
      select 'small-m-' || g || '-' || k, 'small-' || g, md5('small:' || g || ':' || k),
             'ACTIVE', case when k = 1 then 'OWNER' else 'MEMBER' end, 'ADDED',
             md5('small:' || g || ':1'), now(), k
        from generate_series(1, 2000) g, generate_series(1, 3) k`);
    await db.execute(sql`analyze communities`);
    await db.execute(sql`analyze community_members`);

    c = communitiesHarness({
      store: new DrizzleCommunityRepository(db),
      readModel: new DrizzleCommunityReadModel(db),
    });
    h = communitiesRealtimeHarness({ communities: c });
    owner = c.person(member('c-30k', 1), ['ADMIN']);
    c.person(member('c-30', 1), ['ADMIN']);
  }, 300_000);

  afterAll(async () => {
    h?.cleanup();
    await pool?.end();
    await scratch?.drop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const connection of h?.connections.all() ?? []) {
      h.connections.unregister(connection.connectionId);
    }
  });

  /**
   * Every statement sent, EXPLAINed as sent: the plan nodes of each. With
   * `seqScan: false`, the plan Postgres finds when a sequential scan is not
   * an option — whether an index can serve the statement at all.
   */
  async function plansOf(
    sent: readonly { query: string; params: unknown[] }[],
    {
      seqScan = true,
      analyze = false,
    }: { readonly seqScan?: boolean; readonly analyze?: boolean } = {},
  ) {
    const plans: PlanNode[][] = [];
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (!seqScan) await client.query('set local enable_seqscan = off');
      for (const { query, params } of sent) {
        const explained = await client.query(
          `explain (${analyze ? 'analyze, ' : ''}format json) ${query}`,
          params,
        );
        const plan = (explained.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0];
        const nodes: PlanNode[] = [];
        if (plan !== undefined) walk(plan.Plan, (node) => nodes.push(node));
        plans.push(nodes);
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
    return plans;
  }

  const readsMembers = (nodes: readonly PlanNode[]) =>
    nodes.some((node) => node['Relation Name'] === 'community_members');

  /**
   * Each statement that reads community_members does it through one of its
   * indexes — never a sequential scan of 166,000 stints.
   */
  function expectIndexedMemberReads(plans: readonly (readonly PlanNode[])[]): void {
    plans.filter(readsMembers).forEach((nodes, statement) => {
      expect({
        statement,
        seqScans: nodes.filter(
          (node) =>
            node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'community_members',
        ),
        indexes: nodes
          .map((node) => node['Index Name'])
          .filter((name) => name?.startsWith('community_members_')),
      }).toEqual({
        statement,
        seqScans: [],
        indexes: expect.arrayContaining([
          expect.stringMatching(/^community_members_/u),
        ]) as string[],
      });
    });
  }

  /**
   * What an index name cannot show: each member read is bounded by the page
   * it asks for — the rows every community_members node reads, kept or
   * filtered out, run for real, are at most a page and the one that says
   * another follows — never the community's 30,000 or its 100,000 departed.
   */
  async function expectBoundedMemberReads(
    sent: readonly { query: string; params: unknown[] }[],
  ): Promise<void> {
    const analyzed = await plansOf(sent, { analyze: true });
    const reads = analyzed
      .filter(readsMembers)
      .map((nodes) =>
        Math.max(
          ...nodes
            .filter(
              (node) =>
                node['Relation Name'] === 'community_members' ||
                node['Index Name']?.startsWith('community_members_'),
            )
            .map(examined),
        ),
      );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((rows) => rows > 1001)).toEqual([]);
  }

  const locked = new Set<string>();

  /** Locks or unlocks with nobody connected, so nothing is relayed yet; the event. */
  async function flip(communityId: string, by: Principal): Promise<DomainEvent> {
    const to = locked.has(communityId) ? 'OPEN' : 'LOCKED';
    expectOk(await c.status.execute({ principal: by, communityId, to, meta: META }));
    if (to === 'LOCKED') locked.add(communityId);
    else locked.delete(communityId);
    const event = c.journal.events[c.journal.events.length - 1];
    expect(event.name).toBe(
      to === 'LOCKED' ? CommunityEvents.communityLocked : CommunityEvents.communityUnlocked,
    );
    return event;
  }

  /** Accounts online here, each on a device, known to identity with a role that reads communities. */
  function online(userIds: readonly string[]): Map<string, FakeLink> {
    return new Map(
      userIds.map((userId) => {
        c.accounts.add(userId, ['STUDENT']);
        return [userId, h.connect(userId)];
      }),
    );
  }

  it('holds the fixture it claims', async () => {
    const [row] = (
      await db.execute(sql`
        select (select count(*) from community_members
                 where community_id = 'c-30k' and status = 'ACTIVE')::int as active,
               (select count(*) from community_members
                 where community_id = 'c-30k' and status <> 'ACTIVE')::int as churn,
               (select count(*) from community_members)::int as stints`)
    ).rows;
    expect(row).toEqual({ active: 30_000, churn: 100_000, stints: 166_030 });
  });

  it.each([
    [50, 40, 5],
    [2_500, 2_000, 250],
  ])(
    'tells exactly the ACTIVE members among %i accounts online — in at most 1 + ⌈A/1000⌉ member pages, each read on an index',
    async (count, members, gone) => {
      const event = await flip('c-30k', owner);
      // Members spread through the community, people who left, and people who never belonged.
      const insiders = Array.from({ length: members }, (_, n) => member('c-30k', 1 + n * 13));
      const leavers = Array.from({ length: gone }, (_, n) => md5(`gone-c-30k:${1 + n * 7}`));
      const strangers = Array.from({ length: count - members - gone }, (_, n) =>
        md5(`stranger:${n}`),
      );
      const links = online([...insiders, ...leavers, ...strangers]);
      const calls = {
        heads: jest.spyOn(c.membership, 'heads'),
        members: jest.spyOn(c.membership, 'members'),
        statesOf: jest.spyOn(c.membership, 'statesOf'),
        withPermission: jest.spyOn(c.accounts, 'withPermission'),
      };

      statements.length = 0;
      await h.relay.relay(event);
      const sent = [...statements];

      const told = [...links]
        .filter(([, link]) => link.ofType(event.name.replace('communities.', '')).length > 0)
        .map(([userId]) => userId);
      expect(told.sort()).toEqual([...insiders].sort());
      expect(calls.heads).toHaveBeenCalledTimes(1);
      expect(calls.members.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(count / 1000));
      expect(calls.statesOf).not.toHaveBeenCalled();
      expect(calls.withPermission).toHaveBeenCalledTimes(Math.ceil(members / 1000));
      // Never more than a page of names in one statement.
      for (const [, page] of calls.members.mock.calls) {
        expect(page.onlyUserIds?.length ?? 0).toBeLessThanOrEqual(1000);
      }

      expect(sent.length).toBe(1 + calls.members.mock.calls.length);
      expect(sent.filter(({ query }) => /\boffset\b/iu.test(query))).toEqual([]);
      const plans = await plansOf(sent);
      // One statement per members() call, each on an index and reading no more than its page.
      expect(plans.filter(readsMembers)).toHaveLength(calls.members.mock.calls.length);
      expectIndexedMemberReads(plans);
      await expectBoundedMemberReads(sent);
    },
  );

  it('reads a community that fits one page in one member call', async () => {
    const event = await flip('c-30', c.person(member('c-30', 1), ['ADMIN']));
    const links = online([member('c-30', 2), member('c-30', 30), md5('stranger:small')]);
    const pages = jest.spyOn(c.membership, 'members');

    statements.length = 0;
    await h.relay.relay(event);

    expect(pages).toHaveBeenCalledTimes(1);
    expect(
      [...links].filter(([, link]) => link.frames.length > 0).map(([userId]) => userId),
    ).toEqual([member('c-30', 2), member('c-30', 30)]);
    const plans = await plansOf(statements);
    expect(plans.filter(readsMembers)).toHaveLength(1);
    expectIndexedMemberReads(plans);
    await expectBoundedMemberReads(statements);
  });

  /**
   * The audience's other half: each page of up to 1,000 connected members is
   * narrowed by identity's directory (`withPermission`), which reads those
   * accounts, their sign-in identifiers and their roles — three statements a
   * page, each naming the page's ids and nothing else, among 60,000 accounts.
   *
   * Which scan Postgres picks is its cost call on the table's size: at 60,000
   * roles (a 5 MB heap) a sequential pass beats 1,000 index probes, and it
   * turns to its primary key as the table grows (measured: between 120,000
   * and 260,000 rows). What this pins is that the choice is only ever cost —
   * every statement is served by its index when a sequential scan is off —
   * and that none reads more than its page.
   */
  it('narrows a 1,000-account page through identity in three bounded, index-served statements', async () => {
    await db.execute(sql`
      insert into users (id, display_name, status, password_hash)
      select id, 'حساب', 'ACTIVE', 'not-a-password-hash'
        from (select md5('c-30k:' || g) as id from generate_series(1, 30000) g
              union all
              select md5('gone-c-30k:' || g) from generate_series(1, 30000) g) accounts`);
    await db.execute(sql`
      insert into user_identifiers (user_id, kind, value)
      select id, 'email', id || '@example.invalid' from users`);
    await db.execute(sql`insert into user_roles (user_id, role) select id, 'STUDENT' from users`);
    await db.execute(sql`analyze users`);
    await db.execute(sql`analyze user_identifiers`);
    await db.execute(sql`analyze user_roles`);

    const page = Array.from({ length: 1000 }, (_, n) => member('c-30k', 1 + n * 29) as UserId);
    statements.length = 0;
    const accounts = await new DrizzleUserRepository(db).findManyByIds(page);
    const sent = [...statements];

    expect(accounts).toHaveLength(1000);
    // Three statements for the page — not one per account — each bound to its 1,000 ids.
    expect(sent).toHaveLength(3);
    expect(sent.map(({ params }) => params.length)).toEqual([1000, 1000, 1000]);
    expect(sent.filter(({ query }) => /\boffset\b/iu.test(query))).toEqual([]);

    const tables = ['users', 'user_identifiers', 'user_roles'];
    const read = (nodes: readonly PlanNode[]) =>
      nodes.map((node) => node['Relation Name']).filter((name) => tables.includes(name ?? ''));
    // Each statement reads its own table, and joins nothing.
    expect((await plansOf(sent)).map(read)).toEqual([
      ['users'],
      ['user_identifiers'],
      ['user_roles'],
    ]);
    const served = await plansOf(sent, { seqScan: false });
    expect(
      served.map((nodes) => ({
        seqScans: nodes.filter((node) => node['Node Type'] === 'Seq Scan'),
        indexes: nodes.map((node) => node['Index Name']).filter(Boolean),
      })),
    ).toEqual([
      { seqScans: [], indexes: ['users_pkey'] },
      { seqScans: [], indexes: ['user_identifiers_user_id_idx'] },
      { seqScans: [], indexes: ['user_roles_user_id_role_pk'] },
    ]);
  });
});
