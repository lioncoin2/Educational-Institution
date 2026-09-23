import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Result } from '../../../../shared';
import { AUTHORIZATION_SERVICE, type AuthorizationService } from '../../contracts/authorization';
import type { Permission } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import { canAdminister, isSelfAdministration } from '../../domain/administration';
import { USER_REPOSITORY, type UserRepository } from '../../domain/ports';
import { roleCodes, type User, type UserId } from '../../domain/user';
import { USER_RESOURCE } from '../audit-actions';
import { RolePermissions } from '../role-permissions';

/**
 * The gate every administrative use case passes through before touching
 * another account. In order:
 *
 *   1. the actor holds the permission for this kind of act;
 *   2. the target is not the actor (self-service has its own endpoints);
 *   3. the target exists;
 *   4. the actor holds every permission the target holds — no one administers
 *      an account more powerful than their own.
 *
 * The permission is checked before the target is loaded, so a caller without
 * it cannot use the error to learn which accounts exist.
 */
@Injectable()
export class AccountAdministration {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly rolePermissions: RolePermissions,
  ) {}

  async loadTarget(
    actor: Principal,
    permission: Permission,
    targetId: string,
  ): Promise<Result<User>> {
    const allowed = this.authorization.authorize(actor, permission, {
      resourceType: USER_RESOURCE,
      resourceId: targetId,
    });
    if (!allowed.ok) return allowed;

    if (isSelfAdministration(actor.userId, targetId)) {
      return err(
        failure(
          'forbidden',
          'identity.self_administration',
          'Administrative actions cannot target your own account.',
        ),
      );
    }

    const target = await this.users.findById(targetId as UserId);
    if (target === null) {
      return err(failure('not_found', 'identity.user_not_found', 'No such account.'));
    }

    const targetPermissions = await this.rolePermissions.permissionsFor(roleCodes(target));
    if (!canAdminister(actor.permissions, targetPermissions)) {
      return err(
        failure(
          'forbidden',
          'identity.target_outranks_actor',
          'This account holds permissions you do not, so you cannot administer it.',
        ),
      );
    }

    return ok(target);
  }
}
