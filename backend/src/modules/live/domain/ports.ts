import type { LiveRoom, LiveRoomId, LiveSession, LiveSessionId } from './live-room';
import type { ModerationAction } from './moderation';
import type { SpeakerRequest, SpeakerRequestState } from './speaker-request';

export interface LiveRoomRepository {
  findById(id: LiveRoomId): Promise<LiveRoom | null>;
  save(room: LiveRoom): Promise<void>;
}

export interface LiveSessionRepository {
  findById(id: LiveSessionId): Promise<LiveSession | null>;
  save(session: LiveSession): Promise<void>;
}

export type RaiseOutcome = { readonly created: boolean; readonly request: SpeakerRequest };

export type GrantOutcome =
  | { readonly kind: 'granted'; readonly request: SpeakerRequest }
  | { readonly kind: 'unchanged'; readonly request: SpeakerRequest }
  | { readonly kind: 'invalid'; readonly request: SpeakerRequest }
  | { readonly kind: 'slots_full'; readonly request: SpeakerRequest };

export type TransitionOutcome =
  | { readonly kind: 'applied'; readonly request: SpeakerRequest }
  | { readonly kind: 'unchanged'; readonly request: SpeakerRequest }
  | { readonly kind: 'invalid'; readonly request: SpeakerRequest };

/**
 * The raise-hand queue.
 *
 * Every read is targeted — by id, by (session, person), or the few granted
 * hands of a session (at most `MAX_CONCURRENT_SPEAKERS`). No method returns
 * all of a session's requests: in a session of thousands that is exactly the
 * query that must not exist.
 *
 * Every write is atomic: a check and its change happen together (in Postgres,
 * under the session row lock; in memory, without an await between them), so
 * concurrent raises, grants past the cap and a revoke racing a yield resolve
 * to one outcome each. A moderation act's record is written by the same call
 * that changes the request.
 */
export interface SpeakerRequestRepository {
  /** The caller's open hand in the session, or `request` stored as new. */
  raise(request: SpeakerRequest): Promise<RaiseOutcome>;
  findById(id: string): Promise<SpeakerRequest | null>;
  /** The person's open (pending or granted) hand in the session, if any. */
  findOpen(sessionId: string, userId: string): Promise<SpeakerRequest | null>;
  /** The session's granted hands — never more than the speaker cap. */
  granted(sessionId: string): Promise<readonly SpeakerRequest[]>;
  /** pending → granted, counted against `cap` in the same step. */
  grantWithinCap(input: {
    readonly requestId: string;
    readonly cap: number;
    readonly at: Date;
    readonly by: string;
    readonly moderation: ModerationAction;
  }): Promise<GrantOutcome | null>;
  /**
   * Compare-and-set: moves the request to `to` only if it is still in one of
   * `from`. A request already in `to` is `unchanged`.
   */
  transition(input: {
    readonly requestId: string;
    readonly from: readonly SpeakerRequestState[];
    readonly to: SpeakerRequestState;
    readonly at: Date;
    readonly by: string;
    readonly moderation: ModerationAction | null;
  }): Promise<TransitionOutcome | null>;
}

export const LIVE_ROOM_REPOSITORY = Symbol('LIVE_ROOM_REPOSITORY');
export const LIVE_SESSION_REPOSITORY = Symbol('LIVE_SESSION_REPOSITORY');
export const SPEAKER_REQUEST_REPOSITORY = Symbol('SPEAKER_REQUEST_REPOSITORY');
