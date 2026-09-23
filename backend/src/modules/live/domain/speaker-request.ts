import type { Id } from '../../../shared';

export type SpeakerRequestId = Id<'SpeakerRequest'>;

/**
 * The raise-hand lifecycle.
 *
 * `withdrawn` is the student taking their own hand down; `declined` is the host
 * passing them over. Both are terminal, and distinguishing them matters for
 * reporting ("how often were hands ignored?").
 */
export type SpeakerRequestState = 'pending' | 'granted' | 'revoked' | 'withdrawn' | 'declined';

export interface SpeakerRequest {
  readonly id: SpeakerRequestId;
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly state: SpeakerRequestState;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
  /** The host who granted, revoked or declined. */
  readonly decidedBy: string | null;
}

export const TERMINAL_STATES: ReadonlySet<SpeakerRequestState> = new Set([
  'revoked',
  'withdrawn',
  'declined',
]);

export function isPending(request: SpeakerRequest): boolean {
  return request.state === 'pending';
}

export function isSpeaking(request: SpeakerRequest): boolean {
  return request.state === 'granted';
}

/**
 * The queue the host sees: pending hands, oldest first.
 *
 * Fairness is first-come-first-served and intentionally not configurable yet —
 * any other ordering (by participation, by level) is an institutional policy we
 * have not been given. See open-questions.md (Q4).
 */
export function pendingQueue(requests: readonly SpeakerRequest[]): readonly SpeakerRequest[] {
  return requests
    .filter(isPending)
    .slice()
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
}

/** A user may hold only one open hand per session. */
export function hasOpenRequest(requests: readonly SpeakerRequest[], userId: string): boolean {
  return requests.some(
    (request) => request.userId === userId && (isPending(request) || isSpeaking(request)),
  );
}

export function currentSpeakers(requests: readonly SpeakerRequest[]): readonly SpeakerRequest[] {
  return requests.filter(isSpeaking);
}

/** Legal state transitions, in one table so nothing invents its own. */
const ALLOWED_TRANSITIONS: Readonly<Record<SpeakerRequestState, readonly SpeakerRequestState[]>> = {
  pending: ['granted', 'declined', 'withdrawn'],
  granted: ['revoked'],
  revoked: [],
  withdrawn: [],
  declined: [],
};

export function canTransition(from: SpeakerRequestState, to: SpeakerRequestState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transition(
  request: SpeakerRequest,
  to: SpeakerRequestState,
  at: Date,
  decidedBy: string | null,
): SpeakerRequest | null {
  if (!canTransition(request.state, to)) return null;
  return { ...request, state: to, decidedAt: at, decidedBy };
}

/**
 * How many participants may hold the floor at once.
 *
 * A technical safety limit, not a pedagogical one: concurrent speakers are the
 * only thing that scales cost in the room, so it is bounded by default. The
 * exact number is an institutional choice — see open-questions.md (Q4).
 */
export const MAX_CONCURRENT_SPEAKERS = 4;

export function speakerSlotsAvailable(requests: readonly SpeakerRequest[]): boolean {
  return currentSpeakers(requests).length < MAX_CONCURRENT_SPEAKERS;
}
