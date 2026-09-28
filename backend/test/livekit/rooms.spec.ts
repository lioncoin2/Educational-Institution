import type { RtcCapabilities } from '../../src/modules/live/domain/rtc-provider';
import type { Principal } from '../../src/shared';
import { META, captureLogs, codeOf } from '../support/live-harness';
import { mediaClients } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { leakedCredentials } from './support/server-view';

const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

/** An id no session has. */
const UNKNOWN_SESSION = '00000000-0000-4000-8000-00000000abcd';

/** The claims of a join token, read without verifying: what the server will hold it to. */
function claimsOf(token: string): { exp: number; nbf: number; video: Record<string, unknown> } {
  const [, payload = ''] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    exp: number;
    nbf: number;
    video: Record<string, unknown>;
  };
}

/**
 * Rooms exist only because the application made them (live.md §4; P7.1,
 * `room.auto_create: false`) — checked against the pinned server with a
 * real client (brief §10, items 8, 9, 10 and 15):
 *
 *   - no token the application issues creates a room: it carries
 *     `roomJoin` for one room and no admin grant, so the room API refuses
 *     it, and a join to a room never ensured is refused and creates nothing;
 *   - an unknown session gets no ticket, and the server admits nobody to a
 *     room it does not have;
 *   - an ended session's room stays gone: a token still within its lifetime
 *     cannot bring it back;
 *   - a token past its lifetime and the server's 60 s leeway (PGO
 *     verifier.go) is refused.
 */
describe('rooms on the pinned LiveKit server are the application’s alone', () => {
  const clients = mediaClients();
  let logs: ReturnType<typeof captureLogs>;
  let live: RealLive;
  let owner: Principal;
  let student: Principal;
  let communityId: string;

  beforeAll(async () => {
    logs = captureLogs();
    live = realLive();
    const community = await live.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = community);
    student = live.person('student-1', ['STUDENT'], 'مريم');
  });

  afterAll(async () => {
    await clients.closeAll();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Starts a session in the community, and answers it with its room. */
  async function started(): Promise<{ sessionId: string; room: string }> {
    const session = await live.startSession(owner, communityId);
    return { sessionId: session.id, room: live.room(session.id) };
  }

  async function ticket(sessionId: string) {
    const joined = await live.join.execute({ principal: student, sessionId, meta: META });
    if (!joined.ok) throw new Error(`could not join: ${joined.error.code}`);
    return joined.value;
  }

  /** A join token the adapter signs, as `/join` would, for any room. */
  const tokenFor = (roomName: string) =>
    live.adapter.issueAccessToken({
      roomName,
      identity: 'student-1',
      displayName: 'مريم',
      capabilities: LISTENER,
      ttlSeconds: live.settings.joinTokenTtlSeconds,
    });

  it('creates no room from any token it issues: not through the room API, not by joining one it never ensured', async () => {
    const { sessionId, room } = await started();
    const joined = await ticket(sessionId);
    // roomJoin, for this room only — never an admin grant, which would let
    // a join create its room whatever auto_create says (SRV
    // pkg/service/roomallocator.go:175-184).
    const video = claimsOf(joined.token).video;
    expect(video).toMatchObject({ room, roomJoin: true });
    for (const grant of ['roomCreate', 'roomAdmin', 'roomList', 'roomRecord', 'agent']) {
      expect({ grant, held: video[grant] ?? false }).toEqual({ grant, held: false });
    }

    // The room API refuses it: a client cannot make a room of its own.
    const elsewhere = `${live.settings.roomNamePrefix}client-made`;
    const created = await fetch(`${live.server.httpUrl}/twirp/livekit.RoomService/CreateRoom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${joined.token}` },
      body: JSON.stringify({ name: elsewhere }),
    });
    expect(created.status).toBe(401);

    // Nor does joining one make it: a valid token for a room the
    // application never ensured is refused.
    const never = `${live.settings.roomNamePrefix}never-ensured`;
    expect(await clients.refusal(await tokenFor(never))).toContain(
      '404 Not Found - requested room does not exist',
    );
    expect(await live.view.roomsNamed(live.settings.roomNamePrefix)).toEqual([room]);
    await live.end.execute({ principal: owner, sessionId, meta: META });
  });

  it('admits nobody to an unknown room: no ticket for an unknown session, and no join to a room the server lacks', async () => {
    const refused = await live.join.execute({
      principal: student,
      sessionId: UNKNOWN_SESSION,
      meta: META,
    });
    expect(codeOf(refused)).toBe('live.session_not_found');

    // Signed with this deployment's own credentials, for the room that
    // session would use: the server has no such room, and makes none.
    const room = live.room(UNKNOWN_SESSION);
    expect(await clients.refusal(await tokenFor(room))).toContain(
      '404 Not Found - requested room does not exist',
    );
    expect(await live.view.roomsNamed(room)).toEqual([]);
  });

  it('keeps an ended session’s room gone: a token still within its lifetime cannot revive it', async () => {
    const { sessionId, room } = await started();
    const joined = await ticket(sessionId);
    const listener = await clients.connect(joined);
    expect(await live.view.identities(room)).toEqual(['student-1']);

    const ended = await live.end.execute({ principal: owner, sessionId, meta: META });
    expect(ended.ok).toBe(true);
    expect(await live.view.roomsNamed(room)).toEqual([]);
    await listener.disconnect();

    // The same token, well within its 120 s: refused, and nothing re-created.
    expect(claimsOf(joined.token).exp * 1000).toBeGreaterThan(Date.now());
    expect(await clients.refusal(joined)).toContain(
      '404 Not Found - requested room does not exist',
    );
    expect(await live.view.roomsNamed(room)).toEqual([]);
    // …and the application issues no new one.
    expect(codeOf(await live.join.execute({ principal: student, sessionId, meta: META }))).toBe(
      'live.session_not_live',
    );
  });

  it('refuses a token past its lifetime and the server’s 60 s leeway — and only then', async () => {
    const { sessionId } = await started();
    /** A ticket `/join` issued `seconds` ago: only the clock that signs it is set back. */
    const issuedAgo = async (seconds: number) => {
      jest.useFakeTimers({
        now: Date.now() - seconds * 1000,
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
      try {
        return await ticket(sessionId);
      } finally {
        jest.useRealTimers();
      }
    };

    /** How long ago a token's lifetime ended, in seconds. */
    const expiredFor = (token: string) => Date.now() / 1000 - claimsOf(token).exp;

    // Issued 200 s ago: its 120 s ended 80 s ago, past the leeway.
    const expired = await issuedAgo(200);
    const claims = claimsOf(expired.token);
    expect(claims.exp - claims.nbf).toBe(live.settings.joinTokenTtlSeconds);
    expect(expiredFor(expired.token)).toBeGreaterThan(60);
    expect(await clients.refusal(expired)).toMatch(
      /401 Unauthorized - .*token has invalid claims: token is expired/,
    );
    // Issued 150 s ago: ended 30 s ago, inside the server's leeway — still admitted.
    const lately = await issuedAgo(150);
    expect(expiredFor(lately.token)).toBeGreaterThan(0);
    expect(expiredFor(lately.token)).toBeLessThan(60);
    const recent = await clients.connect(lately);
    expect(recent.identity).toBe('student-1');
    await recent.disconnect();
    await live.end.execute({ principal: owner, sessionId, meta: META });
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
