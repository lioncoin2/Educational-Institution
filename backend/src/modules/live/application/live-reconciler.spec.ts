import { MODULE_METADATA } from '@nestjs/common/constants';

import type { Principal } from '../../../shared';
import {
  META,
  captureLogs,
  liveHarness,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import {
  IDLE_END_SECONDS,
  LIVE_SESSIONS_PAGE_MAX,
  ORPHAN_GRACE_SECONDS,
  PARTICIPANT_SWEEP_SECONDS,
  ROOM_PROVIDER_TIMEOUT_SECONDS,
  ROOM_SWEEP_SECONDS,
  WATCH_TICK_SECONDS,
} from '../domain/live-limits';
import { mediaRoomName } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import { capabilitiesFor } from '../domain/standing';
import { DisabledRtcProvider } from '../infrastructure/disabled-rtc-provider';
import { LiveModule } from '../live.module';
import { LiveReconciler } from './live-reconciler';
import type { LiveSessionView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});
const MICROPHONE = { ...LISTENER, canPublishAudio: true };

/** A session id no live session has — a room of this deployment's form that nobody claims. */
const NOBODYS_SESSION = '00000000-0000-4000-8000-00000000dead';

/** A promise the test resolves when it chooses, and one that says when it was reached. */
function gate(): { readonly promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The reconciler's room sweep and its controls (live.md §11.1–11.2, §11.5;
 * audit D19, D23): missing rooms re-created and re-checked, the idle clock,
 * orphans past their grace — and never anything on an incomplete picture:
 * a failed page of live sessions, an outage, a fault. Every test drives the
 * ticks itself, on the harness's fake provider and adjustable clock.
 */
describe('LiveReconciler — rooms and control', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let session: LiveSessionView;
  let room: string;
  /** Every line logged — silenced, and read where a test is about it. */
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    logs = captureLogs();
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = world);
    session = await h.startSession(owner, communityId);
    room = h.room(session.id);
    h.journal.clear();
  });

  afterEach(async () => {
    await h.reconciler.stop();
    jest.restoreAllMocks();
  });

  describe('the room sweep', () => {
    it('re-creates a live session’s missing room — the cap and reserve, the provider’s timeouts — and keeps it', async () => {
      await h.rtc.endRoom(room);
      logs.lines.length = 0;

      const report = await h.reconciler.sweepRooms();

      expect(report).toEqual({
        skipped: null,
        sessions: 1,
        sessionsSkipped: 0,
        ensured: 1,
        idleEnded: 0,
        orphansEnded: 0,
      });
      expect(h.rtc.ensured.at(-1)).toEqual({
        roomName: room,
        maxParticipants: 310,
        emptyTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
        departureTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
      });
      expect(h.rtc.roomNames()).toEqual([room]);
      expect(logs.lines).toContainEqual({
        level: 'log',
        fields: { event: 'live.reconciler.room_ensured', sessionId: session.id, epoch: 0 },
      });
      // A room just made has nobody in it: a join reuses that sample.
      expect(await h.occupancy.sample(room)).toEqual({ kind: 'present', occupancy: 0 });
    });

    it('re-reads the session after the ensure: an end committed meanwhile ends the stray room (§4.4)', async () => {
      await h.rtc.endRoom(room);
      const held = h.rtc.hold('ensureRoom');
      const sweeping = h.reconciler.sweepRooms();
      await held.reached;
      expect(
        (await h.end.execute({ principal: owner, sessionId: session.id, meta: META })).ok,
      ).toBe(true);
      held.release();

      expect(await sweeping).toMatchObject({ skipped: null, ensured: 0 });
      expect(h.rtc.roomNames()).toEqual([]);
      expect(h.rtc.ended.filter((name) => name === room)).toHaveLength(3);
    });

    it('re-reads the session after the ensure: a media reset committed meanwhile ends the old room it re-created', async () => {
      await h.rtc.endRoom(room);
      const held = h.rtc.hold('ensureRoom');
      const sweeping = h.reconciler.sweepRooms();
      await held.reached;
      // A reset elsewhere moves the session to epoch 1 while the old room is being made.
      expect(await h.sessions.bumpEpoch(session.id, 0, resetRow(session.id))).not.toBeNull();
      held.release();

      expect(await sweeping).toMatchObject({ skipped: null, ensured: 0 });
      expect(h.rtc.room(room)).toBeNull();

      // The next sweep ensures the room the session uses now.
      expect(await h.reconciler.sweepRooms()).toMatchObject({ ensured: 1 });
      expect(h.rtc.roomNames()).toEqual([h.room(session.id, 1)]);
    });

    it('sets `empty_since` at the first empty observation, keeps it while empty, and clears it when someone is there', async () => {
      const startedAt = h.clock.now();
      await h.reconciler.sweepRooms();
      expect((await h.session(session.id)).emptySince).toEqual(startedAt);

      h.clock.advance(ROOM_SWEEP_SECONDS);
      await h.reconciler.sweepRooms();
      // The first observation stands: the idle clock never restarts while empty.
      expect((await h.session(session.id)).emptySince).toEqual(startedAt);

      h.rtc.connect(room, 'student-1', LISTENER);
      h.clock.advance(ROOM_SWEEP_SECONDS);
      await h.reconciler.sweepRooms();
      expect((await h.session(session.id)).emptySince).toBeNull();
    });

    it('ends the session `idle` once its room has been empty IDLE_END_SECONDS — not a second before', async () => {
      logs.lines.length = 0;
      await h.reconciler.sweepRooms();
      h.clock.advance(IDLE_END_SECONDS - 1);
      expect(await h.reconciler.sweepRooms()).toMatchObject({ idleEnded: 0 });
      expect((await h.session(session.id)).state).toBe('live');

      h.clock.advance(1);
      expect(await h.reconciler.sweepRooms()).toMatchObject({ idleEnded: 1 });
      const ended = await h.session(session.id);
      expect(ended).toMatchObject({ state: 'ended', endReason: 'idle', endedBy: null });
      expect(h.journal.order).toEqual(['audit:live.session.ended', 'event:live.session.ended']);
      expect(h.journal.entries[0]?.actorUserId).toBeNull();
      expect(h.rtc.room(room)).toBeNull();
      expect(logs.lines).toContainEqual({
        level: 'log',
        fields: { event: 'live.reconciler.session_ended', sessionId: session.id, reason: 'idle' },
      });
    });

    it('never ends a room someone is in, however long it was empty before', async () => {
      await h.reconciler.sweepRooms();
      h.clock.advance(IDLE_END_SECONDS + 60);
      h.rtc.connect(room, 'student-1', LISTENER);
      expect(await h.reconciler.sweepRooms()).toMatchObject({ idleEnded: 0 });
      expect((await h.session(session.id)).state).toBe('live');
    });

    it('counts a missing room as observed empty, so a session whose room keeps disappearing still ends idle', async () => {
      for (let elapsed = 0; elapsed <= IDLE_END_SECONDS; elapsed += ROOM_SWEEP_SECONDS) {
        await h.rtc.endRoom(room);
        await h.reconciler.sweepRooms();
        h.clock.advance(ROOM_SWEEP_SECONDS);
      }
      expect((await h.session(session.id)).endReason).toBe('idle');
    });

    it('ends a room of this deployment’s form that no live session claims — only once its grace has passed', async () => {
      const orphan = mediaRoomName('live-', NOBODYS_SESSION, 0);
      await h.rtc.ensureRoom(spec(orphan));
      logs.lines.length = 0;

      h.clock.advance(ORPHAN_GRACE_SECONDS - 1);
      expect(await h.reconciler.sweepRooms()).toMatchObject({ orphansEnded: 0 });
      expect(h.rtc.room(orphan)).not.toBeNull();

      h.clock.advance(1);
      expect(await h.reconciler.sweepRooms()).toMatchObject({ orphansEnded: 1 });
      expect(h.rtc.room(orphan)).toBeNull();
      // The live session's own room, as old, is never an orphan.
      expect(h.rtc.roomNames()).toEqual([room]);
      expect(logs.lines).toContainEqual({
        level: 'log',
        fields: { event: 'live.reconciler.orphan_ended', sessionId: NOBODYS_SESSION, epoch: 0 },
      });
    });

    it('treats a reset session’s old epoch as an orphan, and its current room as its own', async () => {
      expect(await h.sessions.bumpEpoch(session.id, 0, resetRow(session.id))).not.toBeNull();
      h.clock.advance(ORPHAN_GRACE_SECONDS);

      expect(await h.reconciler.sweepRooms()).toMatchObject({ ensured: 1, orphansEnded: 1 });
      expect(h.rtc.roomNames()).toEqual([h.room(session.id, 1)]);
    });

    it('never touches a room of another deployment, or of no deployment, however old', async () => {
      const foreign = [
        mediaRoomName('staging-', NOBODYS_SESSION, 0),
        // A prefix that merely starts with this one is another deployment's.
        mediaRoomName('live-prod-', NOBODYS_SESSION, 3),
        'lobby',
        `live-${NOBODYS_SESSION}.0`,
      ];
      for (const name of foreign) await h.rtc.ensureRoom(spec(name));
      h.clock.advance(ORPHAN_GRACE_SECONDS * 10);

      expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: null, orphansEnded: 0 });
      expect(h.rtc.roomNames()).toEqual([room, ...foreign]);
      expect(h.rtc.ended).toEqual([]);
    });

    it('never ends the room of a start still in flight: its grace covers the time from ensure to insert', async () => {
      const other = await h.community('teacher-2');
      // Start stops after its room is made, before the session is stored (its D20 re-ask).
      const asked = gate();
      const resume = gate();
      const ask = h.access.ask.bind(h.access);
      let asks = 0;
      jest.spyOn(h.access, 'ask').mockImplementation(async (...args) => {
        if (args[1] === other.id && ++asks === 2) {
          asked.open();
          await resume.promise;
        }
        return ask(...args);
      });
      const starting = h.start.execute({
        principal: other.owner,
        communityId: other.id,
        meta: META,
      });
      await asked.promise;
      const [inFlight] = h.rtc.roomNames().filter((name) => name !== room);
      expect(inFlight).toBeDefined();

      h.clock.advance(ORPHAN_GRACE_SECONDS - 1);
      expect(await h.reconciler.sweepRooms()).toMatchObject({ orphansEnded: 0 });
      expect(h.rtc.roomNames()).toContain(inFlight);

      resume.open();
      const started = await starting;
      if (!started.ok) throw new Error(started.error.code);
      expect(h.room(started.value.session.id)).toBe(inFlight);
      h.clock.advance(ORPHAN_GRACE_SECONDS);
      expect(await h.reconciler.sweepRooms()).toMatchObject({ orphansEnded: 0 });
      expect(h.rtc.roomNames()).toContain(inFlight);
    });

    it('never ends a room the sweep did not see claimed because the session started after its read', async () => {
      const listing = h.rtc.hold('listRooms');
      const sweeping = h.reconciler.sweepRooms();
      await listing.reached;
      const other = await h.community('teacher-2');
      const started = await h.startSession(other.owner, other.id);
      listing.release();

      expect(await sweeping).toMatchObject({ sessions: 1, orphansEnded: 0 });
      expect(h.rtc.room(h.room(started.id))).not.toBeNull();
    });

    it('measures the grace from the read of the live sessions, not from the end of a slow sweep', async () => {
      // The sweep reads one live session, then — before it lists the rooms —
      // another session starts: its room is listed, the session is not.
      await h.rtc.endRoom(room);
      const listing = h.rtc.hold('listRooms');
      const sweeping = h.reconciler.sweepRooms();
      await listing.reached;
      const other = await h.community('teacher-2');
      const started = await h.startSession(other.owner, other.id);
      // Re-creating the first session's missing room then takes the whole grace.
      const ensuring = h.rtc.hold('ensureRoom');
      listing.release();
      await ensuring.reached;
      h.clock.advance(ORPHAN_GRACE_SECONDS);
      ensuring.release();

      expect(await sweeping).toMatchObject({ sessions: 1, ensured: 1, orphansEnded: 0 });
      expect(h.rtc.room(h.room(started.id))).not.toBeNull();
      expect(h.rtc.ended).not.toContain(h.room(started.id));
    });
  });

  describe('the room sweep, over more than one page of live sessions (audit D23)', () => {
    let sessionIds: string[];
    const orphan = mediaRoomName('live-', NOBODYS_SESSION, 0);

    beforeEach(async () => {
      // One more session than a page holds, each started as production starts
      // one — ten per administrator, inside both creation and start limits.
      sessionIds = [session.id];
      while (sessionIds.length <= LIVE_SESSIONS_PAGE_MAX) {
        const admin = h.person(`admin-${Math.floor(sessionIds.length / 10)}`, ['ADMIN']);
        const id = await h.communities.community(admin);
        sessionIds.push((await h.startSession(admin, id)).id);
      }
      await h.rtc.ensureRoom(spec(orphan));
      await h.rtc.endRoom(room);
      h.clock.advance(ORPHAN_GRACE_SECONDS);
    });

    it('pages every live session, so no room on a later page is taken for an orphan', async () => {
      const report = await h.reconciler.sweepRooms();
      expect(report).toMatchObject({
        skipped: null,
        sessions: LIVE_SESSIONS_PAGE_MAX + 1,
        ensured: 1,
        orphansEnded: 1,
      });
      expect(new Set(h.rtc.roomNames())).toEqual(new Set(sessionIds.map((id) => h.room(id))));
    });

    it('deletes nothing, ensures nothing and marks nothing when the SECOND page fails', async () => {
      const listLive = h.sessions.listLive.bind(h.sessions);
      let pages = 0;
      jest.spyOn(h.sessions, 'listLive').mockImplementation(async (after, limit) => {
        if (++pages === 2) throw new Error('connection terminated');
        return listLive(after, limit);
      });
      logs.lines.length = 0;
      const calls = h.rtc.calls.length;

      expect(await h.reconciler.sweepRooms()).toMatchObject({
        skipped: 'failed',
        ensured: 0,
        orphansEnded: 0,
      });
      expect(pages).toBe(2);
      // Not even the room list was read: an incomplete set decides nothing.
      expect(h.rtc.calls.slice(calls)).toEqual([]);
      expect(h.rtc.room(orphan)).not.toBeNull();
      for (const id of sessionIds) expect((await h.session(id)).emptySince).toBeNull();
      expect(logs.lines).toEqual([
        {
          level: 'error',
          fields: {
            event: 'live.reconciler.tick_skipped',
            tick: 'rooms',
            err: { name: 'Error' },
          },
        },
      ]);
    });
  });

  describe('failures of the room sweep', () => {
    it('does nothing when the room list cannot be read: an outage is `provider_unavailable`, a fault `failed`', async () => {
      const orphan = mediaRoomName('live-', NOBODYS_SESSION, 0);
      await h.rtc.ensureRoom(spec(orphan));
      h.clock.advance(ORPHAN_GRACE_SECONDS);
      h.rtc.failNext('listRooms', 'unavailable');
      expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: 'provider_unavailable' });
      h.rtc.failNext('listRooms', 'fault');
      expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: 'failed' });
      expect(h.rtc.room(orphan)).not.toBeNull();
      expect((await h.session(session.id)).emptySince).toBeNull();
    });

    it('skips one session on a fault and carries on with the rest', async () => {
      const other = await h.community('teacher-2');
      const second = await h.startSession(other.owner, other.id);
      await h.rtc.endRoom(room);
      await h.rtc.endRoom(h.room(second.id));
      h.rtc.failNext('ensureRoom', 'fault');
      logs.lines.length = 0;

      expect(await h.reconciler.sweepRooms()).toMatchObject({
        skipped: null,
        sessions: 2,
        sessionsSkipped: 1,
        ensured: 1,
      });
      expect(logs.lines).toContainEqual({
        level: 'error',
        fields: {
          event: 'live.reconciler.session_skipped',
          stage: 'rooms',
          sessionId: session.id,
          err: { name: 'Error' },
        },
      });
      // The message — which could echo a request — is never logged.
      expect(JSON.stringify(logs.lines)).not.toContain('refused');
    });

    it('stops the tick at an outage midway: nothing more is asked of a provider that is down', async () => {
      const other = await h.community('teacher-2');
      await h.startSession(other.owner, other.id);
      await h.rtc.endRoom(room);
      h.rtc.failNext('ensureRoom', 'unavailable');
      const calls = h.rtc.calls.length;

      expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: 'provider_unavailable' });
      expect(h.rtc.calls.slice(calls).map((call) => call.operation)).toEqual([
        'listRooms',
        'ensureRoom',
      ]);
    });

    it('does nothing when the store fails while re-reading a session, and says so by class', async () => {
      await h.rtc.endRoom(room);
      jest.spyOn(h.sessions, 'findById').mockRejectedValue(new TypeError('socket hang up'));
      expect(await h.reconciler.sweepRooms()).toMatchObject({ sessionsSkipped: 1, ensured: 0 });
      expect(h.rtc.roomNames()).toEqual([]);
    });
  });

  describe('the provider’s state, logged once per change (audit D19)', () => {
    it('with the disabled provider, skips every tick and logs exactly one line across many', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE);
      const reconciler = h.reconcilerWith(new DisabledRtcProvider());
      logs.lines.length = 0;

      for (let tick = 0; tick < 5; tick += 1) {
        expect(await reconciler.sweepRooms()).toMatchObject({ skipped: 'provider_unavailable' });
        expect(await reconciler.sweepParticipants()).toMatchObject({
          skipped: 'provider_unavailable',
        });
        expect(await reconciler.watchTick()).toMatchObject({ skipped: null, checked: 0 });
        expect(await reconciler.checkIdentities(session.id, ['student-1'])).toMatchObject({
          outcome: 'provider_unavailable',
        });
        h.clock.advance(WATCH_TICK_SECONDS);
      }

      expect(logs.lines).toEqual([
        { level: 'warn', fields: { event: 'live.reconciler.provider_unavailable' } },
      ]);
      // Nothing was decided on a provider that could not be asked.
      expect((await h.session(session.id)).emptySince).toBeNull();
      expect(h.journal.order).toEqual([]);
    });

    it('logs the outage when it starts and the recovery when it ends — never per tick', async () => {
      logs.lines.length = 0;
      h.rtc.setUnavailable(true);
      for (let tick = 0; tick < 3; tick += 1) await h.reconciler.sweepRooms();
      h.rtc.setUnavailable(false);
      for (let tick = 0; tick < 3; tick += 1) await h.reconciler.sweepRooms();

      expect(logs.events()).toEqual([
        'live.reconciler.provider_unavailable',
        'live.reconciler.provider_available',
      ]);
    });

    // P7.2 decision Q-B: refused credentials, TLS or a wrong endpoint fail
    // every call alike — the tick stops at the first, as at an outage, and
    // says so once, as an error: waiting fixes nothing.
    it('stops every tick at a configuration the provider refuses, and logs it once, with its reason', async () => {
      const other = await h.community('teacher-2');
      await h.startSession(other.owner, other.id);
      h.rtc.connect(room, 'student-1', MICROPHONE);
      logs.lines.length = 0;

      for (let tick = 0; tick < 3; tick += 1) {
        h.rtc.failNext('listRooms', 'misconfigured');
        expect(await h.reconciler.sweepRooms()).toMatchObject({
          skipped: 'provider_misconfigured',
          sessionsSkipped: 0,
        });
        h.rtc.failNext('listParticipants', 'misconfigured');
        const calls = h.rtc.calls.length;
        expect(await h.reconciler.sweepParticipants()).toMatchObject({
          skipped: 'provider_misconfigured',
          sessions: 2,
          sessionsSkipped: 0,
          removed: 0,
          corrected: 0,
        });
        // One call, and the tick stopped: the second session was not asked about.
        expect(h.rtc.calls.slice(calls).map((call) => call.operation)).toEqual([
          'listParticipants',
        ]);
      }
      expect(logs.lines).toEqual([
        {
          level: 'error',
          fields: { event: 'live.reconciler.provider_misconfigured', reason: 'unauthorized' },
        },
      ]);

      // Fixed: the next call that answers says so, and reconciling resumes.
      expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: null });
      expect(logs.events()).toEqual([
        'live.reconciler.provider_misconfigured',
        'live.reconciler.provider_available',
      ]);
    });
  });

  describe('control', () => {
    it('is bound by the Live module', () => {
      const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LiveModule) as unknown[];
      expect(providers).toContain(LiveReconciler);
    });

    it('runs one boot pass — rooms, participants, then the watch — and starts three unref’d timers on the live-limits periods', async () => {
      await h.rtc.endRoom(room);
      h.rtc.connect(room, 'student-1', MICROPHONE);
      const intervals = jest.spyOn(global, 'setInterval');
      const cleared = jest.spyOn(global, 'clearInterval');
      const calls = h.rtc.calls.length;

      h.reconciler.onApplicationBootstrap();
      await h.reconciler.stop();

      expect(intervals.mock.calls.map(([, ms]) => ms)).toEqual([
        ROOM_SWEEP_SECONDS * 1000,
        PARTICIPANT_SWEEP_SECONDS * 1000,
        WATCH_TICK_SECONDS * 1000,
      ]);
      const timers = intervals.mock.results.map(
        (result) => result.value as ReturnType<typeof setInterval>,
      );
      // Unref'd: a timer never keeps the process alive.
      expect(timers.map((timer) => timer.hasRef())).toEqual([false, false, false]);
      expect(cleared.mock.calls.map(([timer]) => timer)).toEqual(timers);

      // The boot pass ran, in order: the room re-created, then the
      // participant sweep corrected who was in it.
      expect(h.rtc.calls.slice(calls).map((call) => call.operation)).toEqual([
        'listRooms',
        'ensureRoom',
        'listParticipants',
        'updateCapabilities',
        // …and the watch looked again at whom the sweep corrected: the room
        // listed, as anyone under enforcement has it looked at.
        'listParticipants',
      ]);
      expect(h.rtc.observed(room)).toMatchObject([
        { identity: 'student-1', capabilities: LISTENER },
      ]);
    });

    it('stop() waits for a tick in flight, and a destroyed module leaves nothing running', async () => {
      const listing = h.rtc.hold('listRooms');
      h.reconciler.onApplicationBootstrap();
      await listing.reached;
      let stopped = false;
      const stopping = h.reconciler.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      listing.release();
      await stopping;
      expect(stopped).toBe(true);
      await h.reconciler.onModuleDestroy();
    });

    it('is single-flight per tick: a tick that finds its last run going is skipped, never queued', async () => {
      const listing = h.rtc.hold('listRooms');
      const first = h.reconciler.sweepRooms();
      await listing.reached;
      expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: 'in_flight' });
      // Another tick is not blocked by it.
      expect(await h.reconciler.watchTick()).toMatchObject({ skipped: null });
      listing.release();
      expect(await first).toMatchObject({ skipped: null });
      expect(h.rtc.calls.filter((call) => call.operation === 'listRooms')).toHaveLength(1);
    });

    it('never throws from a tick: an unexpected failure is reported and logged by class', async () => {
      jest.spyOn(h.sessions, 'listLive').mockRejectedValue(new RangeError('boom'));
      logs.lines.length = 0;
      await expect(h.reconciler.sweepParticipants()).resolves.toMatchObject({ skipped: 'failed' });
      await expect(h.reconciler.watchTick()).resolves.toMatchObject({ skipped: 'failed' });
      expect(logs.lines.map((line) => line.fields)).toEqual([
        { event: 'live.reconciler.tick_skipped', tick: 'sessions', err: { name: 'RangeError' } },
        { event: 'live.reconciler.tick_skipped', tick: 'sessions', err: { name: 'RangeError' } },
      ]);
    });
  });
});

/** A media reset's moderation row, as the reconciler writes one — for a reset made elsewhere. */
function resetRow(sessionId: string): ModerationAction {
  return {
    id: `00000000-0000-4000-8000-0000000fffff` as ModerationAction['id'],
    sessionId,
    actorUserId: null,
    targetUserId: null,
    type: 'reset_media',
    at: new Date('2026-09-23T08:00:00.000Z'),
  };
}

function spec(roomName: string) {
  return {
    roomName,
    maxParticipants: 10,
    emptyTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
    departureTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
  };
}
