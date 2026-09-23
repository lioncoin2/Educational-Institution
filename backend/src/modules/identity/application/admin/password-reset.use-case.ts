import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type Result,
} from '../../../../shared';
import { Permissions } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import { validateNewPassword } from '../../domain/password-policy';
import {
  AUTH_SESSION_REPOSITORY,
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type AuthSessionRepository,
  type PasswordHasher,
  type UserRepository,
} from '../../domain/ports';
import { changePasswordHash } from '../../domain/user';
import { IdentityAudit, USER_RESOURCE, auditEntry } from '../audit-actions';
import { AccountAdministration } from './account-administration';

export interface ResetPasswordCommand {
  readonly actor: Principal;
  readonly userId: string;
  readonly newPassword: string;
  readonly meta: CallMetadata;
}

/**
 * An administrator setting someone else's password — the realistic recovery
 * path in an institution where many learners have no email address.
 *
 * This is the operation the no-escalation rule exists for: resetting a
 * password is signing in as that person. So the actor must hold every
 * permission the target holds, and every one of the target's sessions ends.
 *
 * Whether the person should be made to choose a new password at next sign-in
 * is Q15.
 */
@Injectable()
export class ResetPasswordUseCase {
  constructor(
    private readonly administration: AccountAdministration,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ResetPasswordCommand): Promise<Result<void>> {
    const target = await this.administration.loadTarget(
      command.actor,
      Permissions.users.manage,
      command.userId,
    );
    if (!target.ok) return target;

    const policy = validateNewPassword(command.newPassword);
    if (!policy.ok) return policy;

    const now = this.clock.now();
    await this.users.save(
      changePasswordHash(target.value, await this.hasher.hash(command.newPassword), now),
    );
    const sessionsEnded = await this.sessions.revokeAllForUser(
      target.value.id,
      'password_reset',
      now,
    );

    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.passwordReset,
          actorUserId: command.actor.userId,
          resourceType: USER_RESOURCE,
          resourceId: target.value.id,
          at: now,
          metadata: { sessionsEnded },
        },
        command.meta,
      ),
    );
    return ok(undefined);
  }
}
