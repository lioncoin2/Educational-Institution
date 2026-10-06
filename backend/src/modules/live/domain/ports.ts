import type { LiveSession, LiveSessionEndReason, LiveSessionKey } from './live-session';
import type { ModerationAction } from './moderation';
import type { PresenterGrant, PresenterStopReason } from './presenter-grant';
import type { QueueKey, SpeakerRequest, SpeakerRequestState } from './speaker-request';

export const LIVE_SESSION_REPOSITORY = Symbol('LIVE_SESSION_REPOSITORY');
export const SPEAKER_REQUEST_REPOSITORY = Symbol('SPEAKER_REQUEST_REPOSITORY');
export const PRESENTER_GRANT_REPOSITORY = Symbol('PRESENTER_GRANT_REPOSITORY');

/*
 * Live's persistence, as three ports over one aggregate (live.md §10; plan
 * §2.4). The rules every adapter keeps:
 *
 *   - No method returns every request of a session: in a session of
 *     thousands that is exactly the query that must not exist. Reads are by
 *     id, by (session, person), the few granted hands (at most
 *     MAX_CONCURRENT_SPEAKERS), a bounded keyset page, or a capped count.
 *   - Every change takes the session's lock first — in Postgres its row
 *     FOR UPDATE, after the per-session KeyedMutex; in memory, a synchronous
 *     section with no await between check and write — and requires the
 *     session to be `live`: after End commits, nothing about its hands, floor
 *     or presenter changes (S4). `markEmpty` and `noteViolation` are single
 *     updates that are themselves conditional on `live`.
 *   - Every change a moderator can observe — a session started or ended, a
 *     hand raised or decided, a floor or presenter grant opened or closed —
 *     raises the session's `stateVersion` by exactly 1 in the same step, and
 *     the method returns it (§4.5, whose list this is). A no-op changes
 *     nothing, the version included. The reconciler's bookkeeping
 *     (`markEmpty`, `noteViolation`, `bumpEpoch`) is not on that list: it
 *     publishes no event, so it carries no version, and a moderator's view
 *     shows the violation count as of its next read.
 *   - A moderation act's record is written by the call that makes the change,
 *     and only when it does.
 *   - No provider call ever happens inside a repository.
 *
 * Where a method names an order of checks, every adapter answers in that
 * order, so the in-memory store and Postgres give the same outcome for the
 * same sequence of calls, races included (test/support/live-contract-suite.ts).
 */

export interface StartOutcome {
  readonly created: boolean;
  readonly session: LiveSession;
}

export interface EndInput {
  readonly sessionId: string;
  readonly at: Date;
  /** Null when the system ends it; a `moderator` end always names the moderator (S2). */
  readonly endedBy: string | null;
  readonly reason: LiveSessionEndReason;
  readonly moderation: ModerationAction;
}

export interface EndOutcome {
  /** False when the session had already ended: nothing was written. */
  readonly ended: boolean;
  readonly session: LiveSession;
}

export interface LiveSessionRepository {
  findById(id: string): Promise<LiveSession | null>;
  /** The community's live session, if one runs — there is at most one (S1, Q55). */
  findLiveByCommunity(communityId: string): Promise<LiveSession | null>;
  /**
   * Stores `session` (a `newLiveSession`) as the community's live session,
   * with its `start_session` row — unless one already runs: then nothing is
   * written and that one is returned, `created: false`. Postgres:
   * `INSERT … ON CONFLICT (community_id) WHERE state = 'live' DO NOTHING
   * RETURNING`, so of any number of racing starts exactly one creates.
   */
  start(session: LiveSession, moderation: ModerationAction): Promise<StartOutcome>;
  /**
   * End (§4.2), in one step under the session's lock: a live session becomes
   * ended, one state version later; every open request expires
   * (`decidedBy` null, `decidedAt` = `at`) and the open presenter grant closes
   * (`session_ended`, `endedBy` = the end's `endedBy`), each one statement
   * however many there are; and the `end_session` row is written. An ended
   * session is answered as it is, `ended: false`, with nothing written. Null
   * for an unknown id.
   */
  end(input: EndInput): Promise<EndOutcome | null>;
  /**
   * The live sessions after `after`, in (startedAt, id) order — the
   * reconciler's pages. `limit` is 1..LIVE_SESSIONS_PAGE_MAX (RangeError
   * otherwise).
   */
  listLive(after: LiveSessionKey | null, limit: number): Promise<readonly LiveSession[]>;
  /**
   * Since when a live session's room has been observed empty. A date is kept
   * if one is already set — the room has been empty since the FIRST
   * observation, so a sweep repeating it never restarts the idle clock — and
   * null clears it. A session that is not live is left alone.
   */
  markEmpty(id: string, emptySince: Date | null): Promise<void>;
  /**
   * Counts one enforcement violation on a live session, at `at`, and returns
   * the new count; 0 when the session is unknown or not live, and nothing is
   * noted.
   */
  noteViolation(id: string, at: Date): Promise<number>;
  /**
   * The media reset's compare-and-set (§11.4): moves a live session from
   * epoch `expected` to `expected + 1`, with the `reset_media` row, and
   * returns it; null — and nothing written — when the session is unknown, not
   * live, or no longer on `expected`.
   */
  bumpEpoch(
    id: string,
    expected: number,
    moderation: ModerationAction,
  ): Promise<LiveSession | null>;
}

export type RaiseOutcome =
  | {
      /** False when the person already had an open request: it is returned, and nothing was written. */
      readonly created: boolean;
      readonly request: SpeakerRequest;
      readonly stateVersion: number;
    }
  | 'session_not_live';

export interface GrantOutcome {
  readonly kind: 'granted' | 'unchanged' | 'slots_full' | 'invalid' | 'session_not_live';
  /** The request as it is after the call. */
  readonly request: SpeakerRequest;
  /** The session's version after the call. */
  readonly stateVersion: number;
}

export interface TransitionInput {
  readonly requestId: string;
  /** The states the request may be moved from — the compare in compare-and-set. */
  readonly from: readonly SpeakerRequestState[];
  /** Never `pending` (where requests start) or `granted` (`grantWithinCap`'s, which counts the cap): RangeError. */
  readonly to: SpeakerRequestState;
  readonly at: Date;
  /** Who acts: null exactly for `expired` (RangeError otherwise, R3). */
  readonly by: string | null;
  /** The moderation row for a moderator's act; null for the requester's own. */
  readonly moderation: ModerationAction | null;
}

export interface TransitionOutcome {
  readonly kind: 'applied' | 'unchanged' | 'invalid' | 'session_not_live';
  readonly request: SpeakerRequest;
  readonly stateVersion: number;
}

export interface IneligibleExpiry {
  /** The person's request, expired; null when they had none open. */
  readonly request: SpeakerRequest | null;
  /** Their presenter grant, closed as `ineligible`; null when they held none. */
  readonly presenter: PresenterGrant | null;
  /** The session's version after the call; 0 for an unknown session. */
  readonly stateVersion: number;
}

/**
 * The raise-hand queue. Every read is targeted, and every write is a
 * compare-and-set under the session's lock, so concurrent raises, grants past
 * the cap and a revoke racing a yield resolve to one outcome each.
 */
export interface SpeakerRequestRepository {
  /**
   * Stores `request` (a `newSpeakerRequest`), one version later — unless the
   * person already has an open request in the session: then that one is
   * returned, `created: false`, and nothing is written (R1; Postgres:
   * `INSERT … ON CONFLICT (session_id, user_id) WHERE state IN
   * ('pending', 'granted') DO NOTHING`). `session_not_live` for a session that
   * is unknown or not live.
   */
  raise(request: SpeakerRequest): Promise<RaiseOutcome>;
  findById(id: string): Promise<SpeakerRequest | null>;
  /** The person's open (pending or granted) request in the session, if any. */
  findOpen(sessionId: string, userId: string): Promise<SpeakerRequest | null>;
  /** The session's granted requests — never more than the speaker cap — in queue order. */
  granted(sessionId: string): Promise<readonly SpeakerRequest[]>;
  /**
   * Pending requests after `after`, first come first served ((requestedAt,
   * id) order, R4). `limit` is 1..HANDS_PAGE_MAX (RangeError otherwise).
   */
  pendingPage(
    sessionId: string,
    after: QueueKey | null,
    limit: number,
  ): Promise<readonly SpeakerRequest[]>;
  /**
   * How many requests are pending, counting no further than `cap`
   * (1..PENDING_HANDS_COUNT_CAP; RangeError otherwise): the read never scans
   * more than `cap` rows, and `cap` means "`cap` or more" (audit D8).
   */
  countPending(sessionId: string, cap: number): Promise<number>;
  /**
   * pending → granted, counted against `cap` under the session's lock, with
   * the `grant_speaker` row. In order: null for an unknown request; already
   * granted → `unchanged`; the session not live → `session_not_live`; not
   * pending → `invalid`; `cap` requests already granted → `slots_full`;
   * otherwise `granted`, one version later.
   */
  grantWithinCap(input: {
    readonly requestId: string;
    readonly cap: number;
    readonly at: Date;
    readonly by: string;
    readonly moderation: ModerationAction;
  }): Promise<GrantOutcome | null>;
  /**
   * Compare-and-set: moves the request to `to` only if it is still in one of
   * `from`, and the table allows it. In order: null for an unknown request;
   * already in `to` → `unchanged`, even after the end (a repeat answers 200,
   * audit D6); the session not live → `session_not_live`; not in `from`, or
   * not a legal move → `invalid`; otherwise `applied`, one version later, with
   * the moderation row if one is given.
   */
  transition(input: TransitionInput): Promise<TransitionOutcome | null>;
  /**
   * The ineligible expiry (§11.3): under the session's lock, the person's open
   * request expires and their presenter grant closes (`ineligible`, by nobody),
   * together, one version later if anything changed. Nothing is written for a
   * session that is not live — End has already closed everything there.
   */
  expireIneligible(sessionId: string, userId: string, at: Date): Promise<IneligibleExpiry>;
  /**
   * Who lost the floor at or after `since` — a request that was granted and
   * is now revoked, withdrawn or expired — each person once, in id order: the
   * reconciler's targeted watch.
   */
  floorClosedSince(sessionId: string, since: Date): Promise<readonly string[]>;
}

export interface PresenterOpenOutcome {
  /**
   * `opened` — a slot was free and is now `userId`'s, one version later, with
   * the `grant_presenter` row; `held` — `userId` already holds an open grant;
   * `slots_full` — `cap` grants are already open; `session_not_live` — the
   * session is unknown or not live.
   */
  readonly kind: 'opened' | 'held' | 'slots_full' | 'session_not_live';
  /** `userId`'s open grant after the call — the one opened, or the one already `held`; null otherwise. */
  readonly grant: PresenterGrant | null;
  readonly stateVersion: number;
}

export interface PresenterCloseInput {
  readonly sessionId: string;
  /**
   * The holder whose grant is closed — the one the caller decided about. If
   * the slot has meanwhile passed to someone else, nothing is closed: a stop
   * or a revocation never lands on a grant its caller did not see (a revoke
   * aimed at one moderator's grant must not close the host's).
   */
  readonly userId: string;
  /** The presenter for `stopped`, the moderator for `revoked`, null (the system) for `ineligible`. */
  readonly by: string | null;
  readonly reason: PresenterStopReason;
  readonly at: Date;
  /** The `revoke_presenter` row for a revocation; null otherwise. */
  readonly moderation: ModerationAction | null;
}

export interface PresenterCloseOutcome {
  /** The grant just closed; null when `userId` held nothing open (nothing was written). */
  readonly grant: PresenterGrant | null;
  /** The session's version after the call; 0 for an unknown session. */
  readonly stateVersion: number;
}

/** Screen-share grants: at most `MAX_CONCURRENT_PRESENTERS` open per session (Q56, ADR 0028). */
export interface PresenterGrantRepository {
  /** The session's open grants — each person at most once — in a determinate (grantedAt, id) order. */
  activeGrants(sessionId: string): Promise<readonly PresenterGrant[]>;
  /**
   * Opens `grant` under the session's lock, counted against `cap` in the
   * grant's own transaction — the speaker floor's pattern (R2): a racing open
   * waits on the lock, then counts this one. The open grants are read first,
   * so a repeat by the holder (`held`) and a full house (`slots_full`) are
   * told apart. A person holds at most one open grant; in Postgres a per-user
   * partial unique index is the backstop the lock makes unreachable.
   */
  openWithinCap(
    grant: PresenterGrant,
    cap: number,
    moderation: ModerationAction,
  ): Promise<PresenterOpenOutcome>;
  /**
   * Closes `userId`'s open grant, one version later, with the moderation row
   * if one is given. Nothing is written when they hold none, or when the
   * session is not live — End has already closed it there.
   */
  close(input: PresenterCloseInput): Promise<PresenterCloseOutcome>;
  /** Whose presenter grant closed at or after `since`, each person once, in id order — the watch. */
  closedSince(sessionId: string, since: Date): Promise<readonly string[]>;
}
