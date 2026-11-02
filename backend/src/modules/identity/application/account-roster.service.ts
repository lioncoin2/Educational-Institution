import { Inject, Injectable } from '@nestjs/common';

import { ACCOUNT_ROSTER_MAX_PAGE, type AccountRoster } from '../contracts/account-roster';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';

/**
 * Identity's implementation of the role roster other modules consult (ADR 0052).
 * It reads only ACTIVE accounts, in id order, and returns ids only — who may
 * ask is decided above it.
 */
@Injectable()
export class IdentityAccountRoster implements AccountRoster {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async activeWithRoles(
    roles: readonly string[],
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > ACCOUNT_ROSTER_MAX_PAGE) {
      throw new RangeError(`limit must be 1..${ACCOUNT_ROSTER_MAX_PAGE}`);
    }
    const wanted = [...new Set(roles)];
    if (wanted.length === 0) return { userIds: [], nextCursor: null };
    const ids = await this.users.listActiveIdsWithRoles(
      wanted,
      page.cursor ?? null,
      page.limit + 1,
    );
    const userIds = ids.slice(0, page.limit);
    return {
      userIds,
      nextCursor: ids.length > page.limit ? (userIds[userIds.length - 1] ?? null) : null,
    };
  }

  async activeAmong(
    userIds: readonly string[],
    roles: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (userIds.length > ACCOUNT_ROSTER_MAX_PAGE) {
      throw new RangeError(`at most ${ACCOUNT_ROSTER_MAX_PAGE} ids`);
    }
    if (userIds.length === 0 || roles.length === 0) return new Set();
    return new Set(await this.users.filterActiveIdsWithRoles(userIds, [...new Set(roles)]));
  }
}
