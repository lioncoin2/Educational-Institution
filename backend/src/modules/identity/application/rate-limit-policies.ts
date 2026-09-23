import type { RateLimitPolicy } from '../../../shared';

/**
 * Authentication rate limits.
 *
 * DEVELOPMENT-SAFE DEFAULTS, NOT A PRODUCTION POLICY. They are generous enough
 * that a person — or a test suite — never meets them by accident, and tight
 * enough to make online password guessing slow. The production numbers should
 * be set from observed traffic, not guessed; see
 * docs/architecture/authentication.md, "Rate limiting".
 *
 * Two layers, because they stop different attacks:
 *   per IP          — one source hammering many accounts (credential stuffing)
 *   per identifier  — many sources hammering one account (targeted guessing)
 *
 * Throttling, never lockout: a lockout lets anyone who knows your email lock
 * you out on demand.
 */
export const AuthRateLimits = {
  loginPerIp: { name: 'auth.login.ip', limit: 30, windowSeconds: 300 },
  loginPerIdentifier: { name: 'auth.login.identifier', limit: 10, windowSeconds: 900 },
  refreshPerIp: { name: 'auth.refresh.ip', limit: 120, windowSeconds: 300 },
  passwordPerUser: { name: 'auth.password.user', limit: 5, windowSeconds: 900 },
  passwordPerIp: { name: 'auth.password.ip', limit: 20, windowSeconds: 900 },
} as const satisfies Record<string, RateLimitPolicy>;
