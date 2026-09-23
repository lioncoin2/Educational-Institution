import type { Principal } from '../../src/shared';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../src/modules/identity/domain/provisional-policy';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';

/**
 * A principal exactly as the access guard would resolve it for these roles
 * under the provisional matrix — without a login, so a test about messaging
 * or files is not also a test of password hashing.
 *
 * The matrix is the seeded one (a test keeps the two equal), so these carry
 * precisely the permissions a real account with the same roles would.
 */
export function principalWith(userId: string, roles: readonly KnownRoleCode[]): Principal {
  return {
    userId,
    roles,
    permissions: new Set<string>(roles.flatMap((role) => PROVISIONAL_ROLE_PERMISSIONS[role])),
    sessionId: `session-${userId}`,
  };
}
