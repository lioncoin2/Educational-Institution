import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import { isPermission } from '../contracts/permissions';
import { ROLE_CATALOG, type RoleCatalog, type RoleDefinition } from '../domain/ports';
import type { RoleCode } from '../domain/role';
import { IDENTITY_SETTINGS, type IdentitySettings } from './identity-settings';

interface Snapshot {
  readonly loadedAt: number;
  readonly byRole: ReadonlyMap<RoleCode, ReadonlySet<string>>;
}

/**
 * Resolves role codes to permissions, from the runtime role catalogue.
 *
 * The matrix changes rarely and is read on every request, so it is cached for a
 * short, configured time. What is NOT cached is which roles a user holds —
 * that is read fresh on every request, so revoking a role takes effect on the
 * very next call.
 *
 * Permissions the catalogue in code does not know are dropped: a permission
 * can only exist if code can check it.
 */
@Injectable()
export class RolePermissions {
  private snapshot: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;

  constructor(
    @Inject(ROLE_CATALOG) private readonly catalog: RoleCatalog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
  ) {}

  async permissionsFor(roles: readonly RoleCode[]): Promise<ReadonlySet<string>> {
    const { byRole } = await this.current();
    const effective = new Set<string>();
    for (const role of roles) {
      for (const permission of byRole.get(role) ?? []) effective.add(permission);
    }
    return effective;
  }

  /** The role's definition, or null if no such role exists at runtime. */
  async definition(role: RoleCode): Promise<RoleDefinition | null> {
    const permissions = (await this.current()).byRole.get(role);
    return permissions === undefined ? null : { code: role, permissions };
  }

  /** Forces the next read to reload — for when the matrix is changed in-process. */
  invalidate(): void {
    this.snapshot = null;
  }

  private async current(): Promise<Snapshot> {
    const now = this.clock.now().getTime();
    const fresh =
      this.snapshot !== null &&
      now - this.snapshot.loadedAt < this.settings.rolePolicyCacheSeconds * 1000;
    if (fresh && this.snapshot !== null) return this.snapshot;

    // One load at a time: a cold cache under load must not become N queries.
    this.loading ??= this.load(now).finally(() => {
      this.loading = null;
    });
    this.snapshot = await this.loading;
    return this.snapshot;
  }

  private async load(now: number): Promise<Snapshot> {
    const definitions = await this.catalog.list();
    const byRole = new Map<RoleCode, ReadonlySet<string>>();
    for (const definition of definitions) {
      byRole.set(
        definition.code,
        new Set([...definition.permissions].filter((permission) => isPermission(permission))),
      );
    }
    return { loadedAt: now, byRole };
  }
}
