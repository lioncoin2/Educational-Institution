import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Result } from '../../../shared';
import type { AccountAvatarWriter } from '../contracts/account-avatar';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';
import { clearAvatar, setAvatar, type UserId } from '../domain/user';

/**
 * Identity's implementation of the avatar writer other modules call.
 *
 * It only persists a reference that the caller (Files) has already verified; it
 * holds no opinion on whether the asset exists or is an image. Its own job is
 * narrow and identity-owned: load the account, apply the pure domain mutator,
 * save. A missing account is reported, never silently ignored.
 */
@Injectable()
export class IdentityAccountAvatarWriter implements AccountAvatarWriter {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async setAvatar(userId: string, fileAssetId: string): Promise<Result<void>> {
    const user = await this.users.findById(userId as UserId);
    if (user === null) {
      return err(failure('not_found', 'identity.user_not_found', 'No such account.'));
    }
    const updated = setAvatar(user, fileAssetId, this.clock.now());
    if (!updated.ok) return updated;
    await this.users.save(updated.value);
    return ok(undefined);
  }

  async clearAvatar(userId: string): Promise<Result<void>> {
    const user = await this.users.findById(userId as UserId);
    if (user === null) {
      return err(failure('not_found', 'identity.user_not_found', 'No such account.'));
    }
    await this.users.save(clearAvatar(user, this.clock.now()));
    return ok(undefined);
  }
}
