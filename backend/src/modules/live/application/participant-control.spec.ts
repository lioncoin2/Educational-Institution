import type { Principal } from '../../../shared';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { LiveEvents } from '../contracts';
import { mediaReset as mediaResetFact } from '../domain/events';
import type { ModerationAction } from '../domain/moderation';
import { RtcUnavailableError } from '../domain/rtc-provider';
import { capabilitiesFor } from '../domain/standing';

/** Enough rights to be in the room, nothing to publish. */
const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});

/** A well-formed id no session has. */
const UNKNOWN_SESSION = '00000000-0000-4000-8000-00000000abcd';

/**
 * Q64 participant control (live.md §9, §11.4; ADR 0026): a moderator removes a
 * participant from a live session — an administrative disconnect, never a ban
 * — or resets the session's media room. Both run over the REAL Communities:
 * who may act is Communities' answer through `LiveAccess`, within identity's
 * ceiling; the media plane is reached only through the RTC ports; and a
 * removal reaches the plane but never a ban, so the person may re-join at once.
 */
describe('Q64 — participant control', () => {
  let h: LiveHarness;
  let communityId: string;
  /** The host (teacher-1), who started the session. */
  let owner: Principal;
  /** A TEACHER member holding `community.live.moderate`. */
  let moderator: Principal;
  /** A STUDENT member: below the identity ceiling for `live.moderate`. */
  let member: Principal;
  /** A TEACHER member with no moderate standing in this community. */
  let teacherMember: Principal;
  /** A STUDENT member to be removed. */
  let target: Principal;
  /** A TEACHER who is not a member of this community at all. */
  let outsider: Principal;
  let sessionId: string;
  let room: string;

  beforeEach(async () => {
    h = liveHarness();
    const community = await h.community('teacher-1', 'student-1', 'student-2');
    communityId = community.id;
    owner = community.owner;
    [member, target] = community.students;
    moderator = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    teacherMember = await h.member(communityId, owner, 'teacher-3', ['TEACHER']);
    outsider = h.person('outsider-1', ['TEACHER']);
    const session = await h.startSession(owner, communityId);
    sessionId = session.id;
    room = h.room(sessionId);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('removing a participant', () => {
    it('removes a connected participant, revoking their tokens, and records the act and the fact', async () => {
      h.rtc.connect(room, target.userId, LISTENER);
      const now = h.clock.now();

      const result = await h.kick.execute({
        principal: moderator,
        sessionId,
        targetUserId: target.userId,
        meta: META,
      });

      expect(result.ok && result.value).toEqual({ removed: true });
      // The media plane was reached once, through the port, revoking issued tokens.
      expect(h.rtc.removed).toEqual([
        { roomName: room, identity: target.userId, revokeTokensIssuedBefore: now },
      ]);
      // The fact, for the realtime relay — ids only, the reason null when none was given.
      const events = h.journal.events.filter(
        (event) => event.name === LiveEvents.participantRemoved,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateId: sessionId,
        payload: {
          sessionId,
          communityId,
          userId: target.userId,
          removedBy: moderator.userId,
          reason: null,
        },
      });
      // The audit, with the permit it ran on and the target.
      const audits = h.journal.entries.filter(
        (entry) => entry.action === 'live.participant.removed',
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: moderator.userId,
        resourceType: 'live.session',
        resourceId: sessionId,
        metadata: {
          communityId,
          targetUserId: target.userId,
          reason: null,
          permit: { act: 'community.live.moderate', basis: 'grant' },
        },
      });
    });

    it('lets the host remove a participant too', async () => {
      h.rtc.connect(room, target.userId, LISTENER);
      const result = await h.kick.execute({
        principal: owner,
        sessionId,
        targetUserId: target.userId,
        meta: META,
      });
      expect(result.ok && result.value).toEqual({ removed: true });
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual([target.userId]);
    });

    it('records a reason code when given, and refuses one that is not a code — before any removal', async () => {
      h.rtc.connect(room, target.userId, LISTENER);
      const ok = await h.kick.execute({
        principal: moderator,
        sessionId,
        targetUserId: target.userId,
        reason: 'off_topic',
        meta: META,
      });
      expect(ok.ok && ok.value).toEqual({ removed: true });
      expect(
        h.journal.events.find((event) => event.name === LiveEvents.participantRemoved),
      ).toMatchObject({ payload: { reason: 'off_topic' } });
      expect(
        h.journal.entries.find((entry) => entry.action === 'live.participant.removed'),
      ).toMatchObject({ metadata: { reason: 'off_topic' } });

      // Free text is not a code: refused before the store, before the media plane.
      const bad = await h.kick.execute({
        principal: moderator,
        sessionId,
        targetUserId: member.userId,
        reason: 'He was very rude!',
        meta: META,
      });
      expect(codeOf(bad)).toBe('live.reason_invalid');
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual([target.userId]);
    });

    it('answers removed:false — auditing nothing, announcing nothing — when the person is not in the room', async () => {
      // `target` was never connected to the fake room.
      const result = await h.kick.execute({
        principal: moderator,
        sessionId,
        targetUserId: target.userId,
        meta: META,
      });
      expect(result.ok && result.value).toEqual({ removed: false });
      expect(h.rtc.removed).toEqual([]);
      expect(h.journal.eventNames()).not.toContain(LiveEvents.participantRemoved);
      expect(h.audits()).not.toContain('live.participant.removed');
    });

    it('fails closed on a provider outage — 503, never a false success, nothing audited', async () => {
      jest
        .spyOn(h.rtc, 'removeParticipant')
        .mockRejectedValueOnce(new RtcUnavailableError('removeParticipant'));
      const result = await h.kick.execute({
        principal: moderator,
        sessionId,
        targetUserId: target.userId,
        meta: META,
      });
      expect(result.ok).toBe(false);
      expect(codeOf(result)).toBe('live.media_unavailable');
      expect(h.journal.eventNames()).not.toContain(LiveEvents.participantRemoved);
      expect(h.audits()).not.toContain('live.participant.removed');
    });

    it('refuses a student by the identity ceiling (403), a teacher who does not moderate (403), and tells an outsider nothing (404)', async () => {
      h.rtc.connect(room, target.userId, LISTENER);
      const kickBy = (principal: Principal) =>
        h.kick.execute({ principal, sessionId, targetUserId: target.userId, meta: META });
      // A student is below the coarse ceiling: denied before Communities is asked.
      expect(codeOf(await kickBy(member))).toBe('identity.permission_denied');
      // A teacher member passes the ceiling, but is no moderator here.
      expect(codeOf(await kickBy(teacherMember))).toBe('live.not_a_moderator');
      // An outsider may not even see the session: one 404, whether it exists or not.
      expect(codeOf(await kickBy(outsider))).toBe('live.session_not_found');
      // All refused before the media plane: no one was removed.
      expect(h.rtc.removed).toEqual([]);
    });

    it('refuses to remove the host', async () => {
      h.rtc.connect(room, owner.userId, LISTENER);
      expect(
        codeOf(
          await h.kick.execute({
            principal: moderator,
            sessionId,
            targetUserId: owner.userId,
            meta: META,
          }),
        ),
      ).toBe('live.target_is_host');
      expect(h.rtc.removed).toEqual([]);
    });

    it('keeps no ban: the removed person may re-join at once', async () => {
      h.rtc.connect(room, target.userId, LISTENER);
      expect(
        (
          await h.kick.execute({
            principal: moderator,
            sessionId,
            targetUserId: target.userId,
            meta: META,
          })
        ).ok,
      ).toBe(true);

      const rejoined = await h.join.execute({ principal: target, sessionId, meta: META });
      expect(rejoined.ok).toBe(true);
      expect(rejoined.ok && rejoined.value.token).toBeTruthy();
    });

    it('answers a malformed or unknown session as not found, a malformed target as not in the session', async () => {
      // Well-formed but unknown, and malformed, are both one 404 — before any media call.
      expect(
        codeOf(
          await h.kick.execute({
            principal: moderator,
            sessionId: UNKNOWN_SESSION,
            targetUserId: target.userId,
            meta: META,
          }),
        ),
      ).toBe('live.session_not_found');
      expect(
        codeOf(
          await h.kick.execute({
            principal: moderator,
            sessionId: 'bad id',
            targetUserId: target.userId,
            meta: META,
          }),
        ),
      ).toBe('live.session_not_found');
      // A target of a shape no identity could have (a space is not in the id set).
      expect(
        codeOf(
          await h.kick.execute({
            principal: moderator,
            sessionId,
            targetUserId: 'bad id',
            meta: META,
          }),
        ),
      ).toBe('live.target_not_in_session');
      expect(h.rtc.removed).toEqual([]);
    });

    it('refuses once the session has ended', async () => {
      expect((await h.end.execute({ principal: owner, sessionId, meta: META })).ok).toBe(true);
      expect(
        codeOf(
          await h.kick.execute({
            principal: moderator,
            sessionId,
            targetUserId: target.userId,
            meta: META,
          }),
        ),
      ).toBe('live.session_not_live');
    });
  });

  describe('resetting the media room', () => {
    it('bumps the epoch, ensures the new room, and records the act and the fact', async () => {
      expect((await h.session(sessionId)).mediaRoomEpoch).toBe(0);

      const result = await h.reset.execute({ principal: moderator, sessionId, meta: META });
      expect(result.ok && result.value).toEqual({ reset: true });

      expect((await h.session(sessionId)).mediaRoomEpoch).toBe(1);
      expect(h.rtc.ensured.map((spec) => spec.roomName)).toContain(h.room(sessionId, 1));

      const events = h.journal.events.filter((event) => event.name === LiveEvents.mediaReset);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateId: sessionId,
        payload: { sessionId, communityId, fromEpoch: 0, toEpoch: 1, resetBy: moderator.userId },
      });
      const audits = h.journal.entries.filter(
        (entry) => entry.action === 'live.session.media_reset',
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: moderator.userId,
        resourceType: 'live.session',
        resourceId: sessionId,
        metadata: {
          communityId,
          fromEpoch: 0,
          toEpoch: 1,
          permit: { act: 'community.live.moderate', basis: 'grant' },
        },
      });
    });

    it('lets the host reset too', async () => {
      const result = await h.reset.execute({ principal: owner, sessionId, meta: META });
      expect(result.ok && result.value).toEqual({ reset: true });
      expect((await h.session(sessionId)).mediaRoomEpoch).toBe(1);
    });

    it('refuses a student (403 ceiling), a teacher who does not moderate (403), and an outsider (404), moving no epoch', async () => {
      expect(codeOf(await h.reset.execute({ principal: member, sessionId, meta: META }))).toBe(
        'identity.permission_denied',
      );
      expect(
        codeOf(await h.reset.execute({ principal: teacherMember, sessionId, meta: META })),
      ).toBe('live.not_a_moderator');
      expect(codeOf(await h.reset.execute({ principal: outsider, sessionId, meta: META }))).toBe(
        'live.session_not_found',
      );
      expect((await h.session(sessionId)).mediaRoomEpoch).toBe(0);
    });

    it('answers reset:false — no event, no audit — when a concurrent reset or the end already moved it', async () => {
      jest.spyOn(h.sessions, 'bumpEpoch').mockResolvedValueOnce(null);
      const result = await h.reset.execute({ principal: moderator, sessionId, meta: META });
      expect(result.ok && result.value).toEqual({ reset: false });
      expect(h.journal.eventNames()).not.toContain(LiveEvents.mediaReset);
      expect(h.audits()).not.toContain('live.session.media_reset');
    });

    it('is its own generation each time: two resets move 0 → 1 → 2, each announced once', async () => {
      expect((await h.reset.execute({ principal: moderator, sessionId, meta: META })).ok).toBe(
        true,
      );
      expect((await h.reset.execute({ principal: moderator, sessionId, meta: META })).ok).toBe(
        true,
      );
      expect((await h.session(sessionId)).mediaRoomEpoch).toBe(2);
      const resets = h.journal.events.filter((event) => event.name === LiveEvents.mediaReset);
      expect(resets.map((event) => (event.payload as { toEpoch: number }).toEpoch)).toEqual([1, 2]);
    });

    it('refuses once the session has ended', async () => {
      expect((await h.end.execute({ principal: owner, sessionId, meta: META })).ok).toBe(true);
      expect(codeOf(await h.reset.execute({ principal: moderator, sessionId, meta: META }))).toBe(
        'live.session_not_live',
      );
    });
  });

  /**
   * The reconciler's automatic reset (ADR 0019) and the moderator command
   * (Q64) share one `LiveMediaReset`. Its contract: the epoch bump with its
   * `reset_media` audit always; a fact published only when the caller supplies
   * one — so the reconciler's reset stays event-free, exactly as before.
   */
  describe('the shared media reset preserves the reconciler’s contract (ADR 0026)', () => {
    const resetAction = (actor: string | null, victim: string | null): ModerationAction => ({
      id: h.ids.next<'ModerationAction'>(),
      sessionId,
      actorUserId: actor,
      targetUserId: victim,
      type: 'reset_media',
      at: h.clock.now(),
    });

    it('writes the reset_media audit but publishes no event when none is supplied', async () => {
      const session = await h.session(sessionId);
      const moved = await h.mediaReset.reset({
        session,
        action: resetAction(null, 'student-1'),
        hooks: { runProvider: (call) => call(), onSkipped: () => undefined },
      });
      expect(moved?.mediaRoomEpoch).toBe(1);
      expect(h.audits()).toContain('live.session.media_reset');
      expect(h.journal.eventNames()).not.toContain(LiveEvents.mediaReset);
    });

    it('publishes the supplied fact when events are given', async () => {
      const session = await h.session(sessionId);
      const moved = await h.mediaReset.reset({
        session,
        action: resetAction('teacher-2', null),
        eventsFor: (from, to) => [
          mediaResetFact(from, from.mediaRoomEpoch, to.mediaRoomEpoch, 'teacher-2', h.clock.now()),
        ],
        hooks: { runProvider: (call) => call(), onSkipped: () => undefined },
      });
      expect(moved?.mediaRoomEpoch).toBe(1);
      expect(h.journal.eventNames()).toContain(LiveEvents.mediaReset);
    });

    it('returns null, touching nothing, when the compare-and-set loses', async () => {
      const session = await h.session(sessionId);
      jest.spyOn(h.sessions, 'bumpEpoch').mockResolvedValueOnce(null);
      const moved = await h.mediaReset.reset({
        session,
        action: resetAction(null, null),
        hooks: { runProvider: (call) => call(), onSkipped: () => undefined },
      });
      expect(moved).toBeNull();
      expect(h.audits()).not.toContain('live.session.media_reset');
      expect(h.journal.eventNames()).not.toContain(LiveEvents.mediaReset);
    });
  });
});
