/** DI token. */
export const ACCOUNT_DIRECTORY_SUMMARY = Symbol('ACCOUNT_DIRECTORY_SUMMARY');

/**
 * A factual tally of accounts by status — an aggregate only, never a person and
 * never an identifier. `total` is every account whatever its status; the named
 * fields break out the current statuses (a status with none reads 0). The
 * RIGHT to see it is decided above this port (reporting gates the accounts
 * widget on `users.manage`, the owner/admin "is an administrator" marker).
 */
export interface AccountStatusCounts {
  readonly total: number;
  readonly active: number;
  readonly pending: number;
  readonly suspended: number;
  readonly disabled: number;
}

/**
 * Identity's answer to "how many accounts, and in what state?" — the owner's
 * directory tally for the command center, with no listing and no enumeration.
 */
export interface AccountDirectorySummary {
  summarize(): Promise<AccountStatusCounts>;
}
