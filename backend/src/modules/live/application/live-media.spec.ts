import { Logger } from '@nestjs/common';

import { asId } from '../../../shared';
import { AdjustableClock } from '../../../../test/support/identity-harness';
import { LIVE_TEST_SETTINGS } from '../../../../test/support/live-harness';
import { mediaRoomName, newLiveSession, type LiveSession } from '../domain/live-session';
import { capabilitiesFor, type ParticipantStanding } from '../domain/standing';
import { RtcUnavailableError } from '../domain/rtc-provider';
import { FakeRtcProvider } from '../infrastructure/fake-rtc-provider';
import { LiveMedia, MEDIA_RECORD_LIMIT } from './live-media';
import type { LiveStanding } from './live-standing';

const SPEAKING: ParticipantStanding = {
  moderator: false,
  publishesByRight: false,
  speakerGrant: true,
  presenter: false,
};
const LISTENER = capabilitiesFor({ ...SPEAKING, speakerGrant: false });
const MICROPHONE = capabilitiesFor(SPEAKING);

function sessionNumbered(n: number): LiveSession {
  return newLiveSession({
    id: asId<'LiveSession'>(`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`),
    communityId: 'community-1',
    hostUserId: 'teacher-1',
    at: new Date('2026-09-27T10:00:00.000Z'),
    participantCap: 300,
    moderatorReserve: 10,
  });
}

/**
 * The push after a stored change, and the little it remembers (audit D7,
 * D11): who is left unsettled for the watch, and each person's connection
 * as last observed — both bounded, both dropped when the session ends.
 */
describe('LiveMedia', () => {
  let clock: AdjustableClock;
  let rtc: FakeRtcProvider;
  let ofAccounts: jest.Mock;
  let media: LiveMedia;
  const session = sessionNumbered(1);
  const room = mediaRoomName('live-', session.id, 0);

  beforeEach(() => {
    clock = new AdjustableClock(new Date('2026-09-27T10:00:00.000Z'));
    rtc = new FakeRtcProvider(clock);
    // Everyone asked about is speaking: what is pushed is the standing's set.
    ofAccounts = jest.fn(
      async (_session: LiveSession, userIds: readonly string[]) =>
        new Map(userIds.map((userId) => [userId, { standing: SPEAKING, eligible: true }])),
    );
    const standing = { ofAccounts } as unknown as LiveStanding;
    media = new LiveMedia(rtc, standing, LIVE_TEST_SETTINGS, clock);
  });

  afterEach(() => jest.restoreAllMocks());

  it('pushes the full set the person’s current standing calls for, to the session’s current room', async () => {
    rtc.connect(room, 'student-1', LISTENER);
    expect(await media.push(session, 'student-1')).toBe('applied');
    expect(rtc.capabilityChanges).toEqual([
      { roomName: room, identity: 'student-1', capabilities: MICROPHONE },
    ]);
    expect(media.observed(session.id, 'student-1')).toBe('connected');
    expect(media.unsettled()).toEqual([]);

    // After a media reset, the push goes to the new room.
    await media.push({ ...session, mediaRoomEpoch: 1 }, 'student-1');
    expect(rtc.calls.at(-1)).toMatchObject({ roomName: mediaRoomName('live-', session.id, 1) });
  });

  it('leaves whoever it could not apply to for the watch, from the first time, until a push applies', async () => {
    expect(await media.push(session, 'student-1')).toBe('not_connected');
    expect(media.observed(session.id, 'student-1')).toBe('not_connected');
    const first = clock.now();

    clock.advance(10);
    rtc.setUnavailable(true);
    expect(await media.push(session, 'student-1')).toBe('pending');
    // Nothing was observed: the last observation stands.
    expect(media.observed(session.id, 'student-1')).toBe('not_connected');
    expect(media.unsettled()).toEqual([
      { sessionId: session.id, userId: 'student-1', since: first },
    ]);

    rtc.setUnavailable(false);
    rtc.connect(room, 'student-1', LISTENER);
    expect(await media.push(session, 'student-1')).toBe('applied');
    expect(media.unsettled()).toEqual([]);
  });

  it('never throws: a standing it cannot read is pending, logged by class only', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    ofAccounts.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:5432'));
    expect(await media.push(session, 'student-1')).toBe('pending');
    expect(logged.mock.calls).toEqual([
      [
        { event: 'live.media.push_failed', sessionId: session.id, err: { name: 'Error' } },
        'could not push a participant’s live media rights; left to the watch',
      ],
    ]);
    expect(rtc.calls).toEqual([]);
  });

  it('logs a provider outage nowhere — the adapter already has — and a provider fault by class', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    rtc.failNext('updateCapabilities', 'unavailable');
    expect(await media.push(session, 'student-1')).toBe('pending');
    expect(logged).not.toHaveBeenCalled();
    rtc.failNext('updateCapabilities', 'fault');
    expect(await media.push(session, 'student-1')).toBe('pending');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('refused');
  });

  // P7.2 (audit §4.3): a push to someone Communities no longer lets stay
  // never hands them what their hand says — the reconciler removes them.
  it('pushes the set of no standing at all to someone no longer eligible, whatever their hand says', async () => {
    rtc.connect(room, 'student-1', MICROPHONE);
    ofAccounts.mockResolvedValueOnce(
      new Map([['student-1', { standing: SPEAKING, eligible: false }]]),
    );
    expect(await media.push(session, 'student-1')).toBe('applied');
    expect(rtc.capabilityChanges.at(-1)).toEqual({
      roomName: room,
      identity: 'student-1',
      capabilities: LISTENER,
    });
  });

  describe('one push at a time per person (P7.2, audit §4.2)', () => {
    const revoked = new Map([
      ['student-1', { standing: { ...SPEAKING, speakerGrant: false }, eligible: true }],
    ]);

    it('reads the standing for the next push only once the one before it has landed, so the last stored change wins', async () => {
      rtc.connect(room, 'student-1', LISTENER);
      // The grant's push reads "speaking", then waits at the provider…
      const gate = rtc.hold('updateCapabilities');
      const granting = media.push(session, 'student-1');
      await gate.reached;
      // …while the revoke commits and asks for its own push.
      ofAccounts.mockImplementation(async () => revoked);
      const revoking = media.push(session, 'student-1');
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // The revoke's push has not read anything yet: it waits its turn.
      expect(ofAccounts).toHaveBeenCalledTimes(1);
      gate.release();

      expect(await granting).toBe('applied');
      expect(await revoking).toBe('applied');
      expect(ofAccounts).toHaveBeenCalledTimes(2);
      expect(rtc.capabilityChanges.map((change) => change.capabilities)).toEqual([
        MICROPHONE,
        LISTENER,
      ]);
      expect(rtc.observed(room)[0]?.capabilities).toEqual(LISTENER);
    });

    it('never holds one person’s push behind another’s', async () => {
      rtc.connect(room, 'student-1', LISTENER);
      rtc.connect(room, 'student-2', LISTENER);
      const reads: string[] = [];
      ofAccounts.mockImplementation(async (_session: LiveSession, userIds: readonly string[]) => {
        reads.push(...userIds);
        return new Map(userIds.map((userId) => [userId, { standing: SPEAKING, eligible: true }]));
      });
      const gate = rtc.hold('updateCapabilities');
      const first = media.push(session, 'student-1');
      await gate.reached;
      const second = media.push(session, 'student-2');
      while (reads.length < 2) await new Promise((resolve) => setImmediate(resolve));
      // student-2's push read its standing while student-1's was held.
      expect(reads).toEqual(['student-1', 'student-2']);
      gate.release();
      expect(await Promise.all([first, second])).toEqual(['applied', 'applied']);
    });

    it('runs the reconciler’s correction in turn too — read afresh, its failure thrown, and never counted as a push', async () => {
      rtc.connect(room, 'student-1', LISTENER);
      const mark = media.pushMark();
      const gate = rtc.hold('updateCapabilities');
      const granting = media.push(session, 'student-1');
      await gate.reached;
      ofAccounts.mockImplementation(async () => revoked);
      const correcting = media.pushNow(session, 'student-1');
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(ofAccounts).toHaveBeenCalledTimes(1);
      gate.release();
      expect(await granting).toBe('applied');
      expect(await correcting).toBe('applied');
      expect(ofAccounts).toHaveBeenCalledTimes(2);
      // The correction carried the standing read after the grant's push landed.
      expect(rtc.capabilityChanges.map((change) => change.capabilities)).toEqual([
        MICROPHONE,
        LISTENER,
      ]);
      // Only the moderator's push counts for a later observation.
      const after = media.pushMark();
      expect(media.pushedSince(session.id, 'student-1', mark)).toBe(true);
      await media.pushNow(session, 'student-1');
      expect(media.pushedSince(session.id, 'student-1', after)).toBe(false);

      // An outage, a refused configuration, a standing it cannot read: thrown.
      rtc.failNext('updateCapabilities', 'unavailable');
      await expect(media.pushNow(session, 'student-1')).rejects.toBeInstanceOf(RtcUnavailableError);
      ofAccounts.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(media.pushNow(session, 'student-1')).rejects.toThrow('ECONNREFUSED');
    });
  });

  it('forgets an ended session, and only that one', async () => {
    const other = sessionNumbered(2);
    await media.push(session, 'student-1');
    await media.push(other, 'student-1');
    media.forget(session.id);
    expect(media.unsettled().map((push) => push.sessionId)).toEqual([other.id]);
    expect(media.observed(session.id, 'student-1')).toBe('unknown');
    expect(media.observed(other.id, 'student-1')).toBe('not_connected');
  });

  it('keeps at most MEDIA_RECORD_LIMIT people, dropping the oldest', async () => {
    for (let i = 0; i <= MEDIA_RECORD_LIMIT; i += 1) await media.push(session, `student-${i}`);
    const unsettled = media.unsettled();
    expect(unsettled).toHaveLength(MEDIA_RECORD_LIMIT);
    expect(unsettled[0]?.userId).toBe('student-1');
    expect(media.observed(session.id, 'student-0')).toBe('unknown');
    expect(media.observed(session.id, `student-${MEDIA_RECORD_LIMIT}`)).toBe('not_connected');
  });
});
