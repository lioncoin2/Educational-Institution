import type { Id } from '../../../shared';

export type LiveSessionId = Id<'LiveSession'>;

/** `ended` is terminal (S3): every change to a session requires it to be `live`. */
export const LIVE_SESSION_STATES = ['live', 'ended'] as const;
export type LiveSessionState = (typeof LIVE_SESSION_STATES)[number];

/**
 * Why a session ended: a moderator ended it, the system ended it after its
 * room was observed empty (Q61), or the system ended it because the community
 * no longer lets a running session continue (reserved for a future status
 * such as ARCHIVED, Q47).
 */
export const LIVE_SESSION_END_REASONS = ['moderator', 'idle', 'community_closed'] as const;
export type LiveSessionEndReason = (typeof LIVE_SESSION_END_REASONS)[number];

/**
 * One live session of one community — the aggregate root, whose row is the
 * lock for everything beneath it: the speaker requests, the presenter grant
 * and the moderation record (live.md §3.1).
 *
 * It replaces P1's `LiveRoom`: there is no second durable "place" beside the
 * Community, no halaqa, and no single host who alone may moderate. The
 * community id is Communities' opaque id, always read from this record and
 * never from a client; the media room is derived from the session, never the
 * reverse.
 */
export interface LiveSession {
  readonly id: LiveSessionId;
  readonly communityId: string;
  /** The starter. Moderates this session while Communities answers `community.live.host` (Q54). */
  readonly hostUserId: string;
  readonly state: LiveSessionState;
  /** ≥ 1; +1 in the same step as every change a moderator can observe (§4.5). */
  readonly stateVersion: number;
  readonly startedAt: Date;
  /** Null exactly while live (S2). */
  readonly endedAt: Date | null;
  /** Who ended it; null while live, and null when the system ended it. */
  readonly endedBy: string | null;
  /** Null exactly while live; `moderator` always names who (S2). */
  readonly endReason: LiveSessionEndReason | null;
  /** The listeners' soft cap, copied from configuration at start: never the community's size. */
  readonly participantCap: number;
  /** Seats above the cap for moderators and speakers. */
  readonly moderatorReserve: number;
  /** 0 until the first media reset; only ever increases (§11.4). */
  readonly mediaRoomEpoch: number;
  /** Reconciler bookkeeping: since when its room has been observed empty. */
  readonly emptySince: Date | null;
  /** Reconciler bookkeeping, shown to moderators: violations counted, and the last one. */
  readonly enforcementViolations: number;
  readonly lastViolationAt: Date | null;
}

/**
 * A session as Start stores it: live, at state version 1, on media room
 * epoch 0, with its bounds copied from configuration so a later change of
 * configuration affects later sessions only.
 */
export function newLiveSession(input: {
  readonly id: LiveSessionId;
  readonly communityId: string;
  readonly hostUserId: string;
  readonly at: Date;
  readonly participantCap: number;
  readonly moderatorReserve: number;
}): LiveSession {
  if (!Number.isSafeInteger(input.participantCap) || input.participantCap < 1) {
    throw new RangeError('a live session admits at least one participant');
  }
  if (!Number.isSafeInteger(input.moderatorReserve) || input.moderatorReserve < 0) {
    throw new RangeError('a live session’s moderator reserve is a whole number, 0 or more');
  }
  return {
    id: input.id,
    communityId: input.communityId,
    hostUserId: input.hostUserId,
    state: 'live',
    stateVersion: 1,
    startedAt: input.at,
    endedAt: null,
    endedBy: null,
    endReason: null,
    participantCap: input.participantCap,
    moderatorReserve: input.moderatorReserve,
    mediaRoomEpoch: 0,
    emptySince: null,
    enforcementViolations: 0,
    lastViolationAt: null,
  };
}

export function isLive(session: LiveSession): boolean {
  return session.state === 'live';
}

/**
 * The session as End leaves it: ended, one state version later. Only a live
 * session ends — a repeated end is answered by the caller with the session
 * as it is — and a moderator's end always names the moderator (S2).
 */
export function endSession(
  session: LiveSession,
  input: {
    readonly at: Date;
    readonly endedBy: string | null;
    readonly reason: LiveSessionEndReason;
  },
): LiveSession {
  if (!isLive(session)) throw new RangeError('only a live session ends');
  if (input.reason === 'moderator' && input.endedBy === null) {
    throw new RangeError('a moderator’s end names the moderator');
  }
  return {
    ...session,
    state: 'ended',
    stateVersion: session.stateVersion + 1,
    endedAt: input.at,
    endedBy: input.endedBy,
    endReason: input.reason,
  };
}

/** Whole seconds from start to end, for `live.session.ended`. Null while live. */
export function durationSeconds(session: LiveSession): number | null {
  if (session.endedAt === null) return null;
  return Math.max(0, Math.floor((session.endedAt.getTime() - session.startedAt.getTime()) / 1000));
}

/** A position in the live sessions' keyset, the reconciler's page order. */
export interface LiveSessionKey {
  readonly startedAt: Date;
  readonly id: string;
}

/** (startedAt, id) ascending — ids break ties, so equal instants never reorder. */
export function liveSessionOrder(a: LiveSessionKey, b: LiveSessionKey): number {
  const byTime = a.startedAt.getTime() - b.startedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The provider's name for a session's media room: the deployment's prefix and
 * the session id, plus `.epoch` once a media reset has moved the session to a
 * new room (§11.4). Derived, never stored as an identity (S6).
 *
 * The prefix confines the orphan sweep to this deployment on a media server
 * other environments may share, so it is never empty (configuration refuses
 * one), and the epoch is a whole number, 0 or more.
 */
export function mediaRoomName(prefix: string, sessionId: string, epoch: number): string {
  requirePrefix(prefix);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new RangeError('a media room epoch is a whole number, 0 or more');
  }
  return epoch === 0 ? `${prefix}${sessionId}` : `${prefix}${sessionId}.${epoch}`;
}

/** The media room a session uses now. */
export function currentMediaRoom(prefix: string, session: LiveSession): string {
  return mediaRoomName(prefix, session.id, session.mediaRoomEpoch);
}

/** A lower-case uuid, as the id generator writes one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_LENGTH = 36;
/** `.` and a positive whole number with no leading zero: epoch 0 has no suffix at all. */
const EPOCH_SUFFIX = /^\.([1-9][0-9]*)$/;

/**
 * The session and epoch a room name encodes, if it is exactly one of this
 * deployment's: the prefix, a uuid, and optionally `.` and a positive epoch —
 * nothing before, between or after. So a room of a deployment whose prefix
 * merely starts with this one (`live-` against `live-prod-`) is never taken
 * for ours, and the orphan sweep never deletes it. The prefix is compared as
 * text, never compiled into a pattern.
 */
export function parseMediaRoomName(
  prefix: string,
  name: string,
): { readonly sessionId: string; readonly epoch: number } | null {
  requirePrefix(prefix);
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const sessionId = rest.slice(0, UUID_LENGTH);
  if (!UUID.test(sessionId)) return null;
  const suffix = rest.slice(UUID_LENGTH);
  if (suffix === '') return { sessionId, epoch: 0 };
  const epoch = Number(EPOCH_SUFFIX.exec(suffix)?.[1]);
  return Number.isSafeInteger(epoch) ? { sessionId, epoch } : null;
}

/** Whether a room is one of this deployment's media rooms — the orphan sweep's test. */
export function isMediaRoomName(prefix: string, name: string): boolean {
  return parseMediaRoomName(prefix, name) !== null;
}

function requirePrefix(prefix: string): void {
  if (prefix === '') throw new RangeError('a media room prefix is never empty');
}
