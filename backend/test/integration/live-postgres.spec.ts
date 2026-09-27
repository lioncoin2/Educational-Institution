import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { MAX_CONCURRENT_SPEAKERS } from '../../src/modules/live/domain/live-limits';
import {
  LIVE_SESSION_END_REASONS,
  LIVE_SESSION_STATES,
  newLiveSession,
  type LiveSession,
} from '../../src/modules/live/domain/live-session';
import {
  MODERATION_ACTION_TYPES,
  type ModerationAction,
  type ModerationActionType,
} from '../../src/modules/live/domain/moderation';
import {
  PRESENTER_END_REASONS,
  newPresenterGrant,
} from '../../src/modules/live/domain/presenter-grant';
import {
  SPEAKER_REQUEST_STATES,
  newSpeakerRequest,
  type SpeakerRequest,
} from '../../src/modules/live/domain/speaker-request';
import { DrizzleLiveStore } from '../../src/modules/live/infrastructure/drizzle-live-repositories';
import {
  toModerationAction,
  toPresenterGrant,
} from '../../src/modules/live/infrastructure/row-mapping';
import {
  liveModerationActions,
  livePresenterGrants,
} from '../../src/modules/live/infrastructure/schema';
import { liveRepositoryContract, type LiveStores } from '../support/live-contract-suite';
import {
  describeWithPostgres,
  scratchDatabase,
  tolerateTeardown,
  type ScratchDatabase,
} from '../support/postgres';

/**
 * Live against a real Postgres (plan, commit C): the contract suite the
 * in-memory store also passes (mock parity); every CHECK and partial unique
 * index holding to account by name, and every index of live.md §10.1 as
 * defined; no foreign key leaving Live's tables; the state version stepping
 * exactly once per observable change; End of 3,000 hands in a constant number
 * of statements; the lock discipline — the session row FOR UPDATE first, the
 * admission mutex before a connection; and the invariants only the database
 * can decide, raced for real.
 *
 * Races run through several store instances over one bigger pool: each has
 * its own admission mutex, exactly as separate API processes would, so the
 * database — not the in-process queue — decides every race. Every connection
 * runs under a statement_timeout, so a deadlock or a lock that never frees
 * fails the test instead of hanging it. (The full race matrix of the audit's
 * §14, through the use cases, is live-races.spec.ts; the statement budgets and
 * plans over a churned fixture, live-scale.spec.ts.)
 *
 * One scratch database serves every test: the contract suite creates its own
 * records with fresh ids, and every other test here keeps to instants months
 * before the contract's paging window.
 */
describeWithPostgres('Live in Postgres', () => {
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

  /** A store's three ports, and what no port reads back, read with a SELECT — oldest first. */
  const storesOver = (store: DrizzleLiveStore): LiveStores => ({
    sessions: store.sessions,
    requests: store.requests,
    presenters: store.presenters,
    moderationOf: async (sessionId) =>
      (
        await db
          .select()
          .from(liveModerationActions)
          .where(eq(liveModerationActions.sessionId, sessionId))
          .orderBy(asc(liveModerationActions.at), asc(liveModerationActions.id))
      ).map(toModerationAction),
    presenterGrantsOf: async (sessionId) =>
      (
        await db
          .select()
          .from(livePresenterGrants)
          .where(eq(livePresenterGrants.sessionId, sessionId))
          .orderBy(asc(livePresenterGrants.grantedAt), asc(livePresenterGrants.id))
      ).map(toPresenterGrant),
  });

  describe('the repository contract, on Postgres (mock parity)', () => {
    liveRepositoryContract('postgres', () => storesOver(new DrizzleLiveStore(db)));
  });

  // ── Fixtures for the tests below: mid-January, far from the contract's window ──

  const ids = new UuidIdGenerator();
  const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);
  const at = (seconds: number) => new Date(T0 + seconds * 1000);
  const person = () => `user-${ids.next()}`;

  const action = (
    sessionId: string,
    type: ModerationActionType,
    actorUserId: string | null,
    targetUserId: string | null,
    when: Date,
  ): ModerationAction => ({
    id: ids.next<'ModerationAction'>(),
    sessionId,
    actorUserId,
    targetUserId,
    type,
    at: when,
  });

  const newSession = (communityId = `community-${ids.next()}`): LiveSession =>
    newLiveSession({
      id: ids.next<'LiveSession'>(),
      communityId,
      hostUserId: person(),
      at: at(0),
      participantCap: 300,
      moderatorReserve: 10,
    });

  const start = (store: DrizzleLiveStore, session: LiveSession) =>
    store.sessions.start(
      session,
      action(session.id, 'start_session', session.hostUserId, null, session.startedAt),
    );

  async function started(store: DrizzleLiveStore): Promise<LiveSession> {
    const session = newSession();
    expect(await start(store, session)).toEqual({ created: true, session });
    return session;
  }

  const hand = (session: LiveSession, userId: string, when: Date) =>
    newSpeakerRequest({
      id: ids.next<'SpeakerRequest'>(),
      sessionId: session.id,
      userId,
      at: when,
    });

  async function raised(
    store: DrizzleLiveStore,
    session: LiveSession,
    userId: string,
    when: Date,
  ): Promise<SpeakerRequest> {
    const outcome = await store.requests.raise(hand(session, userId, when));
    if (outcome === 'session_not_live' || !outcome.created) {
      throw new Error('expected a new request');
    }
    return outcome.request;
  }

  const grant = (store: DrizzleLiveStore, request: SpeakerRequest, by: string, when: Date) =>
    store.requests.grantWithinCap({
      requestId: request.id,
      cap: MAX_CONCURRENT_SPEAKERS,
      at: when,
      by,
      moderation: action(request.sessionId, 'grant_speaker', by, request.userId, when),
    });

  const claim = (store: DrizzleLiveStore, session: LiveSession, userId: string, when: Date) =>
    store.presenters.open(
      newPresenterGrant({
        id: ids.next<'PresenterGrant'>(),
        sessionId: session.id,
        userId,
        at: when,
      }),
      action(session.id, 'grant_presenter', userId, userId, when),
    );

  const end = (store: DrizzleLiveStore, session: LiveSession, when: Date) =>
    store.sessions.end({
      sessionId: session.id,
      at: when,
      endedBy: session.hostUserId,
      reason: 'moderator',
      moderation: action(session.id, 'end_session', session.hostUserId, null, when),
    });

  const count = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number(((await db.execute(query)).rows[0] as { n?: unknown } | undefined)?.n ?? 0);

  /** The version as committed — read from the table, never from a port's answer. */
  const committed = (session: LiveSession) =>
    count(sql`select state_version as n from live_sessions where id = ${session.id}`);

  describe('constraints', () => {
    let serial = 0;
    const unique = (prefix: string) => `${prefix}-${(serial += 1)}`;
    const T = `'2026-01-15T09:00:00Z'`;

    /** The constraint a raw statement violates, by name — or 'no violation'. */
    const violated = async (statement: ReturnType<typeof sql>): Promise<string> => {
      try {
        await db.execute(statement);
      } catch (error) {
        const cause = (error as { cause?: { constraint?: string } }).cause;
        return cause?.constraint ?? (error as { constraint?: string }).constraint ?? 'unknown';
      }
      return 'no violation';
    };

    /** A raw INSERT: a valid row of `table`, with `overrides` (SQL literals) in place. */
    const insert = (
      table: string,
      valid: Record<string, string>,
      overrides: Record<string, string>,
    ) => {
      const row = { ...valid, ...overrides };
      return sql.raw(
        `insert into ${table} (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`,
      );
    };

    const session = (overrides: Record<string, string> = {}) =>
      insert(
        'live_sessions',
        {
          id: `'${unique('session')}'`,
          community_id: `'${unique('community')}'`,
          host_user_id: `'host'`,
          state: `'live'`,
          state_version: '1',
          started_at: T,
          participant_cap: '300',
          moderator_reserve: '10',
        },
        overrides,
      );

    let live: LiveSession;

    beforeAll(async () => {
      live = await started(new DrizzleLiveStore(db));
    });

    const request = (overrides: Record<string, string> = {}) =>
      insert(
        'live_speaker_requests',
        {
          id: `'${unique('request')}'`,
          session_id: `'${live.id}'`,
          user_id: `'${unique('user')}'`,
          state: `'pending'`,
          requested_at: T,
        },
        overrides,
      );

    const presenterGrant = (sessionId: string, overrides: Record<string, string> = {}) =>
      insert(
        'live_presenter_grants',
        {
          id: `'${unique('grant')}'`,
          session_id: `'${sessionId}'`,
          user_id: `'presenter'`,
          granted_by: `'presenter'`,
          granted_at: T,
        },
        overrides,
      );

    const moderationRow = (overrides: Record<string, string> = {}) =>
      insert(
        'live_moderation_actions',
        {
          id: `'${unique('action')}'`,
          session_id: `'${live.id}'`,
          actor_user_id: `'moderator'`,
          type: `'grant_speaker'`,
          at: T,
        },
        overrides,
      );

    it('holds every session row to its CHECKs, by name', async () => {
      const ended = { state: `'ended'`, ended_at: T };
      const cases: [Record<string, string>, string][] = [
        [{}, 'no violation'],
        [{ ...ended, end_reason: `'idle'` }, 'no violation'],
        [{ state: `'paused'`, ended_at: T, end_reason: `'idle'` }, 'live_sessions_state_valid'],
        [{ ...ended, end_reason: `'crashed'` }, 'live_sessions_end_reason_valid'],
        [{ state_version: '0' }, 'live_sessions_state_version_positive'],
        [{ participant_cap: '0' }, 'live_sessions_participant_cap_positive'],
        [{ moderator_reserve: '-1' }, 'live_sessions_moderator_reserve_nonnegative'],
        [{ media_room_epoch: '-1' }, 'live_sessions_media_room_epoch_nonnegative'],
        [{ enforcement_violations: '-1' }, 'live_sessions_enforcement_violations_nonnegative'],
        // Live exactly while ended_at is null (S2) — both ways.
        [{ ended_at: T }, 'live_sessions_ended_at_consistent'],
        [{ state: `'ended'`, end_reason: `'idle'` }, 'live_sessions_ended_at_consistent'],
        // …and exactly while end_reason is null (S2) — both ways.
        [{ end_reason: `'idle'` }, 'live_sessions_end_reason_consistent'],
        [ended, 'live_sessions_end_reason_consistent'],
        // A moderator's end names the moderator (S2).
        [{ ...ended, end_reason: `'moderator'` }, 'live_sessions_moderator_end_named'],
        [{ ended_by: `'someone'` }, 'live_sessions_ended_by_needs_end'],
      ];
      for (const [overrides, constraint] of cases) {
        expect([overrides, await violated(session(overrides))]).toEqual([overrides, constraint]);
      }
      // No upper bound on the cap: it is configuration, never a community's size.
      expect(await violated(session({ participant_cap: String(Number.MAX_SAFE_INTEGER) }))).toBe(
        'no violation',
      );
      // An UPDATE is held to the same rules as an INSERT.
      expect(
        await violated(sql`update live_sessions set state_version = 0 where id = ${live.id}`),
      ).toBe('live_sessions_state_version_positive');
      expect(
        await violated(sql`update live_sessions set ended_by = 'someone' where id = ${live.id}`),
      ).toBe('live_sessions_ended_by_needs_end');
    });

    it('holds every speaker request to its CHECKs, by name', async () => {
      const decided = { decided_at: T, decided_by: `'moderator'` };
      const cases: [Record<string, string>, string][] = [
        [{}, 'no violation'],
        [{ state: `'declined'`, ...decided }, 'no violation'],
        [{ state: `'expired'`, decided_at: T }, 'no violation'],
        [{ state: `'raised'`, ...decided }, 'live_speaker_requests_state_valid'],
        // Decided exactly when no longer pending — both ways.
        [{ decided_at: T }, 'live_speaker_requests_decided_at_consistent'],
        [
          { state: `'declined'`, decided_by: `'moderator'` },
          'live_speaker_requests_decided_at_consistent',
        ],
        // A person decides, except while pending and on an expiry (R3).
        [{ decided_by: `'moderator'` }, 'live_speaker_requests_decided_by_consistent'],
        [{ state: `'expired'`, ...decided }, 'live_speaker_requests_decided_by_consistent'],
        [{ state: `'revoked'`, decided_at: T }, 'live_speaker_requests_decided_by_consistent'],
        // A granted request says since when.
        [{ state: `'granted'`, ...decided }, 'live_speaker_requests_granted_at_set'],
      ];
      for (const [overrides, constraint] of cases) {
        expect([overrides, await violated(request(overrides))]).toEqual([overrides, constraint]);
      }
    });

    it('holds every presenter grant and moderation row to its CHECKs, by name', async () => {
      const grants: [Record<string, string>, string][] = [
        [{ ended_at: T, end_reason: `'stopped'`, ended_by: `'presenter'` }, 'no violation'],
        [{ ended_at: T, end_reason: `'kicked'` }, 'live_presenter_grants_end_reason_valid'],
        // Closed exactly when it says why — both ways.
        [{ ended_at: T }, 'live_presenter_grants_end_consistent'],
        [{ end_reason: `'stopped'` }, 'live_presenter_grants_end_consistent'],
        [{ ended_by: `'moderator'` }, 'live_presenter_grants_ended_by_needs_end'],
      ];
      for (const [overrides, constraint] of grants) {
        expect([overrides, await violated(presenterGrant(live.id, overrides))]).toEqual([
          overrides,
          constraint,
        ]);
      }

      const actions: [Record<string, string>, string][] = [
        [{}, 'no violation'],
        [{ actor_user_id: 'null', type: `'reset_media'` }, 'no violation'],
        [{ reason_code: `'target.left_2'` }, 'no violation'],
        [{ type: `'ban_participant'` }, 'live_moderation_actions_type_valid'],
        // A reason is a code, never free text.
        [{ reason_code: `'Talked too much'` }, 'live_moderation_actions_reason_code_shape'],
        [{ reason_code: `'2fast'` }, 'live_moderation_actions_reason_code_shape'],
        [{ reason_code: `''` }, 'live_moderation_actions_reason_code_shape'],
        [{ reason_code: `'${'a'.repeat(65)}'` }, 'live_moderation_actions_reason_code_shape'],
      ];
      for (const [overrides, constraint] of actions) {
        expect([overrides, await violated(moderationRow(overrides))]).toEqual([
          overrides,
          constraint,
        ]);
      }
    });

    it('keeps one live session per community, one open request per person, one open presenter grant', async () => {
      // S1: a second live session of a community — an ended one is history, not a rival.
      const communityId = `'${unique('community')}'`;
      expect(await violated(session({ community_id: communityId }))).toBe('no violation');
      expect(await violated(session({ community_id: communityId }))).toBe(
        'live_sessions_one_live_per_community',
      );
      const endedId = unique('session');
      expect(
        await violated(
          session({
            id: `'${endedId}'`,
            community_id: communityId,
            state: `'ended'`,
            ended_at: T,
            end_reason: `'idle'`,
          }),
        ),
      ).toBe('no violation');
      // Nor can an UPDATE bring the ended one back beside the live one.
      expect(
        await violated(sql`update live_sessions set state = 'live', ended_at = null,
                                  end_reason = null where id = ${endedId}`),
      ).toBe('live_sessions_one_live_per_community');

      // R1: a second open request, pending or granted — a closed one is not open.
      const userId = `'${unique('user')}'`;
      expect(await violated(request({ user_id: userId }))).toBe('no violation');
      expect(await violated(request({ user_id: userId }))).toBe(
        'live_speaker_requests_one_open_per_person',
      );
      expect(
        await violated(
          request({
            user_id: userId,
            state: `'granted'`,
            granted_at: T,
            decided_at: T,
            decided_by: `'moderator'`,
          }),
        ),
      ).toBe('live_speaker_requests_one_open_per_person');
      expect(
        await violated(
          request({ user_id: userId, state: `'withdrawn'`, decided_at: T, decided_by: userId }),
        ),
      ).toBe('no violation');

      // P1: a second open presenter grant — a closed one is not open.
      const slot = await started(new DrizzleLiveStore(db));
      expect(await violated(presenterGrant(slot.id))).toBe('no violation');
      expect(await violated(presenterGrant(slot.id, { user_id: `'rival'` }))).toBe(
        'live_presenter_grants_one_open_per_session',
      );
      expect(
        await violated(presenterGrant(slot.id, { ended_at: T, end_reason: `'stopped'` })),
      ).toBe('no violation');
    });

    it('lists in every enumerated CHECK exactly the domain’s vocabulary, in its order', async () => {
      const listed = async (constraint: string) => {
        const [check] = (
          await db.execute(sql`
            select pg_get_constraintdef(oid) as definition from pg_constraint
             where conname = ${constraint}`)
        ).rows as { definition: string }[];
        return [...(check?.definition ?? '').matchAll(/'([a-z_]+)'::text/gu)].map(
          (match) => match[1],
        );
      };
      expect(await listed('live_sessions_state_valid')).toEqual([...LIVE_SESSION_STATES]);
      expect(await listed('live_sessions_end_reason_valid')).toEqual([...LIVE_SESSION_END_REASONS]);
      expect(await listed('live_speaker_requests_state_valid')).toEqual([
        ...SPEAKER_REQUEST_STATES,
      ]);
      expect(await listed('live_presenter_grants_end_reason_valid')).toEqual([
        ...PRESENTER_END_REASONS,
      ]);
      expect(await listed('live_moderation_actions_type_valid')).toEqual([
        ...MODERATION_ACTION_TYPES,
      ]);
    });

    it('never lets a session with history be deleted, nor a row name a session that does not exist', async () => {
      expect(await violated(sql`delete from live_sessions where id = ${live.id}`)).toBe(
        'live_moderation_actions_session_id_live_sessions_id_fk',
      );
      expect(await violated(request({ session_id: `'no-such-session'` }))).toBe(
        'live_speaker_requests_session_id_live_sessions_id_fk',
      );
      expect(await violated(presenterGrant('no-such-session'))).toBe(
        'live_presenter_grants_session_id_live_sessions_id_fk',
      );
      expect(await violated(moderationRow({ session_id: `'no-such-session'` }))).toBe(
        'live_moderation_actions_session_id_live_sessions_id_fk',
      );
    });
  });

  describe('foreign keys', () => {
    it('lets no foreign key leave Live’s tables, and no other table reference one of them', async () => {
      const keys = (
        await db.execute(sql`
          select conname as name, conrelid::regclass::text as child,
                 confrelid::regclass::text as parent, confdeltype as on_delete
            from pg_constraint
           where contype = 'f'
             and (starts_with(conrelid::regclass::text, 'live_')
                  or starts_with(confrelid::regclass::text, 'live_'))
           order by conname`)
      ).rows as { name: string; child: string; parent: string; on_delete: string }[];
      // Every key that touches a live_* table is inside Live, both ends.
      expect(
        keys.filter((key) => !key.child.startsWith('live_') || !key.parent.startsWith('live_')),
      ).toEqual([]);
      // Not vacuous: exactly the three session keys, each RESTRICT.
      expect(keys).toEqual([
        {
          name: 'live_moderation_actions_session_id_live_sessions_id_fk',
          child: 'live_moderation_actions',
          parent: 'live_sessions',
          on_delete: 'r',
        },
        {
          name: 'live_presenter_grants_session_id_live_sessions_id_fk',
          child: 'live_presenter_grants',
          parent: 'live_sessions',
          on_delete: 'r',
        },
        {
          name: 'live_speaker_requests_session_id_live_sessions_id_fk',
          child: 'live_speaker_requests',
          parent: 'live_sessions',
          on_delete: 'r',
        },
      ]);
    });
  });

  describe('indexes', () => {
    it('carries exactly the indexes of live.md §10.1, by name — each with its columns, order and predicate', async () => {
      const indexes = (
        await db.execute(sql`
          select indexname as name, indexdef as definition from pg_indexes
           where schemaname = 'public' and starts_with(tablename, 'live_')
           order by indexname`)
      ).rows;
      const on = (table: string, rest: string) => `ON public.${table} USING btree ${rest}`;
      expect(indexes).toEqual(
        [
          ['live_moderation_actions_pkey', 'UNIQUE', 'live_moderation_actions', '(id)'],
          [
            'live_moderation_actions_session_idx',
            '',
            'live_moderation_actions',
            '(session_id, at, id)',
          ],
          [
            'live_presenter_grants_closed_idx',
            '',
            'live_presenter_grants',
            '(session_id, ended_at)',
          ],
          [
            'live_presenter_grants_one_open_per_session',
            'UNIQUE',
            'live_presenter_grants',
            '(session_id) WHERE (ended_at IS NULL)',
          ],
          ['live_presenter_grants_pkey', 'UNIQUE', 'live_presenter_grants', '(id)'],
          // History, newest first: plain DESC — NULLS FIRST, as `ORDER BY … DESC` reads.
          [
            'live_sessions_community_history_idx',
            '',
            'live_sessions',
            '(community_id, started_at DESC, id DESC)',
          ],
          [
            'live_sessions_live_page_idx',
            '',
            'live_sessions',
            `(started_at, id) WHERE (state = 'live'::text)`,
          ],
          [
            'live_sessions_one_live_per_community',
            'UNIQUE',
            'live_sessions',
            `(community_id) WHERE (state = 'live'::text)`,
          ],
          ['live_sessions_pkey', 'UNIQUE', 'live_sessions', '(id)'],
          [
            'live_speaker_requests_floor_closed_idx',
            '',
            'live_speaker_requests',
            `(session_id, decided_at) WHERE ((granted_at IS NOT NULL) AND (state = ANY (ARRAY['revoked'::text, 'withdrawn'::text, 'expired'::text])))`,
          ],
          [
            'live_speaker_requests_granted_idx',
            '',
            'live_speaker_requests',
            `(session_id) WHERE (state = 'granted'::text)`,
          ],
          [
            'live_speaker_requests_one_open_per_person',
            'UNIQUE',
            'live_speaker_requests',
            `(session_id, user_id) WHERE (state = ANY (ARRAY['pending'::text, 'granted'::text]))`,
          ],
          ['live_speaker_requests_pkey', 'UNIQUE', 'live_speaker_requests', '(id)'],
          [
            'live_speaker_requests_queue_idx',
            '',
            'live_speaker_requests',
            `(session_id, requested_at, id) WHERE (state = 'pending'::text)`,
          ],
        ].map(([name, unique, table, rest]) => ({
          name,
          definition: `CREATE ${unique === '' ? '' : `${unique} `}INDEX ${name} ${on(table, rest)}`,
        })),
      );
    });
  });

  describe('the state version', () => {
    it('rises by exactly one per observable change, never for a no-op — and each answer is what committed', async () => {
      const store = new DrizzleLiveStore(db);
      const session = await started(store);
      const moderator = session.hostUserId;
      const [speaker, passed] = [person(), person()];
      const steps: [string, number | undefined, number][] = [];
      const note = async (label: string, answered: number | undefined) => {
        steps.push([label, answered, await committed(session)]);
      };
      const versionOf = (outcome: Awaited<ReturnType<typeof store.requests.raise>>) =>
        outcome === 'session_not_live' ? undefined : outcome.stateVersion;

      await note('start', session.stateVersion);
      const first = await store.requests.raise(hand(session, speaker, at(1)));
      await note('raise', versionOf(first));
      await note(
        'raise again',
        versionOf(await store.requests.raise(hand(session, speaker, at(2)))),
      );
      const floor = first === 'session_not_live' ? null : first.request;
      if (floor === null) throw new Error('expected a request');
      await note('grant', (await grant(store, floor, moderator, at(3)))?.stateVersion);
      await note('grant again', (await grant(store, floor, moderator, at(4)))?.stateVersion);
      const second = await store.requests.raise(hand(session, passed, at(5)));
      await note('another raise', versionOf(second));
      const other = second === 'session_not_live' ? null : second.request;
      if (other === null) throw new Error('expected a request');
      const decline = () =>
        store.requests.transition({
          requestId: other.id,
          from: ['pending'],
          to: 'declined',
          at: at(6),
          by: moderator,
          moderation: action(session.id, 'decline_speaker', moderator, passed, at(6)),
        });
      await note('decline', (await decline())?.stateVersion);
      await note('decline again', (await decline())?.stateVersion);
      const yieldFloor = () =>
        store.requests.transition({
          requestId: floor.id,
          from: ['pending', 'granted'],
          to: 'withdrawn',
          at: at(7),
          by: speaker,
          moderation: null,
        });
      await note('yield', (await yieldFloor())?.stateVersion);
      await note('yield again', (await yieldFloor())?.stateVersion);
      await note('claim', (await claim(store, session, moderator, at(8))).stateVersion);
      await note('claim again: held', (await claim(store, session, moderator, at(9))).stateVersion);
      await note(
        'claim by another: occupied',
        (await claim(store, session, person(), at(9))).stateVersion,
      );
      await store.sessions.markEmpty(session.id, at(10));
      await store.sessions.noteViolation(session.id, at(10));
      await note(
        'bookkeeping',
        (
          await store.sessions.bumpEpoch(
            session.id,
            0,
            action(session.id, 'reset_media', null, null, at(10)),
          )
        )?.stateVersion,
      );
      const stop = () =>
        store.presenters.close({
          sessionId: session.id,
          userId: moderator,
          by: moderator,
          reason: 'stopped',
          at: at(11),
          moderation: null,
        });
      await note('stop', (await stop()).stateVersion);
      await note('stop again', (await stop()).stateVersion);
      await note(
        'nothing to expire',
        (await store.requests.expireIneligible(session.id, person(), at(12))).stateVersion,
      );
      await note('end', (await end(store, session, at(20)))?.session.stateVersion);
      await note('end again', (await end(store, session, at(21)))?.session.stateVersion);

      expect(steps).toEqual([
        ['start', 1, 1],
        ['raise', 2, 2],
        ['raise again', 2, 2],
        ['grant', 3, 3],
        ['grant again', 3, 3],
        ['another raise', 4, 4],
        ['decline', 5, 5],
        ['decline again', 5, 5],
        ['yield', 6, 6],
        ['yield again', 6, 6],
        ['claim', 7, 7],
        ['claim again: held', 7, 7],
        ['claim by another: occupied', 7, 7],
        ['bookkeeping', 7, 7],
        ['stop', 8, 8],
        ['stop again', 8, 8],
        ['nothing to expire', 8, 8],
        ['end', 9, 9],
        ['end again', 9, 9],
      ]);
    });
  });

  interface PlanNode {
    readonly 'Node Type': string;
    readonly 'Relation Name'?: string;
    readonly 'Index Name'?: string;
    readonly 'Actual Rows'?: number;
    readonly 'Actual Loops'?: number;
    readonly Plans?: readonly PlanNode[];
  }

  const walk = (node: PlanNode | undefined, visit: (node: PlanNode) => void): void => {
    if (node === undefined) return;
    visit(node);
    for (const child of node.Plans ?? []) walk(child, visit);
  };

  /** What a statement does, and to which table — the query spy's summary. */
  const shapeOf = (statement: string): string => {
    const text = statement.trim().toLowerCase();
    if (/^select .* from "live_sessions" .* for update$/su.test(text)) return 'lock live_sessions';
    const write = /^(update|insert into|delete from) "([a-z_]+)"/u.exec(text);
    if (write !== null) return `${write[1].split(' ')[0]} ${write[2]}`;
    return text.split(/\s+/u)[0] ?? text;
  };

  describe('a crowd of 3,000 pending hands', () => {
    /** Every statement the spied store sends, with its parameters. */
    const statements: { query: string; params: unknown[] }[] = [];
    let plain: DrizzleLiveStore;
    let spied: DrizzleLiveStore;

    beforeAll(() => {
      plain = new DrizzleLiveStore(db);
      spied = new DrizzleLiveStore(
        drizzle(pool, {
          logger: {
            logQuery(query: string, params: unknown[]) {
              statements.push({ query, params });
            },
          },
        }),
      );
    });

    /** A live session: four speakers, a presenter, and `hands` pending hands seeded set-based. */
    async function crowded(hands: number): Promise<LiveSession> {
      const session = await started(plain);
      for (let n = 0; n < MAX_CONCURRENT_SPEAKERS; n += 1) {
        const speaker = await raised(plain, session, person(), at(1 + n));
        expect((await grant(plain, speaker, session.hostUserId, at(10)))?.kind).toBe('granted');
      }
      expect((await claim(plain, session, session.hostUserId, at(11))).kind).toBe('opened');
      await db.execute(sql`
        insert into live_speaker_requests (id, session_id, user_id, state, requested_at)
        select ${session.id} || '-hand-' || g, ${session.id}, 'listener-' || g, 'pending',
               ${at(20).toISOString()}::timestamptz + make_interval(secs => g)
          from generate_series(1, ${hands}) g`);
      return session;
    }

    it('counts them by reading no more rows than the cap (audit D8)', async () => {
      const crowd = await crowded(3000);
      await db.execute(sql`analyze live_speaker_requests`);
      expect(await spied.requests.countPending(crowd.id, 3)).toBe(3);
      statements.length = 0;
      expect(await spied.requests.countPending(crowd.id, 100)).toBe(100);
      const [counting] = statements;
      expect(statements).toHaveLength(1);
      // The statement the adapter sent, planned and run as it was sent: every
      // read of the requests sits beneath a Limit of the cap, and what the
      // Limit took in was no more than the cap — whatever the queue's length.
      expect(counting?.params).toEqual([crowd.id, 100]);
      const explained = await pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `explain (analyze, format json) ${counting?.query ?? ''}`,
        counting?.params,
      );
      const plan = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
      const readsRequests = (node: PlanNode) =>
        (node['Relation Name'] ?? node['Index Name'] ?? '').startsWith('live_speaker_requests');
      const limits: PlanNode[] = [];
      walk(plan, (node) => {
        if (node['Node Type'] === 'Limit') limits.push(node);
      });
      expect(limits).toHaveLength(1);
      const [limit] = limits;
      expect(limit?.['Actual Rows']).toBe(100);
      const beneath = new Set<PlanNode>();
      walk(limit, (node) => beneath.add(node));
      const readers: PlanNode[] = [];
      walk(plan, (node) => {
        if (readsRequests(node)) readers.push(node);
      });
      expect(readers.length).toBeGreaterThan(0);
      expect(readers.every((node) => beneath.has(node))).toBe(true);
      const taken = (limit?.Plans ?? []).map(
        (input) => (input['Actual Rows'] ?? 0) * (input['Actual Loops'] ?? 1),
      );
      expect(taken.length).toBeGreaterThan(0);
      expect(taken.every((rows) => rows <= 100)).toBe(true);
    });

    it('ends them, four floors and the presenter in a constant number of statements, within a time budget', async () => {
      const ending = async (session: LiveSession) => {
        statements.length = 0;
        const began = performance.now();
        const outcome = await end(spied, session, at(4000));
        const ms = performance.now() - began;
        return { outcome, statements: statements.map((statement) => statement.query), ms };
      };

      const few = await ending(await crowded(3));
      const crowd = await crowded(3000);
      expect(
        await count(sql`select count(*)::int as n from live_speaker_requests
                              where session_id = ${crowd.id} and state = 'pending'`),
      ).toBe(3000);
      const many = await ending(crowd);

      expect(many.outcome?.ended).toBe(true);
      // The statements End issues do not depend on how many hands there are:
      // a transaction of seven — the lock, the session, ONE update of every
      // open hand, ONE of the presenter grant, the end_session row.
      expect(many.statements).toEqual(few.statements);
      expect(many.statements.map(shapeOf)).toEqual([
        'begin',
        'lock live_sessions',
        'update live_sessions',
        'update live_speaker_requests',
        'update live_presenter_grants',
        'insert live_moderation_actions',
        'commit',
      ]);
      expect(many.ms).toBeLessThan(5_000);

      // Every open hand expired at the end's instant, by nobody.
      const hands = (
        await db.execute(sql`
          select state, count(*)::int as n,
                 bool_and(decided_at = ${at(4000).toISOString()}::timestamptz) as at_end,
                 bool_and(decided_by is null) as by_nobody,
                 count(granted_at)::int as floors
            from live_speaker_requests where session_id = ${crowd.id}
           group by state`)
      ).rows;
      expect(hands).toEqual([
        { state: 'expired', n: 3004, at_end: true, by_nobody: true, floors: 4 },
      ]);
      // The presenter grant closed as session_ended, by whoever ended it.
      expect(
        (
          await db.execute(sql`
            select end_reason, ended_by, ended_at = ${at(4000).toISOString()}::timestamptz as at_end
              from live_presenter_grants where session_id = ${crowd.id}`)
        ).rows,
      ).toEqual([{ end_reason: 'session_ended', ended_by: crowd.hostUserId, at_end: true }]);
      // Exactly one end_session row.
      expect(
        await count(sql`select count(*)::int as n from live_moderation_actions
                         where session_id = ${crowd.id} and type = 'end_session'`),
      ).toBe(1);
      expect(await committed(crowd)).toBe(1 + 2 * MAX_CONCURRENT_SPEAKERS + 1 + 1);
    }, 60_000);
  });

  describe('the lock discipline', () => {
    /** Every statement the spied store sends, in the order it sends them. */
    const sent: { readonly query: string; readonly params: readonly unknown[] }[] = [];
    let plain: DrizzleLiveStore;
    let spied: DrizzleLiveStore;

    beforeAll(() => {
      plain = new DrizzleLiveStore(db);
      spied = new DrizzleLiveStore(
        drizzle(pool, {
          logger: {
            logQuery(query: string, params: unknown[]) {
              sent.push({ query: query.trim().toLowerCase(), params });
            },
          },
        }),
      );
    });

    /** A statement's shape, a read named by its table and the lock by the session it locks. */
    const named = (query: string, params: readonly unknown[]): string => {
      const shape = shapeOf(query);
      if (shape === 'lock live_sessions') return `${shape} ${String(params[0])}`;
      if (shape === 'select') return `select ${/ from "([a-z_]+)"/u.exec(query)?.[1] ?? '?'}`;
      return shape;
    };

    /**
     * What one call sent: the statements outside any transaction, and each
     * transaction's statements between its BEGIN and its COMMIT.
     */
    async function sending(call: () => Promise<unknown>) {
      sent.length = 0;
      await call();
      const outside: string[] = [];
      const transactions: string[][] = [];
      let current: string[] | null = null;
      for (const { query, params } of sent) {
        if (query === 'begin') current = [];
        else if (query === 'commit' || query === 'rollback') {
          if (current !== null) transactions.push(current);
          current = null;
        } else {
          (current ?? outside).push(named(query, params));
        }
      }
      return { outside, transactions };
    }

    it('locks the session row FOR UPDATE first in every transaction that may change a session, whatever its outcome', async () => {
      const session = await started(plain);
      const host = session.hostUserId;
      const passed = await raised(plain, session, person(), at(1));
      const floor = await raised(plain, session, person(), at(2));
      const presenter = person();
      const lock = `lock live_sessions ${session.id}`;
      /** The request→session read that a call addressed by a request makes first, unlocked. */
      const resolve = 'select live_speaker_requests';

      const decline = () =>
        spied.requests.transition({
          requestId: passed.id,
          from: ['pending'],
          to: 'declined',
          at: at(5),
          by: host,
          moderation: action(session.id, 'decline_speaker', host, passed.userId, at(5)),
        });
      const stop = () =>
        spied.presenters.close({
          sessionId: session.id,
          userId: presenter,
          by: presenter,
          reason: 'stopped',
          at: at(7),
          moderation: null,
        });
      const reset = () =>
        spied.sessions.bumpEpoch(
          session.id,
          0,
          action(session.id, 'reset_media', null, null, at(9)),
        );
      const calls: [string, () => Promise<unknown>, string[]][] = [
        ['raise', () => spied.requests.raise(hand(session, person(), at(3))), []],
        ['raise again', () => spied.requests.raise(hand(session, floor.userId, at(3))), []],
        ['grant', () => grant(spied, floor, host, at(4)), [resolve]],
        ['grant again', () => grant(spied, floor, host, at(4)), [resolve]],
        ['decline', decline, [resolve]],
        ['decline again', decline, [resolve]],
        ['claim', () => claim(spied, session, presenter, at(6)), []],
        ['claim again', () => claim(spied, session, presenter, at(6)), []],
        ['stop', stop, []],
        ['stop again', stop, []],
        ['expire', () => spied.requests.expireIneligible(session.id, floor.userId, at(8)), []],
        ['expire nothing', () => spied.requests.expireIneligible(session.id, person(), at(8)), []],
        ['reset', reset, []],
        ['reset from a stale epoch', reset, []],
        ['end', () => end(spied, session, at(10)), []],
        ['end again', () => end(spied, session, at(11)), []],
        ['raise after the end', () => spied.requests.raise(hand(session, person(), at(12))), []],
        ['grant after the end', () => grant(spied, passed, host, at(13)), [resolve]],
      ];
      const seen: [string, string[], number, string | undefined][] = [];
      for (const [label, call] of calls) {
        const { outside, transactions } = await sending(call);
        const [transaction] = transactions;
        seen.push([label, outside, transactions.length, transaction?.[0]]);
      }
      // One transaction per call, whose first statement is the lock — and
      // nothing but the request's own row read before it, unlocked.
      expect(seen).toEqual(calls.map(([label, , outside]) => [label, outside, 1, lock]));
    });

    it('lets the partial unique index alone decide a start, and the bookkeeping be one conditional statement', async () => {
      const session = newSession();
      expect(await sending(() => start(spied, session))).toEqual({
        outside: [],
        transactions: [['insert live_sessions', 'insert live_moderation_actions']],
      });
      expect(await sending(() => start(spied, newSession(session.communityId)))).toEqual({
        outside: [],
        transactions: [['insert live_sessions', 'select live_sessions']],
      });
      // The arbiter is the partial unique index, named by its predicate.
      expect(
        sent.find(({ query }) => query.startsWith('insert into "live_sessions"'))?.query,
      ).toMatch(/on conflict \("community_id"\) where state = 'live' do nothing returning/u);
      for (const bookkeeping of [
        () => spied.sessions.markEmpty(session.id, at(30)),
        () => spied.sessions.markEmpty(session.id, null),
        () => spied.sessions.noteViolation(session.id, at(31)),
      ]) {
        expect(await sending(bookkeeping)).toEqual({
          outside: ['update live_sessions'],
          transactions: [],
        });
        // …conditional on live, in the statement itself.
        expect(sent[0]?.query).toContain('"live_sessions"."state" = $');
        expect(sent[0]?.params).toContain('live');
      }
    });

    it('queues a session’s transitions in process, whichever port they come through: never two of its transactions open at once', async () => {
      const session = await started(plain);
      const host = session.hostUserId;
      const hands: SpeakerRequest[] = [];
      for (let n = 0; n < 6; n += 1) hands.push(await raised(plain, session, person(), at(n)));

      sent.length = 0;
      const calls: Promise<unknown>[] = [
        ...hands.map((request) => grant(spied, request, host, at(10))),
        ...hands.map((_, n) => spied.requests.raise(hand(session, person(), at(11 + n)))),
        claim(spied, session, host, at(20)),
        spied.presenters.close({
          sessionId: session.id,
          userId: host,
          by: host,
          reason: 'stopped',
          at: at(21),
          moderation: null,
        }),
        spied.requests.expireIneligible(session.id, hands[0].userId, at(22)),
        spied.sessions.bumpEpoch(
          session.id,
          0,
          action(session.id, 'reset_media', null, null, at(23)),
        ),
      ];
      await Promise.all(calls);

      // The admission mutex is taken before a connection: a call waits in
      // memory, so each transaction begins only once the last has committed.
      let open = 0;
      let deepest = 0;
      let begun = 0;
      for (const { query } of sent) {
        if (query === 'begin') {
          begun += 1;
          open += 1;
          deepest = Math.max(deepest, open);
        } else if (query === 'commit' || query === 'rollback') {
          open -= 1;
        }
      }
      expect({ begun, deepest }).toEqual({ begun: calls.length, deepest: 1 });
    });
  });

  describe('races across processes', () => {
    /** Several processes' worth of stores: each has its own admission mutex. */
    let stores: DrizzleLiveStore[];
    const store = (i: number) => stores[i % stores.length];

    beforeEach(() => {
      stores = Array.from({ length: 5 }, () => new DrizzleLiveStore(db));
    });

    // The lock order should make deadlocks impossible. A retried victim
    // succeeds and hides in every outcome, so the retries are counted instead.
    afterEach(() => {
      expect(stores.map((each) => each.deadlockRetries)).toEqual([0, 0, 0, 0, 0]);
    });

    it('twenty starts for one community: exactly one creates, and every caller gets it', async () => {
      const communityId = `community-${ids.next()}`;
      const candidates = Array.from({ length: 20 }, () => newSession(communityId));
      const outcomes = await Promise.all(candidates.map((session, i) => start(store(i), session)));
      expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => outcome.session.id)).size).toBe(1);
      expect(
        await count(sql`select count(*)::int as n from live_sessions
                         where community_id = ${communityId}`),
      ).toBe(1);
      expect(
        await count(sql`select count(*)::int as n from live_moderation_actions m
                          join live_sessions s on s.id = m.session_id
                         where s.community_id = ${communityId}`),
      ).toBe(1);
    });

    it('twenty raises by one person: one open request, one version step', async () => {
      const session = await started(store(0));
      const userId = person();
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) => store(i).requests.raise(hand(session, userId, at(i)))),
      );
      const answers = outcomes.flatMap((outcome) =>
        outcome === 'session_not_live' ? [] : [outcome],
      );
      expect(answers).toHaveLength(20);
      expect(answers.filter((answer) => answer.created)).toHaveLength(1);
      expect(new Set(answers.map((answer) => answer.request.id)).size).toBe(1);
      expect(
        await count(sql`select count(*)::int as n from live_speaker_requests
                         where session_id = ${session.id} and user_id = ${userId}`),
      ).toBe(1);
      expect(await committed(session)).toBe(2);
    });

    it('twelve grants of distinct pending hands: exactly four granted, the rest slots_full', async () => {
      const session = await started(store(0));
      const hands: SpeakerRequest[] = [];
      for (let n = 0; n < 12; n += 1) hands.push(await raised(store(n), session, person(), at(n)));
      const outcomes = await Promise.all(
        hands.map((request, i) => grant(store(i), request, session.hostUserId, at(20))),
      );
      const kinds = outcomes.map((outcome) => outcome?.kind);
      expect(kinds.filter((kind) => kind === 'granted')).toHaveLength(MAX_CONCURRENT_SPEAKERS);
      expect(kinds.filter((kind) => kind === 'slots_full')).toHaveLength(
        12 - MAX_CONCURRENT_SPEAKERS,
      );
      expect(
        await count(sql`select count(*)::int as n from live_speaker_requests
                         where session_id = ${session.id} and state = 'granted'`),
      ).toBe(MAX_CONCURRENT_SPEAKERS);
      expect(
        await count(sql`select count(*)::int as n from live_moderation_actions
                         where session_id = ${session.id} and type = 'grant_speaker'`),
      ).toBe(MAX_CONCURRENT_SPEAKERS);
      expect(await committed(session)).toBe(1 + 12 + MAX_CONCURRENT_SPEAKERS);
    });

    it('ten presenter claims by distinct moderators: one opened, the rest occupied by it', async () => {
      const session = await started(store(0));
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) => claim(store(i), session, `moderator-${i}`, at(5))),
      );
      const opened = outcomes.filter((outcome) => outcome.kind === 'opened');
      expect(opened).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === 'occupied')).toHaveLength(9);
      expect(new Set(outcomes.map((outcome) => outcome.grant?.id))).toEqual(
        new Set([opened[0]?.grant?.id]),
      );
      expect(
        await count(sql`select count(*)::int as n from live_presenter_grants
                         where session_id = ${session.id}`),
      ).toBe(1);
      expect(await committed(session)).toBe(2);
    });

    it('End racing raises and grants: after End nothing is open, and nothing changes', async () => {
      const session = await started(store(0));
      const waiting: SpeakerRequest[] = [];
      for (let n = 0; n < 8; n += 1) waiting.push(await raised(store(n), session, person(), at(n)));
      const raises = Array.from({ length: 10 }, (_, i) =>
        store(i).requests.raise(hand(session, person(), at(30 + i))),
      );
      const grants = waiting.map((request, i) =>
        grant(store(i + 1), request, session.hostUserId, at(40 + i)),
      );
      const [ended, raiseOutcomes, grantOutcomes] = await Promise.all([
        end(store(2), session, at(50)),
        Promise.all(raises),
        Promise.all(grants),
      ]);
      expect(ended?.ended).toBe(true);

      // Whatever committed first, End closed; whatever came after, it refused.
      const created = raiseOutcomes.flatMap((outcome) =>
        outcome === 'session_not_live' ? [] : [outcome],
      );
      expect(created.every((outcome) => outcome.created)).toBe(true);
      const floors = grantOutcomes.filter((outcome) => outcome?.kind === 'granted').length;
      expect(
        grantOutcomes.every((outcome) =>
          ['granted', 'slots_full', 'session_not_live'].includes(outcome?.kind ?? ''),
        ),
      ).toBe(true);
      // One version step per change that committed before End, then End's own.
      expect(ended?.session.stateVersion).toBe(1 + 8 + created.length + floors + 1);

      const openAfter = () =>
        count(sql`select count(*)::int as n from live_speaker_requests
                   where session_id = ${session.id} and state in ('pending', 'granted')`);
      const snapshot = async () =>
        (
          await db.execute(sql`
            select id, state, decided_at, decided_by from live_speaker_requests
             where session_id = ${session.id} order by id`)
        ).rows;
      expect(await openAfter()).toBe(0);
      expect(
        await count(sql`select count(*)::int as n from live_speaker_requests
                         where session_id = ${session.id} and state = 'expired'`),
      ).toBe(8 + created.length);
      expect(await committed(session)).toBe(ended?.session.stateVersion);

      // And nothing changes after it, through any process.
      const before = await snapshot();
      expect(await store(3).requests.raise(hand(session, person(), at(60)))).toBe(
        'session_not_live',
      );
      expect((await grant(store(4), waiting[0], session.hostUserId, at(61)))?.kind).toBe(
        'session_not_live',
      );
      expect((await claim(store(0), session, session.hostUserId, at(62))).kind).toBe(
        'session_not_live',
      );
      expect(await snapshot()).toEqual(before);
      expect(await committed(session)).toBe(ended?.session.stateVersion);
    });
  });
});
