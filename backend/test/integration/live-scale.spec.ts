import { writeFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import type { Principal } from '../../src/shared';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import type { LiveSessionView } from '../../src/modules/live/application/views';
import { HANDS_PAGE_MAX, LIVE_SESSIONS_PAGE_MAX } from '../../src/modules/live/domain/live-limits';
import { newLiveSession } from '../../src/modules/live/domain/live-session';
import { newSpeakerRequest } from '../../src/modules/live/domain/speaker-request';
import { DrizzleLiveStore } from '../../src/modules/live/infrastructure/drizzle-live-repositories';
import { communitiesHarness } from '../support/communities-harness';
import { META, captureLogs, liveHarnessOver } from '../support/live-harness';
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
  readonly 'Conflict Arbiter Indexes'?: readonly string[];
  readonly Plans?: readonly PlanNode[];
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

/** Live's four tables: none of them may be read whole on a request or reconciler path. */
const LIVE_TABLES = [
  'live_sessions',
  'live_speaker_requests',
  'live_presenter_grants',
  'live_moderation_actions',
];

/**
 * "Now", as the application writes an instant: from a JS Date, to the
 * millisecond — as the hands page's cursor carries it. (Postgres's own now()
 * has microseconds no row the application writes ever has.)
 */
const NOW = sql.raw(`date_trunc('milliseconds', now())`);

/** The pending hands in the two sessions compared. */
const FEW = 3;
const MANY = 3_000;

/**
 * Live at scale (audit §15; plan, commit F). What a request costs does not
 * depend on how many hands a session holds, nor on how much history Live
 * has piled up — and nothing here claims a capacity: this is not a load test
 * (P8 measures). `SCALE_REPORT=<file>` writes the timings for the phase
 * report (`SCALE_REPORT=-` prints them); they are recorded, never asserted.
 *
 * Two sessions, run through Live's use cases over the Drizzle store — with
 * Communities on its own Drizzle adapters over the same database, so its
 * statements are counted too — one with 3 pending hands and one with 3,000,
 * over a churned fixture: 25,000 ended sessions (5,000 of them in the busy
 * community itself), 80,000 terminal requests (20,000 in the busy session
 * itself) and 22,000 closed screen shares.
 *
 *   budgets   join, raise, grant, end, current, get and the hands page send
 *             the SAME statements, one for one, at 3 hands and at 3,000; a
 *             join sends no write, lock or transaction; no statement on any
 *             request path counts without a LIMIT;
 *   plans     every hot statement, as the adapter sent it (a query spy), is
 *             EXPLAINed: index-served, no sequential scan of a Live table.
 */
describeWithPostgres('Live at scale', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let db: Database;
  /** Every statement sent — Live's and Communities' alike. */
  const statements: { readonly query: string; readonly params: readonly unknown[] }[] = [];
  const report: Record<string, unknown> = {};
  const ids = new UuidIdGenerator();

  const boot = () => {
    const communities = communitiesHarness({
      store: new DrizzleCommunityRepository(db),
      readModel: new DrizzleCommunityReadModel(db),
      ids,
    });
    return liveHarnessOver(new DrizzleLiveStore(db), { communities });
  };
  let h: ReturnType<typeof boot>;
  let owner: Principal;
  let speaker: Principal;
  let listener: Principal;
  /** The sessions compared: FEW pending hands, and MANY. */
  const sessions: Record<'few' | 'many', LiveSessionView> = {} as Record<
    'few' | 'many',
    LiveSessionView
  >;

  beforeAll(async () => {
    scratch = await scratchDatabase();
    pool = tolerateTeardown(new Pool({ connectionString: scratch.url, max: 8 }));
    db = drizzle(pool, {
      logger: {
        logQuery(query: string, params: unknown[]) {
          statements.push({ query: query.trim(), params });
        },
      },
    });
    h = boot();

    // Two communities, the same people in each; their sessions started as production starts them.
    const few = await h.community('teacher-1', 'student-1', 'student-2');
    owner = few.owner;
    [speaker, listener] = few.students;
    const many = await h.community('teacher-1', 'student-1', 'student-2');
    sessions.few = await h.startSession(owner, few.id);
    sessions.many = await h.startSession(owner, many.id);

    // The pending queues: people nobody else knows, a second apart.
    for (const [session, hands] of [
      [sessions.few, FEW],
      [sessions.many, MANY],
    ] as const) {
      await db.execute(sql`
        insert into live_speaker_requests (id, session_id, user_id, state, requested_at)
        select ${session.id} || '-hand-' || g, ${session.id}, 'listener-' || g, 'pending',
               ${NOW} - interval '1 hour' + make_interval(secs => g)
          from generate_series(1, ${hands}) g`);
    }

    // Churn: 20,000 sessions of 2,000 other communities, and 5,000 of the
    // busy community itself — long ended.
    await db.execute(sql`
      insert into live_sessions (id, community_id, host_user_id, state, state_version,
                                 started_at, ended_at, end_reason, participant_cap,
                                 moderator_reserve)
      select 'ended-' || g,
             case when g <= 5000 then ${many.id} else 'churned-' || (g % 2000) end,
             'host-' || (g % 50), 'ended', 7,
             ${NOW} - interval '400 days' + make_interval(secs => g * 60),
             ${NOW} - interval '400 days' + make_interval(secs => g * 60 + 3000),
             'idle', 300, 10
        from generate_series(1, 25000) g`);
    // 60,000 terminal requests of those sessions, and 20,000 of the busy one:
    // hands withdrawn, passed over, taken back and expired over its long life.
    const terminal = (id: string, session: ReturnType<typeof sql>, count: number) => sql`
      insert into live_speaker_requests (id, session_id, user_id, state, requested_at,
                                         granted_at, decided_at, decided_by)
      select ${id} || g, ${session}, 'listener-' || (g % 5000), s.state,
             ${NOW} - interval '300 days' + make_interval(secs => g),
             case when s.state in ('revoked', 'expired') or g % 8 = 0
                  then ${NOW} - interval '300 days' + make_interval(secs => g + 30) end,
             ${NOW} - interval '300 days' + make_interval(secs => g + 60),
             case when s.state = 'expired' then null else 'moderator' end
        from generate_series(1, ${count}) g,
             lateral (select (array['withdrawn', 'declined', 'revoked', 'expired'])[1 + g % 4]
                             as state) s`;
    await db.execute(terminal('old-', sql`'ended-' || (1 + g % 25000)`, 60_000));
    await db.execute(terminal(`${sessions.many.id}-old-`, sql`${sessions.many.id}`, 20_000));
    // 20,000 screen shares of those sessions and 2,000 of the busy one, all closed.
    await db.execute(sql`
      insert into live_presenter_grants (id, session_id, user_id, granted_by, granted_at,
                                         ended_at, ended_by, end_reason)
      select 'share-' || g,
             case when g <= 2000 then ${sessions.many.id} else 'ended-' || (1 + g % 25000) end,
             'teacher-' || (g % 40), 'teacher-' || (g % 40),
             ${NOW} - interval '300 days' + make_interval(secs => g * 10),
             ${NOW} - interval '300 days' + make_interval(secs => g * 10 + 5),
             'teacher-' || (g % 40), 'stopped'
        from generate_series(1, 22000) g`);
    for (const table of LIVE_TABLES) await db.execute(sql.raw(`analyze ${table}`));
  }, 300_000);

  afterAll(async () => {
    const written = JSON.stringify(report, null, 2);
    if (process.env.SCALE_REPORT === '-') process.stdout.write(`${written}\n`);
    else if (process.env.SCALE_REPORT !== undefined) {
      writeFileSync(process.env.SCALE_REPORT, written);
    }
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(() => {
    captureLogs();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    expect(h.store.deadlockRetries).toBe(0);
  });

  const number = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number(((await db.execute(query)).rows[0] as { n?: unknown } | undefined)?.n ?? 0);

  /** The statements a call sent, as sent (parameters aside), and what it answered. */
  async function sending<T>(call: () => Promise<T>): Promise<{ sent: string[]; answer: T }> {
    statements.length = 0;
    const answer = await call();
    return { sent: statements.map((statement) => statement.query), answer };
  }

  /** Every statement a call sent, EXPLAINed as sent; the plan nodes of each. */
  async function plansOf(
    call: () => Promise<unknown>,
  ): Promise<{ readonly query: string; readonly nodes: PlanNode[] }[]> {
    statements.length = 0;
    await call();
    const sent = statements.filter(({ query }) => /^(select|update|insert|delete)\b/iu.test(query));
    expect(sent.length).toBeGreaterThan(0);
    const plans: { query: string; nodes: PlanNode[] }[] = [];
    for (const { query, params } of sent) {
      const explained = await pool.query(`explain (format json) ${query}`, [...params]);
      const plan = (explained.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0];
      const nodes: PlanNode[] = [];
      if (plan !== undefined) walk(plan.Plan, (node) => nodes.push(node));
      plans.push({ query, nodes });
    }
    return plans;
  }

  const allNodes = (plans: readonly { nodes: PlanNode[] }[]) => plans.flatMap((plan) => plan.nodes);

  /** Sequential scans of a Live table — there must be none. */
  const seqScans = (nodes: readonly PlanNode[]) =>
    nodes
      .filter(
        (node) =>
          node['Node Type'] === 'Seq Scan' && LIVE_TABLES.includes(node['Relation Name'] ?? ''),
      )
      .map((node) => node['Relation Name']);

  /** The indexes a plan reads — by index scan, index-only scan or bitmap. */
  const indexes = (nodes: readonly PlanNode[]) =>
    new Set(nodes.map((node) => node['Index Name']).filter((name) => name !== undefined));

  /** Wall-clock milliseconds of `runs` calls, median — recorded, never asserted. */
  async function timed(runs: number, call: () => Promise<unknown>): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const began = performance.now();
      await call();
      samples.push(performance.now() - began);
      // A new rate-limit window for every run: the limits are not what is measured.
      h.clock.advance(61);
    }
    const sorted = samples.sort((a, b) => a - b);
    return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100) / 100;
  }

  it('holds the fixture it claims: 3 and 3,000 pending hands over a churned history', async () => {
    const pending = (sessionId: string) =>
      number(sql`select count(*)::int as n from live_speaker_requests
                  where session_id = ${sessionId} and state = 'pending'`);
    expect(await pending(sessions.few.id)).toBe(FEW);
    expect(await pending(sessions.many.id)).toBe(MANY);
    expect(
      (
        await db.execute(sql`
          select (select count(*) from live_sessions where state = 'ended')::int as ended,
                 (select count(*) from live_sessions where state = 'live')::int as live,
                 (select count(*) from live_speaker_requests
                   where state not in ('pending', 'granted'))::int as terminal,
                 (select count(*) from live_presenter_grants where ended_at is not null)::int
                   as shares`)
      ).rows[0],
    ).toEqual({ ended: 25_000, live: 2, terminal: 80_000, shares: 22_000 });
  });

  describe('statement budgets: the same at 3 pending hands as at 3,000', () => {
    /** What each use case sends for one session: its statements, in order. */
    const budgets: Record<'few' | 'many', Record<string, string[]>> = { few: {}, many: {} };

    beforeAll(async () => {
      captureLogs();
      for (const size of ['few', 'many'] as const) {
        const session = sessions[size];
        const sessionId = session.id;
        const communityId = session.communityId;
        const spent = budgets[size];
        const note = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
          const { sent, answer } = await sending(call);
          spent[label] = sent;
          return answer;
        };

        const joined = await note('join', () =>
          h.join.execute({ principal: listener, sessionId, meta: META }),
        );
        expect(joined.ok && joined.value.role).toBe('listener');
        await note('current, a moderator', () =>
          h.current.execute({ principal: owner, communityId }),
        );
        await note('current, a listener', () =>
          h.current.execute({ principal: listener, communityId }),
        );
        await note('get, a moderator', () => h.get.execute({ principal: owner, sessionId }));
        // A full page in both: the few's whole queue, the many's first three.
        const page = await note('hands page', () =>
          h.hands.execute({ principal: owner, sessionId, limit: FEW }),
        );
        if (!page.ok) throw new Error(page.error.code);
        expect(page.value.items).toHaveLength(FEW);
        await note('hands page, granted', () =>
          h.hands.execute({ principal: owner, sessionId, state: 'granted' }),
        );
        const raised = await note('raise', () =>
          h.raise.execute({ principal: speaker, sessionId, meta: META }),
        );
        if (!raised.ok) throw new Error(raised.error.code);
        expect(raised.value.created).toBe(true);
        const granted = await note('grant', () =>
          h.moderate.grant({ principal: owner, requestId: raised.value.request.id, meta: META }),
        );
        expect(granted.ok).toBe(true);
        await note('join, a speaker', () =>
          h.join.execute({ principal: speaker, sessionId, meta: META }),
        );
      }
    }, 60_000);

    it.each([
      ['join'],
      ['join, a speaker'],
      ['current, a moderator'],
      ['current, a listener'],
      ['get, a moderator'],
      ['hands page'],
      ['hands page, granted'],
      ['raise'],
      ['grant'],
    ])('%s: the same statements, one for one', (label) => {
      const few = budgets.few[label];
      const many = budgets.many[label];
      expect(few?.length).toBeGreaterThan(0);
      expect(many).toEqual(few);
      report[`statements: ${label}`] = few?.length;
    });

    it('/join writes nothing: no insert, update, delete, row lock or transaction — as a listener or a speaker', () => {
      for (const size of ['few', 'many'] as const) {
        for (const label of ['join', 'join, a speaker']) {
          const sent = (budgets[size][label] ?? []).map((query) => query.toLowerCase());
          expect(sent.filter((query) => /^(insert|update|delete|begin)\b/u.test(query))).toEqual(
            [],
          );
          expect(
            sent.filter((query) => /\bfor (update|share|no key update)\b/u.test(query)),
          ).toEqual([]);
        }
      }
    });

    it('pages the hands from a cursor in the middle of 3,000 with the same statements as from the start', async () => {
      const first = await h.hands.execute({
        principal: owner,
        sessionId: sessions.many.id,
        limit: HANDS_PAGE_MAX,
      });
      if (!first.ok) throw new Error(first.error.code);
      let cursor = first.value.nextCursor ?? undefined;
      for (let page = 1; page < 15; page += 1) {
        const next = await h.hands.execute({
          principal: owner,
          sessionId: sessions.many.id,
          cursor,
          limit: HANDS_PAGE_MAX,
        });
        if (!next.ok) throw new Error(next.error.code);
        cursor = next.value.nextCursor ?? undefined;
      }
      const middle = await sending(() =>
        h.hands.execute({ principal: owner, sessionId: sessions.many.id, cursor, limit: FEW }),
      );
      const start = await sending(() =>
        h.hands.execute({ principal: owner, sessionId: sessions.many.id, limit: FEW }),
      );
      expect(middle.answer.ok && middle.answer.value.items[0]?.userId).toBe('listener-1501');
      expect(middle.sent).toHaveLength(start.sent.length);
    });
  });

  it('never counts without a LIMIT on any request path', async () => {
    // A third session, driven through every route that reads or changes one.
    const probe = await h.community('teacher-1', 'student-1', 'student-2');
    const counted: string[] = [];
    const run = async <T>(call: () => Promise<T>): Promise<T> => {
      const { sent, answer } = await sending(call);
      counted.push(...sent);
      return answer;
    };
    const started = await run(() =>
      h.start.execute({ principal: owner, communityId: probe.id, meta: META }),
    );
    if (!started.ok) throw new Error(started.error.code);
    const sessionId = started.value.session.id;
    await run(() => h.current.execute({ principal: owner, communityId: probe.id }));
    await run(() => h.current.execute({ principal: listener, communityId: probe.id }));
    await run(() => h.get.execute({ principal: owner, sessionId }));
    await run(() => h.join.execute({ principal: listener, sessionId, meta: META }));
    const hand = await run(() => h.raise.execute({ principal: speaker, sessionId, meta: META }));
    if (!hand.ok) throw new Error(hand.error.code);
    const requestId = hand.value.request.id;
    await run(() => h.hands.execute({ principal: owner, sessionId }));
    await run(() => h.hands.execute({ principal: owner, sessionId, state: 'granted' }));
    await run(() => h.moderate.grant({ principal: owner, requestId, meta: META }));
    await run(() => h.moderate.revoke({ principal: owner, requestId, meta: META }));
    const other = await run(() => h.raise.execute({ principal: listener, sessionId, meta: META }));
    if (!other.ok) throw new Error(other.error.code);
    await run(() =>
      h.moderate.decline({ principal: owner, requestId: other.value.request.id, meta: META }),
    );
    await run(() => h.raise.execute({ principal: speaker, sessionId, meta: META }));
    await run(() => h.lower.execute({ principal: speaker, sessionId, meta: META }));
    await run(() => h.presenter.claim({ principal: owner, sessionId, meta: META }));
    await run(() => h.presenter.stop({ principal: owner, sessionId, meta: META }));
    await run(() => h.end.execute({ principal: owner, sessionId, meta: META }));

    const counting = counted.filter((query) => /\bcount\s*\(/iu.test(query));
    // Not vacuous: the session view counts its pending hands, the grant its floor.
    expect(counting.length).toBeGreaterThan(0);
    expect(counting.filter((query) => !/\blimit\b/iu.test(query))).toEqual([]);
  });

  describe('plans over the churned fixture: index-served, no sequential scan of a Live table', () => {
    it('finds a community’s live session by the one-live partial unique index — and a racing start is arbitrated by it', async () => {
      const lookup = await plansOf(() => h.sessions.findLiveByCommunity(sessions.many.communityId));
      expect(seqScans(allNodes(lookup))).toEqual([]);
      expect(indexes(allNodes(lookup))).toEqual(new Set(['live_sessions_one_live_per_community']));

      // A start losing to the running session: its insert names the arbiter, and writes nothing.
      const rival = newLiveSession({
        id: ids.next<'LiveSession'>(),
        communityId: sessions.many.communityId,
        hostUserId: owner.userId,
        at: new Date(),
        participantCap: 300,
        moderatorReserve: 10,
      });
      const start = await plansOf(() =>
        h.sessions.start(rival, {
          id: ids.next<'ModerationAction'>(),
          sessionId: rival.id,
          actorUserId: owner.userId,
          targetUserId: null,
          type: 'start_session',
          at: rival.startedAt,
        }),
      );
      const arbiters = allNodes(start).flatMap((node) => node['Conflict Arbiter Indexes'] ?? []);
      expect(arbiters).toEqual(['live_sessions_one_live_per_community']);
      expect(seqScans(allNodes(start))).toEqual([]);
    });

    it('finds a person’s open hand by the one-open partial unique index — and a raise is arbitrated by it', async () => {
      const lookup = await plansOf(() => h.requests.findOpen(sessions.many.id, 'listener-1500'));
      expect(seqScans(allNodes(lookup))).toEqual([]);
      expect(indexes(allNodes(lookup))).toEqual(
        new Set(['live_speaker_requests_one_open_per_person']),
      );

      // A repeat raise of an open hand: arbitrated, nothing written.
      const raise = await plansOf(() =>
        h.requests.raise(
          newSpeakerRequest({
            id: ids.next<'SpeakerRequest'>(),
            sessionId: sessions.many.id,
            userId: 'listener-1500',
            at: new Date(),
          }),
        ),
      );
      const arbiters = allNodes(raise).flatMap((node) => node['Conflict Arbiter Indexes'] ?? []);
      expect(arbiters).toEqual(['live_speaker_requests_one_open_per_person']);
      expect(seqScans(allNodes(raise))).toEqual([]);
    });

    it('finds the open screen shares by the one-open-per-user partial index, past 2,000 closed ones', async () => {
      const lookup = await plansOf(() => h.presenters.activeGrants(sessions.many.id));
      expect(seqScans(allNodes(lookup))).toEqual([]);
      expect(indexes(allNodes(lookup))).toEqual(
        new Set(['live_presenter_grants_one_open_per_user']),
      );
    });

    it('pages the pending queue on its keyset partial index — from the start and from the middle', async () => {
      const [middle] = (
        await db.execute(sql`
          select requested_at, id from live_speaker_requests
           where session_id = ${sessions.many.id} and state = 'pending'
           order by requested_at, id offset 1500 limit 1`)
      ).rows as { requested_at: string; id: string }[];
      for (const after of [null, { requestedAt: new Date(middle.requested_at), id: middle.id }]) {
        const page = await plansOf(() =>
          h.requests.pendingPage(sessions.many.id, after, HANDS_PAGE_MAX),
        );
        expect(seqScans(allNodes(page))).toEqual([]);
        expect(indexes(allNodes(page))).toEqual(new Set(['live_speaker_requests_queue_idx']));
      }
      // The capped count of the session view reads the same index.
      const counted = await plansOf(() => h.requests.countPending(sessions.many.id, 100));
      expect(seqScans(allNodes(counted))).toEqual([]);
      expect(indexes(allNodes(counted))).toEqual(new Set(['live_speaker_requests_queue_idx']));
    });

    it('reads the floor on the granted partial index — the grant’s cap count included', async () => {
      const floor = await plansOf(() => h.requests.granted(sessions.many.id));
      expect(seqScans(allNodes(floor))).toEqual([]);
      expect(indexes(allNodes(floor))).toEqual(new Set(['live_speaker_requests_granted_idx']));

      // A grant of the busy session: every statement it sends, planned.
      const [pending] = await h.requests.pendingPage(sessions.many.id, null, 1);
      const grant = await plansOf(() =>
        h.requests.grantWithinCap({
          requestId: pending.id,
          cap: 4,
          at: new Date(),
          by: owner.userId,
          moderation: {
            id: ids.next<'ModerationAction'>(),
            sessionId: sessions.many.id,
            actorUserId: owner.userId,
            targetUserId: pending.userId,
            type: 'grant_speaker',
            at: new Date(),
          },
        }),
      );
      expect(seqScans(allNodes(grant))).toEqual([]);
      const cap = grant.find(({ query }) => /\bcount\s*\(/iu.test(query));
      expect(cap).toBeDefined();
      expect(indexes(cap?.nodes ?? [])).toEqual(new Set(['live_speaker_requests_granted_idx']));
    });

    it('pages the reconciler’s live sessions on the live-page partial index, past 25,000 ended ones', async () => {
      for (const after of [null, { startedAt: new Date(0), id: '' }]) {
        const page = await plansOf(() => h.sessions.listLive(after, LIVE_SESSIONS_PAGE_MAX));
        expect(seqScans(allNodes(page))).toEqual([]);
        expect(indexes(allNodes(page))).toEqual(new Set(['live_sessions_live_page_idx']));
      }
    });

    it('reads the watch’s closed floors and closed screen shares on their indexes', async () => {
      const since = new Date(Date.now() - 660_000);
      const floors = await plansOf(() => h.requests.floorClosedSince(sessions.many.id, since));
      expect(seqScans(allNodes(floors))).toEqual([]);
      expect(indexes(allNodes(floors))).toEqual(
        new Set(['live_speaker_requests_floor_closed_idx']),
      );
      const shares = await plansOf(() => h.presenters.closedSince(sessions.many.id, since));
      expect(seqScans(allNodes(shares))).toEqual([]);
      expect(indexes(allNodes(shares))).toEqual(new Set(['live_presenter_grants_closed_idx']));
    });
  });

  describe('End', () => {
    it('ends 3 hands and 3,000 with the same statements — set-based, and every one index-served', async () => {
      const ending = async (size: 'few' | 'many') => {
        const plans: { query: string; nodes: PlanNode[] }[] = [];
        const { sent, answer } = await sending(() =>
          h.end.execute({ principal: owner, sessionId: sessions[size].id, meta: META }),
        );
        const params = statements.map((statement) => statement.params);
        for (const [i, query] of sent.entries()) {
          if (!/^(select|update|insert|delete)\b/iu.test(query)) continue;
          const explained = await pool.query(`explain (format json) ${query}`, [
            ...(params[i] ?? []),
          ]);
          const plan = (explained.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })[
            'QUERY PLAN'
          ][0];
          const nodes: PlanNode[] = [];
          if (plan !== undefined) walk(plan.Plan, (node) => nodes.push(node));
          plans.push({ query, nodes });
        }
        expect(answer.ok && answer.value.state).toBe('ended');
        return { sent, plans };
      };
      const few = await ending('few');
      const openBefore = await number(sql`select count(*)::int as n from live_speaker_requests
                                           where session_id = ${sessions.many.id}
                                             and state in ('pending', 'granted')`);
      expect(openBefore).toBeGreaterThanOrEqual(MANY);
      const many = await ending('many');

      expect(many.sent).toEqual(few.sent);
      report['statements: end'] = few.sent.length;
      // One UPDATE expires every open hand, whatever their number…
      const expiry = many.plans.filter(({ query }) =>
        /^update "live_speaker_requests"/iu.test(query),
      );
      expect(expiry).toHaveLength(1);
      expect(seqScans(allNodes(many.plans))).toEqual([]);
      expect(
        [...indexes(expiry[0]?.nodes ?? [])].every((name) =>
          (name ?? '').startsWith('live_speaker_requests_'),
        ),
      ).toBe(true);
      expect(indexes(expiry[0]?.nodes ?? []).size).toBeGreaterThan(0);
      // …and nothing is left open.
      expect(
        await number(sql`select count(*)::int as n from live_speaker_requests
                          where session_id = ${sessions.many.id}
                            and state in ('pending', 'granted')`),
      ).toBe(0);
    });
  });

  it('records timings for the phase report — never asserted', async () => {
    // Two fresh sessions of the same sizes, timed on the same paths.
    for (const [label, hands] of [
      ['3 hands', FEW],
      ['3,000 hands', MANY],
    ] as const) {
      const world = await h.community('teacher-1', 'student-1', 'student-2');
      const session = await h.startSession(owner, world.id);
      await db.execute(sql`
        insert into live_speaker_requests (id, session_id, user_id, state, requested_at)
        select ${session.id} || '-hand-' || g, ${session.id}, 'listener-' || g, 'pending',
               ${NOW} - interval '1 hour' + make_interval(secs => g)
          from generate_series(1, ${hands}) g`);
      await db.execute(sql`analyze live_speaker_requests`);
      const sessionId = session.id;
      report[label] = {
        joinMs: await timed(20, () =>
          h.join.execute({ principal: listener, sessionId, meta: META }),
        ),
        currentMs: await timed(20, () =>
          h.current.execute({ principal: owner, communityId: world.id }),
        ),
        handsPageMs: await timed(20, () =>
          h.hands.execute({ principal: owner, sessionId, limit: HANDS_PAGE_MAX }),
        ),
        raiseMs: await timed(1, () =>
          h.raise.execute({ principal: speaker, sessionId, meta: META }),
        ),
        endMs: await timed(1, () => h.end.execute({ principal: owner, sessionId, meta: META })),
      };
    }
    expect(Object.keys(report)).toEqual(expect.arrayContaining(['3 hands', '3,000 hands']));
  }, 60_000);
});
