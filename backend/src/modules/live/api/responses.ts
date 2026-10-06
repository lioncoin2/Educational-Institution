import type { LiveParticipantRole } from '../contracts/participant-role';
import type {
  HandView,
  HandsPage,
  JoinTicket,
  KickParticipantResult,
  LiveSessionView,
  MediaOutcome,
  ModerationResult,
  ResetRoomResult,
  SpeakerRequestView,
} from '../application/views';

/**
 * Wire shapes: explicit and flat, instants as ISO-8601. Every field is copied
 * by name, so nothing a view gains later reaches a client unannounced. No
 * response carries an email; only the moderators' hands page carries names,
 * from the account directory; and only the join ticket carries a credential.
 */

export interface LiveSessionResponse {
  readonly id: string;
  readonly communityId: string;
  readonly state: LiveSessionView['state'];
  readonly stateVersion: number;
  readonly hostUserId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endReason: LiveSessionView['endReason'];
  readonly participantCap: number;
  readonly speakerCount: number;
  readonly presenterUserId: string | null;
  /** The caller's own flags: display hints, computed on the server — every command asks again. */
  readonly me: {
    readonly role: LiveParticipantRole;
    readonly isHost: boolean;
    readonly canJoin: boolean;
    readonly canRaiseHand: boolean;
    readonly canModerate: boolean;
    readonly canEnd: boolean;
    readonly canPresent: boolean;
    readonly presenting: boolean;
    readonly hand: {
      readonly requestId: string;
      readonly state: SpeakerRequestView['state'];
    } | null;
  };
  /** The session's moderators only. `pendingHands` stops counting at 100: that value means "100 or more". */
  readonly moderation: {
    readonly pendingHands: number;
    readonly violations: number;
    readonly lastViolationAt: string | null;
  } | null;
}

export function toLiveSessionResponse(view: LiveSessionView): LiveSessionResponse {
  const { me, moderation } = view;
  return {
    id: view.id,
    communityId: view.communityId,
    state: view.state,
    stateVersion: view.stateVersion,
    hostUserId: view.hostUserId,
    startedAt: view.startedAt.toISOString(),
    endedAt: view.endedAt?.toISOString() ?? null,
    endReason: view.endReason,
    participantCap: view.participantCap,
    speakerCount: view.speakerCount,
    presenterUserId: view.presenterUserId,
    me: {
      role: me.role,
      isHost: me.isHost,
      canJoin: me.canJoin,
      canRaiseHand: me.canRaiseHand,
      canModerate: me.canModerate,
      canEnd: me.canEnd,
      canPresent: me.canPresent,
      presenting: me.presenting,
      hand: me.hand === null ? null : { requestId: me.hand.requestId, state: me.hand.state },
    },
    moderation:
      moderation === null
        ? null
        : {
            pendingHands: moderation.pendingHands,
            violations: moderation.violations,
            lastViolationAt: moderation.lastViolationAt?.toISOString() ?? null,
          },
  };
}

/** `{session: null}` when the community has no live session. */
export function toCurrentSessionResponse(session: LiveSessionView | null): {
  readonly session: LiveSessionResponse | null;
} {
  return { session: session === null ? null : toLiveSessionResponse(session) };
}

export interface SpeakerRequestResponse {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly state: SpeakerRequestView['state'];
  readonly requestedAt: string;
  readonly grantedAt: string | null;
  readonly decidedAt: string | null;
}

export function toSpeakerRequestResponse(view: SpeakerRequestView): SpeakerRequestResponse {
  return {
    id: view.id,
    sessionId: view.sessionId,
    userId: view.userId,
    state: view.state,
    requestedAt: view.requestedAt.toISOString(),
    grantedAt: view.grantedAt?.toISOString() ?? null,
    decidedAt: view.decidedAt?.toISOString() ?? null,
  };
}

/** A raised hand, a declined one, or a lowered one — null when none was up. */
export function toRequestResponse(result: { readonly request: SpeakerRequestView | null }): {
  readonly request: SpeakerRequestResponse | null;
} {
  return { request: result.request === null ? null : toSpeakerRequestResponse(result.request) };
}

/** A grant or a revoke, with what the media plane answered (`unchanged` for a repeat). */
export function toModerationResponse(result: ModerationResult): {
  readonly request: SpeakerRequestResponse;
  readonly media: MediaOutcome;
} {
  return { request: toSpeakerRequestResponse(result.request), media: result.media };
}

/** A hand on the moderators' page; a granted one adds its holder's last observed connection. */
export interface HandResponse extends SpeakerRequestResponse {
  readonly displayName: string;
  readonly media?: HandView['media'];
}

export function toHandsPageResponse(page: HandsPage): {
  readonly items: readonly HandResponse[];
  readonly nextCursor: string | null;
} {
  return {
    items: page.items.map((hand) => ({
      ...toSpeakerRequestResponse(hand),
      displayName: hand.displayName,
      ...(hand.media === undefined ? {} : { media: hand.media }),
    })),
    nextCursor: page.nextCursor,
  };
}

/**
 * The only response that carries a media credential: exactly these fields.
 * Never logged, published, framed or audited. `url` is the client-facing
 * LIVEKIT_URL — never the server API's.
 */
export interface JoinTicketResponse {
  readonly sessionId: string;
  readonly token: string;
  readonly url: string;
  readonly expiresInSeconds: number;
  /** ISO-8601: when the token stops admitting a new connection. */
  readonly expiresAt: string;
  readonly role: LiveParticipantRole;
  readonly media: {
    readonly microphone: boolean;
    readonly screen: boolean;
    readonly screenAudio: boolean;
  };
}

export function toJoinTicketResponse(ticket: JoinTicket): JoinTicketResponse {
  return {
    sessionId: ticket.sessionId,
    token: ticket.token,
    url: ticket.url,
    expiresInSeconds: ticket.expiresInSeconds,
    expiresAt: ticket.expiresAt.toISOString(),
    role: ticket.role,
    media: {
      microphone: ticket.media.microphone,
      screen: ticket.media.screen,
      screenAudio: ticket.media.screenAudio,
    },
  };
}

/** A participant removed by a moderator; `removed: false` when they were not in the room. */
export function toParticipantRemovedResponse(result: KickParticipantResult): {
  readonly removed: boolean;
} {
  return { removed: result.removed };
}

/** A media-room reset; `reset: false` when a concurrent reset or the end already moved it. */
export function toRoomResetResponse(result: ResetRoomResult): { readonly reset: boolean } {
  return { reset: result.reset };
}
