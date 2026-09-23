import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PATH_METADATA } from '@nestjs/common/constants';

import { PUBLIC_ROUTE } from '../../src/platform/http/public-route.decorator';
import {
  REQUIRE_AUTHENTICATION,
  REQUIRE_PERMISSION,
  isPermission,
} from '../../src/modules/identity/contracts';

/**
 * Every route is a decision.
 *
 * Each route must declare exactly one access level — public, authenticated, or
 * a permission. The AccessGuard refuses undeclared routes at runtime; this test
 * refuses them at build time, before anyone has to call one to find out.
 *
 * Controllers are DISCOVERED from the source tree, not listed by hand. The
 * Foundation version of this test used a list, which meant a new controller
 * nobody added to it was never checked at all.
 */
const SRC = join(__dirname, '..', '..', 'src');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}

type Constructor = abstract new (...args: never[]) => unknown;

interface Route {
  readonly name: string;
  readonly isPublic: boolean;
  readonly authenticated: boolean;
  readonly permission: unknown;
}

async function discover(): Promise<{ controllers: string[]; routes: Route[] }> {
  const controllers: string[] = [];
  const routes: Route[] = [];
  for (const file of controllerFiles(SRC)) {
    const exported = (await import(file)) as Record<string, unknown>;
    for (const candidate of Object.values(exported)) {
      if (typeof candidate !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, candidate) === undefined) continue;
      const controller = candidate as Constructor & { name: string };
      controllers.push(`${relative(SRC, file)}#${controller.name}`);

      const prototype = controller.prototype as Record<string, unknown>;
      for (const method of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[method];
        if (method === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        routes.push({
          name: `${controller.name}.${method}`,
          isPublic: Reflect.getMetadata(PUBLIC_ROUTE, handler) === true,
          authenticated: Reflect.getMetadata(REQUIRE_AUTHENTICATION, handler) === true,
          permission: Reflect.getMetadata(REQUIRE_PERMISSION, handler),
        });
      }
    }
  }
  return { controllers, routes };
}

describe('route authorization', () => {
  let controllers: string[] = [];
  let routes: Route[] = [];

  beforeAll(async () => {
    ({ controllers, routes } = await discover());
  });

  it('finds every controller in the source tree', () => {
    expect(controllers.sort()).toEqual([
      'modules/files/api/uploads.controller.ts#UploadsController',
      'modules/files/infrastructure/local-transfer.controller.ts#LocalTransferController',
      'modules/identity/api/admin-users.controller.ts#AdminUsersController',
      'modules/identity/api/auth.controller.ts#AuthController',
      'modules/live/api/live.controller.ts#LiveController',
      'modules/messaging/api/conversations.controller.ts#ConversationsController',
      'modules/notifications/api/notifications.controller.ts#NotificationsController',
      'platform/health/health.controller.ts#HealthController',
    ]);
    expect(routes.length).toBeGreaterThanOrEqual(20);
  });

  it('declares exactly one access level on every route', () => {
    const wrong = routes
      .map((route) => ({
        route: route.name,
        declared: [route.isPublic, route.authenticated, route.permission !== undefined].filter(
          Boolean,
        ).length,
      }))
      .filter((entry) => entry.declared !== 1);
    expect(wrong).toEqual([]);
  });

  it('only ever requires a permission that exists in the catalogue', () => {
    const unknown = routes
      .filter((route) => route.permission !== undefined)
      .filter((route) => typeof route.permission !== 'string' || !isPermission(route.permission))
      .map((route) => route.name);
    expect(unknown).toEqual([]);
  });

  it('keeps the set of public routes small and deliberate', () => {
    const publicRoutes = routes
      .filter((route) => route.isPublic)
      .map((route) => route.name)
      .sort();

    // Sign-in, token refresh, and the two health probes. Anything else must be
    // argued for — in this list, in review.
    //
    // The local storage transfer routes are public in the guard's sense only:
    // each request carries a purpose-bound HMAC signature that expires in
    // minutes, which is the authorization — exactly as for a presigned
    // object-store URL, which never sees a bearer token either.
    expect(publicRoutes).toEqual([
      'AuthController.login',
      'AuthController.refresh',
      'HealthController.live',
      'HealthController.ready',
      'LocalTransferController.download',
      'LocalTransferController.upload',
    ]);
  });

  // A person's own inbox, preferences and devices: authentication and nothing
  // else, because every use case is scoped to the caller's own id — and never
  // public, because there is no inbox without an account.
  it('keeps every notification route authenticated — never public, never widened', () => {
    const notificationRoutes = routes.filter((route) =>
      route.name.startsWith('NotificationsController.'),
    );
    expect(notificationRoutes.map((route) => route.name).sort()).toEqual([
      'NotificationsController.changePreferences',
      'NotificationsController.device',
      'NotificationsController.forgetDevice',
      'NotificationsController.list',
      'NotificationsController.preferences',
      'NotificationsController.read',
      'NotificationsController.readAll',
      'NotificationsController.unread',
    ]);
    expect(notificationRoutes.filter((route) => !route.authenticated)).toEqual([]);
  });

  it('puts every administrative route behind a permission, never mere authentication', () => {
    const lax = routes
      .filter((route) => route.name.startsWith('AdminUsersController.'))
      .filter((route) => route.permission === undefined)
      .map((route) => route.name);
    expect(lax).toEqual([]);
  });
});
