import type { Result } from '../../../shared';
import type { Permission } from './permissions';
import type { Principal } from './principal';

/** DI token. Other modules inject the port, never a concrete class. */
export const AUTHORIZATION_SERVICE = Symbol('AUTHORIZATION_SERVICE');

/**
 * Extra facts a resource-scoped decision may need — "this teacher owns this
 * halaqa", "this student belongs to this session". Role-based permission checks
 * ignore it; policy rules use it.
 */
export interface AuthorizationContext {
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly ownerUserId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * The only way to ask "is this allowed?".
 *
 * Centralised on purpose: scattered `if (user.role === 'admin')` checks are how
 * authorization rots. Every module depends on this port; identity owns the
 * answer.
 */
export interface AuthorizationService {
  can(principal: Principal, permission: Permission, context?: AuthorizationContext): boolean;

  /** Same decision, as a Result — for use cases that return failures. */
  authorize(
    principal: Principal,
    permission: Permission,
    context?: AuthorizationContext,
  ): Result<void>;

  /**
   * Resolves an authenticated identity and its granted roles into a Principal.
   *
   * Part of the contract because the HTTP edge needs it on every request, and
   * the edge must not reach into identity's domain to do the resolution itself.
   */
  principalFor(userId: string, roles: readonly string[]): Principal;
}
