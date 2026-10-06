import type { Principal } from '../../../shared';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../identity/domain/provisional-policy';
import {
  META,
  captureLogs,
  liveHarness,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { WATCH_TICK_SECONDS } from '../domain/live-limits';
import type { RtcCapabilities } from '../domain/rtc-provider';
import { capabilitiesFor } from '../domain/standing';
import type { LiveSessionView, SpeakerRequestView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
  presenterDelegated: false,
});
const MICROPHONE = { ...LISTENER, canPublishAudio: true };
/** What LiveKit gives a publishing token's second connection: its microphone, no subscription. */
const SECOND: RtcCapabilities = { ...MICROPHONE, canSubscribe: false };

/**
 * What counts as a repeat — so which step happens to observe which
 * identity first never decides a media reset (P7.2 review of decision R1):
 *
 *   - an account's own identity and its foreign identities are armed apart:
 *     a correction of the one never makes a first sighting of the other a
 *     violation, either way round;
 *   - a watch that finds a foreign identity checks the account behind it in
 *     the same step, its own identity with it — one sighting;
 *   - a breach counts as a violation only on an observation nothing of the
 *     person's own raced: nobody else's act — a hand raised, granted or
 *     revoked elsewhere — can hold a repeat off.
 */
describe('LiveReconciler — what counts as a repeat (P7.2 review)', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let students: readonly Principal[];
  let session: LiveSessionView;
  let room: string;

  beforeEach(async () => {
    captureLogs();
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2', 'student-3');
    ({ id: communityId, owner, students } = world);
    session = await h.startSession(owner, communityId);
    room = h.room(session.id);
    h.rtc.connect(room, 'teacher-1', MICROPHONE);
  });

  afterEach(async () => {
    await h.reconciler.stop();
    jest.restoreAllMocks();
  });

  /** A hand raised and granted, the speaker connected on the microphone the grant pushed. */
  async function speaker(principal: Principal): Promise<SpeakerRequestView> {
    h.rtc.connect(room, principal.userId, LISTENER);
    const hand = await h.raised(principal, session.id);
    const granted = await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    if (!granted.ok) throw new Error(granted.error.code);
    h.rtc.connect(room, principal.userId, MICROPHONE, ['microphone']);
    return hand;
  }

  async function revokeFloor(hand: SpeakerRequestView): Promise<void> {
    const revoked = await h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META });
    if (!revoked.ok) throw new Error(revoked.error.code);
  }

  /** A second identity made from `account`'s publishing token, on the microphone. */
  function secondIdentity(account: string, suffix: string): string {
    const identity = `${account}#${suffix}`;
    h.rtc.connect(room, identity, SECOND, ['microphone']);
    return identity;
  }

  const capabilitiesOf = (userId: string) =>
    h.rtc.observed(room).find((participant) => participant.identity === userId)?.capabilities;

  async function expectNoReset(): Promise<void> {
    expect(await h.session(session.id)).toMatchObject({
      mediaRoomEpoch: 0,
      enforcementViolations: 0,
    });
  }

  it('never makes the own identity’s first correction a violation because a foreign identity was seen — an app back on its last refreshed token is corrected, not counted', async () => {
    const hand = await speaker(students[0]);
    secondIdentity('student-1', 'x');
    // The app drops out for a moment, and misses the revoke's push.
    h.rtc.disconnect(room, 'student-1');
    await revokeFloor(hand);
    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 1,
      violations: 0,
    });

    // Back on the last token the server refreshed for it — the microphone
    // still in it — and nothing foreign again: its first correction.
    h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
    h.clock.advance(WATCH_TICK_SECONDS);
    expect(await h.reconciler.watchTick()).toMatchObject({
      corrected: 1,
      violations: 0,
      resets: 0,
    });
    expect(capabilitiesOf('student-1')).toEqual(LISTENER);
    await expectNoReset();
  });

  it('never makes a first foreign sighting a violation because a targeted check corrected the own identity — and the reappearance still resets', async () => {
    await speaker(students[0]);
    secondIdentity('student-1', 'x');
    // A Communities fact's check, by name: the own identity removed, and
    // under enforcement — the foreign one not looked for (nothing watched).
    await h.remove(communityId, owner, 'student-1');
    expect(await h.reconciler.checkIdentities(session.id, ['student-1'])).toMatchObject({
      removed: 1,
      violations: 0,
    });

    // The sweep then lists the room and sees the foreign identity for the
    // first time: a first sighting, whichever step saw the account first.
    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 1,
      violations: 0,
      resets: 0,
    });
    await expectNoReset();

    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'y');
    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
  });

  it('checks the account behind a foreign identity the watch finds in the same step — its own identity with it — so the next sweep counts nothing', async () => {
    // A legitimate speaker's second identity: removed, nothing counted — and
    // now the watch lists the room.
    await speaker(students[1]);
    secondIdentity('student-2', 'dev');
    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 0,
    });

    // A moderator on the microphone by right, with a second identity, loses
    // live.speak: no event, no push, nothing a moderator's act would step.
    await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    h.rtc.connect(room, 'teacher-2', MICROPHONE, ['microphone']);
    secondIdentity('teacher-2', 'x');
    h.accounts.setPermissions(
      'teacher-2',
      PROVISIONAL_ROLE_PERMISSIONS.TEACHER.filter((permission) => permission !== 'live.speak'),
    );

    h.clock.advance(WATCH_TICK_SECONDS);
    expect(await h.reconciler.watchTick()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 1,
      corrected: 1,
      violations: 0,
    });
    expect(capabilitiesOf('teacher-2')).toEqual(LISTENER);

    // What the watch saw, the sweep does not count again.
    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      corrected: 0,
      violations: 0,
      resets: 0,
    });
    await expectNoReset();
  });

  it('never lets anyone else’s act hold off the own identity’s repeat — a hand raised, granted and revoked elsewhere during the step', async () => {
    const hand = await speaker(students[0]);
    await revokeFloor(hand);
    h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
    expect(await h.reconciler.sweepParticipants()).toMatchObject({ corrected: 1 });

    const read = h.standing.ofAccounts.bind(h.standing);
    let racing = true;
    jest.spyOn(h.standing, 'ofAccounts').mockImplementation(async (at, userIds) => {
      if (racing) {
        racing = false;
        const other = await h.raised(students[2], session.id);
        await h.moderate.grant({ principal: owner, requestId: other.id, meta: META });
        await h.moderate.revoke({ principal: owner, requestId: other.id, meta: META });
      }
      return read(at, userIds);
    });
    h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
    h.clock.advance(WATCH_TICK_SECONDS);
    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
    expect(await h.session(session.id)).toMatchObject({
      mediaRoomEpoch: 1,
      enforcementViolations: 1,
    });
  });
});
