/** DI token. */
export const ACCOUNT_ROSTER = Symbol('ACCOUNT_ROSTER');

/** Upper bound on ids per page; callers walk the roster page by page. */
export const ACCOUNT_ROSTER_MAX_PAGE = 500;

/**
 * Identity's answer to "which ACTIVE accounts hold one of these roles?" — the
 * one way another module may enumerate an audience by role. The daily tasks
 * engine (ADR 0052) addresses a task to the institution's staff audiences
 * (teachers, supervisors, administration) and snapshots who they are at the
 * moment of publishing.
 *
 * Ids only, in id order, a page at a time: a name or a picture is asked of
 * [AccountDirectory] like any other reference. It only FINDS; the caller's
 * RIGHT to address an audience is decided above this port (the tasks module
 * gates publishing on `tasks.manage`). Suspended or disabled accounts are never
 * returned, so a task is never addressed to someone who cannot sign in.
 */
export interface AccountRoster {
  /**
   * ACTIVE accounts holding at least one of `roles`, after `cursor` (an id this
   * contract returned), at most `limit` (1..ACCOUNT_ROSTER_MAX_PAGE).
   */
  activeWithRoles(
    roles: readonly string[],
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;

  /** The subset of `userIds` (at most ACCOUNT_ROSTER_MAX_PAGE) that are ACTIVE and hold one of `roles`. */
  activeAmong(userIds: readonly string[], roles: readonly string[]): Promise<ReadonlySet<string>>;
}
