import { TrackSource } from 'livekit-server-sdk';

import { Permissions } from '../../src/modules/identity/contracts';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../src/modules/identity/domain/provisional-policy';
import type { Principal } from '../../src/shared';
import { META, captureLogs } from '../support/live-harness';
import { mediaClients } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { leakedCredentials } from './support/server-view';

/** `livekit.ParticipantInfo.Kind` STANDARD: a person — not an agent, a recorder or a SIP line. */
const STANDARD = 0;

/** What LiveKit holds for a participant who may publish nothing (PGO grants.go). */
const LISTENING = {
  canPublish: false,
  canPublishSources: [],
  canSubscribe: true,
  canPublishData: false,
  canUpdateMetadata: false,
  hidden: false,
};

/**
 * Who may publish what, as the application grants it (live.md §3.6, P6
 * decision 1) — enforced by the pinned LiveKit server itself on the tokens
 * `/join` issues, with a real WebRTC client publishing real tracks (brief
 * §10, items 1–7 and 12):
 *
 *   - a listener connects, as the identity, name and room the application
 *     issued, and publishes nothing — not even a microphone;
 *   - a speaker (a student whose hand was granted) publishes the
 *     microphone, and cannot share a screen;
 *   - a moderator holding `live.speak` publishes the microphone by right;
 *     one without it publishes nothing;
 *   - the screen only for a moderator holding `live.speak` who claimed the
 *     presenter slot: refused before the claim, published after it;
 *   - revoking a speaker through the use case makes the server take the
 *     published microphone away.
 *
 * A refusal is read on the server, within a bounded wait: its own "no
 * permission to publish track" answer, and no such track in its list.
 */
describe('publishing on the pinned LiveKit server, as the application grants it', () => {
  const clients = mediaClients();
  let logs: ReturnType<typeof captureLogs>;
  let live: RealLive;
  let owner: Principal;
  let listener: Principal;
  let communityId: string;
  let sessionId: string;
  let room: string;

  beforeAll(async () => {
    logs = captureLogs();
    live = realLive();
    const community = await live.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = community);
    // The names the account directory gives: what the server must show.
    live.person('teacher-1', ['TEACHER'], 'الأستاذة عائشة');
    listener = live.person('student-1', ['STUDENT'], 'مريم');
    sessionId = (await live.startSession(owner, communityId)).id;
    room = live.room(sessionId);
  });

  afterAll(async () => {
    await clients.closeAll();
    await live.end.execute({ principal: owner, sessionId, meta: META });
    jest.restoreAllMocks();
  });

  /** `/join`'s ticket for `principal`. */
  async function ticket(principal: Principal) {
    const joined = await live.join.execute({ principal, sessionId, meta: META });
    if (!joined.ok) throw new Error(`could not join: ${joined.error.code}`);
    return joined.value;
  }

  /** A student whose raised hand the host granted — a speaker — and that hand. */
  async function speaker(userId: string): Promise<{ student: Principal; requestId: string }> {
    const student = await live.member(communityId, owner, userId);
    const hand = await live.raised(student, sessionId);
    const granted = await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    if (!granted.ok) throw new Error(`could not grant: ${granted.error.code}`);
    return { student, requestId: hand.id };
  }

  it('admits a listener as the identity, name and room the application issued — holding a listener’s permission', async () => {
    const joined = await ticket(listener);
    expect(joined).toMatchObject({
      role: 'listener',
      url: live.server.url,
      media: { microphone: false, screen: false, screenAudio: false },
    });

    const client = await clients.connect(joined);
    expect({ room: client.room.name, identity: client.identity, name: client.name }).toEqual({
      room,
      identity: 'student-1',
      name: 'مريم',
    });
    // The server's own record: the token's identity, the directory's name,
    // a standard participant, and nothing to publish.
    const held = await live.view.participant(room, 'student-1');
    expect(held).toMatchObject({
      identity: 'student-1',
      name: 'مريم',
      kind: STANDARD,
      permission: LISTENING,
    });
  });

  it('refuses a listener’s microphone: the server answers NOT_ALLOWED and holds no track', async () => {
    const another = await live.member(communityId, owner, 'student-4');
    const client = await clients.connect(await ticket(another));
    const mark = live.view.mark();
    client.publish('microphone');
    expect(await live.view.refused(room, 'student-4', 'AUDIO', mark)).toEqual([]);
  });

  it('lets a speaker — a student whose hand was granted — publish the microphone, and never a screen', async () => {
    const { student } = await speaker('student-2');
    const joined = await ticket(student);
    expect(joined).toMatchObject({ role: 'speaker', media: { microphone: true, screen: false } });
    const client = await clients.connect(joined);

    expect(await client.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-2', TrackSource.MICROPHONE);
    expect((await live.view.participant(room, 'student-2'))?.permission).toMatchObject({
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canPublishData: false,
    });

    const mark = live.view.mark();
    client.publish('screen_share');
    expect(await live.view.refused(room, 'student-2', 'VIDEO', mark)).toEqual([
      TrackSource.MICROPHONE,
    ]);
  });

  it('lets a moderator holding live.speak — the host — publish the microphone by right', async () => {
    const joined = await ticket(owner);
    expect(joined).toMatchObject({ role: 'moderator', media: { microphone: true, screen: false } });
    const client = await clients.connect(joined);
    expect(client.name).toBe('الأستاذة عائشة');
    expect(await client.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'teacher-1', TrackSource.MICROPHONE);
    // By right, the microphone only: no screen without the presenter slot.
    expect((await live.view.participant(room, 'teacher-1'))?.permission).toMatchObject({
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
    });
  });

  it('lets a moderator without live.speak publish nothing', async () => {
    const delegate = await live.delegate(
      communityId,
      owner,
      'teacher-2',
      'community.live.moderate',
    );
    const withoutSpeak = PROVISIONAL_ROLE_PERMISSIONS.TEACHER.filter(
      (permission) => permission !== Permissions.live.speak,
    );
    live.accounts.setPermissions('teacher-2', withoutSpeak);
    const silent: Principal = { ...delegate, permissions: new Set<string>(withoutSpeak) };

    const joined = await ticket(silent);
    expect(joined).toMatchObject({
      role: 'moderator',
      media: { microphone: false, screen: false },
    });
    const client = await clients.connect(joined);
    expect((await live.view.participant(room, 'teacher-2'))?.permission).toMatchObject(LISTENING);
    const mark = live.view.mark();
    client.publish('microphone');
    expect(await live.view.refused(room, 'teacher-2', 'AUDIO', mark)).toEqual([]);
  });

  it('lets a moderator holding live.speak share a screen only once they claimed the presenter slot', async () => {
    const moderator = await live.delegate(
      communityId,
      owner,
      'teacher-3',
      'community.live.moderate',
    );
    const joined = await ticket(moderator);
    expect(joined).toMatchObject({ role: 'moderator', media: { microphone: true, screen: false } });

    // Without the claim: the server refuses the screen.
    const unclaimed = await clients.connect(joined);
    const mark = live.view.mark();
    unclaimed.publish('screen_share');
    expect(await live.view.refused(room, 'teacher-3', 'VIDEO', mark)).toEqual([]);
    // (The client waits on its refused track until it leaves: it reconnects
    // before publishing again, still without the claim.)
    await unclaimed.disconnect();
    const client = await clients.connect(await ticket(moderator));

    // The claim pushes the full set — the screen with it — to the connected participant…
    const claimed = await live.presenter.claim({ principal: moderator, sessionId, meta: META });
    expect(claimed.ok && claimed.value.opened).toBe(true);
    expect((await live.view.participant(room, 'teacher-3'))?.permission).toMatchObject({
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
    });
    // …and the same connection now publishes a screen.
    expect(await client.publish('screen_share').outcome).toBe('published');
    await live.view.published(room, 'teacher-3', TrackSource.SCREEN_SHARE);
    // A fresh ticket carries it too.
    expect((await ticket(moderator)).media).toEqual({
      microphone: true,
      screen: true,
      screenAudio: false,
    });
  });

  it('takes the microphone away when the floor is revoked through the use case', async () => {
    const { student, requestId } = await speaker('student-3');
    const client = await clients.connect(await ticket(student));
    expect(await client.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-3', TrackSource.MICROPHONE);

    const revoked = await live.moderate.revoke({ principal: owner, requestId, meta: META });
    expect(revoked.ok && revoked.value.media).toBe('applied');
    // The server unpublishes it itself, and holds a listener's permission.
    await live.view.unpublished(room, 'student-3', TrackSource.MICROPHONE);
    expect((await live.view.participant(room, 'student-3'))?.permission).toMatchObject(LISTENING);
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
