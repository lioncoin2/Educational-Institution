/** DI token. */
export const LIVE_AUDIENCE = Symbol('LIVE_AUDIENCE');

/** The most user ids one `participantsAmong` call may ask about, and the largest `moderators` page. */
export const MAX_AUDIENCE_PROBE = 1000;

/**
 * LIVE_AUDIENCE — who a live session's facts may reach, for realtime's relay.
 *
 * Every answer is Communities' (COMMUNITY_AUTHORIZATION.permittedAmong and
 * COMMUNITY_CAPABILITY_HOLDERS), asked at the moment of the call: Live keeps
 * no copy of a membership, ceiling or lifecycle rule, and caches nothing. A
 * failure to ask rejects — never a partial or empty answer for "could not
 * tell".
 */
export interface LiveAudience {
  /**
   * Of `userIds` (at most MAX_AUDIENCE_PROBE; a RangeError above), who may
   * take part in this session now, ignoring the session's state: those
   * Communities permits `community.live.join`, and the session's moderators
   * among them (`community.live.moderate`, or the host while
   * `community.live.host` holds). Deduplicated, in the order given. An
   * unknown session → [].
   */
  participantsAmong(sessionId: string, userIds: readonly string[]): Promise<readonly string[]>;

  /**
   * The session's moderators: the holders of `community.live.moderate`
   * (COMMUNITY_CAPABILITY_HOLDERS, which applies the act's ceiling), plus the
   * host while `permittedAmong(C, [host], 'community.live.host')` accepts
   * them. Keyset pages of at most `limit` (1..MAX_AUDIENCE_PROBE; a
   * RangeError outside), every id exactly once across the pages; a page may
   * be short, even empty — keep asking while `nextCursor` is not null. An
   * ended or unknown session → no ids, no cursor. A cursor this contract did
   * not issue for this session is a RangeError.
   */
  moderators(
    sessionId: string,
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}
