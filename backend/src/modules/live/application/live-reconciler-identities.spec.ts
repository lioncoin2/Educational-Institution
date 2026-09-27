import type { Principal } from '../../../shared';
import {
  META,
  captureLogs,
  liveHarness,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { ENFORCEMENT_WATCH_SECONDS, WATCH_TICK_SECONDS } from '../domain/live-limits';
import type { RtcCapabilities } from '../domain/rtc-provider';
import { capabilitiesFor } from '../domain/standing';
import type { LiveSessionView, SpeakerRequestView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});
const MICROPHONE = { ...LISTENER, canPublishAudio: true };
/** What LiveKit gives a publishing token's second connection: its sources, no subscription. */
const SECONDARY: RtcCapabilities = { ...MICROPHONE, canSubscribe: false };

/** What a client chose — found in no log line, ever. */
const SUFFIX = 'client-chosen-suffix';
/** A speaker's token, reused with `publish=<SUFFIX>` (SRV `pkg/service/utils.go:378-387`). */
const FOREIGN = `student-1#${SUFFIX}`;

/**
 * The identity contract (P7.1; audit S2): the application issues one media
 * identity per account, the account id. Any other standard participant is
 * foreign — removed at once by the participant sweep, and by the watch when
 * it comes back; never put to Communities or identity, never given
 * capabilities, never a violation and never a media reset. The fake
 * provider's scripted participants stand for what LiveKit would hold.
 */
describe('LiveReconciler — identities it never issued', () => {
  let h: LiveHarness;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;
  let room: string;
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    logs = captureLogs();
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    owner = world.owner;
    student = world.students[0];
    session = await h.startSession(owner, world.id);
    room = h.room(session.id);
    h.rtc.connect(room, 'teacher-1', MICROPHONE);
  });

  afterEach(async () => {
    await h.reconciler.stop();
    jest.restoreAllMocks();
  });

  /** student-1 on the floor, connected with the microphone the grant pushed. */
  async function speaker(): Promise<SpeakerRequestView> {
    h.rtc.connect(room, 'student-1', LISTENER);
    const hand = await h.raised(student, session.id);
    const granted = await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    if (!granted.ok) throw new Error(granted.error.code);
    return hand;
  }

  /** A second connection on a publishing token, the microphone on. */
  const secondary = (identity = FOREIGN, roomName = room) =>
    h.rtc.connect(roomName, identity, SECONDARY, ['microphone']);

  const identitiesIn = (roomName = room) =>
    h.rtc.observed(roomName).map((participant) => participant.identity);

  const removals = () => h.rtc.removed.map((removal) => removal.identity);

  const foreignLines = () =>
    logs.lines.filter((line) => line.fields.event === 'live.reconciler.foreign_identity_removed');

  describe('the participant sweep', () => {
    it('removes a foreign identity at once — every token issued before now revoked — and asks Communities and identity nothing about it', async () => {
      await speaker();
      secondary();
      const standing = jest.spyOn(h.standing, 'ofAccounts');
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');
      const withPermission = jest.spyOn(h.accounts, 'withPermission');
      const now = h.clock.now();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        sessions: 1,
        foreignRemoved: 1,
        // The people, and only them.
        checked: 2,
        removed: 0,
        corrected: 0,
        pushed: 0,
        violations: 0,
        resets: 0,
      });
      expect(h.rtc.removed).toEqual([
        { roomName: room, identity: FOREIGN, revokeTokensIssuedBefore: now },
      ]);
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1']);
      // The standing read was the people's alone; nothing was asked about it.
      expect(standing.mock.calls.map(([, userIds]) => userIds)).toEqual([
        ['teacher-1', 'student-1'],
      ]);
      expect(permittedAmong).toHaveBeenCalled();
      const asked = [standing.mock.calls, permittedAmong.mock.calls, withPermission.mock.calls];
      expect(JSON.stringify(asked)).not.toContain('#');
      // And it was given nothing: no capability pushed, no token issued.
      expect(h.rtc.capabilityChanges.map((change) => change.identity)).not.toContain(FOREIGN);
      expect(h.rtc.issued.map((grant) => grant.identity)).not.toContain(FOREIGN);
    });

    it('leaves the account behind the suffix as it was: its floor, its microphone, its place', async () => {
      const hand = await speaker();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      secondary();
      const pushed = h.rtc.capabilityChanges.length;
      h.journal.clear();

      await h.reconciler.sweepParticipants();

      expect(removals()).toEqual([FOREIGN]);
      expect(h.rtc.observed(room).find((p) => p.identity === 'student-1')).toMatchObject({
        capabilities: MICROPHONE,
        publishing: ['microphone'],
      });
      expect(h.rtc.capabilityChanges.slice(pushed)).toEqual([]);
      expect((await h.requests.findById(hand.id))?.state).toBe('granted');
      expect(h.media.observed(session.id, 'student-1')).toBe('connected');
      expect(h.journal.order).toEqual([]);
    });

    it('logs the removal with the session and the account whose token was used — never the identity', async () => {
      await speaker();
      secondary();
      logs.lines.length = 0;

      await h.reconciler.sweepParticipants();

      expect(foreignLines()).toEqual([
        {
          level: 'warn',
          fields: {
            event: 'live.reconciler.foreign_identity_removed',
            sessionId: session.id,
            userId: 'student-1',
            outcome: 'applied',
          },
        },
      ]);
      expect(JSON.stringify(logs.lines)).not.toContain(SUFFIX);
      expect(JSON.stringify(logs.lines)).not.toContain('#');
    });

    it('removes a foreign identity whose base is no id, and logs no account and nothing a client chose', async () => {
      const chosen = [
        `#${SUFFIX}`,
        `not an id#${SUFFIX}`,
        `${'x'.repeat(129)}#${SUFFIX}`,
        `${SUFFIX} with spaces`,
        SUFFIX.repeat(8),
      ];
      for (const identity of chosen) secondary(identity);
      logs.lines.length = 0;

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        foreignRemoved: chosen.length,
        checked: 1,
        removed: 0,
      });
      expect(removals()).toEqual(chosen);
      expect(identitiesIn()).toEqual(['teacher-1']);
      expect(foreignLines().map((line) => line.fields)).toEqual(
        chosen.map(() => ({
          event: 'live.reconciler.foreign_identity_removed',
          sessionId: session.id,
          outcome: 'applied',
        })),
      );
      const written = JSON.stringify(logs.lines);
      for (const part of [SUFFIX, 'not an id', 'x'.repeat(129), '#']) {
        expect(written).not.toContain(part);
      }
    });

    it('decides on the identity alone: removed while Communities cannot answer — and nobody else is touched', async () => {
      // student-1 holds the microphone with no floor: a breach, left for a
      // sweep that can read Communities (audit D23).
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      secondary();
      jest.spyOn(h.communities.membership, 'heads').mockRejectedValue(new Error('timeout'));

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        sessionsSkipped: 1,
        removed: 0,
        corrected: 0,
      });
      expect(removals()).toEqual([FOREIGN]);
      expect(foreignLines()).toHaveLength(1);
      expect(h.rtc.capabilityChanges).toEqual([]);
      expect(h.rtc.observed(room).find((p) => p.identity === 'student-1')?.capabilities).toEqual(
        MICROPHONE,
      );
    });

    it('ignores a participant that is not a person, whatever its identity', async () => {
      h.rtc.observe(room, [
        ...h.rtc.observed(room),
        {
          identity: `EG_recorder#${SUFFIX}`,
          state: 'active',
          standard: false,
          joinedAt: h.clock.now(),
          publishing: ['microphone'],
          capabilities: MICROPHONE,
        },
      ]);

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        foreignRemoved: 0,
        checked: 1,
        removed: 0,
      });
      expect(h.rtc.removed).toEqual([]);
      expect(foreignLines()).toEqual([]);
    });

    it('counts every session’s removals in the tick’s report, apart from the people', async () => {
      const other = await h.community('teacher-2');
      const second = await h.startSession(other.owner, other.id);
      secondary();
      secondary(`teacher-2#${SUFFIX}`, h.room(second.id));

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        sessions: 2,
        foreignRemoved: 2,
        checked: 1,
        removed: 0,
      });
      expect(identitiesIn(h.room(second.id))).toEqual([]);
    });
  });

  describe('the watch', () => {
    it('looks for it again by name, and removes it each time it comes back inside the window', async () => {
      await speaker();
      secondary();
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ foreignRemoved: 1 });

      for (let round = 0; round < 3; round += 1) {
        h.clock.advance(WATCH_TICK_SECONDS);
        secondary();
        const from = h.rtc.calls.length;
        expect(await h.reconciler.watchTick()).toMatchObject({
          skipped: null,
          foreignRemoved: 1,
          checked: 0,
          violations: 0,
          resets: 0,
        });
        // One look and one removal — the watch lists no room.
        expect(h.rtc.calls.slice(from).map((call) => [call.operation, call.identity])).toEqual([
          ['getParticipant', FOREIGN],
          ['removeParticipant', FOREIGN],
        ]);
      }
      expect(removals()).toEqual([FOREIGN, FOREIGN, FOREIGN, FOREIGN]);
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1']);
    });

    it('never counts it as a violation, and never resets the media — even while its account is under enforcement', async () => {
      // student-1, holding the microphone with no floor, is corrected: an
      // applied correction, so any breach of THEIRS in the window would count.
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ corrected: 1 });
      h.journal.clear();

      for (let round = 0; round < 3; round += 1) {
        secondary();
        expect(await h.reconciler.sweepParticipants()).toMatchObject({
          foreignRemoved: 1,
          violations: 0,
          resets: 0,
        });
        h.clock.advance(WATCH_TICK_SECONDS);
        secondary();
        expect(await h.reconciler.watchTick()).toMatchObject({
          foreignRemoved: 1,
          violations: 0,
          resets: 0,
        });
      }

      expect(await h.session(session.id)).toMatchObject({
        mediaRoomEpoch: 0,
        enforcementViolations: 0,
        lastViolationAt: null,
      });
      expect(h.rtc.roomNames()).toEqual([room]);
      expect(h.rtc.ended).toEqual([]);
      expect(h.audits()).not.toContain('live.session.media_reset');
      expect(logs.events()).not.toContain('live.reconciler.violation');
      expect(logs.events()).not.toContain('live.session.media_reset');
      // The account itself was left as the correction left it.
      expect(h.rtc.observed(room).find((p) => p.identity === 'student-1')?.capabilities).toEqual(
        LISTENER,
      );
    });

    it('extends the window on every removal, and stops looking once it has passed — the sweep still finds it', async () => {
      secondary();
      await h.reconciler.sweepParticipants();

      // Back inside the window: removed, and the window starts again.
      h.clock.advance(ENFORCEMENT_WATCH_SECONDS - WATCH_TICK_SECONDS);
      secondary();
      expect(await h.reconciler.watchTick()).toMatchObject({ foreignRemoved: 1 });
      h.clock.advance(ENFORCEMENT_WATCH_SECONDS - WATCH_TICK_SECONDS);
      secondary();
      expect(await h.reconciler.watchTick()).toMatchObject({ foreignRemoved: 1 });

      // Past it: the watch asks nothing…
      h.clock.advance(ENFORCEMENT_WATCH_SECONDS);
      secondary();
      const from = h.rtc.calls.length;
      expect(await h.reconciler.watchTick()).toMatchObject({ checked: 0, foreignRemoved: 0 });
      expect(h.rtc.calls.slice(from)).toEqual([]);
      // …and the participant sweep, which lists everyone, removes it.
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ foreignRemoved: 1 });
      expect(identitiesIn()).toEqual(['teacher-1']);
    });
  });

  describe('failures', () => {
    it('an outage while removing it skips the tick — and the watch still looks for it', async () => {
      secondary();
      h.rtc.failNext('removeParticipant', 'unavailable');

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: 'provider_unavailable',
        foreignRemoved: 0,
      });
      expect(identitiesIn()).toContain(FOREIGN);

      expect(await h.reconciler.watchTick()).toMatchObject({ skipped: null, foreignRemoved: 1 });
      expect(identitiesIn()).toEqual(['teacher-1']);
    });

    it('a refusal skips the session, by class only — and the watch removes it next', async () => {
      secondary();
      h.rtc.failNext('removeParticipant', 'fault');
      logs.lines.length = 0;

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        sessionsSkipped: 1,
        foreignRemoved: 0,
        checked: 0,
      });
      expect(logs.lines).toContainEqual({
        level: 'error',
        fields: {
          event: 'live.reconciler.session_skipped',
          stage: 'session',
          sessionId: session.id,
          err: { name: 'Error' },
        },
      });
      expect(JSON.stringify(logs.lines)).not.toContain(SUFFIX);

      expect(await h.reconciler.watchTick()).toMatchObject({ foreignRemoved: 1 });
      expect(identitiesIn()).toEqual(['teacher-1']);
    });

    it('counts no removal for one that left first — logged as such — and still looks for it', async () => {
      secondary();
      const removing = h.rtc.hold('removeParticipant');
      const sweeping = h.reconciler.sweepParticipants();
      await removing.reached;
      h.rtc.disconnect(room, FOREIGN);
      removing.release();

      expect(await sweeping).toMatchObject({ foreignRemoved: 0 });
      expect(foreignLines().map((line) => line.fields.outcome)).toEqual(['not_connected']);

      h.clock.advance(WATCH_TICK_SECONDS);
      secondary();
      expect(await h.reconciler.watchTick()).toMatchObject({ foreignRemoved: 1 });
      expect(identitiesIn()).toEqual(['teacher-1']);
    });
  });

  describe('ProtectLiveSessions’ checks', () => {
    it('checkSession removes it too, and reports the people alone', async () => {
      secondary();
      expect(await h.reconciler.checkSession(session.id)).toEqual({
        outcome: 'checked',
        checked: 1,
        removed: 0,
        corrected: 0,
        pushed: 0,
        violations: 0,
        resets: 0,
      });
      expect(removals()).toEqual([FOREIGN]);
    });

    it('checkIdentities looks for an identity it never issued in the room, removes it there, and asks nothing about it', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      secondary();
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');

      expect(await h.reconciler.checkIdentities(session.id, [FOREIGN, 'student-1'])).toEqual({
        outcome: 'checked',
        checked: 1,
        removed: 0,
        corrected: 0,
        pushed: 0,
        violations: 0,
        resets: 0,
      });
      expect(removals()).toEqual([FOREIGN]);
      expect(permittedAmong.mock.calls.map(([, userIds]) => userIds)).toEqual([
        ['student-1'],
        ['student-1'],
      ]);
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1']);
    });
  });
});
