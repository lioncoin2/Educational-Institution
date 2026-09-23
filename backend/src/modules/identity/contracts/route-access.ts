import { SetMetadata } from '@nestjs/common';

import type { Permission } from './permissions';

export const REQUIRE_PERMISSION = 'identity:require_permission';
export const REQUIRE_AUTHENTICATION = 'identity:require_authentication';

/**
 * Every route declares exactly one of three access levels. A route that
 * declares none is refused with 403 — to everyone, on the first request — so an
 * endpoint cannot ship unguarded by accident. `test/architecture` also fails
 * the build for any controller route that declares none.
 */

/** The caller must be authenticated AND hold this permission. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRE_PERMISSION, permission);

/**
 * The caller must be authenticated; no particular permission is needed.
 *
 * For acts inherent to having an account — seeing who you are, signing
 * yourself out, managing your own sessions and password. Making these grantable
 * permissions would allow a role that cannot log out, which is absurd.
 */
export const Authenticated = () => SetMetadata(REQUIRE_AUTHENTICATION, true);

/** Re-exported so controllers take all three annotations from one import. */
export { PublicRoute, PUBLIC_ROUTE } from '../../../platform/http/public-route.decorator';
