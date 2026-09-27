/**
 * Live's public surface.
 *
 * Other modules react to live events rather than calling in; this exports the
 * event names and payload types, and the vocabulary needed to interpret them.
 */
export type { LiveParticipantRole } from './participant-role';
export {
  LiveEvents,
  type LiveEvent,
  type LiveSessionEnded,
  type LiveSessionStarted,
  type LiveSpeakerFact,
  type ScreenShareStarted,
  type ScreenShareStopped,
  type SpeakerPermissionGranted,
  type SpeakerPermissionRevoked,
  type SpeakerRequestDeclined,
  type SpeakerRequestExpired,
  type SpeakerRequestWithdrawn,
  type SpeakerRequested,
} from './events';
