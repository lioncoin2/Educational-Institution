import type { Principal } from '../../../shared';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../identity/domain/provisional-policy';
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
const MICROPHONE = { ...LISTENER, canPublishAudio: true };

/**
 * Join (live.md S2) — the security boundary of live media: a token only
 * after Communities permits it on the session's OWN community, capabilities
 * decided by the server from the caller's standing, the name from the
 * directory, and nothing written.
 */
describe('joining a live session', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    h.accounts.add('student-1', ['STUDENT'], 'مريم');
    session = await h.startSession(owner, communityId);
    h.journal.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  const join = (principal: Principal, sessionId = session.id) =>
    h.join.execute({ principal, sessionId, meta: META });

  async function ticket(principal: Principal, sessionId = session.id) {
    const joined = await join(principal, sessionId);
    if (!joined.ok) throw new Error(`expected a ticket, got ${joined.error.code}`);
    return joined.value;
  }

  // The property a large session rests on.
  it('gives a listener a token that can publish nothing — not audio, not a screen, not data', async () => {
    const joined = await ticket(student);
    expect(h.rtc.issued.at(-1)?.capabilities).toEqual(LISTENER);
    expect(LISTENER).toEqual({
      canPublishAudio: false,
      canPublishScreen: false,
      canPublishScreenAudio: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: false,
    });
    expect(joined).toMatchObject({
      role: 'listener',
      media: { microphone: false, screen: false, screenAudio: false },
    });
    expect(joined.token).toBe(`fake.${h.room(session.id)}.student-1.sub`);
  });

  it('names the participant from the account directory, scoped to the session’s room, for 120 seconds', async () => {
    const joined = await ticket(student);
    expect(h.settings.joinTokenTtlSeconds).toBe(120);
    expect(h.rtc.issued.at(-1)).toMatchObject({
      roomName: h.room(session.id),
      identity: 'student-1',
      displayName: 'مريم',
      ttlSeconds: 120,
    });
    expect(joined.expiresInSeconds).toBe(120);
  });

  it('names someone the directory does not know with an empty name, never anything else', async () => {
    jest.spyOn(h.accounts, 'describe').mockResolvedValueOnce([]);
    await ticket(student);
    expect(h.rtc.issued.at(-1)?.displayName).toBe('');
  });

  // P7.2 decision Q-C: the lifetime is the deployment's
  // (LIVE_JOIN_TOKEN_TTL_SECONDS), never a constant of the use case.
  it.each([1, 45, 600])('mints for the %s seconds the deployment configured', async (ttl) => {
    const configured = liveHarness({ settings: { joinTokenTtlSeconds: ttl } });
    const world = await configured.community('teacher-1', 'student-1');
    const started = await configured.startSession(world.owner, world.id);
    const joined = await configured.join.execute({
      principal: world.students[0],
      sessionId: started.id,
      meta: META,
    });
    expect(joined.ok && joined.value.expiresInSeconds).toBe(ttl);
    expect(configured.rtc.issued.at(-1)?.ttlSeconds).toBe(ttl);
  });

  it('checks the token’s lifetime where it is minted, and mints nothing outside 1..600 seconds (D24)', async () => {
    for (const joinTokenTtlSeconds of [0, 601, 21_600, 1.5]) {
      const misconfigured = liveHarness({ settings: { joinTokenTtlSeconds } });
      const world = await misconfigured.community('teacher-1', 'student-1');
      const started = await misconfigured.startSession(world.owner, world.id);
      await expect(
        misconfigured.join.execute({
          principal: world.students[0],
          sessionId: started.id,
          meta: META,
        }),
      ).rejects.toThrow(RangeError);
      expect(misconfigured.rtc.issued).toEqual([]);
    }
  });

  it('writes, audits and publishes nothing — a join is transport', async () => {
    const before = await h.session(session.id);
    for (let i = 0; i < 3; i += 1) await ticket(student);
    expect(h.rtc.issued).toHaveLength(3);
    expect(await h.session(session.id)).toEqual(before);
    expect(h.journal.order).toEqual([]);
    expect(await h.requests.findOpen(session.id, 'student-1')).toBeNull();
    expect(h.rtc.capabilityChanges).toEqual([]);
  });

  describe('who may join', () => {
    it('refuses a non-member exactly as an unknown session', async () => {
      const outsider = h.person('student-9', ['STUDENT']);
      const unknown = await join(outsider, '00000000-0000-4000-8000-00000000ffff');
      expect(await join(outsider)).toEqual(unknown);
      expect(codeOf(unknown)).toBe('live.session_not_found');
      expect(h.rtc.issued).toEqual([]);
    });

    it('refuses a member of another community as a non-member — the session’s own community decides', async () => {
      const other = await h.community('teacher-2', 'student-2');
      expect(codeOf(await join(other.students[0]))).toBe('live.session_not_found');
      expect(codeOf(await join(other.owner))).toBe('live.session_not_found');
    });

    it('refuses an ended session with 412', async () => {
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(codeOf(await join(student))).toBe('live.session_not_live');
    });

    it('refuses an ended session whose room outlived the end — the record decides, not the room', async () => {
      // The provider could not end the room: it stands, for the room sweep to
      // end. A join must still mint no token for it, a moderator's included.
      h.rtc.failNext('endRoom', 'unavailable');
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(h.rtc.roomNames()).toEqual([h.room(session.id)]);
      for (const principal of [student, owner]) {
        expect(codeOf(await join(principal))).toBe('live.session_not_live');
      }
      expect(h.rtc.issued).toEqual([]);
    });

    it('admits members of a LOCKED community: a lock stops new sessions, not the running one (Q46)', async () => {
      await h.lock(communityId, owner);
      expect((await ticket(student)).role).toBe('listener');
      expect((await ticket(owner)).role).toBe('moderator');
    });

    it('refuses a member with 412 under a status that closes joins — and still admits a moderator', async () => {
      withUnmappedStatus(h);
      expect(codeOf(await join(student))).toBe('live.community_not_open');
      expect((await ticket(owner)).role).toBe('moderator');
    });

    it('refuses a removed member at once: Communities is asked on every join, nothing is cached', async () => {
      expect((await join(student)).ok).toBe(true);
      await h.remove(communityId, owner, 'student-1');
      expect(codeOf(await join(student))).toBe('live.session_not_found');
    });
  });

  describe('the role matrix', () => {
    it('makes the host a moderator, publishing by right', async () => {
      const joined = await ticket(owner);
      expect(joined).toMatchObject({ role: 'moderator', media: { microphone: true } });
      expect(h.rtc.issued.at(-1)?.capabilities).toEqual(MICROPHONE);
    });

    it('makes a delegated moderator who did not start the session a moderator too', async () => {
      const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
      expect(await ticket(delegate)).toMatchObject({
        role: 'moderator',
        media: { microphone: true },
      });
    });

    it('makes the host who holds only community.live.start a moderator through community.live.host', async () => {
      const starter = await h.delegate(communityId, owner, 'teacher-2', 'community.live.start');
      const other = await h.community('teacher-3');
      await h.communities.addPeople(other.owner, other.id, 'teacher-2');
      await h.communities.delegate(other.owner, other.id, 'teacher-2', 'community.live.start');
      const hosted = await h.startSession(starter, other.id);
      expect((await ticket(starter, hosted.id)).role).toBe('moderator');
      // …only of their own session: in the owner's session they are a member, a listener.
      expect((await ticket(starter)).role).toBe('listener');
    });

    it('gives a moderator without live.speak no microphone', async () => {
      const withoutSpeak = PROVISIONAL_ROLE_PERMISSIONS.TEACHER.filter(
        (permission) => permission !== 'live.speak',
      );
      const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
      h.accounts.setPermissions('teacher-2', withoutSpeak);
      const silent: Principal = { ...delegate, permissions: new Set<string>(withoutSpeak) };
      expect(await ticket(silent)).toMatchObject({
        role: 'moderator',
        media: { microphone: false, screen: false },
      });
      expect(h.rtc.issued.at(-1)?.capabilities).toEqual(LISTENER);
    });

    it('treats an all-permission OWNER without standing as a stranger, and as a listener once a plain member', async () => {
      const institutionOwner = h.person('owner-1', ['OWNER']);
      expect(codeOf(await join(institutionOwner))).toBe('live.session_not_found');
      await h.communities.addPeople(owner, communityId, 'owner-1');
      expect(await ticket(institutionOwner)).toMatchObject({
        role: 'listener',
        media: { microphone: false },
      });
    });

    it('gives a granted hand the microphone across reconnects, and a revoked one nothing', async () => {
      const hand = await h.raised(student, session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      for (let i = 0; i < 2; i += 1) {
        expect(await ticket(student)).toMatchObject({
          role: 'speaker',
          media: { microphone: true, screen: false },
        });
        expect(h.rtc.issued.at(-1)?.capabilities).toEqual(MICROPHONE);
      }
      await h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META });
      expect((await ticket(student)).role).toBe('listener');
      expect(h.rtc.issued.at(-1)?.capabilities).toEqual(LISTENER);
    });

    it('gives the presenter the screen, and nobody the camera or data', async () => {
      await h.presenter.claim({ principal: owner, sessionId: session.id, meta: META });
      expect((await ticket(owner)).media).toEqual({
        microphone: true,
        screen: true,
        screenAudio: false,
      });
      for (const grant of h.rtc.issued) {
        expect(grant.capabilities.canPublishData).toBe(false);
        expect(grant.capabilities.canPublishScreenAudio).toBe(false);
        expect(grant.capabilities.hidden).toBe(false);
      }
    });
  });

  /**
   * P7.2 (audit §4.4, D20 as Start asks it): the provider round trips of the
   * room check take up to seconds, so everything the token encodes is decided
   * again just before it is signed — a removal, a revoke, an end or a reset
   * committed meanwhile is honoured.
   */
  describe('decided again just before the token', () => {
    /** Holds the room check at the provider, runs `meanwhile`, then lets the join finish. */
    async function joinWhile(principal: Principal, meanwhile: () => Promise<unknown>) {
      const gate = h.rtc.hold('listRooms');
      const joining = join(principal);
      await gate.reached;
      await meanwhile();
      gate.release();
      return joining;
    }

    it('refuses someone removed from the community during the room check, as a non-member — no token', async () => {
      const refused = await joinWhile(student, () => h.remove(communityId, owner, 'student-1'));
      expect(codeOf(refused)).toBe('live.session_not_found');
      expect(h.rtc.issued).toEqual([]);
    });

    it('signs what the caller may do now: a floor revoked during the room check gives no microphone', async () => {
      const hand = await h.raised(student, session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      const joined = await joinWhile(student, () =>
        h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META }),
      );
      expect(joined.ok && joined.value).toMatchObject({
        role: 'listener',
        media: { microphone: false, screen: false, screenAudio: false },
      });
      expect(h.rtc.issued.at(-1)?.capabilities).toEqual(LISTENER);
    });

    it('refuses a session ended during the room check with 412 — no token for a room being deleted', async () => {
      const refused = await joinWhile(student, () =>
        h.end.execute({ principal: owner, sessionId: session.id, meta: META }),
      );
      expect(codeOf(refused)).toBe('live.session_not_live');
      expect(h.rtc.issued).toEqual([]);
    });

    it('answers 503, retryable, when a media reset moved the session during the room check — never a token for the old room', async () => {
      const refused = await joinWhile(student, () =>
        h.sessions.bumpEpoch(session.id, 0, {
          id: h.ids.next<'ModerationAction'>(),
          sessionId: session.id,
          actorUserId: null,
          targetUserId: null,
          type: 'reset_media',
          at: h.clock.now(),
        }),
      );
      expect(refused).toMatchObject({
        ok: false,
        error: { kind: 'unavailable', code: 'live.media_unavailable' },
      });
      expect(h.rtc.issued).toEqual([]);
      await h.rtc.ensureRoom({
        roomName: h.room(session.id, 1),
        maxParticipants: 310,
        emptyTimeoutSeconds: 1_200,
        departureTimeoutSeconds: 1_200,
      });
      h.clock.advance(5);
      expect((await ticket(student)).token).toBe(`fake.${h.room(session.id, 1)}.student-1.sub`);
    });

    it('fails closed when the account directory cannot name the caller: 503, no token, logged by class', async () => {
      jest.spyOn(h.accounts, 'describe').mockRejectedValueOnce(new Error('directory down'));
      const refused = await join(student);
      expect(refused).toMatchObject({
        ok: false,
        error: { kind: 'unavailable', code: 'unavailable' },
      });
      expect(h.rtc.issued).toEqual([]);
    });
  });

  it('names the session and when the token stops admitting a connection — never later than the token says', async () => {
    h.clock.advance(0.75);
    const signedAt = Math.floor(h.clock.now().getTime() / 1000);
    const joined = await ticket(student);
    expect(joined.sessionId).toBe(session.id);
    expect(joined.expiresAt).toEqual(new Date((signedAt + joined.expiresInSeconds) * 1000));
    expect(joined.expiresAt.getTime()).toBeLessThanOrEqual(
      h.clock.now().getTime() + joined.expiresInSeconds * 1000,
    );
  });

  describe('the media room', () => {
    it('re-creates a room the provider lost, and admits the caller into it', async () => {
      await h.rtc.endRoom(h.room(session.id));
      expect((await ticket(student)).role).toBe('listener');
      expect(h.rtc.roomNames()).toEqual([h.room(session.id)]);
    });

    it('re-reads the session after ensuring a missing room: an end in between ends the room and refuses (§4.4)', async () => {
      await h.rtc.endRoom(h.room(session.id));
      const gate = h.rtc.hold('ensureRoom');
      const joining = join(student);
      await gate.reached;
      const ended = await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      expect(ended.ok).toBe(true);
      gate.release();

      expect(codeOf(await joining)).toBe('live.session_not_live');
      expect(h.rtc.roomNames()).toEqual([]);
      expect(h.rtc.issued).toEqual([]);
    });

    /** A media reset committed elsewhere: the session moves one epoch on (§11.4). */
    const resetElsewhere = async (from: number) => {
      const moved = await h.sessions.bumpEpoch(session.id, from, {
        id: h.ids.next<'ModerationAction'>(),
        sessionId: session.id,
        actorUserId: null,
        targetUserId: null,
        type: 'reset_media',
        at: h.clock.now(),
      });
      expect(moved?.mediaRoomEpoch).toBe(from + 1);
    };

    it('compares the epoch after ensuring: a reset in between ends the re-created old room, and admits into the new one', async () => {
      await h.rtc.endRoom(h.room(session.id));
      const gate = h.rtc.hold('ensureRoom');
      const joining = join(student);
      await gate.reached;
      await resetElsewhere(0);
      gate.release();

      const joined = await joining;
      if (!joined.ok) throw new Error(joined.error.code);
      // The token is for the room the session uses now — never the deleted one.
      expect(joined.value.token).toBe(`fake.${h.room(session.id, 1)}.student-1.sub`);
      expect(h.rtc.issued.map((grant) => grant.roomName)).toEqual([h.room(session.id, 1)]);
      expect(h.rtc.ensured.slice(-2).map((spec) => spec.roomName)).toEqual([
        h.room(session.id, 0),
        h.room(session.id, 1),
      ]);
      expect(h.rtc.ended.at(-1)).toBe(h.room(session.id, 0));
      expect(h.rtc.roomNames()).toEqual([h.room(session.id, 1)]);
    });

    it('answers 503 live.media_unavailable, retryable, when the session moves again during the second admission', async () => {
      await h.rtc.endRoom(h.room(session.id));
      const first = h.rtc.hold('ensureRoom');
      const joining = join(student);
      await first.reached;
      await resetElsewhere(0);
      first.release();
      const second = h.rtc.hold('ensureRoom');
      await second.reached;
      await resetElsewhere(1);
      second.release();

      const refused = await joining;
      expect(codeOf(refused)).toBe('live.media_unavailable');
      expect(refused).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
      expect(h.rtc.issued).toEqual([]);
      // Neither room the call re-created is left behind.
      expect(h.rtc.roomNames()).toEqual([]);
      // The next try is admitted to the current room.
      expect((await ticket(student)).token).toBe(`fake.${h.room(session.id, 2)}.student-1.sub`);
    });

    it('lets a provider fault fail the join as the fault it is — never a token on a guess', async () => {
      h.rtc.failNext('listRooms', 'fault');
      await expect(join(student)).rejects.toThrow('refused listRooms');
      expect(h.rtc.issued).toEqual([]);
    });

    // P7.2 decision Q-B: an outage fails open to the provider's hard cap; a
    // provider refusing this deployment's configuration fails closed — nothing
    // could enforce anything in a room it runs.
    it.each(['listRooms', 'ensureRoom', 'issueAccessToken'] as const)(
      'fails closed, 503 live.media_misconfigured, when %s meets a configuration the provider refuses',
      async (operation) => {
        if (operation === 'ensureRoom') await h.rtc.endRoom(h.room(session.id));
        h.rtc.failNext(operation, 'misconfigured');
        const refused = await join(student);
        expect(refused).toMatchObject({
          ok: false,
          error: { kind: 'unavailable', code: 'live.media_misconfigured' },
        });
        expect(h.rtc.issued).toEqual([]);
      },
    );

    it('fails open when the provider cannot be asked about the room, but not when it cannot sign', async () => {
      h.rtc.failNext('listRooms', 'unavailable');
      expect((await join(student)).ok).toBe(true);

      await h.rtc.endRoom(h.room(session.id));
      h.rtc.failNext('ensureRoom', 'unavailable');
      h.clock.advance(5);
      expect((await join(student)).ok).toBe(true);

      h.rtc.setUnavailable(true);
      h.clock.advance(5);
      expect(await join(student)).toMatchObject({
        ok: false,
        error: { kind: 'unavailable', code: 'live.media_unavailable' },
      });
    });
  });

  describe('the soft cap', () => {
    let small: LiveHarness;
    let world: Awaited<ReturnType<LiveHarness['community']>>;
    let room: string;
    let started: LiveSessionView;

    beforeEach(async () => {
      small = liveHarness({ settings: { participantCap: 3 } });
      world = await small.community(
        'teacher-1',
        'student-1',
        'student-2',
        'student-3',
        'student-4',
      );
      started = await small.startSession(world.owner, world.id);
      room = small.room(started.id);
      // Two people are already in the room.
      small.rtc.connect(room, 'someone-a', LISTENER);
      small.rtc.connect(room, 'someone-b', LISTENER);
    });

    const joinSmall = (principal: Principal) =>
      small.join.execute({ principal, sessionId: started.id, meta: META });

    it('counts the listener tokens issued since the sample, so a storm inside one sample stops at the cap', async () => {
      const [first, second] = world.students as [Principal, Principal];
      expect((await joinSmall(first)).ok).toBe(true);
      expect(codeOf(await joinSmall(second))).toBe('live.session_full');
      // A fresh sample sees who actually connected: nobody new, so there is room again.
      small.clock.advance(3);
      expect((await joinSmall(second)).ok).toBe(true);
    });

    it('reads the room at most once per sample, however many join', async () => {
      const [first] = world.students as [Principal];
      for (let i = 0; i < 3; i += 1) expect((await joinSmall(world.owner)).ok).toBe(true);
      expect((await joinSmall(first)).ok).toBe(true);
      expect(small.rtc.calls.filter((call) => call.operation === 'listRooms')).toHaveLength(1);
    });

    it('lets moderators and speakers in above it: the reserve is theirs', async () => {
      const [first, second, third] = world.students as [Principal, Principal, Principal];
      small.rtc.connect(room, 'someone-c', LISTENER);
      expect(codeOf(await joinSmall(first))).toBe('live.session_full');
      expect((await joinSmall(world.owner)).ok).toBe(true);

      const hand = await small.raised(second, started.id);
      await small.moderate.grant({ principal: world.owner, requestId: hand.id, meta: META });
      expect(await joinSmall(second)).toMatchObject({ ok: true, value: { role: 'speaker' } });
      expect(codeOf(await joinSmall(third))).toBe('live.session_full');
    });

    it('fails open when the room cannot be observed', async () => {
      const [first] = world.students as [Principal];
      small.rtc.connect(room, 'someone-c', LISTENER);
      small.rtc.failNext('listRooms', 'unavailable');
      expect((await joinSmall(first)).ok).toBe(true);
    });
  });

  it('limits joins to ten a minute per (session, person) — never per address', async () => {
    for (let i = 0; i < 10; i += 1) {
      const joined = await h.join.execute({
        principal: student,
        sessionId: session.id,
        meta: { correlationId: `r-${i}`, ipAddress: `10.0.0.${i}` },
      });
      expect(joined.ok).toBe(true);
    }
    expect(await join(student)).toMatchObject({
      ok: false,
      error: {
        kind: 'rate_limited',
        code: 'live.too_many_joins',
        details: { retryAfterSeconds: expect.any(Number) as number },
      },
    });
    // Another person in the same session, from the same address, is not limited by it.
    expect((await join(owner)).ok).toBe(true);
    // Nor is the same person in another session.
    const other = await h.community('teacher-2');
    await h.communities.addPeople(other.owner, other.id, 'student-1');
    const elsewhere = await h.startSession(other.owner, other.id);
    expect((await join(student, elsewhere.id)).ok).toBe(true);
    h.clock.advance(60);
    expect((await join(student)).ok).toBe(true);
  });
});
