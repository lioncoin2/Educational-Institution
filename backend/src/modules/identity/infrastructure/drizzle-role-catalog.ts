import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { RoleCatalog, RoleDefinition } from '../domain/ports';
import { rolePermissions, roles } from './schema';

/**
 * The role → permission matrix, read from `roles` and `role_permissions`.
 *
 * One query for the whole matrix; `RolePermissions` caches the result. A role
 * with no grants is still returned — it exists and can be held, it simply
 * confers nothing.
 */
@Injectable()
export class DrizzleRoleCatalog implements RoleCatalog {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<readonly RoleDefinition[]> {
    const rows = await this.db
      .select({ role: roles.code, permission: rolePermissions.permissionCode })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleCode, roles.code));

    const byRole = new Map<string, Set<string>>();
    for (const row of rows) {
      const granted = byRole.get(row.role) ?? new Set<string>();
      if (row.permission !== null) granted.add(row.permission);
      byRole.set(row.role, granted);
    }
    return [...byRole].map(([code, permissions]) => ({ code, permissions }));
  }
}
