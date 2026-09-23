import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as deliberately unauthenticated.
 *
 * It lives in platform rather than identity because platform's own routes
 * (health probes) need it, and platform must not depend on a business module.
 * Identity's PermissionGuard reads this key — the guard refuses any route that
 * declares neither this nor a required permission, so "public" is always a
 * decision someone wrote down.
 */
export const PUBLIC_ROUTE = 'platform:public_route';

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);
