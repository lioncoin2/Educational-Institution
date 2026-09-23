import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Result } from '../../../shared';
import type { Principal } from '../contracts';
import {
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type PasswordHasher,
  type UserRepository,
} from '../domain/ports';
import { permissionsForRoles } from '../domain/role';
import { isActive } from '../domain/user';

export interface AuthenticateCommand {
  readonly email: string;
  readonly password: string;
}

/**
 * Verifies credentials and resolves the caller's effective permissions.
 *
 * Failure is deliberately indistinguishable between "no such user" and "wrong
 * password" so the endpoint cannot be used to enumerate accounts. The password
 * is still hashed for a missing user, to keep the response time flat.
 */
@Injectable()
export class AuthenticateUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(command: AuthenticateCommand): Promise<Result<Principal>> {
    const invalid = failure(
      'unauthenticated',
      'identity.invalid_credentials',
      'Invalid email or password.',
    );

    const user = await this.users.findByEmail(command.email.trim().toLowerCase());
    if (user === null) {
      // Equalise timing against the found-user path.
      await this.hasher.verify(command.password, '$scrypt$0$0000$0000');
      return err(invalid);
    }

    const matches = await this.hasher.verify(command.password, user.passwordHash);
    if (!matches) return err(invalid);
    if (!isActive(user)) {
      return err(failure('forbidden', 'identity.user_not_active', 'This account is not active.'));
    }

    return ok({
      userId: user.id,
      roles: user.roles,
      permissions: permissionsForRoles(user.roles),
    });
  }
}
