/**
 * The authenticated actor.
 *
 * It lives in the shared kernel rather than inside identity because every layer
 * — including platform's HTTP plumbing — needs to name it, and platform must not
 * depend on a business module. Identity remains the only module that decides
 * what a principal may *do*; this is just who they are.
 */
export interface Principal {
  readonly userId: string;
  /** Role codes, carried for auditing and policy rules — never for `if` checks. */
  readonly roles: readonly string[];
  /** Effective permissions, resolved from the principal's roles at request time. */
  readonly permissions: ReadonlySet<string>;
  /**
   * The authenticated session this principal acts through, when there is one.
   * Absent for system principals (jobs, automation), which have no session.
   */
  readonly sessionId?: string;
}

export function principalHas(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}
