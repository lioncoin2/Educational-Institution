import { TrackSource } from 'livekit-server-sdk';

import { Permissions } from '../../src/modules/identity/contracts';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../src/modules/identity/domain/provisional-policy';
import type { Principal } from '../../src/shared';
import { META, captureLogs, codeOf } from '../support/live-harness';
import { mediaClients, type MediaClient } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { leakedCredentials } from './support/server-view';

/** What LiveKit holds for a participant who may publish nothing (PGO grants.go). */
const LISTENING = { canPublish: false, canPublishSources: [] };
/** …for one who may publish the microphone only. */
const SPEAKING = { canPublish: true, canPublishSources: [TrackSource.MICROPHONE] };
/** …and for the presenter: the microphone and a screen. */
const PRESENTING = {
  canPublish: true,
  canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
};

/**
 * The presenter slot on the pinned server, with a real WebRTC client
 * sharing a real screen (brief §10, items 13 and 14; live.md §3.6: the
 * screen is the presenter's, and the slot a moderator's who holds
 * `live.speak`):
 *
 *   - its holder stopping, a moderator taking it back, and the holder
 *     losing `live.speak` each close the slot, and the server takes the
 *     screen away from the connection — the microphone with it only when
 *     `live.speak` itself is gone;
 *   - a student — even one on the floor — and a member who moderates
 *     nothing are refused the slot, and nothing is pushed: the server holds
 *     what it held, and refuses their screen.
 */
describe('the presenter slot on the pinned LiveKit server', () => {
  const clients = mediaClients();
  let logs: ReturnType<typeof captureLogs>;
  let live: RealLive;
  let owner: Principal;
  let communityId: string;
  let sessionId: string;
  let room: string;
  let presenter: Principal;
  let screen: MediaClient;

  beforeAll(async () => {
    logs = captureLogs();
    live = realLive();
    const community = await live.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = community);
    sessionId = (await live.startSession(owner, communityId)).id;
    room = live.room(sessionId);
    presenter = await live.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    screen = await clients.connect(await ticket(presenter));
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

  const permissionOf = async (identity: string) =>
    (await live.view.participant(room, identity))?.permission;

  const closedLines = () =>
    logs.lines
      .map((line) => line.fields)
      .filter((fields) => fields.event === 'live.presenter.closed');

  /** teacher-2 claims the slot and its connection shares a screen. */
  async function presenting(): Promise<void> {
    const claimed = await live.presenter.claim({ principal: presenter, sessionId, meta: META });
    expect(claimed.ok && claimed.value.opened).toBe(true);
    expect(await permissionOf('teacher-2')).toMatchObject(PRESENTING);
    expect(await screen.publish('screen_share').outcome).toBe('published');
    await live.view.published(room, 'teacher-2', TrackSource.SCREEN_SHARE);
  }

  it('closes the slot when its holder stops: the server takes the screen away, and leaves the microphone', async () => {
    await presenting();
    const stopped = await live.presenter.stop({ principal: presenter, sessionId, meta: META });
    expect(stopped.ok).toBe(true);
    expect(closedLines().at(-1)).toMatchObject({ userId: 'teacher-2', reason: 'stopped' });

    await live.view.unpublished(room, 'teacher-2', TrackSource.SCREEN_SHARE);
    expect(await permissionOf('teacher-2')).toMatchObject(SPEAKING);
  });

  it('closes it when another moderator takes it back: the screen goes the same way', async () => {
    await presenting();
    const taken = await live.presenter.stop({ principal: owner, sessionId, meta: META });
    expect(taken.ok).toBe(true);
    expect(closedLines().at(-1)).toMatchObject({
      userId: 'teacher-2',
      by: 'teacher-1',
      reason: 'revoked',
    });

    await live.view.unpublished(room, 'teacher-2', TrackSource.SCREEN_SHARE);
    expect(await permissionOf('teacher-2')).toMatchObject(SPEAKING);
  });

  it('closes it when its holder loses live.speak — at the participant sweep, with no event to say so — and the server takes screen and microphone', async () => {
    await presenting();
    live.accounts.setPermissions(
      'teacher-2',
      PROVISIONAL_ROLE_PERMISSIONS.TEACHER.filter(
        (permission) => permission !== Permissions.live.speak,
      ),
    );

    expect(await live.reconciler.sweepParticipants()).toMatchObject({
      skipped: null,
      corrected: 1,
      violations: 0,
      resets: 0,
    });
    expect(await live.presenters.activeGrants(sessionId)).toEqual([]);
    await live.view.unpublished(room, 'teacher-2', TrackSource.SCREEN_SHARE);
    expect(await permissionOf('teacher-2')).toMatchObject(LISTENING);
    expect(await live.view.publishing(room, 'teacher-2')).toEqual([]);
  });

  it('refuses the slot to a student on the floor and to a member who moderates nothing — pushing nothing — and the server refuses their screens', async () => {
    // student-1 of THIS community, on the floor and speaking.
    const speaker = live.person('student-1', ['STUDENT']);
    const hand = await live.raised(speaker, sessionId);
    await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    const onFloor = await clients.connect(await ticket(speaker));
    expect(await onFloor.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-1', TrackSource.MICROPHONE);
    // A teacher who is a member, and moderates nothing here.
    const member = await live.member(communityId, owner, 'teacher-3', ['TEACHER']);
    const memberClient = await clients.connect(await ticket(member));

    const pushesBefore = logs.lines.filter(
      (line) => line.fields.event === 'live.media.authorization_changed',
    ).length;
    for (const [principal, code] of [
      [speaker, 'identity.permission_denied'],
      [member, 'live.not_a_moderator'],
    ] as const) {
      expect(codeOf(await live.presenter.claim({ principal, sessionId, meta: META }))).toBe(code);
    }
    expect(await live.presenters.activeGrants(sessionId)).toEqual([]);
    // Nothing pushed to anyone.
    expect(
      logs.lines.filter((line) => line.fields.event === 'live.media.authorization_changed'),
    ).toHaveLength(pushesBefore);
    expect(await permissionOf('student-1')).toMatchObject(SPEAKING);
    expect(await permissionOf('teacher-3')).toMatchObject(LISTENING);

    for (const [client, identity, holds] of [
      [onFloor, 'student-1', [TrackSource.MICROPHONE]],
      [memberClient, 'teacher-3', []],
    ] as const) {
      const mark = live.view.mark();
      client.publish('screen_share');
      expect(await live.view.refused(room, identity, 'VIDEO', mark)).toEqual(holds);
    }
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
