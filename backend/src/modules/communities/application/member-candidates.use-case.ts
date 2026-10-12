import { Inject, Injectable } from '@nestjs/common';

import { DEFAULT_PAGE_LIMIT, ok, type Page, type Principal, type Result } from '../../../shared';
// Specific contract files, not the identity barrel: the barrel re-exports HTTP
// route decorators, which the communities application layer must not depend on
// (communities-boundaries.spec). This mirrors community-authorization.service.
import { type AccountSummary } from '../../identity/contracts/account-directory';
import { ACCOUNT_SEARCH, type AccountSearch } from '../../identity/contracts/account-search';
import { CommunityAuthorizationService } from './community-authorization.service';

/**
 * Finds people to add to ONE community by display-name prefix — the
 * community-scoped counterpart of `GET /people` (Sprint 24, approved Design X).
 *
 * The right to search is `community.members.invite` IN THIS community, decided
 * HERE through the one community authorizer (so the ceiling, the read and the
 * decision are exactly those of the add-member mutation — a teacher who owns or
 * is delegated invitation authority may search; anyone else, including an
 * oversight-only admin, is refused). It is re-checked even when an HTTP guard
 * already ran. Discovery is NOT authorization to add: `AddMembersUseCase` still
 * re-authorizes `community.members.invite` on the mutation.
 *
 * The data comes from identity's `ACCOUNT_SEARCH` — the same relationship-blind,
 * ACTIVE-only, keyset-paged account search `GET /people` uses — and the wire
 * projection stays the minimal {userId, displayName}. Nothing is read from
 * academic, enrollment or roles; searching mutates nothing and emits no event.
 */
@Injectable()
export class SearchMemberCandidatesUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(ACCOUNT_SEARCH) private readonly accounts: AccountSearch,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly query: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<Page<AccountSummary>>> {
    const permit = await this.authorization.authorize(
      command.principal,
      command.communityId,
      'community.members.invite',
    );
    if (!permit.ok) return permit;

    const page = await this.accounts.search(command.query, {
      limit: command.limit ?? DEFAULT_PAGE_LIMIT,
      ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
    });
    return ok(page);
  }
}
