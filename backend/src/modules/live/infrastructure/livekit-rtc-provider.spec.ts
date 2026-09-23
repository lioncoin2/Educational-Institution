import { Logger } from '@nestjs/common';
import {
  ParticipantInfo,
  ParticipantInfo_State,
  ServerError,
  TrackInfo,
  TrackSource,
} from 'livekit-server-sdk';

import type { AppConfig } from '../../../platform/config/app-config';
import {
  LISTENER,
  RtcUnavailableError,
  SPEAKER,
  type RtcCapabilities,
} from '../domain/rtc-provider';
import {
  LiveKitRtcProvider,
  classify,
  describe as describeError,
  permissionOf,
  type LiveKitRoomService,
} from './livekit-rtc-provider';

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256-signing';

const config = {
  livekit: { url: 'wss://media.example.test', apiKey: 'test-key', apiSecret: SECRET },
} as unknown as AppConfig;

/** A room service that records calls and fails when told to. */
function roomService(overrides: Partial<Record<keyof LiveKitRoomService, jest.Mock>> = {}) {
  const service = {
    createRoom: jest.fn().mockResolvedValue({}),
    deleteRoom: jest.fn().mockResolvedValue(undefined),
    listRooms: jest.fn().mockResolvedValue([]),
    listParticipants: jest.fn().mockResolvedValue([]),
    getParticipant: jest.fn().mockResolvedValue(new ParticipantInfo({ identity: 'u' })),
    updateParticipant: jest.fn().mockResolvedValue(new ParticipantInfo({ identity: 'u' })),
    removeParticipant: jest.fn().mockResolvedValue(undefined),
    mutePublishedTrack: jest.fn().mockResolvedValue(new TrackInfo()),
    ...overrides,
  };
  return service;
}

const provider = (service = roomService()) => new LiveKitRtcProvider(config, service);

const notFound = () => new ServerError('Not Found', 'participant not found', 404, 'not_found');
const serverDown = () => new ServerError('Service Unavailable', 'down', 503, 'unavailable');
const badKey = () => new ServerError('Unauthorized', 'invalid token', 401, 'unauthenticated');

/** The claims of a JWT, read without verifying — the test inspects what we signed. */
function claims(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

// The adapter logs outages and refusals by design. Each test captures what it
// logged, so the log is asserted on rather than printed.
let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'debug', 'warn', 'error', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push([level, ...args]);
    });
  }
});
afterEach(() => jest.restoreAllMocks());

describe('the LiveKit adapter — tokens', () => {
  async function tokenFor(capabilities: RtcCapabilities) {
    const issued = await provider().issueAccessToken({
      roomName: 'session-1',
      identity: 'student-1',
      displayName: 'مريم',
      capabilities,
      ttlSeconds: 120,
    });
    return { issued, claims: claims(issued.token) };
  }

  it('gives a listener a token for one room that can publish nothing, data included', async () => {
    const { claims: c } = await tokenFor(LISTENER);
    const video = c.video as Record<string, unknown>;
    expect(video).toMatchObject({
      room: 'session-1',
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      hidden: false,
    });
    // An empty source list would mean EVERY source; a listener's publish flag is off.
    expect(video.canPublishSources ?? []).toEqual([]);
  });

  it('gives a speaker the microphone and only the microphone — never the camera', async () => {
    const { claims: c } = await tokenFor(SPEAKER);
    const video = c.video as Record<string, unknown>;
    expect(video.canPublish).toBe(true);
    expect(video.canPublishSources).toEqual(['microphone']);
    expect(video.canPublishData).toBe(false);
  });

  it('never grants an administrative right, and names the identity from the grant', async () => {
    const { claims: c } = await tokenFor(SPEAKER);
    const video = c.video as Record<string, unknown>;
    for (const admin of ['roomCreate', 'roomAdmin', 'roomList', 'roomRecord']) {
      expect(video[admin]).toBeFalsy();
    }
    expect(c.sub).toBe('student-1');
    expect(c.name).toBe('مريم');
  });

  it('lives exactly as long as asked — 120 seconds for a join', async () => {
    const { claims: c, issued } = await tokenFor(LISTENER);
    expect((c.exp as number) - (c.nbf as number)).toBe(120);
    expect(issued).toMatchObject({ url: 'wss://media.example.test', expiresInSeconds: 120 });
  });
});

describe('the LiveKit adapter — participants', () => {
  it('applies the FULL permission set on every update, with an explicit source list', async () => {
    const service = roomService();
    await provider(service).updateCapabilities('session-1', 'student-1', LISTENER);
    await provider(service).updateCapabilities('session-1', 'student-1', SPEAKER);
    expect(service.updateParticipant.mock.calls).toEqual([
      [
        'session-1',
        'student-1',
        {
          permission: {
            canPublish: false,
            canPublishSources: [],
            canSubscribe: true,
            canPublishData: false,
            canUpdateMetadata: false,
            hidden: false,
          },
        },
      ],
      [
        'session-1',
        'student-1',
        {
          permission: {
            canPublish: true,
            canPublishSources: [TrackSource.MICROPHONE],
            canSubscribe: true,
            canPublishData: false,
            canUpdateMetadata: false,
            hidden: false,
          },
        },
      ],
    ]);
  });

  it('turns "not found" into not_connected — the person is simply not in the room', async () => {
    const service = roomService({ updateParticipant: jest.fn().mockRejectedValue(notFound()) });
    await expect(provider(service).updateCapabilities('s', 'u', LISTENER)).resolves.toBe(
      'not_connected',
    );
    const removing = roomService({ removeParticipant: jest.fn().mockRejectedValue(notFound()) });
    await expect(provider(removing).removeParticipant('s', 'u')).resolves.toBe('not_connected');
    const reading = roomService({ getParticipant: jest.fn().mockRejectedValue(notFound()) });
    await expect(provider(reading).getParticipant('s', 'u')).resolves.toBeNull();
  });

  it('reports an outage as RtcUnavailableError — a 5xx, a refused connection, a timeout', async () => {
    for (const failure of [serverDown(), new TypeError('fetch failed'), timeout()]) {
      const service = roomService({ updateParticipant: jest.fn().mockRejectedValue(failure) });
      await expect(provider(service).updateCapabilities('s', 'u', SPEAKER)).rejects.toBeInstanceOf(
        RtcUnavailableError,
      );
    }
  });

  it('treats rejected credentials as a fault, not an outage', async () => {
    const service = roomService({ updateParticipant: jest.fn().mockRejectedValue(badKey()) });
    const failure = provider(service).updateCapabilities('s', 'u', SPEAKER);
    await expect(failure).rejects.toThrow('refused updateCapabilities');
    await expect(failure).rejects.not.toBeInstanceOf(RtcUnavailableError);
  });

  it('observes participants who are present, dropping those who have left', async () => {
    const present = new ParticipantInfo({
      identity: 'student-1',
      state: ParticipantInfo_State.ACTIVE,
      joinedAt: 1_700_000_000n,
      tracks: [new TrackInfo({ sid: 't1', source: TrackSource.MICROPHONE, muted: false })],
      permission: {
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true,
      },
    });
    const gone = new ParticipantInfo({
      identity: 'student-2',
      state: ParticipantInfo_State.DISCONNECTED,
    });
    const service = roomService({ listParticipants: jest.fn().mockResolvedValue([present, gone]) });
    const observed = await provider(service).listParticipants('session-1');
    expect(observed).toEqual([
      {
        identity: 'student-1',
        state: 'active',
        standard: true,
        joinedAt: new Date(1_700_000_000_000),
        publishing: ['microphone'],
        capabilities: SPEAKER,
      },
    ]);
    // A room that does not exist has nobody in it.
    const empty = roomService({ listParticipants: jest.fn().mockRejectedValue(notFound()) });
    await expect(provider(empty).listParticipants('nope')).resolves.toEqual([]);
  });
});

describe('the LiveKit adapter — rooms', () => {
  it('creates rooms with our limits and reports failures instead of swallowing them', async () => {
    const service = roomService();
    await provider(service).ensureRoom({
      roomName: 'session-1',
      maxParticipants: 300,
      emptyTimeoutSeconds: 300,
      departureTimeoutSeconds: 20,
    });
    expect(service.createRoom).toHaveBeenCalledWith({
      name: 'session-1',
      maxParticipants: 300,
      emptyTimeout: 300,
      departureTimeout: 20,
    });
    const down = roomService({ createRoom: jest.fn().mockRejectedValue(serverDown()) });
    await expect(
      provider(down).ensureRoom({
        roomName: 'x',
        maxParticipants: 1,
        emptyTimeoutSeconds: 1,
        departureTimeoutSeconds: 1,
      }),
    ).rejects.toBeInstanceOf(RtcUnavailableError);
  });

  it('treats ending a room that does not exist as already ended', async () => {
    const service = roomService({ deleteRoom: jest.fn().mockRejectedValue(notFound()) });
    await expect(provider(service).endRoom('gone')).resolves.toBeUndefined();
  });
});

describe('the LiveKit adapter — what it logs', () => {
  it('describes an error by class, status and code only — never its message', () => {
    const leaky = new ServerError(
      'Unauthorized',
      `bad token eyJhbGciOi.${SECRET}.sig`,
      401,
      'unauthenticated',
    );
    const described = JSON.stringify(describeError(leaky));
    expect(described).toBe('{"name":"ServerError","status":401,"code":"unauthenticated"}');
    expect(described).not.toContain(SECRET);
    expect(JSON.stringify(describeError(new TypeError(`fetch ${SECRET}`)))).toBe(
      '{"name":"TypeError"}',
    );
  });

  it('logs an outage as a warning and a refusal as an error, with no message, token or secret', async () => {
    const down = roomService({ updateParticipant: jest.fn().mockRejectedValue(serverDown()) });
    await expect(provider(down).updateCapabilities('s', 'u', SPEAKER)).rejects.toBeInstanceOf(
      RtcUnavailableError,
    );
    const leaky = new ServerError('Unauthorized', `bad key ${SECRET}`, 401, 'unauthenticated');
    const refused = roomService({ updateParticipant: jest.fn().mockRejectedValue(leaky) });
    await expect(provider(refused).updateCapabilities('s', 'u', SPEAKER)).rejects.toThrow(
      'refused updateCapabilities (401)',
    );
    expect(logged).toEqual([
      [
        'warn',
        { operation: 'updateCapabilities', name: 'ServerError', status: 503, code: 'unavailable' },
        'media provider unavailable',
      ],
      [
        'error',
        {
          operation: 'updateCapabilities',
          name: 'ServerError',
          status: 401,
          code: 'unauthenticated',
        },
        'media provider rejected our credentials',
      ],
    ]);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it('classifies by what the caller can do about it', () => {
    expect(classify(notFound())).toBe('not_found');
    expect(classify(serverDown())).toBe('unavailable');
    expect(classify(badKey())).toBe('misconfigured');
    expect(classify(new TypeError('fetch failed'))).toBe('unavailable');
    expect(classify(timeout())).toBe('unavailable');
    expect(classify(new ServerError('Bad Request', 'x', 400, 'invalid_argument'))).toBe('rejected');
  });

  it('maps capability sets to explicit permission sets', () => {
    expect(
      permissionOf({ ...LISTENER, canPublishScreen: true, canPublishScreenAudio: true }),
    ).toMatchObject({
      canPublish: true,
      canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    });
  });
});

function timeout(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}
