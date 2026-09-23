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
  /** Role names, carried for auditing and policy rules — not for `if` checks. */
  readonly roles: readonly string[];
  /** Effective permissions, already resolved from roles. */
  readonly permissions: ReadonlySet<string>;
}

export function principalHas(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}
