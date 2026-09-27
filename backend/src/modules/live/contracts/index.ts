/**
 * Live's public surface.
 *
 * Other modules mostly react to live events rather than calling in; this
 * exports the event names and payload types and the vocabulary needed to
 * interpret them, and two contracts bound by LiveModule: LIVE_SESSIONS (a
 * session's scope, from Live's own record) and LIVE_AUDIENCE (who a
 * session's facts may reach, as Communities answers it).
 */
export { LIVE_AUDIENCE, MAX_AUDIENCE_PROBE, type LiveAudience } from './live-audience';
export { LIVE_SESSIONS, type LiveSessionScope, type LiveSessions } from './live-sessions';
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
