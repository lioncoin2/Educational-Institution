import { Logger } from '@nestjs/common';

import { asId } from '../../../shared';
import { AdjustableClock } from '../../../../test/support/identity-harness';
import { LIVE_TEST_SETTINGS } from '../../../../test/support/live-harness';
import { mediaRoomName, newLiveSession, type LiveSession } from '../domain/live-session';
import { capabilitiesFor, type ParticipantStanding } from '../domain/standing';
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
