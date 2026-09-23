import type { Principal } from '../../../shared/principal';
import type { Permission } from './permissions';

/**
 * Principal is kernel vocabulary (see `shared/principal.ts`) — re-exported here
 * so callers can take everything they need about access from one place.
 */
export { principalHas, type Principal } from '../../../shared/principal';

/** Prefix that can never collide with a user id (ids are UUIDs). */
export const SYSTEM_PRINCIPAL_PREFIX = 'system:';

/**
 * A principal for work nobody is logged in to do — a scheduled job, an event
 * handler, an automation rule.
 *
 * It holds exactly the permissions it is given and nothing else, so a job that
 * reconciles attendance cannot also assign roles. Use cases authorize it with
 * the same call they use for a person; that is the point.
 */
export function systemPrincipal(name: string, permissions: readonly Permission[]): Principal {
  return {
    userId: `${SYSTEM_PRINCIPAL_PREFIX}${name}`,
    roles: [],
    permissions: new Set<string>(permissions),
  };
}

export function isSystemPrincipal(principal: Principal): boolean {
  return principal.userId.startsWith(SYSTEM_PRINCIPAL_PREFIX);
}
