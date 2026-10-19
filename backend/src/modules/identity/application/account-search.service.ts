import { Inject, Injectable } from '@nestjs/common';

import { clampLimit, type Page, type PageRequest } from '../../../shared';
import type { AccountSummary } from '../contracts/account-directory';
import { ELIGIBLE_TEACHER, type AccountSearch } from '../contracts/account-search';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';

/**
 * Identity's implementation of the account search other modules consult.
 *
 * It reads only ACTIVE accounts by display-name prefix (the repository escapes
 * LIKE metacharacters and treats a blank query as empty), clamps the page size
 * to the shared ceiling, and maps each account to the same minimal
 * {userId, displayName, avatarFileAssetId, active} shape as the directory — so a
 * searchable account discloses nothing a batch lookup would not (the avatar is a
 * Files asset id, not the bytes). Who may search is decided above this service
 * (People's `people.read` gate); this only finds.
 */
@Injectable()
export class IdentityAccountSearch implements AccountSearch {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async search(query: string, page: PageRequest): Promise<Page<AccountSummary>> {
    return this.summarize(await this.users.searchActiveByDisplayName(query, this.page(page)));
  }

  async searchTeachers(query: string, page: PageRequest): Promise<Page<AccountSummary>> {
    return this.summarize(
      await this.users.searchActiveTeachersByDisplayName(query, this.page(page), ELIGIBLE_TEACHER),
    );
  }

  private page(page: PageRequest): PageRequest {
    return {
      limit: clampLimit(page.limit),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    };
  }

  private summarize(
    found: Page<{ id: string; displayName: string; avatarFileAssetId: string | null }>,
  ): Page<AccountSummary> {
    return {
      items: found.items.map((user) => ({
        userId: user.id,
        displayName: user.displayName,
        // The same picture reference the directory returns — a Files asset id,
        // never a URL; a consumer turns it into a short-lived link through its
        // own authorized route (People's `GET /people/:userId/avatar`), so a
        // searchable account discloses the reference but not the bytes. Every
        // row this service returns is ACTIVE by construction.
        avatarFileAssetId: user.avatarFileAssetId,
        active: true,
      })),
      ...(found.nextCursor === undefined ? {} : { nextCursor: found.nextCursor }),
    };
  }
}
