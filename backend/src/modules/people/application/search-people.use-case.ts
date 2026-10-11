import { Inject, Injectable } from '@nestjs/common';

import { DEFAULT_PAGE_LIMIT, ok, type Page, type Principal, type Result } from '../../../shared';
import {
  ACCOUNT_SEARCH,
  type AccountSearch,
  type AccountSummary,
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
  Permissions,
} from '../../identity/contracts';

/**
 * Finds people by display-name prefix, for a staff member who may read the
 * human record (`people.read`) — adding a member, or starting a conversation
 * with someone whose id they do not already hold.
 *
 * The right to search is decided HERE and re-checked even when an HTTP guard
 * already ran (a use case may be called by a job or an event handler, which do
 * not pass a guard). What is returned is identity's minimal
 * {userId, displayName, active} — never an email, a role or any security state;
 * the controller narrows it further to {userId, displayName} on the wire.
 */
@Injectable()
export class SearchPeopleUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(ACCOUNT_SEARCH) private readonly accounts: AccountSearch,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly query: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<Page<AccountSummary>>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.people.read);
    if (!allowed.ok) return allowed;
    const page = await this.accounts.search(command.query, {
      limit: command.limit ?? DEFAULT_PAGE_LIMIT,
      ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
    });
    return ok(page);
  }
}
