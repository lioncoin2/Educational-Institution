import { Inject, Injectable } from '@nestjs/common';

import { err, ok, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';
import type { Assignment } from '../domain/assignment';
import { ASSIGNMENT_NOT_FOUND } from './task-failures';

/**
 * The tasks engine's one authorization gate (ADR 0052 §10). Every use case asks
 * it again — the route guard is the outer edge, never the decision:
 *
 *   manage    publish, follow and administer tasks and reports (OWNER, ADMIN)
 *   template  templates and re-publishing (OWNER)
 *   respond   act on one's own assignment — the permission AND being its holder
 *
 * A recipient asking about someone else's assignment is told it does not exist,
 * exactly as for an id that never did: a guessed id reveals nothing.
 */
@Injectable()
export class TasksAccess {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
  ) {}

  authorizeManage(principal: Principal): Result<void> {
    return this.authorization.authorize(principal, Permissions.tasks.manage);
  }

  authorizeTemplate(principal: Principal): Result<void> {
    return this.authorization.authorize(principal, Permissions.tasks.template);
  }

  authorizeRespond(principal: Principal): Result<void> {
    return this.authorization.authorize(principal, Permissions.tasks.respond);
  }

  /** The assignment, if it exists and is the principal's own; one refusal otherwise. */
  ownAssignment(principal: Principal, assignment: Assignment | null): Result<Assignment> {
    if (assignment === null || assignment.recipientId !== principal.userId) {
      return err(ASSIGNMENT_NOT_FOUND);
    }
    return ok(assignment);
  }
}
