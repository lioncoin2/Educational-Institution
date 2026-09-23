/**
 * The refresh token's wire format: `<sessionId>.<secret>`.
 *
 * The session id makes lookup a primary-key read; the secret is what proves
 * possession. Only the secret's hash is ever stored. The id is not secret — an
 * attacker who knows it still cannot refresh, and cannot even trigger reuse
 * detection, because that requires presenting a secret that was once valid.
 *
 * Parsing is strict so that anything malformed is rejected before it reaches
 * storage or a hash function.
 */
export interface RefreshTokenParts {
  readonly sessionId: string;
  readonly secret: string;
}

const SESSION_ID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;

/** 32 random bytes, base64url without padding — the generator must produce this. */
export const REFRESH_SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(token: string): RefreshTokenParts | null {
  const separator = token.indexOf('.');
  if (separator <= 0 || separator !== token.lastIndexOf('.')) return null;

  const sessionId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!SESSION_ID_SHAPE.test(sessionId) || !REFRESH_SECRET_SHAPE.test(secret)) return null;

  return { sessionId, secret };
}
