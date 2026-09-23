/**
 * Re-export of the public contract, so identity's own controllers import the
 * same annotation every other module uses.
 */
export {
  PublicRoute,
  REQUIRE_PERMISSION,
  RequirePermission,
} from '../../contracts/require-permission';
