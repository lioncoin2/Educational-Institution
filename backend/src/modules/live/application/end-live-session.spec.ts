import { Logger } from '@nestjs/common';

import type { Principal } from '../../../shared';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import type { LiveSessionView } from './views';

/**
 * End (live.md §4.2, S5; audit D2, D6): one step closes everything open, one
 * audit entry and ONE `live.session.ended` announce it, and a repeat changes
 * nothing at all.
 */
describe('ending a live session', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let students: readonly Principal[];
  let session: LiveSessionView;

  beforeEach(async () => {
    h = liveHarness();
    ({
      id: communityId,
      owner,
      students,
    } = await h.community('teacher-1', 'student-1', 'student-2', 'student-3'));
    session = await h.startSession(owner, communityId);
    h.journal.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  const end = (principal: Principal, sessionId = session.id) =>
    h.end.execute({ principal, sessionId, meta: META });

  it('expires every open hand and closes the presenter grant in one step, with no per-hand events', async () => {
    const hands = [];
    for (const student of students) hands.push(await h.raised(student, session.id));
    const granted = await h.moderate.grant({
      principal: owner,
      requestId: hands[0]?.id,
      meta: META,
    });
    expect(granted.ok).toBe(true);
    expect(
      (await h.presenter.claim({ principal: owner, sessionId: session.id, meta: META })).ok,
    ).toBe(true);
    h.journal.clear();
    const before = (await h.session(session.id)).stateVersion;
    // Nobody is connected to the fake's room: both pushes are left for the watch.
    expect(h.media.unsettled().map((push) => push.userId)).toEqual(['student-1', 'teacher-1']);

    const ended = await end(owner);
    expect(ended.ok && ended.value).toMatchObject({
      id: session.id,
      state: 'ended',
      stateVersion: before + 1,
      endReason: 'moderator',
      speakerCount: 0,
      presenterUserId: null,
      me: { canJoin: false, canModerate: false, canEnd: false, canPresent: false, hand: null },
    });
    for (const hand of hands) {
      expect(await h.requests.findById(hand.id)).toMatchObject({
        state: 'expired',
        decidedBy: null,
        decidedAt: h.clock.now(),
      });
    }
    expect(h.store.presenterGrantsOf(session.id)).toEqual([
      expect.objectContaining({ endReason: 'session_ended', endedBy: owner.userId }),
    ]);
    // One audit entry, one event — the end implies every expiry and the close.
    expect(h.journal.order).toEqual(['audit:live.session.ended', 'event:live.session.ended']);
    expect(h.journal.events[0]?.payload).toEqual({
      sessionId: session.id,
      communityId,
      endedBy: owner.userId,
      reason: 'moderator',
      durationSeconds: 0,
    });
    expect(h.journal.entries[0]).toMatchObject({
      actorUserId: owner.userId,
      action: 'live.session.ended',
      resourceId: session.id,
      metadata: {
        communityId,
        reason: 'moderator',
        permit: { act: 'community.live.moderate', basis: 'owner', grantId: null },
      },
      correlationId: META.correlationId,
    });
    // Then the room — after `ended` was stored — and nothing is left to watch.
    expect(h.rtc.ended).toEqual([h.room(session.id)]);
    expect(h.rtc.roomNames()).toEqual([]);
    expect(h.media.unsettled()).toEqual([]);
  });

  it('answers a repeat with the ended view: no audit, no event, no provider call', async () => {
    await end(owner);
    h.journal.clear();
    const calls = h.rtc.calls.length;
    const again = await end(owner);
    expect(again.ok && again.value).toMatchObject({ id: session.id, state: 'ended' });
    expect(h.journal.order).toEqual([]);
    expect(h.rtc.calls).toHaveLength(calls);
  });

  it('lets any session moderator end the host’s session — End has no target (D2)', async () => {
    const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    const ended = await end(delegate);
    expect(ended.ok && ended.value.state).toBe('ended');
    expect(h.journal.entries[0]).toMatchObject({
      actorUserId: 'teacher-2',
      metadata: { permit: { basis: 'grant', grantId: expect.any(String) as string } },
    });
  });

  it('refuses a member who does not moderate with 403, and a non-member as an unknown session', async () => {
    const member = await h.member(communityId, owner, 'teacher-2', ['TEACHER']);
    expect(codeOf(await end(member))).toBe('live.not_a_moderator');
    const outsider = h.person('teacher-9', ['TEACHER']);
    expect(await end(outsider)).toEqual(
      await end(outsider, '00000000-0000-4000-8000-00000000ffff'),
    );
    expect(codeOf(await end(outsider))).toBe('live.session_not_found');
    // A student may not moderate at all: refused before anything is read.
    const lookup = jest.spyOn(h.sessions, 'findById');
    expect(codeOf(await end(students[0]))).toBe('identity.permission_denied');
    expect(lookup).not.toHaveBeenCalled();
    expect((await h.session(session.id)).state).toBe('live');
    expect(h.journal.order).toEqual([]);
  });

  it('audits a system end with a null actor, and announces it once', async () => {
    await h.raised(students[0], session.id);
    h.journal.clear();
    h.clock.advance(900);
    const outcome = await h.lifecycle.endBySystem(session.id, 'idle');
    expect(outcome).toMatchObject({ ended: true, session: { state: 'ended', endReason: 'idle' } });
    expect(h.journal.entries).toEqual([
      expect.objectContaining({
        actorUserId: null,
        action: 'live.session.ended',
        metadata: { communityId, targetUserId: null, reason: 'idle' },
      }),
    ]);
    expect(h.journal.events.map((event) => event.payload)).toEqual([
      { sessionId: session.id, communityId, endedBy: null, reason: 'idle', durationSeconds: 900 },
    ]);
    expect(h.store.moderationOf(session.id).at(-1)).toMatchObject({
      type: 'end_session',
      actorUserId: null,
    });
    // A repeat, by anyone, changes nothing.
    expect(await h.lifecycle.endBySystem(session.id, 'idle')).toMatchObject({ ended: false });
    expect(h.journal.events).toHaveLength(1);
  });

  it('keeps the end when the room cannot be ended — the room sweep is left to finish it', async () => {
    h.rtc.failNext('endRoom', 'unavailable');
    const ended = await end(owner);
    expect(ended.ok && ended.value.state).toBe('ended');
    expect(h.eventNames()).toEqual(['live.session.ended']);
    expect(h.rtc.roomNames()).toEqual([h.room(session.id)]);

    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const other = await h.community('teacher-5');
    const second = await h.startSession(other.owner, other.id);
    h.rtc.failNext('endRoom', 'fault');
    expect((await end(other.owner, second.id)).ok).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('refused');
  });

  it('refuses every change after the end, and answers a repeat of one with 200 (D6)', async () => {
    const [first, second, third] = students as [Principal, Principal, Principal];
    const pending = await h.raised(first, session.id);
    const toGrant = await h.raised(second, session.id);
    await h.moderate.grant({ principal: owner, requestId: toGrant.id, meta: META });
    const toDecline = await h.raised(third, session.id);
    await h.moderate.decline({ principal: owner, requestId: toDecline.id, meta: META });
    await end(owner);
    h.journal.clear();

    // A repeat of what a hand already is answers 200, even now, and records nothing.
    const repeated = await h.moderate.decline({
      principal: owner,
      requestId: toDecline.id,
      meta: META,
    });
    expect(repeated.ok && repeated.value.request.state).toBe('declined');

    expect(
      codeOf(await h.moderate.grant({ principal: owner, requestId: pending.id, meta: META })),
    ).toBe('live.session_not_live');
    expect(
      codeOf(await h.raise.execute({ principal: first, sessionId: session.id, meta: META })),
    ).toBe('live.session_not_live');
    expect(
      codeOf(await h.presenter.claim({ principal: owner, sessionId: session.id, meta: META })),
    ).toBe('live.session_not_live');
    expect(
      codeOf(await h.join.execute({ principal: first, sessionId: session.id, meta: META })),
    ).toBe('live.session_not_live');
    // The expired hand is simply down now.
    expect(await h.lower.execute({ principal: first, sessionId: session.id, meta: META })).toEqual({
      ok: true,
      value: { request: null },
    });
    expect(h.journal.order).toEqual([]);
  });
});
