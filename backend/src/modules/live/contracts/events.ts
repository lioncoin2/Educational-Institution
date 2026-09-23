import type { DomainEvent } from '../../../shared/domain-event';

/**
 * Facts live publishes, for any module to react to without importing live's
 * internals. Their names and payloads are declared here, in the public
 * contract, because a subscriber may import nothing of another module but its
 * `contracts/` (`no-cross-module-internals`); the domain's factories build
 * them from these types.
 *
 * Payloads carry identifiers only — never a display name, a token or a URL.
 * Every event's `aggregateId` is the live session id, so one session's facts
 * form one ordered stream.
 *
 * Nothing subscribes to them yet. Attendance snapshots are designed as a
 * separate module that asks live's contracts at the moment a snapshot is
 * taken (ADR 0020, implementation held) — not as a reaction to these events.
 */
export const LiveEvents = {
  sessionStarted: 'live.session.started',
  sessionEnded: 'live.session.ended',
  speakerRequested: 'live.speaker.requested',
  speakerGranted: 'live.speaker.granted',
  speakerRevoked: 'live.speaker.revoked',
} as const;

export type LiveSessionStarted = DomainEvent<
  typeof LiveEvents.sessionStarted,
  { readonly sessionId: string; readonly roomId: string; readonly hostUserId: string }
>;

export type LiveSessionEnded = DomainEvent<
  typeof LiveEvents.sessionEnded,
  { readonly sessionId: string; readonly roomId: string; readonly durationSeconds: number }
>;

export type SpeakerRequested = DomainEvent<
  typeof LiveEvents.speakerRequested,
  { readonly sessionId: string; readonly requestId: string; readonly userId: string }
>;

export type SpeakerPermissionGranted = DomainEvent<
  typeof LiveEvents.speakerGranted,
  { readonly sessionId: string; readonly userId: string; readonly grantedBy: string }
>;

export type SpeakerPermissionRevoked = DomainEvent<
  typeof LiveEvents.speakerRevoked,
  { readonly sessionId: string; readonly userId: string; readonly revokedBy: string }
>;
