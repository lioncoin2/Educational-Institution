import { randomBytes } from 'node:crypto';

import { TrackSource } from 'livekit-server-sdk';

import { IDLE_END_SECONDS, ORPHAN_GRACE_SECONDS } from '../../src/modules/live/domain/live-limits';
import { RtcUnavailableError } from '../../src/modules/live/domain/rtc-provider';
import type { Principal } from '../../src/shared';
import { META, captureLogs } from '../support/live-harness';
import { mediaClients, reasonName } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { eventually, leakedCredentials } from './support/server-view';

/** What LiveKit holds for a participant who may publish nothing (PGO grants.go). */
const LISTENING = { canPublish: false, canPublishSources: [] };

/** A community with a teacher and students, and a session started in it. */
interface World {
  readonly live: RealLive;
  readonly owner: Principal;
  readonly students: readonly Principal[];
  readonly sessionId: string;
  readonly room: string;
}

/**
 * The application's record decides the room, on the pinned server, with
 * real WebRTC clients (brief §10, items 15, 20, 22, 24 and 25):
 *
 *   - End deletes the room, and the server disconnects everyone in it;
 *   - one participant per account: a second connection of the same account
 *     evicts the first;
 *   - a media reset moves the session to a new room — the old one deleted
 *     with everyone in it, its tickets refused — and never touches another
 *     deployment's rooms on the same server;
 *   - a session nobody attends ends `idle`, its room with it; an End whose
 *     room could not be deleted is finished by the room sweep;
 *   - a room deleted behind the application's back is made again, and
 *     nothing else is: no session, no audit, no event.
 */
describe('the session lifecycle on the pinned LiveKit server', () => {
  const clients = mediaClients();
  const harnesses: RealLive[] = [];
  let logs: ReturnType<typeof captureLogs>;

  beforeAll(() => {
    logs = captureLogs();
  });

  afterAll(async () => {
    await clients.closeAll();
    jest.restoreAllMocks();
  });

  /** A harness of its own — its own room prefix — with a session running. */
  async function world(): Promise<World> {
    const live = realLive();
    harnesses.push(live);
    const community = await live.community('teacher-1', 'student-1', 'student-2');
    const sessionId = (await live.startSession(community.owner, community.id)).id;
    return {
      live,
      owner: community.owner,
      students: community.students,
      sessionId,
      room: live.room(sessionId),
    };
  }

  async function ticket(w: World, principal: Principal) {
    const joined = await w.live.join.execute({ principal, sessionId: w.sessionId, meta: META });
    if (!joined.ok) throw new Error(`could not join: ${joined.error.code}`);
    return joined.value;
  }

  /** Sets the harness's clock `seconds` past the real time: the server's rooms were made before it. */
  function pastRealTime(live: RealLive, seconds: number): void {
    live.clock.advance((Date.now() - live.clock.now().getTime()) / 1000 + seconds);
  }

  it('disconnects everyone when the session ends: the server deletes the room, and tells each client why', async () => {
    const w = await world();
    const listener = await clients.connect(await ticket(w, w.students[0]));
    const hand = await w.live.raised(w.students[1], w.sessionId);
    await w.live.moderate.grant({ principal: w.owner, requestId: hand.id, meta: META });
    const speaker = await clients.connect(await ticket(w, w.students[1]));
    expect(await speaker.publish('microphone').outcome).toBe('published');

    const ended = await w.live.end.execute({
      principal: w.owner,
      sessionId: w.sessionId,
      meta: META,
    });
    expect(ended.ok).toBe(true);
    for (const client of [listener, speaker]) {
      expect(reasonName(await client.ended)).toBe('ROOM_DELETED');
    }
    expect(await w.live.view.roomsNamed(w.live.settings.roomNamePrefix)).toEqual([]);
  });

  it('keeps one participant per account: a second connection of the same account evicts the first', async () => {
    const w = await world();
    const first = await clients.connect(await ticket(w, w.students[0]));
    const firstSid = (await w.live.view.participant(w.room, 'student-1'))?.sid;

    const second = await clients.connect(await ticket(w, w.students[0]));
    expect(reasonName(await first.ended)).toBe('DUPLICATE_IDENTITY');
    expect(second.identity).toBe('student-1');
    expect(await w.live.view.identities(w.room)).toEqual(['student-1']);
    expect((await w.live.view.participant(w.room, 'student-1'))?.sid).not.toBe(firstSid);
    await w.live.end.execute({ principal: w.owner, sessionId: w.sessionId, meta: META });
  });

  it('moves the session to a new room at a media reset — the old room deleted with everyone in it, its tickets refused — and never touches another deployment’s room', async () => {
    const w = await world();
    // Another deployment on the same server.
    const elsewhere = `other-${randomBytes(4).toString('hex')}-room`;
    await w.live.view.rooms.createRoom({ name: elsewhere, emptyTimeout: 300 });

    const listenerTicket = await ticket(w, w.students[1]);
    const listener = await clients.connect(listenerTicket);
    const hand = await w.live.raised(w.students[0], w.sessionId);
    await w.live.moderate.grant({ principal: w.owner, requestId: hand.id, meta: META });
    const speaker = await clients.connect(await ticket(w, w.students[0]));
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await w.live.moderate.revoke({ principal: w.owner, requestId: hand.id, meta: META });
    await w.live.view.unpublished(w.room, 'student-1', TrackSource.MICROPHONE);

    // The server made to hold the microphone for student-1 again — through
    // its own room API, as a provider that lost the correction would.
    const drift = () =>
      w.live.view.rooms.updateParticipant(w.room, 'student-1', {
        permission: {
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
        },
      });
    await drift();
    expect(await w.live.reconciler.sweepParticipants()).toMatchObject({
      corrected: 1,
      violations: 0,
    });
    expect((await w.live.view.participant(w.room, 'student-1'))?.permission).toMatchObject(
      LISTENING,
    );
    await drift();
    expect(await w.live.reconciler.watchTick()).toMatchObject({ violations: 1, resets: 1 });

    const moved = w.live.room(w.sessionId, 1);
    expect(await w.live.view.roomsNamed(w.live.settings.roomNamePrefix)).toEqual([moved]);
    for (const client of [speaker, listener]) {
      expect(reasonName(await client.ended)).toBe('ROOM_DELETED');
    }
    // A ticket for the old room, well within its lifetime: refused, nothing made.
    expect(await clients.refusal(listenerTicket)).toContain(
      '404 Not Found - requested room does not exist',
    );
    // (The new room's name begins with the old one's: epoch 0 has no suffix.)
    expect(await w.live.view.roomsNamed(w.room)).toEqual([moved]);
    // `/join` now admits to the new room.
    const back = await clients.connect(await ticket(w, w.students[1]));
    expect(back.room.name).toBe(moved);

    // Another deployment's room: untouched by the reset, and by the room
    // sweep past every grace.
    pastRealTime(w.live, ORPHAN_GRACE_SECONDS + 1);
    expect(await w.live.reconciler.sweepRooms()).toMatchObject({ orphansEnded: 0 });
    expect(await w.live.view.roomsNamed(elsewhere)).toEqual([elsewhere]);
    await w.live.view.rooms.deleteRoom(elsewhere);
    await w.live.end.execute({ principal: w.owner, sessionId: w.sessionId, meta: META });
  });

  it('ends a session nobody attends as idle, and its room with it', async () => {
    const w = await world();
    // Observed empty…
    expect(await w.live.reconciler.sweepRooms()).toMatchObject({ idleEnded: 0 });
    // …and still empty IDLE_END_SECONDS later.
    w.live.clock.advance(IDLE_END_SECONDS);
    expect(await w.live.reconciler.sweepRooms()).toMatchObject({ idleEnded: 1 });
    expect(await w.live.session(w.sessionId)).toMatchObject({
      state: 'ended',
      endReason: 'idle',
    });
    expect(await w.live.view.roomsNamed(w.live.settings.roomNamePrefix)).toEqual([]);
  });

  it('finishes an End whose room could not be deleted: the room sweep deletes it once past its grace, and the server disconnects who is left', async () => {
    const w = await world();
    const listener = await clients.connect(await ticket(w, w.students[0]));
    jest.spyOn(w.live.adapter, 'endRoom').mockRejectedValueOnce(new RtcUnavailableError('endRoom'));

    const ended = await w.live.end.execute({
      principal: w.owner,
      sessionId: w.sessionId,
      meta: META,
    });
    expect(ended.ok).toBe(true);
    expect((await w.live.session(w.sessionId)).state).toBe('ended');
    // The room is still on the server, the listener in it.
    expect(await w.live.view.identities(w.room)).toEqual(['student-1']);

    pastRealTime(w.live, ORPHAN_GRACE_SECONDS + 1);
    expect(await w.live.reconciler.sweepRooms()).toMatchObject({ orphansEnded: 1 });
    expect(reasonName(await listener.ended)).toBe('ROOM_DELETED');
    expect(await w.live.view.roomsNamed(w.live.settings.roomNamePrefix)).toEqual([]);
  });

  it('makes a room deleted behind its back again — and nothing else: no session, no audit, no event', async () => {
    const w = await world();
    const listener = await clients.connect(await ticket(w, w.students[0]));
    const audits = w.live.audits().length;
    const events = w.live.eventNames().length;

    await w.live.view.rooms.deleteRoom(w.room);
    expect(reasonName(await listener.ended)).toBe('ROOM_DELETED');

    expect(await w.live.reconciler.sweepRooms()).toMatchObject({
      ensured: 1,
      idleEnded: 0,
      orphansEnded: 0,
    });
    expect(await w.live.view.roomsNamed(w.live.settings.roomNamePrefix)).toEqual([w.room]);
    expect(await w.live.session(w.sessionId)).toMatchObject({ state: 'live', mediaRoomEpoch: 0 });
    expect(
      (await w.live.sessions.findLiveByCommunity((await w.live.session(w.sessionId)).communityId))
        ?.id,
    ).toBe(w.sessionId);
    expect([w.live.audits().length, w.live.eventNames().length]).toEqual([audits, events]);

    // The same ticket flow as before brings the member back into it.
    const back = await clients.connect(await ticket(w, w.students[0]));
    expect(back.room.name).toBe(w.room);
    await eventually('the server holding student-1 again', async () =>
      (await w.live.view.identities(w.room)).includes('student-1'),
    );
    await w.live.end.execute({ principal: w.owner, sessionId: w.sessionId, meta: META });
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), ...harnesses.map((live) => live.view.logText())];
    expect(
      leakedCredentials(
        written.join('\n'),
        harnesses.map((l) => l.server.apiSecret),
      ),
    ).toEqual([]);
  });
});
