import { RtcUnavailableError, type RtcProvider } from '../domain/rtc-provider';
import { DisabledRtcProvider } from './disabled-rtc-provider';

const CAPABILITIES = {
  canPublishAudio: true,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

/** One call of every method of the port, with plausible arguments. */
const EVERY_CALL: Readonly<Record<keyof RtcProvider, (rtc: RtcProvider) => Promise<unknown>>> = {
  ensureRoom: (rtc) =>
    rtc.ensureRoom({
      roomName: 'live-room',
      maxParticipants: 310,
      emptyTimeoutSeconds: 1_200,
      departureTimeoutSeconds: 1_200,
    }),
  endRoom: (rtc) => rtc.endRoom('live-room'),
  listRooms: (rtc) => rtc.listRooms(['live-room']),
  issueAccessToken: (rtc) =>
    rtc.issueAccessToken({
      roomName: 'live-room',
      identity: 'student-1',
      displayName: 'مريم',
      capabilities: CAPABILITIES,
      ttlSeconds: 120,
    }),
  updateCapabilities: (rtc) => rtc.updateCapabilities('live-room', 'student-1', CAPABILITIES),
  removeParticipant: (rtc) =>
    rtc.removeParticipant('live-room', 'student-1', { revokeTokensIssuedBefore: new Date(0) }),
  muteParticipant: (rtc) => rtc.muteParticipant('live-room', 'student-1', ['microphone']),
  listParticipants: (rtc) => rtc.listParticipants('live-room'),
  getParticipant: (rtc) => rtc.getParticipant('live-room', 'student-1'),
};

describe('the disabled RTC provider (audit D19)', () => {
  it.each(Object.keys(EVERY_CALL) as (keyof RtcProvider)[])(
    'refuses %s as an outage: media is disabled',
    async (method) => {
      const refused = EVERY_CALL[method](new DisabledRtcProvider());
      await expect(refused).rejects.toBeInstanceOf(RtcUnavailableError);
      await expect(refused).rejects.toMatchObject({ operation: `${method} (media disabled)` });
    },
  );

  // Start's 503 `live.media_unavailable`, with nothing stored, rests on this:
  // the refusal is the port's own outage, never a fault or a quiet success.
  it('refuses every call, token signing included — nothing half-works', async () => {
    const rtc = new DisabledRtcProvider();
    const outcomes = await Promise.allSettled(Object.values(EVERY_CALL).map((call) => call(rtc)));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(
      Object.keys(EVERY_CALL).map(() => 'rejected'),
    );
  });
});
