import { Inject, Injectable } from '@nestjs/common';

import {
  ACCOUNT_DIRECTORY,
  ACCOUNT_DIRECTORY_MAX_IDS,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import type { Permission } from '../../identity/contracts/permissions';

export interface PersonView {
  readonly userId: string;
  /** Null when identity no longer knows the account: the gap shows, rather than being papered over. */
  readonly displayName: string | null;
  /** Whether the ACCOUNT can sign in — not whether the membership is active. */
  readonly active: boolean;
}

/**
 * People, as Communities shows them — asked of identity's account directory
 * a whole page of ids at a time (never one lookup per row), and never copied
 * into Communities' tables. Never an email.
 */
@Injectable()
export class CommunityPeople {
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
    for (const userId of unique) {
      if (!people.has(userId)) people.set(userId, { userId, displayName: null, active: false });
    }
    return people;
  }

  /** The subset of `userIds` identity says are ACTIVE and hold `permission`. */
  async eligible(userIds: readonly string[], permission: Permission): Promise<ReadonlySet<string>> {
    const unique = [...new Set(userIds)];
    const eligible = new Set<string>();
    for (let start = 0; start < unique.length; start += ACCOUNT_DIRECTORY_MAX_IDS) {
      const chunk = unique.slice(start, start + ACCOUNT_DIRECTORY_MAX_IDS);
      for (const userId of await this.directory.withPermission(chunk, permission)) {
        eligible.add(userId);
      }
    }
    return eligible;
  }
}
