import { domainEvent } from '../../../shared/domain-event';
import {
  LiveEvents,
  type LiveSessionEnded,
  type LiveSessionStarted,
  type SpeakerPermissionGranted,
  type SpeakerPermissionRevoked,
  type SpeakerRequestDeclined,
  type SpeakerRequestWithdrawn,
  type SpeakerRequested,
} from '../contracts/events';

/**
 * Builds live's facts. Their names and payload types are the public contract
 * (`../contracts/events.ts`), so a subscriber never needs live's domain.
 */
export type {
  LiveSessionEnded,
  LiveSessionStarted,
  SpeakerPermissionGranted,
  SpeakerPermissionRevoked,
  SpeakerRequestDeclined,
  SpeakerRequestWithdrawn,
  SpeakerRequested,
} from '../contracts/events';

export function liveSessionStarted(
  sessionId: string,
  roomId: string,
  hostUserId: string,
  at: Date,
): LiveSessionStarted {
  return domainEvent(LiveEvents.sessionStarted, sessionId, { sessionId, roomId, hostUserId }, at);
}

export function liveSessionEnded(
  sessionId: string,
  roomId: string,
  durationSeconds: number,
  at: Date,
): LiveSessionEnded {
  return domainEvent(
    LiveEvents.sessionEnded,
    sessionId,
    { sessionId, roomId, durationSeconds },
    at,
  );
}

export function speakerRequested(
  sessionId: string,
  requestId: string,
  userId: string,
  at: Date,
): SpeakerRequested {
  return domainEvent(LiveEvents.speakerRequested, sessionId, { sessionId, requestId, userId }, at);
}

export function speakerPermissionGranted(
  sessionId: string,
  userId: string,
  grantedBy: string,
  at: Date,
): SpeakerPermissionGranted {
  return domainEvent(LiveEvents.speakerGranted, sessionId, { sessionId, userId, grantedBy }, at);
}

export function speakerPermissionRevoked(
  sessionId: string,
  userId: string,
  revokedBy: string,
  at: Date,
): SpeakerPermissionRevoked {
  return domainEvent(LiveEvents.speakerRevoked, sessionId, { sessionId, userId, revokedBy }, at);
}

export function speakerRequestDeclined(
  sessionId: string,
  userId: string,
  declinedBy: string,
  at: Date,
): SpeakerRequestDeclined {
  return domainEvent(LiveEvents.speakerDeclined, sessionId, { sessionId, userId, declinedBy }, at);
}

export function speakerRequestWithdrawn(
  sessionId: string,
  userId: string,
  from: 'pending' | 'granted',
  at: Date,
): SpeakerRequestWithdrawn {
  return domainEvent(LiveEvents.speakerWithdrawn, sessionId, { sessionId, userId, from }, at);
}
