import { asId } from '../../../shared';
import type { LiveSession } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import type { PresenterGrant } from '../domain/presenter-grant';
import type { SpeakerRequest } from '../domain/speaker-request';
import type {
  LiveSessionRow,
  ModerationActionRow,
  PresenterGrantRow,
  SpeakerRequestRow,
} from './schema';

/** Rows to entities and back, field by field — no spreading, so no column leaks. */

export function toLiveSession(row: LiveSessionRow): LiveSession {
  return {
    id: asId<'LiveSession'>(row.id),
    communityId: row.communityId,
    hostUserId: row.hostUserId,
    state: row.state,
    stateVersion: Number(row.stateVersion),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
    endReason: row.endReason,
    participantCap: row.participantCap,
    moderatorReserve: row.moderatorReserve,
    mediaRoomEpoch: row.mediaRoomEpoch,
    emptySince: row.emptySince,
    enforcementViolations: row.enforcementViolations,
    lastViolationAt: row.lastViolationAt,
  };
}

export function liveSessionRow(session: LiveSession): LiveSessionRow {
  return {
    id: session.id,
    communityId: session.communityId,
    hostUserId: session.hostUserId,
    state: session.state,
    stateVersion: session.stateVersion,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endedBy: session.endedBy,
    endReason: session.endReason,
    participantCap: session.participantCap,
    moderatorReserve: session.moderatorReserve,
    mediaRoomEpoch: session.mediaRoomEpoch,
    emptySince: session.emptySince,
    enforcementViolations: session.enforcementViolations,
    lastViolationAt: session.lastViolationAt,
  };
}

export function toSpeakerRequest(row: SpeakerRequestRow): SpeakerRequest {
  return {
    id: asId<'SpeakerRequest'>(row.id),
    sessionId: row.sessionId,
    userId: row.userId,
    state: row.state,
    requestedAt: row.requestedAt,
    grantedAt: row.grantedAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
  };
}

export function speakerRequestRow(request: SpeakerRequest): SpeakerRequestRow {
  return {
    id: request.id,
    sessionId: request.sessionId,
    userId: request.userId,
    state: request.state,
    requestedAt: request.requestedAt,
    grantedAt: request.grantedAt,
    decidedAt: request.decidedAt,
    decidedBy: request.decidedBy,
  };
}

export function toPresenterGrant(row: PresenterGrantRow): PresenterGrant {
  return {
    id: asId<'PresenterGrant'>(row.id),
    sessionId: row.sessionId,
    userId: row.userId,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
    endReason: row.endReason,
  };
}

export function presenterGrantRow(grant: PresenterGrant): PresenterGrantRow {
  return {
    id: grant.id,
    sessionId: grant.sessionId,
    userId: grant.userId,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    endedAt: grant.endedAt,
    endedBy: grant.endedBy,
    endReason: grant.endReason,
  };
}

/** The reason code is optional in the domain: absent, not undefined, when the row has none. */
export function toModerationAction(row: ModerationActionRow): ModerationAction {
  return {
    id: asId<'ModerationAction'>(row.id),
    sessionId: row.sessionId,
    actorUserId: row.actorUserId,
    targetUserId: row.targetUserId,
    type: row.type,
    at: row.at,
    ...(row.reasonCode === null ? {} : { reasonCode: row.reasonCode }),
  };
}

export function moderationActionRow(action: ModerationAction): ModerationActionRow {
  return {
    id: action.id,
    sessionId: action.sessionId,
    actorUserId: action.actorUserId,
    targetUserId: action.targetUserId,
    type: action.type,
    at: action.at,
    reasonCode: action.reasonCode ?? null,
  };
}
