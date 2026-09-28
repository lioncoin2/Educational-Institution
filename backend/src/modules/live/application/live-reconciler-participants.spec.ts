import type { Principal } from '../../../shared';
import { Permissions, type Permission } from '../../identity/contracts';
import {
  META,
  captureLogs,
  liveHarness,
  withUnmappedStatus,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { MAX_AUTHORIZE_BATCH } from '../../communities/contracts/authorization';
import type { CommunityHead } from '../../communities/contracts/membership';
import { ENFORCEMENT_WATCH_SECONDS, WATCH_TICK_SECONDS } from '../domain/live-limits';
import { capabilitiesFor } from '../domain/standing';
import type { LiveSessionView, SpeakerRequestView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});
const MICROPHONE = { ...LISTENER, canPublishAudio: true };
const PRESENTING = { ...MICROPHONE, canPublishScreen: true };

/**
 * The reconciler's participant sweep, targeted watch and media reset
 * (live.md §11.3–11.4; audit D10, D21, D22, D23), against the REAL
 * Communities: eligibility and moderation are only ever Communities' answers
 * (`permittedAmong`, through `LiveStanding`), and identity's `live.speak`.
 * The fake provider's scripted observations stand for who is in the room.
 */
describe('LiveReconciler — participants', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;
  let room: string;
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    logs = captureLogs();
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    session = await h.startSession(owner, communityId);
    room = h.room(session.id);
    h.rtc.connect(room, 'teacher-1', MICROPHONE);
  });

  afterEach(async () => {
    await h.reconciler.stop();
    jest.restoreAllMocks();
  });

  /** A hand raised and granted, the speaker connected with what the grant pushed. */
  async function speaker(principal: Principal = student): Promise<SpeakerRequestView> {
    h.rtc.connect(room, principal.userId, LISTENER);
    const hand = await h.raised(principal, session.id);
    const granted = await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    if (!granted.ok) throw new Error(granted.error.code);
    return hand;
  }

  /** A TEACHER delegated `community.live.moderate`, presenting — and connected, unless told otherwise. */
  async function presenter(connected = true): Promise<Principal> {
    const moderator = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    if (connected) h.rtc.connect(room, 'teacher-2', MICROPHONE);
    const claimed = await h.presenter.claim({
      principal: moderator,
      sessionId: session.id,
      meta: META,
    });
    if (!claimed.ok) throw new Error(claimed.error.code);
    return moderator;
  }

  const revokeFloor = async (hand: SpeakerRequestView) => {
    const revoked = await h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META });
    if (!revoked.ok) throw new Error(revoked.error.code);
    return revoked.value;
  };

  const requestState = async (hand: SpeakerRequestView) =>
    (await h.requests.findById(hand.id))?.state;

  /** A reset committed elsewhere — another instance's — moving the session from `from`. */
  const resetElsewhere = async (from: number) =>
    h.sessions.bumpEpoch(session.id, from, {
      id: h.ids.next<'ModerationAction'>(),
      sessionId: session.id,
      actorUserId: null,
      targetUserId: null,
      type: 'reset_media',
      at: h.clock.now(),
    });

  const capabilitiesOf = (userId: string, roomName = room) =>
    h.rtc.observed(roomName).find((participant) => participant.identity === userId)?.capabilities;

  describe('who is no longer eligible to stay', () => {
    it('removes a removed member — the floor expired, the presenter grant closed, both announced, nothing audited', async () => {
      const hand = await speaker();
      await presenter();
      h.rtc.connect(room, 'teacher-2', PRESENTING, ['microphone', 'screen_share']);
      await h.remove(communityId, owner, 'student-1');
      await h.remove(communityId, owner, 'teacher-2');
      h.journal.clear();
      const now = h.clock.now();

      const report = await h.reconciler.sweepParticipants();

      expect(report).toMatchObject({ skipped: null, sessions: 1, removed: 2, violations: 0 });
      expect(h.rtc.removed).toEqual([
        { roomName: room, identity: 'student-1', revokeTokensIssuedBefore: now },
        { roomName: room, identity: 'teacher-2', revokeTokensIssuedBefore: now },
      ]);
      expect(h.rtc.observed(room).map((participant) => participant.identity)).toEqual([
        'teacher-1',
      ]);
      expect(await requestState(hand)).toBe('expired');
      expect(await h.presenters.active(session.id)).toBeNull();
      // Announced, never audited: the system's bookkeeping, not a moderator's act.
      expect(h.journal.order).toEqual([
        'event:live.speaker.expired',
        'event:live.screen_share.stopped',
      ]);
      const [expired, stopped] = h.journal.events;
      expect(expired?.payload).toEqual({
        sessionId: session.id,
        communityId,
        requestId: hand.id,
        userId: 'student-1',
        stateVersion: 5,
        from: 'granted',
        cause: 'ineligible',
      });
      expect(stopped?.payload).toEqual({
        sessionId: session.id,
        communityId,
        userId: 'teacher-2',
        stoppedBy: null,
        reason: 'ineligible',
        stateVersion: 6,
      });
      expect(logs.lines).toContainEqual({
        level: 'log',
        fields: {
          event: 'live.reconciler.removed',
          sessionId: session.id,
          userId: 'student-1',
          outcome: 'applied',
        },
      });
    });

    it('removes a suspended account', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      h.suspend('student-1');
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ removed: 1 });
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual(['student-1']);
    });

    it('removes a member who loses `communities.read` — eligibility is only ever Communities’ answer', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');
      h.accounts.setPermissions('student-1', ['live.join', 'live.raise_hand']);

      expect(await h.reconciler.sweepParticipants()).toMatchObject({ removed: 1 });
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual(['student-1']);
      expect(permittedAmong).toHaveBeenCalledWith(
        communityId,
        expect.arrayContaining(['student-1']),
        'community.live.remain',
      );
    });

    it('removes nobody from a LOCKED community: a lock stops joining, not a running session', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      const hand = await speaker(h.person('student-2', ['STUDENT']));
      await h.lock(communityId, owner);
      h.journal.clear();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        ended: 0,
        removed: 0,
        corrected: 0,
      });
      expect(h.rtc.removed).toEqual([]);
      expect(await requestState(hand)).toBe('granted');
      expect(h.journal.order).toEqual([]);
      expect((await h.session(session.id)).state).toBe('live');
    });

    it('ejects nobody, and ends nothing, for a community status this build does not know', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      const hand = await speaker(h.person('student-2', ['STUDENT']));
      withUnmappedStatus(h);
      h.journal.clear();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        ended: 0,
        removed: 0,
      });
      expect(await requestState(hand)).toBe('granted');
      expect((await h.session(session.id)).state).toBe('live');
      expect(h.journal.order).toEqual([]);
    });

    it('expires the floor of a DISCONNECTED speaker who lost standing (D21) — no provider call for them', async () => {
      const hand = await speaker();
      h.rtc.disconnect(room, 'student-1');
      await h.remove(communityId, owner, 'student-1');
      h.journal.clear();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({ removed: 0 });
      expect(await requestState(hand)).toBe('expired');
      expect(h.journal.eventNames()).toEqual(['live.speaker.expired']);
      expect(h.rtc.removed).toEqual([]);
      // Their next join is refused, and a join would find no floor anyway.
      expect(h.media.observed(session.id, 'student-1')).toBe('not_connected');
    });

    it('closes the presenter grant of a DISCONNECTED presenter who lost moderation (D21)', async () => {
      await presenter(false);
      const [grantId] = await h.grantsOf(
        communityId,
        owner,
        'teacher-2',
        'community.live.moderate',
      );
      const revoked = await h.communities.revokeGrant.execute({
        principal: owner,
        communityId,
        grantId,
        meta: META,
      });
      expect(revoked.ok).toBe(true);
      h.journal.clear();

      await h.reconciler.sweepParticipants();
      expect(await h.presenters.active(session.id)).toBeNull();
      expect(h.journal.events.map((event) => event.payload)).toEqual([
        expect.objectContaining({ userId: 'teacher-2', reason: 'ineligible', stoppedBy: null }),
      ]);
      // Still a member, still eligible: nobody is removed.
      expect(h.rtc.removed).toEqual([]);
    });

    it('closes a connected presenter’s grant when they no longer moderate, BEFORE the capability step', async () => {
      await presenter();
      h.rtc.connect(room, 'teacher-2', PRESENTING, ['screen_share']);
      const [grantId] = await h.grantsOf(
        communityId,
        owner,
        'teacher-2',
        'community.live.moderate',
      );
      await h.communities.revokeGrant.execute({
        principal: owner,
        communityId,
        grantId,
        meta: META,
      });
      h.journal.clear();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({ removed: 0, corrected: 1 });
      expect(h.journal.eventNames()).toEqual(['live.screen_share.stopped']);
      // The set pushed already lacks the screen — and, no longer a
      // moderator, the microphone by right.
      expect(capabilitiesOf('teacher-2')).toEqual(LISTENER);
      expect(h.rtc.observed(room).find((p) => p.identity === 'teacher-2')?.publishing).toEqual([]);
    });
  });

  describe('presenter authority follows live.speak (P6 decision 1)', () => {
    /** teacher-2's TEACHER permissions without identity's `live.speak`, as identity would now answer. */
    const withoutSpeak = (principal: Principal): Principal => {
      const permissions = [...principal.permissions].filter(
        (permission) => permission !== Permissions.live.speak,
      ) as Permission[];
      h.accounts.setPermissions(principal.userId, permissions);
      return { ...principal, permissions: new Set(permissions) };
    };
    const restoreSpeak = (principal: Principal): Principal => {
      const permissions = [...principal.permissions, Permissions.live.speak] as Permission[];
      h.accounts.setPermissions(principal.userId, permissions);
      return { ...principal, permissions: new Set(permissions) };
    };

    it('revokes the presenter slot of a moderator who loses live.speak; they stay a moderator, and the screen stops', async () => {
      const moderator = await presenter();
      h.rtc.connect(room, 'teacher-2', PRESENTING, ['microphone', 'screen_share']);
      const grant = await h.presenters.active(session.id);
      expect(grant?.userId).toBe('teacher-2');
      const silenced = withoutSpeak(moderator);
      h.journal.clear();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        removed: 0,
        corrected: 1,
        violations: 0,
        resets: 0,
      });

      // The slot is closed as `ineligible`, by the system, and announced.
      expect(await h.presenters.active(session.id)).toBeNull();
      expect(h.journal.eventNames()).toEqual(['live.screen_share.stopped']);
      expect(h.journal.events[0]?.payload).toEqual(
        expect.objectContaining({ userId: 'teacher-2', reason: 'ineligible', stoppedBy: null }),
      );
      // The screen cannot continue: the full set pushed has no screen (and,
      // without live.speak, no microphone by right); nothing is published.
      expect(capabilitiesOf('teacher-2')).toEqual(LISTENER);
      expect(h.rtc.observed(room).find((p) => p.identity === 'teacher-2')?.publishing).toEqual([]);
      // Still in the room, still a moderator of the session.
      expect(h.rtc.removed).toEqual([]);
      const view = await h.get.execute({ principal: silenced, sessionId: session.id });
      if (!view.ok) throw new Error(view.error.code);
      expect(view.value.me).toMatchObject({
        role: 'moderator',
        canModerate: true,
        presenting: false,
      });
      expect(view.value.presenterUserId).toBeNull();
      // A rejoin is issued no screen either.
      const ticket = await h.join.execute({
        principal: silenced,
        sessionId: session.id,
        meta: META,
      });
      if (!ticket.ok) throw new Error(ticket.error.code);
      expect(ticket.value.media).toEqual({ microphone: false, screen: false, screenAudio: false });
    });

    it('closes the slot of a DISCONNECTED presenter who lost live.speak, too', async () => {
      const moderator = await presenter(false);
      withoutSpeak(moderator);
      h.journal.clear();

      await h.reconciler.sweepParticipants();
      expect(await h.presenters.active(session.id)).toBeNull();
      expect(h.journal.eventNames()).toEqual(['live.screen_share.stopped']);
      expect(h.rtc.removed).toEqual([]);
    });

    it('does not give the slot back when live.speak returns: presenting again is an explicit new claim', async () => {
      const moderator = await presenter();
      h.rtc.connect(room, 'teacher-2', PRESENTING, ['microphone', 'screen_share']);
      const first = await h.presenters.active(session.id);
      withoutSpeak(moderator);
      await h.reconciler.sweepParticipants();
      expect(await h.presenters.active(session.id)).toBeNull();

      const restored = restoreSpeak(moderator);
      h.journal.clear();
      await h.reconciler.sweepParticipants();
      // Nothing restored by the sweep: no grant, no screen in any set pushed.
      expect(await h.presenters.active(session.id)).toBeNull();
      expect(h.journal.eventNames()).toEqual([]);
      expect(capabilitiesOf('teacher-2')?.canPublishScreen).toBe(false);
      const ticket = await h.join.execute({
        principal: restored,
        sessionId: session.id,
        meta: META,
      });
      if (!ticket.ok) throw new Error(ticket.error.code);
      expect(ticket.value.media.screen).toBe(false);

      // Only an explicit claim opens a NEW grant.
      const claimed = await h.presenter.claim({
        principal: restored,
        sessionId: session.id,
        meta: META,
      });
      if (!claimed.ok) throw new Error(claimed.error.code);
      expect(claimed.value.opened).toBe(true);
      const second = await h.presenters.active(session.id);
      expect(second?.userId).toBe('teacher-2');
      expect(second?.id).not.toBe(first?.id);
    });

    it('refuses the claim itself to a moderator without live.speak', async () => {
      const moderator = await h.delegate(
        communityId,
        owner,
        'teacher-2',
        'community.live.moderate',
      );
      const claimed = await h.presenter.claim({
        principal: withoutSpeak(moderator),
        sessionId: session.id,
        meta: META,
      });
      expect(claimed.ok ? null : claimed.error.code).toBe('live.presenter_not_permitted');
      expect(await h.presenters.active(session.id)).toBeNull();
    });
  });

  describe('capabilities', () => {
    it('corrects a wrong set with the FULL set, and watches — the first breach is not a violation', async () => {
      h.rtc.connect(
        room,
        'student-1',
        { ...LISTENER, canPublishAudio: true, canPublishData: true },
        ['microphone'],
      );

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        corrected: 1,
        violations: 0,
        resets: 0,
      });
      expect(h.rtc.capabilityChanges).toEqual([
        { roomName: room, identity: 'student-1', capabilities: LISTENER },
      ]);
      expect((await h.session(session.id)).enforcementViolations).toBe(0);
      expect(logs.lines).toContainEqual({
        level: 'log',
        fields: {
          event: 'live.reconciler.corrected',
          sessionId: session.id,
          userId: 'student-1',
          outcome: 'applied',
        },
      });
    });

    it('leaves alone whoever holds exactly their set — the host publishing by right among them', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        checked: 2,
        corrected: 0,
        pushed: 0,
      });
      expect(h.rtc.capabilityChanges).toEqual([]);
      expect(h.media.observed(session.id, 'teacher-1')).toBe('connected');
    });

    it('pushes a set BELOW the desired one — a grant not yet applied — and never counts it, however often', async () => {
      await speaker();
      for (let round = 0; round < 3; round += 1) {
        // The grant has not reached the provider (the client reconnected with an old token).
        h.rtc.connect(room, 'student-1', LISTENER);
        expect(await h.reconciler.sweepParticipants()).toMatchObject({
          pushed: 1,
          corrected: 0,
          violations: 0,
          resets: 0,
        });
        expect(capabilitiesOf('student-1')).toEqual(MICROPHONE);
      }
      expect(await h.session(session.id)).toMatchObject({
        enforcementViolations: 0,
        mediaRoomEpoch: 0,
      });
    });

    it('demotes again a speaker revoked 12 minutes ago who comes back publishing on a refreshed token', async () => {
      const hand = await speaker();
      await revokeFloor(hand);
      expect(capabilitiesOf('student-1')).toEqual(LISTENER);

      h.clock.advance(12 * 60);
      // The watch's window from Postgres has passed…
      expect(await h.reconciler.watchTick()).toMatchObject({ checked: 0 });
      // …and the client rejoins holding the microphone again.
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);

      expect(await h.reconciler.sweepParticipants()).toMatchObject({ corrected: 1 });
      expect(capabilitiesOf('student-1')).toEqual(LISTENER);
      expect(h.rtc.observed(room).find((p) => p.identity === 'student-1')?.publishing).toEqual([]);
    });

    it('counts a breach seen again after an applied correction as a violation — and extends the window', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();

      // Back with the microphone, inside the window: violation 1, and a reset.
      h.clock.advance(WATCH_TICK_SECONDS);
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
      const first = await h.session(session.id);
      expect(first).toMatchObject({ enforcementViolations: 1, mediaRoomEpoch: 1 });
      expect(first.lastViolationAt).toEqual(h.clock.now());

      // Past the first window, inside the extended one: still watched.
      h.clock.advance(ENFORCEMENT_WATCH_SECONDS - WATCH_TICK_SECONDS);
      const newRoom = h.room(session.id, 1);
      h.rtc.connect(newRoom, 'student-1', LISTENER);
      expect(await h.reconciler.watchTick()).toMatchObject({ checked: 1, violations: 0 });
      h.rtc.connect(newRoom, 'student-1', MICROPHONE, ['microphone']);
      expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
      expect(await h.session(session.id)).toMatchObject({
        enforcementViolations: 2,
        mediaRoomEpoch: 2,
        lastViolationAt: h.clock.now(),
      });

      // Once the window has passed with no breach, a breach is a first one again.
      h.clock.advance(ENFORCEMENT_WATCH_SECONDS);
      expect(await h.reconciler.watchTick()).toMatchObject({ checked: 0 });
      h.rtc.connect(h.room(session.id, 2), 'student-1', MICROPHONE, ['microphone']);
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        corrected: 1,
        violations: 0,
      });
    });

    it('resets the media exactly once for a second violation that the watch and the sweep see together', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      h.journal.clear();
      const ensuredBefore = h.rtc.ensured.length;

      const [swept, watched] = await Promise.all([
        h.reconciler.sweepParticipants(),
        h.reconciler.watchTick(),
      ]);

      expect(swept.resets + watched.resets).toBe(1);
      expect(swept.violations + watched.violations).toBe(1);
      const reset = await h.session(session.id);
      expect(reset).toMatchObject({ mediaRoomEpoch: 1, enforcementViolations: 1 });
      // The new room ensured, the old one ended — everyone in it disconnected.
      expect(h.rtc.ensured.slice(ensuredBefore).map((spec) => spec.roomName)).toEqual([
        h.room(session.id, 1),
      ]);
      expect(h.rtc.roomNames()).toEqual([h.room(session.id, 1)]);
      expect(h.rtc.ended).toEqual([room]);
      // Audited with a null actor, the violator as its target; no event.
      expect(h.journal.order).toEqual(['audit:live.session.media_reset']);
      expect(h.journal.entries[0]).toEqual({
        actorUserId: null,
        action: 'live.session.media_reset',
        resourceType: 'live.session',
        resourceId: session.id,
        at: h.clock.now(),
        metadata: { communityId, targetUserId: 'student-1', fromEpoch: 0, toEpoch: 1 },
        correlationId: undefined,
      });
      expect(
        h.store
          .moderationOf(session.id)
          .filter((action) => action.type === 'reset_media')
          .map(({ actorUserId, targetUserId }) => ({ actorUserId, targetUserId })),
      ).toEqual([{ actorUserId: null, targetUserId: 'student-1' }]);
      expect(logs.lines).toContainEqual({
        level: 'warn',
        fields: {
          event: 'live.session.media_reset',
          sessionId: session.id,
          targetUserId: 'student-1',
          fromEpoch: 0,
          toEpoch: 1,
        },
      });
    });

    it('lets a reset committed elsewhere during the violation win: the epoch compare-and-set decides, and nothing more is done', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      h.journal.clear();
      logs.lines.length = 0;
      const ensuredBefore = h.rtc.ensured.length;

      const pushing = h.rtc.hold('updateCapabilities');
      const watching = h.reconciler.watchTick();
      await pushing.reached;
      expect((await resetElsewhere(0))?.mediaRoomEpoch).toBe(1);
      pushing.release();

      // The violation is counted; the reset is the one that won, not a second.
      expect(await watching).toMatchObject({ violations: 1, resets: 0 });
      expect(await h.session(session.id)).toMatchObject({
        mediaRoomEpoch: 1,
        enforcementViolations: 1,
      });
      expect(h.store.moderationOf(session.id).filter((a) => a.type === 'reset_media')).toHaveLength(
        1,
      );
      expect(h.rtc.ensured.slice(ensuredBefore)).toEqual([]);
      expect(h.rtc.ended).toEqual([]);
      expect(h.journal.order).toEqual([]);
      expect(logs.events()).not.toContain('live.session.media_reset');
    });

    it('resets nothing for a violation in a session that ended meanwhile', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);

      const pushing = h.rtc.hold('updateCapabilities');
      const watching = h.reconciler.watchTick();
      await pushing.reached;
      expect(
        (await h.end.execute({ principal: owner, sessionId: session.id, meta: META })).ok,
      ).toBe(true);
      const ensuredBefore = h.rtc.ensured.length;
      pushing.release();

      expect(await watching).toMatchObject({ resets: 0 });
      expect(await h.session(session.id)).toMatchObject({ state: 'ended', mediaRoomEpoch: 0 });
      expect(h.store.moderationOf(session.id).some((a) => a.type === 'reset_media')).toBe(false);
      expect(h.rtc.ensured.slice(ensuredBefore)).toEqual([]);
      expect(h.audits()).not.toContain('live.session.media_reset');
    });

    it('ends the new room of a reset whose session ended while it was being made — ensure-then-recheck (§4.4)', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      const newRoom = h.room(session.id, 1);

      // The epoch is bumped, and the new room is on its way when End commits:
      // End ends the new room, which is not there yet.
      const ensuring = h.rtc.hold('ensureRoom');
      const watching = h.reconciler.watchTick();
      await ensuring.reached;
      expect(
        (await h.end.execute({ principal: owner, sessionId: session.id, meta: META })).ok,
      ).toBe(true);
      ensuring.release();

      expect(await watching).toMatchObject({ violations: 1, resets: 1 });
      expect(await h.session(session.id)).toMatchObject({ state: 'ended', mediaRoomEpoch: 1 });
      // Ending is final: neither room of the ended session is left.
      expect(h.rtc.roomNames()).toEqual([]);
      expect(h.rtc.ended).toEqual([newRoom, newRoom, room]);
      // Never reported as ensured: a join's sample asks the provider, which has no such room.
      expect(await h.occupancy.sample(newRoom)).toEqual({ kind: 'missing' });
    });

    it('ends the new room of a reset that another reset moved on while it was being made', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);

      const ensuring = h.rtc.hold('ensureRoom');
      const watching = h.reconciler.watchTick();
      await ensuring.reached;
      expect((await resetElsewhere(1))?.mediaRoomEpoch).toBe(2);
      ensuring.release();

      expect(await watching).toMatchObject({ violations: 1, resets: 1 });
      // Epoch 1 is nobody's room: ended with the old one. Epoch 2's room is its
      // own reset's — or the room sweep's — to make.
      expect(h.rtc.roomNames()).toEqual([]);
      expect(h.rtc.ended).toEqual([h.room(session.id, 1), room]);
    });

    describe('a moderator’s change racing the check (D22)', () => {
      /** The next standing read of student-1 runs `act` first — landing between observation and standing. */
      function beforeStanding(act: () => Promise<void>): void {
        const read = h.standing.ofAccounts.bind(h.standing);
        let pending: (() => Promise<void>) | null = act;
        jest.spyOn(h.standing, 'ofAccounts').mockImplementation(async (at, userIds) => {
          if (pending !== null && userIds.includes('student-1')) {
            const running = pending;
            pending = null;
            await running();
          }
          return read(at, userIds);
        });
      }

      /** The floor given again, and the speaker speaking on it. */
      async function speaking(): Promise<SpeakerRequestView> {
        const hand = await speaker();
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        return hand;
      }

      it('counts no violation, and resets nothing, for a breach observed before a revoke that landed — a genuine repeat still resets once', async () => {
        const first = await speaking();
        beforeStanding(async () => {
          await revokeFloor(first);
        });
        // Observed on the microphone, compared with no floor: corrected.
        expect(await h.reconciler.sweepParticipants()).toMatchObject({
          corrected: 1,
          violations: 0,
        });
        jest.restoreAllMocks();

        h.clock.advance(60);
        const second = await speaking();
        beforeStanding(async () => {
          await revokeFloor(second);
          // The moderator's own push applied before the standing was read.
          expect(capabilitiesOf('student-1')).toEqual(LISTENER);
        });
        h.clock.advance(WATCH_TICK_SECONDS);
        // The same again, inside the window of an applied correction: still a
        // correction — the observation predates the revoke.
        expect(await h.reconciler.watchTick()).toMatchObject({
          corrected: 1,
          violations: 0,
          resets: 0,
        });
        expect(await h.session(session.id)).toMatchObject({
          mediaRoomEpoch: 0,
          enforcementViolations: 0,
        });
        expect(h.audits()).not.toContain('live.session.media_reset');
        jest.restoreAllMocks();

        // Back on the microphone with no floor, and nothing changed meanwhile:
        // a violation, and exactly one reset.
        h.clock.advance(WATCH_TICK_SECONDS);
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
        expect(await h.reconciler.watchTick()).toMatchObject({ violations: 0, resets: 0 });
        expect(await h.session(session.id)).toMatchObject({
          mediaRoomEpoch: 1,
          enforcementViolations: 1,
        });
      });

      it('counts no violation for a breach observed while the moderator’s push was still on its way — and corrects only after it, in turn', async () => {
        // An applied correction, and so a live window.
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        expect(await h.reconciler.sweepParticipants()).toMatchObject({ corrected: 1 });
        const hand = await speaking();

        // The revoke has committed; its push waits at the provider while the
        // watch observes the microphone and reads no floor.
        const pushing = h.rtc.hold('updateCapabilities');
        const revoking = revokeFloor(hand);
        await pushing.reached;
        const pushes = () => h.rtc.calls.filter((c) => c.operation === 'updateCapabilities');
        const before = pushes().length;
        const correcting = jest.spyOn(h.media, 'pushNow');
        const watching = h.reconciler.watchTick();
        while (correcting.mock.calls.length === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        // The correction waits its turn behind the revoke's push (P7.2): it
        // reaches the provider only once that push has landed.
        for (let turn = 0; turn < 20; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(pushes()).toHaveLength(before);
        pushing.release();

        expect((await revoking).media).toBe('applied');
        expect(await watching).toMatchObject({ corrected: 1, violations: 0, resets: 0 });
        expect(pushes()).toHaveLength(before + 1);
        expect(await h.session(session.id)).toMatchObject({
          mediaRoomEpoch: 0,
          enforcementViolations: 0,
        });
        expect(capabilitiesOf('student-1')).toEqual(LISTENER);
      });

      it('counts no violation for a breach observed before a revoke another instance committed — its push not yet made', async () => {
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        expect(await h.reconciler.sweepParticipants()).toMatchObject({ corrected: 1 });
        const hand = await speaking();
        // Committed elsewhere: this process pushes nothing, and knows only the
        // session's version.
        beforeStanding(async () => {
          const revoked = await h.requests.transition({
            requestId: hand.id,
            from: ['granted'],
            to: 'revoked',
            at: h.clock.now(),
            by: 'teacher-1',
            moderation: null,
          });
          expect(revoked?.kind).toBe('applied');
        });

        expect(await h.reconciler.watchTick()).toMatchObject({
          corrected: 1,
          violations: 0,
          resets: 0,
        });
        expect(await h.session(session.id)).toMatchObject({
          mediaRoomEpoch: 0,
          enforcementViolations: 0,
        });
      });

      it('counts no violation when a reset elsewhere moved the session between observation and standing', async () => {
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        await h.reconciler.sweepParticipants();
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        beforeStanding(async () => {
          expect((await resetElsewhere(0))?.mediaRoomEpoch).toBe(1);
        });

        expect(await h.reconciler.watchTick()).toMatchObject({ violations: 0, resets: 0 });
        expect(await h.session(session.id)).toMatchObject({
          mediaRoomEpoch: 1,
          enforcementViolations: 0,
        });
      });

      it('counts no violation when the session ended between observation and standing', async () => {
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        await h.reconciler.sweepParticipants();
        h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
        beforeStanding(async () => {
          expect(
            (await h.end.execute({ principal: owner, sessionId: session.id, meta: META })).ok,
          ).toBe(true);
        });

        expect(await h.reconciler.watchTick()).toMatchObject({ violations: 0, resets: 0 });
        expect(await h.session(session.id)).toMatchObject({
          state: 'ended',
          mediaRoomEpoch: 0,
          enforcementViolations: 0,
        });
      });
    });

    it('acts on nobody else in the room a reset just deleted: the rest wait for the next tick, in the new room', async () => {
      for (const userId of ['student-1', 'student-2']) {
        h.rtc.connect(room, userId, MICROPHONE, ['microphone']);
      }
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ corrected: 2 });
      for (const userId of ['student-1', 'student-2']) {
        h.rtc.connect(room, userId, MICROPHONE, ['microphone']);
      }
      const from = h.rtc.calls.length;

      expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
      const calls = h.rtc.calls.slice(from);
      const ended = calls.findIndex(
        (call) => call.operation === 'endRoom' && call.roomName === room,
      );
      expect(ended).toBeGreaterThanOrEqual(0);
      // Nothing more was asked of the deleted room.
      expect(calls.slice(ended + 1).filter((call) => call.roomName === room)).toEqual([]);
      expect(await h.session(session.id)).toMatchObject({
        mediaRoomEpoch: 1,
        enforcementViolations: 1,
      });
    });

    it('removes, then resets on a removed member who comes straight back', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      await h.remove(communityId, owner, 'student-1');
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ removed: 1, violations: 0 });

      h.rtc.connect(room, 'student-1', LISTENER);
      expect(await h.reconciler.watchTick()).toMatchObject({
        removed: 1,
        violations: 1,
        resets: 1,
      });
      expect((await h.session(session.id)).mediaRoomEpoch).toBe(1);
    });

    it('after a revoke during an outage and recovery with the speaker still publishing: ONE corrective push, NO reset (D22)', async () => {
      const hand = await speaker();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      h.rtc.setUnavailable(true);
      expect((await revokeFloor(hand)).media).toBe('pending');
      expect(await h.reconciler.watchTick()).toMatchObject({ skipped: 'provider_unavailable' });
      h.rtc.setUnavailable(false);
      const pushes = h.rtc.capabilityChanges.length;

      expect(await h.reconciler.watchTick()).toMatchObject({ corrected: 1, violations: 0 });
      expect(await h.reconciler.watchTick()).toMatchObject({ corrected: 0, violations: 0 });
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        corrected: 0,
        violations: 0,
      });
      expect(h.rtc.capabilityChanges.slice(pushes)).toEqual([
        { roomName: room, identity: 'student-1', capabilities: LISTENER },
      ]);
      expect(await h.session(session.id)).toMatchObject({
        mediaRoomEpoch: 0,
        enforcementViolations: 0,
      });
      expect(h.media.unsettled()).toEqual([]);
    });

    it('never takes a failed correction for the earlier one: the repeat is corrected, not counted (D22)', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      h.rtc.failNext('updateCapabilities', 'unavailable');
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: 'provider_unavailable',
      });

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        corrected: 1,
        violations: 0,
      });
      expect((await h.session(session.id)).enforcementViolations).toBe(0);
    });

    it('never takes a correction that found nobody for the earlier one (D22)', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      const pushing = h.rtc.hold('updateCapabilities');
      const sweeping = h.reconciler.sweepParticipants();
      await pushing.reached;
      h.rtc.disconnect(room, 'student-1');
      pushing.release();
      expect(await sweeping).toMatchObject({ corrected: 0, violations: 0 });

      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      expect(await h.reconciler.watchTick()).toMatchObject({ corrected: 1, violations: 0 });
      expect(await h.session(session.id)).toMatchObject({
        enforcementViolations: 0,
        mediaRoomEpoch: 0,
      });
    });

    it('ignores identities that are not people — recorders, ingress, agents', async () => {
      h.rtc.observe(room, [
        {
          identity: 'EG_recorder',
          state: 'active',
          standard: false,
          joinedAt: h.clock.now(),
          publishing: ['microphone'],
          capabilities: MICROPHONE,
        },
      ]);
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ checked: 0, removed: 0 });
      expect(permittedAmong).not.toHaveBeenCalled();
      expect(h.rtc.removed).toEqual([]);
    });
  });

  describe('the community’s lifecycle', () => {
    const head = (runningLiveContinues: boolean): CommunityHead => ({
      communityId,
      membershipVersion: 1,
      lifecycleVersion: 1,
      effects: {
        acceptsMembers: false,
        chatReadable: false,
        chatPostingOpen: false,
        liveStartOpen: false,
        liveJoinOpen: false,
        runningLiveContinues,
      },
    });

    it('ends the session `community_closed` — and does nothing else — when a running session may not continue', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      jest.spyOn(h.communities.membership, 'heads').mockResolvedValue([head(false)]);
      h.journal.clear();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({ ended: 1, checked: 0 });
      expect(await h.session(session.id)).toMatchObject({
        state: 'ended',
        endReason: 'community_closed',
        endedBy: null,
      });
      expect(h.journal.eventNames()).toEqual(['live.session.ended']);
      expect(h.rtc.capabilityChanges).toEqual([]);
      expect(h.rtc.removed).toEqual([]);
    });

    it('ends it when Communities no longer knows the community', async () => {
      jest.spyOn(h.communities.membership, 'heads').mockResolvedValue([]);
      expect(await h.reconciler.sweepParticipants()).toMatchObject({ ended: 1 });
      expect((await h.session(session.id)).endReason).toBe('community_closed');
    });

    describe('a community Communities can no longer resolve fails closed (P6 decision 2)', () => {
      /** Communities, asked about the community, knows nothing of it. */
      const forgetCommunity = () => {
        jest.spyOn(h.communities.membership, 'heads').mockResolvedValue([]);
        jest.spyOn(h.authorization, 'authorize').mockResolvedValue({
          ok: false,
          error: { kind: 'not_found', code: 'communities.not_found', message: 'not found' },
        });
        jest.spyOn(h.authorization, 'permittedAmong').mockResolvedValue([]);
      };

      it('ends the session community_closed at the next sweep: everything open closes, the room ends, nobody is re-authorized', async () => {
        const hand = await speaker();
        await presenter();
        h.rtc.connect(room, 'teacher-2', PRESENTING, ['microphone', 'screen_share']);
        forgetCommunity();
        h.journal.clear();
        const pushedBefore = h.rtc.capabilityChanges.length;

        expect(await h.reconciler.sweepParticipants()).toMatchObject({ ended: 1, checked: 0 });
        expect(await h.session(session.id)).toMatchObject({
          state: 'ended',
          endReason: 'community_closed',
          endedBy: null,
        });
        // One ended event implies every expiry and the presenter's close.
        expect(h.journal.eventNames()).toEqual(['live.session.ended']);
        expect(await requestState(hand)).toBe('expired');
        expect(await h.presenters.active(session.id)).toBeNull();
        expect(h.rtc.ended).toContain(room);
        expect(h.rtc.roomNames()).not.toContain(room);
        // No capability was pushed from membership nobody can vouch for.
        expect(h.rtc.capabilityChanges).toHaveLength(pushedBefore);

        // It stays ended: nothing restarts it, and no participant step runs.
        expect(await h.reconciler.sweepParticipants()).toMatchObject({ sessions: 0, ended: 0 });
        expect((await h.session(session.id)).state).toBe('ended');
      });

      it('never assumes membership meanwhile: before any sweep, join, raise and moderation are refused as unknown', async () => {
        forgetCommunity();
        const join = await h.join.execute({
          principal: student,
          sessionId: session.id,
          meta: META,
        });
        expect(join.ok ? null : join.error.code).toBe('live.session_not_found');
        const raise = await h.raise.execute({
          principal: student,
          sessionId: session.id,
          meta: META,
        });
        expect(raise.ok ? null : raise.error.code).toBe('live.session_not_found');
        const end = await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
        expect(end.ok ? null : end.error.code).toBe('live.session_not_found');
        expect(h.rtc.issued.filter((grant) => grant.identity === 'student-1')).toEqual([]);
        expect((await h.session(session.id)).state).toBe('live');
      });
    });
  });

  describe('failures — never on unknown state (D23)', () => {
    it('skips the session when `permittedAmong` rejects: nobody ejected, nothing expired', async () => {
      const hand = await speaker();
      await h.remove(communityId, owner, 'student-1');
      jest
        .spyOn(h.authorization, 'permittedAmong')
        .mockRejectedValue(new Error('the store is unreachable at 10.0.0.7'));
      h.journal.clear();

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        sessionsSkipped: 1,
        removed: 0,
      });
      expect(h.rtc.removed).toEqual([]);
      expect(await requestState(hand)).toBe('granted');
      expect(h.journal.order).toEqual([]);
      expect(logs.lines).toContainEqual({
        level: 'error',
        fields: {
          event: 'live.reconciler.session_skipped',
          stage: 'session',
          sessionId: session.id,
          err: { name: 'Error' },
        },
      });
      expect(JSON.stringify(logs.lines)).not.toContain('10.0.0.7');
    });

    it.each(['community.live.remain', 'community.live.moderate'] as const)(
      'skips the session when only `permittedAmong(%s)` rejects: a partial answer is no answer — nobody ejected, demoted or expired',
      async (failing) => {
        // Everyone is still a member here: any action would be taken on a
        // guess, from the other questions' answers alone.
        const hand = await speaker();
        const permittedAmong = h.authorization.permittedAmong.bind(h.authorization);
        jest
          .spyOn(h.authorization, 'permittedAmong')
          .mockImplementation((id, userIds, act) =>
            act === failing
              ? Promise.reject(new Error('one query timed out'))
              : permittedAmong(id, userIds, act),
          );
        const pushed = h.rtc.capabilityChanges.length;
        h.journal.clear();

        expect(await h.reconciler.sweepParticipants()).toMatchObject({
          sessionsSkipped: 1,
          removed: 0,
          corrected: 0,
        });
        expect(h.rtc.removed).toEqual([]);
        expect(h.rtc.capabilityChanges).toHaveLength(pushed);
        expect(await requestState(hand)).toBe('granted');
        expect(h.journal.order).toEqual([]);
      },
    );

    it('skips the session when identity’s `live.speak` lookup rejects: nobody demoted', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      jest.spyOn(h.accounts, 'withPermission').mockRejectedValue(new Error('directory down'));

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        sessionsSkipped: 1,
        corrected: 0,
      });
      expect(h.rtc.capabilityChanges).toEqual([]);
      expect(capabilitiesOf('student-1')).toEqual(MICROPHONE);
    });

    it('skips the session when `heads` rejects: nothing ended, nobody touched', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      jest.spyOn(h.communities.membership, 'heads').mockRejectedValue(new Error('timeout'));

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        sessionsSkipped: 1,
        ended: 0,
        corrected: 0,
      });
      expect((await h.session(session.id)).state).toBe('live');
      expect(h.rtc.capabilityChanges).toEqual([]);
    });

    it('skips the session when Postgres fails reading the holders', async () => {
      const hand = await speaker();
      h.rtc.disconnect(room, 'student-1');
      await h.remove(communityId, owner, 'student-1');
      jest.spyOn(h.requests, 'granted').mockRejectedValue(new Error('connection reset'));

      expect(await h.reconciler.sweepParticipants()).toMatchObject({ sessionsSkipped: 1 });
      expect(await requestState(hand)).toBe('granted');
    });

    it('skips the session when the provider cannot list its participants — and the whole tick on an outage', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      h.rtc.failNext('listParticipants', 'fault');
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: null,
        sessionsSkipped: 1,
      });
      h.rtc.failNext('listParticipants', 'unavailable');
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        skipped: 'provider_unavailable',
      });
      expect(h.rtc.capabilityChanges).toEqual([]);
    });

    it('decides nothing for anyone when a later batch of standing fails after an earlier one answered', async () => {
      // More people connected than one batch holds — none of them a member.
      const strangers = Array.from({ length: MAX_AUTHORIZE_BATCH + 1 }, (_, n) => `stranger-${n}`);
      for (const userId of strangers) h.rtc.connect(room, userId, LISTENER);
      const ofAccounts = h.standing.ofAccounts.bind(h.standing);
      const batches: number[] = [];
      const spy = jest.spyOn(h.standing, 'ofAccounts').mockImplementation(async (at, ids) => {
        batches.push(ids.length);
        if (batches.length === 2) throw new Error('connection reset');
        return ofAccounts(at, ids);
      });

      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        sessionsSkipped: 1,
        removed: 0,
      });
      expect(batches).toEqual([MAX_AUTHORIZE_BATCH, 2]);
      // The first batch's answer — every one of them ineligible — was not acted on.
      expect(h.rtc.removed).toEqual([]);

      spy.mockRestore();
      expect(await h.reconciler.sweepParticipants()).toMatchObject({
        removed: MAX_AUTHORIZE_BATCH + 1,
      });
    });

    it('skips a session of the watch whose `getParticipant` fails, and carries on', async () => {
      const hand = await speaker();
      await revokeFloor(hand);
      h.rtc.failNext('getParticipant', 'fault');
      expect(await h.reconciler.watchTick()).toMatchObject({ sessionsSkipped: 1, checked: 0 });
      expect(await h.reconciler.watchTick()).toMatchObject({ sessionsSkipped: 0, checked: 1 });
    });
  });

  describe('the targeted watch', () => {
    it('applies at the next watch tick after recovery a grant pushed during an outage', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      const hand = await h.raised(student, session.id);
      h.rtc.setUnavailable(true);
      const granted = await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      expect(granted).toMatchObject({ ok: true, value: { media: 'pending' } });
      expect(h.media.unsettled().map((push) => push.userId)).toEqual(['student-1']);
      h.rtc.setUnavailable(false);

      expect(await h.reconciler.watchTick()).toMatchObject({ pushed: 1, violations: 0 });
      expect(capabilitiesOf('student-1')).toEqual(MICROPHONE);
      expect(h.media.unsettled()).toEqual([]);
      expect(h.media.observed(session.id, 'student-1')).toBe('connected');
    });

    it('finds a closed floor from Postgres alone — nothing in memory — and corrects the speaker back on the mic', async () => {
      const hand = await speaker();
      await revokeFloor(hand);
      expect(h.media.unsettled()).toEqual([]);
      h.clock.advance(ENFORCEMENT_WATCH_SECONDS - WATCH_TICK_SECONDS);
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);

      // A reconciler with an empty watch, as after a restart.
      const fresh = h.reconcilerWith();
      expect(await fresh.watchTick()).toMatchObject({ checked: 1, corrected: 1, violations: 0 });
      expect(capabilitiesOf('student-1')).toEqual(LISTENER);
      expect(h.rtc.calls.filter((call) => call.operation === 'listParticipants')).toEqual([]);
    });

    it('drains an unsettled push of someone who has left: their next join computes their set', async () => {
      const hand = await speaker();
      h.rtc.disconnect(room, 'student-1');
      await revokeFloor(hand);
      expect(h.media.unsettled().map((push) => push.userId)).toEqual(['student-1']);

      await h.reconciler.watchTick();
      expect(h.media.unsettled()).toEqual([]);
      expect(h.media.observed(session.id, 'student-1')).toBe('not_connected');
    });

    it('drops the watch of a session that ended', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      const calls = h.rtc.calls.length;
      expect(await h.reconciler.watchTick()).toMatchObject({ sessions: 0, checked: 0 });
      expect(await h.reconciler.checkIdentities(session.id, ['student-1'])).toMatchObject({
        outcome: 'not_live',
      });
      expect(h.rtc.calls.slice(calls)).toEqual([]);
    });
  });

  describe('the per-session steps (for ProtectLiveSessions)', () => {
    it('checkIdentities runs the per-identity step for exactly the people named', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      h.rtc.connect(room, 'student-2', MICROPHONE, ['microphone']);
      await h.remove(communityId, owner, 'student-1');

      expect(await h.reconciler.checkIdentities(session.id, ['student-1', 'student-1'])).toEqual({
        outcome: 'checked',
        checked: 1,
        removed: 1,
        corrected: 0,
        pushed: 0,
        violations: 0,
        resets: 0,
      });
      // Nobody else was looked at.
      expect(capabilitiesOf('student-2')).toEqual(MICROPHONE);
    });

    it('checkSession runs the participant sweep’s step for one session', async () => {
      h.rtc.connect(room, 'student-2', MICROPHONE, ['microphone']);
      expect(await h.reconciler.checkSession(session.id)).toMatchObject({
        outcome: 'checked',
        corrected: 1,
      });
      expect(await h.reconciler.checkSession('00000000-0000-4000-8000-00000000abcd')).toMatchObject(
        { outcome: 'not_live' },
      );
    });

    it('steps on the room the session uses now: after a reset, both checks look in the new room', async () => {
      expect((await resetElsewhere(0))?.mediaRoomEpoch).toBe(1);
      const current = h.room(session.id, 1);
      await h.rtc.ensureRoom({
        roomName: current,
        maxParticipants: 310,
        emptyTimeoutSeconds: 60,
        departureTimeoutSeconds: 60,
      });
      h.rtc.connect(current, 'student-2', MICROPHONE, ['microphone']);

      expect(await h.reconciler.checkSession(session.id)).toMatchObject({
        outcome: 'checked',
        corrected: 1,
      });
      h.rtc.connect(current, 'student-1', MICROPHONE, ['microphone']);
      expect(await h.reconciler.checkIdentities(session.id, ['student-1'])).toMatchObject({
        outcome: 'checked',
        corrected: 1,
      });
      expect(h.rtc.capabilityChanges).toEqual([
        { roomName: current, identity: 'student-2', capabilities: LISTENER },
        { roomName: current, identity: 'student-1', capabilities: LISTENER },
      ]);
    });

    it('serializes every step for one session: a check waits for the one in flight, and sees what it did', async () => {
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
      await h.reconciler.sweepParticipants();
      h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);

      const listing = h.rtc.hold('listParticipants');
      const swept = h.reconciler.checkSession(session.id);
      await listing.reached;
      let checked = false;
      const identities = h.reconciler.checkIdentities(session.id, ['student-1']).then((report) => {
        checked = true;
        return report;
      });
      await new Promise((resolve) => setImmediate(resolve));
      // Not a single provider call of the second step while the first holds the session.
      expect(checked).toBe(false);
      expect(h.rtc.calls.filter((call) => call.operation === 'getParticipant')).toEqual([]);
      listing.release();

      expect(await swept).toMatchObject({ violations: 1, resets: 1 });
      // The second step ran on the session as the reset left it: the new room, where nobody is.
      expect(await identities).toMatchObject({ outcome: 'checked', violations: 0, resets: 0 });
      expect(h.rtc.calls.filter((call) => call.operation === 'getParticipant')).toEqual([
        expect.objectContaining({ roomName: h.room(session.id, 1), identity: 'student-1' }),
      ]);
      expect((await h.session(session.id)).mediaRoomEpoch).toBe(1);
    });

    it('never throws: a dependency failing is a `skipped` report', async () => {
      jest.spyOn(h.sessions, 'findById').mockRejectedValue(new Error('down'));
      await expect(h.reconciler.checkSession(session.id)).resolves.toMatchObject({
        outcome: 'skipped',
      });
      await expect(h.reconciler.checkIdentities(session.id, ['student-1'])).resolves.toMatchObject({
        outcome: 'skipped',
      });
    });
  });

  it('a reset outage after the bump is left to the room sweep: the new room ensured, the old one ended as an orphan', async () => {
    h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
    await h.reconciler.sweepParticipants();
    h.rtc.connect(room, 'student-1', MICROPHONE, ['microphone']);
    h.rtc.failNext('ensureRoom', 'unavailable');

    expect(await h.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });
    expect((await h.session(session.id)).mediaRoomEpoch).toBe(1);
    expect(h.rtc.roomNames()).toEqual([room]);
    expect(h.audits()).toContain('live.session.media_reset');

    h.clock.advance(60);
    expect(await h.reconciler.sweepRooms()).toMatchObject({ ensured: 1, orphansEnded: 1 });
    expect(h.rtc.roomNames()).toEqual([h.room(session.id, 1)]);
  });
});
