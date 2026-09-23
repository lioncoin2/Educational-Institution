import { Inject, Injectable } from '@nestjs/common';

import {
  clampLimit,
  err,
  failure,
  ok,
  type Page,
  type PageRequest,
  type Result,
} from '../../../../shared';
import { AUTHORIZATION_SERVICE, type AuthorizationService } from '../../contracts/authorization';
import { Permissions } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import { USER_REPOSITORY, type UserRepository } from '../../domain/ports';
import type { UserId } from '../../domain/user';
import { USER_RESOURCE } from '../audit-actions';
import { toUserAccountView, type UserAccountView } from '../views';

/** Reading accounts needs `users.read`. Reading is not administering, so no rank check. */
@Injectable()
export class ListUsersUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async execute(command: {
    readonly actor: Principal;
    readonly page: PageRequest;
  }): Promise<Result<Page<UserAccountView>>> {
    const allowed = this.authorization.authorize(command.actor, Permissions.users.read, {
      resourceType: USER_RESOURCE,
    });
    if (!allowed.ok) return allowed;

    const page = await this.users.list({ ...command.page, limit: clampLimit(command.page.limit) });
    return ok({ items: page.items.map(toUserAccountView), nextCursor: page.nextCursor });
  }
}

@Injectable()
export class GetUserUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async execute(command: {
    readonly actor: Principal;
    readonly userId: string;
  }): Promise<Result<UserAccountView>> {
    const allowed = this.authorization.authorize(command.actor, Permissions.users.read, {
      resourceType: USER_RESOURCE,
      resourceId: command.userId,
    });
    if (!allowed.ok) return allowed;

    const user = await this.users.findById(command.userId as UserId);
    if (user === null) {
      return err(failure('not_found', 'identity.user_not_found', 'No such account.'));
    }
    return ok(toUserAccountView(user));
  }
}
