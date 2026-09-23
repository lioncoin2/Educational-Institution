import type { LiveParticipantRole } from '../contracts/participant-role';
import type { RtcCapabilities } from '../domain/rtc-provider';
import type { SpeakerRequest, SpeakerRequestState } from '../domain/speaker-request';

/**
 * What live's routes answer — application views, never domain objects.
 * No display name here: a hand is shown by id; names are resolved from the
 * account directory where a moderator's list needs them.
 */
export interface SpeakerRequestView {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly state: SpeakerRequestState;
  readonly requestedAt: Date;
  readonly grantedAt: Date | null;
  readonly decidedAt: Date | null;
}

export function speakerRequestView(request: SpeakerRequest): SpeakerRequestView {
  return {
    id: request.id,
    sessionId: request.sessionId,
    userId: request.userId,
    state: request.state,
    requestedAt: request.requestedAt,
    grantedAt: request.grantedAt,
    decidedAt: request.decidedAt,
  };
}

/**
 * What happened on the media plane when the floor changed hands:
 *   applied        — the provider holds the new permission set now;
 *   not_connected  — the person is not in the room: their next join carries it;
 *   pending        — the provider did not take it yet (it was unreachable,
 *                    or it refused and the fault was logged): it is
 *                    re-applied until it lands (see `CapabilityConvergence`);
 *   unchanged      — a repeat of a decision already taken: nothing was sent.
 */
export type MediaOutcome = 'applied' | 'not_connected' | 'pending' | 'unchanged';

export interface ModerationResult {
  readonly request: SpeakerRequestView;
  readonly media: MediaOutcome;
}

export interface RaiseHandResult {
  readonly created: boolean;
  readonly request: SpeakerRequestView;
}

export interface LowerHandResult {
  readonly request: SpeakerRequestView | null;
}

/**
 * The only thing that carries a media credential. Never logged, never in an
 * event, frame or audit entry. `expiresInSeconds` bounds only the FIRST
 * connection: once connected, the media server itself keeps issuing the
 * client fresh tokens with its current permissions (see live.md §9).
 */
export interface JoinTicket {
  readonly token: string;
  readonly url: string;
  readonly expiresInSeconds: number;
  readonly role: LiveParticipantRole;
  readonly media: {
    readonly microphone: boolean;
    readonly screen: boolean;
    readonly screenAudio: boolean;
  };
}

export function mediaOf(capabilities: RtcCapabilities): JoinTicket['media'] {
  return {
    microphone: capabilities.canPublishAudio,
    screen: capabilities.canPublishScreen,
    screenAudio: capabilities.canPublishScreen && capabilities.canPublishScreenAudio,
  };
}
