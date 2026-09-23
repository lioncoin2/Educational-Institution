import { domainEvent, type DomainEvent } from '../../../shared';

/**
 * Facts other modules react to.
 *
 * Operations turns `LiveSessionStarted`/`Ended` into attendance; Notifications
 * turns `SpeakerPermissionGranted` into a nudge. Neither module imports Live.
 */
export type LiveSessionStarted = DomainEvent<
  'live.session.started',
  { readonly sessionId: string; readonly roomId: string; readonly hostUserId: string }
>;

export type LiveSessionEnded = DomainEvent<
  'live.session.ended',
  { readonly sessionId: string; readonly roomId: string; readonly durationSeconds: number }
>;

export type SpeakerRequested = DomainEvent<
  'live.speaker.requested',
  { readonly sessionId: string; readonly requestId: string; readonly userId: string }
>;

export type SpeakerPermissionGranted = DomainEvent<
  'live.speaker.granted',
  { readonly sessionId: string; readonly userId: string; readonly grantedBy: string }
>;

export type SpeakerPermissionRevoked = DomainEvent<
  'live.speaker.revoked',
  { readonly sessionId: string; readonly userId: string; readonly revokedBy: string }
>;

export function liveSessionStarted(
  sessionId: string,
  roomId: string,
  hostUserId: string,
  at: Date,
): LiveSessionStarted {
  return domainEvent('live.session.started', sessionId, { sessionId, roomId, hostUserId }, at);
}

export function liveSessionEnded(
  sessionId: string,
  roomId: string,
  durationSeconds: number,
  at: Date,
): LiveSessionEnded {
  return domainEvent('live.session.ended', sessionId, { sessionId, roomId, durationSeconds }, at);
}

export function speakerRequested(
  sessionId: string,
  requestId: string,
  userId: string,
  at: Date,
): SpeakerRequested {
  return domainEvent('live.speaker.requested', sessionId, { sessionId, requestId, userId }, at);
}

export function speakerPermissionGranted(
  sessionId: string,
  userId: string,
  grantedBy: string,
  at: Date,
): SpeakerPermissionGranted {
  return domainEvent('live.speaker.granted', sessionId, { sessionId, userId, grantedBy }, at);
}

export function speakerPermissionRevoked(
  sessionId: string,
  userId: string,
  revokedBy: string,
  at: Date,
): SpeakerPermissionRevoked {
  return domainEvent('live.speaker.revoked', sessionId, { sessionId, userId, revokedBy }, at);
}
