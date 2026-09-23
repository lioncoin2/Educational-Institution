import { PUBLIC_ROUTE } from '../../src/platform/http/public-route.decorator';
import { HealthController } from '../../src/platform/health/health.controller';
import { AuthController } from '../../src/modules/identity/api/auth.controller';
import { REQUIRE_PERMISSION } from '../../src/modules/identity/contracts';
import { LiveController } from '../../src/modules/live/api/live.controller';

/**
 * Every route is a decision.
 *
 * A route must declare the permission it needs, or be explicitly marked public.
 * Without this test, the first endpoint someone adds in a hurry ships with no
 * authorization at all and nothing notices — the guard would reject it at
 * runtime, but only once somebody calls it.
 *
 * New controllers must be added to this list; that is deliberate friction.
 */
const CONTROLLERS = [AuthController, LiveController, HealthController];

interface RouteInfo {
  readonly controller: string;
  readonly method: string;
  readonly permission: unknown;
  readonly isPublic: boolean;
}

function routesOf(controller: new (...args: never[]) => unknown): RouteInfo[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return (
    Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => prototype[name])
      .filter(
        (handler): handler is (...args: unknown[]) => unknown => typeof handler === 'function',
      )
      // Nest marks a method as a route by attaching a 'path' metadata key.
      .filter((handler) => Reflect.getMetadata('path', handler) !== undefined)
      .map((handler) => ({
        controller: controller.name,
        method: handler.name,
        permission: Reflect.getMetadata(REQUIRE_PERMISSION, handler),
        isPublic: Reflect.getMetadata(PUBLIC_ROUTE, handler) === true,
      }))
  );
}

describe('route authorization', () => {
  const routes = CONTROLLERS.flatMap(routesOf);

  it('finds the routes it is meant to be checking', () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });

  it('declares a permission or an explicit public marker on every route', () => {
    const undeclared = routes
      .filter((route) => route.permission === undefined && !route.isPublic)
      .map((route) => `${route.controller}.${route.method}`);

    expect(undeclared).toEqual([]);
  });

  it('keeps the set of public routes small and deliberate', () => {
    const publicRoutes = routes
      .filter((route) => route.isPublic)
      .map((route) => `${route.controller}.${route.method}`)
      .sort();

    // Login and the two health probes. Anything else must be argued for.
    expect(publicRoutes).toEqual([
      'AuthController.authenticate',
      'HealthController.live',
      'HealthController.ready',
    ]);
  });

  it('never marks a route both public and permission-guarded', () => {
    const contradictory = routes
      .filter((route) => route.isPublic && route.permission !== undefined)
      .map((route) => `${route.controller}.${route.method}`);

    expect(contradictory).toEqual([]);
  });
});
