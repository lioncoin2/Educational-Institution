import { TrackSource } from 'livekit-server-sdk';

import type { RtcCapabilities } from '../../src/modules/live/domain/rtc-provider';
import type { Principal } from '../../src/shared';
import { META, captureLogs } from '../support/live-harness';
import { mediaClients, type MediaClient } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { eventually, leakedCredentials } from './support/server-view';

/** A listener's set, as the application grants it. */
const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

/** How long a packet the server would forward takes at most to arrive, on loopback — and then some. */
const GRACE_MS = 1_500;

/**
 * Listeners on the pinned server, with real WebRTC clients (brief §10,
 * items 4, 6 and 7): they hear, and send nothing.
 *
 *   - a listener subscribes to a speaker's microphone and hears it: real
 *     audio, a 440 Hz tone, through the server;
 *   - a listener's screen share is refused by the server itself;
 *   - a listener's data packets and texts are dropped by the server (SRV
 *     pkg/rtc/participant.go:2455, :2670) — while those of a participant
 *     whose token differs ONLY in `canPublishData`, signed by the same
 *     adapter for the same room, reach everyone: the control that shows the
 *     drop is the server's, not the client's;
 *   - a listener's own metadata and name changes are refused, the server
 *     logging why (participant.go:721), and it keeps the name the directory
 *     gave.
 */
describe('listeners on the pinned LiveKit server hear, and send nothing', () => {
  const clients = mediaClients();
  let logs: ReturnType<typeof captureLogs>;
  let live: RealLive;
  let owner: Principal;
  let communityId: string;
  let sessionId: string;
  let room: string;
  /** student-1, a listener subscribed to everything: where anything sent would arrive. */
  let hearer: MediaClient;

  beforeAll(async () => {
    logs = captureLogs();
    live = realLive();
    const community = await live.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = community);
    sessionId = (await live.startSession(owner, communityId)).id;
    room = live.room(sessionId);
    hearer = await clients.connect(await ticket(community.students[0]), true);
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

  /** A new member, connected as the listener `/join` makes them. */
  async function listener(userId: string): Promise<MediaClient> {
    const joined = await ticket(await live.member(communityId, owner, userId));
    expect(joined).toMatchObject({ role: 'listener', media: { microphone: false } });
    return clients.connect(joined);
  }

  it('lets a listener hear a speaker: the tone the speaker publishes reaches it through the server', async () => {
    const student = await live.member(communityId, owner, 'student-2');
    const hand = await live.raised(student, sessionId);
    await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    const speaker = await clients.connect(await ticket(student));
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-2', TrackSource.MICROPHONE);

    // Loud: a tone, not silence the codec could make up.
    expect(await hearer.heard('student-2')).toBeGreaterThan(1_000);
    // The server's own record: subscribed, publishing nothing.
    expect(await live.view.participant(room, 'student-1')).toMatchObject({
      permission: { canSubscribe: true, canPublish: false, canPublishData: false },
      tracks: [],
    });
  });

  it('refuses a listener’s screen share: the server answers NOT_ALLOWED, and nobody receives a screen', async () => {
    const client = await listener('student-3');
    const mark = live.view.mark();
    client.publish('screen_share');
    expect(await live.view.refused(room, 'student-3', 'VIDEO', mark)).toEqual([]);
    const published = hearer.room.remoteParticipants.get('student-3')?.trackPublications;
    expect([...(published?.values() ?? [])]).toEqual([]);
  });

  it('drops a listener’s data and text at the server — while the same packets from a participant allowed to send data reach everyone', async () => {
    const quiet = await listener('student-4');
    // The control: the same adapter, room and set — but for canPublishData.
    const control = await clients.connect(
      await live.adapter.issueAccessToken({
        roomName: room,
        identity: 'control-1',
        displayName: 'control',
        capabilities: { ...LISTENER, canPublishData: true },
        ttlSeconds: live.settings.joinTokenTtlSeconds,
      }),
    );

    // Everyone known to the hearer first: the server announces a participant
    // who publishes nothing in batches (SRV pkg/rtc/room.go:56, :2263), and a
    // packet from someone not yet announced arrives with no sender.
    await eventually('the hearer knowing both senders', () =>
      ['student-4', 'control-1'].every((identity) => hearer.room.remoteParticipants.has(identity)),
    );

    // The listener's first — and its client sends them.
    expect(await quiet.sendData('from the listener')).toBe('sent');
    expect(await quiet.sendText('text from the listener')).toBe('sent');
    expect(await control.sendData('from the control')).toBe('sent');
    expect(await control.sendText('text from the control')).toBe('sent');

    await eventually('the control’s data and text reaching the hearer', () =>
      ['data', 'text'].every((kind) =>
        hearer.received.some((got) => got.kind === kind && got.from === 'control-1'),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS));
    // The control's two, and nothing of the listener's — from anyone.
    expect([...hearer.received].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: 'data', from: 'control-1', text: 'from the control' },
      { kind: 'text', from: 'control-1', text: 'text from the control' },
    ]);
    await control.disconnect();
  });

  it('refuses a listener’s own metadata and name: the server says why, and keeps the name the directory gave', async () => {
    const client = await listener('student-5');
    for (const change of [{ metadata: '{"role":"host"}' }, { name: 'الإدارة' }]) {
      const mark = live.view.mark();
      client.update(change);
      await live.view.logged(
        'the server refusing student-5 its own update',
        mark,
        (line) =>
          line.msg === 'could not update metadata' &&
          line.participant === 'student-5' &&
          line.error === 'update own metadata not allowed',
      );
    }
    expect(await live.view.participant(room, 'student-5')).toMatchObject({
      name: 'student-5',
      metadata: '',
      permission: { canUpdateMetadata: false },
    });
    // As everyone else in the room sees it, once announced (in a batch).
    const seen = await eventually('the hearer knowing student-5', () =>
      hearer.room.remoteParticipants.get('student-5'),
    );
    expect({ name: seen.name, metadata: seen.metadata }).toEqual({
      name: 'student-5',
      metadata: '',
    });
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
