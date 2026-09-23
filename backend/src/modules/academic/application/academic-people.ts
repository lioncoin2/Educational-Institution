import { Inject, Injectable } from '@nestjs/common';

import {
  ACCOUNT_DIRECTORY,
  ACCOUNT_DIRECTORY_MAX_IDS,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import type { PersonView } from './views';

/**
 * People, as academic shows them — asked of identity's account directory, a
 * whole page of ids in one call (never one lookup per row), and never
 * copied into academic's tables.
 */
@Injectable()
export class AcademicPeople {
  constructor(@Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory) {}

  async describe(userIds: readonly string[]): Promise<ReadonlyMap<string, PersonView>> {
    const unique = [...new Set(userIds)];
    const people = new Map<string, PersonView>();
    for (let start = 0; start < unique.length; start += ACCOUNT_DIRECTORY_MAX_IDS) {
      const chunk = unique.slice(start, start + ACCOUNT_DIRECTORY_MAX_IDS);
      for (const summary of await this.directory.describe(chunk)) {
        people.set(summary.userId, {
          userId: summary.userId,
          displayName: summary.displayName,
          active: summary.active,
        });
      }
    }
    // An id identity no longer knows still gets a row: the record stays
    // readable, and the gap shows rather than being papered over.
    for (const userId of unique) {
      if (!people.has(userId)) people.set(userId, { userId, displayName: null, active: false });
    }
    return people;
  }

  /** The subset of `userIds` identity says are ACTIVE and hold `permission`. */
  eligible(
    userIds: readonly string[],
    permission: Parameters<AccountDirectory['withPermission']>[1],
  ): Promise<ReadonlySet<string>> {
    return this.directory.withPermission(userIds, permission);
  }
}
