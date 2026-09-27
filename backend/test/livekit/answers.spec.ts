import { TrackSource } from 'livekit-server-sdk';

import { LiveMedia } from '../../src/modules/live/application/live-media';
import { LiveMediaReadiness } from '../../src/modules/live/application/live-media-readiness';
import { IDLE_END_SECONDS } from '../../src/modules/live/domain/live-limits';
import {
  RtcUnavailableError,
  type RtcCapabilities,
} from '../../src/modules/live/domain/rtc-provider';
import type { LiveKitRtcProvider } from '../../src/modules/live/infrastructure/livekit-rtc-provider';
import { loadConfig } from '../../src/platform/config/app-config';
import type { Principal } from '../../src/shared';
import { META, captureLogs } from '../support/live-harness';
import {
  startStubHttpServer,
  type StubAnswer,
  type StubHttpServer,
} from '../support/stub-http-server';
import { mediaClients } from './support/media-client';
import { realAdapter, realLive, realMediaEnv, type RealLive } from './support/real-live';
import { leakedCredentials } from './support/server-view';

const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

/** Someone who is in no room. */
const NOBODY = 'student-9';

/** The rooms the calls are about: the session's, and one nobody made. */
interface Rooms {
  readonly live: string;
  readonly missing: string;
}

/**
 * Every adapter call that may answer "not there" — a room already gone, a
 * participant not connected — made about a room (`live`, the session's) and
 * a room nobody made (`missing`).
 */
const MAY_BE_ABSENT = {
  endRoom: (rtc: LiveKitRtcProvider, rooms: Rooms) => rtc.endRoom(rooms.missing),
  listParticipants: (rtc: LiveKitRtcProvider, rooms: Rooms) => rtc.listParticipants(rooms.missing),
  getParticipant: (rtc: LiveKitRtcProvider, rooms: Rooms) => rtc.getParticipant(rooms.live, NOBODY),
  updateCapabilities: (rtc: LiveKitRtcProvider, rooms: Rooms) =>
    rtc.updateCapabilities(rooms.live, NOBODY, LISTENER),
  removeParticipant: (rtc: LiveKitRtcProvider, rooms: Rooms) =>
    rtc.removeParticipant(rooms.live, NOBODY, { revokeTokensIssuedBefore: new Date() }),
  muteParticipant: (rtc: LiveKitRtcProvider, rooms: Rooms) =>
    rtc.muteParticipant(rooms.live, NOBODY, ['microphone']),
} as const;
type Call = keyof typeof MAY_BE_ABSENT;

/** What each call came to: the answer it resolved to, an outage, or a fault. */
async function outcomes(rtc: LiveKitRtcProvider, rooms: Rooms): Promise<Record<Call, unknown>> {
  const all = {} as Record<Call, unknown>;
  for (const call of Object.keys(MAY_BE_ABSENT) as Call[]) {
    try {
      all[call] = { answered: await MAY_BE_ABSENT[call](rtc, rooms) };
    } catch (error) {
      all[call] = error instanceof RtcUnavailableError ? 'outage' : 'fault';
    }
  }
  return all;
}

/**
 * Only LiveKit's own "not found" means absent (P7.1, decision 5; audit S1;
 * brief §10, item 13). The same adapter calls, side by side:
 *
 *   - against the pinned server, about a room or a participant it does not
 *     have: absence, as the port reports it — ended already, nobody there,
 *     `not_connected`;
 *   - against something else on the API URL — a proxy's 404 page, a JSON 404
 *     without LiveKit's code, a 200 that is not LiveKit's JSON: a fault,
 *     every time, never absence and never success;
 *   - and so the reconciler, pointed there, takes no room for missing and
 *     no participant for gone: its sweeps do nothing at all, the session
 *     stays live and its speaker keeps the microphone — and a push reports
 *     `pending`, never `not_connected`.
 */
describe('answers that are not LiveKit’s, beside the pinned server’s own', () => {
  const clients = mediaClients();
  let logs: ReturnType<typeof captureLogs>;
  let stub: StubHttpServer;
  let live: RealLive;
  /** The same deployment with LIVEKIT_API_URL on the stub: a wrong endpoint. */
  let misdirected: LiveKitRtcProvider;
  let owner: Principal;
  let student: Principal;
  let sessionId: string;
  let rooms: Rooms;

  beforeAll(async () => {
    logs = captureLogs();
    stub = await startStubHttpServer();
    live = realLive();
    misdirected = realAdapter(
      loadConfig(
        realMediaEnv(live.server, {
          LIVE_ROOM_NAME_PREFIX: live.settings.roomNamePrefix,
          LIVEKIT_API_URL: stub.url,
        }),
      ),
    );
    const community = await live.community('teacher-1', 'student-1');
    ({ owner } = community);
    [student] = community.students;
    sessionId = (await live.startSession(owner, community.id)).id;
    rooms = { live: live.room(sessionId), missing: `${live.settings.roomNamePrefix}missing` };
  });

  afterAll(async () => {
    await clients.closeAll();
    await stub.close();
    jest.restoreAllMocks();
  });

  it('reads the pinned server’s own "not found" as absence — room and participant alike', async () => {
    expect(await outcomes(live.adapter, rooms)).toEqual({
      endRoom: { answered: undefined },
      listParticipants: { answered: [] },
      getParticipant: { answered: null },
      updateCapabilities: { answered: 'not_connected' },
      removeParticipant: { answered: 'not_connected' },
      muteParticipant: { answered: 'not_connected' },
    });
  });

  it.each<[string, StubAnswer]>([
    [
      'a proxy’s 404 page',
      { status: 404, contentType: 'text/html', body: '<h1>404 Not Found</h1>' },
    ],
    [
      'a JSON 404 without LiveKit’s code',
      { status: 404, contentType: 'application/json', body: '{"error":"not found"}' },
    ],
    [
      'a 200 that is not LiveKit’s JSON',
      { status: 200, contentType: 'text/html', body: '<p>OK</p>' },
    ],
  ])('reads %s on the API URL as a fault — never absence, never success', async (_case, answer) => {
    stub.answer(answer);
    expect(await outcomes(misdirected, rooms)).toEqual({
      endRoom: 'fault',
      listParticipants: 'fault',
      getParticipant: 'fault',
      updateCapabilities: 'fault',
      removeParticipant: 'fault',
      muteParticipant: 'fault',
    });
  });

  it('keeps the reconciler, pointed there, from taking the room for missing or its people for gone', async () => {
    stub.answer({ status: 404, contentType: 'text/html', body: '<h1>404 Not Found</h1>' });
    // student-1 on the floor, publishing, on the real server.
    const hand = await live.raised(student, sessionId);
    await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    const joined = await live.join.execute({ principal: student, sessionId, meta: META });
    if (!joined.ok) throw new Error(joined.error.code);
    const speaker = await clients.connect(joined.value);
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await live.view.published(rooms.live, 'student-1', TrackSource.MICROPHONE);

    const session = await live.session(sessionId);
    const reconciler = live.reconcilerWith(misdirected);
    // The room list is unreadable: nothing ensured, nothing ended.
    expect(await reconciler.sweepRooms()).toMatchObject({
      skipped: 'failed',
      ensured: 0,
      idleEnded: 0,
      orphansEnded: 0,
    });
    // Nobody's presence is decided from it: the session is skipped whole.
    expect(await reconciler.sweepParticipants()).toMatchObject({
      skipped: null,
      sessionsSkipped: 1,
      removed: 0,
      corrected: 0,
    });
    // A push through it is pending — never "not connected".
    const media = new LiveMedia(misdirected, live.standing, live.settings, live.clock);
    expect(await media.push(session, 'student-1')).toBe('pending');

    // And on the real server nothing changed.
    expect((await live.session(sessionId)).state).toBe(session.state);
    expect(await live.view.roomsNamed(rooms.live)).toEqual([rooms.live]);
    expect(await live.view.publishing(rooms.live, 'student-1')).toEqual([TrackSource.MICROPHONE]);
    await live.end.execute({ principal: owner, sessionId, meta: META });
  });

  it('never takes a wrong endpoint that says 200 {} to everything for an empty server: no live session is ended idle', async () => {
    // A second session, long "empty" by its record: the one an empty room
    // list would end idle at the next room sweep.
    const community = await live.community('teacher-2', 'student-2');
    const idle = await live.startSession(community.owner, community.id);
    const past = new Date(live.clock.now().getTime() - (IDLE_END_SECONDS + 60) * 1000);
    await live.sessions.markEmpty(idle.id, past);

    stub.answer({ status: 200, contentType: 'application/json', body: '{}' });
    // The misdirected deployment's own self-check: the room API answers, but
    // /rtc/validate does not say what LiveKit says.
    const readiness = new LiveMediaReadiness(misdirected, live.clock);
    expect(await readiness.refresh()).toEqual({ ready: false, reason: 'incompatible_response' });

    const reconciler = live.reconcilerWith(misdirected, readiness);
    expect(await reconciler.sweepRooms()).toEqual({
      skipped: 'provider_incompatible',
      sessions: 0,
      sessionsSkipped: 0,
      ensured: 0,
      idleEnded: 0,
      orphansEnded: 0,
    });
    // Still live, and its room still on the real server.
    expect((await live.session(idle.id)).state).toBe('live');
    expect(await live.view.roomsNamed(live.room(idle.id))).toEqual([live.room(idle.id)]);
    await live.end.execute({ principal: community.owner, sessionId: idle.id, meta: META });
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
