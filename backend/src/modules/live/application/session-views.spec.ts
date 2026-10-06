import type { Principal } from '../../../shared';
import {
  META,
  codeOf,
  liveHarness,
  withUnmappedStatus,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { HANDS_PAGE_MAX, PENDING_HANDS_COUNT_CAP } from '../domain/live-limits';
import { capabilitiesFor } from '../domain/standing';
import { decodeHandsCursor, encodeHandsCursor } from './list-hands.use-case';
import type { LiveSessionView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
  presenterDelegated: false,
});

/**
 * What callers see (live.md §15.3; audit §11): a session's view with the
 * caller's own flags, the community's current session, and the moderators'
 * hands page — each visible only to whoever may see the session, and
 * identical to "no such thing" for anyone else.
 */
describe('live session views', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    session = await h.startSession(owner, communityId);
  });

  afterEach(() => jest.restoreAllMocks());

  const get = (principal: Principal, sessionId = session.id) =>
    h.get.execute({ principal, sessionId });
  const current = (principal: Principal, community = communityId) =>
    h.current.execute({ principal, communityId: community });

  describe('a session', () => {
    it('shows a member their own flags, and no moderation', async () => {
      const seen = await get(student);
      expect(seen.ok && seen.value).toEqual({
        id: session.id,
        communityId,
        state: 'live',
        stateVersion: 1,
        hostUserId: 'teacher-1',
        startedAt: h.clock.now(),
        endedAt: null,
        endReason: null,
        participantCap: 300,
        speakerCount: 0,
        presenterUserIds: [],
        me: {
          role: 'listener',
          isHost: false,
          canJoin: true,
          canRaiseHand: true,
          canModerate: false,
          canEnd: false,
          canPresent: false,
          presenting: false,
          hand: null,
        },
        moderation: null,
      });
      const hand = await h.raised(student, session.id);
      const withHand = await get(student);
      expect(withHand.ok && withHand.value.me.hand).toEqual({
        requestId: hand.id,
        state: 'pending',
      });
    });

    it('shows a moderator the queue’s size — counted no further than 100 — and the floor', async () => {
      // One addition of them all: Communities limits how often members are added.
      const members = Array.from({ length: PENDING_HANDS_COUNT_CAP + 1 }, (_, i) =>
        h.person(`student-${i + 101}`, ['STUDENT']),
      );
      await h.communities.addPeople(owner, communityId, ...members.map((m) => m.userId));
      const hands = [];
      for (const member of members) hands.push(await h.raised(member, session.id));
      await h.moderate.grant({ principal: owner, requestId: hands[0]?.id, meta: META });
      const seen = await get(owner);
      expect(seen.ok && seen.value).toMatchObject({
        speakerCount: 1,
        me: {
          role: 'moderator',
          isHost: true,
          canModerate: true,
          canEnd: true,
          canPresent: true,
          canRaiseHand: false,
        },
        moderation: { pendingHands: PENDING_HANDS_COUNT_CAP, violations: 0, lastViolationAt: null },
      });
      // The speaker sees themself as one — and no queue.
      const speaker = h.person('student-101', ['STUDENT']);
      const theirs = await get(speaker);
      expect(theirs.ok && theirs.value).toMatchObject({
        me: { role: 'speaker', hand: { state: 'granted' } },
        moderation: null,
      });
    });

    it('refuses a non-member exactly as an unknown session', async () => {
      const outsider = h.person('teacher-9', ['TEACHER']);
      expect(await get(outsider)).toEqual(
        await get(outsider, '00000000-0000-4000-8000-00000000ffff'),
      );
      expect(codeOf(await get(outsider))).toBe('live.session_not_found');
    });

    it('still shows a member refused only by the lifecycle, with canJoin false', async () => {
      withUnmappedStatus(h);
      const seen = await get(student);
      expect(seen.ok && seen.value.me).toMatchObject({ canJoin: false, canRaiseHand: false });
      // A moderator's moderation is never closed by a status.
      const theirs = await get(owner);
      expect(theirs.ok && theirs.value.me).toMatchObject({ canJoin: true, canModerate: true });
    });

    it('shows an ended session with every command off', async () => {
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      const seen = await get(student);
      expect(seen.ok && seen.value).toMatchObject({
        state: 'ended',
        endReason: 'moderator',
        me: { canJoin: false, canRaiseHand: false, canModerate: false, canEnd: false },
      });
    });
  });

  describe('the community’s current session', () => {
    it('answers the running session to a member, and null once it has ended', async () => {
      const running = await current(student);
      expect(running.ok && running.value.session?.id).toBe(session.id);
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(await current(student)).toEqual({ ok: true, value: { session: null } });
    });

    it('tells a non-member nothing — not even whether a session runs', async () => {
      const outsider = h.person('teacher-9', ['TEACHER']);
      const whileLive = await current(outsider);
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(await current(outsider)).toEqual(whileLive);
      expect(await current(outsider, '00000000-0000-4000-8000-00000000ffff')).toEqual(whileLive);
      expect(codeOf(whileLive)).toBe('live.community_not_found');
    });
  });

  describe('the hands page', () => {
    const page = (
      principal: Principal,
      query: { state?: 'pending' | 'granted'; cursor?: string; limit?: number } = {},
    ) => h.hands.execute({ principal, sessionId: session.id, ...query });

    it('pages the queue first come first served, with names from the directory', async () => {
      const names = ['آمنة', 'خديجة', 'فاطمة'];
      const ids: string[] = [];
      for (const [i, name] of names.entries()) {
        const member = await h.member(communityId, owner, `student-${i + 50}`);
        h.accounts.add(`student-${i + 50}`, ['STUDENT'], name);
        ids.push((await h.raised(member, session.id)).id);
        h.clock.advance(1);
      }
      const first = await page(owner, { limit: 2 });
      if (!first.ok) throw new Error(first.error.code);
      expect(first.value.items.map((item) => [item.id, item.displayName])).toEqual([
        [ids[0], 'آمنة'],
        [ids[1], 'خديجة'],
      ]);
      expect(first.value.items[0]).not.toHaveProperty('media');
      expect(first.value.nextCursor).not.toBeNull();

      const second = await page(owner, { limit: 2, cursor: first.value.nextCursor ?? undefined });
      expect(second.ok && second.value).toEqual({
        items: [expect.objectContaining({ id: ids[2], displayName: 'فاطمة', state: 'pending' })],
        nextCursor: null,
      });
      // A full last page knows it is the last.
      const exact = await page(owner, { limit: 3 });
      expect(exact.ok && exact.value.nextCursor).toBeNull();
    });

    it('bounds the page: the default when none is asked, never more than the maximum', async () => {
      const read = jest.spyOn(h.requests, 'pendingPage');
      await page(owner);
      await page(owner, { limit: 0 });
      await page(owner, { limit: 10_000 });
      expect(read.mock.calls.map((call) => call[2])).toEqual([50, 50, HANDS_PAGE_MAX]);
    });

    it('refuses a cursor it did not issue', async () => {
      for (const cursor of ['garbage', encodeHandsCursor({ requestedAt: new Date(), id: 'x y' })]) {
        expect(codeOf(await page(owner, { cursor }))).toBe('live.cursor_invalid');
      }
      const key = { requestedAt: new Date('2026-09-27T10:00:00.000Z'), id: 'abc-1' };
      expect(decodeHandsCursor(encodeHandsCursor(key))).toEqual({ ok: true, value: key });
    });

    it('lists who holds the floor, with each speaker’s connection as last observed (D7)', async () => {
      const [first, second] = [student, h.person('student-2', ['STUDENT'])];
      h.rtc.connect(h.room(session.id), 'student-1', LISTENER);
      for (const person of [first, second]) {
        const hand = await h.raised(person, session.id);
        await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      }
      const third = await h.member(communityId, owner, 'student-3');
      const pending = await h.raised(third, session.id);
      h.rtc.setUnavailable(true);
      await h.moderate.grant({ principal: owner, requestId: pending.id, meta: META });

      const granted = await page(owner, { state: 'granted' });
      expect(granted.ok && granted.value).toEqual({
        items: [
          expect.objectContaining({ userId: 'student-1', media: 'connected' }),
          expect.objectContaining({ userId: 'student-2', media: 'not_connected' }),
          expect.objectContaining({ userId: 'student-3', media: 'unknown' }),
        ],
        nextCursor: null,
      });
    });

    it('is for moderators only', async () => {
      const member = await h.member(communityId, owner, 'teacher-2', ['TEACHER']);
      expect(codeOf(await page(member))).toBe('live.not_a_moderator');
      expect(codeOf(await page(student))).toBe('identity.permission_denied');
      const outsider = h.person('teacher-9', ['TEACHER']);
      expect(codeOf(await page(outsider))).toBe('live.session_not_found');
    });
  });
});
