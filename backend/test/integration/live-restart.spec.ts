import { sql } from 'drizzle-orm';

import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import { capabilitiesFor } from '../../src/modules/live/domain/standing';
import { DrizzleLiveStore } from '../../src/modules/live/infrastructure/drizzle-live-repositories';
import { communitiesHarness } from '../support/communities-harness';
import { AdjustableClock } from '../support/identity-harness';
import { META, captureLogs, liveHarnessOver, type LoggedLine } from '../support/live-harness';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
  presenterDelegated: false,
});
const MICROPHONE = { ...LISTENER, canPublishAudio: true };

/** How long the restart takes: well inside the enforcement window. */
const DOWNTIME_SECONDS = 45;

/**
 * A backend restart (live.md §11.5): all truth is in Postgres, and nothing
 * in memory survives.
 *
 * "Module A" — Live's use cases over a Drizzle store on a scratch database,
 * with Communities on its own Drizzle repository and read model over the
 * same database — starts a session, grants one hand and revokes another, and
 * is discarded: its fake provider (with the room), LiveMedia, RoomOccupancy,
 * reconciler and store instances go with it.
 *
 * "Module B" is built from nothing but the database: a NEW Drizzle store for
 * Live, NEW Drizzle repositories for Communities, a NEW fake provider with
 * no rooms, a new LiveMedia, RoomOccupancy and reconciler, a clock that goes
 * on from A's, and ids no earlier process can have used. Identity's account
 * directory — its own persisted store in production — is told the same
 * accounts again. Communities is on Postgres rather than shared in memory so
 * that nothing at all crosses the restart but the database.
 */
describeWithPostgres('Live across a restart', () => {
  let scratch: ScratchDatabase;
  let logs: ReturnType<typeof captureLogs>;

  beforeAll(async () => {
    scratch = await scratchDatabase();
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => jest.restoreAllMocks());

  /** Live and Communities over the scratch database, every adapter instance new. */
  function boot(options: { clock?: AdjustableClock; freshIds?: boolean } = {}) {
    const communities = communitiesHarness({
      store: new DrizzleCommunityRepository(scratch.db),
      readModel: new DrizzleCommunityReadModel(scratch.db),
      clock: options.clock,
      ids: options.freshIds === true ? new UuidIdGenerator() : undefined,
    });
    return liveHarnessOver(new DrizzleLiveStore(scratch.db), { communities });
  }

  const events = (lines: readonly LoggedLine[]) => lines.map((line) => line.fields.event);

  it('re-ensures the room at boot, admits the granted speaker with the microphone, and watches a floor closed before the restart — from Postgres alone', async () => {
    // ── Module A ─────────────────────────────────────────────────────────
    const a = boot();
    const {
      id: communityId,
      owner,
      students,
    } = await a.community('teacher-1', 'student-1', 'student-2');
    const [speaker, revoked] = students;
    const session = await a.startSession(owner, communityId);
    const room = a.room(session.id);

    const hand = await a.raised(speaker, session.id);
    const granted = await a.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    expect(granted.ok).toBe(true);
    const other = await a.raised(revoked, session.id);
    await a.moderate.grant({ principal: owner, requestId: other.id, meta: META });
    a.clock.advance(30);
    const revocation = await a.moderate.revoke({
      principal: owner,
      requestId: other.id,
      meta: META,
    });
    expect(revocation.ok).toBe(true);
    // A's provider holds the room; nobody had connected, so both pushes
    // stayed unsettled in A's memory — which is about to be lost.
    expect(a.rtc.roomNames()).toEqual([room]);
    expect(a.media.unsettled().length).toBeGreaterThan(0);
    const restartedAt = new Date(a.clock.now().getTime() + DOWNTIME_SECONDS * 1000);

    // ── Module B: nothing but the database ───────────────────────────────
    const b = boot({ clock: new AdjustableClock(restartedAt), freshIds: true });
    b.person('teacher-1', ['TEACHER']);
    const speakerAgain = b.person('student-1', ['STUDENT']);
    b.person('student-2', ['STUDENT']);
    expect(b.store).not.toBe(a.store);
    expect(b.rtc.roomNames()).toEqual([]);
    expect(b.media.unsettled()).toEqual([]);
    const booted = logs.lines.length;

    // The boot pass: rooms, participants, then the watch.
    b.reconciler.onApplicationBootstrap();
    await b.reconciler.stop();

    expect(b.rtc.roomNames()).toEqual([room]);
    expect(b.rtc.ensured.map((spec) => spec.roomName)).toEqual([room]);
    expect(events(logs.lines.slice(booted))).toContain('live.reconciler.room_ensured');
    // The session goes on, as it was; nobody's floor was touched.
    const stored = await b.sessions.findById(session.id);
    expect(stored).toMatchObject({ state: 'live', mediaRoomEpoch: 0 });
    expect((await b.requests.findById(hand.id))?.state).toBe('granted');
    expect((await b.requests.findById(other.id))?.state).toBe('revoked');

    // The granted speaker joins B: the microphone, computed from Postgres.
    const joined = await b.join.execute({
      principal: speakerAgain,
      sessionId: session.id,
      meta: META,
    });
    if (!joined.ok) throw new Error(joined.error.code);
    expect(joined.value).toMatchObject({
      role: 'speaker',
      media: { microphone: true, screen: false, screenAudio: false },
    });
    expect(b.rtc.issued).toEqual([
      expect.objectContaining({ roomName: room, identity: 'student-1', capabilities: MICROPHONE }),
    ]);

    // The speaker revoked before the restart comes back publishing on a
    // refreshed token. B never saw the revocation — no watch entry, no
    // unsettled push — yet its watch finds the closed floor in Postgres.
    expect(b.media.unsettled()).toEqual([]);
    b.rtc.connect(room, 'student-2', MICROPHONE, ['microphone']);
    const from = b.rtc.calls.length;

    expect(await b.reconciler.watchTick()).toMatchObject({
      skipped: null,
      sessions: 1,
      checked: 1,
      corrected: 1,
      violations: 0,
    });
    expect(b.rtc.calls.slice(from).map((call) => [call.operation, call.identity])).toEqual([
      ['getParticipant', 'student-2'],
      ['updateCapabilities', 'student-2'],
    ]);
    expect(b.rtc.capabilityChanges).toEqual([
      { roomName: room, identity: 'student-2', capabilities: LISTENER },
    ]);
    expect(b.rtc.observed(room).find((p) => p.identity === 'student-2')?.publishing).toEqual([]);

    // A was never started, and B's work is all B's: A's provider saw none of it.
    expect(a.rtc.calls.some((call) => call.at.getTime() >= restartedAt.getTime())).toBe(false);
    expect(
      Number(
        (
          await scratch.db.execute(
            sql`select count(*)::int as n from live_sessions where state = 'live'`,
          )
        ).rows[0]?.n,
      ),
    ).toBe(1);
  });
});
