import type { Id } from '../../../shared';

export { MAX_CONCURRENT_SPEAKERS } from './live-limits';

export type SpeakerRequestId = Id<'SpeakerRequest'>;

/**
 * The raise-hand lifecycle (live.md §5). The state encodes who acted:
 *
 *   pending   — the hand is up.
 *   granted   — a moderator gave the floor: the requester may publish audio.
 *   declined  — a moderator passed over a pending hand.
 *   revoked   — a moderator took the floor back.
 *   withdrawn — the requester lowered their own hand: a pending hand
 *               withdrawn, or a speaker yielding the floor.
 *   expired   — the system closed an open hand: the session ended, or the
 *               requester may no longer take part.
 *
 * `pending` and `granted` are open; the rest are terminal, and raising again
 * later is a new request. Distinguishing them matters for reporting ("how
 * often were hands passed over?"). Nothing here grants or removes community
 * membership: a speaker grant is session state only, and confers no
 * community act (R5).
 */
export const SPEAKER_REQUEST_STATES = [
  'pending',
  'granted',
  'declined',
  'revoked',
  'withdrawn',
  'expired',
] as const;
export type SpeakerRequestState = (typeof SPEAKER_REQUEST_STATES)[number];

/** The two open states. At most one open request per person per session (R1). */
export const OPEN_STATES: ReadonlySet<SpeakerRequestState> = new Set(['pending', 'granted']);

export const TERMINAL_STATES: ReadonlySet<SpeakerRequestState> = new Set([
  'declined',
  'revoked',
  'withdrawn',
  'expired',
]);

export interface SpeakerRequest {
  readonly id: SpeakerRequestId;
  readonly sessionId: string;
  readonly userId: string;
  readonly state: SpeakerRequestState;
  readonly requestedAt: Date;
  /** When the floor was given; null unless the request was ever granted (at most once). */
  readonly grantedAt: Date | null;
  /** When the request left `pending` or `granted` for its current state; null exactly while pending. */
  readonly decidedAt: Date | null;
  /**
   * Who decided: the moderator for granted, declined and revoked; the
   * requester themself for withdrawn. Null exactly while pending and once
   * expired, because the system expires (R3).
   */
  readonly decidedBy: string | null;
}

/** A hand as Raise stores it: pending, decided by nobody yet. */
export function newSpeakerRequest(input: {
  readonly id: SpeakerRequestId;
  readonly sessionId: string;
  readonly userId: string;
  readonly at: Date;
}): SpeakerRequest {
  return {
    id: input.id,
    sessionId: input.sessionId,
    userId: input.userId,
    state: 'pending',
    requestedAt: input.at,
    grantedAt: null,
    decidedAt: null,
    decidedBy: null,
  };
}

/** An open hand: pending or granted. */
export function isOpen(request: SpeakerRequest): boolean {
  return OPEN_STATES.has(request.state);
}

export function isSpeaking(request: SpeakerRequest): boolean {
  return request.state === 'granted';
}

/**
 * Legal moves, in one table so nothing invents its own (live.md §5.1). A
 * speaker may yield the floor themself (withdrawn) or have it taken back
 * (revoked); the system expires either open state, when the session ends or
 * when the requester may no longer take part. Terminal states go nowhere.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<SpeakerRequestState, readonly SpeakerRequestState[]>
> = Object.freeze({
  pending: ['granted', 'declined', 'withdrawn', 'expired'],
  granted: ['revoked', 'withdrawn', 'expired'],
  declined: [],
  revoked: [],
  withdrawn: [],
  expired: [],
});

export function canTransition(from: SpeakerRequestState, to: SpeakerRequestState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The request after a legal move, or null for a move outside the table (the
 * request is left as it was). `by` is the person who acted, and null exactly
 * for an expiry: an actor on an expiry, or none on anything else, is a
 * programming error and throws, as the database's CHECK would (R3).
 */
export function transition(
  request: SpeakerRequest,
  to: SpeakerRequestState,
  at: Date,
  by: string | null,
): SpeakerRequest | null {
  if (!canTransition(request.state, to)) return null;
  if ((to === 'expired') !== (by === null)) {
    throw new RangeError(
      'a request is decided by a person, except an expiry, which nobody decides',
    );
  }
  return {
    ...request,
    state: to,
    grantedAt: to === 'granted' ? at : request.grantedAt,
    decidedAt: at,
    decidedBy: by,
  };
}

/**
 * What asking for `to` means for a request in its current state — the one
 * place repeats are defined. A request already in the target state is
 * unchanged (the caller answers 200 and does nothing); a move outside the
 * table is invalid (409); anything else applies.
 */
export type TransitionVerdict = 'apply' | 'unchanged' | 'invalid';

export function judgeTransition(
  current: SpeakerRequestState,
  to: SpeakerRequestState,
): TransitionVerdict {
  if (current === to) return 'unchanged';
  return canTransition(current, to) ? 'apply' : 'invalid';
}

/**
 * The open state a request was last in: `granted` if it ever held the floor,
 * else `pending`. A request is granted at most once, so its `grantedAt` tells
 * which open state a withdrawal or an expiry closed — the `from` of
 * `live.speaker.withdrawn` and `live.speaker.expired`.
 */
export function lastOpenState(request: SpeakerRequest): 'pending' | 'granted' {
  return request.grantedAt === null ? 'pending' : 'granted';
}

/** A position in the queue: what the hands page's keyset pages by. */
export interface QueueKey {
  readonly requestedAt: Date;
  readonly id: string;
}

/**
 * The order moderators see hands in: first come, first served — oldest
 * first, then by id so equal instants never reorder (R4). Any other order (by
 * participation, by level) is an institutional policy we have not been given
 * (Q4, Q62).
 */
export function queueOrder(a: QueueKey, b: QueueKey): number {
  const byTime = a.requestedAt.getTime() - b.requestedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
