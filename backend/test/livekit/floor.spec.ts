import { TrackSource } from 'livekit-server-sdk';

import type { Principal } from '../../src/shared';
import { META, captureLogs } from '../support/live-harness';
import { mediaClients, type MediaClient } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { eventually, leakedCredentials } from './support/server-view';

/** What LiveKit holds for a participant who may publish nothing (PGO grants.go). */
const LISTENING = { canPublish: false, canPublishSources: [], canSubscribe: true };
/** …and for one who may publish the microphone. */
const SPEAKING = { canPublish: true, canPublishSources: [TrackSource.MICROPHONE] };

/**
 * The floor on the pinned server, connection by connection, with real
 * WebRTC clients (brief §10, items 8, 11, 18 and 23):
 *
 *   - a grant reaches the listener's connection as it is: the server holds
 *     the microphone for it at once, and the same connection publishes;
 *   - a revoke takes it back from that connection, and the server refuses
 *     the same connection the microphone again;
 *   - a reconnect keeps the application's decision: the granted speaker
 *     comes back a speaker, the revoked one a listener;
 *   - grants, revokes and yields landing together leave the server holding
 *     exactly what the stored floor gives, however they interleave.
 */
describe('the floor on the pinned LiveKit server, connection by connection', () => {
  const clients = mediaClients();
  let logs: ReturnType<typeof captureLogs>;
  let live: RealLive;
  let owner: Principal;
  let communityId: string;
  let students: readonly Principal[];
  let sessionId: string;
  let room: string;

  beforeAll(async () => {
    logs = captureLogs();
    live = realLive();
    const community = await live.community('teacher-1', 'student-1', 'student-2', 'student-3');
    ({ id: communityId, owner, students } = community);
    sessionId = (await live.startSession(owner, communityId)).id;
    room = live.room(sessionId);
  });

  afterAll(async () => {
    await clients.closeAll();
    await live.end.execute({ principal: owner, sessionId, meta: META });
    jest.restoreAllMocks();
  });

  async function ticket(principal: Principal) {
    const joined = await live.join.execute({ principal, sessionId, meta: META });
    if (!joined.ok) throw new Error(`could not join: ${joined.error.code}`);
    return joined.value;
  }

  /** The participant the server holds for `identity`. */
  async function held(identity: string) {
    const participant = await live.view.participant(room, identity);
    if (participant === undefined) throw new Error(`The server holds no ${identity}.`);
    return participant;
  }

  async function raise(student: Principal): Promise<string> {
    return (await live.raised(student, sessionId)).id;
  }

  /** student-1's connection, made as a listener in the first test and kept throughout. */
  let first: MediaClient;
  let firstHand: string;
  /** Its session on the server: the same while the connection is. */
  let firstSid: string;

  it('pushes a grant to a connected listener: the same connection, never reconnected, publishes the microphone', async () => {
    const joined = await ticket(students[0]);
    expect(joined).toMatchObject({ role: 'listener', media: { microphone: false } });
    first = await clients.connect(joined);
    firstSid = (await held('student-1')).sid;
    expect((await held('student-1')).permission).toMatchObject(LISTENING);

    firstHand = await raise(students[0]);
    const granted = await live.moderate.grant({
      principal: owner,
      requestId: firstHand,
      meta: META,
    });
    expect(granted.ok && granted.value.media).toBe('applied');
    expect((await held('student-1')).permission).toMatchObject(SPEAKING);

    expect(await first.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-1', TrackSource.MICROPHONE);
    expect(first.room.isConnected).toBe(true);
    expect((await held('student-1')).sid).toBe(firstSid);
  });

  it('takes the floor back from that connection — and the server refuses the same connection the microphone again', async () => {
    const revoked = await live.moderate.revoke({
      principal: owner,
      requestId: firstHand,
      meta: META,
    });
    expect(revoked.ok && revoked.value.media).toBe('applied');
    await live.view.unpublished(room, 'student-1', TrackSource.MICROPHONE);
    expect((await held('student-1')).permission).toMatchObject(LISTENING);

    const mark = live.view.mark();
    first.publish('microphone');
    expect(await live.view.refused(room, 'student-1', 'AUDIO', mark)).toEqual([]);
    // Still the same connection: nothing but the application's push changed it.
    expect((await held('student-1')).sid).toBe(firstSid);
  });

  it('keeps the application’s decision across a reconnect: the granted speaker is a speaker again, the revoked one a listener', async () => {
    const hand = await raise(students[1]);
    await live.moderate.grant({ principal: owner, requestId: hand, meta: META });
    const speaker = await clients.connect(await ticket(students[1]));
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-2', TrackSource.MICROPHONE);

    for (const client of [speaker, first]) await client.disconnect();
    await eventually(
      'the server letting both go',
      async () => (await live.view.identities(room)).length === 0,
    );

    // The granted one: a speaker's ticket, and the microphone published.
    const again = await ticket(students[1]);
    expect(again).toMatchObject({ role: 'speaker', media: { microphone: true } });
    const back = await clients.connect(again);
    expect(await back.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-2', TrackSource.MICROPHONE);

    // The revoked one: a listener's ticket, and the microphone refused.
    const demoted = await ticket(students[0]);
    expect(demoted).toMatchObject({ role: 'listener', media: { microphone: false } });
    const listener = await clients.connect(demoted);
    expect((await held('student-1')).permission).toMatchObject(LISTENING);
    const mark = live.view.mark();
    listener.publish('microphone');
    expect(await live.view.refused(room, 'student-1', 'AUDIO', mark)).toEqual([]);
  });

  it('leaves the server holding exactly what the stored floor gives after moderation that lands together — whatever the order', async () => {
    const delegate = await live.delegate(
      communityId,
      owner,
      'teacher-2',
      'community.live.moderate',
    );
    const student = students[2];
    await clients.connect(await ticket(student));

    for (const order of [
      ['grant', 'revoke'],
      ['revoke', 'grant'],
      ['grant', 'lower'],
      ['lower', 'grant'],
      ['grant', 'revoke'],
    ] as const) {
      const requestId = await raise(student);
      const acts = {
        grant: () => live.moderate.grant({ principal: owner, requestId, meta: META }),
        revoke: () => live.moderate.revoke({ principal: delegate, requestId, meta: META }),
        lower: () => live.lower.execute({ principal: student, sessionId, meta: META }),
      };
      await Promise.all(order.map((act) => acts[act]()));

      // What is stored decides: a granted floor is the microphone, anything else none.
      const open = await live.requests.findOpen(sessionId, 'student-3');
      const expected = open?.state === 'granted' ? SPEAKING : LISTENING;
      expect((await held('student-3')).permission).toMatchObject(expected);
      // …and nothing lands after it: still so a moment later.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await held('student-3')).permission).toMatchObject(expected);

      if (open?.state === 'granted') {
        await live.moderate.revoke({ principal: owner, requestId, meta: META });
        expect((await held('student-3')).permission).toMatchObject(LISTENING);
      }
    }
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
