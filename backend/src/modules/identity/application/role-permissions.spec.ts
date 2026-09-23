import type { RoleCatalog, RoleDefinition } from '../domain/ports';
import { AdjustableClock } from '../../../../test/support/identity-harness';
import { RolePermissions } from './role-permissions';

class CountingCatalog implements RoleCatalog {
  loads = 0;
  constructor(public matrix: Record<string, string[]>) {}
  async list(): Promise<readonly RoleDefinition[]> {
    this.loads += 1;
    return Object.entries(this.matrix).map(([code, permissions]) => ({
      code,
      permissions: new Set(permissions),
    }));
  }
}

describe('RolePermissions', () => {
  it('unions the permissions of several roles', async () => {
    const catalog = new CountingCatalog({ A: ['live.join'], B: ['reports.read'] });
    const roles = new RolePermissions(catalog, new AdjustableClock(), {
      refreshSessionTtlSeconds: 1,
      rolePolicyCacheSeconds: 30,
    });
    expect([...(await roles.permissionsFor(['A', 'B']))].sort()).toEqual([
      'live.join',
      'reports.read',
    ]);
  });

  it('grants nothing for a role that does not exist', async () => {
    const roles = new RolePermissions(new CountingCatalog({}), new AdjustableClock(), {
      refreshSessionTtlSeconds: 1,
      rolePolicyCacheSeconds: 30,
    });
    expect((await roles.permissionsFor(['NOT_A_ROLE'])).size).toBe(0);
    expect(await roles.definition('NOT_A_ROLE')).toBeNull();
  });

  // A permission code in storage that this version of the code cannot check
  // (after a rollback, say) must not appear in anyone's permission set.
  it('drops permissions the code catalogue does not know', async () => {
    const catalog = new CountingCatalog({ A: ['live.join', 'live.teleport'] });
    const roles = new RolePermissions(catalog, new AdjustableClock(), {
      refreshSessionTtlSeconds: 1,
      rolePolicyCacheSeconds: 30,
    });
    expect([...(await roles.permissionsFor(['A']))]).toEqual(['live.join']);
  });

  it('caches the matrix for the configured time, then reloads', async () => {
    const clock = new AdjustableClock();
    const catalog = new CountingCatalog({ A: ['live.join'] });
    const roles = new RolePermissions(catalog, clock, {
      refreshSessionTtlSeconds: 1,
      rolePolicyCacheSeconds: 30,
    });

    await roles.permissionsFor(['A']);
    await roles.permissionsFor(['A']);
    expect(catalog.loads).toBe(1);

    catalog.matrix = { A: ['live.join', 'reports.read'] };
    clock.advance(31);
    expect((await roles.permissionsFor(['A'])).has('reports.read')).toBe(true);
    expect(catalog.loads).toBe(2);
  });

  it('loads once for concurrent callers on a cold cache', async () => {
    const catalog = new CountingCatalog({ A: ['live.join'] });
    const roles = new RolePermissions(catalog, new AdjustableClock(), {
      refreshSessionTtlSeconds: 1,
      rolePolicyCacheSeconds: 30,
    });
    await Promise.all(Array.from({ length: 10 }, () => roles.permissionsFor(['A'])));
    expect(catalog.loads).toBe(1);
  });
});
