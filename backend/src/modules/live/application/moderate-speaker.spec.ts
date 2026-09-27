import { Logger } from '@nestjs/common';

import type { Principal } from '../../../shared';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { MAX_CONCURRENT_SPEAKERS } from '../domain/live-limits';
import { capabilitiesFor } from '../domain/standing';
import type { LiveSessionView, SpeakerRequestView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});
const MICROPHONE = { ...LISTENER, canPublishAudio: true };

/**
 * A staff member who may also raise a hand — no provisional role holds both
 * `live.moderate` and `live.raise_hand` but OWNER and ADMIN, so the
 * combination is made explicitly.
 */
function withRaiseHand(principal: Principal): Principal {
  return { ...principal, permissions: new Set([...principal.permissions, 'live.raise_hand']) };
}

/**
 * Giving, refusing and taking back the floor (live.md §5, S3): moderators
 * only — Communities' answer on the session's own community — never on the
 * host, never past the cap, never to someone who may no longer take part;
 * one audit action per act, carrying the permit it ran on; and the media
 * plane's answer reported, never assumed.
 */
describe('moderating the floor', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;
  let hand: SpeakerRequestView;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    session = await h.startSession(owner, communityId);
    hand = await h.raised(student, session.id);
    h.journal.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  const grant = (principal: Principal, requestId = hand.id) =>
    h.moderate.grant({ principal, requestId, meta: META });
  const decline = (principal: Principal, requestId = hand.id) =>
    h.moderate.decline({ principal, requestId, meta: META });
  const revoke = (principal: Principal, requestId = hand.id) =>
    h.moderate.revoke({ principal, requestId, meta: META });
  const connect = (userId: string) => h.rtc.connect(h.room(session.id), userId, LISTENER);

  describe('granting', () => {
    it('pushes the FULL set on the wire, then audits the act with its permit and announces it', async () => {
      connect('student-1');
      const granted = await grant(owner);
      expect(granted).toEqual({
        ok: true,
        value: {
          request: expect.objectContaining({ id: hand.id, state: 'granted' }) as unknown,
          media: 'applied',
        },
      });
      expect(h.rtc.capabilityChanges).toEqual([
        { roomName: h.room(session.id), identity: 'student-1', capabilities: MICROPHONE },
      ]);
      expect(h.journal.order).toEqual(['audit:live.speaker.granted', 'event:live.speaker.granted']);
      expect(h.journal.entries[0]).toEqual({
        actorUserId: owner.userId,
        action: 'live.speaker.granted',
        resourceType: 'live.session',
        resourceId: session.id,
        at: h.clock.now(),
        metadata: {
          communityId,
          targetUserId: 'student-1',
          requestId: hand.id,
          media: 'applied',
          permit: {
            act: 'community.live.moderate',
            basis: 'owner',
            membershipId: expect.any(String) as string,
            grantId: null,
          },
        },
        correlationId: META.correlationId,
      });
      expect(h.journal.events[0]?.payload).toEqual({
        sessionId: session.id,
        communityId,
        requestId: hand.id,
        userId: 'student-1',
        stateVersion: 3,
        grantedBy: owner.userId,
      });
      expect(h.store.moderationOf(session.id).map((action) => action.type)).toEqual([
        'start_session',
        'grant_speaker',
      ]);
    });

    it('is idempotent: granting a granted hand answers 200 unchanged and records nothing more', async () => {
      await grant(owner);
      const calls = h.rtc.calls.length;
      expect(await grant(owner)).toMatchObject({
        ok: true,
        value: { request: { state: 'granted' }, media: 'unchanged' },
      });
      expect(h.rtc.calls).toHaveLength(calls);
      expect(h.audits()).toEqual(['live.speaker.granted']);
      expect(h.eventNames()).toEqual(['live.speaker.granted']);
    });

    it(`never lets more than ${MAX_CONCURRENT_SPEAKERS} hold the floor, even when granted all at once`, async () => {
      const hands = [hand];
      for (let i = 2; i <= 7; i += 1) {
        const member = await h.member(communityId, owner, `student-${i + 10}`);
        hands.push(await h.raised(member, session.id));
      }
      const results = await Promise.all(hands.map((raised) => grant(owner, raised.id)));
      expect(results.filter((result) => result.ok)).toHaveLength(MAX_CONCURRENT_SPEAKERS);
      expect(results.filter((result) => codeOf(result) === 'live.speaker_slots_full')).toHaveLength(
        hands.length - MAX_CONCURRENT_SPEAKERS,
      );
      expect(await h.requests.granted(session.id)).toHaveLength(MAX_CONCURRENT_SPEAKERS);
      expect(h.audits()).toHaveLength(MAX_CONCURRENT_SPEAKERS);
    });

    it('refuses a requester who was removed from the community, and changes nothing (D5)', async () => {
      await h.remove(communityId, owner, 'student-1');
      expect(codeOf(await grant(owner))).toBe('live.target_not_eligible');
      expect((await h.requests.findById(hand.id))?.state).toBe('pending');
      expect(h.journal.order).toEqual([]);
      expect(h.rtc.capabilityChanges).toEqual([]);
    });

    it('refuses a requester whose account was suspended', async () => {
      h.suspend('student-1');
      expect(codeOf(await grant(owner))).toBe('live.target_not_eligible');
      expect((await h.requests.findById(hand.id))?.state).toBe('pending');
    });

    it('grants a requester who moderates the session, whatever their membership basis', async () => {
      const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
      h.accounts.setPermissions('teacher-2', ['live.moderate', 'communities.moderate']);
      const raised = await h.raised(withRaiseHand(delegate), session.id);
      // Identity no longer lets them take part as a member: only moderating keeps them eligible.
      expect(
        await h.authorization.permittedAmong(communityId, ['teacher-2'], 'community.live.remain'),
      ).toEqual([]);
      expect((await grant(owner, raised.id)).ok).toBe(true);
    });

    it('reports the media plane honestly: applied, not connected, or pending when unreachable', async () => {
      const others = [];
      for (const userId of ['student-21', 'student-22']) {
        const member = await h.member(communityId, owner, userId);
        others.push(await h.raised(member, session.id));
      }
      h.journal.clear();
      connect('student-1');
      expect(await grant(owner)).toMatchObject({ ok: true, value: { media: 'applied' } });
      expect(await grant(owner, others[0]?.id)).toMatchObject({
        ok: true,
        value: { media: 'not_connected' },
      });
      h.rtc.setUnavailable(true);
      expect(await grant(owner, others[1]?.id)).toMatchObject({
        ok: true,
        value: { request: { state: 'granted' }, media: 'pending' },
      });
      // Every decision is audited and announced, whatever the media plane said.
      expect(h.journal.entries.map((entry) => entry.metadata?.media)).toEqual([
        'applied',
        'not_connected',
        'pending',
      ]);
      expect(h.eventNames()).toEqual(Array(3).fill('live.speaker.granted'));
      // The two that did not apply are left to the watch.
      expect(h.media.unsettled().map((push) => push.userId)).toEqual(['student-21', 'student-22']);
    });

    it('still audits and announces a grant the provider refused — the fault logged by class only', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      connect('student-1');
      h.rtc.failNext('updateCapabilities', 'fault');
      expect(await grant(owner)).toMatchObject({
        ok: true,
        value: { request: { state: 'granted' }, media: 'pending' },
      });
      expect(h.audits()).toEqual(['live.speaker.granted']);
      expect(h.eventNames()).toEqual(['live.speaker.granted']);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logged.mock.calls)).not.toContain('refused');
    });

    it('refuses a hand that is no longer pending, and an unknown request', async () => {
      await h.lower.execute({ principal: student, sessionId: session.id, meta: META });
      expect(codeOf(await grant(owner))).toBe('live.invalid_transition');
      expect(codeOf(await grant(owner, '00000000-0000-4000-8000-00000000ffff'))).toBe(
        'live.request_not_found',
      );
    });
  });

  describe('declining and revoking', () => {
    it('passes over a pending hand without touching the media plane, audited under its own name', async () => {
      const calls = h.rtc.calls.length;
      const declined = await decline(owner);
      expect(declined.ok && declined.value.request.state).toBe('declined');
      expect(h.rtc.calls).toHaveLength(calls);
      expect(h.journal.order).toEqual([
        'audit:live.speaker.declined',
        'event:live.speaker.declined',
      ]);
      expect(h.journal.entries[0]?.metadata).toMatchObject({
        requestId: hand.id,
        permit: { basis: 'owner' },
      });
      expect(h.journal.events[0]?.payload).toMatchObject({ declinedBy: owner.userId });
    });

    it('is idempotent, and refuses to decline a hand that holds the floor', async () => {
      await decline(owner);
      expect((await decline(owner)).ok).toBe(true);
      expect(h.audits()).toEqual(['live.speaker.declined']);

      const member = await h.member(communityId, owner, 'student-31');
      const other = await h.raised(member, session.id);
      await grant(owner, other.id);
      expect(codeOf(await decline(owner, other.id))).toBe('live.invalid_transition');
    });

    it('demotes to listener with the full set, removing nobody', async () => {
      connect('student-1');
      await grant(owner);
      const revoked = await revoke(owner);
      expect(revoked).toMatchObject({
        ok: true,
        value: { request: { state: 'revoked' }, media: 'applied' },
      });
      expect(h.rtc.capabilityChanges.at(-1)).toEqual({
        roomName: h.room(session.id),
        identity: 'student-1',
        capabilities: LISTENER,
      });
      expect(h.rtc.removed).toEqual([]);
      expect(h.audits()).toEqual(['live.speaker.granted', 'live.speaker.revoked']);
      expect(h.journal.events.at(-1)?.payload).toMatchObject({ revokedBy: owner.userId });
    });

    it('is idempotent, and refuses to revoke a hand that is only pending', async () => {
      await grant(owner);
      await revoke(owner);
      expect(await revoke(owner)).toMatchObject({ ok: true, value: { media: 'unchanged' } });
      expect(h.audits()).toEqual(['live.speaker.granted', 'live.speaker.revoked']);

      const member = await h.member(communityId, owner, 'student-31');
      const other = await h.raised(member, session.id);
      expect(codeOf(await revoke(owner, other.id))).toBe('live.invalid_transition');
    });

    it('frees a slot, so the next hand can be granted', async () => {
      const hands = [hand];
      for (let i = 2; i <= MAX_CONCURRENT_SPEAKERS + 1; i += 1) {
        const member = await h.member(communityId, owner, `student-${i + 40}`);
        hands.push(await h.raised(member, session.id));
      }
      for (const raised of hands.slice(0, MAX_CONCURRENT_SPEAKERS)) await grant(owner, raised.id);
      const last = hands[MAX_CONCURRENT_SPEAKERS]?.id;
      expect(codeOf(await grant(owner, last))).toBe('live.speaker_slots_full');
      await revoke(owner);
      expect((await grant(owner, last)).ok).toBe(true);
    });

    it('keeps the host on the microphone hosting gives them when their own hand is revoked', async () => {
      const hostHand = await h.raised(withRaiseHand(owner), session.id);
      connect('teacher-1');
      await grant(owner, hostHand.id);
      const revoked = await revoke(owner, hostHand.id);
      expect(revoked.ok && revoked.value.media).toBe('applied');
      // The set is recomputed from standing, not assumed from the act.
      expect(h.rtc.capabilityChanges.map((change) => change.capabilities)).toEqual([
        MICROPHONE,
        MICROPHONE,
      ]);
    });
  });

  describe('who moderates', () => {
    it('refuses a caller without live.moderate before looking anything up', async () => {
      const lookup = jest.spyOn(h.requests, 'findById');
      expect(codeOf(await grant(student))).toBe('identity.permission_denied');
      expect(lookup).not.toHaveBeenCalled();
    });

    it('lets a delegate holding community.live.moderate moderate, on the grant basis', async () => {
      const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
      expect((await grant(delegate)).ok).toBe(true);
      expect(h.journal.entries[0]?.metadata).toMatchObject({
        permit: {
          act: 'community.live.moderate',
          basis: 'grant',
          grantId: expect.any(String) as string,
        },
      });
    });

    it('lets the host moderate their own session through community.live.host', async () => {
      const starter = await h.delegate(communityId, owner, 'teacher-2', 'community.live.start');
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      const hosted = await h.startSession(starter, communityId);
      const raised = await h.raised(student, hosted.id);
      const granted = await grant(starter, raised.id);
      expect(granted.ok).toBe(true);
      expect(h.journal.entries.at(-1)?.metadata).toMatchObject({
        permit: { act: 'community.live.host', basis: 'grant' },
      });
    });

    it('refuses a member who does not moderate with 403 — a join permit is not moderation', async () => {
      const member = await h.member(communityId, owner, 'teacher-2', ['TEACHER']);
      expect(codeOf(await grant(member))).toBe('live.not_a_moderator');
      expect(codeOf(await decline(member))).toBe('live.not_a_moderator');
      expect(codeOf(await revoke(member))).toBe('live.not_a_moderator');
      expect((await h.requests.findById(hand.id))?.state).toBe('pending');
    });

    it('refuses a moderator of another community exactly as an unknown request', async () => {
      const other = await h.community('teacher-5');
      expect(await grant(other.owner)).toEqual(
        await grant(other.owner, '00000000-0000-4000-8000-00000000ffff'),
      );
      expect(codeOf(await grant(other.owner))).toBe('live.request_not_found');
    });

    it('never lets a delegate — the owner included — act on the host’s own hand (Q54)', async () => {
      const starter = await h.delegate(communityId, owner, 'teacher-2', 'community.live.start');
      const moderator = await h.delegate(
        communityId,
        owner,
        'teacher-3',
        'community.live.moderate',
      );
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      const hosted = await h.startSession(starter, communityId);
      const hostHand = await h.raised(withRaiseHand(starter), hosted.id);

      for (const delegate of [moderator, owner]) {
        expect(codeOf(await grant(delegate, hostHand.id))).toBe('live.target_is_host');
        expect(codeOf(await decline(delegate, hostHand.id))).toBe('live.target_is_host');
      }
      // The host acts on their own.
      expect((await grant(starter, hostHand.id)).ok).toBe(true);
      for (const delegate of [moderator, owner]) {
        expect(codeOf(await revoke(delegate, hostHand.id))).toBe('live.target_is_host');
      }
      expect((await h.requests.findById(hostHand.id))?.state).toBe('granted');
    });
  });
});
