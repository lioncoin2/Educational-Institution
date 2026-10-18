import { Inject, Injectable } from '@nestjs/common';

import { AUTHORIZATION_SERVICE, type AuthorizationService } from '../../contracts/authorization';
import { Permissions } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import type { User } from '../../domain/user';
import { USER_RESOURCE } from '../audit-actions';
import { toUserAccountView, type UserAccountView } from '../views';

/**
 * What an account looks like to the person reading it — the one place that
 * decides whether its login identifiers (today, its email) are shown.
 *
 * ENGINEERING_RULES §11 keeps emails out of responses. Account administration
 * is the one surface that needs them — whoever creates an account, resets its
 * password or changes its status has to know how it signs in — so they are
 * shown only to whoever may administer accounts (`users.manage`). Reading
 * accounts (`users.read`) alone, as the provisional matrix grants a supervisor
 * (Q1), shows who an account is, its status and its roles: never how it signs
 * in. Withheld is `null`, not an empty list — "not yours to see" is not "has
 * none".
 */
@Injectable()
export class AccountViews {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
  ) {}

  of(reader: Principal, account: User): UserAccountView {
    const mayReadIdentifiers = this.authorization.can(reader, Permissions.users.manage, {
      resourceType: USER_RESOURCE,
      resourceId: account.id,
    });
    return toUserAccountView(account, mayReadIdentifiers ? 'shown' : 'withheld');
  }
}
