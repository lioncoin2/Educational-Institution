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
 * it comes back; never put to Communities or identity itself, never given
 * capabilities. Here, its account is entitled to what it holds, and so it is
 * never a violation and never a media reset. An account that is NOT — the
 * withdrawn publisher of P7.2 decision R1 — is `live-reconciler-foreign-
 * breach.spec.ts`'s. The fake provider's scripted participants stand for what
 * LiveKit would hold.
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
    it('removes a foreign identity at once — every token issued before now revoked — and asks Communities and identity about the account behind it, never about the identity', async () => {
      await speaker();
      // student-2's token made it; student-2 itself is not in the room.
      const identity = `student-2#${SUFFIX}`;
      secondary(identity);
      const standing = jest.spyOn(h.standing, 'ofAccounts');
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');
      const withPermission = jest.spyOn(h.accounts, 'withPermission');
      const now = h.clock.now();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        sessions: 1,
        foreignRemoved: 1,
        // student-2 holds no floor: the microphone its identity held is a breach (R1).
        foreignBreaches: 1,
        // The people, and only them.
        checked: 2,
        removed: 0,
        corrected: 0,
        pushed: 0,
        violations: 0,
        resets: 0,
      });
      expect(h.rtc.removed).toEqual([{ roomName: room, identity, revokeTokensIssuedBefore: now }]);
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1']);
      // The people's standing, and the account's behind the identity — by its
      // id alone, read with theirs; the identity itself reaches neither
      // Communities nor identity.
      expect(standing.mock.calls.map(([, userIds]) => userIds)).toEqual([
        ['teacher-1', 'student-1', 'student-2'],
      ]);
      expect(permittedAmong.mock.calls.length).toBeGreaterThan(0);
      for (const [, userIds] of permittedAmong.mock.calls) {
        expect(userIds).toEqual(['teacher-1', 'student-1', 'student-2']);
      }
      const asked = [standing.mock.calls, permittedAmong.mock.calls, withPermission.mock.calls];
      expect(JSON.stringify(asked)).not.toContain('#');
      // And it was given nothing: no capability pushed, no token issued.
      expect(h.rtc.capabilityChanges.map((change) => change.identity)).not.toContain(identity);
      expect(h.rtc.issued.map((grant) => grant.identity)).not.toContain(identity);
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
    it('looks for it again by listing the room — a client may come back under any suffix — and removes it each time inside the window', async () => {
      await speaker();
      secondary();
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ foreignRemoved: 1 });

      for (const suffix of [SUFFIX, 'another', 'yet-another']) {
        h.clock.advance(WATCH_TICK_SECONDS);
        const identity = `student-1#${suffix}`;
        secondary(identity);
        const from = h.rtc.calls.length;
        expect(await h.reconciler.watchTick()).toMatchObject({
          skipped: null,
          foreignRemoved: 1,
          foreignBreaches: 0,
          // The account behind it, checked in the same step: its own
          // identity is part of the same sighting.
          checked: 1,
          violations: 0,
          resets: 0,
        });
        // One list and one removal: a new suffix is found as surely as the old one.
        expect(h.rtc.calls.slice(from).map((call) => [call.operation, call.identity])).toEqual([
          ['listParticipants', undefined],
          ['removeParticipant', identity],
        ]);
      }
      expect(removals()).toEqual([FOREIGN, FOREIGN, 'student-1#another', 'student-1#yet-another']);
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1']);
    });

    it('never counts it as a violation, and never resets the media, while its account may hold what it holds — even under enforcement', async () => {
      // student-1 holds the floor — the microphone is theirs — and was
      // corrected for holding the screen too: an applied correction, so a
      // breach of THEIRS in the window would count.
      await speaker();
      h.rtc.connect(room, 'student-1', { ...MICROPHONE, canPublishScreen: true }, [
        'microphone',
        'screen_share',
      ]);
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ corrected: 1 });
      h.journal.clear();

      for (let round = 0; round < 3; round += 1) {
        // The microphone only: what the floor gives them.
        secondary();
        expect(await h.reconciler.sweepParticipants()).toMatchObject({
          foreignRemoved: 1,
          foreignBreaches: 0,
          violations: 0,
          resets: 0,
        });
        h.clock.advance(WATCH_TICK_SECONDS);
        secondary();
        expect(await h.reconciler.watchTick()).toMatchObject({
          foreignRemoved: 1,
          foreignBreaches: 0,
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
      expect(logs.events()).not.toContain('live.reconciler.foreign_breach');
      expect(logs.events()).not.toContain('live.session.media_reset');
      // The account itself was left as the correction left it: its floor's microphone.
      expect(h.rtc.observed(room).find((p) => p.identity === 'student-1')?.capabilities).toEqual(
        MICROPHONE,
      );
    });

    it('extends the window on every removal, and stops looking once it has passed — the sweep still finds it', async () => {
      await speaker();
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
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1']);
    });
  });

  describe('failures', () => {
    // student-1 holds no floor in these: the microphone its identity holds
    // is a breach, and a sighting counts whatever its removal came to (R1).
    it('an outage while removing it skips the tick — but the sighting counts: the watch finds it again, and that is its reappearance', async () => {
      secondary();
      h.rtc.failNext('removeParticipant', 'unavailable');

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: 'provider_unavailable',
        foreignRemoved: 0,
      });
      expect(identitiesIn()).toContain(FOREIGN);
      expect(foreignLines().map((line) => line.fields.outcome)).toEqual(['failed']);

      expect(await h.reconciler.watchTick()).toMatchObject({
        skipped: null,
        foreignRemoved: 1,
        violations: 1,
        resets: 1,
      });
      expect((await h.session(session.id)).mediaRoomEpoch).toBe(1);
    });

    it('a refusal skips the session, by class only — but the sighting counts, so an identity whose removal always fails shields nobody', async () => {
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

      expect(await h.reconciler.watchTick()).toMatchObject({
        foreignRemoved: 1,
        violations: 1,
        resets: 1,
      });
    });

    it('tries every removal when one fails — and counts each identity seen, removed or not', async () => {
      secondary(`student-1#a`);
      secondary(`student-1#b`);
      secondary(`student-2#c`);
      // The first removal fails; the others are still tried.
      h.rtc.failNext('removeParticipant', 'fault');

      expect(await h.reconciler.sweepParticipants()).toMatchObject({ sessionsSkipped: 1 });
      expect(foreignLines().map((line) => line.fields.outcome)).toEqual([
        'failed',
        'applied',
        'applied',
      ]);
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1#a']);

      // Both accounts were armed by what was seen: each one's next sighting resets.
      expect(await h.reconciler.watchTick()).toMatchObject({
        foreignRemoved: 1,
        violations: 1,
        resets: 1,
      });
    });

    it('counts no removal for one that left first — logged as such — and still looks for it: it was seen, so its return is a reappearance (R1)', async () => {
      // student-1 holds no floor: the microphone its identity holds is a breach.
      secondary();
      const removing = h.rtc.hold('removeParticipant');
      const sweeping = h.reconciler.sweepParticipants();
      await removing.reached;
      h.rtc.disconnect(room, FOREIGN);
      removing.release();

      expect(await sweeping).toMatchObject({
        foreignRemoved: 0,
        foreignBreaches: 1,
        violations: 0,
      });
      expect(foreignLines().map((line) => line.fields.outcome)).toEqual(['not_connected']);

      // Leaving before the removal hides nothing: back inside the window, it
      // is found, removed, and counted — and the media reset.
      h.clock.advance(WATCH_TICK_SECONDS);
      secondary();
      expect(await h.reconciler.watchTick()).toMatchObject({
        foreignRemoved: 1,
        foreignBreaches: 1,
        violations: 1,
        resets: 1,
      });
      expect((await h.session(session.id)).mediaRoomEpoch).toBe(1);
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

    it('checkIdentities looks for an identity it never issued in the room, removes it there, and asks about the account behind it — never about the identity', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      const identity = `student-2#${SUFFIX}`;
      secondary(identity);
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');

      expect(await h.reconciler.checkIdentities(session.id, [identity, 'student-1'])).toEqual({
        outcome: 'checked',
        checked: 1,
        removed: 0,
        corrected: 0,
        pushed: 0,
        violations: 0,
        resets: 0,
      });
      expect(removals()).toEqual([identity]);
      expect(permittedAmong.mock.calls.length).toBeGreaterThan(0);
      for (const [, userIds] of permittedAmong.mock.calls) {
        expect(userIds).toEqual(['student-1', 'student-2']);
      }
      expect(JSON.stringify(permittedAmong.mock.calls)).not.toContain('#');
      expect(identitiesIn()).toEqual(['teacher-1', 'student-1']);
    });
  });
});
