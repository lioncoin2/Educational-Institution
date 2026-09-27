import { failure, type Failure } from '../../../shared';

/** DI token. */
export const LIVE_SETTINGS = Symbol('LIVE_SETTINGS');

/**
 * What a deployment decides about Live, bound once in the module from
 * `AppConfig.live` (plan §2.5). The use cases read these, never the
 * configuration itself, so a test sets them directly.
 */
export interface LiveSettings {
  /**
   * This deployment's media room prefix. Real media refuses to boot without
   * one (the orphan sweep ends every room of its form that no live session
   * claims); the fake and the disabled provider use DEFAULT_ROOM_NAME_PREFIX.
   */
  readonly roomNamePrefix: string;
  /** The listeners' soft cap, copied onto each session at start (PROVISIONAL, Q57). */
  readonly participantCap: number;
  /** Seats above the cap for moderators and current speakers (PROVISIONAL, Q57). */
  readonly moderatorReserve: number;
  /**
   * The join token's lifetime: JOIN_TOKEN_TTL_SECONDS. Checked again where
   * the token is minted (audit D24), because the provider's SDK turns a falsy
   * lifetime into six hours.
   */
  readonly joinTokenTtlSeconds: number;
}

/** The prefix when none is configured — the fake's and the disabled provider's only. */
export const DEFAULT_ROOM_NAME_PREFIX = 'live-';

/** What every Live audit entry is about: the session. */
export const LIVE_AUDIT_RESOURCE = 'live.session';

/**
 * Live's refusals, in the vocabulary every route shares (live.md §15.2). The
 * three not-found answers are each identical for "does not exist" and "you
 * may not see it", so no route tells a non-member whether a session runs.
 */
export const LiveRefusals = {
  sessionNotFound: failure('not_found', 'live.session_not_found', 'No such live session.'),
  requestNotFound: failure('not_found', 'live.request_not_found', 'No such speaker request.'),
  communityNotFound: failure('not_found', 'live.community_not_found', 'No such community.'),
  startNotPermitted: failure(
    'forbidden',
    'live.start_not_permitted',
    'You may not start a live session in this community.',
  ),
  notAModerator: failure(
    'forbidden',
    'live.not_a_moderator',
    'You do not moderate this live session.',
  ),
  targetIsHost: failure(
    'forbidden',
    'live.target_is_host',
    'Only the host acts on the host’s own hand or screen share.',
  ),
  presenterNotPermitted: failure(
    'forbidden',
    'live.presenter_not_permitted',
    'You may not share your screen in this session.',
  ),
  communityNotOpen: failure(
    'precondition_failed',
    'live.community_not_open',
    'This community does not allow that right now.',
  ),
  sessionNotLive: failure(
    'precondition_failed',
    'live.session_not_live',
    'This session is not live.',
  ),
  sessionFull: failure('precondition_failed', 'live.session_full', 'This session is full.'),
  speakerSlotsFull: failure(
    'precondition_failed',
    'live.speaker_slots_full',
    'The maximum number of speakers already hold the floor.',
  ),
  targetNotEligible: failure(
    'precondition_failed',
    'live.target_not_eligible',
    'This person may no longer take part in the session.',
  ),
  invalidTransition: failure(
    'conflict',
    'live.invalid_transition',
    'This hand has already been decided otherwise.',
  ),
  presenterSlotTaken: failure(
    'conflict',
    'live.presenter_slot_taken',
    'Someone else is sharing their screen.',
  ),
  cursorInvalid: failure('validation', 'live.cursor_invalid', 'That page cursor is not valid.'),
  /** Start only: nothing was stored, and retrying is sensible. */
  mediaUnavailable: failure(
    'unavailable',
    'live.media_unavailable',
    'Live media is unavailable right now. Try again shortly.',
  ),
  /**
   * Communities or the account directory could not answer. Fail closed: never
   * a role-only answer, and the client learns that retrying is sensible.
   */
  unavailable: failure(
    'unavailable',
    'unavailable',
    'A service this request needs is briefly unavailable. Try again shortly.',
  ),
} as const satisfies Record<string, Failure>;

/**
 * The shape of every id this API issues — a session's and a speaker
 * request's are UUIDs; this leaves room — and so of every id a path or a
 * cursor may name. Anything else was never issued here: each use case that
 * takes an id from the path answers it as an unknown id, right after
 * identity's ceiling and BEFORE any limiter, store or Communities call. A
 * malformed id is then cheap, and opens no rate-limit window — whose key
 * would hold whatever text a client sent, of any length — while an
 * attempt on a well-formed id still counts, found or not.
 */
const LIVE_ID_SHAPE = /^[A-Za-z0-9:_-]{1,128}$/;

/** Whether `raw` could be an id this API issued (`LIVE_ID_SHAPE`). */
export function isLiveId(raw: string): boolean {
  return LIVE_ID_SHAPE.test(raw);
}

/** 429, with when to try again — as Communities' use cases answer it. */
export function tooMany(code: string, retryAfterSeconds: number): Failure {
  return failure('rate_limited', code, 'Too many requests. Try again later.', {
    retryAfterSeconds,
  });
}

/**
 * A rate-limit key per (session, user) — never an address, which a school
 * behind one NAT shares. User ids hold no NUL, so the pair is unambiguous;
 * the session id is one `isLiveId` accepted, so the key is bounded.
 */
export function sessionUserKey(sessionId: string, userId: string): string {
  return `${sessionId}\u0000${userId}`;
}
