import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';

import { EVENT_SUBSCRIBER, type DomainEvent, type EventSubscriber } from '../../src/shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
} from '../../src/modules/communities/contracts/authorization';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../src/modules/identity/contracts';
import { LiveController } from '../../src/modules/live/api/live.controller';
import { LiveEvents } from '../../src/modules/live/contracts';
import {
  LIVE_SESSION_REPOSITORY,
  type LiveSessionRepository,
} from '../../src/modules/live/domain/ports';
import {
  RTC_PROVIDER,
  type RtcCapabilities,
  type RtcParticipantObservation,
} from '../../src/modules/live/domain/rtc-provider';
import type { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import type { ApiResponse } from '../support/api-client';
import { LogCapture, credentialsIn, serialize } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/** Ids no community, session or request has — "does not exist". */
const UNKNOWN_COMMUNITY = '00000000-0000-4000-8000-00000000c0de';
const UNKNOWN_SESSION = '00000000-0000-4000-8000-00000000abcd';
const UNKNOWN_REQUEST = '00000000-0000-4000-8000-00000000beef';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The wire shapes' keys, sorted: pinned, so nothing reaches a client unannounced. */
const SESSION_KEYS = [
  'communityId',
  'endReason',
  'endedAt',
  'hostUserId',
  'id',
  'me',
  'moderation',
  'participantCap',
  'presenterUserId',
  'speakerCount',
  'startedAt',
  'state',
  'stateVersion',
].sort();
const ME_KEYS = [
  'canEnd',
  'canJoin',
  'canModerate',
  'canPresent',
  'canRaiseHand',
  'hand',
  'isHost',
  'presenting',
  'role',
].sort();
const MODERATION_KEYS = ['lastViolationAt', 'pendingHands', 'violations'].sort();
const REQUEST_KEYS = [
  'decidedAt',
  'grantedAt',
  'id',
  'requestedAt',
  'sessionId',
  'state',
  'userId',
].sort();
const TICKET_KEYS = ['expiresInSeconds', 'media', 'role', 'token', 'url'].sort();

/** A listener's rights: to listen, and nothing else — not even the data channel. */
const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

/** The thirteen routes (the P6 audit §11), for these ids. */
function liveRoutes(communityId: string, sessionId: string, requestId: string) {
  return [
    ['POST', `/communities/${communityId}/sessions`],
    ['GET', `/communities/${communityId}/sessions/current`],
    ['GET', `/sessions/${sessionId}`],
    ['POST', `/sessions/${sessionId}/join`],
    ['POST', `/sessions/${sessionId}/end`],
    ['POST', `/sessions/${sessionId}/hand`],
    ['DELETE', `/sessions/${sessionId}/hand`],
    ['GET', `/sessions/${sessionId}/hands`],
    ['POST', `/requests/${requestId}/grant`],
    ['POST', `/requests/${requestId}/decline`],
    ['POST', `/requests/${requestId}/revoke`],
    ['POST', `/sessions/${sessionId}/screen-share`],
    ['DELETE', `/sessions/${sessionId}/screen-share`],
  ] as const;
}

/**
 * /live over HTTP — the application exactly as the server runs it without a
 * database or media credentials: the real guards, pipes, filter,
 * interceptor and wiring, in-memory sessions and the fake media provider,
 * over the real Communities. Accounts, communities, members, grants and locks
 * are all made over HTTP, and so is every session.
 *
 * Every line the application logs is captured, as written, and so is every
 * live event: the suite ends by scanning them for any join ticket — or any
 * token at all.
 */
describe('live API', () => {
  const logs = new LogCapture();
  const events: DomainEvent[] = [];
  /** Every live response, with the route that gave it. */
  const transcript: Array<{ readonly route: string; readonly raw: string }> = [];
  /** Every join ticket's token, as issued. */
  const tickets: string[] = [];

  let r: RealtimeApi;
  let rtc: FakeRtcProvider;
  let admin: Account;
  let host: Account;
  let delegate: Account;
  let teacher: Account;
  let s1: Account;
  let s2: Account;
  let s3: Account;
  let s4: Account;
  let s5: Account;
  let outsider: Account;
  /** Owned by the host (a TEACHER): made by the admin, handed over, and left. */
  let communityId: string;
  /** Owned, and hosted in, by the admin. */
  let otherCommunityId: string;
  let sessionId: string;

  beforeAll(async () => {
    // The fake media provider, bound as development binds it — the
    // development secret, real media not asked for, the default room prefix —
    // whatever the shell running the tests exports.
    r = await startRealtimeApi(
      {
        LIVEKIT_API_SECRET: 'development-only-secret',
        LIVE_MEDIA_PROVIDER: '',
        LIVE_ROOM_NAME_PREFIX: '',
      },
      { logger: logs },
    );
    rtc = r.api.app.get<FakeRtcProvider>(RTC_PROVIDER, { strict: false });
    const bus = r.api.app.get<EventSubscriber>(EVENT_SUBSCRIBER, { strict: false });
    for (const name of Object.values(LiveEvents)) {
      bus.subscribe(name, (event) => {
        events.push(event);
      });
    }

    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    host = await r.provision('host', 'TEACHER', 'الأستاذة عائشة');
    delegate = await r.provision('delegate', 'TEACHER', 'الأستاذة سودة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة حفصة');
    s1 = await r.provision('s1', 'STUDENT', 'مريم');
    s2 = await r.provision('s2', 'STUDENT', 'زينب');
    s3 = await r.provision('s3', 'STUDENT', 'رقية');
    s4 = await r.provision('s4', 'STUDENT', 'سمية');
    s5 = await r.provision('s5', 'STUDENT', 'خديجة');
    outsider = await r.provision('outsider', 'STUDENT', 'أسماء');

    // Only OWNER and ADMIN create communities: the admin makes this one,
    // hands it to the host and leaves, so nobody but the people added here
    // has any standing in it.
    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [host, delegate, teacher, s1, s2, s3, s4, s5]);
    await expectStatus(
      r.api.call('PUT', `/communities/${communityId}/owner`, {
        token: admin.token,
        body: { userId: host.id },
      }),
      200,
    );
    await expectStatus(
      r.api.call('POST', `/communities/${communityId}/leave`, { token: admin.token }),
      204,
    );
    await r.grantCapabilities(host, communityId, delegate.id, [
      'community.live.start',
      'community.live.moderate',
    ]);

    otherCommunityId = await r.createCommunity(admin, 'حلقة الفجر');
    await r.addToCommunity(admin, otherCommunityId, [delegate, s1]);
    await r.grantCapabilities(admin, otherCommunityId, delegate.id, ['community.live.moderate']);
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  async function expectStatus(response: Promise<ApiResponse>, status: number): Promise<void> {
    const answered = await response;
    if (answered.status !== status) throw new Error(`${answered.status}: ${answered.raw}`);
  }

  async function call(
    method: string,
    path: string,
    account?: Account,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResponse> {
    const response = await r.api.call(method, `/live${path}`, {
      token: account?.token,
      body,
      headers,
    });
    transcript.push({ route: `${method} ${path}`, raw: response.raw });
    if (path.endsWith('/join') && response.status === 200) {
      tickets.push(response.body.token as string);
    }
    return response;
  }

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;
  const refusal = (response: ApiResponse) => ({ status: response.status, code: code(response) });

  /** A body with its request id removed — two refusals compared byte for byte. */
  const withoutRequestId = (response: ApiResponse) => {
    const { requestId: _ignored, ...rest } = response.body;
    return JSON.stringify({ status: response.status, ...rest });
  };

  /** The fake's rooms carry the development prefix: `live-` + the session id. */
  const room = (id: string) => `live-${id}`;

  /**
   * The audit trail, as the application wrote it — to the log, since there is
   * no database: every entry, or one action's.
   */
  const audits = (action?: string): Array<Record<string, unknown>> =>
    logs
      .logged()
      .map(([first]) => first)
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>).audit === true &&
          (action === undefined || (entry as Record<string, unknown>).action === action),
      );

  /** A hand as the wire carries it. */
  type Hand = Record<string, unknown> & { id: string; userId: string; requestedAt: string };

  /** The session's queue, as a moderator's first page shows it. */
  const pendingHands = async (by: Account = host) =>
    (await call('GET', `/sessions/${sessionId}/hands`, by)).body.items as Hand[];

  /** `account`'s hand among these. */
  const handOf = (hands: readonly Hand[], account: Account): Hand => {
    const hand = hands.find((candidate) => candidate.userId === account.id);
    if (hand === undefined) throw new Error(`no hand of ${account.email}`);
    return hand;
  };

  /**
   * First come, first served, by the server's own keys: when it was raised,
   * then its id. Two raises inside one millisecond are ordered by id, so a
   * test states the order through these keys, never through the order it
   * raised them in.
   */
  const firstComeFirstServed = (a: Hand, b: Hand) =>
    byText(a.requestedAt, b.requestedAt) || byText(a.id, b.id);
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  it('refuses every route to an anonymous caller', async () => {
    const answers: Array<Record<string, unknown>> = [];
    for (const [method, path] of liveRoutes(UNKNOWN_COMMUNITY, UNKNOWN_SESSION, UNKNOWN_REQUEST)) {
      answers.push({ method, path, status: (await call(method, path)).status });
    }
    expect(answers).toHaveLength(13);
    expect(answers).toEqual(answers.map((answer) => ({ ...answer, status: 401 })));
  });

  it('holds every route to its identity ceiling before anything is read', async () => {
    // A student moderates nothing — refused before any id is looked up.
    for (const [method, path] of [
      ['POST', `/communities/${UNKNOWN_COMMUNITY}/sessions`],
      ['POST', `/sessions/${UNKNOWN_SESSION}/end`],
      ['GET', `/sessions/${UNKNOWN_SESSION}/hands`],
      ['POST', `/requests/${UNKNOWN_REQUEST}/grant`],
      ['POST', `/requests/${UNKNOWN_REQUEST}/decline`],
      ['POST', `/requests/${UNKNOWN_REQUEST}/revoke`],
      ['POST', `/sessions/${UNKNOWN_SESSION}/screen-share`],
    ] as const) {
      expect({ method, path, ...refusal(await call(method, path, s1)) }).toEqual({
        method,
        path,
        status: 403,
        code: 'identity.permission_denied',
      });
    }
    // …and a teacher does not ask for the floor: `live.raise_hand` is not theirs.
    expect(refusal(await call('POST', `/sessions/${UNKNOWN_SESSION}/hand`, teacher))).toEqual({
      status: 403,
      code: 'identity.permission_denied',
    });
  });

  it('starts a session: 201 with the caller as its host, then 200 with the same one', async () => {
    expect(refusal(await call('POST', `/communities/${communityId}/sessions`, teacher))).toEqual({
      status: 403,
      code: 'live.start_not_permitted',
    });

    // A body is no input: the host is the caller, the community the path's,
    // the cap the deployment's.
    const created = await call('POST', `/communities/${communityId}/sessions`, host, {
      hostUserId: delegate.id,
      communityId: otherCommunityId,
      participantCap: 5,
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(SESSION_KEYS);
    expect(created.body).toEqual({
      id: expect.any(String),
      communityId,
      state: 'live',
      stateVersion: 1,
      hostUserId: host.id,
      startedAt: expect.stringMatching(ISO),
      endedAt: null,
      endReason: null,
      participantCap: 300,
      speakerCount: 0,
      presenterUserId: null,
      me: {
        role: 'moderator',
        isHost: true,
        canJoin: true,
        canRaiseHand: false,
        canModerate: true,
        canEnd: true,
        canPresent: true,
        presenting: false,
        hand: null,
      },
      moderation: { pendingHands: 0, violations: 0, lastViolationAt: null },
    });
    sessionId = created.body.id as string;
    // Provider first: the media room was made, sized to the cap plus the reserve.
    expect(rtc.room(room(sessionId))?.spec).toEqual({
      roomName: room(sessionId),
      maxParticipants: 310,
      emptyTimeoutSeconds: 1200,
      departureTimeoutSeconds: 1200,
    });

    const again = await call('POST', `/communities/${communityId}/sessions`, host);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(created.body);
    const byDelegate = await call('POST', `/communities/${communityId}/sessions`, delegate);
    expect(byDelegate.status).toBe(200);
    expect(byDelegate.body).toMatchObject({
      id: sessionId,
      hostUserId: host.id,
      me: { role: 'moderator', isHost: false, canModerate: true },
    });
    expect(rtc.ensured.filter((spec) => spec.roomName === room(sessionId))).toHaveLength(1);
    expect(audits('live.session.started')).toMatchObject([
      {
        actorUserId: host.id,
        resourceType: 'live.session',
        resourceId: sessionId,
        metadata: { communityId, permit: { act: 'community.live.start', basis: 'owner' } },
      },
    ]);
  });

  it('shows the current session, and the session, to whoever may see it — with their own flags', async () => {
    const current = await call('GET', `/communities/${communityId}/sessions/current`, s1);
    expect(current.status).toBe(200);
    expect(Object.keys(current.body)).toEqual(['session']);
    expect(current.body.session).toMatchObject({
      id: sessionId,
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
    const seen = await call('GET', `/sessions/${sessionId}`, s1);
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual(current.body.session);
    expect(Object.keys(seen.body.me as object).sort()).toEqual(ME_KEYS);

    // Moderators see the moderation block; a member who is not one does not.
    expect((await call('GET', `/sessions/${sessionId}`, teacher)).body).toMatchObject({
      me: { role: 'listener', canRaiseHand: false, canModerate: false },
      moderation: null,
    });
    const moderating = await call('GET', `/sessions/${sessionId}`, delegate);
    expect(moderating.body).toMatchObject({ me: { role: 'moderator', canEnd: true } });
    expect(Object.keys(moderating.body.moderation as object).sort()).toEqual(MODERATION_KEYS);

    // A community with nothing running.
    expect(
      (await call('GET', `/communities/${otherCommunityId}/sessions/current`, s1)).body,
    ).toEqual({ session: null });
  });

  it('joins with a ticket that is the server’s decision alone — never the client’s', async () => {
    const before = rtc.issued.length;
    const listener = await call('POST', `/sessions/${sessionId}/join`, s1, {
      displayName: 'الأستاذة عائشة',
      role: 'moderator',
      identity: host.id,
      roomName: 'another-room',
      ttlSeconds: 21_600,
    });
    expect(listener.status).toBe(200);
    expect(Object.keys(listener.body).sort()).toEqual(TICKET_KEYS);
    expect(listener.body).toEqual({
      token: `fake.${room(sessionId)}.${s1.id}.sub`,
      url: 'ws://fake-rtc.local',
      expiresInSeconds: 120,
      role: 'listener',
      media: { microphone: false, screen: false, screenAudio: false },
    });
    // What the token encodes: this session's room, the caller, the name the
    // directory holds (a student cannot appear as the teacher), nothing to
    // publish, and two minutes.
    expect(rtc.issued[before]).toEqual({
      roomName: room(sessionId),
      identity: s1.id,
      displayName: 'مريم',
      capabilities: LISTENER,
      ttlSeconds: 120,
    });

    expect((await call('POST', `/sessions/${sessionId}/join`, host)).body).toMatchObject({
      role: 'moderator',
      media: { microphone: true, screen: false, screenAudio: false },
    });
    expect((await call('POST', `/sessions/${sessionId}/join`, delegate)).body).toMatchObject({
      role: 'moderator',
      media: { microphone: true },
    });
    expect((await call('POST', `/sessions/${sessionId}/join`, teacher)).body).toMatchObject({
      role: 'listener',
      media: { microphone: false },
    });
  });

  it('raises a hand: 201, then 200 with the same hand; lowers it, then answers {request: null}', async () => {
    // A body is no input here either: the hand is the caller's, and pending.
    const first = await call('POST', `/sessions/${sessionId}/hand`, s1, {
      userId: s2.id,
      state: 'granted',
    });
    expect(first.status).toBe(201);
    expect(Object.keys(first.body)).toEqual(['request']);
    const request = first.body.request as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(REQUEST_KEYS);
    expect(request).toEqual({
      id: expect.any(String),
      sessionId,
      userId: s1.id,
      state: 'pending',
      requestedAt: expect.stringMatching(ISO),
      grantedAt: null,
      decidedAt: null,
    });

    const again = await call('POST', `/sessions/${sessionId}/hand`, s1);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(events.filter((event) => event.name === 'live.speaker.requested')).toHaveLength(1);
    expect((await call('GET', `/sessions/${sessionId}`, s1)).body).toMatchObject({
      me: { hand: { requestId: request.id, state: 'pending' } },
    });

    const lowered = await call('DELETE', `/sessions/${sessionId}/hand`, s1);
    expect(lowered.status).toBe(200);
    expect(lowered.body).toEqual({
      request: { ...request, state: 'withdrawn', decidedAt: expect.stringMatching(ISO) },
    });
    const nothing = await call('DELETE', `/sessions/${sessionId}/hand`, s1);
    expect(nothing.status).toBe(200);
    expect(nothing.body).toEqual({ request: null });
  });

  it('pages the queue for moderators: first come first served, named from the directory', async () => {
    const raised: Hand[] = [];
    for (const student of [s1, s2, s3]) {
      const response = await call('POST', `/sessions/${sessionId}/hand`, student);
      expect(response.status).toBe(201);
      raised.push(response.body.request as Hand);
    }
    const queue = [...raised].sort(firstComeFirstServed);
    const names = new Map([
      [s1.id, 'مريم'],
      [s2.id, 'زينب'],
      [s3.id, 'رقية'],
    ]);
    const onPage = (hand: Hand) => ({ ...hand, displayName: names.get(hand.userId) });

    const first = await call('GET', `/sessions/${sessionId}/hands?limit=2`, host);
    expect(first.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual(['items', 'nextCursor']);
    expect(first.body.items).toEqual(queue.slice(0, 2).map(onPage));
    for (const hand of first.body.items as Hand[]) {
      expect(Object.keys(hand).sort()).toEqual([...REQUEST_KEYS, 'displayName'].sort());
    }
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const rest = await call(
      'GET',
      `/sessions/${sessionId}/hands?state=pending&limit=2&cursor=${encodeURIComponent(
        first.body.nextCursor as string,
      )}`,
      delegate,
    );
    expect(rest.status).toBe(200);
    expect(rest.body).toEqual({ items: queue.slice(2).map(onPage), nextCursor: null });
    // The default page holds the whole queue.
    expect(await pendingHands()).toEqual(queue.map(onPage));
    expect((await call('GET', `/sessions/${sessionId}/hands?state=granted`, host)).body).toEqual({
      items: [],
      nextCursor: null,
    });

    // The query is bounded at the edge; a cursor this API did not issue is refused.
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=ten',
      'state=revoked',
      'state=pending&sort=newest',
    ]) {
      const status = (await call('GET', `/sessions/${sessionId}/hands?${query}`, host)).status;
      expect({ query, status }).toEqual({ query, status: 400 });
    }
    expect(refusal(await call('GET', `/sessions/${sessionId}/hands?cursor=forged`, host))).toEqual({
      status: 422,
      code: 'live.cursor_invalid',
    });

    // Moderators only.
    expect(refusal(await call('GET', `/sessions/${sessionId}/hands`, teacher))).toEqual({
      status: 403,
      code: 'live.not_a_moderator',
    });
  });

  it('answers anyone without standing exactly as if nothing existed — an all-permission OWNER included — and changes nothing', async () => {
    const [hand] = await pendingHands();
    const before = (await call('GET', `/sessions/${sessionId}`, host)).body;
    const unchanged = {
      providerCalls: rtc.calls.length,
      audits: audits().length,
      events: events.length,
    };

    const expected = [
      'live.community_not_found',
      'live.community_not_found',
      ...Array<string>(6).fill('live.session_not_found'),
      ...Array<string>(3).fill('live.request_not_found'),
      ...Array<string>(2).fill('live.session_not_found'),
    ];
    const unknown = liveRoutes(UNKNOWN_COMMUNITY, UNKNOWN_SESSION, UNKNOWN_REQUEST);
    const answers: Array<Record<string, unknown>> = [];
    for (const [index, [method, path]] of liveRoutes(communityId, sessionId, hand.id).entries()) {
      // The institution's OWNER holds every permission, and no standing here.
      const seen = await call(method, path, r.owner);
      const missing = await call(method, unknown[index][1], r.owner);
      answers.push({
        route: `${method} ${unknown[index][1]}`,
        ...refusal(seen),
        identical: withoutRequestId(seen) === withoutRequestId(missing),
      });
    }
    expect(answers).toEqual(
      expected.map((notFound, index) => ({
        route: `${unknown[index][0]} ${unknown[index][1]}`,
        status: 404,
        code: notFound,
        identical: true,
      })),
    );

    // A student who is not a member, on every route a student may call.
    for (const index of [1, 2, 3, 5, 6, 12]) {
      const [method, path] = liveRoutes(communityId, sessionId, hand.id)[index];
      const seen = await call(method, path, outsider);
      const missing = await call(method, unknown[index][1], outsider);
      expect({ route: `${method} ${path}`, ...refusal(seen) }).toEqual({
        route: `${method} ${path}`,
        status: 404,
        code: expected[index],
      });
      expect(withoutRequestId(seen)).toBe(withoutRequestId(missing));
    }

    // Nothing moved: no provider call, no audit entry, no event.
    expect((await call('GET', `/sessions/${sessionId}`, host)).body).toEqual(before);
    expect({
      providerCalls: rtc.calls.length,
      audits: audits().length,
      events: events.length,
    }).toEqual(unchanged);
  });

  it('gives, refuses and takes back the floor — a moderator of this session only, each act once', async () => {
    const queue = await pendingHands();
    const [first, second, third] = [handOf(queue, s1), handOf(queue, s2), handOf(queue, s3)];
    expect(refusal(await call('POST', `/requests/${first.id}/grant`, teacher))).toEqual({
      status: 403,
      code: 'live.not_a_moderator',
    });

    const granted = await call('POST', `/requests/${first.id}/grant`, host, undefined, {
      'x-request-id': 'live-grant-1',
    });
    expect(granted.status).toBe(200);
    expect(Object.keys(granted.body).sort()).toEqual(['media', 'request']);
    const { displayName: _name, ...asked } = first;
    expect(granted.body).toEqual({
      request: {
        ...asked,
        state: 'granted',
        grantedAt: expect.stringMatching(ISO),
        decidedAt: expect.stringMatching(ISO),
      },
      // Nobody is connected to the fake's room: the next join carries the microphone.
      media: 'not_connected',
    });
    const repeat = await call('POST', `/requests/${first.id}/grant`, host);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual({ request: granted.body.request, media: 'unchanged' });

    // The speaker comes back in with the microphone: the server's decision.
    expect((await call('POST', `/sessions/${sessionId}/join`, s1)).body).toMatchObject({
      role: 'speaker',
      media: { microphone: true, screen: false, screenAudio: false },
    });
    expect(
      (await call('GET', `/sessions/${sessionId}/hands?state=granted`, delegate)).body,
    ).toEqual({
      items: [{ ...(granted.body.request as object), displayName: 'مريم', media: 'not_connected' }],
      nextCursor: null,
    });

    const declined = await call('POST', `/requests/${second.id}/decline`, delegate);
    expect(declined.status).toBe(200);
    expect(Object.keys(declined.body)).toEqual(['request']);
    expect(declined.body.request).toMatchObject({ id: second.id, state: 'declined' });
    expect((await call('POST', `/requests/${second.id}/decline`, delegate)).body).toEqual(
      declined.body,
    );

    const revoked = await call('POST', `/requests/${first.id}/revoke`, delegate);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      request: { id: first.id, state: 'revoked' },
      media: 'not_connected',
    });
    expect((await call('POST', `/requests/${first.id}/revoke`, delegate)).body).toMatchObject({
      request: { state: 'revoked' },
      media: 'unchanged',
    });

    // A decision taken is not taken again the other way.
    expect(refusal(await call('POST', `/requests/${first.id}/decline`, host))).toEqual({
      status: 409,
      code: 'live.invalid_transition',
    });
    expect(refusal(await call('POST', `/requests/${second.id}/grant`, host))).toEqual({
      status: 409,
      code: 'live.invalid_transition',
    });
    expect(refusal(await call('POST', `/requests/${third.id}/revoke`, host))).toEqual({
      status: 409,
      code: 'live.invalid_transition',
    });

    // One audit entry per act, with the permit it ran on and the request's
    // correlation id — which the event carries too.
    expect(audits('live.speaker.granted')).toMatchObject([
      {
        actorUserId: host.id,
        correlationId: 'live-grant-1',
        metadata: {
          communityId,
          targetUserId: s1.id,
          requestId: first.id,
          media: 'not_connected',
          permit: { act: 'community.live.moderate', basis: 'owner' },
        },
      },
    ]);
    expect(audits('live.speaker.declined')).toMatchObject([
      {
        actorUserId: delegate.id,
        metadata: { permit: { basis: 'grant', grantId: expect.any(String) } },
      },
    ]);
    expect(audits('live.speaker.revoked')).toHaveLength(1);
    expect(
      events
        .filter((event) => event.name === 'live.speaker.granted')
        .map((event) => event.correlationId),
    ).toEqual(['live-grant-1']);
  });

  it('holds the floor to four speakers — and a grant the provider cannot take yet still stands', async () => {
    for (const student of [s1, s2, s4, s5]) {
      expect((await call('POST', `/sessions/${sessionId}/hand`, student)).status).toBe(201);
    }
    const queue = await pendingHands();
    expect(queue).toEqual([...queue].sort(firstComeFirstServed));
    expect(queue.map((hand) => hand.userId).sort()).toEqual(
      [s1.id, s2.id, s3.id, s4.id, s5.id].sort(),
    );
    for (const student of [s1, s2, s3]) {
      expect(
        (await call('POST', `/requests/${handOf(queue, student).id}/grant`, host)).status,
      ).toBe(200);
    }
    // The provider cannot be reached: the grant commits all the same, and says
    // the media plane has yet to follow.
    rtc.failNext('updateCapabilities', 'unavailable');
    const fourth = await call('POST', `/requests/${handOf(queue, s4).id}/grant`, host);
    expect(fourth.status).toBe(200);
    expect(fourth.body).toMatchObject({ request: { state: 'granted' }, media: 'pending' });

    expect(refusal(await call('POST', `/requests/${handOf(queue, s5).id}/grant`, host))).toEqual({
      status: 412,
      code: 'live.speaker_slots_full',
    });
    expect((await call('GET', `/sessions/${sessionId}`, s1)).body).toMatchObject({
      speakerCount: 4,
      me: { role: 'speaker', hand: { state: 'granted' } },
    });
  });

  it('refuses the floor to someone who may no longer take part — who may still lower their own hand', async () => {
    const waiting = handOf(await pendingHands(), s5);
    const speakers = (await call('GET', `/sessions/${sessionId}/hands?state=granted`, host)).body
      .items as Hand[];

    await r.removeFromCommunity(host, communityId, s5.id);
    // A slot is freed, so only eligibility stands in the way.
    expect((await call('POST', `/requests/${handOf(speakers, s4).id}/revoke`, host)).status).toBe(
      200,
    );
    expect(refusal(await call('POST', `/requests/${waiting.id}/grant`, host))).toEqual({
      status: 412,
      code: 'live.target_not_eligible',
    });

    // No longer a member: the session is not theirs to see…
    expect(refusal(await call('GET', `/sessions/${sessionId}`, s5))).toEqual({
      status: 404,
      code: 'live.session_not_found',
    });
    // …but their own hand is still theirs to put down: that only reduces privilege.
    expect((await call('DELETE', `/sessions/${sessionId}/hand`, s5)).body).toMatchObject({
      request: { id: waiting.id, state: 'withdrawn' },
    });
  });

  it('lends the screen to one moderator at a time, for themself — and the host’s grant is the host’s', async () => {
    // A body is no input: the presenter is the caller.
    const claimed = await call('POST', `/sessions/${sessionId}/screen-share`, host, {
      userId: delegate.id,
    });
    expect(claimed.status).toBe(201);
    expect(Object.keys(claimed.body).sort()).toEqual(SESSION_KEYS);
    expect(claimed.body).toMatchObject({
      presenterUserId: host.id,
      me: { presenting: true, canPresent: true },
    });
    const held = await call('POST', `/sessions/${sessionId}/screen-share`, host);
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({
      presenterUserId: host.id,
      stateVersion: claimed.body.stateVersion,
    });

    expect(refusal(await call('POST', `/sessions/${sessionId}/screen-share`, delegate))).toEqual({
      status: 409,
      code: 'live.presenter_slot_taken',
    });
    expect(refusal(await call('DELETE', `/sessions/${sessionId}/screen-share`, delegate))).toEqual({
      status: 403,
      code: 'live.target_is_host',
    });
    expect(refusal(await call('DELETE', `/sessions/${sessionId}/screen-share`, teacher))).toEqual({
      status: 403,
      code: 'live.not_a_moderator',
    });
    // A member who may never moderate is told what a stranger is told.
    expect(refusal(await call('DELETE', `/sessions/${sessionId}/screen-share`, s2))).toEqual({
      status: 404,
      code: 'live.session_not_found',
    });

    const stopped = await call('DELETE', `/sessions/${sessionId}/screen-share`, host);
    expect(stopped.status).toBe(200);
    expect(Object.keys(stopped.body).sort()).toEqual(SESSION_KEYS);
    expect(stopped.body).toMatchObject({ presenterUserId: null, me: { presenting: false } });
    const again = await call('DELETE', `/sessions/${sessionId}/screen-share`, host);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(stopped.body);

    // Another moderator presents, and the host takes the slot back.
    const byDelegate = await call('POST', `/sessions/${sessionId}/screen-share`, delegate);
    expect(byDelegate.status).toBe(201);
    expect(byDelegate.body).toMatchObject({ presenterUserId: delegate.id });
    expect((await call('DELETE', `/sessions/${sessionId}/screen-share`, host)).body).toMatchObject({
      presenterUserId: null,
    });

    // Opening is audited, and taking it back; the host's own stop is not.
    expect(audits('live.screen_share.started')).toHaveLength(2);
    expect(audits('live.screen_share.revoked')).toMatchObject([
      { actorUserId: host.id, metadata: { targetUserId: delegate.id } },
    ]);
  });

  it('lets a moderator present only while identity lets them speak', async () => {
    // No provisional role moderates without `live.speak`; the institution may
    // make one (Q1), so identity is made to answer that way for the delegate.
    const identity = r.api.app.get<AuthorizationService>(AUTHORIZATION_SERVICE, { strict: false });
    const can = identity.can.bind(identity);
    const spy = jest
      .spyOn(identity, 'can')
      .mockImplementation((principal, permission, context) =>
        permission === 'live.speak' && principal.userId === delegate.id
          ? false
          : can(principal, permission, context),
      );
    try {
      expect(refusal(await call('POST', `/sessions/${sessionId}/screen-share`, delegate))).toEqual({
        status: 403,
        code: 'live.presenter_not_permitted',
      });
      expect((await call('GET', `/sessions/${sessionId}`, delegate)).body).toMatchObject({
        me: { role: 'moderator', canPresent: false },
      });
      expect((await call('POST', `/sessions/${sessionId}/join`, delegate)).body).toMatchObject({
        role: 'moderator',
        media: { microphone: false },
      });
    } finally {
      spy.mockRestore();
    }
  });

  let otherSessionId: string;

  it('keeps the host’s own hand the host’s: a delegated moderator never decides it', async () => {
    const started = await call('POST', `/communities/${otherCommunityId}/sessions`, admin);
    expect(started.status).toBe(201);
    otherSessionId = started.body.id as string;
    // A host who holds `live.raise_hand` (an ADMIN here) asks for the floor in their own session.
    const raised = await call('POST', `/sessions/${otherSessionId}/hand`, admin);
    expect(raised.status).toBe(201);
    const requestId = (raised.body.request as { id: string }).id;
    for (const act of ['grant', 'decline']) {
      expect(refusal(await call('POST', `/requests/${requestId}/${act}`, delegate))).toEqual({
        status: 403,
        code: 'live.target_is_host',
      });
    }
    expect((await call('POST', `/requests/${requestId}/grant`, admin)).body).toMatchObject({
      request: { state: 'granted' },
    });
    expect(refusal(await call('POST', `/requests/${requestId}/revoke`, delegate))).toEqual({
      status: 403,
      code: 'live.target_is_host',
    });
  });

  it('turns a listener away from a full session — never a moderator, whose seats are the reserve', async () => {
    const participant = (identity: string): RtcParticipantObservation => ({
      identity,
      state: 'active',
      standard: true,
      joinedAt: new Date(),
      publishing: [],
      capabilities: LISTENER,
    });
    // The room already holds the session's 300: the cap.
    rtc.observe(
      room(otherSessionId),
      Array.from({ length: 300 }, (_, index) => participant(`listener-${index}`)),
    );
    expect(refusal(await call('POST', `/sessions/${otherSessionId}/join`, s1))).toEqual({
      status: 412,
      code: 'live.session_full',
    });
    expect((await call('POST', `/sessions/${otherSessionId}/join`, delegate)).body).toMatchObject({
      role: 'moderator',
    });
    expect((await call('POST', `/sessions/${otherSessionId}/join`, admin)).body).toMatchObject({
      role: 'moderator',
      media: { microphone: true },
    });
  });

  let lockedHandId: string;

  it('keeps a running session going while its community is locked: a start answers it, members join and raise', async () => {
    await r.setCommunityLocked(host, communityId, true);
    try {
      const retried = await call('POST', `/communities/${communityId}/sessions`, host);
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ id: sessionId, state: 'live' });
      expect((await call('POST', `/sessions/${sessionId}/join`, s3)).body).toMatchObject({
        role: 'speaker',
      });
      const raised = await call('POST', `/sessions/${sessionId}/hand`, s4);
      expect(raised.status).toBe(201);
      lockedHandId = (raised.body.request as { id: string }).id;
    } finally {
      await r.setCommunityLocked(host, communityId, false);
    }
  });

  it('ends the session — any of its moderators may — closing every hand and the screen with it; a repeat changes nothing', async () => {
    expect(refusal(await call('POST', `/sessions/${sessionId}/end`, teacher))).toEqual({
      status: 403,
      code: 'live.not_a_moderator',
    });
    expect(await pendingHands()).toHaveLength(1);

    const ended = await call('POST', `/sessions/${sessionId}/end`, delegate);
    expect(ended.status).toBe(200);
    expect(Object.keys(ended.body).sort()).toEqual(SESSION_KEYS);
    expect(ended.body).toMatchObject({
      id: sessionId,
      state: 'ended',
      endedAt: expect.stringMatching(ISO),
      endReason: 'moderator',
      speakerCount: 0,
      presenterUserId: null,
      me: {
        role: 'moderator',
        canJoin: false,
        canRaiseHand: false,
        canModerate: false,
        canEnd: false,
        canPresent: false,
        hand: null,
      },
      moderation: { pendingHands: 0 },
    });
    const repeat = await call('POST', `/sessions/${sessionId}/end`, host);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({
      state: 'ended',
      stateVersion: ended.body.stateVersion,
      endedAt: ended.body.endedAt,
    });

    // One end: one audit entry, one event — which implies every expiry, so
    // there is no per-hand event — and the room ended once.
    const endedHere = <T extends { resourceId?: unknown; aggregateId?: unknown }>(
      entries: readonly T[],
    ) => entries.filter((entry) => (entry.resourceId ?? entry.aggregateId) === sessionId);
    expect(endedHere(audits('live.session.ended'))).toMatchObject([
      { actorUserId: delegate.id, metadata: { reason: 'moderator', permit: { basis: 'grant' } } },
    ]);
    const endEvents = endedHere(events.filter((event) => event.name === 'live.session.ended'));
    expect(endEvents.map((event) => event.payload)).toEqual([
      {
        sessionId,
        communityId,
        endedBy: delegate.id,
        reason: 'moderator',
        durationSeconds: expect.any(Number),
      },
    ]);
    expect(events.filter((event) => event.name === 'live.speaker.expired')).toEqual([]);
    expect(rtc.ended.filter((name) => name === room(sessionId))).toHaveLength(1);
    expect(await pendingHands()).toEqual([]);
    expect((await call('GET', `/sessions/${sessionId}/hands?state=granted`, host)).body).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('refuses every change to an ended session, and still shows it', async () => {
    for (const [method, path, account] of [
      ['POST', `/sessions/${sessionId}/join`, s3],
      ['POST', `/sessions/${sessionId}/hand`, s4],
      ['POST', `/sessions/${sessionId}/screen-share`, host],
      ['POST', `/requests/${lockedHandId}/grant`, host],
    ] as const) {
      expect({ path, ...refusal(await call(method, path, account)) }).toEqual({
        path,
        status: 412,
        code: 'live.session_not_live',
      });
    }
    // Nothing is up any more, and lowering says so.
    expect((await call('DELETE', `/sessions/${sessionId}/hand`, s4)).body).toEqual({
      request: null,
    });
    expect((await call('GET', `/sessions/${sessionId}`, s2)).body).toMatchObject({
      state: 'ended',
      me: { canJoin: false, canRaiseHand: false },
    });
    expect((await call('GET', `/communities/${communityId}/sessions/current`, s2)).body).toEqual({
      session: null,
    });
  });

  let nextSessionId: string;

  it('starts nothing while the community is locked — not even when the lock lands during the provider call — nor when the media room cannot be made; then a new session', async () => {
    const started = () => ({
      audits: audits('live.session.started').length,
      events: events.filter((event) => event.name === 'live.session.started').length,
    });
    const before = started();

    await r.setCommunityLocked(host, communityId, true);
    try {
      expect(refusal(await call('POST', `/communities/${communityId}/sessions`, host))).toEqual({
        status: 412,
        code: 'live.community_not_open',
      });
    } finally {
      await r.setCommunityLocked(host, communityId, false);
    }

    // The lock commits while Start waits on the media room: Start asks again
    // after it (audit D20), refuses, and ends the room it made.
    const gate = rtc.hold('ensureRoom');
    const starting = call('POST', `/communities/${communityId}/sessions`, host);
    await gate.reached;
    const stray = rtc.calls[rtc.calls.length - 1]?.roomName ?? '';
    await r.setCommunityLocked(host, communityId, true);
    gate.release();
    try {
      expect(refusal(await starting)).toEqual({ status: 412, code: 'live.community_not_open' });
    } finally {
      await r.setCommunityLocked(host, communityId, false);
    }
    expect(stray).toMatch(/^live-[0-9a-f-]{36}$/);
    expect(rtc.ended).toContain(stray);
    expect(rtc.room(stray)).toBeNull();

    rtc.failNext('ensureRoom', 'unavailable');
    const refused = await call('POST', `/communities/${communityId}/sessions`, host);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({
      kind: 'unavailable',
      code: 'live.media_unavailable',
    });
    // Nothing is stored: no session, no audit entry, no event.
    expect((await call('GET', `/communities/${communityId}/sessions/current`, s2)).body).toEqual({
      session: null,
    });
    expect(started()).toEqual(before);

    const restarted = await call('POST', `/communities/${communityId}/sessions`, host);
    expect(restarted.status).toBe(201);
    expect(restarted.body).toMatchObject({ state: 'live', stateVersion: 1, hostUserId: host.id });
    expect(restarted.body.id).not.toBe(sessionId);
    nextSessionId = restarted.body.id as string;
  });

  it('limits starts per person, and joins and raised hands per (session, person) — never per address', async () => {
    const eager = await r.provision('eager', 'TEACHER', 'الأستاذ يحيى');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(code(await call('POST', `/communities/${communityId}/sessions`, eager))).toBe(
        'live.community_not_found',
      );
    }
    const starts = await call('POST', `/communities/${communityId}/sessions`, eager);
    expect(refusal(starts)).toEqual({ status: 429, code: 'live.too_many_starts' });
    expect(Number(starts.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(
      (starts.body.error as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds,
    ).toBeGreaterThan(0);

    // Asked of sessions that do not exist, so nothing else is in play: every
    // attempt counts, found or not.
    const [x, y] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(code(await call('POST', `/sessions/${x}/join`, outsider))).toBe(
        'live.session_not_found',
      );
    }
    expect(refusal(await call('POST', `/sessions/${x}/join`, outsider))).toEqual({
      status: 429,
      code: 'live.too_many_joins',
    });
    // Another session, or another person at the same address, is not held back.
    expect(code(await call('POST', `/sessions/${y}/join`, outsider))).toBe(
      'live.session_not_found',
    );
    expect(code(await call('POST', `/sessions/${x}/join`, s4))).toBe('live.session_not_found');

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(code(await call('POST', `/sessions/${y}/hand`, outsider))).toBe(
        'live.session_not_found',
      );
    }
    expect(refusal(await call('POST', `/sessions/${y}/hand`, outsider))).toEqual({
      status: 429,
      code: 'live.too_many_hands',
    });
  });

  it('answers 503 live.media_unavailable when the provider cannot sign a ticket', async () => {
    rtc.failNext('issueAccessToken', 'unavailable');
    const refused = await call('POST', `/sessions/${nextSessionId}/join`, s2);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({
      kind: 'unavailable',
      code: 'live.media_unavailable',
    });
    expect((await call('POST', `/sessions/${nextSessionId}/join`, s2)).status).toBe(200);
  });

  it('fails closed with 503 unavailable when Communities cannot answer — never a role-only answer', async () => {
    const communities = r.api.app.get<CommunityAuthorization>(COMMUNITY_AUTHORIZATION, {
      strict: false,
    });
    const spy = jest
      .spyOn(communities, 'authorize')
      .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432'));
    try {
      for (const [method, path, account] of [
        ['POST', `/communities/${communityId}/sessions`, host],
        ['GET', `/communities/${communityId}/sessions/current`, s2],
        ['GET', `/sessions/${nextSessionId}`, s2],
        ['POST', `/sessions/${nextSessionId}/join`, s2],
        ['POST', `/sessions/${nextSessionId}/hand`, s2],
        ['POST', `/sessions/${nextSessionId}/screen-share`, host],
        ['POST', `/sessions/${nextSessionId}/end`, host],
      ] as const) {
        const refused = await call(method, path, account);
        expect({ path, status: refused.status, error: refused.body.error }).toEqual({
          path,
          status: 503,
          error: { kind: 'unavailable', code: 'unavailable', message: expect.any(String) },
        });
      }
    } finally {
      spy.mockRestore();
    }
    expect((await call('GET', `/sessions/${nextSessionId}`, host)).body).toMatchObject({
      state: 'live',
      stateVersion: 1,
      presenterUserId: null,
    });
  });

  it('answers 503 unavailable when Live’s store cannot be reached, and 500 for a fault', async () => {
    const sessions = r.api.app.get<LiveSessionRepository>(LIVE_SESSION_REPOSITORY, {
      strict: false,
    });
    const outage = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const spy = jest.spyOn(sessions, 'findById').mockRejectedValueOnce(outage);
    try {
      const refused = await call('GET', `/sessions/${nextSessionId}`, s2);
      expect(refused.status).toBe(503);
      expect(refused.body.error).toMatchObject({ kind: 'unavailable', code: 'unavailable' });
      spy.mockRejectedValueOnce(new TypeError('a bug, not an outage'));
      expect((await call('GET', `/sessions/${nextSessionId}`, s2)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await call('GET', `/sessions/${nextSessionId}`, s2)).status).toBe(200);
  });

  it('reads no body on any route', () => {
    const prototype = LiveController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && typeof prototype[name] === 'function',
    );
    const parameters = (handler: string) =>
      Object.keys(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, LiveController, handler) ?? {}) as object,
      ).map((key) => Number(key.split(':')[0]));
    const bodies: readonly number[] = [RouteParamtypes.BODY, RouteParamtypes.RAW_BODY];
    expect(handlers).toHaveLength(13);
    expect(
      handlers.filter((handler) => parameters(handler).some((type) => bodies.includes(type))),
    ).toEqual([]);
    // Not vacuous: the handlers' parameters are declared there.
    expect(parameters('join')).toContain(RouteParamtypes.PARAM);
    expect(parameters('hands')).toContain(RouteParamtypes.QUERY);
  });

  it('never logs a join ticket, or any other token — in a log line, an audit entry or an event', () => {
    // The capture is not blind: it holds Live's own lines and the audit trail…
    expect(logs.text()).toContain('media provider: fake');
    expect(audits('live.session.started').length).toBeGreaterThanOrEqual(3);
    expect(events.length).toBeGreaterThan(20);
    // …tickets were issued, and the scan finds a token of either kind wherever it is.
    expect(tickets.length).toBeGreaterThanOrEqual(10);
    for (const token of tickets) expect(credentialsIn(`{"token":"${token}"}`)).toEqual([token]);
    expect(credentialsIn(`Bearer ${host.token}`)).toEqual([host.token]);

    expect(credentialsIn(logs.text())).toEqual([]);
    expect(credentialsIn(serialize(events))).toEqual([]);
  });

  it('never answers with an email, and carries a credential in a join ticket only', () => {
    expect(transcript.length).toBeGreaterThan(150);
    for (const { route, raw } of transcript) {
      expect({ route, email: raw.includes('@') }).toEqual({ route, email: false });
      if (!route.endsWith('/join')) {
        expect({ route, credentials: credentialsIn(raw) }).toEqual({ route, credentials: [] });
      }
    }
  });
});
