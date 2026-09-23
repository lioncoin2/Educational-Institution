import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Result } from '../../../shared';
import type { Principal } from '../contracts/principal';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';
import type { UserId } from '../domain/user';
import { toCurrentUserView, type CurrentUserView } from './views';

/**
 * "Who am I?" — the caller's own account as the system sees it right now.
 *
 * Permissions come from the principal, which was resolved from current storage
 * on this very request — so what the client is told it may do is exactly what
 * the server will allow.
 */
@Injectable()
export class GetCurrentUserUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async execute(command: { readonly principal: Principal }): Promise<Result<CurrentUserView>> {
    const user = await this.users.findById(command.principal.userId as UserId);
    if (user === null) {
      return err(failure('not_found', 'identity.user_not_found', 'No such account.'));
    }
    return ok(toCurrentUserView(user, command.principal.permissions));
  }
}
