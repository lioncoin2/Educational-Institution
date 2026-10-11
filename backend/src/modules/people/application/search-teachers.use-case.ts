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
 * Finds eligible TEACHERS by display-name prefix, for a student who may message
 * them (`messaging.start_direct_teacher`, Q6). It is the student-facing
 * counterpart of [SearchPeopleUseCase]: that one needs `people.read` (staff) and
 * returns anyone; this one needs only the teacher-messaging capability and
 * returns ONLY eligible teachers (identity's `searchTeachers`, see
 * `ELIGIBLE_TEACHER`) — never a student, an administrator or the owner. So a
 * student gains a teacher directory, not a general people search.
 *
 * The right to search is decided HERE and re-checked even when an HTTP guard
 * already ran. The projection is identity's minimal {userId, displayName, active};
 * the controller narrows it to {userId, displayName} on the wire.
 */
@Injectable()
export class SearchTeachersUseCase {
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
    const allowed = this.authorization.authorize(
      command.principal,
      Permissions.messaging.startDirectTeacher,
    );
    if (!allowed.ok) return allowed;
    const page = await this.accounts.searchTeachers(command.query, {
      limit: command.limit ?? DEFAULT_PAGE_LIMIT,
      ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
    });
    return ok(page);
  }
}
