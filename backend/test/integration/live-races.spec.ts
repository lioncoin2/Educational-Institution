import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { InProcessEventBus } from '../../src/platform/events/event-bus';
import type { Database } from '../../src/platform/database';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import type { Principal } from '../../src/shared';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import { ProtectLiveSessions } from '../../src/modules/live/application/protect-live-sessions';
import type { LiveSessionView, SpeakerRequestView } from '../../src/modules/live/application/views';
import { MAX_CONCURRENT_SPEAKERS } from '../../src/modules/live/domain/live-limits';
import { capabilitiesFor } from '../../src/modules/live/domain/standing';
import { DrizzleLiveStore } from '../../src/modules/live/infrastructure/drizzle-live-repositories';
import { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import { communitiesHarness, type CommunitiesHarness } from '../support/communities-harness';
import { META, captureLogs, codeOf, liveHarnessOver } from '../support/live-harness';
import {
  describeWithPostgres,
  scratchDatabase,
  tolerateTeardown,
  type ScratchDatabase,
} from '../support/postgres';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
  presenterDelegated: false,
});

/** How many API processes each race runs across. */
const PROCESSES = 5;

type Method = (...args: unknown[]) => Promise<unknown>;

/** A pause the test opens when it chooses; `reached` once every paused call waits there. */
interface Pause {
  readonly reached: Promise<void>;
  open(): void;
}

/**
 * Stops the first `calls` calls of these methods — across all the targets
 * together, a barrier — until `open()`. Later calls pass straight through.
 * Placed between a use case's permit and its write, it makes the race
 * HAPPEN: the other side commits while this one holds its answer.
 */
function pauseAt(calls: number, ...targets: ReadonlyArray<readonly [object, string]>): Pause {
  let arrived = 0;
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  for (const [target, name] of targets) {
    const object = target as Record<string, Method>;
    const original = object[name].bind(object);
    jest.spyOn(object, name).mockImplementation(async (...args: unknown[]) => {
      if (arrived < calls) {
        arrived += 1;
        if (arrived === calls) reach();
        await opened;
      }
      return original(...args);
    });
  }
  return { reached, open };
}

/** Waits until `done` holds — or fails the test after ten seconds rather than hang it. */
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2_000; turn += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the awaited calls never arrived');
}

/**
 * Every race of the audit's §14, on Postgres, through Live's use cases —
 * each asserting exactly the ACCEPTED outcome, neither stricter nor looser.
 *
 * Each test runs FIVE Live "processes" over one pool: every one has its own
 * Drizzle store (its own admission mutex), its own rate limiter, LiveMedia,
 * RoomOccupancy and reconciler, exactly as separate API instances would — so
 * the database, never an in-process queue, decides every race. They share
 * what separate instances share: Postgres (Live's tables and Communities',
 * through Communities' own Drizzle adapters and use cases), identity's
 * account directory, the clock, and one media server (the fake provider).
 * `ProtectLiveSessions` runs in a process of its own choosing, fed
 * Communities' real events through a real in-process bus.
 *
 * No race is left to chance: a pause between the permit and the write (or a
 * held provider call) makes the other side commit at exactly that point,
 * and each order is forced in turn. Only the 50-round run lets the
 * scheduler choose — and asserts what holds whichever it chose. Every
 * connection runs under a statement_timeout, so a lock that never frees
 * fails a test instead of hanging it, and the stores' deadlock retries must
 * stay zero: a retried victim would succeed and hide in every outcome.
 */
describeWithPostgres('Live races on Postgres (audit §14)', () => {
  let scratch: ScratchDatabase;
  let pool: Pool;
  let db: Database;
  /** Every statement any process sends — Live's and Communities' alike. */
  const statements: { readonly query: string; readonly params: readonly unknown[] }[] = [];

  beforeAll(async () => {
    scratch = await scratchDatabase();
    pool = tolerateTeardown(
      new Pool({ connectionString: scratch.url, max: 16, options: '-c statement_timeout=15000' }),
    );
    db = drizzle(pool, {
      logger: {
        logQuery(query: string, params: unknown[]) {
          statements.push({ query: query.trim().toLowerCase(), params });
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  /** One Live API process over the shared database, Communities and media server. */
  const boot = (communities: CommunitiesHarness, rtc: FakeRtcProvider) =>
    liveHarnessOver(new DrizzleLiveStore(db), {
      communities,
      provider: rtc,
      limiter: new InMemoryRateLimiter(communities.clock),
    });
  type Process = ReturnType<typeof boot>;

  let communities: CommunitiesHarness;
  let rtc: FakeRtcProvider;
  let processes: Process[];
  let bus: InProcessEventBus;
  let protect: ProtectLiveSessions;
  /** How many of Communities' events have been handed to the bus. */
  let delivered: number;

  const live = (i: number): Process => processes[i % processes.length];

  beforeEach(() => {
    // The reconciler's metric lines, silenced.
    captureLogs();
    communities = communitiesHarness({
      store: new DrizzleCommunityRepository(db),
      readModel: new DrizzleCommunityReadModel(db),
      ids: new UuidIdGenerator(),
    });
    rtc = new FakeRtcProvider(communities.clock);
    processes = Array.from({ length: PROCESSES }, () => boot(communities, rtc));
    bus = new InProcessEventBus();
    // Another process than the one that acts reacts to Communities' facts.
    protect = new ProtectLiveSessions(bus, live(1).sessions, live(1).reconciler);
    protect.onModuleInit();
    delivered = 0;
  });

  afterEach(async () => {
    await protect.onModuleDestroy();
    for (const each of processes) await each.reconciler.stop();
    jest.restoreAllMocks();
    // The one lock order makes deadlocks impossible; a retry would hide one.
    expect(processes.map((each) => each.store.deadlockRetries)).toEqual(
      Array.from({ length: PROCESSES }, () => 0),
    );
  });

  /** Hands Communities' new events to the bus, then waits for what they scheduled. */
  async function deliver(): Promise<void> {
    const events = communities.journal.events.slice(delivered);
    delivered = communities.journal.events.length;
    await bus.publish(events);
    await protect.idle();
  }

  /** A community of teacher-1 and these students, its session started in process 0. */
  async function scene(...studentIds: string[]) {
    const world = await live(0).community('teacher-1', ...studentIds);
    const session = await live(0).startSession(world.owner, world.id);
    return {
      communityId: world.id,
      owner: world.owner,
      students: world.students,
      session,
      room: live(0).room(session.id),
    };
  }

  // ── What Postgres holds — read with SQL, never through a port ──────────

  const number = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number(((await db.execute(query)).rows[0] as { n?: unknown } | undefined)?.n ?? 0);

  const openHands = (sessionId: string) =>
    number(sql`select count(*)::int as n from live_speaker_requests
                where session_id = ${sessionId} and state in ('pending', 'granted')`);

  const openPresenters = (sessionId: string) =>
    number(sql`select count(*)::int as n from live_presenter_grants
                where session_id = ${sessionId} and ended_at is null`);

  const versionOf = (sessionId: string) =>
    number(sql`select state_version as n from live_sessions where id = ${sessionId}`);

  const moderationRows = (sessionId: string, type: string) =>
    number(sql`select count(*)::int as n from live_moderation_actions
                where session_id = ${sessionId} and type = ${type}`);

  async function request(requestId: string) {
    const [row] = (
      await db.execute(sql`
        select state, decided_by, granted_at is not null as floor
          from live_speaker_requests where id = ${requestId}`)
    ).rows as { state: string; decided_by: string | null; floor: boolean }[];
    return row;
  }

  async function sessionState(sessionId: string): Promise<string | undefined> {
    const [row] = (await db.execute(sql`select state from live_sessions where id = ${sessionId}`))
      .rows as { state: string }[];
    return row?.state;
  }

  /** Live's audit entries and events, from every process. */
  const audits = () => processes.flatMap((each) => each.journal.entries);
  const auditActions = () => audits().map((entry) => entry.action);
  const events = () => processes.flatMap((each) => each.journal.events);
  const eventNames = () => events().map((event) => event.name);
  const clearJournals = () => processes.forEach((each) => each.journal.clear());

  const calls = (operation: string) =>
    rtc.calls.filter((call) => call.operation === operation).length;

  // ── Start ──────────────────────────────────────────────────────────────

  describe('two moderators start at once', () => {
    it('twenty starts across five processes: one row, the same id for all, one created, every loser’s room ended', async () => {
      const { id: communityId, owner } = await live(0).community('teacher-1');
      const starters: Principal[] = [owner];
      for (let i = 2; i <= 20; i += 1) {
        starters.push(
          await live(0).delegate(communityId, owner, `teacher-${i}`, 'community.live.start'),
        );
      }
      // Every start is past its first look for a running session, holding a
      // room of its own, before any of them inserts.
      const held = rtc.hold('ensureRoom');
      const racing = starters.map((starter, i) =>
        live(i).start.execute({ principal: starter, communityId, meta: META }),
      );
      await until(() => calls('ensureRoom') === 20);
      held.release();
      const results = await Promise.all(racing);

      const answers = results.map((result) => {
        if (!result.ok) throw new Error(result.error.code);
        return result.value;
      });
      const ids = new Set(answers.map((answer) => answer.session.id));
      expect(ids.size).toBe(1);
      const [id] = [...ids];
      // One 201; every other caller gets the same session with 200.
      const created = answers.filter((answer) => answer.created);
      expect(created).toHaveLength(1);
      expect(
        await number(sql`select count(*)::int as n from live_sessions
                          where community_id = ${communityId}`),
      ).toBe(1);
      expect(await moderationRows(id, 'start_session')).toBe(1);
      // The winner's starter hosts it.
      const winner = starters[answers.indexOf(created[0])];
      expect(created[0].session.hostUserId).toBe(winner.userId);

      // Each loser ended the room it ensured; only the session's room is left.
      const room = live(0).room(id);
      const ensured = rtc.ensured.map((spec) => spec.roomName);
      expect(new Set(ensured).size).toBe(20);
      expect(rtc.roomNames()).toEqual([room]);
      expect([...rtc.ended].sort()).toEqual(ensured.filter((name) => name !== room).sort());
      expect(auditActions()).toEqual(['live.session.started']);
      expect(eventNames()).toEqual(['live.session.started']);
    });
  });

  // ── Join ───────────────────────────────────────────────────────────────

  describe('two users join at once', () => {
    it('both get tokens, and nothing is written: no insert, update, delete, lock or transaction', async () => {
      const { session, students, room } = await scene('student-1', 'student-2');
      clearJournals();
      const before = await versionOf(session.id);
      const rows = () =>
        number(sql`select (select count(*) from live_sessions)
                        + (select count(*) from live_speaker_requests)
                        + (select count(*) from live_presenter_grants)
                        + (select count(*) from live_moderation_actions) as n`);
      const stored = await rows();

      // Both joins hold their answers at the signing step, past every read.
      const held = rtc.hold('issueAccessToken');
      statements.length = 0;
      const joining = students.map((student, i) =>
        live(i).join.execute({ principal: student, sessionId: session.id, meta: META }),
      );
      await until(() => calls('issueAccessToken') === 2);
      held.release();
      const tickets = await Promise.all(joining);
      const sent = statements.map((statement) => statement.query);

      expect(tickets.map((ticket) => ticket.ok && ticket.value.token)).toEqual([
        `fake.${room}.student-1.sub`,
        `fake.${room}.student-2.sub`,
      ]);
      // Signed in whichever order they arrived.
      expect(rtc.issued.map((grant) => `${grant.roomName} ${grant.identity}`).sort()).toEqual([
        `${room} student-1`,
        `${room} student-2`,
      ]);
      // The statement spy: reads only — Live's and Communities' alike.
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((query) => /^(insert|update|delete|begin)\b/u.test(query))).toEqual([]);
      expect(sent.filter((query) => /\bfor (update|share|no key update)\b/u.test(query))).toEqual(
        [],
      );
      expect(await versionOf(session.id)).toBe(before);
      expect(await rows()).toBe(stored);
      expect(audits()).toEqual([]);
      expect(events()).toEqual([]);
    });
  });

  // ── Promotion + removal ────────────────────────────────────────────────

  describe('promotion + removal', () => {
    it('A: the removal commits while the grant is in flight, before its target is asked about — 412 live.target_not_eligible, nothing granted', async () => {
      const { communityId, owner, students, session } = await scene('student-1');
      const hand = await live(2).raised(students[0], session.id);
      const version = await versionOf(session.id);

      // The grant has its moderator permit and the request; the target's
      // eligibility is read only once the removal has committed.
      const paused = pauseAt(1, [live(0).standing, 'ofAccounts']);
      const granting = live(0).moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      await paused.reached;
      await live(3).remove(communityId, owner, 'student-1');
      paused.open();

      expect(codeOf(await granting)).toBe('live.target_not_eligible');
      expect(await request(hand.id)).toMatchObject({ state: 'pending', floor: false });
      expect(await moderationRows(session.id, 'grant_speaker')).toBe(0);
      expect(await versionOf(session.id)).toBe(version);
      expect(eventNames()).not.toContain('live.speaker.granted');

      // The step then expires the removed member's pending hand.
      await deliver();
      expect(await request(hand.id)).toMatchObject({ state: 'expired', decided_by: null });
      expect(await openHands(session.id)).toBe(0);
    });

    it('B: the removal commits between the target’s permit and the write — the grant commits, then the reconciler step expires it', async () => {
      const { communityId, owner, students, session } = await scene('student-1');
      const hand = await live(2).raised(students[0], session.id);

      const paused = pauseAt(1, [live(0).requests, 'grantWithinCap']);
      const granting = live(0).moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      await paused.reached;
      await live(3).remove(communityId, owner, 'student-1');
      paused.open();

      // The permit read before the removal committed carries the act (§14).
      const granted = await granting;
      expect(granted.ok && granted.value.request.state).toBe('granted');
      expect(await request(hand.id)).toMatchObject({ state: 'granted', floor: true });
      expect(auditActions()).toEqual(['live.session.started', 'live.speaker.granted']);

      // ProtectLiveSessions, in another process, on member.removed.
      await deliver();
      expect(await request(hand.id)).toMatchObject({
        state: 'expired',
        decided_by: null,
        floor: true,
      });
      expect(await openHands(session.id)).toBe(0);
      expect(live(1).journal.eventNames()).toEqual(['live.speaker.expired']);
    });

    it('stays safe under 50 rounds of real concurrency: no eligibility read after the removal committed is ever granted, and nothing stays open', async () => {
      const { communityId, owner, session } = await scene();
      const target = await live(0).member(communityId, owner, 'student-9');
      const original = communities.authorization.permittedAmong.bind(communities.authorization);
      let tick = 0;
      let recording = false;
      /** The round's first read of the target's eligibility: the grant's own. */
      let eligibility: { started: number; granted: boolean } | null = null;
      jest
        .spyOn(communities.authorization, 'permittedAmong')
        .mockImplementation(async (community, userIds, act) => {
          const started = (tick += 1);
          const answer = await original(community, userIds, act);
          if (
            recording &&
            eligibility === null &&
            act === 'community.live.remain' &&
            userIds.includes(target.userId)
          ) {
            eligibility = { started, granted: answer.includes(target.userId) };
          }
          return answer;
        });
      let seed = 23;
      const delay = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return Math.floor((seed / 2 ** 32) * 24);
      };

      const outcomes: string[] = [];
      for (let round = 0; round < 50; round += 1) {
        if (round > 0) {
          communities.clock.advance(600);
          await communities.addPeople(owner, communityId, target.userId);
        }
        const hand = await live(round).raised(target, session.id);
        eligibility = null;
        recording = true;
        let committed = Number.POSITIVE_INFINITY;
        const [granted] = await Promise.all([
          new Promise((resolve) => setTimeout(resolve, delay())).then(() =>
            live(round + 1).moderate.grant({ principal: owner, requestId: hand.id, meta: META }),
          ),
          (async () => {
            await live(round + 2).remove(communityId, owner, target.userId);
            committed = tick += 1;
          })(),
        ]);
        recording = false;

        // The grant always asks about its target (TypeScript cannot see the spy assign it).
        const asked = eligibility as { started: number; granted: boolean } | null;
        if (asked === null) throw new Error('the grant never asked about its target');
        // An eligibility read that started after the removal committed is never granted…
        if (asked.started > committed) expect(asked.granted).toBe(false);
        // …so a grant that committed rests only on a read that came before.
        if (granted.ok) {
          expect(asked).toEqual({ started: expect.any(Number), granted: true });
          expect(asked.started).toBeLessThan(committed);
        } else {
          expect(codeOf(granted)).toBe('live.target_not_eligible');
          expect(asked.granted).toBe(false);
        }
        outcomes.push(codeOf(granted));
        // Either way, the step leaves nothing open for someone who may not stay.
        await deliver();
        expect(await request(hand.id)).toMatchObject({ state: 'expired', decided_by: null });
        expect(await openHands(session.id)).toBe(0);
      }
      expect(outcomes).toHaveLength(50);
    }, 180_000);
  });

  // ── Session end + a change ─────────────────────────────────────────────

  describe('a change racing End: nothing stays open in an ended session', () => {
    const end = (process: Process, owner: Principal, sessionId: string) =>
      process.end.execute({ principal: owner, sessionId, meta: META });

    /** Nothing open, and the session ended — what End promises whichever order won. */
    async function closed(sessionId: string): Promise<void> {
      expect(await sessionState(sessionId)).toBe('ended');
      expect(await openHands(sessionId)).toBe(0);
      expect(await openPresenters(sessionId)).toBe(0);
    }

    it('grant + End, End first: the grant waits on the session row, finds it ended — 412, nothing written', async () => {
      const { owner, students, session } = await scene('student-1');
      const hand = await live(2).raised(students[0], session.id);
      const paused = pauseAt(1, [live(0).requests, 'grantWithinCap']);
      const granting = live(0).moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      await paused.reached;
      expect((await end(live(1), owner, session.id)).ok).toBe(true);
      paused.open();

      expect(codeOf(await granting)).toBe('live.session_not_live');
      expect(await request(hand.id)).toMatchObject({ state: 'expired', floor: false });
      expect(await moderationRows(session.id, 'grant_speaker')).toBe(0);
      await closed(session.id);
    });

    it('grant + End, grant first: End, already in flight, expires the floor it granted', async () => {
      const { owner, students, session } = await scene('student-1');
      const hand = await live(2).raised(students[0], session.id);
      const paused = pauseAt(1, [live(1).sessions, 'end']);
      const ending = end(live(1), owner, session.id);
      await paused.reached;
      const granted = await live(0).moderate.grant({
        principal: owner,
        requestId: hand.id,
        meta: META,
      });
      expect(granted.ok).toBe(true);
      paused.open();

      expect((await ending).ok).toBe(true);
      expect(await request(hand.id)).toMatchObject({ state: 'expired', floor: true });
      await closed(session.id);
    });

    it('raise + End, End first: 412, and no hand in the ended session', async () => {
      const { owner, students, session } = await scene('student-1');
      const paused = pauseAt(1, [live(0).requests, 'raise']);
      const raising = live(0).raise.execute({
        principal: students[0],
        sessionId: session.id,
        meta: META,
      });
      await paused.reached;
      expect((await end(live(1), owner, session.id)).ok).toBe(true);
      paused.open();

      expect(codeOf(await raising)).toBe('live.session_not_live');
      expect(
        await number(sql`select count(*)::int as n from live_speaker_requests
                          where session_id = ${session.id}`),
      ).toBe(0);
      expect(eventNames()).not.toContain('live.speaker.requested');
      await closed(session.id);
    });

    it('raise + End, raise first: End expires the new hand — one live.session.ended, no per-hand event', async () => {
      const { owner, students, session } = await scene('student-1');
      const paused = pauseAt(1, [live(1).sessions, 'end']);
      const ending = end(live(1), owner, session.id);
      await paused.reached;
      const raised = await live(0).raised(students[0], session.id);
      paused.open();

      expect((await ending).ok).toBe(true);
      expect(await request(raised.id)).toMatchObject({ state: 'expired', decided_by: null });
      expect(eventNames().filter((name) => name !== 'live.session.started')).toEqual([
        'live.speaker.requested',
        'live.session.ended',
      ]);
      await closed(session.id);
    });

    it('claim + End, End first: 412, and no presenter grant', async () => {
      const { owner, session } = await scene();
      const paused = pauseAt(1, [live(0).presenters, 'open']);
      const claiming = live(0).presenter.claim({
        principal: owner,
        sessionId: session.id,
        meta: META,
      });
      await paused.reached;
      expect((await end(live(1), owner, session.id)).ok).toBe(true);
      paused.open();

      expect(codeOf(await claiming)).toBe('live.session_not_live');
      expect(
        await number(sql`select count(*)::int as n from live_presenter_grants
                          where session_id = ${session.id}`),
      ).toBe(0);
      await closed(session.id);
    });

    it('claim + End, claim first: End closes the grant as session_ended', async () => {
      const { owner, session } = await scene();
      const paused = pauseAt(1, [live(1).sessions, 'end']);
      const ending = end(live(1), owner, session.id);
      await paused.reached;
      const claimed = await live(0).presenter.claim({
        principal: owner,
        sessionId: session.id,
        meta: META,
      });
      expect(claimed.ok && claimed.value.opened).toBe(true);
      paused.open();

      expect((await ending).ok).toBe(true);
      expect(
        (
          await db.execute(sql`select end_reason from live_presenter_grants
                                where session_id = ${session.id}`)
        ).rows,
      ).toEqual([{ end_reason: 'session_ended' }]);
      await closed(session.id);
    });

    it('join + End, End first: a join that re-created the missing room ends it and gets 412', async () => {
      const { owner, students, session, room } = await scene('student-1');
      // The provider lost the room; the join ensures it, and is held there.
      await rtc.endRoom(room);
      const held = rtc.hold('ensureRoom');
      const joining = live(0).join.execute({
        principal: students[0],
        sessionId: session.id,
        meta: META,
      });
      await held.reached;
      expect((await end(live(1), owner, session.id)).ok).toBe(true);
      held.release();

      expect(codeOf(await joining)).toBe('live.session_not_live');
      expect(rtc.room(room)).toBeNull();
      expect(rtc.issued).toEqual([]);
      await closed(session.id);
    });

    it('join + End, join first: the token names the room End then deletes', async () => {
      const { owner, students, session, room } = await scene('student-1');
      const paused = pauseAt(1, [live(1).sessions, 'end']);
      const ending = end(live(1), owner, session.id);
      await paused.reached;
      const joined = await live(0).join.execute({
        principal: students[0],
        sessionId: session.id,
        meta: META,
      });
      expect(joined.ok && joined.value.token).toBe(`fake.${room}.student-1.sub`);
      paused.open();

      expect((await ending).ok).toBe(true);
      expect(rtc.ended).toContain(room);
      expect(rtc.roomNames()).toEqual([]);
      await closed(session.id);
    });
  });

  // ── Raise + removal ────────────────────────────────────────────────────

  describe('raise + removal', () => {
    it('A: the removal commits before the raise’s permit is read — refused as a stranger, nothing stored', async () => {
      const { communityId, owner, students, session } = await scene('student-1');
      const paused = pauseAt(1, [live(0).access, 'ask']);
      const raising = live(0).raise.execute({
        principal: students[0],
        sessionId: session.id,
        meta: META,
      });
      await paused.reached;
      await live(3).remove(communityId, owner, 'student-1');
      paused.open();

      expect(codeOf(await raising)).toBe('live.session_not_found');
      expect(
        await number(sql`select count(*)::int as n from live_speaker_requests
                          where session_id = ${session.id}`),
      ).toBe(0);
    });

    it('B: the removal commits between the permit and the write — created, then expired by the step', async () => {
      const { communityId, owner, students, session } = await scene('student-1');
      const paused = pauseAt(1, [live(0).requests, 'raise']);
      const raising = live(0).raise.execute({
        principal: students[0],
        sessionId: session.id,
        meta: META,
      });
      await paused.reached;
      await live(3).remove(communityId, owner, 'student-1');
      paused.open();

      const raised = await raising;
      if (!raised.ok) throw new Error(raised.error.code);
      expect(raised.value.created).toBe(true);
      expect(await request(raised.value.request.id)).toMatchObject({ state: 'pending' });

      await deliver();
      expect(await request(raised.value.request.id)).toMatchObject({
        state: 'expired',
        decided_by: null,
      });
      expect(await openHands(session.id)).toBe(0);
    });
  });

  // ── Lock + start ───────────────────────────────────────────────────────

  describe('lock + start', () => {
    it('the lock commits during ensureRoom: the re-asked permit refuses — 412 live.community_not_open, the room ended, nothing stored (D20)', async () => {
      const { id: communityId, owner } = await live(0).community('teacher-1', 'student-1');
      const held = rtc.hold('ensureRoom');
      const starting = live(0).start.execute({ principal: owner, communityId, meta: META });
      await held.reached;
      await live(1).lock(communityId, owner);
      held.release();

      expect(codeOf(await starting)).toBe('live.community_not_open');
      const [ensured] = rtc.ensured;
      expect(rtc.ended).toEqual([ensured?.roomName]);
      expect(rtc.roomNames()).toEqual([]);
      expect(
        await number(sql`select count(*)::int as n from live_sessions
                          where community_id = ${communityId}`),
      ).toBe(0);
      expect(audits()).toEqual([]);
      expect(events()).toEqual([]);
    });

    it('the lock commits after the re-asked permit: the session runs, and a LOCKED community lets it continue (Q46)', async () => {
      const {
        id: communityId,
        owner,
        students,
      } = await live(0).community('teacher-1', 'student-1');
      const paused = pauseAt(1, [live(0).sessions, 'start']);
      const starting = live(0).start.execute({ principal: owner, communityId, meta: META });
      await paused.reached;
      await live(1).lock(communityId, owner);
      paused.open();

      const started = await starting;
      if (!started.ok) throw new Error(started.error.code);
      expect(started.value.created).toBe(true);
      const sessionId = started.value.session.id;

      // community.locked → the per-session step: Communities lets it continue.
      await deliver();
      expect(await sessionState(sessionId)).toBe('live');
      const joined = await live(2).join.execute({
        principal: students[0],
        sessionId,
        meta: META,
      });
      expect(joined.ok && joined.value.role).toBe('listener');
      // And no NEW session starts while it is LOCKED — a retry answers the running one (D1).
      const retried = await live(3).start.execute({ principal: owner, communityId, meta: META });
      expect(retried.ok && [retried.value.created, retried.value.session.id]).toEqual([
        false,
        sessionId,
      ]);
    });
  });

  // ── Removal + join ─────────────────────────────────────────────────────

  describe('membership removal + join', () => {
    it('A: the removal commits before the join’s permit is read — 404, exactly as an unknown session', async () => {
      const { communityId, owner, students, session } = await scene('student-1');
      const paused = pauseAt(1, [live(0).access, 'ask']);
      const joining = live(0).join.execute({
        principal: students[0],
        sessionId: session.id,
        meta: META,
      });
      await paused.reached;
      await live(3).remove(communityId, owner, 'student-1');
      paused.open();

      const refused = await joining;
      expect(codeOf(refused)).toBe('live.session_not_found');
      const unknown = await live(0).join.execute({
        principal: students[0],
        sessionId: '00000000-0000-4000-8000-0000000fffff',
        meta: META,
      });
      expect(refused).toEqual(unknown);
      expect(rtc.issued).toEqual([]);
    });

    it('B: the removal commits after the permit — one token is minted, then the step removes the participant', async () => {
      const { communityId, owner, students, session, room } = await scene('student-1');
      const held = rtc.hold('issueAccessToken');
      const joining = live(0).join.execute({
        principal: students[0],
        sessionId: session.id,
        meta: META,
      });
      await held.reached;
      await live(3).remove(communityId, owner, 'student-1');
      held.release();

      const joined = await joining;
      expect(joined.ok && joined.value.token).toBe(`fake.${room}.student-1.sub`);
      expect(rtc.issued).toHaveLength(1);
      rtc.connect(room, 'student-1', LISTENER);

      await deliver();
      expect(rtc.observed(room).map((participant) => participant.identity)).not.toContain(
        'student-1',
      );
      expect(rtc.removed).toEqual([
        { roomName: room, identity: 'student-1', revokeTokensIssuedBefore: expect.any(Date) },
      ]);
      // And no second token.
      expect(
        codeOf(
          await live(4).join.execute({
            principal: students[0],
            sessionId: session.id,
            meta: META,
          }),
        ),
      ).toBe('live.session_not_found');
      expect(rtc.issued).toHaveLength(1);
    });
  });

  // ── Grant-basis revocation + moderation ────────────────────────────────

  describe('a capability revoked + a live operation resting on it', () => {
    it('one act completes on the earlier permit — and its audit entry names that permit: basis and grant id', async () => {
      const { communityId, owner, students, session } = await scene('student-1');
      const delegate = await live(0).delegate(
        communityId,
        owner,
        'teacher-2',
        'community.live.moderate',
      );
      const [grantId] = await live(0).grantsOf(
        communityId,
        owner,
        'teacher-2',
        'community.live.moderate',
      );
      const hand = await live(2).raised(students[0], session.id);
      clearJournals();

      const paused = pauseAt(1, [live(0).requests, 'grantWithinCap']);
      const granting = live(0).moderate.grant({
        principal: delegate,
        requestId: hand.id,
        meta: META,
      });
      await paused.reached;
      const revoked = await communities.revokeGrant.execute({
        principal: owner,
        communityId,
        grantId,
        meta: META,
      });
      expect(revoked.ok).toBe(true);
      paused.open();

      expect((await granting).ok).toBe(true);
      // The grant the act rested on had ended by the time it committed…
      expect(
        await number(sql`select count(*)::int as n from communities_capability_grants
                          where id = ${grantId} and ended_at is not null`),
      ).toBe(1);
      // …and the audit entry says exactly which standing it ran under.
      expect(audits()).toEqual([
        expect.objectContaining({
          action: 'live.speaker.granted',
          actorUserId: 'teacher-2',
          metadata: expect.objectContaining({
            permit: {
              act: 'community.live.moderate',
              basis: 'grant',
              membershipId: expect.any(String),
              grantId,
            },
          }),
        }),
      ]);
      // The next act asks afresh, and is refused.
      expect(
        codeOf(
          await live(1).moderate.revoke({ principal: delegate, requestId: hand.id, meta: META }),
        ),
      ).toBe('live.not_a_moderator');
    });
  });

  // ── The cap, the slot, the queue ───────────────────────────────────────

  describe('the database decides the cap, the slot and the queue', () => {
    it(`ten concurrent grants across five processes: exactly ${MAX_CONCURRENT_SPEAKERS} granted, the rest live.speaker_slots_full`, async () => {
      const ids = Array.from({ length: 10 }, (_, i) => `student-${i + 1}`);
      const { owner, students, session } = await scene(...ids);
      const hands: SpeakerRequestView[] = [];
      for (const [i, student] of students.entries()) {
        hands.push(await live(i).raised(student, session.id));
      }
      clearJournals();
      // Every grant is past its permits and the target's eligibility first.
      const paused = pauseAt(
        10,
        ...processes.map((each) => [each.requests, 'grantWithinCap'] as const),
      );
      const granting = hands.map((hand, i) =>
        live(i).moderate.grant({ principal: owner, requestId: hand.id, meta: META }),
      );
      await paused.reached;
      paused.open();
      const results = await Promise.all(granting);

      expect(results.filter((result) => result.ok)).toHaveLength(MAX_CONCURRENT_SPEAKERS);
      expect(results.filter((result) => !result.ok).map(codeOf)).toEqual(
        Array.from({ length: 10 - MAX_CONCURRENT_SPEAKERS }, () => 'live.speaker_slots_full'),
      );
      expect(
        await number(sql`select count(*)::int as n from live_speaker_requests
                          where session_id = ${session.id} and state = 'granted'`),
      ).toBe(MAX_CONCURRENT_SPEAKERS);
      expect(await moderationRows(session.id, 'grant_speaker')).toBe(MAX_CONCURRENT_SPEAKERS);
      expect(auditActions()).toEqual(
        Array.from({ length: MAX_CONCURRENT_SPEAKERS }, () => 'live.speaker.granted'),
      );
      expect(eventNames()).toEqual(
        Array.from({ length: MAX_CONCURRENT_SPEAKERS }, () => 'live.speaker.granted'),
      );
      expect(await versionOf(session.id)).toBe(1 + 10 + MAX_CONCURRENT_SPEAKERS);
    });

    it('two presenter claims in two processes: exactly one opens, the other 409 live.presenter_slot_taken', async () => {
      const { communityId, owner, session } = await scene();
      const rival = await live(0).delegate(
        communityId,
        owner,
        'teacher-2',
        'community.live.moderate',
      );
      clearJournals();
      const paused = pauseAt(2, [live(0).presenters, 'open'], [live(1).presenters, 'open']);
      const claiming = [owner, rival].map((claimer, i) =>
        live(i).presenter.claim({ principal: claimer, sessionId: session.id, meta: META }),
      );
      await paused.reached;
      paused.open();
      const results = await Promise.all(claiming);

      expect(results.filter((result) => result.ok && result.value.opened)).toHaveLength(1);
      expect(results.filter((result) => !result.ok).map(codeOf)).toEqual([
        'live.presenter_slot_taken',
      ]);
      expect(
        await number(sql`select count(*)::int as n from live_presenter_grants
                          where session_id = ${session.id}`),
      ).toBe(1);
      expect(await openPresenters(session.id)).toBe(1);
      expect(eventNames()).toEqual(['live.screen_share.started']);
    });

    it('twenty raises by one person across five processes: one row, ONE event, one version step', async () => {
      const { students, session } = await scene('student-1');
      clearJournals();
      // Every raise has found no open hand on the fast path, and reaches the insert.
      const paused = pauseAt(20, ...processes.map((each) => [each.requests, 'raise'] as const));
      const raising = Array.from({ length: 20 }, (_, i) =>
        live(i).raise.execute({ principal: students[0], sessionId: session.id, meta: META }),
      );
      await paused.reached;
      paused.open();
      const results = await Promise.all(raising);

      const answers = results.map((result) => {
        if (!result.ok) throw new Error(result.error.code);
        return result.value;
      });
      expect(answers.filter((answer) => answer.created)).toHaveLength(1);
      expect(new Set(answers.map((answer) => answer.request.id)).size).toBe(1);
      expect(
        await number(sql`select count(*)::int as n from live_speaker_requests
                          where session_id = ${session.id}`),
      ).toBe(1);
      expect(eventNames()).toEqual(['live.speaker.requested']);
      expect(await versionOf(session.id)).toBe(2);
    });
  });

  // ── Compare-and-set: revoke + yield, lower + grant ─────────────────────

  describe('compare-and-set races on one hand', () => {
    let owner: Principal;
    let student: Principal;
    let session: LiveSessionView;

    beforeEach(async () => {
      const world = await scene('student-1');
      ({ owner, session } = world);
      [student] = world.students;
    });

    const revoke = (process: Process, requestId: string, by = owner) =>
      process.moderate.revoke({ principal: by, requestId, meta: META });
    const lower = (process: Process) =>
      process.lower.execute({ principal: student, sessionId: session.id, meta: META });
    const grant = (process: Process, requestId: string) =>
      process.moderate.grant({ principal: owner, requestId, meta: META });

    async function speaking(): Promise<SpeakerRequestView> {
      const hand = await live(2).raised(student, session.id);
      expect((await grant(live(2), hand.id)).ok).toBe(true);
      clearJournals();
      return hand;
    }

    it('revoke + yield, the yield first: the revoke finds withdrawn — 409', async () => {
      const hand = await speaking();
      const paused = pauseAt(1, [live(0).requests, 'transition']);
      const revoking = revoke(live(0), hand.id);
      await paused.reached;
      expect((await lower(live(1))).ok).toBe(true);
      paused.open();

      expect(codeOf(await revoking)).toBe('live.invalid_transition');
      expect(await request(hand.id)).toMatchObject({ state: 'withdrawn' });
      expect(eventNames()).toEqual(['live.speaker.withdrawn']);
    });

    it('revoke + yield, the revoke first: the yield finds revoked — 409', async () => {
      const hand = await speaking();
      const paused = pauseAt(1, [live(1).requests, 'transition']);
      const lowering = lower(live(1));
      await paused.reached;
      expect((await revoke(live(0), hand.id)).ok).toBe(true);
      paused.open();

      expect(codeOf(await lowering)).toBe('live.invalid_transition');
      expect(await request(hand.id)).toMatchObject({ state: 'revoked' });
      expect(eventNames()).toEqual(['live.speaker.revoked']);
    });

    it('revoke + yield released together: exactly one wins, the loser 409', async () => {
      const hand = await speaking();
      const paused = pauseAt(2, [live(0).requests, 'transition'], [live(1).requests, 'transition']);
      const racing = [revoke(live(0), hand.id), lower(live(1))];
      await paused.reached;
      paused.open();
      const [revoked, yielded] = await Promise.all(racing);

      expect([revoked.ok, yielded.ok].filter(Boolean)).toHaveLength(1);
      expect([codeOf(revoked), codeOf(yielded)]).toContain('live.invalid_transition');
      expect((await request(hand.id))?.state).toBe(revoked.ok ? 'revoked' : 'withdrawn');
      expect(eventNames()).toHaveLength(1);
      expect(await openHands(session.id)).toBe(0);
    });

    it('two revokes released together: one applies, the loser finds its own target state — 200 unchanged', async () => {
      const hand = await speaking();
      const paused = pauseAt(2, [live(0).requests, 'transition'], [live(1).requests, 'transition']);
      const racing = [revoke(live(0), hand.id), revoke(live(1), hand.id)];
      await paused.reached;
      paused.open();
      const results = await Promise.all(racing);

      expect(results.map((result) => result.ok && result.value.request.state)).toEqual([
        'revoked',
        'revoked',
      ]);
      expect(
        results.filter((result) => result.ok && result.value.media === 'unchanged'),
      ).toHaveLength(1);
      expect(auditActions()).toEqual(['live.speaker.revoked']);
      expect(eventNames()).toEqual(['live.speaker.revoked']);
      expect(await moderationRows(session.id, 'revoke_speaker')).toBe(1);
    });

    it('lower + grant, the lower first: the grant finds withdrawn — 409', async () => {
      const hand = await live(2).raised(student, session.id);
      const paused = pauseAt(1, [live(0).requests, 'grantWithinCap']);
      const granting = grant(live(0), hand.id);
      await paused.reached;
      expect((await lower(live(1))).ok).toBe(true);
      paused.open();

      expect(codeOf(await granting)).toBe('live.invalid_transition');
      expect(await request(hand.id)).toMatchObject({ state: 'withdrawn', floor: false });
      expect(await moderationRows(session.id, 'grant_speaker')).toBe(0);
    });

    it('lower + grant, the grant first: the lower takes either open state — it yields the floor, 200', async () => {
      const hand = await live(2).raised(student, session.id);
      const paused = pauseAt(1, [live(1).requests, 'transition']);
      const lowering = lower(live(1));
      await paused.reached;
      expect((await grant(live(0), hand.id)).ok).toBe(true);
      paused.open();

      const lowered = await lowering;
      expect(lowered.ok && lowered.value.request?.state).toBe('withdrawn');
      expect(await request(hand.id)).toMatchObject({ state: 'withdrawn', floor: true });
      expect(
        events().find((event) => event.name === 'live.speaker.withdrawn')?.payload,
      ).toMatchObject({ from: 'granted' });
    });

    it('lower + grant released together: the lower always wins — withdrawn, whichever committed first', async () => {
      const hand = await live(2).raised(student, session.id);
      const paused = pauseAt(
        2,
        [live(0).requests, 'grantWithinCap'],
        [live(1).requests, 'transition'],
      );
      const racing = [grant(live(0), hand.id), lower(live(1))];
      await paused.reached;
      paused.open();
      const [granted, lowered] = await Promise.all(racing);

      expect(lowered.ok).toBe(true);
      expect(await request(hand.id)).toMatchObject({ state: 'withdrawn', floor: granted.ok });
      if (!granted.ok) expect(codeOf(granted)).toBe('live.invalid_transition');
      expect(await openHands(session.id)).toBe(0);
    });
  });
});
