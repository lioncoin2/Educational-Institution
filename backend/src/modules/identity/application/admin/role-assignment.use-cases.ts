import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  EVENT_PUBLISHER,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Result,
} from '../../../../shared';
import { Permissions } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import { canGrantRole } from '../../domain/administration';
import { roleAssigned, roleRevoked } from '../../domain/events';
import { USER_REPOSITORY, type UserRepository } from '../../domain/ports';
import { assignRole, revokeRole } from '../../domain/user';
import { IdentityAudit, USER_RESOURCE, auditEntry } from '../audit-actions';
import { RolePermissions } from '../role-permissions';
import { toUserAccountView, type UserAccountView } from '../views';
import { AccountAdministration } from './account-administration';

export interface RoleChangeCommand {
  readonly actor: Principal;
  readonly userId: string;
  readonly role: string;
  readonly meta: CallMetadata;
}

/**
 * Provisioning, step two: give an account a role.
 *
 * The role must exist in the runtime catalogue, and the actor must already hold
 * every permission it carries. Without that second check, anyone able to
 * assign roles could grant OWNER to an account they control.
 */
@Injectable()
export class AssignRoleUseCase {
  constructor(
    private readonly administration: AccountAdministration,
    private readonly rolePermissions: RolePermissions,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: RoleChangeCommand): Promise<Result<UserAccountView>> {
    const target = await this.administration.loadTarget(
      command.actor,
      Permissions.roles.assign,
      command.userId,
    );
    if (!target.ok) return target;

    const role = await this.rolePermissions.definition(command.role);
    if (role === null) {
      return err(
        failure('validation', 'identity.role_unknown', `There is no role ${command.role}.`),
      );
    }
    if (!canGrantRole(command.actor.permissions, role.permissions)) {
      return err(
        failure(
          'forbidden',
          'identity.role_outranks_actor',
          'This role carries permissions you do not hold, so you cannot grant it.',
        ),
      );
    }

    const now = this.clock.now();
    const updated = assignRole(target.value, role.code, command.actor.userId, now);
    if (!updated.ok) return updated;
    await this.users.save(updated.value);

    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.roleAssigned,
          actorUserId: command.actor.userId,
          resourceType: USER_RESOURCE,
          resourceId: target.value.id,
          at: now,
          metadata: { role: role.code },
        },
        command.meta,
      ),
    );
    await this.events.publish([
      roleAssigned(
        target.value.id,
        role.code,
        command.actor.userId,
        now,
        command.meta.correlationId,
      ),
    ]);
    return ok(toUserAccountView(updated.value));
  }
}

/**
 * Takes a role away. Effective on the target's very next request: roles are
 * read from storage on every request, never from the token.
 */
@Injectable()
export class RevokeRoleUseCase {
  constructor(
    private readonly administration: AccountAdministration,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: RoleChangeCommand): Promise<Result<UserAccountView>> {
    const target = await this.administration.loadTarget(
      command.actor,
      Permissions.roles.assign,
      command.userId,
    );
    if (!target.ok) return target;

    const now = this.clock.now();
    const updated = revokeRole(target.value, command.role, now);
    if (!updated.ok) return updated;
    await this.users.save(updated.value);

    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.roleRevoked,
          actorUserId: command.actor.userId,
          resourceType: USER_RESOURCE,
          resourceId: target.value.id,
          at: now,
          metadata: { role: command.role },
        },
        command.meta,
      ),
    );
    await this.events.publish([
      roleRevoked(
        target.value.id,
        command.role,
        command.actor.userId,
        now,
        command.meta.correlationId,
      ),
    ]);
    return ok(toUserAccountView(updated.value));
  }
}
