import { Controller, Get, Query } from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  GetMyAcademicUseCase,
  ListMyEnrollmentsUseCase,
  ListMyTeachingUseCase,
} from '../application/my-academic.use-cases';
import { PageQuery } from './dto/academic.dto';
import {
  toMyAcademicResponse,
  toPageResponse,
  toPlacedAssignmentResponse,
  toPlacedEnrollmentResponse,
} from './responses';

/**
 * The caller's own academic record. No route here takes a person's id: what
 * is returned is always the principal's own, so nobody can ask for anyone
 * else's through it.
 */
@Controller('academic/me')
export class MyAcademicController {
  constructor(
    private readonly mine: GetMyAcademicUseCase,
    private readonly myEnrollments: ListMyEnrollmentsUseCase,
    private readonly myTeaching: ListMyTeachingUseCase,
  ) {}

  /** What I study and what I teach, now. */
  @Get()
  @RequirePermission(Permissions.academic.read)
  async me(@CurrentPrincipal() principal: Principal) {
    return toMyAcademicResponse(unwrap(await this.mine.execute({ principal })));
  }

  /** My enrollments, every status, newest first. */
  @Get('enrollments')
  @RequirePermission(Permissions.academic.read)
  async enrollments(@CurrentPrincipal() principal: Principal, @Query() query: PageQuery) {
    return toPageResponse(
      unwrap(
        await this.myEnrollments.execute({ principal, cursor: query.cursor, limit: query.limit }),
      ),
      toPlacedEnrollmentResponse,
    );
  }

  /** My teaching assignments, every status, newest first. */
  @Get('teaching')
  @RequirePermission(Permissions.academic.read)
  async teaching(@CurrentPrincipal() principal: Principal, @Query() query: PageQuery) {
    return toPageResponse(
      unwrap(
        await this.myTeaching.execute({ principal, cursor: query.cursor, limit: query.limit }),
      ),
      toPlacedAssignmentResponse,
    );
  }
}
