import { Logger } from '@nestjs/common';

import type { Principal } from '../../../shared';
import {
  META,
  codeOf,
  liveHarness,
  withUnmappedStatus,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { capabilitiesFor } from '../domain/standing';
import type { LiveSessionView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});

describe('the raise-hand queue', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;
  /** The provider calls Start made; nothing after them should call the provider unless it must. */
  let startCalls: number;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    session = await h.startSession(owner, communityId);
    startCalls = h.rtc.calls.length;
    h.journal.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  const raise = (principal: Principal, sessionId = session.id) =>
    h.raise.execute({ principal, sessionId, meta: META });
  const lower = (principal: Principal, sessionId = session.id) =>
    h.lower.execute({ principal, sessionId, meta: META });

  describe('raising a hand', () => {
    it('creates one pending request, announced with the session’s new version — no media, no audit', async () => {
      const raised = await raise(student);
      if (!raised.ok) throw new Error(raised.error.code);
      expect(raised.value.created).toBe(true);
      expect(raised.value.request).toMatchObject({
        sessionId: session.id,
        userId: 'student-1',
        state: 'pending',
        grantedAt: null,
        decidedAt: null,
      });
      expect(h.journal.order).toEqual(['event:live.speaker.requested']);
      expect(h.journal.events[0]).toMatchObject({
        aggregateId: session.id,
        payload: {
          sessionId: session.id,
          communityId,
          requestId: raised.value.request.id,
          userId: 'student-1',
          stateVersion: 2,
        },
        correlationId: META.correlationId,
      });
      expect((await h.session(session.id)).stateVersion).toBe(2);
      // A raised hand is application state, not media state.
      expect(h.rtc.calls).toHaveLength(startCalls);
    });

    it('is idempotent: the hand already up is answered with 200, and announced only once', async () => {
      const first = await raise(student);
      const again = await raise(student);
      expect(again).toEqual({
        ok: true,
        value: { created: false, request: first.ok && first.value.request },
      });
      expect(h.eventNames()).toEqual(['live.speaker.requested']);
      expect((await h.session(session.id)).stateVersion).toBe(2);
    });

    it('makes one request out of simultaneous raises by one person', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => raise(student)));
      const values = results.map((result) => (result.ok ? result.value : null));
      expect(values.filter((value) => value?.created)).toHaveLength(1);
      expect(new Set(values.map((value) => value?.request.id)).size).toBe(1);
      expect(h.eventNames()).toEqual(['live.speaker.requested']);
    });

    it('answers a speaker who raises again with their granted hand — the floor is not reset', async () => {
      const hand = await h.raised(student, session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      expect(await raise(student)).toMatchObject({
        ok: true,
        value: { created: false, request: { id: hand.id, state: 'granted' } },
      });
    });

    it('lets members of a LOCKED community raise (Q46), and closes it under an unknown status', async () => {
      await h.lock(communityId, owner);
      expect((await raise(student)).ok).toBe(true);
      withUnmappedStatus(h);
      const other = h.person('student-2', ['STUDENT']);
      expect(codeOf(await raise(other))).toBe('live.community_not_open');
    });

    it('refuses a non-member exactly as an unknown session, and an ended session with 412', async () => {
      const outsider = h.person('student-9', ['STUDENT']);
      expect(await raise(outsider)).toEqual(
        await raise(outsider, '00000000-0000-4000-8000-00000000ffff'),
      );
      expect(codeOf(await raise(outsider))).toBe('live.session_not_found');
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(codeOf(await raise(student))).toBe('live.session_not_live');
    });

    it('refuses a role without live.raise_hand before anything is read', async () => {
      const lookup = jest.spyOn(h.sessions, 'findById');
      expect(codeOf(await raise(owner))).toBe('identity.permission_denied');
      expect(lookup).not.toHaveBeenCalled();
    });

    it('limits raises to six a minute per (session, person)', async () => {
      for (let i = 0; i < 6; i += 1) expect((await raise(student)).ok).toBe(true);
      expect(await raise(student)).toMatchObject({
        ok: false,
        error: {
          kind: 'rate_limited',
          code: 'live.too_many_hands',
          details: { retryAfterSeconds: expect.any(Number) as number },
        },
      });
      expect((await raise(h.person('student-2', ['STUDENT']))).ok).toBe(true);
      // Nor is the same person in another session.
      const other = await h.community('teacher-2');
      await h.communities.addPeople(other.owner, other.id, 'student-1');
      const elsewhere = await h.startSession(other.owner, other.id);
      expect((await raise(student, elsewhere.id)).ok).toBe(true);
      h.clock.advance(60);
      expect((await raise(student)).ok).toBe(true);
    });
  });

  describe('lowering a hand', () => {
    it('withdraws a pending hand without touching the media plane or the audit trail', async () => {
      const hand = await h.raised(student, session.id);
      h.journal.clear();
      const lowered = await lower(student);
      expect(lowered.ok && lowered.value.request).toMatchObject({
        id: hand.id,
        state: 'withdrawn',
        decidedAt: h.clock.now(),
      });
      expect(h.journal.order).toEqual(['event:live.speaker.withdrawn']);
      expect(h.journal.events[0]?.payload).toMatchObject({ from: 'pending', stateVersion: 3 });
      expect(h.rtc.calls).toHaveLength(startCalls);
    });

    it('lets a speaker yield the floor: the microphone right ends on the wire too', async () => {
      const hand = await h.raised(student, session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      h.rtc.connect(h.room(session.id), 'student-1', { ...LISTENER, canPublishAudio: true }, [
        'microphone',
      ]);
      h.journal.clear();

      const lowered = await lower(student);
      expect(lowered.ok && lowered.value.request?.state).toBe('withdrawn');
      expect(h.rtc.capabilityChanges.at(-1)).toEqual({
        roomName: h.room(session.id),
        identity: 'student-1',
        capabilities: LISTENER,
      });
      expect(h.rtc.observed(h.room(session.id))[0]?.publishing).toEqual([]);
      expect(h.journal.order).toEqual(['event:live.speaker.withdrawn']);
      expect(h.journal.events[0]?.payload).toMatchObject({ from: 'granted' });
    });

    it('keeps a yield when the provider is down: 200, and the push left to the watch', async () => {
      const hand = await h.raised(student, session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      h.rtc.setUnavailable(true);
      expect((await lower(student)).ok).toBe(true);
      expect(h.media.unsettled()).toEqual([
        { sessionId: session.id, userId: 'student-1', since: h.clock.now() },
      ]);
    });

    it('answers {request: null} when nothing is up, and a repeat changes nothing', async () => {
      expect(await lower(student)).toEqual({ ok: true, value: { request: null } });
      await h.raised(student, session.id);
      await lower(student);
      h.journal.clear();
      expect(await lower(student)).toEqual({ ok: true, value: { request: null } });
      expect(h.journal.order).toEqual([]);
    });

    it('only ever lowers the caller’s own hand', async () => {
      await h.raised(student, session.id);
      const other = h.person('student-2', ['STUDENT']);
      expect(await lower(other)).toEqual({ ok: true, value: { request: null } });
      expect((await h.requests.findOpen(session.id, 'student-1'))?.state).toBe('pending');
    });

    it('needs no permit to lower one’s own hand — a member just removed may still put it down', async () => {
      const hand = await h.raised(student, session.id);
      await h.remove(communityId, owner, 'student-1');
      const lowered = await lower(student);
      expect(lowered.ok && lowered.value.request).toMatchObject({
        id: hand.id,
        state: 'withdrawn',
      });
    });

    it('reveals nothing without an open hand: 404 unless the caller may see the session (D9)', async () => {
      const outsider = h.person('student-9', ['STUDENT']);
      expect(await lower(outsider)).toEqual(
        await lower(outsider, '00000000-0000-4000-8000-00000000ffff'),
      );
      expect(codeOf(await lower(outsider))).toBe('live.session_not_found');
      // Seeing is enough: a LOCKED community's member, or one a status closes joins to.
      await h.lock(communityId, owner);
      expect(await lower(student)).toEqual({ ok: true, value: { request: null } });
      withUnmappedStatus(h);
      expect(await lower(student)).toEqual({ ok: true, value: { request: null } });
    });

    it('lets exactly one of a yield and a revoke win when they race', async () => {
      const hand = await h.raised(student, session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      h.journal.clear();
      const [yielded, revoked] = await Promise.all([
        lower(student),
        h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META }),
      ]);
      // The loser finds the other's terminal state: never a second change.
      expect([yielded.ok, revoked.ok].filter(Boolean)).toHaveLength(1);
      expect([codeOf(yielded), codeOf(revoked)]).toContain('live.invalid_transition');
      expect(['withdrawn', 'revoked']).toContain((await h.requests.findById(hand.id))?.state);
      expect(await h.requests.granted(session.id)).toEqual([]);
      expect(h.journal.events).toHaveLength(1);
    });

    describe('when the hand changes between the read and the write', () => {
      /** Runs `meanwhile` right after the lower has read the caller's open hand. */
      function between(meanwhile: () => Promise<unknown>): void {
        const findOpen = h.requests.findOpen.bind(h.requests);
        jest.spyOn(h.requests, 'findOpen').mockImplementationOnce(async (sessionId, userId) => {
          const read = await findOpen(sessionId, userId);
          await meanwhile();
          return read;
        });
      }

      it('yields a grant that committed meanwhile — the lower takes either open state (D4)', async () => {
        const hand = await h.raised(student, session.id);
        h.rtc.connect(h.room(session.id), 'student-1', LISTENER);
        between(() => h.moderate.grant({ principal: owner, requestId: hand.id, meta: META }));
        h.journal.clear();

        const lowered = await lower(student);
        expect(lowered.ok && lowered.value.request?.state).toBe('withdrawn');
        expect(await h.requests.granted(session.id)).toEqual([]);
        expect(h.eventNames()).toEqual(['live.speaker.granted', 'live.speaker.withdrawn']);
        expect(h.journal.events.at(-1)?.payload).toMatchObject({ from: 'granted' });
        // The microphone the grant pushed is taken back at once.
        expect(
          h.rtc.capabilityChanges.map((change) => change.capabilities.canPublishAudio),
        ).toEqual([true, false]);
        expect(h.media.unsettled()).toEqual([]);
      });

      it('answers 200 with the hand when another lower won', async () => {
        const hand = await h.raised(student, session.id);
        between(() => lower(student));
        h.journal.clear();
        expect(await lower(student)).toMatchObject({
          ok: true,
          value: { request: { id: hand.id, state: 'withdrawn' } },
        });
        expect(h.eventNames()).toEqual(['live.speaker.withdrawn']);
      });

      it('answers {request: null} when the session ended meanwhile', async () => {
        await h.raised(student, session.id);
        between(() => h.end.execute({ principal: owner, sessionId: session.id, meta: META }));
        expect(await lower(student)).toEqual({ ok: true, value: { request: null } });
      });

      it('answers 409 when a moderator revoked or declined it meanwhile', async () => {
        const hand = await h.raised(student, session.id);
        await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
        between(() => h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META }));
        expect(codeOf(await lower(student))).toBe('live.invalid_transition');

        const other = h.person('student-2', ['STUDENT']);
        const pending = await h.raised(other, session.id);
        between(() => h.moderate.decline({ principal: owner, requestId: pending.id, meta: META }));
        expect(codeOf(await lower(other))).toBe('live.invalid_transition');
      });
    });
  });

  it('logs nothing on the happy path', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error');
    const hand = await h.raised(student, session.id);
    await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    await lower(student);
    expect(logged).not.toHaveBeenCalled();
  });
});
