import type { RateLimitPolicy } from '../../../shared';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  LIVE BOUNDS — ENGINEERING, PROVISIONAL; NOT POLICY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every number Live runs on, in one file (docs/architecture/live.md §3.8;
 * the P6 audit §8.5). Each is the design's recorded default and names the
 * open question that owns it: an answer to that question, or a load profile
 * measured in P8, changes one line here and nothing else. None is a limit on
 * a community's size. Two bounds differ per deployment and live in
 * `AppConfig.live` instead: the participant cap and the moderator reserve.
 */

/**
 * How many people may hold the floor at once (Q4). A technical safety limit,
 * not a pedagogical one: concurrent speakers are what scales a room's cost.
 * Moderators publishing by right and the presenter use no slot (Q54): only
 * granted requests count, under the session's lock.
 */
export const MAX_CONCURRENT_SPEAKERS = 4;

/**
 * One screen at a time (Q56). A screen share costs about one subscriber's
 * worth of egress per listener, so the slot is bounded and audited rather
 * than a flag in every moderator's token.
 */
export const MAX_CONCURRENT_PRESENTERS = 1;

/**
 * The longest join token the call site will ask for (audit D24).
 *
 * How long a join token is good for — to START a connection — is each
 * deployment's to set (LIVE_JOIN_TOKEN_TTL_SECONDS, 120 by default; Q63, P7.2
 * decision Q-C), refused at boot outside 1 to this bound. Short on purpose: a
 * token that leaks is good for one fresh connection within its lifetime. It
 * does not bound how long anyone stays: once connected, the media server
 * itself sends the client a fresh token at once, every five minutes after and
 * on every change of its permissions, each valid ten minutes and carrying the
 * participant's current permissions (verified in LiveKit's source, live.md
 * §9). Token expiry never disconnects anyone; `/join` is the way back in and
 * decides afresh every time.
 *
 * The provider's SDK turns a falsy lifetime into six hours, so the configured
 * lifetime is checked again where the token is minted, and anything but a
 * whole number of seconds from 1 to this bound is refused there.
 */
export const MAX_JOIN_TOKEN_TTL_SECONDS = 600;

/** The call-site check of audit D24: a whole number of seconds, 1 to 600. */
export function isJoinTokenTtl(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_JOIN_TOKEN_TTL_SECONDS;
}

/**
 * The reconciler's periods (Q63): the room sweep (missing, empty and orphan
 * rooms), the participant sweep of each live session (eligibility and
 * capabilities, the backstop for every lost event), and the targeted watch.
 */
export const ROOM_SWEEP_SECONDS = 30;
export const PARTICIPANT_SWEEP_SECONDS = 60;
export const WATCH_TICK_SECONDS = 10;

/**
 * How long someone whose floor or presenter grant closed — or whose
 * correction or removal applied — is watched (Q63; audit D10; P7.2 decision
 * Q-D), extended on every violation. A token the media server refreshed
 * lives ten minutes and the server honours it a minute past its expiry; the
 * watch outlives both by one participant sweep, so a client that comes back
 * holding the permissions it had before — under its own identity or any
 * other its token can make — is found inside it: 600 + 60 + 60.
 */
export const ENFORCEMENT_WATCH_SECONDS = 720;

/**
 * How old a room no live session claims must be before the sweep deletes it
 * (engineering). Start ensures its room before it stores the session, so the
 * grace keeps the sweep off the room of a start still in flight.
 */
export const ORPHAN_GRACE_SECONDS = 60;

/**
 * A room observed empty this long ends its session as `idle` (Q61). Never
 * because the host is absent, and there is no maximum duration.
 */
export const IDLE_END_SECONDS = 900;

/**
 * The provider's own empty and departure timeouts (Q61): a backstop only,
 * longer than the idle end, so Live ends a session before the provider
 * reaps its room.
 */
export const ROOM_PROVIDER_TIMEOUT_SECONDS = 1_200;

/**
 * How long a join may reuse its room-occupancy sample for the soft cap (Q57).
 * Listener tokens issued since the sample count against it too.
 */
export const OBSERVATION_CACHE_SECONDS = 2;

/**
 * The most pending hands a session view counts (audit D8, after the unread
 * count's precedent, Q27): the count reads at most this many rows, and this
 * value means "this many or more".
 */
export const PENDING_HANDS_COUNT_CAP = 100;

/** The moderators' hands page: its largest size, and the size when none is asked. */
export const HANDS_PAGE_MAX = 100;
export const HANDS_PAGE_DEFAULT = 50;

/** The reconciler reads the live sessions this many at a time (live.md §11.2; engineering). */
export const LIVE_SESSIONS_PAGE_MAX = 100;

/**
 * Per-process request limits (Q26), keyed by user or by (session, user) —
 * never by address, because a whole school behind one NAT shares one.
 * Correctness never depends on them.
 */
export const LiveRateLimits = {
  /** Starting a session, per user. */
  startsPerUser: { name: 'live.start.user', limit: 10, windowSeconds: 60 },
  /** Joining (a fresh token), per (session, user). */
  joinsPerSessionUser: { name: 'live.join.session_user', limit: 10, windowSeconds: 60 },
  /** Raising a hand, per (session, user). */
  handsPerSessionUser: { name: 'live.hand.session_user', limit: 6, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * How often, at most, the realtime relay tells a session's moderators that it
 * changed — defined in Live's contracts, where realtime reads it, and
 * re-exported here so every bound Live runs on is found in this file.
 */
export { MODERATOR_FRAME_COALESCE_MS } from '../contracts/frame-coalescing';
