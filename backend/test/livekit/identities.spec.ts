import { TrackSource } from 'livekit-server-sdk';

import type { Principal } from '../../src/shared';
import { META, captureLogs } from '../support/live-harness';
import { mediaClients, type MediaClient } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { eventually, leakedCredentials } from './support/server-view';
import { RawSignalling } from './support/signalling';

/** `livekit.ParticipantInfo.Kind` STANDARD: a person — not an agent, a recorder or a SIP line. */
const STANDARD = 0;

/** What the client chose — never in a log line. */
const SUFFIX = 'client-chosen-suffix';
/** The participant LiveKit makes of student-1's token with `publish=<SUFFIX>`. */
const FOREIGN = `student-1#${SUFFIX}`;

/**
 * The identity contract against the pinned server (P7.1, decision 6; audit
 * S2; brief §10, item 11). The application issues one media identity per
 * account, the account id; but LiveKit v1.13.7 joins a publishing token,
 * presented with the `publish` connect parameter, as a SECOND standard
 * participant `<account id>#<publish>` (SRV pkg/service/utils.go:378-387),
 * and no server option turns that off. So the reconciler removes every
 * standard participant it never issued: the participant sweep at once, and
 * the watch whenever it comes back — while the participant the application
 * issued stays, publishing. Here the account still holds its floor — it may
 * publish what its second identity held — so never a violation and never a
 * media reset. A WITHDRAWN publisher's second identities count against its
 * account (P7.2 decision R1; src/modules/live/application/
 * live-reconciler-foreign-breach.spec.ts). And nothing the client chose in
 * any of the application's log lines.
 */
describe('identities the application never issued, on the pinned LiveKit server', () => {
  const clients = mediaClients();
  const sockets: RawSignalling[] = [];
  let logs: ReturnType<typeof captureLogs>;
  let live: RealLive;
  let owner: Principal;
  let sessionId: string;
  let room: string;
  let token: string;
  let listenerToken: string;
  let speaker: MediaClient;

  beforeAll(async () => {
    logs = captureLogs();
    live = realLive();
    const community = await live.community('teacher-1', 'student-1', 'student-2');
    owner = community.owner;
    const [student, listener] = community.students;
    sessionId = (await live.startSession(owner, community.id)).id;
    room = live.room(sessionId);

    // student-1 on the floor, publishing the microphone with its own ticket.
    const hand = await live.raised(student, sessionId);
    await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    const joined = await live.join.execute({ principal: student, sessionId, meta: META });
    if (!joined.ok) throw new Error(joined.error.code);
    token = joined.value.token;
    speaker = await clients.connect(joined.value);
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-1', TrackSource.MICROPHONE);

    // A listener, too: its ticket cannot be used this way at all.
    const heard = await live.join.execute({ principal: listener, sessionId, meta: META });
    if (!heard.ok) throw new Error(heard.error.code);
    listenerToken = heard.value.token;
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await clients.closeAll();
    await live.end.execute({ principal: owner, sessionId, meta: META });
    jest.restoreAllMocks();
  });

  /** The speaker's own token on a bare signalling connection, with `publish=<SUFFIX>`. */
  async function foreignConnection(): Promise<RawSignalling> {
    const opened = await RawSignalling.open(live.server.url, token, SUFFIX);
    if (!(opened instanceof RawSignalling)) throw new Error(`refused: ${opened.refused}`);
    sockets.push(opened);
    await eventually(`the server holding ${FOREIGN}`, async () =>
      (await live.view.identities(room)).includes(FOREIGN),
    );
    return opened;
  }

  /** In the room: the speaker alone, still connected and still publishing. */
  async function expectOnlyTheSpeaker(): Promise<void> {
    expect(await live.view.identities(room)).toEqual(['student-1']);
    expect(speaker.room.isConnected).toBe(true);
    expect(await live.view.publishing(room, 'student-1')).toEqual([TrackSource.MICROPHONE]);
  }

  it('joins a second, standard participant from a publishing token — and never from a listener’s', async () => {
    expect(await RawSignalling.open(live.server.url, listenerToken, SUFFIX)).toEqual({
      refused: 401,
    });

    const foreign = await foreignConnection();
    // As the server holds it: standard, with the token's microphone and no subscription.
    expect(await live.view.participant(room, FOREIGN)).toMatchObject({
      kind: STANDARD,
      permission: {
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: false,
      },
    });
    foreign.close();
    await eventually(
      `the server letting ${FOREIGN} go`,
      async () => !(await live.view.identities(room)).includes(FOREIGN),
    );
  });

  it('removes it at the participant sweep, and again at the watch when it comes back — the participant the application issued stays and publishes', async () => {
    const foreign = await foreignConnection();
    expect(await live.reconciler.sweepParticipants()).toMatchObject({
      skipped: null,
      foreignRemoved: 1,
      removed: 0,
      corrected: 0,
      violations: 0,
      resets: 0,
    });
    // The server dropped it and closed its connection; the speaker is untouched.
    expect(await foreign.closedByServer()).toBeGreaterThan(0);
    await expectOnlyTheSpeaker();

    // Back again, within the watch's window: the watch looks for it, and removes it.
    const back = await foreignConnection();
    expect(await live.reconciler.watchTick()).toMatchObject({
      skipped: null,
      foreignRemoved: 1,
      violations: 0,
      resets: 0,
    });
    expect(await back.closedByServer()).toBeGreaterThan(0);
    await expectOnlyTheSpeaker();

    // Its account may publish the microphone: not a breach, so no violation
    // and no media reset — the session keeps its room.
    const stored = await live.session(sessionId);
    expect({ epoch: stored.mediaRoomEpoch, violations: stored.enforcementViolations }).toEqual({
      epoch: 0,
      violations: 0,
    });
    // Logged by session and account only — never what the client chose.
    const removals = logs.lines
      .map((line) => line.fields)
      .filter((fields) => fields.event === 'live.reconciler.foreign_identity_removed');
    expect(removals).toEqual([
      {
        event: 'live.reconciler.foreign_identity_removed',
        sessionId,
        userId: 'student-1',
        outcome: 'applied',
      },
      {
        event: 'live.reconciler.foreign_identity_removed',
        sessionId,
        userId: 'student-1',
        outcome: 'applied',
      },
    ]);
    expect(JSON.stringify(logs.lines)).not.toContain(SUFFIX);
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
