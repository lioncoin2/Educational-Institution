import {
  RtcUnavailableError,
  type RtcAccessToken,
  type RtcApplyOutcome,
  type RtcParticipantObservation,
  type RtcProvider,
  type RtcReadinessReport,
  type RtcRoomObservation,
} from '../domain/rtc-provider';

/**
 * The media provider of a deployment in which real media is not enabled
 * (P6 audit, D19): every call refuses, as an outage, and its self-check
 * reports `provider_disabled`.
 *
 * The design's media-plane finality — an ended room cannot come back, and a
 * media reset keeps a violator's old room deleted — rests on a pinned server
 * configuration (`room.auto_create=false`), on the adapter's contract suite
 * against a real server and on the `/rtc/validate` self-check. So the
 * LiveKit adapter is bound only on explicit opt-in
 * (`LIVE_MEDIA_PROVIDER=livekit`, with its boot checks), the fake only for
 * the development secret, and every other deployment binds this.
 *
 * So failure is explicit, and nothing half-works: Start answers 503
 * `live.media_unavailable` with nothing stored, `/join` mints no token, and
 * the reconciler skips its ticks. Real credentials in the environment are
 * never reached by accident.
 */
export class DisabledRtcProvider implements RtcProvider {
  async check(): Promise<RtcReadinessReport> {
    return { ready: false, reason: 'provider_disabled' };
  }

  async ensureRoom(): Promise<void> {
    throw disabled('ensureRoom');
  }

  async endRoom(): Promise<void> {
    throw disabled('endRoom');
  }

  async listRooms(): Promise<readonly RtcRoomObservation[]> {
    throw disabled('listRooms');
  }

  async issueAccessToken(): Promise<RtcAccessToken> {
    throw disabled('issueAccessToken');
  }

  async updateCapabilities(): Promise<RtcApplyOutcome> {
    throw disabled('updateCapabilities');
  }

  async removeParticipant(): Promise<RtcApplyOutcome> {
    throw disabled('removeParticipant');
  }

  async muteParticipant(): Promise<RtcApplyOutcome> {
    throw disabled('muteParticipant');
  }

  async listParticipants(): Promise<readonly RtcParticipantObservation[]> {
    throw disabled('listParticipants');
  }

  async getParticipant(): Promise<RtcParticipantObservation | null> {
    throw disabled('getParticipant');
  }
}

function disabled(operation: string): RtcUnavailableError {
  return new RtcUnavailableError(`${operation} (media disabled)`);
}
