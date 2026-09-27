import { InProcessEventBus } from '../../../platform/events/event-bus';
import type { DomainEvent, Principal } from '../../../shared';
import {
  META,
  captureLogs,
  liveHarness,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { CommunityEvents } from '../../communities/contracts/events';
import { capabilitiesFor } from '../domain/standing';
import { PROTECTED_BY, ProtectLiveSessions } from './protect-live-sessions';
import type { LiveSessionView, SpeakerRequestView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});
const MICROPHONE = { ...LISTENER, canPublishAudio: true };
const PRESENTING = { ...MICROPHONE, canPublishScreen: true };

/** A promise the test resolves when it chooses. */
function gate(): { readonly promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets pending work run until `done` holds — or fails the test after a bounded number of turns. */
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (done()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the awaited work never finished');
}

/**
 * `ProtectLiveSessions` (live.md §11.6; audit D17) over the REAL Communities
 * and a real in-process bus: Communities' own use cases publish the facts,
 * and each has the reconciler look at the community's live session at once
 * — the per-identity step for the people it names, the per-session step for
 * a lock or an unlock. Every decision stays the reconciler's, from
 * Communities' answers now; a lost event is caught by the next sweep.
 */
describe('ProtectLiveSessions', () => {
  let h: LiveHarness;
  let bus: InProcessEventBus;
  let protect: ProtectLiveSessions;
  /** Anything a handler threw into the bus — there must never be any. */
  let thrown: unknown[];
  let logs: ReturnType<typeof captureLogs>;
  let communityId: string;
  let owner: Principal;
  let session: LiveSessionView;
  let room: string;
  /** How many of Communities' events have been handed to the bus. */
  let delivered: number;

  beforeEach(async () => {
    logs = captureLogs();
    h = liveHarness();
    thrown = [];
    bus = new InProcessEventBus((_event, error) => void thrown.push(error));
    protect = new ProtectLiveSessions(bus, h.sessions, h.reconciler);
    protect.onModuleInit();
    ({ id: communityId, owner } = await h.community('teacher-1', 'student-1', 'student-2'));
    session = await h.startSession(owner, communityId);
    room = h.room(session.id);
    h.rtc.connect(room, 'teacher-1', MICROPHONE);
    delivered = h.communities.journal.events.length;
  });

  afterEach(async () => {
    await protect.onModuleDestroy();
    await h.reconciler.stop();
    jest.restoreAllMocks();
  });

  /** Hands Communities' events published since the last call to the bus, as the platform would. */
  async function publishCommunityEvents(): Promise<void> {
    const events = h.communities.journal.events.slice(delivered);
    delivered = h.communities.journal.events.length;
    await bus.publish(events);
  }

  /** Publishes Communities' new events, then waits for everything they scheduled. */
  async function deliver(): Promise<void> {
    await publishCommunityEvents();
    await protect.idle();
  }

  /** Drops Communities' events published since the last delivery: they are lost. */
  function lose(): void {
    delivered = h.communities.journal.events.length;
  }

  /** A hand raised and granted, the speaker connected with what the grant pushed — unless told otherwise. */
  async function speaker(principal: Principal, connected = true): Promise<SpeakerRequestView> {
    if (connected) h.rtc.connect(room, principal.userId, LISTENER);
    const hand = await h.raised(principal, session.id);
    const granted = await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
    if (!granted.ok) throw new Error(granted.error.code);
    return hand;
  }

  /** teacher-2, delegated `community.live.moderate`, presenting — connected unless told otherwise. */
  async function presenter(connected = true): Promise<Principal> {
    const moderator = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    if (connected) h.rtc.connect(room, 'teacher-2', PRESENTING, ['microphone', 'screen_share']);
    const claimed = await h.presenter.claim({
      principal: moderator,
      sessionId: session.id,
      meta: META,
    });
    if (!claimed.ok) throw new Error(claimed.error.code);
    return moderator;
  }

  async function revokeModeration(userId: string): Promise<void> {
    const [grantId] = await h.grantsOf(communityId, owner, userId, 'community.live.moderate');
    const revoked = await h.communities.revokeGrant.execute({
      principal: owner,
      communityId,
      grantId,
      meta: META,
    });
    if (!revoked.ok) throw new Error(revoked.error.code);
  }

  const requestState = async (hand: SpeakerRequestView) =>
    (await h.requests.findById(hand.id))?.state;

  const capabilitiesOf = (userId: string) =>
    h.rtc.observed(room).find((participant) => participant.identity === userId)?.capabilities;

  /** Which RTC operations the fake saw since `from`, with the identity each named. */
  const callsSince = (from: number) =>
    h.rtc.calls.slice(from).map((call) => [call.operation, call.identity ?? null]);

  it('subscribes to exactly the five Communities facts, and lets go of them on destroy', async () => {
    expect([...PROTECTED_BY]).toEqual([
      CommunityEvents.memberRemoved,
      CommunityEvents.capabilityRevoked,
      CommunityEvents.ownershipTransferred,
      CommunityEvents.communityLocked,
      CommunityEvents.communityUnlocked,
    ]);
    const subscribe = jest.spyOn(bus, 'subscribe');
    const other = new ProtectLiveSessions(bus, h.sessions, h.reconciler);
    other.onModuleInit();
    expect(subscribe.mock.calls.map(([name]) => name)).toEqual([...PROTECTED_BY]);

    // Destroyed, nothing reaches the reconciler any more.
    await protect.onModuleDestroy();
    await other.onModuleDestroy();
    const checks = jest.spyOn(h.reconciler, 'checkIdentities');
    h.rtc.connect(room, 'student-1', LISTENER);
    await h.remove(communityId, owner, 'student-1');
    await deliver();
    expect(checks).not.toHaveBeenCalled();
    expect(h.rtc.removed).toEqual([]);
  });

  describe('each fact, at once', () => {
    it('member.removed — removes the member at once: the floor expired, out of the room', async () => {
      const hand = await speaker(h.person('student-1', ['STUDENT']));
      const checks = jest.spyOn(h.reconciler, 'checkIdentities');
      const sweeps = jest.spyOn(h.reconciler, 'sweepParticipants');
      await h.remove(communityId, owner, 'student-1');
      h.journal.clear();
      const from = h.rtc.calls.length;
      const now = h.clock.now();

      await deliver();

      expect(checks.mock.calls).toEqual([[session.id, ['student-1']]]);
      expect(sweeps).not.toHaveBeenCalled();
      // Only the person named was looked at — no sweep of the room.
      expect(callsSince(from)).toEqual([
        ['getParticipant', 'student-1'],
        ['removeParticipant', 'student-1'],
      ]);
      expect(h.rtc.removed).toEqual([
        { roomName: room, identity: 'student-1', revokeTokensIssuedBefore: now },
      ]);
      expect(await requestState(hand)).toBe('expired');
      expect(h.journal.eventNames()).toEqual(['live.speaker.expired']);
    });

    it('member.removed — a member who LEFT is checked the same way', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      const left = await h.communities.leave.execute({
        principal: h.person('student-1', ['STUDENT']),
        communityId,
        meta: META,
      });
      expect(left.ok).toBe(true);

      await deliver();
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual(['student-1']);
    });

    it('capability.revoked — the presenter who no longer moderates loses the slot and the microphone at once', async () => {
      await presenter();
      const checks = jest.spyOn(h.reconciler, 'checkIdentities');
      await revokeModeration('teacher-2');
      h.journal.clear();

      await deliver();

      expect(checks.mock.calls).toEqual([[session.id, ['teacher-2']]]);
      expect(await h.presenters.active(session.id)).toBeNull();
      expect(h.journal.events.map((event) => event.payload)).toEqual([
        expect.objectContaining({ userId: 'teacher-2', reason: 'ineligible', stoppedBy: null }),
      ]);
      // Still a member: corrected, not removed.
      expect(capabilitiesOf('teacher-2')).toEqual(LISTENER);
      expect(h.rtc.removed).toEqual([]);
    });

    it('ownership.transferred — the old owner and the new one: the old host loses moderation, the new owner gains it', async () => {
      await h.member(communityId, owner, 'teacher-2', ['TEACHER']);
      h.rtc.connect(room, 'teacher-2', LISTENER);
      const checks = jest.spyOn(h.reconciler, 'checkIdentities');
      const transferred = await h.communities.transfer.execute({
        principal: owner,
        communityId,
        userId: 'teacher-2',
        meta: META,
      });
      expect(transferred.ok).toBe(true);

      await deliver();

      expect(checks.mock.calls).toEqual([[session.id, ['teacher-1', 'teacher-2']]]);
      // The starter no longer hosts (no start grant, no longer the owner): the
      // microphone they held by right goes; still a member, they stay.
      expect(capabilitiesOf('teacher-1')).toEqual(LISTENER);
      // The new owner moderates now, and publishes by right: a set below
      // theirs is pushed — never a violation.
      expect(capabilitiesOf('teacher-2')).toEqual(MICROPHONE);
      expect(h.rtc.removed).toEqual([]);
      expect((await h.session(session.id)).enforcementViolations).toBe(0);
    });

    it('community.locked — runs the per-session step, and a LOCKED community’s members stay', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      const hand = await speaker(h.person('student-2', ['STUDENT']));
      const sessions = jest.spyOn(h.reconciler, 'checkSession');
      const heads = jest.spyOn(h.communities.membership, 'heads');
      h.journal.clear();
      const from = h.rtc.calls.length;

      await h.lock(communityId, owner);
      await deliver();

      expect(sessions.mock.calls).toEqual([[session.id]]);
      expect(await sessions.mock.results[0]?.value).toMatchObject({
        outcome: 'checked',
        checked: 3,
        removed: 0,
        corrected: 0,
        pushed: 0,
      });
      expect(heads).toHaveBeenCalledWith([communityId]);
      // Everyone in the room was looked at, and nothing was pushed or removed.
      expect(callsSince(from)).toEqual([['listParticipants', null]]);
      expect(h.media.observed(session.id, 'student-1')).toBe('connected');
      expect(h.rtc.removed).toEqual([]);
      expect(await requestState(hand)).toBe('granted');
      expect((await h.session(session.id)).state).toBe('live');
      expect(h.journal.order).toEqual([]);
    });

    it('community.unlocked — runs the per-session step too', async () => {
      await h.lock(communityId, owner);
      await deliver();
      const sessions = jest.spyOn(h.reconciler, 'checkSession');

      await h.unlock(communityId, owner);
      await deliver();

      expect(sessions.mock.calls).toEqual([[session.id]]);
      expect((await h.session(session.id)).state).toBe('live');
    });

    it('does nothing for a community with no live session', async () => {
      const other = await h.community('teacher-9', 'student-9');
      const checks = jest.spyOn(h.reconciler, 'checkIdentities');
      const sessions = jest.spyOn(h.reconciler, 'checkSession');
      lose();
      const from = h.rtc.calls.length;

      await h.remove(other.id, other.owner, 'student-9');
      await h.lock(other.id, other.owner);
      await deliver();

      expect(checks).not.toHaveBeenCalled();
      expect(sessions).not.toHaveBeenCalled();
      expect(h.rtc.calls.length).toBe(from);
    });
  });

  describe('delivery', () => {
    it('returns to the publisher at once, and handles one community’s facts in order — other communities unhindered', async () => {
      const other = await h.community('teacher-9', 'student-9');
      const otherSession = await h.startSession(other.owner, other.id);
      h.rtc.connect(h.room(otherSession.id), 'student-9', LISTENER);
      h.rtc.connect(room, 'student-1', LISTENER);
      h.rtc.connect(room, 'student-2', LISTENER);
      lose();

      // The first look at this community stalls on Live's store.
      const stalled = gate();
      const findLive = h.sessions.findLiveByCommunity.bind(h.sessions);
      let first = true;
      jest.spyOn(h.sessions, 'findLiveByCommunity').mockImplementation(async (id) => {
        if (id === communityId && first) {
          first = false;
          await stalled.promise;
        }
        return findLive(id);
      });
      const order: string[] = [];
      const checkIdentities = h.reconciler.checkIdentities.bind(h.reconciler);
      jest.spyOn(h.reconciler, 'checkIdentities').mockImplementation(async (id, userIds) => {
        order.push(`start ${userIds.join()}`);
        const report = await checkIdentities(id, userIds);
        order.push(`end ${userIds.join()}`);
        return report;
      });

      await h.remove(communityId, owner, 'student-1');
      await h.remove(communityId, owner, 'student-2');
      await h.remove(other.id, other.owner, 'student-9');
      // The bus hands the facts over and returns, though nothing has been handled yet.
      await publishCommunityEvents();
      expect(order).toEqual([]);

      // The other community is not held behind this one…
      await until(() => order.includes('end student-9'));
      expect(order).toEqual(['start student-9', 'end student-9']);
      // …and this community's second fact waits for its first.
      stalled.open();
      await protect.idle();
      expect(order).toEqual([
        'start student-9',
        'end student-9',
        'start student-1',
        'end student-1',
        'start student-2',
        'end student-2',
      ]);
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual([
        'student-9',
        'student-1',
        'student-2',
      ]);
    });

    it('logs and ignores a malformed payload — by name only — and throws nothing into the bus', async () => {
      const checks = jest.spyOn(h.reconciler, 'checkIdentities');
      const sessions = jest.spyOn(h.reconciler, 'checkSession');
      const event = (name: string, aggregateId: string, payload: unknown): DomainEvent => ({
        name,
        aggregateId,
        occurredAt: h.clock.now(),
        payload,
      });

      await bus.publish([
        event(CommunityEvents.memberRemoved, communityId, null),
        event(CommunityEvents.memberRemoved, communityId, { communityId }),
        event(CommunityEvents.memberRemoved, communityId, { communityId, userId: 42 }),
        event(CommunityEvents.capabilityRevoked, communityId, { communityId, userId: '' }),
        event(CommunityEvents.ownershipTransferred, communityId, {
          communityId,
          fromUserId: 'teacher-1',
        }),
        // A payload about another community than the stream it is ordered under.
        event(CommunityEvents.memberRemoved, 'another-community', {
          communityId,
          userId: 'student-1',
        }),
        event(CommunityEvents.communityLocked, communityId, 'LOCKED <script>'),
      ]);
      await protect.idle();

      expect(checks).not.toHaveBeenCalled();
      expect(sessions).not.toHaveBeenCalled();
      expect(thrown).toEqual([]);
      const malformed = logs.lines.filter((line) => line.fields.event === 'live.protect.malformed');
      expect(malformed).toHaveLength(7);
      for (const line of malformed) {
        expect(Object.keys(line.fields).sort()).toEqual(['event', 'name']);
      }
    });

    it('logs a dependency that throws — by class only — never into the bus, and goes on with the next fact', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      h.rtc.connect(room, 'student-2', LISTENER);
      jest
        .spyOn(h.sessions, 'findLiveByCommunity')
        .mockRejectedValueOnce(new TypeError('connection to 10.0.0.5 reset'));

      await h.remove(communityId, owner, 'student-1');
      await h.remove(communityId, owner, 'student-2');
      await deliver();

      expect(thrown).toEqual([]);
      expect(logs.lines).toContainEqual({
        level: 'error',
        fields: {
          event: 'live.protect.failed',
          name: CommunityEvents.memberRemoved,
          communityId,
          err: { name: 'TypeError' },
        },
      });
      expect(JSON.stringify(logs.lines)).not.toContain('10.0.0.5');
      // The first fact was lost to the failure; the second was handled.
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual(['student-2']);
      // …and the sweep catches the first.
      await h.reconciler.sweepParticipants();
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual(['student-2', 'student-1']);
    });

    it('ejects nobody when Communities cannot answer: the reconciler’s step is skipped, and nothing is thrown', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      await h.remove(communityId, owner, 'student-1');
      jest
        .spyOn(h.authorization, 'permittedAmong')
        .mockRejectedValue(new Error('Communities down'));

      await deliver();

      expect(thrown).toEqual([]);
      expect(h.rtc.removed).toEqual([]);
      expect(logs.events()).toContain('live.reconciler.session_skipped');
    });
  });

  describe('a lost event costs at most one sweep period', () => {
    it('a removed, connected member is removed by the next participant sweep', async () => {
      h.rtc.connect(room, 'student-1', LISTENER);
      await h.remove(communityId, owner, 'student-1');
      lose();
      await protect.idle();
      expect(h.rtc.removed).toEqual([]);

      await h.reconciler.sweepParticipants();
      expect(h.rtc.removed.map((removal) => removal.identity)).toEqual(['student-1']);
    });

    it('a removed, DISCONNECTED floor holder has the floor expired by the next sweep (D21)', async () => {
      const hand = await speaker(h.person('student-1', ['STUDENT']), false);
      await h.remove(communityId, owner, 'student-1');
      lose();
      expect(await requestState(hand)).toBe('granted');
      h.journal.clear();

      await h.reconciler.sweepParticipants();

      expect(await requestState(hand)).toBe('expired');
      expect(h.journal.eventNames()).toEqual(['live.speaker.expired']);
      expect(h.rtc.removed).toEqual([]);
    });

    it('a DISCONNECTED presenter who lost moderation has the grant closed by the next sweep (D21)', async () => {
      await presenter(false);
      await revokeModeration('teacher-2');
      lose();
      expect(await h.presenters.active(session.id)).not.toBeNull();
      h.journal.clear();

      await h.reconciler.sweepParticipants();

      expect(await h.presenters.active(session.id)).toBeNull();
      expect(h.journal.events.map((event) => event.payload)).toEqual([
        expect.objectContaining({ userId: 'teacher-2', reason: 'ineligible', stoppedBy: null }),
      ]);
    });
  });
});
