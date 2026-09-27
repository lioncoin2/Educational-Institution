import type { DomainEvent } from '../../../shared/domain-event';

/**
 * Facts live publishes, for any module to react to without importing live's
 * internals. Their names and payloads are declared here, in the public
 * contract, because a subscriber may import nothing of another module but its
 * `contracts/` (`no-cross-module-internals`); the domain's factories build
 * them from these types.
 *
 * Published through the live journal after the change is stored — audit
 * first, then the event — and never for a repeat that changed nothing.
 * Every event's `aggregateId` is the live session id, so one session's facts
 * form one ordered stream. Payloads carry ids, codes and versions ONLY — never
 * a display name, a token, a URL or a participant list — and every payload
 * names its community. `stateVersion` is the session's version after the
 * change: a client applies only a newer one, and refetches over HTTP.
 *
 * An event is a hint, never a grant: every consumer re-asks (ADR 0021). The
 * realtime relay turns them into frames; nothing else subscribes yet.
 */
export const LiveEvents = {
  sessionStarted: 'live.session.started',
  sessionEnded: 'live.session.ended',
  speakerRequested: 'live.speaker.requested',
  speakerGranted: 'live.speaker.granted',
  speakerDeclined: 'live.speaker.declined',
  speakerRevoked: 'live.speaker.revoked',
  speakerWithdrawn: 'live.speaker.withdrawn',
  speakerExpired: 'live.speaker.expired',
  screenShareStarted: 'live.screen_share.started',
  screenShareStopped: 'live.screen_share.stopped',
} as const;

/** A start created the community's live session — never a repeat, never a lost race. */
export type LiveSessionStarted = DomainEvent<
  typeof LiveEvents.sessionStarted,
  { readonly sessionId: string; readonly communityId: string; readonly hostUserId: string }
>;

/**
 * A live session ended — published once, by the end that changed it. It
 * implies that every open hand expired and the presenter grant closed in the
 * same step: no per-hand or screen-share event follows. `endedBy` is null
 * when the system ended it.
 */
export type LiveSessionEnded = DomainEvent<
  typeof LiveEvents.sessionEnded,
  {
    readonly sessionId: string;
    readonly communityId: string;
    readonly endedBy: string | null;
    readonly reason: 'moderator' | 'idle' | 'community_closed';
    readonly durationSeconds: number;
  }
>;

/** What every speaker event carries: the request, its owner, and the session's new version. */
export interface LiveSpeakerFact {
  readonly sessionId: string;
  readonly communityId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly stateVersion: number;
}

/** A raise created a request (a hand already up publishes nothing). Not audited. */
export type SpeakerRequested = DomainEvent<typeof LiveEvents.speakerRequested, LiveSpeakerFact>;

export type SpeakerPermissionGranted = DomainEvent<
  typeof LiveEvents.speakerGranted,
  LiveSpeakerFact & { readonly grantedBy: string }
>;

export type SpeakerRequestDeclined = DomainEvent<
  typeof LiveEvents.speakerDeclined,
  LiveSpeakerFact & { readonly declinedBy: string }
>;

export type SpeakerPermissionRevoked = DomainEvent<
  typeof LiveEvents.speakerRevoked,
  LiveSpeakerFact & { readonly revokedBy: string }
>;

/**
 * The requester lowered their own hand: a pending hand withdrawn, or a
 * speaker yielding the floor (`from: 'granted'`). Not audited — it is the
 * person's own act, not moderation.
 */
export type SpeakerRequestWithdrawn = DomainEvent<
  typeof LiveEvents.speakerWithdrawn,
  LiveSpeakerFact & { readonly from: 'pending' | 'granted' }
>;

/**
 * The system expired an open hand because its owner may no longer take part.
 * Never published for the end of a session, which `live.session.ended`
 * implies. Not audited: its cause is audited by the module that owns it.
 */
export type SpeakerRequestExpired = DomainEvent<
  typeof LiveEvents.speakerExpired,
  LiveSpeakerFact & { readonly from: 'pending' | 'granted'; readonly cause: 'ineligible' }
>;

/** A moderator took the presenter slot for themself. */
export type ScreenShareStarted = DomainEvent<
  typeof LiveEvents.screenShareStarted,
  {
    readonly sessionId: string;
    readonly communityId: string;
    readonly userId: string;
    readonly grantedBy: string;
    readonly stateVersion: number;
  }
>;

/**
 * The presenter slot closed while the session runs: the presenter stopped,
 * another moderator revoked it, or the presenter became ineligible (then
 * `stoppedBy` is null: the system). Never published for the end of a session.
 */
export type ScreenShareStopped = DomainEvent<
  typeof LiveEvents.screenShareStopped,
  {
    readonly sessionId: string;
    readonly communityId: string;
    readonly userId: string;
    readonly stoppedBy: string | null;
    readonly reason: 'stopped' | 'revoked' | 'ineligible';
    readonly stateVersion: number;
  }
>;

/** Every fact live publishes. */
export type LiveEvent =
  | LiveSessionStarted
  | LiveSessionEnded
  | SpeakerRequested
  | SpeakerPermissionGranted
  | SpeakerRequestDeclined
  | SpeakerPermissionRevoked
  | SpeakerRequestWithdrawn
  | SpeakerRequestExpired
  | ScreenShareStarted
  | ScreenShareStopped;
