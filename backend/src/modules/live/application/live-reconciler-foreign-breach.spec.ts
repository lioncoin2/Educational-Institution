import type { Principal } from '../../../shared';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../identity/domain/provisional-policy';
import {
  META,
  captureLogs,
  liveHarness,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { ENFORCEMENT_WATCH_SECONDS, WATCH_TICK_SECONDS } from '../domain/live-limits';
import type { RtcCapabilities, RtcNotReadyReason, RtcSource } from '../domain/rtc-provider';
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
const PRESENTING = { ...MICROPHONE, canPublishScreen: true };

/** What a client chose — found in no log line, ever. */
const SUFFIX = 'client-chosen-suffix';

/** What LiveKit gives a publishing token's second connection: its sources, no subscription. */
interface Held {
  readonly capabilities: RtcCapabilities;
  readonly publishing: readonly RtcSource[];
}
const MICROPHONE_HELD: Held = {
  capabilities: { ...MICROPHONE, canSubscribe: false },
  publishing: ['microphone'],
};
const SCREEN_HELD: Held = {
  capabilities: { ...PRESENTING, canSubscribe: false },
  publishing: ['microphone', 'screen_share'],
};

/**
 * P7.2 decision R1 — the self-renewing `#` identities of withdrawn
 * publishers (audit §2, reproduced on the pinned server). A client whose
 * publishing token outlives its rights makes `<account>#<anything>` with it,
 * and the media server hands that connection a fresh ten-minute token of
 * its own on every join; removal alone never ends the chain.
 *
 * So the identity is its account's: an account that may not hold what the
 * identity held has breached. The first sighting removes the identity and
 * watches the account; a second, under ANY identity of that account inside
 * the window, is a violation, and the media reset moves the session to a new
 * room — every token the server ever refreshed then names a room that is
 * gone, and `/join` gives the account a listener's token, which can make no
 * second identity at all. Accounts still entitled to what they hold, and
 * everyone else in the room, are never touched by it.
 */
describe('LiveReconciler — a withdrawn publisher’s second identities (R1)', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let students: readonly Principal[];
  let session: LiveSessionView;
  let room: string;
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    logs = captureLogs();
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    ({ id: communityId, owner, students } = world);
    session = await h.startSession(owner, communityId);
    room = h.room(session.id);
    h.rtc.connect(room, 'teacher-1', MICROPHONE);
  });

  afterEach(async () => {
    await h.reconciler.stop();
    jest.restoreAllMocks();
  });

  /** A hand raised and granted, the speaker connected with what the grant pushed. */
  async function speaker(principal: Principal): Promise<SpeakerRequestView> {
    h.rtc.connect(room, principal.userId, LISTENER);
    const hand = await h.raised(principal, session.id);
    const granted = await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    if (!granted.ok) throw new Error(granted.error.code);
    return hand;
  }

  async function revokeFloor(hand: SpeakerRequestView): Promise<void> {
    const revoked = await h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META });
    if (!revoked.ok) throw new Error(revoked.error.code);
  }

  /** A second identity made from `account`'s publishing token, holding `held`. */
  function secondIdentity(account: string, suffix: string, held = MICROPHONE_HELD): string {
    const identity = `${account}#${suffix}`;
    h.rtc.connect(room, identity, held.capabilities, held.publishing);
    return identity;
  }

  const capabilitiesOf = (userId: string, roomName = room) =>
    h.rtc.observed(roomName).find((participant) => participant.identity === userId)?.capabilities;

  const eventsNamed = (event: string) =>
    logs.lines.filter((line) => line.fields.event === event).map((line) => line.fields);

  /** Each way a publisher's rights are withdrawn — and what their second identity still holds. */
  const WITHDRAWALS: ReadonlyArray<
    readonly [string, () => Promise<{ readonly account: string; readonly held: Held }>]
  > = [
    [
      'a speaker whose floor was revoked',
      async () => {
        await revokeFloor(await speaker(students[0]));
        return { account: 'student-1', held: MICROPHONE_HELD };
      },
    ],
    [
      'a presenter whose slot was closed — the screen, which the microphone they keep is not',
      async () => {
        const moderator = await h.delegate(
          communityId,
          owner,
          'teacher-2',
          'community.live.moderate',
        );
        h.rtc.connect(room, 'teacher-2', MICROPHONE);
        const claimed = await h.presenter.claim({
          principal: moderator,
          sessionId: session.id,
          meta: META,
        });
        if (!claimed.ok) throw new Error(claimed.error.code);
        const closed = await h.presenter.revoke({
          principal: owner,
          sessionId: session.id,
          targetUserId: 'teacher-2',
          meta: META,
        });
        if (!closed.ok) throw new Error(closed.error.code);
        return { account: 'teacher-2', held: SCREEN_HELD };
      },
    ],
    [
      'a moderator who lost live.speak',
      async () => {
        await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
        h.accounts.setPermissions(
          'teacher-2',
          PROVISIONAL_ROLE_PERMISSIONS.TEACHER.filter((permission) => permission !== 'live.speak'),
        );
        return { account: 'teacher-2', held: MICROPHONE_HELD };
      },
    ],
    [
      'a member removed from the community',
      async () => {
        await h.remove(communityId, owner, 'student-1');
        return { account: 'student-1', held: MICROPHONE_HELD };
      },
    ],
  ];

  it.each(WITHDRAWALS)(
    'ends the chain of %s: the first sighting watches the account, the second — under any suffix — resets the media',
    async (_case, withdraw) => {
      const { account, held } = await withdraw();
      const first = secondIdentity(account, SUFFIX, held);
      const at = h.clock.now();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        foreignRemoved: 1,
        foreignBreaches: 1,
        violations: 0,
        resets: 0,
      });
      expect(h.rtc.removed).toContainEqual({
        roomName: room,
        identity: first,
        revokeTokensIssuedBefore: at,
      });
      expect(await h.session(session.id)).toMatchObject({
        mediaRoomEpoch: 0,
        enforcementViolations: 0,
      });

      // Back with the token the server refreshed for it, under a new suffix:
      // the watch — within one of its ticks, not the sweep's — finds it.
      h.clock.advance(WATCH_TICK_SECONDS);
      secondIdentity(account, 'another', held);
      expect(await h.reconciler.watchTick()).toMatchObject({
        foreignRemoved: 1,
        foreignBreaches: 1,
        violations: 1,
        resets: 1,
      });

      const reset = await h.session(session.id);
      expect(reset).toMatchObject({
        state: 'live',
        mediaRoomEpoch: 1,
        enforcementViolations: 1,
        lastViolationAt: h.clock.now(),
      });
      // Every token the server refreshed names the old room: gone, never back.
      expect(h.rtc.ended).toContain(room);
      expect(h.rtc.roomNames()).toEqual([h.room(session.id, 1)]);
      expect(h.audits()).toContain('live.session.media_reset');
      expect(eventsNamed('live.reconciler.violation')).toEqual([
        {
          event: 'live.reconciler.violation',
          sessionId: session.id,
          userId: account,
          violations: 1,
          via: 'foreign_identity',
        },
      ]);
      expect(eventsNamed('live.session.media_reset')).toEqual([
        {
          event: 'live.session.media_reset',
          sessionId: session.id,
          targetUserId: account,
          fromEpoch: 0,
          toEpoch: 1,
        },
      ]);
      expect(
        eventsNamed('live.reconciler.foreign_breach').map((fields) => fields.violation),
      ).toEqual([false, true]);
      // Named by account only — never by anything the client chose.
      expect(JSON.stringify(logs.lines)).not.toContain(SUFFIX);
      expect(JSON.stringify(logs.lines)).not.toContain('#');
    },
  );

  it('lets the withdrawn account back only as what it may be now: a listener’s token, which can make no second identity', async () => {
    await revokeFloor(await speaker(students[0]));
    secondIdentity('student-1', SUFFIX);
    await h.reconciler.sweepParticipants();
    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'another');
    expect(await h.reconciler.watchTick()).toMatchObject({ resets: 1 });

    const again = await h.join.execute({
      principal: students[0],
      sessionId: session.id,
      meta: META,
    });
    expect(again.ok && again.value).toMatchObject({
      role: 'listener',
      media: { microphone: false, screen: false, screenAudio: false },
    });
    expect(h.rtc.issued.at(-1)).toMatchObject({
      roomName: h.room(session.id, 1),
      identity: 'student-1',
      capabilities: LISTENER,
    });
  });

  it('leaves a legitimate speaker alone throughout — never removed, demoted or counted — and back in at once, speaking, after the reset', async () => {
    const withdrawn = await speaker(students[0]);
    const legitimate = await speaker(students[1]);
    h.rtc.connect(room, 'student-2', MICROPHONE, ['microphone']);
    await revokeFloor(withdrawn);
    const pushedToThem = () =>
      h.rtc.capabilityChanges.filter((change) => change.identity === 'student-2');
    const pushesBefore = pushedToThem().length;

    const first = secondIdentity('student-1', SUFFIX);
    await h.reconciler.sweepParticipants();
    // The first sighting touches nobody but the identity it removed.
    expect(h.rtc.removed.map((removal) => removal.identity)).toEqual([first]);
    expect(capabilitiesOf('student-2')).toEqual(MICROPHONE);
    expect(pushedToThem()).toHaveLength(pushesBefore);

    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'another');
    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });

    // The reset moved the room — the approved protection, which everyone
    // rejoins through /join — and nothing of student-2's own changed: never
    // removed, pushed, expired or counted.
    expect(h.rtc.removed.map((removal) => removal.identity)).not.toContain('student-2');
    expect(pushedToThem()).toHaveLength(pushesBefore);
    expect((await h.requests.findById(legitimate.id))?.state).toBe('granted');
    expect(eventsNamed('live.reconciler.violation').map((fields) => fields.userId)).toEqual([
      'student-1',
    ]);

    const back = await h.join.execute({
      principal: students[1],
      sessionId: session.id,
      meta: META,
    });
    expect(back.ok && back.value).toMatchObject({ role: 'speaker', media: { microphone: true } });
    expect(h.rtc.issued.at(-1)).toMatchObject({
      roomName: h.room(session.id, 1),
      identity: 'student-2',
      capabilities: MICROPHONE,
    });
  });

  it('counts two identities of one account seen in one step as one sighting — the next step’s is the repeat', async () => {
    await revokeFloor(await speaker(students[0]));
    // Its own identity back on an old token, and two more made from it.
    h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
    secondIdentity('student-1', 'a');
    secondIdentity('student-1', 'b');

    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      corrected: 1,
      foreignRemoved: 2,
      foreignBreaches: 1,
      violations: 0,
      resets: 0,
    });
    expect(capabilitiesOf('student-1')).toEqual(LISTENER);

    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'c');
    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
  });

  /** The next standing read runs `act` first — landing between the observation and the standing. */
  function beforeStanding(act: () => Promise<unknown>): void {
    const read = h.standing.ofAccounts.bind(h.standing);
    let pending: (() => Promise<unknown>) | null = act;
    jest.spyOn(h.standing, 'ofAccounts').mockImplementation(async (at, userIds) => {
      if (pending !== null) {
        const running = pending;
        pending = null;
        await running();
      }
      return read(at, userIds);
    });
  }

  it('never lets anyone else’s act hold off the reappearance — hands raised, granted and revoked elsewhere during the step change nothing the account holds', async () => {
    await revokeFloor(await speaker(students[0]));
    secondIdentity('student-1', SUFFIX);
    await h.reconciler.sweepParticipants();

    // Every act another member or a moderator may repeat at will, landing
    // between the observation and the standing read: none of them is
    // student-1's, so none makes what was observed of student-1 stale.
    beforeStanding(async () => {
      const hand = await h.raised(students[1], session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      await h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META });
      await h.raised(students[1], session.id);
    });
    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'another');
    expect(await h.reconciler.watchTick()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 1,
      violations: 1,
      resets: 1,
    });
    expect(await h.session(session.id)).toMatchObject({
      mediaRoomEpoch: 1,
      enforcementViolations: 1,
    });
  });

  it('counts no violation when the account itself lost the floor during the step — what was observed was its right then — and a genuine repeat still resets', async () => {
    await revokeFloor(await speaker(students[0]));
    secondIdentity('student-1', SUFFIX);
    await h.reconciler.sweepParticipants();

    // The floor given back: what its identities hold is its right again…
    const regranted = await speaker(students[0]);
    h.clock.advance(WATCH_TICK_SECONDS);
    const raced = secondIdentity('student-1', 'raced');
    // …until a revoke lands between the observation and the standing read.
    beforeStanding(() => revokeFloor(regranted));
    expect(await h.reconciler.watchTick()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 1,
      violations: 0,
      resets: 0,
    });
    expect(h.rtc.removed.map((removal) => removal.identity)).toContain(raced);
    jest.restoreAllMocks();

    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'again');
    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
  });

  it('counts no violation, and resets nothing, when the session ended during the step', async () => {
    await revokeFloor(await speaker(students[0]));
    secondIdentity('student-1', SUFFIX);
    await h.reconciler.sweepParticipants();

    beforeStanding(() => h.end.execute({ principal: owner, sessionId: session.id, meta: META }));
    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'another');
    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 0, resets: 0 });
    expect(await h.session(session.id)).toMatchObject({
      state: 'ended',
      mediaRoomEpoch: 0,
      enforcementViolations: 0,
    });
  });

  it('finds the account under a suffix at the watch — not only at the sweep — once its own identity is under enforcement', async () => {
    const hand = await speaker(students[0]);
    await revokeFloor(hand);
    // Its own identity back on the microphone (a refreshed token): corrected,
    // and under enforcement — nothing foreign seen yet.
    h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      corrected: 1,
      foreignRemoved: 0,
    });

    // It leaves, and publishes through an identity of its token instead: the
    // watch lists the room, because someone in it is under enforcement.
    h.rtc.disconnect(room, 'student-1');
    h.clock.advance(WATCH_TICK_SECONDS);
    const first = secondIdentity('student-1', SUFFIX);
    const from = h.rtc.calls.length;
    expect(await h.reconciler.watchTick()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 1,
      violations: 0,
      resets: 0,
    });
    expect(h.rtc.calls[from]).toMatchObject({ operation: 'listParticipants', roomName: room });
    expect(h.rtc.removed.map((removal) => removal.identity)).toContain(first);

    // Its reappearance, under any suffix, at the next watch tick: the reset.
    h.clock.advance(WATCH_TICK_SECONDS);
    secondIdentity('student-1', 'another');
    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
  });

  it('starts afresh once the window has passed: a sighting after it is a first sighting again', async () => {
    await revokeFloor(await speaker(students[0]));
    secondIdentity('student-1', SUFFIX);
    await h.reconciler.sweepParticipants();

    h.clock.advance(ENFORCEMENT_WATCH_SECONDS);
    secondIdentity('student-1', 'late');
    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      foreignRemoved: 1,
      foreignBreaches: 1,
      violations: 0,
      resets: 0,
    });
    expect((await h.session(session.id)).mediaRoomEpoch).toBe(0);
  });

  it('finds the account under a new suffix at a ProtectLiveSessions check too, while one of its identities is watched', async () => {
    await revokeFloor(await speaker(students[0]));
    secondIdentity('student-1', SUFFIX);
    await h.reconciler.sweepParticipants();

    secondIdentity('student-1', 'another');
    const from = h.rtc.calls.length;
    expect(await h.reconciler.checkIdentities(session.id, ['student-2'])).toMatchObject({
      outcome: 'checked',
      violations: 1,
      resets: 1,
    });
    expect(h.rtc.calls[from]).toMatchObject({ operation: 'listParticipants', roomName: room });
  });

  it('decides nothing about the account while its standing cannot be read — the identity is removed all the same', async () => {
    await revokeFloor(await speaker(students[0]));
    const identity = secondIdentity('student-1', SUFFIX);
    jest.spyOn(h.standing, 'ofAccounts').mockRejectedValue(new Error('timeout'));

    expect(await h.reconciler.sweepParticipants()).toMatchObject({
      sessionsSkipped: 1,
      foreignBreaches: 0,
      violations: 0,
      resets: 0,
    });
    // Removed on its identity alone, before anything was read.
    expect(h.rtc.removed.map((removal) => removal.identity)).toEqual([identity]);
    expect(eventsNamed('live.reconciler.foreign_breach')).toEqual([]);
  });

  describe('against a self-check that fails (audit §4.5; P7.2 review)', () => {
    it('observes and corrects nothing while the self-check says incompatible_response — a wrong endpoint — and says so once, sweep after sweep', async () => {
      await revokeFloor(await speaker(students[0]));
      secondIdentity('student-1', SUFFIX);
      h.rtc.setReadiness({ ready: false, reason: 'incompatible_response' });
      await h.readiness.refresh();
      logs.lines.length = 0;
      const from = h.rtc.calls.length;

      for (let tick = 0; tick < 3; tick += 1) {
        expect(await h.reconciler.sweepRooms()).toMatchObject({
          skipped: 'provider_incompatible',
        });
        expect(await h.reconciler.sweepParticipants()).toMatchObject({
          skipped: 'provider_misconfigured',
          foreignRemoved: 0,
        });
        expect(await h.reconciler.watchTick()).toMatchObject({
          skipped: 'provider_misconfigured',
        });
        expect(await h.reconciler.checkSession(session.id)).toMatchObject({
          outcome: 'provider_misconfigured',
        });
        expect(await h.reconciler.checkIdentities(session.id, ['student-1'])).toMatchObject({
          outcome: 'provider_misconfigured',
        });
      }
      // Nothing asked of it — and one line, not a flap.
      expect(h.rtc.calls.slice(from)).toEqual([]);
      expect(logs.lines).toEqual([
        {
          level: 'error',
          fields: {
            event: 'live.reconciler.provider_misconfigured',
            reason: 'incompatible_response',
          },
        },
      ]);

      // Fixed: the room sweep's own self-check lets everything run again.
      h.rtc.setReadiness({ ready: true });
      await h.reconciler.sweepRooms();
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        foreignRemoved: 1,
        foreignBreaches: 1,
      });
    });

    it.each<RtcNotReadyReason>([
      'unauthorized',
      'tls_failure',
      'unreachable',
      'auto_create_enabled',
    ])(
      'still enforces while the self-check says %s: the reconciler’s own calls decide, and here they work — no switch-off, and no flapping lines',
      async (reason) => {
        await revokeFloor(await speaker(students[0]));
        secondIdentity('student-1', SUFFIX);
        h.rtc.setReadiness({ ready: false, reason });
        await h.readiness.refresh();
        logs.lines.length = 0;

        for (let tick = 0; tick < 3; tick += 1) {
          expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: null });
          expect(await h.reconciler.sweepParticipants()).toMatchObject({ skipped: null });
          expect(await h.reconciler.watchTick()).toMatchObject({ skipped: null });
          if (tick === 0) {
            expect(h.rtc.removed.map((removal) => removal.identity)).toContain(
              `student-1#${SUFFIX}`,
            );
          }
        }
        const provider = logs.lines
          .map((line) => line.fields.event)
          .filter((event) => String(event).startsWith('live.reconciler.provider_'));
        expect(provider).toEqual([]);
      },
    );
  });
});
