import { TrackSource } from 'livekit-server-sdk';

import type { Principal } from '../../src/shared';
import { META, captureLogs, codeOf } from '../support/live-harness';
import { mediaClients, type MediaTicket } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { restartableServer, type RestartableServer } from './support/restartable-server';
import { leakedCredentials } from './support/server-view';

/**
 * The media server failing under a running session — killed, as in a crash,
 * and started again empty — on a server of this file's own, the pinned
 * release as the suite's runtime runs it (brief §10, item 26):
 *
 *   - while it is down, nothing is decided on it: Start answers 503
 *     live.media_unavailable and stores nothing, every reconciler tick skips
 *     as an outage and ends nothing, the session and its floor stay as they
 *     were; `/join` still signs a ticket (signing needs no server), which
 *     admits nobody while the server is down;
 *   - when it comes back without its rooms, the room sweep makes the
 *     session's room again, and a ticket issued during the outage admits its
 *     holder with what the application gave them — the speaker publishes,
 *     the listener is refused — and Start works again.
 */
describe('the pinned LiveKit server crashing mid-session, and coming back without its rooms', () => {
  const clients = mediaClients();
  let logs: ReturnType<typeof captureLogs>;
  let restartable: RestartableServer;
  let live: RealLive;
  let owner: Principal;
  let students: readonly Principal[];
  let sessionId: string;
  let room: string;
  /** Issued while the server was down. */
  let speakerTicket: MediaTicket;

  beforeAll(async () => {
    logs = captureLogs();
    restartable = await restartableServer();
    live = realLive({ server: restartable.server });
    const community = await live.community('teacher-1', 'student-1', 'student-2');
    ({ owner, students } = community);
    sessionId = (await live.startSession(owner, community.id)).id;
    room = live.room(sessionId);
  }, 60_000);

  afterAll(async () => {
    await clients.closeAll();
    await restartable.close();
    jest.restoreAllMocks();
  });

  async function ticket(principal: Principal) {
    const joined = await live.join.execute({ principal, sessionId, meta: META });
    if (!joined.ok) throw new Error(`could not join: ${joined.error.code}`);
    return joined.value;
  }

  it('decides nothing while the server is down: Start refused, every tick skipped, nothing ended — and a ticket admits nobody', async () => {
    const hand = await live.raised(students[0], sessionId);
    await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    const speaker = await clients.connect(await ticket(students[0]));
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-1', TrackSource.MICROPHONE);
    const listener = await clients.connect(await ticket(students[1]));

    await restartable.crash();
    // What their clients do next is theirs; this file watches the application.
    for (const client of [speaker, listener]) await client.disconnect();

    const other = await live.community('teacher-2');
    const started = await live.start.execute({
      principal: other.owner,
      communityId: other.id,
      meta: META,
    });
    expect(codeOf(started)).toBe('live.media_unavailable');
    expect(await live.sessions.findLiveByCommunity(other.id)).toBeNull();

    expect(await live.reconciler.sweepRooms()).toMatchObject({
      skipped: 'provider_unavailable',
      ensured: 0,
      idleEnded: 0,
      orphansEnded: 0,
    });
    expect(await live.reconciler.sweepParticipants()).toMatchObject({
      skipped: 'provider_unavailable',
      removed: 0,
      corrected: 0,
      violations: 0,
      resets: 0,
    });
    expect(await live.reconciler.watchTick()).toMatchObject({
      removed: 0,
      corrected: 0,
      violations: 0,
      resets: 0,
    });
    expect(await live.session(sessionId)).toMatchObject({ state: 'live', mediaRoomEpoch: 0 });
    expect((await live.requests.findOpen(sessionId, 'student-1'))?.state).toBe('granted');

    // Signing needs no server: the speaker still gets a speaker's ticket…
    const joined = await ticket(students[0]);
    expect(joined).toMatchObject({ role: 'speaker', media: { microphone: true } });
    speakerTicket = joined;
    // …which admits nobody while the server is down.
    expect(await clients.refusal(speakerTicket)).toMatch(/Connection refused/);
  });

  it('comes back without its rooms: the room sweep makes the session’s room again, a ticket from the outage admits its holder as what they are, and Start works again', async () => {
    await restartable.start();
    expect(await live.adapter.check()).toEqual({ ready: true });
    expect(await live.view.roomsNamed(live.settings.roomNamePrefix)).toEqual([]);

    expect(await live.reconciler.sweepRooms()).toMatchObject({ skipped: null, ensured: 1 });
    expect(await live.view.roomsNamed(live.settings.roomNamePrefix)).toEqual([room]);

    const speaker = await clients.connect(speakerTicket);
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-1', TrackSource.MICROPHONE);
    const listener = await clients.connect(await ticket(students[1]));
    const mark = live.view.mark();
    listener.publish('microphone');
    expect(await live.view.refused(room, 'student-2', 'AUDIO', mark)).toEqual([]);

    const other = await live.community('teacher-3');
    const started = await live.start.execute({
      principal: other.owner,
      communityId: other.id,
      meta: META,
    });
    expect(started.ok).toBe(true);
    await live.end.execute({ principal: owner, sessionId, meta: META });
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [restartable.server.apiSecret])).toEqual([]);
  });
});
