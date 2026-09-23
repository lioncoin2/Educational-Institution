import { Inject, Injectable } from '@nestjs/common';

import {
  ACCOUNT_DIRECTORY_MAX_IDS,
  type AccountDirectory,
  type AccountSummary,
} from '../contracts/account-directory';
import { AUTHORIZATION_SERVICE, type AuthorizationService } from '../contracts/authorization';
import type { Permission } from '../contracts/permissions';
import { canAuthenticate } from '../domain/account-status';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';
import { roleCodes, type User, type UserId } from '../domain/user';
import { RolePermissions } from './role-permissions';

/**
 * Identity's implementation of the account directory other modules consult.
 *
 * `withPermission` builds each account's principal exactly as a request would
 * — current status, current roles, the cached role matrix — and asks the one
 * authorization service. So "may this account read messages?" is decided by
 * the same rules as "may I?", never by a second copy of them.
 */
@Injectable()
export class IdentityAccountDirectory implements AccountDirectory {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    private readonly rolePermissions: RolePermissions,
  ) {}

  async describe(userIds: readonly string[]): Promise<readonly AccountSummary[]> {
    const found = await this.load(userIds);
    return found.map((user) => ({
      userId: user.id,
      displayName: user.displayName,
      active: canAuthenticate(user.status),
    }));
  }

  async withPermission(
    userIds: readonly string[],
    permission: Permission,
  ): Promise<ReadonlySet<string>> {
    const eligible = new Set<string>();
    for (const user of await this.load(userIds)) {
      if (!canAuthenticate(user.status)) continue;
      const roles = roleCodes(user);
      const principal = {
        userId: user.id,
        roles,
        permissions: await this.rolePermissions.permissionsFor(roles),
      };
      if (this.authorization.can(principal, permission)) eligible.add(user.id);
    }
    return eligible;
  }

  private async load(userIds: readonly string[]): Promise<readonly User[]> {
    const unique = [...new Set(userIds)];
    if (unique.length > ACCOUNT_DIRECTORY_MAX_IDS) {
      throw new RangeError(
        `AccountDirectory accepts at most ${ACCOUNT_DIRECTORY_MAX_IDS} ids per call.`,
      );
    }
    return this.users.findManyByIds(unique as UserId[]);
  }
}
