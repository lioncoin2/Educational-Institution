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
import { AUTH_SESSION_REPOSITORY, type AuthSessionRepository } from '../../domain/ports';
import { IdentityAudit, USER_RESOURCE, auditEntry } from '../audit-actions';
import { AccountAdministration } from './account-administration';

/**
 * Signs an account out everywhere — the response to a lost phone or a
 * compromised account, without changing its password or status.
 */
@Injectable()
export class RevokeUserSessionsUseCase {
  constructor(
    private readonly administration: AccountAdministration,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly actor: Principal;
    readonly userId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<{ readonly sessionsEnded: number }>> {
    const target = await this.administration.loadTarget(
      command.actor,
      Permissions.sessions.manage,
      command.userId,
    );
    if (!target.ok) return target;

    const now = this.clock.now();
    const sessionsEnded = await this.sessions.revokeAllForUser(
      target.value.id,
      'revoked_by_admin',
      now,
    );

    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.sessionRevoked,
          actorUserId: command.actor.userId,
          resourceType: USER_RESOURCE,
          resourceId: target.value.id,
          at: now,
          metadata: { reason: 'revoked_by_admin', sessionsEnded },
        },
        command.meta,
      ),
    );
    return ok({ sessionsEnded });
  }
}
