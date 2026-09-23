import type { Id } from '../../../shared';

export type SpeakerRequestId = Id<'SpeakerRequest'>;

/**
 * The raise-hand lifecycle. The state encodes who acted:
 *
 *   pending   — the hand is up.
 *   granted   — a moderator gave the floor: the requester may publish audio.
 *   declined  — a moderator passed over a pending hand.
 *   revoked   — a moderator took the floor back.
 *   withdrawn — the requester lowered their own hand: a pending hand
 *               withdrawn, or a speaker yielding the floor.
 *
 * `declined`, `revoked` and `withdrawn` are terminal; raising again later is a
 * new request. Distinguishing them matters for reporting ("how often were
 * hands passed over?"). Nothing here grants or removes group membership: a
 * speaker grant is session state only.
 */
export type SpeakerRequestState = 'pending' | 'granted' | 'declined' | 'revoked' | 'withdrawn';

export interface SpeakerRequest {
  readonly id: SpeakerRequestId;
  readonly sessionId: string;
  readonly userId: string;
  readonly state: SpeakerRequestState;
  readonly requestedAt: Date;
  /** When the floor was given; null unless the request was ever granted. */
  readonly grantedAt: Date | null;
  /** When the request left `pending` or `granted` for its current state. */
  readonly decidedAt: Date | null;
  /**
   * Who made the last decision: the moderator for granted, declined and
   * revoked; the requester themself for withdrawn. Null exactly while pending.
   */
  readonly decidedBy: string | null;
}

export const TERMINAL_STATES: ReadonlySet<SpeakerRequestState> = new Set([
  'declined',
  'revoked',
  'withdrawn',
]);

/** An open hand: at most one per person per session. */
export function isOpen(request: SpeakerRequest): boolean {
  return request.state === 'pending' || request.state === 'granted';
}

export function isSpeaking(request: SpeakerRequest): boolean {
  return request.state === 'granted';
}

/** Legal state transitions, in one table so nothing invents its own. */
const ALLOWED_TRANSITIONS: Readonly<Record<SpeakerRequestState, readonly SpeakerRequestState[]>> = {
  pending: ['granted', 'declined', 'withdrawn'],
  // A speaker may yield the floor themself (withdrawn), or have it revoked.
  granted: ['revoked', 'withdrawn'],
  declined: [],
  revoked: [],
  withdrawn: [],
};

export function canTransition(from: SpeakerRequestState, to: SpeakerRequestState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transition(
  request: SpeakerRequest,
  to: SpeakerRequestState,
  at: Date,
  decidedBy: string,
): SpeakerRequest | null {
  if (!canTransition(request.state, to)) return null;
  return {
    ...request,
    state: to,
    grantedAt: to === 'granted' ? at : request.grantedAt,
    decidedAt: at,
    decidedBy,
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
 * The order moderators see hands in: first come, first served — oldest
 * first, then by id so equal instants never reorder. Any other order (by
 * participation, by level) is an institutional policy we have not been
 * given (open-questions.md Q4).
 */
export function queueOrder(a: SpeakerRequest, b: SpeakerRequest): number {
  const byTime = a.requestedAt.getTime() - b.requestedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How many participants may hold the floor at once.
 *
 * A technical safety limit, not a pedagogical one: concurrent speakers are the
 * only thing that scales cost in the room, so it is bounded by default. The
 * exact number is an institutional choice — see open-questions.md (Q4). The
 * host publishes by virtue of hosting and is not counted.
 */
export const MAX_CONCURRENT_SPEAKERS = 4;
