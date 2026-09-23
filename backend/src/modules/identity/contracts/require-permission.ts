import { SetMetadata } from '@nestjs/common';

import type { Permission } from './permissions';

export const REQUIRE_PERMISSION = 'identity:require_permission';

/**
 * Declares the permission a route requires.
 *
 * Part of identity's public contract: every module's controllers annotate their
 * routes with it, and identity's guard is what enforces it. A route carries
 * either this or `@PublicRoute()` — `authorization.spec.ts` fails the build if a
 * route carries neither, so an endpoint cannot ship unguarded by accident.
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRE_PERMISSION, permission);

/** Re-exported so controllers take both annotations from one import. */
export { PublicRoute } from '../../../platform/http/public-route.decorator';
