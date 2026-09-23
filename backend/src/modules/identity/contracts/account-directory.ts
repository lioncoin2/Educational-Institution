import type { Permission } from './permissions';

/** DI token. */
export const ACCOUNT_DIRECTORY = Symbol('ACCOUNT_DIRECTORY');

/**
 * What another module may know about an account: its id, a name to show, and
 * whether it can currently sign in. Deliberately nothing more — no login
 * identifier (email), no roles, no security state.
 */
export interface AccountSummary {
  readonly userId: string;
  readonly displayName: string;
  readonly active: boolean;
}

/** Upper bound on ids per call; callers with more ask in chunks. */
export const ACCOUNT_DIRECTORY_MAX_IDS = 1000;

/**
 * Identity's answer to "who is this account, and may it take part?" for
 * modules that reference accounts they did not create.
 *
 * Messaging asks it before letting anyone start a conversation with, or add,
 * an account — so an id that does not exist, belongs to a suspended account,
 * or holds no messaging permission is refused without messaging ever reading
 * identity's tables.
 */
export interface AccountDirectory {
  /** Summaries for the ids that exist. Unknown ids are simply absent. */
  describe(userIds: readonly string[]): Promise<readonly AccountSummary[]>;

  /**
   * The subset of `userIds` that are ACTIVE and whose roles grant `permission`.
   * The decision is identity's, made the same way as for a signed-in principal.
   */
  withPermission(userIds: readonly string[], permission: Permission): Promise<ReadonlySet<string>>;
}
