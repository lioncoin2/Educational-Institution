import { Logger } from '@nestjs/common';

import type { Principal } from '../../../shared';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { ROOM_PROVIDER_TIMEOUT_SECONDS } from '../domain/live-limits';
import { DisabledRtcProvider } from '../infrastructure/disabled-rtc-provider';

/**
 * Start (live.md §4.1, S1; audit D1, D19, D20): idempotent and provider
 * first, over Communities' real answers — nothing is stored unless the room
 * exists and the permit held both before and after the provider call.
 */
describe('starting a live session', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;

  beforeEach(async () => {
    h = liveHarness();
    ({ id: communityId, owner } = await h.community('teacher-1', 'student-1'));
  });

  afterEach(() => jest.restoreAllMocks());

  const start = (principal: Principal, community = communityId) =>
    h.start.execute({ principal, communityId: community, meta: META });

  /** Nothing about a session exists for the community: no row, no audit, no event. */
  async function nothingStored(community = communityId): Promise<void> {
    expect(await h.sessions.findLiveByCommunity(community)).toBeNull();
    expect(h.journal.entries).toEqual([]);
    expect(h.journal.events).toEqual([]);
  }

  it('ensures the room first, then stores one session, audited with its permit and announced once', async () => {
    const started = await start(owner);
    if (!started.ok) throw new Error(started.error.code);
    const { session } = started.value;
    expect(started.value.created).toBe(true);
    expect(session).toMatchObject({
      communityId,
      state: 'live',
      stateVersion: 1,
      hostUserId: owner.userId,
      endedAt: null,
      endReason: null,
      participantCap: 300,
      speakerCount: 0,
      presenterUserIds: [],
      me: { role: 'moderator', isHost: true, canJoin: true, canModerate: true, canEnd: true },
      moderation: { pendingHands: 0, violations: 0, lastViolationAt: null },
    });

    // The room, sized to the cap plus the reserve, before anything was stored.
    expect(h.rtc.ensured).toEqual([
      {
        roomName: h.room(session.id),
        maxParticipants: 310,
        emptyTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
        departureTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
      },
    ]);
    expect(h.rtc.roomNames()).toEqual([h.room(session.id)]);

    expect(h.journal.order).toEqual(['audit:live.session.started', 'event:live.session.started']);
    expect(h.journal.entries[0]).toEqual({
      actorUserId: owner.userId,
      action: 'live.session.started',
      resourceType: 'live.session',
      resourceId: session.id,
      at: h.clock.now(),
      metadata: {
        communityId,
        targetUserId: null,
        permit: {
          act: 'community.live.start',
          basis: 'owner',
          membershipId: expect.any(String) as string,
          grantId: null,
        },
      },
      correlationId: META.correlationId,
    });
    expect(h.journal.events[0]).toMatchObject({
      name: 'live.session.started',
      aggregateId: session.id,
      payload: { sessionId: session.id, communityId, hostUserId: owner.userId },
      correlationId: META.correlationId,
    });
    expect(h.store.moderationOf(session.id).map((action) => action.type)).toEqual([
      'start_session',
    ]);
  });

  it('is idempotent: a second start answers the running session, with no provider call and nothing recorded', async () => {
    const first = await h.startSession(owner, communityId);
    const calls = h.rtc.calls.length;
    const again = await start(owner);
    expect(again.ok && again.value).toMatchObject({ created: false, session: { id: first.id } });
    expect(h.rtc.calls).toHaveLength(calls);
    expect(h.audits()).toEqual(['live.session.started']);
    expect(h.eventNames()).toEqual(['live.session.started']);
  });

  it('lets a delegate holding community.live.start start — and host — the session', async () => {
    const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.start');
    const started = await start(delegate);
    expect(started.ok && started.value.session).toMatchObject({
      hostUserId: 'teacher-2',
      me: { role: 'moderator', isHost: true, canModerate: true },
    });
    expect(h.journal.entries[0]?.metadata).toMatchObject({
      permit: { act: 'community.live.start', basis: 'grant', grantId: expect.any(String) },
    });
  });

  it('makes one session out of twenty racing starts, and ends every loser’s room', async () => {
    // Twenty people, each within their own start limit.
    const starters = [owner];
    for (let i = 2; i <= 20; i += 1) {
      starters.push(await h.delegate(communityId, owner, `teacher-${i}`, 'community.live.start'));
    }
    const gate = h.rtc.hold('ensureRoom');
    const racing = starters.map((starter) => start(starter));
    // Every start is past its first look for a running session, holding a room of its own.
    while (h.rtc.calls.filter((call) => call.operation === 'ensureRoom').length < 20) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    gate.release();
    const results = await Promise.all(racing);

    const ids = new Set(results.map((result) => (result.ok ? result.value.session.id : 'failed')));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(results.filter((result) => result.ok && result.value.created)).toHaveLength(1);
    expect(h.rtc.roomNames()).toEqual([h.room(id)]);
    expect(h.rtc.ended).toHaveLength(19);
    expect(h.rtc.ended).not.toContain(h.room(id));
    expect(h.audits()).toEqual(['live.session.started']);
    expect(h.eventNames()).toEqual(['live.session.started']);
  });

  it('answers a provider outage with 503 live.media_unavailable and stores nothing', async () => {
    h.rtc.failNext('ensureRoom', 'unavailable');
    const refused = await start(owner);
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', code: 'live.media_unavailable' },
    });
    await nothingStored();
  });

  it('answers 503 with nothing stored when real media is not enabled — the disabled provider (D19)', async () => {
    const disabled = liveHarness({ provider: new DisabledRtcProvider() });
    const world = await disabled.community('teacher-1');
    const refused = await disabled.start.execute({
      principal: world.owner,
      communityId: world.id,
      meta: META,
    });
    expect(codeOf(refused)).toBe('live.media_unavailable');
    expect(await disabled.sessions.findLiveByCommunity(world.id)).toBeNull();
    expect(disabled.journal.entries).toEqual([]);
    expect(disabled.journal.events).toEqual([]);
  });

  // P7.2 decision Q-B: refused credentials, a TLS failure or a wrong
  // endpoint is not an outage — waiting fixes none of them.
  it('answers a configuration the provider refuses with 503 live.media_misconfigured and stores nothing', async () => {
    h.rtc.failNext('ensureRoom', 'misconfigured');
    const refused = await start(owner);
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', code: 'live.media_misconfigured' },
    });
    // The answer names no reason, URL or key: only the stable code and a message.
    expect(JSON.stringify(refused)).not.toMatch(/unauthorized|ensureRoom|http|ws:/);
    await nothingStored();
  });

  it('lets a fault from the provider fail the call as the fault it is, storing nothing', async () => {
    h.rtc.failNext('ensureRoom', 'fault');
    await expect(start(owner)).rejects.toThrow('refused ensureRoom');
    await nothingStored();
  });

  it('refuses a non-member exactly as an unknown community, and a member without the capability with 403', async () => {
    const outsider = h.person('teacher-9', ['TEACHER']);
    const unknown = await start(outsider, '00000000-0000-4000-8000-00000000ffff');
    const real = await start(outsider);
    expect(real).toEqual(unknown);
    expect(codeOf(real)).toBe('live.community_not_found');

    const member = await h.member(communityId, owner, 'teacher-2', ['TEACHER']);
    expect(codeOf(await start(member))).toBe('live.start_not_permitted');
    // A student may not start at all: identity's ceiling, before anything is read.
    const [student] = (await h.community('teacher-3', 'student-3')).students;
    expect(codeOf(await start(student))).toBe('identity.permission_denied');
    expect(h.rtc.calls).toEqual([]);
    await nothingStored();
  });

  it('refuses a LOCKED community with 412 — but answers a retry after a lock with the running session (D1)', async () => {
    const other = await h.community('teacher-5');
    await h.lock(other.id, other.owner);
    expect(codeOf(await start(other.owner, other.id))).toBe('live.community_not_open');
    await nothingStored(other.id);

    const session = await h.startSession(owner, communityId);
    await h.lock(communityId, owner);
    const retried = await start(owner);
    expect(retried.ok && retried.value).toMatchObject({
      created: false,
      session: { id: session.id, state: 'live' },
    });
  });

  it('asks again after the provider call: a lock committed meanwhile refuses, and the room is ended (D20)', async () => {
    const gate = h.rtc.hold('ensureRoom');
    const starting = start(owner);
    await gate.reached;
    await h.lock(communityId, owner);
    gate.release();

    expect(codeOf(await starting)).toBe('live.community_not_open');
    const [ensured] = h.rtc.ensured;
    expect(h.rtc.ended).toEqual([ensured?.roomName]);
    expect(h.rtc.roomNames()).toEqual([]);
    await nothingStored();
  });

  it('asks again after the provider call: a capability revoked meanwhile refuses with 403', async () => {
    const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.start');
    const [grantId] = await h.grantsOf(communityId, owner, 'teacher-2', 'community.live.start');
    const gate = h.rtc.hold('ensureRoom');
    const starting = start(delegate);
    await gate.reached;
    const revoked = await h.communities.revokeGrant.execute({
      principal: owner,
      communityId,
      grantId: grantId,
      meta: META,
    });
    expect(revoked.ok).toBe(true);
    gate.release();

    expect(codeOf(await starting)).toBe('live.start_not_permitted');
    expect(h.rtc.roomNames()).toEqual([]);
    await nothingStored();
  });

  it('ends the room it ensured when Communities cannot answer the second time, and answers 503', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const authorize = h.authorization.authorize.bind(h.authorization);
    jest
      .spyOn(h.authorization, 'authorize')
      .mockImplementationOnce(authorize)
      .mockRejectedValueOnce(new Error('connection terminated'));

    expect(await start(owner)).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', code: 'unavailable' },
    });
    expect(h.rtc.roomNames()).toEqual([]);
    await nothingStored();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('limits starts to ten a minute per person — never per address', async () => {
    await h.startSession(owner, communityId);
    for (let i = 1; i < 10; i += 1) expect((await start(owner)).ok).toBe(true);
    const limited = await start(owner);
    expect(limited).toMatchObject({
      ok: false,
      error: {
        kind: 'rate_limited',
        code: 'live.too_many_starts',
        details: { retryAfterSeconds: expect.any(Number) as number },
      },
    });
    // Someone else is not limited by it…
    const other = await h.community('teacher-7');
    expect((await start(other.owner, other.id)).ok).toBe(true);
    // …and the window passes.
    h.clock.advance(60);
    expect((await start(owner)).ok).toBe(true);
  });
});
