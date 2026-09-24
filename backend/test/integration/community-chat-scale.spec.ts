import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import type { Principal } from '../../src/shared';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import type { ConversationId } from '../../src/modules/messaging/domain/conversation';
import { DrizzleMessagingReadModel } from '../../src/modules/messaging/infrastructure/drizzle-messaging-read-model';
import { DrizzleMessagingRepository } from '../../src/modules/messaging/infrastructure/drizzle-messaging-repository';
import { communitiesHarness, type CommunitiesHarness } from '../support/communities-harness';
import { expectErr, expectOk } from '../support/identity-harness';
import { META, messagingHarness, type MessagingHarness } from '../support/messaging-harness';
import {
  describeWithPostgres,
  scratchDatabase,
  tolerateTeardown,
  type ScratchDatabase,
} from '../support/postgres';
import { principalWith } from '../support/principals';

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const ms = (since: bigint) => Number(process.hrtime.bigint() - since) / 1e6;

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * A community chat at 30,000 members (community-chat.md §11, §17; the P4
 * brief's §16): measured, not assumed. Communities holds 30,000 ACTIVE
 * members and 30,000 who left (their tombstones fill half the projection:
 * 50% churn); a 30-member community is the control. The projection is
 * filled by the real sync — 60 applies of at most 1,000 — while the owner
 * keeps sending, and every read path is pinned by EXPLAIN on the statement
 * the adapter actually sends, captured by a query spy.
 *
 * What this shows is that nothing on a request path depends on the
 * community's size. It is not a load test (gate G3, profile 4) and claims no
 * capacity: `SCALE_REPORT=<file>` writes the timings for the phase report.
 */
describeWithPostgres('a community chat at 30,000 members', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let db: Database;
  const statements: { query: string; params: unknown[] }[] = [];
  let communities: CommunitiesHarness;
  let h: MessagingHarness;
  let store: DrizzleCommunityRepository;
  let readModel: DrizzleMessagingReadModel;
  const chats: Record<'c-30k' | 'c-30', string> = { 'c-30k': '', 'c-30': '' };
  const owners: Record<'c-30k' | 'c-30', Principal> = {} as Record<'c-30k' | 'c-30', Principal>;
  const members: Record<'c-30k' | 'c-30', Principal> = {} as Record<'c-30k' | 'c-30', Principal>;
  const batches: { states: number; ms: number }[] = [];
  const sends: number[] = [];
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    scratch = await scratchDatabase();
    pool = tolerateTeardown(new Pool({ connectionString: scratch.url, max: 8 }));
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
      values ('c-30k', 'ثلاثون ألفاً', 'OPEN', 1, 60000, 30000, ${md5('c-30k:1')}, now(), now()),
             ('c-30', 'ثلاثون', 'OPEN', 1, 30, 30, ${md5('c-30:1')}, now(), now())`);
    for (const [community, size] of [
      ['c-30k', 30_000],
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
    // Churn: 30,000 people who joined and left.
    await db.execute(sql`
      insert into community_members (id, community_id, user_id, status, standing, source,
                                     added_by, joined_at, ended_at, ended_by, version)
      select 'c-30k-h-' || g, 'c-30k', md5('gone-c-30k:' || g), 'LEFT', 'MEMBER', 'ADDED',
             'someone', now() - interval '400 days', now() - interval '300 days',
             md5('gone-c-30k:' || g), 30000 + g
        from generate_series(1, 30000) g`);
    await db.execute(sql`analyze communities`);
    await db.execute(sql`analyze community_members`);

    // Everything else a deployment holds, so the planner sees production's
    // shapes: 10,000 DMs, 10,000 five-person groups, 2,000 small community chats.
    await db.execute(sql`
      insert into conversations (id, type, title, created_by, created_at, direct_user_low,
                                 direct_user_high, member_count)
      select 'dm-' || g, 'DIRECT', null, md5('dm-a:' || g), now(),
             least(md5('dm-a:' || g), md5('dm-b:' || g)),
             greatest(md5('dm-a:' || g), md5('dm-b:' || g)), 2
        from generate_series(1, 10000) g`);
    await db.execute(sql`
      insert into conversation_participants (conversation_id, user_id, role, joined_at)
      select 'dm-' || g, md5(side || ':' || g), 'MEMBER', now()
        from generate_series(1, 10000) g, unnest(array['dm-a', 'dm-b']) side`);
    await db.execute(sql`
      insert into conversations (id, type, title, created_by, created_at, member_count)
      select 'group-' || g, 'GROUP', 'حلقة ' || g, md5('group:' || g || ':0'), now(), 5
        from generate_series(1, 10000) g`);
    await db.execute(sql`
      insert into conversation_participants (conversation_id, user_id, role, joined_at)
      select 'group-' || g, md5('group:' || g || ':' || k),
             case when k = 0 then 'OWNER' else 'MEMBER' end, now()
        from generate_series(1, 10000) g, generate_series(0, 4) k`);
    await db.execute(sql`
      insert into conversations (id, type, title, created_by, created_at, member_count,
                                 community_id, projected_membership_version)
      select 'chat-other-' || g, 'CHANNEL', null, 'system:messaging-community-chat', now(), 3,
             'other-' || g, 3
        from generate_series(1, 2000) g`);
    await db.execute(sql`
      insert into conversation_participants (conversation_id, user_id, role, joined_at,
                                             source_version, source_membership_id, source_joined_at)
      select 'chat-other-' || g, md5('other:' || g || ':' || k), 'MEMBER', now(), k,
             'm-' || g || '-' || k, now()
        from generate_series(1, 2000) g, generate_series(1, 3) k`);

    store = new DrizzleCommunityRepository(db);
    communities = communitiesHarness({ store, readModel: new DrizzleCommunityReadModel(db) });
    const repository = new DrizzleMessagingRepository(db);
    readModel = new DrizzleMessagingReadModel(db);
    // The capacity switch is a deployment setting (§11.2); raised here so the
    // mechanics can be measured. A test below shows the default refusing.
    h = await messagingHarness({
      repository,
      readModel,
      communities,
      settings: { maxServedMembers: 1_000_000 },
    });
    for (const [community, size] of [
      ['c-30k', 30_000],
      ['c-30', 30],
    ] as const) {
      // Identity knows these accounts: messaging's directory answers for them.
      for (let g = 1; g <= size; g++) {
        h.directory.add(md5(`${community}:${g}`), g === 1 ? ['ADMIN'] : ['STUDENT']);
      }
      owners[community] = principalWith(md5(`${community}:1`), ['ADMIN']);
      members[community] = principalWith(md5(`${community}:${Math.ceil(size / 2)}`), ['STUDENT']);
    }

    // The fill: the real sync, every apply timed, while the owner keeps sending.
    const apply = repository.applyCommunityMembership.bind(repository);
    const timed = jest
      .spyOn(repository, 'applyCommunityMembership')
      .mockImplementation(async (input) => {
        const started = process.hrtime.bigint();
        try {
          return await apply(input);
        } finally {
          if (input.states.length > 1)
            batches.push({ states: input.states.length, ms: ms(started) });
        }
      });
    for (const community of ['c-30', 'c-30k'] as const) {
      const chat = await repository.materializeCommunityChat({
        id: `chat-${community}` as ConversationId,
        communityId: community,
        at: new Date(),
      });
      chats[community] = chat.id;
      let filling = true;
      const fill = h.sync.syncCommunity(community).finally(() => {
        filling = false;
      });
      if (community === 'c-30k') {
        let n = 0;
        while (filling) {
          const started = process.hrtime.bigint();
          expectOk(
            await h.sendText.execute({
              principal: owners[community],
              conversationId: chat.id,
              clientMessageId: `during-fill-${(n += 1).toString().padStart(5, '0')}`,
              body: `رسالة ${n}`,
              meta: META,
            }),
          );
          sends.push(ms(started));
          h.clock.advance(1);
        }
      }
      expect(await fill).toBe('current');
    }
    // The control chat holds messages too, so a page of it is a page of messages.
    for (let n = 1; n <= 3; n++) {
      expectOk(
        await h.sendText.execute({
          principal: owners['c-30'],
          conversationId: chats['c-30'],
          clientMessageId: `control-${n.toString().padStart(5, '0')}`,
          body: `رسالة ${n}`,
          meta: META,
        }),
      );
    }
    timed.mockRestore();
    await db.execute(sql`analyze conversations`);
    await db.execute(sql`analyze conversation_participants`);
  }, 600_000);

  afterAll(async () => {
    if (process.env.SCALE_REPORT !== undefined) {
      writeFileSync(process.env.SCALE_REPORT, JSON.stringify(report, null, 2));
    }
    await h?.cleanup();
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(() => {
    statements.length = 0;
  });

  /** Every statement a call sent, EXPLAINed; the plan nodes of all of them. */
  async function plansOf(
    call: () => Promise<unknown>,
  ): Promise<{ sent: number; nodes: PlanNode[] }> {
    statements.length = 0;
    await call();
    const sent = [...statements];
    const nodes: PlanNode[] = [];
    for (const { query, params } of sent) {
      if (!/^\s*(select|with|update|insert)/iu.test(query)) continue;
      const explained = await pool.query(`explain (format json) ${query}`, params);
      const plan = (explained.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0];
      if (plan !== undefined) walk(plan.Plan, (node) => nodes.push(node));
    }
    return { sent: sent.length, nodes };
  }

  const MEMBERSHIP_TABLES = ['community_members', 'conversation_participants'];
  const scansOfMembership = (nodes: readonly PlanNode[]) =>
    nodes
      .filter((node) => node['Node Type'] === 'Seq Scan')
      .map((node) => node['Relation Name'])
      .filter(
        (relation): relation is string =>
          relation !== undefined && MEMBERSHIP_TABLES.includes(relation),
      );
  const indexes = (nodes: readonly PlanNode[]) =>
    new Set(nodes.map((node) => node['Index Name']).filter((name) => name !== undefined));

  async function timed(runs: number, call: () => Promise<unknown>): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const started = process.hrtime.bigint();
      await call();
      samples.push(ms(started));
    }
    return percentile(samples.slice(Math.floor(runs / 5)), 0.99); // after warm-up
  }

  it('holds the fixture it claims: 30,000 current, 30,000 tombstones, projected to the head', async () => {
    const [row] = (
      await db.execute(sql`
        select (select count(*) from conversation_participants
                 where conversation_id = ${chats['c-30k']} and left_at is null)::int as current,
               (select count(*) from conversation_participants
                 where conversation_id = ${chats['c-30k']} and left_at is not null)::int as tombstones,
               (select member_count from conversations where id = ${chats['c-30k']}) as member_count,
               (select projected_membership_version::int from conversations
                 where id = ${chats['c-30k']}) as projected`)
    ).rows;
    expect(row).toEqual({
      current: 30_000,
      tombstones: 30_000,
      member_count: 30_000,
      projected: 60_000,
    });
  });

  it('filled it in 60 applies of at most 1,000, sends going through between them', () => {
    expect(batches.filter((batch) => batch.states > 30)).toHaveLength(60);
    expect(Math.max(...batches.map((batch) => batch.states))).toBeLessThanOrEqual(1000);
    expect(sends.length).toBeGreaterThan(0);
    const holds = batches.filter((batch) => batch.states > 30).map((batch) => batch.ms);
    report.fill = {
      applies: holds.length,
      lockHoldMs: {
        p50: round(percentile(holds, 0.5)),
        p99: round(percentile(holds, 0.99)),
        max: round(Math.max(...holds)),
      },
      sendsDuringFill: sends.length,
      sendMs: { p50: round(percentile(sends, 0.5)), max: round(Math.max(...sends)) },
    };
    // A send waits for at most the batch holding the lock when it arrives.
    expect(Math.max(...sends)).toBeLessThan(Math.max(...holds) * 2 + 1000);
  });

  it('walks every member through MESSAGE_RECIPIENTS exactly once, in 30 pages', async () => {
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    const started = process.hrtime.bigint();
    do {
      const page: { userIds: readonly string[]; nextCursor: string | null } =
        await h.recipients.list(chats['c-30k'], { limit: 1000, cursor });
      walked.push(...page.userIds);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    report.recipientWalkMs = round(ms(started));
    expect(pages).toBe(30);
    expect(walked).toHaveLength(30_000);
    expect(new Set(walked).size).toBe(30_000);
    expect(walked).toContain(owners['c-30k'].userId);
    expect(walked).not.toContain(md5('gone-c-30k:1'));
  });

  it('pages current members on conversation_participants_current_idx under 50% churn (G2)', async () => {
    const [middle] = (
      await db.execute(sql`
        select user_id from conversation_participants
         where conversation_id = ${chats['c-30k']} and left_at is null
         order by user_id offset 15000 limit 1`)
    ).rows as { user_id: string }[];
    for (const afterUserId of [undefined, middle?.user_id]) {
      const { nodes } = await plansOf(() =>
        readModel.listMemberIds(chats['c-30k'] as ConversationId, { limit: 1000, afterUserId }),
      );
      expect(scansOfMembership(nodes)).toEqual([]);
      expect(indexes(nodes)).toContain('conversation_participants_current_idx');
    }
  });

  it('looks a community’s chat up on its unique index', async () => {
    const { nodes } = await plansOf(() => readModel.communityChat('c-30k'));
    expect(indexes(nodes)).toContain('conversations_community_unique');
    expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan')).toEqual([]);
  });

  describe('the same statements at 30,000 as at 30 — nothing loads the membership', () => {
    it.each([
      [
        'a member opening the chat (access: the permit, then point lookups)',
        (community: 'c-30k' | 'c-30') =>
          h.getConversation.execute({
            principal: members[community],
            conversationId: chats[community],
          }),
      ],
      [
        'a page of messages',
        (community: 'c-30k' | 'c-30') =>
          h.listMessages.execute({
            principal: members[community],
            conversationId: chats[community],
          }),
      ],
      [
        'the owner sending (both permits, then the append under the lock)',
        (community: 'c-30k' | 'c-30') =>
          h.sendText.execute({
            principal: owners[community],
            conversationId: chats[community],
            clientMessageId: `probe-${community}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            body: 'قياس',
            meta: META,
          }),
      ],
      [
        // Every page is checked against Communities: one statesOf for its
        // 1,000 people. How Communities plans that is Communities' own — at
        // this fixture's 60,000 stints one pass is cheaper than 1,000 probes;
        // at production volume it is index probes (communities-scale.spec.ts
        // pins it at ~900,000 stints) — so only messaging's table is held here.
        'one recipient page of 1,000',
        (community: 'c-30k' | 'c-30') => h.recipients.list(chats[community], { limit: 1000 }),
        ['conversation_participants'],
      ],
    ])('%s', async (_name, call, tables: readonly string[] = MEMBERSHIP_TABLES) => {
      h.clock.advance(60);
      const large = await plansOf(() => call('c-30k'));
      const small = await plansOf(() => call('c-30'));
      expect(large.sent).toBe(small.sent);
      expect(large.sent).toBeLessThanOrEqual(12);
      expect(scansOfMembership(large.nodes).filter((table) => tables.includes(table))).toEqual([]);
    });
  });

  it('checks every page against Communities in one call, whatever it holds — lagging or not', async () => {
    // Measured alone: the sync a lagging page schedules would otherwise run alongside.
    jest.spyOn(h.sync, 'schedule').mockImplementation(() => undefined);
    const rebuild = jest.spyOn(h.sync, 'requestReconcile');
    const statesOf = jest.spyOn(h.communities.membership, 'statesOf');
    try {
      const current = await plansOf(() => h.recipients.list(chats['c-30k'], { limit: 1000 }));
      // Behind by one change.
      await db.execute(sql`
        update conversations set projected_membership_version = 59999 where id = ${chats['c-30k']}`);
      const small = await plansOf(() => h.recipients.list(chats['c-30k'], { limit: 10 }));
      const large = await plansOf(() => h.recipients.list(chats['c-30k'], { limit: 1000 }));
      // One statesOf a page, and the same statements, whatever the page's
      // size or the projection's lag.
      expect(statesOf).toHaveBeenCalledTimes(3);
      expect(statesOf.mock.calls.map(([, userIds]) => userIds.length)).toEqual([1000, 10, 1000]);
      expect(large.sent).toBe(small.sent);
      expect(large.sent).toBe(current.sent);
      // Messaging's own statements stay on its indexes (Communities' statesOf
      // is Communities' to plan — see the recipient page above).
      expect(
        scansOfMembership(large.nodes).filter((table) => table === 'conversation_participants'),
      ).toEqual([]);
      const page = await h.recipients.list(chats['c-30k'], { limit: 1000 });
      expect(page.userIds).toHaveLength(1000);
      // Under 50% churn, lagging is not mistaken for a lost change.
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      await db.execute(sql`
        update conversations set projected_membership_version = 60000 where id = ${chats['c-30k']}`);
    }
  });

  it('answers as fast at 30,000 as at 30', async () => {
    const measure = async (community: 'c-30k' | 'c-30') => ({
      authorityRead: await timed(200, () =>
        store.authorityOf(community, members[community].userId),
      ),
      openChat: await timed(200, () =>
        h.getConversation.execute({
          principal: members[community],
          conversationId: chats[community],
        }),
      ),
      recipientPage: await timed(50, () => h.recipients.list(chats[community], { limit: 1000 })),
      chatLookup: await timed(200, () => readModel.communityChat(community)),
    });
    const small = await measure('c-30');
    const large = await measure('c-30k');
    const sendsAt = async (community: 'c-30k' | 'c-30') => {
      let n = 0;
      return timed(60, async () => {
        h.clock.advance(1);
        expectOk(
          await h.sendText.execute({
            principal: owners[community],
            conversationId: chats[community],
            clientMessageId: `timed-${community}-${(n += 1).toString().padStart(4, '0')}`,
            body: 'توقيت',
            meta: META,
          }),
        );
      });
    };
    const sendSmall = await sendsAt('c-30');
    const sendLarge = await sendsAt('c-30k');
    report.p99Ms = {
      'c-30': { ...small, send: sendSmall },
      'c-30k': { ...large, send: sendLarge },
    };
    for (const key of Object.keys(small) as (keyof typeof small)[]) {
      // The recipient page returns 1,000 ids at 30,000 and 30 at 30: it is
      // bounded by the page, not the community — so it is compared per id.
      const [a, b] =
        key === 'recipientPage' ? [small[key] / 30, large[key] / 1000] : [small[key], large[key]];
      expect({ [key]: b < Math.max(a * 5, a + 10) }).toEqual({ [key]: true });
    }
    expect(sendLarge).toBeLessThan(Math.max(sendSmall * 5, sendSmall + 20));
  }, 300_000);

  it('keeps posting switched off at this size under the default setting (§11.2)', async () => {
    const guarded = await messagingHarness({
      repository: new DrizzleMessagingRepository(db),
      readModel,
      communities,
    });
    try {
      guarded.directory.add(owners['c-30k'].userId, ['ADMIN']);
      expect(
        expectErr(
          await guarded.sendText.execute({
            principal: owners['c-30k'],
            conversationId: chats['c-30k'],
            clientMessageId: 'over-the-switch-01',
            body: 'لا',
            meta: META,
          }),
        ).code,
      ).toBe('messaging.community_chat_over_capacity');
      expectOk(
        await guarded.listMessages.execute({
          principal: members['c-30k'],
          conversationId: chats['c-30k'],
        }),
      );
    } finally {
      await guarded.cleanup();
    }
  });
});
