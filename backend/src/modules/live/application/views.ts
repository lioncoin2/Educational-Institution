import type { LiveParticipantRole } from '../contracts/participant-role';
import type { LiveSession, LiveSessionEndReason, LiveSessionState } from '../domain/live-session';
import type { RtcCapabilities } from '../domain/rtc-provider';
import type { SpeakerRequest, SpeakerRequestState } from '../domain/speaker-request';
import type { ObservedMedia, PushOutcome } from './live-media';

/**
 * What Live's routes answer — application views, never domain objects
 * (live.md §15.3). No view carries an email, and only the moderators' hands
 * page carries a name, from the account directory.
 */

/**
 * A session as one caller sees it. `me` holds that caller's flags, computed
 * on the server as display hints — every command re-checks — and
 * `moderation` is present for the session's moderators only.
 */
export interface LiveSessionView {
  readonly id: string;
  readonly communityId: string;
  readonly state: LiveSessionState;
  /** A client applies only a newer version than the one it holds, and refetches. */
  readonly stateVersion: number;
  readonly hostUserId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly endReason: LiveSessionEndReason | null;
  readonly participantCap: number;
  /** Granted hands: at most MAX_CONCURRENT_SPEAKERS. */
  readonly speakerCount: number;
  readonly presenterUserId: string | null;
  readonly me: LiveSessionMe;
  readonly moderation: LiveSessionModeration | null;
}

export interface LiveSessionMe {
  readonly role: LiveParticipantRole;
  /** The caller started this session. The host is a moderator while Communities says so. */
  readonly isHost: boolean;
  /** `/join` would admit them now (the soft cap aside). */
  readonly canJoin: boolean;
  /** They may raise a hand now; while `hand` is set, raising again answers that hand. */
  readonly canRaiseHand: boolean;
  /** They may grant, decline and revoke hands, and list them. */
  readonly canModerate: boolean;
  /** They may end the session — any of its moderators (audit D2). */
  readonly canEnd: boolean;
  /** They may take the presenter slot now: a moderator holding `live.speak`, and the slot is free or theirs. */
  readonly canPresent: boolean;
  readonly presenting: boolean;
  /** Their open hand, if any. */
  readonly hand: { readonly requestId: string; readonly state: SpeakerRequestState } | null;
}

export interface LiveSessionModeration {
  /** Counts at most PENDING_HANDS_COUNT_CAP rows: that value means "this many or more" (audit D8). */
  readonly pendingHands: number;
  readonly violations: number;
  readonly lastViolationAt: Date | null;
}

export function liveSessionView(
  session: LiveSession,
  extras: {
    readonly speakerCount: number;
    readonly presenterUserId: string | null;
    readonly me: LiveSessionMe;
    readonly pendingHands: number | null;
  },
): LiveSessionView {
  return {
    id: session.id,
    communityId: session.communityId,
    state: session.state,
    stateVersion: session.stateVersion,
    hostUserId: session.hostUserId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endReason: session.endReason,
    participantCap: session.participantCap,
    speakerCount: extras.speakerCount,
    presenterUserId: extras.presenterUserId,
    me: extras.me,
    moderation:
      extras.pendingHands === null
        ? null
        : {
            pendingHands: extras.pendingHands,
            violations: session.enforcementViolations,
            lastViolationAt: session.lastViolationAt,
          },
  };
}

/** A hand, shown by id: names are resolved only where a moderator's list needs them. */
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

/** A hand on the moderators' page: its owner's name from the directory (never an email). */
export interface HandView extends SpeakerRequestView {
  readonly displayName: string;
  /** Granted hands only: the speaker's connection as last observed (audit D7). */
  readonly media?: ObservedMedia;
}

export interface HandsPage {
  readonly items: readonly HandView[];
  /** Opaque; null on the last page. */
  readonly nextCursor: string | null;
}

/**
 * What happened on the media plane when the floor changed hands — a push's
 * answer (`applied`, `not_connected`, `pending`), or `unchanged` for a repeat
 * of a decision already taken, when nothing was sent.
 */
export type MediaOutcome = PushOutcome | 'unchanged';

export interface ModerationResult {
  readonly request: SpeakerRequestView;
  readonly media: MediaOutcome;
}

export interface DeclineResult {
  readonly request: SpeakerRequestView;
}

export interface RaiseHandResult {
  /** True for a new hand (201); false for the hand already up (200). */
  readonly created: boolean;
  readonly request: SpeakerRequestView;
}

export interface LowerHandResult {
  readonly request: SpeakerRequestView | null;
}

export interface StartResult {
  /** True when this call created the session (201); false for the running one (200). */
  readonly created: boolean;
  readonly session: LiveSessionView;
}

export interface CurrentSessionResult {
  readonly session: LiveSessionView | null;
}

export interface ClaimResult {
  /** True when this call opened the presenter slot (201); false when the caller already held it (200). */
  readonly opened: boolean;
  readonly session: LiveSessionView;
}

export interface KickParticipantResult {
  /** True when the target was connected and has been removed; false when they were not in the room. */
  readonly removed: boolean;
}

export interface ResetRoomResult {
  /** True when this call moved the room to a new generation; false when a concurrent reset or the end already did. */
  readonly reset: boolean;
}

/**
 * The only thing that carries a media credential. Never logged, never in an
 * event, frame or audit entry. `expiresInSeconds` and `expiresAt` bound only
 * the FIRST connection: once connected, the media server itself keeps issuing
 * the client fresh tokens with its current permissions (live.md §9), and
 * `/join` is the way back in after that.
 */
export interface JoinTicket {
  /** The session the ticket is for — the one in the path. */
  readonly sessionId: string;
  readonly token: string;
  readonly url: string;
  readonly expiresInSeconds: number;
  /** When the token stops admitting a new connection: never later than the token says. */
  readonly expiresAt: Date;
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
