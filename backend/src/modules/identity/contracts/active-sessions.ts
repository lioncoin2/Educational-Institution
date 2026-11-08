import type { SessionReference } from './access-tokens';

/** DI token. */
export const ACTIVE_SESSIONS = Symbol('ACTIVE_SESSIONS');

/** Upper bound on references per call; a caller asks a page at a time. */
export const ACTIVE_SESSIONS_MAX_BATCH = 1000;

/**
 * Identity's answer to "which of these signed-in sessions are still live?" —
 * not revoked, not expired, and belonging to the account named with each one.
 *
 * Notifications asks it before a push (ADR 0058): a device registered under a
 * session that has ended — signed out, revoked from another device, ended by a
 * password change or an administrator, refused at refresh, or simply expired —
 * receives nothing more, whichever of those paths ended it. That is why it is a
 * question asked at send time rather than an event: every ending is covered,
 * including expiry, which no use case announces.
 *
 * References in, references out; never a session's details. A reference whose
 * session belongs to another account is not live.
 */
export interface ActiveSessions {
  /**
   * The references among `refs` (at most ACTIVE_SESSIONS_MAX_BATCH) whose
   * session is live for the account named with it.
   */
  activeAmong(refs: readonly SessionReference[]): Promise<readonly SessionReference[]>;
}
