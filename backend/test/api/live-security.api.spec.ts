import { randomUUID } from 'node:crypto';

import {
  EVENT_SUBSCRIBER,
  RATE_LIMITER,
  type DomainEvent,
  type EventSubscriber,
  type RateLimiter,
} from '../../src/shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
} from '../../src/modules/communities/contracts/authorization';
import { CommunityEvents } from '../../src/modules/communities/contracts/events';
import { JoinLiveSessionUseCase } from '../../src/modules/live/application/join-live-session.use-case';
import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import { ProtectLiveSessions } from '../../src/modules/live/application/protect-live-sessions';
import { RaiseHandUseCase } from '../../src/modules/live/application/raise-hand.use-case';
import { StartLiveSessionUseCase } from '../../src/modules/live/application/start-live-session.use-case';
import { LiveEvents } from '../../src/modules/live/contracts';
import type { ModerationActionId } from '../../src/modules/live/domain/moderation';
import {
  LIVE_SESSION_REPOSITORY,
  type LiveSessionRepository,
} from '../../src/modules/live/domain/ports';
import {
  RTC_PROVIDER,
  type RtcAccessGrant,
  type RtcCapabilities,
} from '../../src/modules/live/domain/rtc-provider';
import type { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import {
  LiveKitRtcProvider,
  type LiveKitRoomService,
} from '../../src/modules/live/infrastructure/livekit-rtc-provider';
import type { AppConfig } from '../../src/platform/config/app-config';
import type { CallMetadata } from '../../src/shared';
import type { ApiResponse } from '../support/api-client';
import { LogCapture, credentialsIn, serialize } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import type { TestSocket } from '../support/realtime-client';

/** Ids no community, session or request has — "does not exist". */
const UNKNOWN_COMMUNITY = '00000000-0000-4000-8000-00000000c0de';
const UNKNOWN_SESSION = '00000000-0000-4000-8000-00000000abcd';
const UNKNOWN_REQUEST = '00000000-0000-4000-8000-00000000beef';

/** The secrets this deployment holds: none may appear anywhere a scenario writes to. */
const LIVEKIT_SECRET = 'development-only-secret';
const JWT_SECRET = 'api-test-secret-that-is-at-least-32-bytes';

/** Two addresses a reverse proxy forwards: one shared by two people, and another. */
const SHARED_ADDRESS = '203.0.113.7';
const OTHER_ADDRESS = '198.51.100.23';

/** The capability sets of the four roles — every flag explicit, nothing implied. */
const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};
const SPEAKER: RtcCapabilities = { ...LISTENER, canPublishAudio: true };
const PRESENTER: RtcCapabilities = { ...SPEAKER, canPublishScreen: true };

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
 * The LiveKit adapter signing a grant — offline: signing a token calls no
 * server, and the room service is never reached.
 */
const livekit = new LiveKitRtcProvider(
  {
    livekit: {
      url: 'wss://media.security.test',
      apiKey: 'APIsecurityspec',
      apiSecret: 'a-security-spec-secret-long-enough-for-hs256',
    },
  } as unknown as AppConfig,
  {} as LiveKitRoomService,
);

/** A JWT's claims, read without verifying: the test inspects what was signed. */
function claimsOf(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Live's security properties over HTTP, as the application runs without a
 * database or media credentials — the real guards, filter and wiring, the
 * in-memory store, the fake media provider, the real Communities, real
 * sockets — behind a reverse proxy (`TRUST_PROXY=1`), so a caller's address
 * reaches Live as it would in production (P6 audit §13; plan, commit F):
 *
 *   - each role's join token, claim by claim: the fake's recorded grant, and
 *     the same grant signed by the LiveKit adapter and decoded;
 *   - one indistinguishable 404 for unknown and not visible on every route
 *     that takes an id, the community-scoped ones included;
 *   - `DELETE …/hand` reveals nothing to a caller with no open hand who may
 *     not see the session;
 *   - rate limits keyed per person, or per (session, person) — never by
 *     address;
 *   - and, last, no token or secret in anything the scenario produced: every
 *     log line (the audit trail included), every event on the bus, every
 *     frame on every socket, every error body — scanned for the value,
 *     whatever key it sits under.
 */
describe('live security', () => {
  const logs = new LogCapture();
  const events: DomainEvent[] = [];
  /** Every live response, with the route that gave it. */
  const transcript: Array<{
    readonly route: string;
    readonly status: number;
    readonly raw: string;
  }> = [];
  /** Every join ticket's token, as issued. */
  const tickets: string[] = [];
  const sockets: TestSocket[] = [];

  let r: RealtimeApi;
  let rtc: FakeRtcProvider;
  let sessions: LiveSessionRepository;
  let admin: Account;
  let host: Account;
  let delegate: Account;
  let s1: Account;
  let s2: Account;
  let s3: Account;
  let outsider: Account;
  /** A TEACHER who moderates another community — and has no standing in this one. */
  let stranger: Account;
  let communityId: string;
  /** A community with nothing running, of which the outsider and the stranger are not members. */
  let idleCommunityId: string;
  let otherCommunityId: string;
  let sessionId: string;

  beforeAll(async () => {
    r = await startRealtimeApi(
      {
        LIVEKIT_API_SECRET: LIVEKIT_SECRET,
        LIVE_MEDIA_PROVIDER: '',
        LIVE_ROOM_NAME_PREFIX: '',
        TRUST_PROXY: '1',
      },
      { logger: logs },
    );
    rtc = r.api.app.get<FakeRtcProvider>(RTC_PROVIDER, { strict: false });
    sessions = r.api.app.get<LiveSessionRepository>(LIVE_SESSION_REPOSITORY, { strict: false });
    // The reconciler's timers would race what each test counts on the fake;
    // ProtectLiveSessions stays subscribed, so a removal acts at once.
    await r.api.app.get(LiveReconciler, { strict: false }).stop();
    const bus = r.api.app.get<EventSubscriber>(EVENT_SUBSCRIBER, { strict: false });
    for (const name of [...Object.values(LiveEvents), ...Object.values(CommunityEvents)]) {
      bus.subscribe(name, (event) => {
        events.push(event);
      });
    }

    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    host = await r.provision('host', 'TEACHER', 'الأستاذة عائشة');
    delegate = await r.provision('delegate', 'TEACHER', 'الأستاذة سودة');
    s1 = await r.provision('s1', 'STUDENT', 'مريم');
    s2 = await r.provision('s2', 'STUDENT', 'زينب');
    s3 = await r.provision('s3', 'STUDENT', 'رقية');
    outsider = await r.provision('outsider', 'STUDENT', 'أسماء');
    stranger = await r.provision('stranger', 'TEACHER', 'الأستاذة حفصة');

    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [host, delegate, s1, s2, s3]);
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
    await r.grantCapabilities(host, communityId, delegate.id, ['community.live.moderate']);

    idleCommunityId = await r.createCommunity(admin, 'حلقة الضحى');
    otherCommunityId = await r.createCommunity(admin, 'حلقة الفجر');
    await r.addToCommunity(admin, otherCommunityId, [stranger]);
    await r.grantCapabilities(admin, otherCommunityId, stranger.id, [
      'community.live.start',
      'community.live.moderate',
    ]);

    for (const account of [host, delegate, s1, s2, s3, outsider, stranger]) {
      sockets.push(await r.connect(account));
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all(sockets.map((socket) => socket.close()));
    await r.close();
  });

  async function expectStatus(response: Promise<ApiResponse>, status: number): Promise<void> {
    const answered = await response;
    if (answered.status !== status) throw new Error(`${answered.status}: ${answered.raw}`);
  }

  async function call(
    method: string,
    path: string,
    account: Account,
    from: string = SHARED_ADDRESS,
  ): Promise<ApiResponse> {
    const response = await r.api.call(method, `/live${path}`, {
      token: account.token,
      headers: { 'x-forwarded-for': from },
    });
    transcript.push({ route: `${method} ${path}`, status: response.status, raw: response.raw });
    if (path.endsWith('/join') && response.status === 200) {
      tickets.push(response.body.token as string);
    }
    return response;
  }

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;
  const refusal = (response: ApiResponse) => ({ status: response.status, code: code(response) });

  /**
   * What a caller can tell a response by: its status, its body with the
   * request's own id removed, and which headers it carries.
   */
  const observable = (response: ApiResponse) => {
    const { requestId: _ignored, ...body } = response.body;
    const headers = [...response.headers.keys()].sort();
    return JSON.stringify({ status: response.status, body, headers });
  };

  const room = (id: string, epoch = 0) => (epoch === 0 ? `live-${id}` : `live-${id}.${epoch}`);

  const audits = (): Array<Record<string, unknown>> =>
    logs
      .logged()
      .map(([first]) => first)
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>).audit === true,
      );

  /** The grant the fake recorded for `account`'s latest ticket. */
  const lastGrantOf = (account: Account): RtcAccessGrant => {
    const grants = rtc.issued.filter((grant) => grant.identity === account.id);
    const grant = grants[grants.length - 1];
    if (grant === undefined) throw new Error(`no ticket for ${account.email}`);
    return grant;
  };

  describe('the join token', () => {
    it('is minted per role for the session’s room alone: the user id, the directory’s name, an explicit capability set, 120 seconds — and nothing else', async () => {
      const started = await call('POST', `/communities/${communityId}/sessions`, host);
      expect(started.status).toBe(201);
      sessionId = started.body.id as string;

      // A listener; a granted speaker; the host, a moderator publishing by
      // right; a moderator presenting her screen.
      expect((await call('POST', `/sessions/${sessionId}/join`, s1)).status).toBe(200);
      const raised = await call('POST', `/sessions/${sessionId}/hand`, s2);
      expect(raised.status).toBe(201);
      const handId = (raised.body.request as { id: string }).id;
      expect((await call('POST', `/requests/${handId}/grant`, host)).status).toBe(200);
      expect((await call('POST', `/sessions/${sessionId}/screen-share`, delegate)).status).toBe(
        201,
      );

      const roles = [
        { account: s1, name: 'مريم', role: 'listener', capabilities: LISTENER, sources: [] },
        {
          account: s2,
          name: 'زينب',
          role: 'speaker',
          capabilities: SPEAKER,
          sources: ['microphone'],
        },
        {
          account: host,
          name: 'الأستاذة عائشة',
          role: 'moderator',
          capabilities: SPEAKER,
          sources: ['microphone'],
        },
        {
          account: delegate,
          name: 'الأستاذة سودة',
          role: 'moderator',
          capabilities: PRESENTER,
          sources: ['microphone', 'screen_share'],
        },
      ] as const;

      for (const { account, name, role, capabilities, sources } of roles) {
        const ticket = await call('POST', `/sessions/${sessionId}/join`, account);
        expect({ role, status: ticket.status, body: ticket.body }).toEqual({
          role,
          status: 200,
          body: {
            token: `fake.${room(sessionId)}.${account.id}.${sources.length > 0 ? 'pub' : 'sub'}`,
            url: 'ws://fake-rtc.local',
            expiresInSeconds: 120,
            role,
            media: {
              microphone: capabilities.canPublishAudio,
              screen: capabilities.canPublishScreen,
              screenAudio: capabilities.canPublishScreenAudio,
            },
          },
        });

        // The grant, exactly: no field more — a client's wish has no way in.
        const grant = lastGrantOf(account);
        expect({ role, grant }).toStrictEqual({
          role,
          grant: {
            roomName: room(sessionId),
            identity: account.id,
            displayName: name,
            capabilities,
            ttlSeconds: 120,
          },
        });

        // The same grant, signed as real media would sign it, decoded: one
        // room, the user id, the name, an explicit source list, no data, not
        // hidden, no administrative right, no metadata, two minutes.
        const claims = claimsOf((await livekit.issueAccessToken(grant)).token);
        expect({ role, claims }).toStrictEqual({
          role,
          claims: {
            iss: 'APIsecurityspec',
            sub: account.id,
            name,
            nbf: expect.any(Number) as number,
            exp: expect.any(Number) as number,
            video: {
              room: room(sessionId),
              roomJoin: true,
              canPublish: sources.length > 0,
              canPublishSources: [...sources],
              canSubscribe: true,
              canPublishData: false,
              canUpdateOwnMetadata: false,
              hidden: false,
            },
          },
        });
        expect((claims.exp as number) - (claims.nbf as number)).toBe(120);
      }
    });

    it('names the session’s CURRENT room once the media was reset — never the room the reset left behind', async () => {
      // The reconciler's reset (§11.4), as it commits: the epoch moves on.
      const reset = await sessions.bumpEpoch(sessionId, 0, {
        id: randomUUID() as ModerationActionId,
        sessionId,
        actorUserId: null,
        targetUserId: null,
        type: 'reset_media',
        at: new Date(),
      });
      expect(reset?.mediaRoomEpoch).toBe(1);
      const issuedBefore = rtc.issued.length;

      for (const account of [s1, s2, host, delegate]) {
        const ticket = await call('POST', `/sessions/${sessionId}/join`, account);
        expect(ticket.status).toBe(200);
        expect(ticket.body.token as string).toMatch(
          new RegExp(`^fake\\.${room(sessionId, 1).replace(/\./g, '\\.')}\\.${account.id}\\.`),
        );
        expect(lastGrantOf(account).roomName).toBe(room(sessionId, 1));
      }
      expect(rtc.issued.slice(issuedBefore).map((grant) => grant.roomName)).toEqual(
        Array<string>(4).fill(room(sessionId, 1)),
      );
    });
  });

  describe('what a caller without standing can tell', () => {
    it('answers a non-member exactly as an unknown id on every route that takes one — a moderator of another community included — and changes nothing', async () => {
      const raised = await call('POST', `/sessions/${sessionId}/hand`, s3);
      expect(raised.status).toBe(201);
      const handId = (raised.body.request as { id: string }).id;

      const before = (await call('GET', `/sessions/${sessionId}`, host)).body;
      const unchanged = () => ({
        providerCalls: rtc.calls.length,
        audits: audits().length,
        events: events.length,
      });
      const baseline = unchanged();

      const known = liveRoutes(communityId, sessionId, handId);
      const unknown = liveRoutes(UNKNOWN_COMMUNITY, UNKNOWN_SESSION, UNKNOWN_REQUEST);
      const seenBy = async (account: Account) => {
        const answers: Array<Record<string, unknown>> = [];
        for (const [index, [method, path]] of known.entries()) {
          const seen = await call(method, path, account);
          const missing = await call(method, unknown[index][1], account);
          answers.push({
            route: `${method} ${unknown[index][1]}`,
            ...refusal(seen),
            identical: observable(seen) === observable(missing),
          });
        }
        return answers;
      };
      const expected = (codes: ReadonlyArray<readonly [number, string]>) =>
        codes.map(([status, notFound], index) => ({
          route: `${unknown[index][0]} ${unknown[index][1]}`,
          status,
          code: notFound,
          identical: true,
        }));
      const ceiling = [403, 'identity.permission_denied'] as const;
      const community = [404, 'live.community_not_found'] as const;
      const session = [404, 'live.session_not_found'] as const;
      const request = [404, 'live.request_not_found'] as const;

      // A teacher who moderates elsewhere holds every ceiling a moderator
      // does, so each route reads — and still finds nothing to tell.
      expect(await seenBy(stranger)).toEqual(
        expected([
          community,
          community,
          session,
          session,
          session,
          ceiling, // a teacher does not raise a hand
          session,
          session,
          request,
          request,
          request,
          session,
          session,
        ]),
      );
      // A student who is not a member: refused at the ceiling where a student
      // may not go, before anything is read — identically either way.
      expect(await seenBy(outsider)).toEqual(
        expected([
          ceiling,
          community,
          session,
          session,
          ceiling,
          session,
          session,
          ceiling,
          ceiling,
          ceiling,
          ceiling,
          ceiling,
          session,
        ]),
      );

      // The community-scoped routes cannot tell a community that runs a
      // session from one that runs none, or from one that does not exist.
      for (const account of [stranger, outsider]) {
        for (const [method, suffix] of [
          ['GET', '/sessions/current'],
          ['POST', '/sessions'],
        ] as const) {
          const running = await call(method, `/communities/${communityId}${suffix}`, account);
          const idle = await call(method, `/communities/${idleCommunityId}${suffix}`, account);
          const missing = await call(method, `/communities/${UNKNOWN_COMMUNITY}${suffix}`, account);
          expect({ account: account.email, method, status: running.status }).toEqual({
            account: account.email,
            method,
            status: account === stranger || method === 'GET' ? 404 : 403,
          });
          expect(observable(running)).toBe(observable(missing));
          expect(observable(idle)).toBe(observable(missing));
        }
      }
      // …and a start there started nothing.
      expect(
        (await call('GET', `/communities/${idleCommunityId}/sessions/current`, admin)).body,
      ).toEqual({ session: null });

      // Nothing moved: no provider call, no audit entry, no event.
      expect((await call('GET', `/sessions/${sessionId}`, host)).body).toEqual(before);
      expect(unchanged()).toEqual(baseline);
    });

    it('answers `DELETE …/hand` from a caller with no open hand who may not see the session as if it did not exist', async () => {
      const protect = r.api.app.get(ProtectLiveSessions, { strict: false });
      const [s3Hand] = (
        (await call('GET', `/sessions/${sessionId}/hands`, host)).body.items as Array<{
          id: string;
          userId: string;
        }>
      ).filter((hand) => hand.userId === s3.id);
      expect((await call('POST', `/requests/${s3Hand.id}/decline`, host)).status).toBe(200);

      // s3 once asked for the floor and was declined; s2 held it. Both are
      // removed, and the removal closes whatever they still held.
      await r.removeFromCommunity(host, communityId, s3.id);
      await r.removeFromCommunity(host, communityId, s2.id);
      await protect.idle();
      expect(
        (
          (await call('GET', `/sessions/${sessionId}/hands?state=granted`, host)).body
            .items as unknown[]
        ).length,
      ).toBe(0);

      for (const account of [s3, s2, outsider, stranger]) {
        const lowered = await call('DELETE', `/sessions/${sessionId}/hand`, account);
        const missing = await call('DELETE', `/sessions/${UNKNOWN_SESSION}/hand`, account);
        expect({ account: account.email, ...refusal(lowered) }).toEqual({
          account: account.email,
          status: 404,
          code: 'live.session_not_found',
        });
        expect(observable(lowered)).toBe(observable(missing));
      }
      // Not vacuous: a member with no open hand, who may see the session, is told so.
      const member = await call('DELETE', `/sessions/${sessionId}/hand`, s1);
      expect({ status: member.status, body: member.body }).toEqual({
        status: 200,
        body: { request: null },
      });
    });

    it('answers a non-member exactly as an unknown id once the session has ended, too', async () => {
      expect((await call('POST', `/sessions/${sessionId}/end`, host)).status).toBe(200);
      const unknown = liveRoutes(UNKNOWN_COMMUNITY, UNKNOWN_SESSION, UNKNOWN_REQUEST);
      for (const account of [stranger, outsider, s3]) {
        for (const [index, [method, path]] of liveRoutes(
          communityId,
          sessionId,
          UNKNOWN_REQUEST,
        ).entries()) {
          // The start route and the request routes are asked above.
          if (index === 0 || (index >= 8 && index <= 10)) continue;
          const seen = await call(method, path, account);
          const missing = await call(method, unknown[index][1], account);
          expect({
            account: account.email,
            route: `${method} ${path}`,
            status: seen.status,
          }).toEqual({
            account: account.email,
            route: `${method} ${path}`,
            status: seen.status === 403 ? 403 : 404,
          });
          expect({ route: `${method} ${path}`, answer: observable(seen) }).toEqual({
            route: `${method} ${path}`,
            answer: observable(missing),
          });
        }
      }
      // A member still sees the ended session.
      expect((await call('GET', `/sessions/${sessionId}`, s1)).body).toMatchObject({
        id: sessionId,
        state: 'ended',
      });
    });
  });

  describe('rate limits', () => {
    it('keys starts per person, and joins and raised hands per (session, person) — never by address', async () => {
      const limiter = r.api.app.get<RateLimiter>(RATE_LIMITER, { strict: false });
      const consume = jest.spyOn(limiter, 'consume');
      const metas: CallMetadata[] = [];
      const spies = [StartLiveSessionUseCase, JoinLiveSessionUseCase, RaiseHandUseCase].map(
        (useCase) => {
          const instance = r.api.app.get(useCase, { strict: false });
          const execute = instance.execute.bind(instance) as (command: {
            meta: CallMetadata;
          }) => Promise<unknown>;
          return jest
            .spyOn(instance, 'execute')
            .mockImplementation((command: { meta: CallMetadata }) => {
              metas.push(command.meta);
              return execute(command) as never;
            });
        },
      );
      try {
        const [teacherA, teacherB] = [
          await r.provision('teacher-a', 'TEACHER', 'الأستاذ يحيى'),
          await r.provision('teacher-b', 'TEACHER', 'الأستاذ زكريا'),
        ];
        const [studentA, studentB] = [
          await r.provision('student-a', 'STUDENT', 'فاطمة'),
          await r.provision('student-b', 'STUDENT', 'أمامة'),
        ];
        const x = '00000000-0000-4000-8000-0000000000a1';

        // Each limit, spent by one person at the shared address. The same
        // person from another address is still held back; another person at
        // the shared address is not.
        for (const [path, first, second, limit, refused] of [
          [
            `/communities/${UNKNOWN_COMMUNITY}/sessions`,
            teacherA,
            teacherB,
            10,
            'live.too_many_starts',
          ],
          [`/sessions/${x}/join`, studentA, studentB, 10, 'live.too_many_joins'],
          [`/sessions/${x}/hand`, studentA, studentB, 6, 'live.too_many_hands'],
        ] as const) {
          for (let attempt = 0; attempt < limit; attempt += 1) {
            expect((await call('POST', path, first, SHARED_ADDRESS)).status).toBe(404);
          }
          expect(refusal(await call('POST', path, first, OTHER_ADDRESS))).toEqual({
            status: 429,
            code: refused,
          });
          expect(refusal(await call('POST', path, first, SHARED_ADDRESS))).toEqual({
            status: 429,
            code: refused,
          });
          expect({
            path,
            status: (await call('POST', path, second, SHARED_ADDRESS)).status,
          }).toEqual({
            path,
            status: 404,
          });
        }

        // Not vacuous: both addresses reached Live, as the proxy forwarded them…
        const addresses = new Set(metas.map((meta) => meta.ipAddress));
        expect(addresses).toEqual(new Set([SHARED_ADDRESS, OTHER_ADDRESS]));
        // …and no key Live counted under names one.
        const keys = consume.mock.calls
          .filter(([, policy]) => policy.name.startsWith('live.'))
          .map(([key, policy]) => ({ policy: policy.name, key }));
        // Each limit's attempts, the two refused ones and the other person's.
        expect(keys.length).toBe(10 + 10 + 6 + 3 * 3);
        for (const { policy, key } of keys) {
          expect({
            policy,
            key,
            address: key.includes('203.0.113') || key.includes('198.51.100'),
          }).toEqual({ policy, key, address: false });
        }
        expect(new Set(keys.map(({ policy, key }) => `${policy} ${key}`))).toEqual(
          new Set([
            `live.start.user ${teacherA.id}`,
            `live.start.user ${teacherB.id}`,
            `live.join.session_user ${x}\u0000${studentA.id}`,
            `live.join.session_user ${x}\u0000${studentB.id}`,
            `live.hand.session_user ${x}\u0000${studentA.id}`,
            `live.hand.session_user ${x}\u0000${studentB.id}`,
          ]),
        );
      } finally {
        consume.mockRestore();
        for (const spy of spies) spy.mockRestore();
      }
    });
  });

  describe('tokens and secrets', () => {
    it('writes no token and no secret into a log line, an audit entry, an event, a frame or an error body — whatever key it would sit under', async () => {
      // A second session, and the failures a scenario can meet: a provider
      // fault and outage while signing, and Communities out of reach.
      const again = await call('POST', `/communities/${communityId}/sessions`, host);
      expect(again.status).toBe(201);
      const nextId = again.body.id as string;
      expect((await call('POST', `/sessions/${nextId}/join`, s1)).status).toBe(200);
      expect(refusal(await call('POST', `/sessions/${sessionId}/join`, s1))).toEqual({
        status: 412,
        code: 'live.session_not_live',
      });
      rtc.failNext('issueAccessToken', 'fault');
      expect((await call('POST', `/sessions/${nextId}/join`, s1)).status).toBe(500);
      rtc.failNext('issueAccessToken', 'unavailable');
      expect(refusal(await call('POST', `/sessions/${nextId}/join`, s1))).toEqual({
        status: 503,
        code: 'live.media_unavailable',
      });
      const communities = r.api.app.get<CommunityAuthorization>(COMMUNITY_AUTHORIZATION, {
        strict: false,
      });
      const outage = jest
        .spyOn(communities, 'authorize')
        .mockRejectedValue(new Error(`token ${tickets[0]} secret ${LIVEKIT_SECRET}`));
      try {
        expect((await call('POST', `/sessions/${nextId}/join`, s1)).status).toBe(503);
      } finally {
        outage.mockRestore();
      }
      expect((await call('POST', `/sessions/${nextId}/end`, delegate)).status).toBe(200);
      await r.liveRelay.idle();
      await r.communitiesRelay.idle();
      await sockets[2].waitFor(
        (frame) => frame.type === 'live.session.ended' && frame.sessionId === nextId,
      );

      const frames = sockets.flatMap((socket) => socket.frames);
      const errorBodies = r.api.transcript.filter((raw) => raw.includes('"error"'));
      const captures = {
        logs: logs.text(),
        audit: serialize(audits()),
        events: serialize(events),
        frames: serialize(frames),
        errors: errorBodies.join('\n'),
        liveBodies: transcript
          .filter(({ route, status }) => !(route.endsWith('/join') && status === 200))
          .map(({ raw }) => raw)
          .join('\n'),
      };

      // The captures are not blind: each holds what it should…
      expect(captures.logs).toContain('media provider: fake');
      for (const action of [
        'live.session.started',
        'live.speaker.granted',
        'live.screen_share.started',
        'live.session.ended',
      ]) {
        expect(audits().some((entry) => entry.action === action)).toBe(true);
      }
      expect(events.some((event) => event.name === LiveEvents.sessionStarted)).toBe(true);
      expect(events.some((event) => event.name === CommunityEvents.memberRemoved)).toBe(true);
      expect(frames.some((frame) => frame.type === 'live.session.changed')).toBe(true);
      for (const refused of [403, 404, 412, 429, 500, 503]) {
        expect({ refused, seen: transcript.some(({ status }) => status === refused) }).toEqual({
          refused,
          seen: true,
        });
      }
      // …tickets of every kind were issued, and the scan finds each wherever it is.
      expect(tickets.length).toBeGreaterThanOrEqual(10);
      expect(tickets.some((token) => token.endsWith('.pub'))).toBe(true);
      expect(tickets.some((token) => token.endsWith('.sub'))).toBe(true);
      for (const token of tickets) expect(credentialsIn(`{"x":["${token}"]}`)).toEqual([token]);
      expect(credentialsIn(`authorization=${host.token};`)).toEqual([host.token]);

      for (const [capture, text] of Object.entries(captures)) {
        expect({ capture, credentials: credentialsIn(text) }).toEqual({ capture, credentials: [] });
        expect({
          capture,
          livekitSecret: text.includes(LIVEKIT_SECRET),
          jwtSecret: text.includes(JWT_SECRET),
        }).toEqual({ capture, livekitSecret: false, jwtSecret: false });
      }
    });
  });
});
