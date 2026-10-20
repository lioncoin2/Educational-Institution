import { Inject, Injectable } from '@nestjs/common';

import type {
  AccountDirectorySummary,
  AccountStatusCounts,
} from '../contracts/account-directory-summary';
import { AccountStatuses } from '../domain/account-status';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';

/**
 * The accounts tally behind the command center's accounts widget — one grouped
 * count of the users table, mapped to the public shape. `total` sums every
 * status (so a status added later still counts in the total), and each named
 * field is that status's own count, 0 when none. No account is read whole, and
 * nothing but counts leaves identity.
 */
@Injectable()
export class IdentityAccountDirectorySummary implements AccountDirectorySummary {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async summarize(): Promise<AccountStatusCounts> {
    const counts = await this.users.countByStatus();
    let total = 0;
    for (const n of counts.values()) total += n;
    return {
      total,
      active: counts.get(AccountStatuses.active) ?? 0,
      pending: counts.get(AccountStatuses.pending) ?? 0,
      suspended: counts.get(AccountStatuses.suspended) ?? 0,
      disabled: counts.get(AccountStatuses.disabled) ?? 0,
    };
  }
}
