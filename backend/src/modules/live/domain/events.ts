import { domainEvent } from '../../../shared/domain-event';
import {
  LiveEvents,
  type LiveChatLockChanged,
  type LiveChatPosted,
  type LiveReactionSent,
  type LiveMediaReset,
  type LiveParticipantRemoved,
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
} from '../contracts/events';
import type { LiveChatMessage, LiveChatState } from './live-chat';
import type { LiveReactionKind } from './live-reaction';
import { durationSeconds, type LiveSession } from './live-session';
import type { PresenterGrant } from './presenter-grant';
import { lastOpenState, type SpeakerRequest } from './speaker-request';

/**
 * Builds live's facts. Their names and payload types are the public contract
 * (`../contracts/events.ts`), so a subscriber never needs live's domain.
 *
 * Each factory takes the records as the repository returned them after the
 * change, and the session's new `stateVersion`, so an event says exactly what
 * was stored: who decided, when, and from which state. Payloads are built
 * field by field, never spread from an entity, so nothing but ids, codes and
 * versions can ride along. The aggregate is always the session.
 */
export type {
  LiveEvent,
  LiveMediaReset,
  LiveParticipantRemoved,
  LiveSessionEnded,
  LiveSessionStarted,
  ScreenShareStarted,
  ScreenShareStopped,
  SpeakerPermissionGranted,
  SpeakerPermissionRevoked,
  SpeakerRequestDeclined,
  SpeakerRequestExpired,
  SpeakerRequestWithdrawn,
  SpeakerRequested,
} from '../contracts/events';

/** The part of a session every event names. */
type SessionRef = Pick<LiveSession, 'id' | 'communityId'>;

export function liveSessionStarted(
  session: LiveSession,
  correlationId?: string,
): LiveSessionStarted {
  return domainEvent(
    LiveEvents.sessionStarted,
    session.id,
    { sessionId: session.id, communityId: session.communityId, hostUserId: session.hostUserId },
    session.startedAt,
    correlationId,
  );
}

/** One per end that changed the session; it implies every expiry and the presenter's close. */
export function liveSessionEnded(session: LiveSession, correlationId?: string): LiveSessionEnded {
  const duration = durationSeconds(session);
  if (session.endedAt === null || session.endReason === null || duration === null) {
    throw new RangeError('only an ended session is announced as ended');
  }
  return domainEvent(
    LiveEvents.sessionEnded,
    session.id,
    {
      sessionId: session.id,
      communityId: session.communityId,
      endedBy: session.endedBy,
      reason: session.endReason,
      durationSeconds: duration,
    },
    session.endedAt,
    correlationId,
  );
}

export function speakerRequested(
  session: SessionRef,
  request: SpeakerRequest,
  stateVersion: number,
  correlationId?: string,
): SpeakerRequested {
  return domainEvent(
    LiveEvents.speakerRequested,
    session.id,
    speakerFact(session, request, stateVersion),
    request.requestedAt,
    correlationId,
  );
}

export function speakerGranted(
  session: SessionRef,
  request: SpeakerRequest,
  stateVersion: number,
  correlationId?: string,
): SpeakerPermissionGranted {
  const { by, at } = decision(request);
  return domainEvent(
    LiveEvents.speakerGranted,
    session.id,
    { ...speakerFact(session, request, stateVersion), grantedBy: by },
    at,
    correlationId,
  );
}

export function speakerDeclined(
  session: SessionRef,
  request: SpeakerRequest,
  stateVersion: number,
  correlationId?: string,
): SpeakerRequestDeclined {
  const { by, at } = decision(request);
  return domainEvent(
    LiveEvents.speakerDeclined,
    session.id,
    { ...speakerFact(session, request, stateVersion), declinedBy: by },
    at,
    correlationId,
  );
}

export function speakerRevoked(
  session: SessionRef,
  request: SpeakerRequest,
  stateVersion: number,
  correlationId?: string,
): SpeakerPermissionRevoked {
  const { by, at } = decision(request);
  return domainEvent(
    LiveEvents.speakerRevoked,
    session.id,
    { ...speakerFact(session, request, stateVersion), revokedBy: by },
    at,
    correlationId,
  );
}

/** A withdrawal, or a speaker's yield: `from` is the open state it left. */
export function speakerWithdrawn(
  session: SessionRef,
  request: SpeakerRequest,
  stateVersion: number,
  correlationId?: string,
): SpeakerRequestWithdrawn {
  const { at } = decision(request);
  return domainEvent(
    LiveEvents.speakerWithdrawn,
    session.id,
    { ...speakerFact(session, request, stateVersion), from: lastOpenState(request) },
    at,
    correlationId,
  );
}

/** The ineligible expiry only — never the end's, which `live.session.ended` implies. */
export function speakerExpired(
  session: SessionRef,
  request: SpeakerRequest,
  stateVersion: number,
  correlationId?: string,
): SpeakerRequestExpired {
  if (request.state !== 'expired' || request.decidedAt === null) {
    throw new RangeError('only an expired request is announced as expired');
  }
  return domainEvent(
    LiveEvents.speakerExpired,
    session.id,
    {
      ...speakerFact(session, request, stateVersion),
      from: lastOpenState(request),
      cause: 'ineligible',
    },
    request.decidedAt,
    correlationId,
  );
}

export function screenShareStarted(
  session: SessionRef,
  grant: PresenterGrant,
  stateVersion: number,
  correlationId?: string,
): ScreenShareStarted {
  return domainEvent(
    LiveEvents.screenShareStarted,
    session.id,
    {
      sessionId: session.id,
      communityId: session.communityId,
      userId: grant.userId,
      grantedBy: grant.grantedBy,
      stateVersion,
    },
    grant.grantedAt,
    correlationId,
  );
}

/** A close while the session runs — never the end's, which `live.session.ended` implies. */
export function screenShareStopped(
  session: SessionRef,
  grant: PresenterGrant,
  stateVersion: number,
  correlationId?: string,
): ScreenShareStopped {
  const reason = grant.endReason;
  if (grant.endedAt === null || reason === null || reason === 'session_ended') {
    throw new RangeError('only a grant closed while the session runs is announced as stopped');
  }
  return domainEvent(
    LiveEvents.screenShareStopped,
    session.id,
    {
      sessionId: session.id,
      communityId: session.communityId,
      userId: grant.userId,
      stoppedBy: grant.endedBy,
      reason,
      stateVersion,
    },
    grant.endedAt,
    correlationId,
  );
}

/** A moderator removed a participant (Q64). An administrative disconnect, not a ban. */
export function participantRemoved(
  session: SessionRef,
  userId: string,
  removedBy: string,
  reason: string | null,
  at: Date,
  correlationId?: string,
): LiveParticipantRemoved {
  return domainEvent(
    LiveEvents.participantRemoved,
    session.id,
    { sessionId: session.id, communityId: session.communityId, userId, removedBy, reason },
    at,
    correlationId,
  );
}

/** A moderator reset the media room (Q64): the room generation moved `fromEpoch` → `toEpoch`. */
export function mediaReset(
  session: SessionRef,
  fromEpoch: number,
  toEpoch: number,
  resetBy: string,
  at: Date,
  correlationId?: string,
): LiveMediaReset {
  return domainEvent(
    LiveEvents.mediaReset,
    session.id,
    { sessionId: session.id, communityId: session.communityId, fromEpoch, toEpoch, resetBy },
    at,
    correlationId,
  );
}

function speakerFact(
  session: SessionRef,
  request: SpeakerRequest,
  stateVersion: number,
): LiveSpeakerFact {
  return {
    sessionId: session.id,
    communityId: session.communityId,
    requestId: request.id,
    userId: request.userId,
    stateVersion,
  };
}

/** Who decided a request a person decided, and when — set for every such state (R3). */
function decision(request: SpeakerRequest): { readonly by: string; readonly at: Date } {
  if (request.decidedBy === null || request.decidedAt === null) {
    throw new RangeError(`a ${request.state} request carries no decision to announce`);
  }
  return { by: request.decidedBy, at: request.decidedAt };
}

/** A chat post (ADR 0047): ids and the position — never the text. */
export function liveChatPosted(
  session: SessionRef,
  message: LiveChatMessage,
  correlationId?: string,
): LiveChatPosted {
  return domainEvent(
    LiveEvents.chatPosted,
    session.id,
    {
      sessionId: session.id,
      communityId: session.communityId,
      messageId: message.id,
      senderId: message.senderId,
      position: message.position,
    },
    message.createdAt,
    correlationId,
  );
}

/** A moderator locked or unlocked the session's chat (ADR 0047). */
export function liveChatLockChanged(
  session: SessionRef,
  state: LiveChatState,
  changedBy: string,
  at: Date,
  correlationId?: string,
): LiveChatLockChanged {
  return domainEvent(
    LiveEvents.chatLockChanged,
    session.id,
    {
      sessionId: session.id,
      communityId: session.communityId,
      locked: state.locked,
      lockVersion: state.lockVersion,
      changedBy,
    },
    at,
    correlationId,
  );
}

/** A participant's reaction (C15, ADR 0049): the kind and an id — the sender stays on the server. */
export function liveReactionSent(
  session: SessionRef,
  reaction: {
    readonly id: string;
    readonly kind: LiveReactionKind;
    readonly sentBy: string;
    readonly at: Date;
  },
  correlationId?: string,
): LiveReactionSent {
  return domainEvent(
    LiveEvents.reactionSent,
    session.id,
    {
      sessionId: session.id,
      communityId: session.communityId,
      reactionId: reaction.id,
      kind: reaction.kind,
      sentBy: reaction.sentBy,
    },
    reaction.at,
    correlationId,
  );
}
