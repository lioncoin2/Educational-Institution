import { TrackSource } from 'livekit-server-sdk';

import { ProtectLiveSessions } from '../../src/modules/live/application/protect-live-sessions';
import { InProcessEventBus } from '../../src/platform/events/event-bus';
import type { Principal } from '../../src/shared';
import { META, captureLogs, codeOf } from '../support/live-harness';
import { mediaClients, reasonName } from './support/media-client';
import { realLive, type RealLive } from './support/real-live';
import { leakedCredentials } from './support/server-view';

/** An id no session has. */
const UNKNOWN_SESSION = '00000000-0000-4000-8000-00000000abcd';

/**
 * Communities decides who is in a session's room — on the pinned server,
 * with real WebRTC clients, Communities' facts delivered through the bus to
 * `ProtectLiveSessions` as the module wires it (brief §10, items 16, 17
 * and 21):
 *
 *   - a member removed while connected is removed from the room by the
 *     server itself, the moment the fact is delivered, and refused a ticket
 *     after — with the same 404 as anyone who never belonged (Q-A);
 *   - a LOCKED community keeps its running session (Q46): nobody is
 *     removed, a member still joins, raises a hand and speaks — and no new
 *     session starts, nor any room;
 *   - a member of another community is refused exactly as an outsider is,
 *     and the ticket of their own session admits them to their own room
 *     only.
 */
describe('membership on the pinned LiveKit server: Communities decides who is in the room', () => {
  const clients = mediaClients();
  const thrown: unknown[] = [];
  let logs: ReturnType<typeof captureLogs>;
  let live: RealLive;
  let bus: InProcessEventBus;
  let protect: ProtectLiveSessions;
  let owner: Principal;
  let communityId: string;
  let students: readonly Principal[];
  let sessionId: string;
  let room: string;
  /** How many of Communities' events have been handed to the bus. */
  let delivered = 0;

  beforeAll(async () => {
    logs = captureLogs();
    live = realLive();
    bus = new InProcessEventBus((_event, error) => void thrown.push(error));
    protect = new ProtectLiveSessions(bus, live.sessions, live.reconciler);
    protect.onModuleInit();
    const community = await live.community('teacher-1', 'student-1', 'student-2', 'student-3');
    ({ id: communityId, owner, students } = community);
    sessionId = (await live.startSession(owner, communityId)).id;
    room = live.room(sessionId);
    delivered = live.communities.journal.events.length;
  });

  afterAll(async () => {
    await protect.onModuleDestroy();
    await live.reconciler.stop();
    await clients.closeAll();
    await live.end.execute({ principal: owner, sessionId, meta: META });
    jest.restoreAllMocks();
    expect(thrown).toEqual([]);
  });

  /** Hands Communities' new events to the bus, as the platform would, and waits for what they started. */
  async function deliver(): Promise<void> {
    const events = live.communities.journal.events.slice(delivered);
    delivered = live.communities.journal.events.length;
    await bus.publish(events);
    await protect.idle();
  }

  const join = (principal: Principal, id = sessionId) =>
    live.join.execute({ principal, sessionId: id, meta: META });

  async function ticket(principal: Principal, id = sessionId) {
    const joined = await join(principal, id);
    if (!joined.ok) throw new Error(`could not join: ${joined.error.code}`);
    return joined.value;
  }

  const fieldsOf = (event: string) =>
    logs.lines.map((line) => line.fields).filter((fields) => fields.event === event);

  it('removes a connected member from the room the moment Communities says so — and refuses them a ticket after, as it refuses anyone', async () => {
    const listener = await clients.connect(await ticket(students[0]));
    const hand = await live.raised(students[1], sessionId);
    await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    const speaker = await clients.connect(await ticket(students[1]));
    expect(await speaker.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-2', TrackSource.MICROPHONE);

    await live.remove(communityId, owner, 'student-2');
    await deliver();

    // The server removed them itself, and says so to their client.
    expect(reasonName(await speaker.ended)).toBe('PARTICIPANT_REMOVED');
    expect(await live.view.identities(room)).toEqual(['student-1']);
    expect(listener.room.isConnected).toBe(true);
    expect(fieldsOf('live.reconciler.removed')).toContainEqual({
      event: 'live.reconciler.removed',
      sessionId,
      userId: 'student-2',
      outcome: 'applied',
    });

    // No ticket after: the 404 of a session they cannot see (Q-A).
    const refused = await join(students[1]);
    expect(codeOf(refused)).toBe('live.session_not_found');
    expect(refused).toEqual(await join(students[1], UNKNOWN_SESSION));
    expect(fieldsOf('live.join.denied')).toContainEqual(
      expect.objectContaining({ sessionId, userId: 'student-2', reason: 'not_a_participant' }),
    );
  });

  it('keeps a running session going when its community is locked (Q46) — nobody removed, a member still joins, raises a hand and speaks — and starts no new one', async () => {
    await live.lock(communityId, owner);
    await deliver();
    expect(await live.view.identities(room)).toEqual(['student-1']);

    const joined = await ticket(students[2]);
    expect(joined.role).toBe('listener');
    const member = await clients.connect(joined);
    const hand = await live.raised(students[2], sessionId);
    const granted = await live.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    expect(granted.ok && granted.value.media).toBe('applied');
    expect(await member.publish('microphone').outcome).toBe('published');
    await live.view.published(room, 'student-3', TrackSource.MICROPHONE);

    // No new session in a locked community — and no room on the server.
    const other = await live.community('teacher-3');
    await live.lock(other.id, other.owner);
    const started = await live.start.execute({
      principal: other.owner,
      communityId: other.id,
      meta: META,
    });
    expect(codeOf(started)).toBe('live.community_not_open');
    expect(await live.view.roomsNamed(live.settings.roomNamePrefix)).toEqual([room]);

    await live.unlock(communityId, owner);
    await deliver();
    expect(await live.view.identities(room)).toEqual(['student-1', 'student-3']);
  });

  it('refuses a member of another community as it refuses an outsider — and their own ticket admits them to their own room only', async () => {
    const elsewhere = await live.community('teacher-4', 'student-4');
    const theirSession = (await live.startSession(elsewhere.owner, elsewhere.id)).id;
    const [outsider] = elsewhere.students;

    const refused = await join(outsider);
    expect(codeOf(refused)).toBe('live.session_not_found');
    expect(refused).toEqual(await join(outsider, UNKNOWN_SESSION));

    const client = await clients.connect(await ticket(outsider, theirSession));
    expect(client.room.name).toBe(live.room(theirSession));
    expect(await live.view.identities(live.room(theirSession))).toEqual(['student-4']);
    expect(await live.view.identities(room)).not.toContain('student-4');
    await client.disconnect();
    await live.end.execute({ principal: elsewhere.owner, sessionId: theirSession, meta: META });
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [JSON.stringify(logs.lines), live.view.logText()].join('\n');
    expect(leakedCredentials(written, [live.server.apiSecret])).toEqual([]);
  });
});
