import { Inject, Injectable } from '@nestjs/common';

import type { Principal, Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';

/**
 * Operations' one authorization question: may this principal manage the
 * schedule? Every scheduling use case re-asks it through the identity
 * authorization port — the HTTP guard is a convenience, never the boundary, so
 * a use case invoked by a job or a test is exactly as safe.
 */
@Injectable()
export class OperationsAccess {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
  ) {}

  authorizeScheduleManage(principal: Principal): Result<void> {
    return this.authorization.authorize(principal, Permissions.operations.scheduleManage);
  }
}
