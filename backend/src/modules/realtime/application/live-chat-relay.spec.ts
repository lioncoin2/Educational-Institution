import { META, type LiveHarness } from '../../../../test/support/live-harness';
import { credentialsIn } from '../../../../test/support/log-capture';
import {
  liveRealtimeHarness,
  type FakeLink,
  type Frame,
  type LiveRealtimeHarness,
} from '../../../../test/support/realtime-harness';
import { domainEvent, type Principal } from '../../../shared';
import { LiveEvents } from '../../live/contracts';

const chatFrames = (link: FakeLink): Frame[] =>
  link.frames.filter((frame) => frame.type.startsWith('live.chat.'));

/**
 * A live session's own chat over the realtime pipeline (ADR 0047): the REAL
 * Live use cases over the REAL Communities publish ids-only facts; the relay
 * renders a post through LIVE_CHAT and sends it — and every lock change — to
 * the session's participants connected here, asked at delivery time. Unlike
 * every other live frame, `live.chat.message` carries text and a name: it IS
 * the message, for the people in the session, and for nobody else.
 */
describe('live session chat, delivered in real time (ADR 0047)', () => {
  let h: LiveRealtimeHarness;
  let l: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let leaver: Principal;
  let outsider: Principal;
  let sessionId: string;
  let devices: FakeLink[];
  let keys = 0;

  const post = (who: Principal, body: string, session = sessionId) =>
    l.postChat.execute({
      principal: who,
      sessionId: session,
      clientMessageId: `relay-key-${String((keys += 1)).padStart(6, '0')}`,
      body,
      meta: META,
    });
  const lock = (who: Principal, locked: boolean) =>
    l.chatLock.execute({ principal: who, sessionId, locked, meta: META });
  const connect = (userId: string) => {
    const device = h.connect(userId);
    devices.push(device);
    return device;
  };

  beforeEach(async () => {
    h = liveRealtimeHarness();
    l = h.live;
    devices = [];
    keys = 0;
    const community = await l.community('teacher-1', 'student-1', 'student-2');
    communityId = community.id;
    owner = community.owner;
    [student, leaver] = community.students as [Principal, Principal];
    outsider = l.person('outsider-1', ['STUDENT']);
    l.accounts.add('student-1', ['STUDENT'], 'مريم');
    sessionId = (await l.startSession(owner, communityId)).id;
  });

  afterEach(() => {
    const raw = devices.flatMap((device) => device.raw).join('\n');
    expect(credentialsIn(raw)).toEqual([]);
    expect(raw).not.toContain('@');
    h.cleanup();
  });

  it('delivers a post, as the chat page shows it, to the session’s participants only', async () => {
    const ownerDevice = connect('teacher-1');
    const studentDevice = connect('student-2');
    const stranger = connect('outsider-1');
    expect((await post(student, 'سؤال عن الدرس')).ok).toBe(true);
    await h.settle();

    for (const device of [ownerDevice, studentDevice]) {
      const [frame] = chatFrames(device);
      expect(frame).toMatchObject({
        type: 'live.chat.message',
        version: 1,
        communityId,
        sessionId,
        message: {
          sessionId,
          senderId: 'student-1',
          senderDisplayName: 'مريم',
          body: 'سؤال عن الدرس',
          position: expect.any(Number),
        },
      });
      expect(String(frame?.eventId)).toBe(
        `live.chat.message:${String((frame?.message as Frame).id)}`,
      );
    }
    expect(chatFrames(stranger)).toEqual([]);
    expect(outsider.userId).toBe('outsider-1');
  });

  it('tells nothing to a member removed before the post, nor to another session’s audience', async () => {
    const removed = connect('student-2');
    const elsewhere = await l.community('teacher-5', 'student-5');
    await l.startSession(elsewhere.owner, elsewhere.id);
    const foreign = connect('student-5');
    await l.remove(communityId, owner, leaver.userId);
    await post(student, 'بعد الإزالة');
    await h.settle();
    expect(chatFrames(removed)).toEqual([]);
    expect(chatFrames(foreign)).toEqual([]);
  });

  it('announces a lock and a re-open, with the version, to the participants', async () => {
    const studentDevice = connect('student-1');
    const stranger = connect('outsider-1');
    await lock(owner, true);
    await lock(owner, true); // a repeat: nothing
    await lock(owner, false);
    await h.settle();
    expect(
      chatFrames(studentDevice).map((frame) => [frame.type, frame.locked, frame.lockVersion]),
    ).toEqual([
      ['live.chat.changed', true, 1],
      ['live.chat.changed', false, 2],
    ]);
    expect(chatFrames(stranger)).toEqual([]);
    // A hint: the frame carries no name, and nothing but the switch and its version.
    expect(Object.keys(chatFrames(studentDevice)[0] ?? {}).sort()).toEqual([
      'communityId',
      'eventId',
      'lockVersion',
      'locked',
      'occurredAt',
      'sessionId',
      'type',
      'version',
    ]);
  });

  it('ignores a malformed or unknown chat fact instead of guessing', async () => {
    const device = connect('student-1');
    await h.relay.relay(
      domainEvent(LiveEvents.chatPosted, sessionId, { sessionId, communityId }, l.clock.now()),
    );
    await h.relay.relay(
      domainEvent(
        LiveEvents.chatPosted,
        sessionId,
        { sessionId, communityId, messageId: 'no-such', senderId: 'x', position: 1 },
        l.clock.now(),
      ),
    );
    expect(chatFrames(device)).toEqual([]);
  });
});
