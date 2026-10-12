import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions, RequirePermission } from '../../identity/contracts';
import { SearchPeopleUseCase } from '../application/search-people.use-case';
import { SearchTeachersUseCase } from '../application/search-teachers.use-case';
import { SearchPeopleQuery } from './dto/search-people.dto';
import { toPeopleSearchResponse } from './responses';

/**
 * /people — the human record behind a login (Owner Decision A1/A4, and Q6 for
 * the teacher directory; the discovery/membership/attendance separation is
 * ADR 0032).
 *
 * Two display-name searches, each its own gate; both answer the same minimal
 * {userId, displayName} — never an email, a role or any security state — and
 * each use case re-asks its permission, so a caller that is not an HTTP request
 * (a job, an event handler) is exactly as safe:
 *
 *   GET /people          `people.read` (OWNER/ADMIN only — not a teacher,
 *                         supervisor or student, since migration 0020): the
 *                         institution-wide membership-management directory.
 *                         Community add-member discovery is the community-scoped
 *                         `GET /communities/:id/member-candidates` instead
 *                         (gated per community on `community.members.invite`);
 *                         finding an account is not adding it (ADR 0032).
 *   GET /people/teachers `messaging.start_direct_teacher` (a student): ELIGIBLE
 *                         TEACHERS ONLY, to find one to message (Q6). It is a
 *                         teacher directory, not a general people search — a
 *                         student cannot enumerate students, admins or the owner.
 *
 * A store that cannot be reached answers 503 (the interceptor), never a result
 * computed without it.
 */
@Controller('people')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class PeopleController {
  constructor(
    private readonly searchPeople: SearchPeopleUseCase,
    private readonly searchTeachers: SearchTeachersUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.people.read)
  async search(@CurrentPrincipal() principal: Principal, @Query() query: SearchPeopleQuery) {
    const page = unwrap(
      await this.searchPeople.execute({
        principal,
        query: query.q,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    );
    return toPeopleSearchResponse(page);
  }

  @Get('teachers')
  @RequirePermission(Permissions.messaging.startDirectTeacher)
  async teachers(@CurrentPrincipal() principal: Principal, @Query() query: SearchPeopleQuery) {
    const page = unwrap(
      await this.searchTeachers.execute({
        principal,
        query: query.q,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    );
    return toPeopleSearchResponse(page);
  }
}
