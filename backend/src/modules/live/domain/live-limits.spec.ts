import {
  ENFORCEMENT_WATCH_SECONDS,
  HANDS_PAGE_DEFAULT,
  HANDS_PAGE_MAX,
  IDLE_END_SECONDS,
  LIVE_SESSIONS_PAGE_MAX,
  LiveRateLimits,
  MAX_CONCURRENT_PRESENTERS,
  MAX_CONCURRENT_SPEAKERS,
  MAX_JOIN_TOKEN_TTL_SECONDS,
  MODERATOR_FRAME_COALESCE_MS,
  OBSERVATION_CACHE_SECONDS,
  ORPHAN_GRACE_SECONDS,
  PARTICIPANT_SWEEP_SECONDS,
  PENDING_HANDS_COUNT_CAP,
  ROOM_PROVIDER_TIMEOUT_SECONDS,
  ROOM_SWEEP_SECONDS,
  WATCH_TICK_SECONDS,
  isJoinTokenTtl,
} from './live-limits';

/** How long the media server's refreshed tokens stay valid (live.md §9). */
const REFRESHED_TOKEN_SECONDS = 600;

describe('live limits (PROVISIONAL, live.md §3.8)', () => {
  it('pins every bound to the design’s recorded default', () => {
    expect({
      MAX_CONCURRENT_SPEAKERS,
      MAX_CONCURRENT_PRESENTERS,
      MAX_JOIN_TOKEN_TTL_SECONDS,
      ROOM_SWEEP_SECONDS,
      PARTICIPANT_SWEEP_SECONDS,
      WATCH_TICK_SECONDS,
      ENFORCEMENT_WATCH_SECONDS,
      ORPHAN_GRACE_SECONDS,
      IDLE_END_SECONDS,
      ROOM_PROVIDER_TIMEOUT_SECONDS,
      OBSERVATION_CACHE_SECONDS,
      PENDING_HANDS_COUNT_CAP,
      HANDS_PAGE_MAX,
      HANDS_PAGE_DEFAULT,
      LIVE_SESSIONS_PAGE_MAX,
      MODERATOR_FRAME_COALESCE_MS,
    }).toEqual({
      MAX_CONCURRENT_SPEAKERS: 4,
      MAX_CONCURRENT_PRESENTERS: 1,
      MAX_JOIN_TOKEN_TTL_SECONDS: 600,
      ROOM_SWEEP_SECONDS: 30,
      PARTICIPANT_SWEEP_SECONDS: 60,
      WATCH_TICK_SECONDS: 10,
      ENFORCEMENT_WATCH_SECONDS: 660,
      ORPHAN_GRACE_SECONDS: 60,
      IDLE_END_SECONDS: 900,
      ROOM_PROVIDER_TIMEOUT_SECONDS: 1_200,
      OBSERVATION_CACHE_SECONDS: 2,
      PENDING_HANDS_COUNT_CAP: 100,
      HANDS_PAGE_MAX: 100,
      HANDS_PAGE_DEFAULT: 50,
      LIVE_SESSIONS_PAGE_MAX: 100,
      MODERATOR_FRAME_COALESCE_MS: 250,
    });
  });

  // The provider's SDK turns a falsy lifetime into six hours (audit D24). The
  // lifetime itself is configuration (P7.2, Q-C); this is the mint's check.
  it('accepts a join token of a whole number of seconds from 1 to 600 at the call site, and nothing else', () => {
    for (const ttl of [1, 120, 600]) expect(isJoinTokenTtl(ttl)).toBe(true);
    for (const ttl of [0, -1, 601, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect({ ttl, accepted: isJoinTokenTtl(ttl) }).toEqual({ ttl, accepted: false });
    }
  });

  it('watches a closed floor for longer than a refreshed token lives, by one participant sweep', () => {
    expect(ENFORCEMENT_WATCH_SECONDS).toBe(REFRESHED_TOKEN_SECONDS + PARTICIPANT_SWEEP_SECONDS);
  });

  it('ends an idle session itself: the provider’s own timeouts are only a backstop', () => {
    expect(IDLE_END_SECONDS).toBeLessThan(ROOM_PROVIDER_TIMEOUT_SECONDS);
  });

  it('asks for no more than the hands page allows when no size is given', () => {
    expect(HANDS_PAGE_DEFAULT).toBeLessThanOrEqual(HANDS_PAGE_MAX);
  });

  it('limits starts per user and joins and hands per (session, user), each under its own name', () => {
    expect(LiveRateLimits).toEqual({
      startsPerUser: { name: 'live.start.user', limit: 10, windowSeconds: 60 },
      joinsPerSessionUser: { name: 'live.join.session_user', limit: 10, windowSeconds: 60 },
      handsPerSessionUser: { name: 'live.hand.session_user', limit: 6, windowSeconds: 60 },
    });
    const names = Object.values(LiveRateLimits).map((policy) => policy.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
