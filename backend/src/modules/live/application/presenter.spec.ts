import type { Principal } from '../../../shared';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../identity/domain/provisional-policy';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { MAX_CONCURRENT_PRESENTERS } from '../domain/live-limits';
import { capabilitiesFor } from '../domain/standing';
import type { LiveSessionView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
  presenterDelegated: false,
});

/**
 * Screen sharing (live.md §6; Q56, ADR 0028): up to MAX_CONCURRENT_PRESENTERS
 * presenters at a time, the cap counted under the session's lock. A by-right
 * presenter (owner/moderator/teacher holding `live.speak`) claims for themself;
 * a moderator grants a student a delegated slot, and the student presents by
 * that grant alone — never `live.speak`, never a community capability.
 */
describe('screen sharing', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let moderator: Principal;
  let session: LiveSessionView;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    moderator = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    session = await h.startSession(owner, communityId);
    h.rtc.connect(h.room(session.id), 'teacher-1', LISTENER);
    h.rtc.connect(h.room(session.id), 'teacher-2', LISTENER);
    h.rtc.connect(h.room(session.id), 'student-1', LISTENER);
    h.journal.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  const claim = (principal: Principal, sessionId = session.id) =>
    h.presenter.claim({ principal, sessionId, meta: META });
  const stop = (principal: Principal, sessionId = session.id) =>
    h.presenter.stop({ principal, sessionId, meta: META });
  const grant = (principal: Principal, targetUserId: string, sessionId = session.id) =>
    h.presenter.grant({ principal, sessionId, targetUserId, meta: META });
  const revoke = (principal: Principal, targetUserId: string, sessionId = session.id) =>
    h.presenter.revoke({ principal, sessionId, targetUserId, meta: META });
  const sharers = async () => (await h.presenters.activeGrants(session.id)).map((g) => g.userId);

  describe('claiming by right', () => {
    it('opens a slot for a moderator holding live.speak: the screen pushed, audited, announced, 201', async () => {
      const claimed = await claim(moderator);
      if (!claimed.ok) throw new Error(claimed.error.code);
      expect(claimed.value.opened).toBe(true);
      expect(claimed.value.session).toMatchObject({
        presenterUserIds: ['teacher-2'],
        stateVersion: 2,
        me: { presenting: true, canPresent: true },
      });
      expect(h.rtc.capabilityChanges).toEqual([
        {
          roomName: h.room(session.id),
          identity: 'teacher-2',
          capabilities: { ...LISTENER, canPublishAudio: true, canPublishScreen: true },
        },
      ]);
      expect(h.journal.order).toEqual([
        'audit:live.screen_share.started',
        'event:live.screen_share.started',
      ]);
      const [open] = h.store.presenterGrantsOf(session.id);
      expect(open).toMatchObject({ userId: 'teacher-2', grantedBy: 'teacher-2' });
      expect(h.journal.entries[0]).toMatchObject({
        actorUserId: 'teacher-2',
        metadata: {
          communityId,
          targetUserId: 'teacher-2',
          media: 'applied',
          permit: { act: 'community.live.moderate', basis: 'grant' },
        },
      });
      expect(h.journal.events[0]?.payload).toEqual({
        sessionId: session.id,
        communityId,
        userId: 'teacher-2',
        grantedBy: 'teacher-2',
        stateVersion: 2,
      });
    });

    it('answers a claim by the holder with 200 and nothing more', async () => {
      await claim(moderator);
      h.journal.clear();
      const again = await claim(moderator);
      expect(again.ok && again.value.opened).toBe(false);
      expect(h.journal.order).toEqual([]);
      expect(await sharers()).toEqual(['teacher-2']);
    });

    it('refuses a moderator without live.speak with 403 live.presenter_not_permitted', async () => {
      const withoutSpeak = PROVISIONAL_ROLE_PERMISSIONS.TEACHER.filter(
        (permission) => permission !== 'live.speak',
      );
      const silent: Principal = { ...moderator, permissions: new Set<string>(withoutSpeak) };
      expect(codeOf(await claim(silent))).toBe('live.presenter_not_permitted');
      expect(await sharers()).toEqual([]);
    });

    it('refuses a member who does not moderate (403), an outsider as an unknown session (404), and after the end (412)', async () => {
      const member = await h.member(communityId, owner, 'teacher-3', ['TEACHER']);
      expect(codeOf(await claim(member))).toBe('live.not_a_moderator');
      const outsider = h.person('teacher-9', ['TEACHER']);
      expect(await claim(outsider)).toEqual(
        await claim(outsider, '00000000-0000-4000-8000-00000000ffff'),
      );
      expect(codeOf(await claim(outsider))).toBe('live.session_not_found');
      // A student is below the identity ceiling for live.moderate.
      expect(codeOf(await claim(student))).toBe('identity.permission_denied');

      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(codeOf(await claim(owner))).toBe('live.session_not_live');
    });
  });

  describe('two concurrent slots (Q56)', () => {
    let third: Principal;

    beforeEach(async () => {
      expect(MAX_CONCURRENT_PRESENTERS).toBe(2);
      third = await h.delegate(communityId, owner, 'teacher-4', 'community.live.moderate');
      h.rtc.connect(h.room(session.id), 'teacher-4', LISTENER);
    });

    it('lets a first and a second presenter in, and refuses a third with 409 live.presenter_slots_full', async () => {
      expect((await claim(moderator)).ok).toBe(true); // first
      expect((await claim(owner)).ok).toBe(true); // second
      expect(await sharers()).toEqual(['teacher-2', 'teacher-1']);
      expect(codeOf(await claim(third))).toBe('live.presenter_slots_full'); // third
      expect(await sharers()).toEqual(['teacher-2', 'teacher-1']);
    });

    it('with one slot left, two concurrent claims let exactly one in', async () => {
      await claim(moderator); // one slot taken, one left
      const [a, b] = await Promise.all([claim(owner), claim(third)]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(codeOf(loser)).toBe('live.presenter_slots_full');
      expect((await sharers()).length).toBe(2);
    });

    it('with both slots full, two concurrent claims are both refused', async () => {
      await claim(moderator);
      await claim(owner); // full
      const fourth = await h.delegate(communityId, owner, 'teacher-5', 'community.live.moderate');
      const [a, b] = await Promise.all([claim(third), claim(fourth)]);
      expect(codeOf(a)).toBe('live.presenter_slots_full');
      expect(codeOf(b)).toBe('live.presenter_slots_full');
      expect((await sharers()).length).toBe(2);
    });

    it('does not consume a second slot for an idempotent repeat by a holder', async () => {
      await claim(moderator);
      await claim(moderator); // held, not a second slot
      expect(await sharers()).toEqual(['teacher-2']);
      // A real second presenter still fits.
      expect((await claim(owner)).ok).toBe(true);
      expect((await sharers()).length).toBe(2);
    });

    it('frees a slot on revoke, which a new presenter then claims', async () => {
      await claim(moderator);
      await claim(owner); // full
      expect(codeOf(await claim(third))).toBe('live.presenter_slots_full');

      expect((await revoke(owner, 'teacher-2')).ok).toBe(true); // one slot freed
      expect((await claim(third)).ok).toBe(true); // the freed slot
      expect((await sharers()).sort()).toEqual(['teacher-1', 'teacher-4']);
    });
  });

  describe('delegated student grant (Q56)', () => {
    it('lets a moderator grant a student, who then presents by the grant alone — screen on, no microphone, no live.speak', async () => {
      const granted = await grant(moderator, 'student-1');
      if (!granted.ok) throw new Error(granted.error.code);
      expect(granted.value.opened).toBe(true);
      expect(await sharers()).toEqual(['student-1']);

      // The grant records the moderator as grantedBy and the student as userId.
      const [open] = h.store.presenterGrantsOf(session.id);
      expect(open).toMatchObject({ userId: 'student-1', grantedBy: 'teacher-2' });

      // The pushed set gives the screen and nothing else — never the microphone.
      expect(h.rtc.capabilityChanges.at(-1)).toEqual({
        roomName: h.room(session.id),
        identity: 'student-1',
        capabilities: { ...LISTENER, canPublishScreen: true },
      });
      // The audit names the teacher as actor and the student as target.
      expect(h.journal.order).toEqual([
        'audit:live.screen_share.started',
        'event:live.screen_share.started',
      ]);
      expect(h.journal.entries[0]).toMatchObject({
        actorUserId: 'teacher-2',
        metadata: { targetUserId: 'student-1' },
      });
      expect(h.journal.events[0]?.payload).toMatchObject({
        userId: 'student-1',
        grantedBy: 'teacher-2',
      });

      // The student's join token now carries the screen, never the microphone or live.speak.
      const ticket = await h.join.execute({
        principal: student,
        sessionId: session.id,
        meta: META,
      });
      expect(ticket.ok && ticket.value.media).toEqual({
        microphone: false,
        screen: true,
        screenAudio: false,
      });
      expect(student.permissions.has('live.speak')).toBe(false);
      // The student's own view shows them presenting, but never able to self-claim.
      const view = await h.get.execute({ principal: student, sessionId: session.id });
      expect(view.ok && view.value.me).toMatchObject({ presenting: true, canPresent: false });
    });

    it('does not let a student self-claim, nor present without a grant', async () => {
      expect(codeOf(await claim(student))).toBe('identity.permission_denied');
      const view = await h.get.execute({ principal: student, sessionId: session.id });
      expect(view.ok && view.value.me).toMatchObject({ canPresent: false, presenting: false });
      const ticket = await h.join.execute({
        principal: student,
        sessionId: session.id,
        meta: META,
      });
      expect(ticket.ok && ticket.value.media.screen).toBe(false);
      expect(await sharers()).toEqual([]);
    });

    it('lets the granted student stop their own share, relinquishing the slot (existing policy)', async () => {
      await grant(moderator, 'student-1');
      h.journal.clear();
      const stopped = await stop(student);
      expect(stopped.ok && stopped.value).toMatchObject({ presenterUserIds: [] });
      expect(h.rtc.capabilityChanges.at(-1)?.capabilities.canPublishScreen).toBe(false);
      expect(h.journal.order).toEqual(['event:live.screen_share.stopped']);
      expect(await sharers()).toEqual([]);
    });

    it('lets a moderator revoke a student’s grant: the screen pushed off at once, audited, announced', async () => {
      await grant(moderator, 'student-1');
      h.journal.clear();
      const revoked = await revoke(owner, 'student-1');
      expect(revoked.ok && revoked.value.presenterUserIds).toEqual([]);
      expect(h.rtc.capabilityChanges.at(-1)).toMatchObject({
        identity: 'student-1',
        capabilities: { canPublishScreen: false },
      });
      expect(h.journal.order).toEqual([
        'audit:live.screen_share.revoked',
        'event:live.screen_share.stopped',
      ]);
      expect(h.journal.events[0]?.payload).toMatchObject({
        userId: 'student-1',
        stoppedBy: 'teacher-1',
        reason: 'revoked',
      });
    });

    it('does not let a student present again after revocation — and never self-grant back', async () => {
      await grant(moderator, 'student-1');
      await revoke(moderator, 'student-1');
      expect(await sharers()).toEqual([]);
      // No self-grant, no self-claim: the student cannot restore their own authority.
      expect(codeOf(await grant(student, 'student-1'))).toBe('identity.permission_denied');
      expect(codeOf(await claim(student))).toBe('identity.permission_denied');
      const ticket = await h.join.execute({
        principal: student,
        sessionId: session.id,
        meta: META,
      });
      expect(ticket.ok && ticket.value.media.screen).toBe(false);
    });

    it('counts a delegated grant against the two-slot cap', async () => {
      await claim(moderator); // slot 1 (by right)
      await grant(owner, 'student-1'); // slot 2 (delegated)
      expect((await sharers()).sort()).toEqual(['student-1', 'teacher-2']);
      // A third presenter — by right or delegated — does not fit.
      const third = await h.delegate(communityId, owner, 'teacher-4', 'community.live.moderate');
      h.rtc.connect(h.room(session.id), 'teacher-4', LISTENER);
      expect(codeOf(await claim(third))).toBe('live.presenter_slots_full');
      const other = await h.member(communityId, owner, 'student-2', ['STUDENT']);
      expect(codeOf(await grant(owner, other.userId))).toBe('live.presenter_slots_full');
    });
  });

  describe('granting: authorization and target validation (Q56)', () => {
    it('refuses a non-moderator grantor exactly as the model already refuses moderation', async () => {
      // A student is below the identity ceiling.
      expect(codeOf(await grant(student, 'student-1'))).toBe('identity.permission_denied');
      // A teacher member who does not moderate: 403.
      const member = await h.member(communityId, owner, 'teacher-3', ['TEACHER']);
      expect(codeOf(await grant(member, 'student-1'))).toBe('live.not_a_moderator');
      // An outsider: one 404, whether the session exists or not.
      const outsider = h.person('teacher-9', ['TEACHER']);
      expect(codeOf(await grant(outsider, 'student-1'))).toBe('live.session_not_found');
      expect(await sharers()).toEqual([]);
    });

    it('validates the target server-side: a non-participant is one 404, the grantedBy is never the client’s to choose', async () => {
      // A well-formed id that names nobody in the community.
      expect(codeOf(await grant(moderator, '00000000-0000-4000-8000-0000000000aa'))).toBe(
        'live.target_not_in_session',
      );
      // A malformed target, before any store call.
      expect(codeOf(await grant(moderator, 'bad id'))).toBe('live.target_not_in_session');
      // The server sets grantedBy to the acting moderator — never anything a client could send.
      await grant(moderator, 'student-1');
      expect(h.store.presenterGrantsOf(session.id)[0]?.grantedBy).toBe('teacher-2');
    });
  });

  describe('stop and revoke', () => {
    it('lets a by-right presenter stop with no permit: the screen off, announced, not audited', async () => {
      await claim(moderator);
      h.journal.clear();
      const stopped = await stop(moderator);
      expect(stopped.ok && stopped.value).toMatchObject({
        presenterUserIds: [],
        me: { presenting: false },
      });
      expect(h.rtc.capabilityChanges.at(-1)?.capabilities).toEqual({
        ...LISTENER,
        canPublishAudio: true,
      });
      expect(h.journal.order).toEqual(['event:live.screen_share.stopped']);
      expect(h.store.presenterGrantsOf(session.id)[0]).toMatchObject({ endReason: 'stopped' });
    });

    it('lets a presenter removed from the community still stop their own share', async () => {
      await claim(moderator);
      await h.remove(communityId, owner, 'teacher-2');
      const stopped = await stop(moderator);
      expect(stopped.ok && stopped.value).toMatchObject({
        presenterUserIds: [],
        me: { canJoin: false, canModerate: false, presenting: false },
      });
    });

    it('never lets a delegate revoke the host’s own share (Q54); a revoke with nothing open answers 200', async () => {
      await claim(owner);
      h.journal.clear();
      expect(codeOf(await revoke(moderator, 'teacher-1'))).toBe('live.target_is_host');
      expect(await sharers()).toEqual(['teacher-1']);
      expect(h.journal.order).toEqual([]);

      // Nothing open for a target → 200 no-op, nothing recorded.
      expect((await revoke(owner, 'student-1')).ok).toBe(true);
      expect(h.journal.order).toEqual([]);
    });

    it('refuses a revoke by anyone who does not moderate', async () => {
      await claim(moderator);
      const member = await h.member(communityId, owner, 'teacher-3', ['TEACHER']);
      expect(codeOf(await revoke(member, 'teacher-2'))).toBe('live.not_a_moderator');
      expect(codeOf(await revoke(student, 'teacher-2'))).toBe('identity.permission_denied');
      const outsider = h.person('teacher-9', ['TEACHER']);
      expect(codeOf(await revoke(outsider, 'teacher-2'))).toBe('live.session_not_found');
      expect(await sharers()).toEqual(['teacher-2']);
    });
  });

  describe('Q64 interaction — grant survives reset and kick (Q56)', () => {
    it('a room reset keeps a student’s grant: after re-join the screen capability is restored', async () => {
      await grant(moderator, 'student-1');
      expect(await sharers()).toEqual(['student-1']);

      // The reset moves the media room; grants are not touched (Q64/ADR 0026).
      const reset = await h.reset.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(reset.ok && reset.value.reset).toBe(true);
      expect(await sharers()).toEqual(['student-1']);

      // Re-joining the new room, the student's token still carries the screen —
      // no new approval needed.
      const ticket = await h.join.execute({
        principal: student,
        sessionId: session.id,
        meta: META,
      });
      expect(ticket.ok && ticket.value.media.screen).toBe(true);
    });

    it('a kick does not revoke a student’s grant: re-entry restores the screen', async () => {
      await grant(moderator, 'student-1');
      const kicked = await h.kick.execute({
        principal: moderator,
        sessionId: session.id,
        targetUserId: 'student-1',
        meta: META,
      });
      expect(kicked.ok).toBe(true);
      // The grant remains; the student may re-join and present again.
      expect(await sharers()).toEqual(['student-1']);
      const ticket = await h.join.execute({
        principal: student,
        sessionId: session.id,
        meta: META,
      });
      expect(ticket.ok && ticket.value.media.screen).toBe(true);
    });

    it('session end closes every open grant', async () => {
      await claim(moderator);
      await grant(owner, 'student-1');
      expect((await sharers()).length).toBe(2);
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(await h.presenters.activeGrants(session.id)).toEqual([]);
    });
  });
});
