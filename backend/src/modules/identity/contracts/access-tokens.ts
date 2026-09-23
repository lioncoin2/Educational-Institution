import type { Principal } from '../../../shared/principal';

/** DI token. */
export const ACCESS_TOKEN_AUTHENTICATOR = Symbol('ACCESS_TOKEN_AUTHENTICATOR');

/** Which account, through which signed-in session — identifiers, never a credential. */
export interface SessionReference {
  readonly userId: string;
  readonly sessionId: string;
}

export interface Authentication {
  readonly principal: Principal;
  /**
   * When the presented access token stops being valid. A connection that
   * outlives one request must present a fresh token before this instant, or
   * be treated as unauthenticated from then on.
   */
  readonly expiresAt: Date;
}

/**
 * Authentication for transports that are not an HTTP request — today, the
 * realtime connection.
 *
 * It is the SAME decision the HTTP guard makes, by the same code, not a
 * second implementation: a valid signature, issuer, audience and expiry; a
 * session that is still live; an ACTIVE account; roles and permissions read
 * from storage now, never from the token. Anything else is `null` — invalid,
 * expired, revoked and suspended all look alike, and nothing here throws for
 * bad input.
 */
export interface AccessTokenAuthenticator {
  authenticate(accessToken: string): Promise<Authentication | null>;

  /**
   * The principal for this session as of now — the session still live, the
   * account still ACTIVE, permissions re-read — or null once any of that has
   * stopped being true. For re-checking a long-lived connection without
   * holding on to its token, or to a copy of its roles.
   */
  revalidate(session: SessionReference): Promise<Principal | null>;
}
