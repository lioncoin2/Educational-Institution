import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions, type Permission } from '../../identity/contracts/permissions';
import { isSystemPrincipal } from '../../identity/contracts/principal';
import { ACADEMIC_REPOSITORY, type AcademicRepository, type Placement } from '../domain/ports';
import { AcademicResources } from './academic-settings';

export const HALAQA_NOT_FOUND = failure(
  'not_found',
  'academic.halaqa_not_found',
  'No such halaqa.',
);

const HALAQA_ACCESS_DENIED = failure(
  'forbidden',
  'academic.halaqa_access_denied',
  "Only this halaqa's teachers and academic administrators may see who is in it.",
);

/**
 * Academic's authorization, in one place: identity decides what a PERMISSION
 * allows; academic's own records decide which halaqat a teacher's
 * permission reaches.
 *
 *   the catalogue                 academic.read — every role
 *   one's own record              academic.read — the caller's id, never a parameter
 *   who is in a halaqa            academic.manage (any halaqa), or
 *                                 academic.teach AND an ACTIVE assignment to THAT halaqa
 *   changing anything             academic.manage
 *
 * Nobody else sees another person's academic record: not a student (another
 * student's enrollment), not a teacher outside their halaqat, not a
 * supervisor (Q31) — whatever else their role allows.
 */
@Injectable()
export class AcademicAccess {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
  ) {}

  authorize(
    principal: Principal,
    permission: Permission,
    resource?: { readonly type: string; readonly id: string },
  ): Result<void> {
    return this.authorization.authorize(
      principal,
      permission,
      resource === undefined ? undefined : { resourceType: resource.type, resourceId: resource.id },
    );
  }

  can(principal: Principal, permission: Permission): boolean {
    return this.authorization.can(principal, permission);
  }

  /**
   * May the principal see who is in this halaqa — its students and teachers?
   * The halaqa itself is catalogue data, so a missing one is `not_found` and
   * someone else's is `forbidden`: nothing about it is being hidden.
   */
  async halaqaMembers(principal: Principal, halaqaId: string): Promise<Result<Placement>> {
    const reads = this.authorize(principal, Permissions.academic.read, {
      type: AcademicResources.halaqa,
      id: halaqaId,
    });
    if (!reads.ok) return reads;
    const placement = await this.repository.placement(halaqaId);
    if (placement === null) return err(HALAQA_NOT_FOUND);
    if (this.can(principal, Permissions.academic.manage)) return ok(placement);
    if (
      this.can(principal, Permissions.academic.teach) &&
      (await this.repository.isTeaching(principal.userId, halaqaId))
    ) {
      return ok(placement);
    }
    return err(HALAQA_ACCESS_DENIED);
  }

  /** Who to record as having acted: a person's id, or null for a system job. */
  actorOf(principal: Principal): string | null {
    return isSystemPrincipal(principal) ? null : principal.userId;
  }
}
