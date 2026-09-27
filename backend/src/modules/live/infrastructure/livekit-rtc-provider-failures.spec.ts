import { Logger } from '@nestjs/common';

import {
  closedPort,
  startStubHttpServer,
  type StubAnswer,
  type StubHttpServer,
} from '../../../../test/support/stub-http-server';
import { loadConfig, type AppConfig } from '../../../platform/config/app-config';
import { PINNED_LIVEKIT_SERVER_VERSION } from '../../../platform/config/livekit-config';
import { RtcUnavailableError, type RtcCapabilities } from '../domain/rtc-provider';
import { LiveKitRtcProvider } from './livekit-rtc-provider';

const KEY = 'APIfailuresspec';
const SECRET = 'a-failures-spec-secret-that-is-long-enough-for-hs256';

const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

/**
 * Real media as configuration makes it, with the server API on `apiUrl` —
 * and clients on a host that does not exist, so a call that reached it
 * instead of the API URL could only fail.
 */
function configFor(apiUrl: string): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LIVE_MEDIA_PROVIDER: 'livekit',
    LIVE_ROOM_NAME_PREFIX: 'live-spec-',
    LIVEKIT_URL: 'wss://clients.media.invalid',
    LIVEKIT_API_URL: apiUrl,
    LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
    LIVEKIT_API_KEY: KEY,
    LIVEKIT_API_SECRET: SECRET,
  });
}

/** Every adapter method that calls the server, as the reconciler and the use cases call it. */
const EVERY_CALL = {
  ensureRoom: (rtc: LiveKitRtcProvider) =>
    rtc.ensureRoom({
      roomName: 'live-spec-room',
      maxParticipants: 310,
      emptyTimeoutSeconds: 1_200,
      departureTimeoutSeconds: 1_200,
    }),
  endRoom: (rtc: LiveKitRtcProvider) => rtc.endRoom('live-spec-room'),
  listRooms: (rtc: LiveKitRtcProvider) => rtc.listRooms(),
  getParticipant: (rtc: LiveKitRtcProvider) => rtc.getParticipant('live-spec-room', 'student-1'),
  listParticipants: (rtc: LiveKitRtcProvider) => rtc.listParticipants('live-spec-room'),
  updateCapabilities: (rtc: LiveKitRtcProvider) =>
    rtc.updateCapabilities('live-spec-room', 'student-1', LISTENER),
  removeParticipant: (rtc: LiveKitRtcProvider) =>
    rtc.removeParticipant('live-spec-room', 'student-1', { revokeTokensIssuedBefore: new Date() }),
  muteParticipant: (rtc: LiveKitRtcProvider) =>
    rtc.muteParticipant('live-spec-room', 'student-1', ['microphone']),
} as const;
type Method = keyof typeof EVERY_CALL;
const METHODS = Object.keys(EVERY_CALL) as Method[];

/** What a call came to: the value it resolved to, an outage, or a fault and its message. */
async function outcomeOf(call: Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: await call };
  } catch (error) {
    if (error instanceof RtcUnavailableError) return 'outage';
    return `fault: ${(error as Error).message}`;
  }
}

/** Every method's outcome against a server answering `answer`. */
async function outcomes(
  stub: StubHttpServer,
  rtc: LiveKitRtcProvider,
  answer: StubAnswer,
): Promise<Record<Method, unknown>> {
  stub.answer(answer);
  const all = {} as Record<Method, unknown>;
  for (const method of METHODS) all[method] = await outcomeOf(EVERY_CALL[method](rtc));
  return all;
}

/** The same outcome for every method. */
const everyMethod = (outcome: (method: Method) => unknown): Record<Method, unknown> =>
  Object.fromEntries(METHODS.map((method) => [method, outcome(method)])) as Record<Method, unknown>;

describe('the LiveKit adapter against a server that is not LiveKit (audit S1)', () => {
  let stub: StubHttpServer;
  let rtc: LiveKitRtcProvider;
  let logged: unknown[][];

  beforeAll(async () => {
    stub = await startStubHttpServer();
    rtc = new LiveKitRtcProvider(configFor(stub.url));
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push([level, ...args]);
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it.each<[string, StubAnswer]>([
    ['a codeless plain-text 404', { status: 404, body: '404 page not found' }],
    [
      'a proxy’s HTML 404',
      { status: 404, contentType: 'text/html', body: '<html><h1>404 Not Found</h1></html>' },
    ],
    [
      'a JSON 404 without a code',
      { status: 404, contentType: 'application/json', body: '{"error":"not here"}' },
    ],
    [
      'a Twirp 404 that is not not_found',
      { status: 404, contentType: 'application/json', body: '{"code":"bad_route","msg":"x"}' },
    ],
  ])(
    'never reads %s as an absent room or participant, nor as success — every call fails loudly',
    async (_case, answer) => {
      expect(await outcomes(stub, rtc, answer)).toEqual(
        everyMethod((method) => `fault: The media provider refused ${method} (404).`),
      );
      // Logged as what it is — a fault: its class, status and Twirp code, never its body.
      expect(logged.filter(([level]) => level === 'error')).toHaveLength(METHODS.length);
      expect(logged[0]).toEqual([
        'error',
        expect.objectContaining({
          event: 'live.provider.error',
          operation: 'ensureRoom',
          name: 'ServerError',
          status: 404,
        }),
        'media provider answered, but not as LiveKit does',
      ]);
    },
  );

  it('reads LiveKit’s own not_found as absence — only where absence is an answer', async () => {
    expect(
      await outcomes(stub, rtc, {
        status: 404,
        contentType: 'application/json',
        body: '{"code":"not_found","msg":"twirp error unknown: participant does not exist"}',
      }),
    ).toEqual({
      ensureRoom: 'fault: The media provider refused ensureRoom (404).',
      endRoom: { resolved: undefined },
      listRooms: 'fault: The media provider refused listRooms (404).',
      getParticipant: { resolved: null },
      listParticipants: { resolved: [] },
      updateCapabilities: { resolved: 'not_connected' },
      removeParticipant: { resolved: 'not_connected' },
      muteParticipant: { resolved: 'not_connected' },
    });
    expect(logged).toContainEqual([
      'log',
      { event: 'live.provider.room_delete', room: 'live-spec-room', outcome: 'already_gone' },
      'media room ended',
    ]);
  });

  it('never reads a 2xx body that is not LiveKit’s JSON as an answer', async () => {
    expect(
      await outcomes(stub, rtc, {
        status: 200,
        contentType: 'text/html',
        body: '<html>Welcome to nginx!</html>',
      }),
    ).toEqual(
      everyMethod((method) => `fault: The media provider refused ${method} (incompatible).`),
    );
  });

  it.each<[string, StubAnswer]>([
    ['a 401', { status: 401, body: 'invalid API key' }],
    ['a 403', { status: 403, contentType: 'text/html', body: '<h1>Forbidden</h1>' }],
  ])('fails every call on %s as rejected credentials', async (_case, answer) => {
    const status = typeof answer === 'object' ? answer.status : 0;
    expect(await outcomes(stub, rtc, answer)).toEqual(
      everyMethod((method) => `fault: The media provider refused ${method} (${status}).`),
    );
    expect(logged[0]?.[2]).toBe('media provider rejected our credentials');
  });

  it.each<[string, StubAnswer]>([
    ['a 500', { status: 500, body: 'internal error' }],
    ['a proxy’s 502', { status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }],
    ['a connection reset', 'reset'],
  ])('fails every call on %s as an outage', async (_case, answer) => {
    expect(await outcomes(stub, rtc, answer)).toEqual(everyMethod(() => 'outage'));
    expect(logged.every(([level]) => level === 'warn')).toBe(true);
  });

  it('fails every call to a closed port as an outage', async () => {
    const closed = new LiveKitRtcProvider(configFor(`http://127.0.0.1:${await closedPort()}`));
    expect(await outcomes(stub, closed, { status: 200 })).toEqual(everyMethod(() => 'outage'));
    expect(logged[0]).toEqual([
      'warn',
      {
        event: 'live.provider.error',
        operation: 'ensureRoom',
        name: 'TypeError',
        code: 'ECONNREFUSED',
      },
      'media provider unavailable',
    ]);
  });

  it('fails every call on a TLS failure as a fault — never an outage a retry would fix', async () => {
    const tls = new LiveKitRtcProvider(configFor(`https://127.0.0.1:${stub.port}`));
    expect(await outcomes(stub, tls, { status: 200 })).toEqual(
      everyMethod((method) => `fault: The media provider refused ${method} (tls).`),
    );
    expect(logged[0]?.[2]).toBe('media provider TLS handshake or certificate failed');
  });
});

describe('the LiveKit adapter’s transport', () => {
  let stub: StubHttpServer;

  beforeAll(async () => {
    stub = await startStubHttpServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('calls the server API on LIVEKIT_API_URL — never the client URL — signed per call', async () => {
    const rtc = new LiveKitRtcProvider(configFor(stub.url));
    stub.answer({ status: 200, contentType: 'application/json', body: '{"rooms":[]}' });
    const before = stub.requests.length;
    await expect(rtc.listRooms()).resolves.toEqual([]);
    const [request] = stub.requests.slice(before);
    expect(request).toMatchObject({
      method: 'POST',
      url: '/twirp/livekit.RoomService/ListRooms',
      headers: { authorization: expect.stringMatching(/^Bearer eyJ/) as string },
    });
  });

  it('builds the SDK’s client with the options stated: a 10-second timeout, no failover', () => {
    const rtc = new LiveKitRtcProvider(configFor(stub.url));
    // The SDK keeps them on its RPC client; read there, they are what it will use.
    const rpc = (rtc as unknown as { rooms: { rpc: Record<string, unknown> } }).rooms.rpc;
    expect(rpc).toMatchObject({ host: stub.url, requestTimeout: 10, failover: false });
  });

  it('logs the room it ensured and ended, by name only', async () => {
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const rtc = new LiveKitRtcProvider(configFor(stub.url));
    stub.answer({ status: 200, contentType: 'application/json', body: '{"name":"live-spec-a"}' });
    await rtc.ensureRoom({
      roomName: 'live-spec-a',
      maxParticipants: 310,
      emptyTimeoutSeconds: 1_200,
      departureTimeoutSeconds: 1_200,
    });
    stub.answer({ status: 200, contentType: 'application/json', body: '{}' });
    await rtc.endRoom('live-spec-a');
    expect(logged.mock.calls).toEqual([
      [{ event: 'live.provider.room_create', room: 'live-spec-a' }, 'media room ensured'],
      [
        { event: 'live.provider.room_delete', room: 'live-spec-a', outcome: 'deleted' },
        'media room ended',
      ],
    ]);
  });
});

describe('the LiveKit adapter’s join tokens', () => {
  const rtc = new LiveKitRtcProvider(configFor('http://127.0.0.1:9'));
  const grant = (ttlSeconds: number) => ({
    roomName: 'live-spec-room',
    identity: 'student-1',
    displayName: 'مريم',
    capabilities: LISTENER,
    ttlSeconds,
  });

  afterEach(() => jest.restoreAllMocks());

  // The SDK reads a falsy lifetime as six hours: the adapter refuses it itself (audit D24).
  it.each([0, -1, 1.5, 601, 21_600, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses to sign a token that lives %s seconds',
    async (ttlSeconds) => {
      await expect(rtc.issueAccessToken(grant(ttlSeconds))).rejects.toThrow(RangeError);
    },
  );

  it.each([1, 120, 600])('signs a token that lives %s seconds', async (ttlSeconds) => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const issued = await rtc.issueAccessToken(grant(ttlSeconds));
    const [, payload] = issued.token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp: number;
      nbf: number;
    };
    expect(claims.exp - claims.nbf).toBe(ttlSeconds);
    // Clients connect on the client URL, never the server API's.
    expect(issued.url).toBe('wss://clients.media.invalid');
  });

  it('logs each token it issues — the room, the identity and the lifetime; never the token', async () => {
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const issued = await rtc.issueAccessToken(grant(120));
    expect(logged.mock.calls).toEqual([
      [
        {
          event: 'live.provider.token_issue',
          room: 'live-spec-room',
          identity: 'student-1',
          ttlSeconds: 120,
        },
        'media join token issued',
      ],
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(issued.token);
  });
});
