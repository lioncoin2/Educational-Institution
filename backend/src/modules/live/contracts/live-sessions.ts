/** DI token. */
export const LIVE_SESSIONS = Symbol('LIVE_SESSIONS');

/**
 * What a live session is scoped to, as Live's own record holds it.
 *
 * `active` is true exactly while the session is live; an ended session keeps
 * its community and host, so a reader can still tell whose it was.
 */
export interface LiveSessionScope {
  readonly liveSessionId: string;
  readonly communityId: string;
  /** The starter. Whether they still moderate is Communities' answer, never this. */
  readonly hostUserId: string;
  readonly active: boolean;
}

/**
 * LIVE_SESSIONS — the scope of a live session, for trusted in-process
 * consumers (attendance, any future reader of session scope).
 *
 * Live's own record only: it never asks the media provider, and it takes no
 * principal — the caller authorizes its own act, in its own terms, against
 * the community named here. An unknown id is null.
 */
export interface LiveSessions {
  describe(liveSessionId: string): Promise<LiveSessionScope | null>;
}
