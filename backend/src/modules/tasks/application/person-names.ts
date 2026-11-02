import { Inject, Injectable } from '@nestjs/common';

import {
  ACCOUNT_DIRECTORY,
  ACCOUNT_DIRECTORY_MAX_IDS,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';

/**
 * Display names for the people a view shows, asked of identity at view time
 * (names never cross a contract or enter a stored row). An account that no
 * longer exists keeps its id and shows no name.
 */
@Injectable()
export class PersonNames {
  constructor(@Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory) {}

  async of(userIds: Iterable<string | null>): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set([...userIds].filter((id): id is string => id !== null))];
    const names = new Map<string, string>();
    for (let start = 0; start < ids.length; start += ACCOUNT_DIRECTORY_MAX_IDS) {
      const found = await this.directory.describe(
        ids.slice(start, start + ACCOUNT_DIRECTORY_MAX_IDS),
      );
      for (const account of found) names.set(account.userId, account.displayName);
    }
    return names;
  }
}
