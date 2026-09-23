import type { Result } from '../../../shared';
import type { Permission } from './permissions';
import type { Principal } from './principal';

/** DI token. Other modules inject the port, never a concrete class. */
export const AUTHORIZATION_SERVICE = Symbol('AUTHORIZATION_SERVICE');

/**
 * Facts a resource-scoped decision may need — "this room is hosted by that
 * teacher". Role permissions ignore it; policy rules use it.
 */
export interface AuthorizationContext {
  /** e.g. `live.session`, `identity.user`. */
  readonly resourceType?: string;
  readonly resourceId?: string;
  /** The user who owns or runs the resource, when that is meaningful. */
  readonly ownerUserId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * The only way to ask "is this allowed?".
 *
 * Centralised on purpose: scattered `if (user.role === 'admin')` checks are how
 * authorization rots. Every module depends on this port; identity owns the
 * answer.
 *
 * Use cases call `authorize` themselves, with the resource in `context`, rather
 * than trusting that an HTTP guard ran first. A use case may be invoked by a
 * job, an event handler or an automation rule — none of which pass through a
 * guard — and must be exactly as safe when they do.
 *
 * Deny by default: an unknown permission, an empty principal and a missing
 * context all produce "no".
 */
export interface AuthorizationService {
  can(principal: Principal, permission: Permission, context?: AuthorizationContext): boolean;

  /** Same decision, as a Result — for use cases that return failures. */
  authorize(
    principal: Principal,
    permission: Permission,
    context?: AuthorizationContext,
  ): Result<void>;
}
