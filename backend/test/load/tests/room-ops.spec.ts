import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';

import {
  type CreateOptions,
  ParticipantInfo,
  ParticipantInfo_State,
  Room,
  TokenVerifier,
  TrackInfo,
  TrackType,
} from 'livekit-server-sdk';

import { type RoomServiceCalls, roomOps, roomOpsFrom } from '../livekit/room-ops';
import { type LivekitEnv } from '../livekit/tokens';

/**
 * Unit tests for the controller's RoomService port (design §2, §7, §12) over a
 * fake RoomServiceCalls: the never-reuse check, CreateRoom limits, the
 * participant mapping, and — unlike the P8.3 helpers — errors SURFACED, never
 * swallowed. One wiring test drives the real SDK client against an in-process
 * 127.0.0.1 server (no LiveKit).
 */

const ROOM = 'loadtest-p84-0123456789abcdef';

interface Behaviour {
  readonly listRooms?: (names?: string[]) => Promise<Room[]>;
  readonly createRoom?: (options: CreateOptions) => Promise<Room>;
  readonly listParticipants?: (room: string) => Promise<ParticipantInfo[]>;
  readonly deleteRoom?: (room: string) => Promise<void>;
}

interface Call {
  readonly method: keyof RoomServiceCalls;
  readonly args: unknown[];
}

/** A fake RoomService: records every call with its exact arguments, then delegates. */
function fakeService(b: Behaviour = {}): { svc: RoomServiceCalls; calls: Call[] } {
  const calls: Call[] = [];
  const svc: RoomServiceCalls = {
    listRooms: async (...args: [names?: string[]]) => {
      calls.push({ method: 'listRooms', args });
      return b.listRooms ? b.listRooms(...args) : [];
    },
    createRoom: async (...args: [options: CreateOptions]) => {
      calls.push({ method: 'createRoom', args });
      return b.createRoom ? b.createRoom(...args) : new Room({ name: args[0].name });
    },
    listParticipants: async (...args: [room: string]) => {
      calls.push({ method: 'listParticipants', args });
      return b.listParticipants ? b.listParticipants(...args) : [];
    },
    deleteRoom: async (...args: [room: string]) => {
      calls.push({ method: 'deleteRoom', args });
      if (b.deleteRoom) await b.deleteRoom(...args);
    },
  };
  return { svc, calls };
}

const failing = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

function participant(
  identity: string,
  state: ParticipantInfo_State,
  tracks: readonly TrackType[] = [],
): ParticipantInfo {
  return new ParticipantInfo({
    identity,
    state,
    tracks: tracks.map((type, i) => new TrackInfo({ sid: `TR_${identity}_${i}`, type })),
  });
}

describe('livekit/room-ops — assertAbsent (room names are never reused)', () => {
  it('lists exactly that one room name and resolves when none exists', async () => {
    const { svc, calls } = fakeService({ listRooms: async () => [] });
    await expect(roomOpsFrom(svc).assertAbsent(ROOM)).resolves.toBeUndefined();
    expect(calls).toEqual([{ method: 'listRooms', args: [[ROOM]] }]);
  });

  it('throws when ListRooms returns the room', async () => {
    const { svc, calls } = fakeService({
      listRooms: async () => [new Room({ name: ROOM, numParticipants: 0 })],
    });
    await expect(roomOpsFrom(svc).assertAbsent(ROOM)).rejects.toThrow(
      `room ${ROOM} already exists — refusing to reuse it`,
    );
    expect(calls.map((c) => c.method)).toEqual(['listRooms']);
  });

  it('surfaces a ListRooms failure (an unverifiable check never passes)', async () => {
    const { svc } = fakeService({ listRooms: failing('twirp unavailable') });
    await expect(roomOpsFrom(svc).assertAbsent(ROOM)).rejects.toThrow('twirp unavailable');
  });
});

describe('livekit/room-ops — create', () => {
  it('passes maxParticipants and emptyTimeout (120 s) — and nothing else', async () => {
    const { svc, calls } = fakeService();
    await expect(roomOpsFrom(svc).create(ROOM, 1_000)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('createRoom');
    expect(calls[0].args).toStrictEqual([
      { name: ROOM, maxParticipants: 1_000, emptyTimeout: 120 },
    ]);
  });

  it('surfaces a CreateRoom failure (never swallowed)', async () => {
    const { svc } = fakeService({ createRoom: failing('permission denied') });
    await expect(roomOpsFrom(svc).create(ROOM, 100)).rejects.toThrow('permission denied');
  });
});

describe('livekit/room-ops — participants', () => {
  it('maps identity, ACTIVE state and the number of AUDIO tracks', async () => {
    const { svc, calls } = fakeService({
      listParticipants: async () => [
        participant('p84-01234567-P0', ParticipantInfo_State.ACTIVE, [TrackType.AUDIO]),
        participant('p84-01234567-L00000', ParticipantInfo_State.ACTIVE),
        participant('p84-01234567-L00001', ParticipantInfo_State.JOINED, [
          TrackType.AUDIO,
          TrackType.VIDEO,
          TrackType.AUDIO,
          TrackType.DATA,
        ]),
        participant('p84-01234567-L00002', ParticipantInfo_State.JOINING),
        participant('p84-01234567-L00003', ParticipantInfo_State.DISCONNECTED, [TrackType.VIDEO]),
      ],
    });
    const list = await roomOpsFrom(svc).participants(ROOM);
    expect(calls).toEqual([{ method: 'listParticipants', args: [ROOM] }]);
    expect(list).toStrictEqual([
      { identity: 'p84-01234567-P0', active: true, audioTracks: 1 },
      { identity: 'p84-01234567-L00000', active: true, audioTracks: 0 },
      { identity: 'p84-01234567-L00001', active: false, audioTracks: 2 },
      { identity: 'p84-01234567-L00002', active: false, audioTracks: 0 },
      { identity: 'p84-01234567-L00003', active: false, audioTracks: 0 },
    ]);
  });

  it('an empty room maps to an empty list', async () => {
    const { svc } = fakeService({ listParticipants: async () => [] });
    expect(await roomOpsFrom(svc).participants(ROOM)).toEqual([]);
  });

  it('surfaces a ListParticipants failure', async () => {
    const { svc } = fakeService({ listParticipants: failing('room not found') });
    await expect(roomOpsFrom(svc).participants(ROOM)).rejects.toThrow('room not found');
  });
});

describe('livekit/room-ops — remove', () => {
  it('deletes exactly that room', async () => {
    const { svc, calls } = fakeService();
    await expect(roomOpsFrom(svc).remove(ROOM)).resolves.toBeUndefined();
    expect(calls).toEqual([{ method: 'deleteRoom', args: [ROOM] }]);
  });

  it('surfaces a DeleteRoom failure: rejects with the same error (unlike P8.3 deleteRooms)', async () => {
    const boom = new Error('delete failed');
    const { svc } = fakeService({
      deleteRoom: async () => {
        throw boom;
      },
    });
    await expect(roomOpsFrom(svc).remove(ROOM)).rejects.toBe(boom);
  });
});

describe('livekit/room-ops — loadtestRooms', () => {
  it('lists ALL rooms, keeps only the `loadtest-` prefix and maps numParticipants', async () => {
    const { svc, calls } = fakeService({
      listRooms: async () => [
        new Room({ name: 'loadtest-p84-aaaa', numParticipants: 3 }),
        new Room({ name: 'live-staging-school-1', numParticipants: 5 }),
        new Room({ name: 'loadtest-mp-r0', numParticipants: 0 }),
        new Room({ name: 'xloadtest-p84-bbbb', numParticipants: 1 }),
        new Room({ name: 'LOADTEST-p84-cccc', numParticipants: 1 }),
        new Room({ name: 'loadtest', numParticipants: 1 }),
      ],
    });
    const rooms = await roomOpsFrom(svc).loadtestRooms();
    expect(calls).toEqual([{ method: 'listRooms', args: [] }]);
    expect(rooms).toStrictEqual([
      { name: 'loadtest-p84-aaaa', participants: 3 },
      { name: 'loadtest-mp-r0', participants: 0 },
    ]);
  });

  it('is empty when no load room is left', async () => {
    const { svc } = fakeService({
      listRooms: async () => [new Room({ name: 'live-staging-x', numParticipants: 2 })],
    });
    expect(await roomOpsFrom(svc).loadtestRooms()).toEqual([]);
  });

  it('surfaces a ListRooms failure (cleanup verification cannot pass silently)', async () => {
    const { svc } = fakeService({ listRooms: failing('connection refused') });
    await expect(roomOpsFrom(svc).loadtestRooms()).rejects.toThrow('connection refused');
  });
});

describe('livekit/room-ops — roomOps(env) wiring (in-process 127.0.0.1 server)', () => {
  interface Seen {
    readonly path: string;
    readonly authorization: string;
    readonly body: unknown;
  }

  let server: Server;
  let seen: Seen[] = [];
  let env: LivekitEnv;

  function handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => {
      raw += d;
    });
    req.on('end', () => {
      seen.push({
        path: req.url ?? '',
        authorization: req.headers.authorization ?? '',
        body: JSON.parse(raw || '{}'),
      });
      const reply = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.endsWith('/ListRooms'))
        reply(200, {
          rooms: [
            { name: 'loadtest-p84-aaaa', numParticipants: 2 },
            { name: 'live-staging-x', numParticipants: 7 },
          ],
        });
      else reply(404, { code: 'not_found', msg: 'requested room does not exist' });
    });
  }

  beforeAll(async () => {
    server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    env = {
      url: 'wss://livekit-staging.example.test',
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: 'APIroomopsspec',
      apiSecret: 'a-room-ops-spec-secret-long-enough-for-hs256',
    };
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
  });

  it('talks to env.apiUrl with env credentials and filters the real ListRooms response', async () => {
    const rooms = await roomOps(env).loadtestRooms();
    expect(rooms).toStrictEqual([{ name: 'loadtest-p84-aaaa', participants: 2 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/twirp/livekit.RoomService/ListRooms');
    const bearer = seen[0].authorization.replace(/^Bearer /, '');
    const claims = await new TokenVerifier(env.apiKey, env.apiSecret).verify(bearer);
    expect(claims.iss).toBe(env.apiKey);
  });

  it('a server error on DeleteRoom surfaces as a rejection', async () => {
    await expect(roomOps(env).remove(ROOM)).rejects.toThrow('requested room does not exist');
    expect(seen.map((s) => [s.path, s.body])).toEqual([
      ['/twirp/livekit.RoomService/DeleteRoom', { room: ROOM }],
    ]);
  });
});
