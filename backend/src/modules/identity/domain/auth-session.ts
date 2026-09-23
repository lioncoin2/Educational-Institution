import type { Id } from '../../../shared';
import type { UserId } from './user';

export type AuthSessionId = Id<'AuthSession'>;

/**
 * One signed-in device.
 *
 *   User
 *    ├── Session A (iPhone)
 *    ├── Session B (iPad)
 *    └── Session C (Web)
 *
 * A session is what a refresh token belongs to, and what every access token is
 * checked against on every request — so ending a session ends that device's
 * access immediately, not when its access token happens to expire.
 *
 * Refresh tokens rotate: each use issues a new one and retires the old. The
 * session keeps the hash of the current token and of the one before it, and
 * nothing else — never a raw token. Presenting the *previous* token is proof
 * that a token was copied (both the owner and someone else held it), so it
 * ends the session. See docs/architecture/session-management.md.
 */
export interface AuthSession {
  readonly id: AuthSessionId;
  readonly userId: UserId;
  readonly device: DeviceInfo;

  /** Hash of the refresh token that may be used next. */
  readonly refreshTokenHash: string;
  /** Hash of the token it replaced; presenting it again means reuse. */
  readonly previousRefreshTokenHash: string | null;
  /** How many times the token has rotated. Diagnostic; not a security control. */
  readonly generation: number;

  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  /** Absolute end of the session. Refreshing does not extend it. */
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: RevocationReason | null;
}

export type DevicePlatform = 'ios' | 'android' | 'web' | 'unknown';

export const DEVICE_PLATFORMS: readonly DevicePlatform[] = Object.freeze([
  'ios',
  'android',
  'web',
  'unknown',
]);

/**
 * What the client tells us about itself — self-declared, never trusted for a
 * decision, and deliberately minimal. No IP address, user-agent string or
 * hardware identifier is stored: those would make a session list a
 * fingerprinting database, and the user can recognize "Ahmad's iPhone" without
 * them.
 */
export interface DeviceInfo {
  readonly platform: DevicePlatform;
  /** e.g. "Ahmad's iPhone". Shown back to the user in their session list. */
  readonly label: string | null;
  readonly appVersion: string | null;
}

export type RevocationReason =
  | 'logout'
  | 'revoked_by_user'
  | 'revoked_by_admin'
  | 'refresh_token_reuse'
  | 'password_changed'
  | 'password_reset'
  | 'account_suspended'
  | 'account_disabled'
  | 'account_inactive';

export const REVOCATION_REASONS: readonly RevocationReason[] = Object.freeze([
  'logout',
  'revoked_by_user',
  'revoked_by_admin',
  'refresh_token_reuse',
  'password_changed',
  'password_reset',
  'account_suspended',
  'account_disabled',
  'account_inactive',
]);

export const DEVICE_LABEL_MAX_LENGTH = 64;
export const APP_VERSION_MAX_LENGTH = 32;

/**
 * Bounds and cleans self-declared device details before they are stored and
 * shown back to a user: control characters removed, whitespace collapsed,
 * length capped, unknown platforms mapped to "unknown".
 */
export function sanitizeDevice(input: {
  readonly platform?: string | null;
  readonly label?: string | null;
  readonly appVersion?: string | null;
}): DeviceInfo {
  const platform = (DEVICE_PLATFORMS as readonly string[]).includes(input.platform ?? '')
    ? (input.platform as DevicePlatform)
    : 'unknown';
  return {
    platform,
    label: cleanText(input.label, DEVICE_LABEL_MAX_LENGTH),
    appVersion: cleanText(input.appVersion, APP_VERSION_MAX_LENGTH),
  };
}

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value
    .normalize('NFC')
    // Whitespace first — a newline between two words is a space, not nothing —
    // then whatever control characters remain.
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  if (cleaned.length === 0) return null;
  return [...cleaned].slice(0, maxLength).join('');
}

export interface OpenSessionInput {
  readonly id: AuthSessionId;
  readonly userId: UserId;
  readonly device: DeviceInfo;
  readonly refreshTokenHash: string;
  readonly now: Date;
  readonly lifetimeSeconds: number;
}

export function openSession(input: OpenSessionInput): AuthSession {
  return {
    id: input.id,
    userId: input.userId,
    device: input.device,
    refreshTokenHash: input.refreshTokenHash,
    previousRefreshTokenHash: null,
    generation: 0,
    createdAt: input.now,
    lastUsedAt: input.now,
    expiresAt: new Date(input.now.getTime() + input.lifetimeSeconds * 1000),
    revokedAt: null,
    revokedReason: null,
  };
}

export function isSessionActive(session: AuthSession, now: Date): boolean {
  return session.revokedAt === null && now.getTime() < session.expiresAt.getTime();
}

/** The next state after a successful refresh: the presented token is retired. */
export function rotateRefreshToken(
  session: AuthSession,
  nextRefreshTokenHash: string,
  now: Date,
): AuthSession {
  return {
    ...session,
    previousRefreshTokenHash: session.refreshTokenHash,
    refreshTokenHash: nextRefreshTokenHash,
    generation: session.generation + 1,
    lastUsedAt: now,
  };
}

/** Idempotent: revoking a revoked session keeps the original time and reason. */
export function revokeSession(
  session: AuthSession,
  reason: RevocationReason,
  now: Date,
): AuthSession {
  if (session.revokedAt !== null) return session;
  return { ...session, revokedAt: now, revokedReason: reason };
}
