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

const reactions = (link: FakeLink): Frame[] =>
  link.frames.filter((frame) => frame.type === 'live.reaction');

/**
 * The room's four reactions over the realtime pipeline (C15, ADR 0049): the
 * REAL Live use case publishes the fact; the relay sends `live.reaction` — the
 * kind alone — to the session's OTHER participants connected here, asked at
 * delivery time: never the sender's own devices (they showed it as it was
 * tapped), never the community's other members, never another session.
 */
describe('live reactions, delivered in real time (ADR 0049)', () => {
  let h: LiveRealtimeHarness;
  let l: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let leaver: Principal;
  let sessionId: string;
  let devices: FakeLink[];

  const react = (who: Principal, kind: string, session = sessionId) =>
    l.sendReaction.execute({ principal: who, sessionId: session, kind, meta: META });
  const connect = (userId: string) => {
    const device = h.connect(userId);
    devices.push(device);
    return device;
  };

  beforeEach(async () => {
    h = liveRealtimeHarness();
    l = h.live;
    devices = [];
    const community = await l.community('teacher-1', 'student-1', 'student-2');
    communityId = community.id;
    owner = community.owner;
    [student, leaver] = community.students as [Principal, Principal];
    l.person('outsider-1', ['STUDENT']);
    sessionId = (await l.startSession(owner, communityId)).id;
  });

  afterEach(() => {
    const raw = devices.flatMap((device) => device.raw).join('\n');
    expect(credentialsIn(raw)).toEqual([]);
    h.cleanup();
  });

  it('delivers the kind — and nothing about who — to the other participants only', async () => {
    const host = connect('teacher-1');
    const peer = connect('student-2');
    const sender = connect('student-1');
    const senderTablet = connect('student-1');
    const stranger = connect('outsider-1');
    const sent = await react(student, 'clap');
    expect(sent.ok).toBe(true);
    await h.settle();

    for (const device of [host, peer]) {
      expect(reactions(device)).toEqual([
        {
          type: 'live.reaction',
          version: 1,
          eventId: `live.reaction:${sessionId}:${sent.ok ? sent.value.reactionId : ''}`,
          occurredAt: expect.any(String) as string,
          communityId,
          sessionId,
          kind: 'clap',
        },
      ]);
      expect(device.raw.join('\n')).not.toContain('student-1');
    }
    // The sender's own devices drew it as it was tapped; the community's
    // non-participants and strangers hear nothing.
    expect(reactions(sender)).toEqual([]);
    expect(reactions(senderTablet)).toEqual([]);
    expect(reactions(stranger)).toEqual([]);
  });

  it('keeps one session’s reactions from another’s audience, and from a removed member', async () => {
    const elsewhere = await l.community('teacher-5', 'student-5');
    const otherSession = (await l.startSession(elsewhere.owner, elsewhere.id)).id;
    const foreign = connect('student-5');
    const removed = connect('student-2');
    const host = connect('teacher-1');
    await l.remove(communityId, owner, leaver.userId);
    await react(student, 'heart');
    await h.settle();
    expect(reactions(foreign)).toEqual([]);
    expect(reactions(removed)).toEqual([]);
    expect(reactions(host)).toHaveLength(1);
    // And the other session's own reaction reaches its audience, not ours.
    const theirs = await react(elsewhere.owner, 'smile', otherSession);
    expect(theirs.ok).toBe(true);
    await h.settle();
    expect(reactions(host)).toHaveLength(1);
  });

  it('sends each reaction as its own fact — two taps, two frames, two ids', async () => {
    const host = connect('teacher-1');
    await react(student, 'heart');
    await react(student, 'heart');
    await h.settle();
    const frames = reactions(host);
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((frame) => frame.eventId)).size).toBe(2);
  });

  it('drops a malformed fact instead of sending it', async () => {
    const host = connect('teacher-1');
    for (const payload of [
      { sessionId, communityId, reactionId: 'r-1', kind: 'fire', sentBy: 'student-1' },
      { sessionId, communityId, reactionId: '', kind: 'heart', sentBy: 'student-1' },
      { sessionId, communityId, reactionId: 'r-2', kind: 'heart' },
    ]) {
      await h.relay.relay(domainEvent(LiveEvents.reactionSent, sessionId, payload, l.clock.now()));
    }
    expect(reactions(host)).toEqual([]);
  });
});
