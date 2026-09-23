/**
 * Live's public surface.
 *
 * Other modules react to live events rather than calling in; this exports the
 * event names and payload types, and the vocabulary needed to interpret them.
 */
export type { ParticipantRole } from './participant-role';
export {
  LiveEvents,
  type LiveSessionEnded,
  type LiveSessionStarted,
  type SpeakerPermissionGranted,
  type SpeakerPermissionRevoked,
  type SpeakerRequested,
} from './events';
