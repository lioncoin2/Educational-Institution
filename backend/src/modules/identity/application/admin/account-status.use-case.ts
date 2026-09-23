import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  EVENT_PUBLISHER,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Result,
} from '../../../../shared';
import { Permissions } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import { AccountStatuses, endsSessions, type AccountStatus } from '../../domain/account-status';
import type { RevocationReason } from '../../domain/auth-session';
import { accountStatusChanged } from '../../domain/events';
import {
  AUTH_SESSION_REPOSITORY,
  USER_REPOSITORY,
  type AuthSessionRepository,
  type UserRepository,
} from '../../domain/ports';
import { changeStatus } from '../../domain/user';
import {
  IdentityAudit,
  USER_RESOURCE,
  auditEntry,
  type IdentityAuditAction,
} from '../audit-actions';
import { toUserAccountView, type UserAccountView } from '../views';
import { AccountAdministration } from './account-administration';

export interface ChangeAccountStatusCommand {
  readonly actor: Principal;
  readonly userId: string;
  readonly status: AccountStatus;
  readonly meta: CallMetadata;
}

function auditActionFor(to: AccountStatus): IdentityAuditAction {
  switch (to) {
    case AccountStatuses.active:
      return IdentityAudit.accountActivated;
    case AccountStatuses.suspended:
      return IdentityAudit.accountSuspended;
    case AccountStatuses.disabled:
      return IdentityAudit.accountDisabled;
    case AccountStatuses.pending:
      // The domain permits no transition INTO pending, so a successful change
      // can never arrive here. Failing loudly beats auditing the wrong action.
      throw new Error('No account transition leads to PENDING.');
  }
}

const SESSION_END_REASON: Partial<Record<AccountStatus, RevocationReason>> = {
  SUSPENDED: 'account_suspended',
  DISABLED: 'account_disabled',
};

/**
 * Provisioning, step three — and everything after it: activate, suspend,
 * disable, re-enable.
 *
 * Suspending or disabling ends every session the account holds, in the same
 * use case, so there is no window in which a suspended user's refresh token
 * still works.
 */
@Injectable()
export class ChangeAccountStatusUseCase {
  constructor(
    private readonly administration: AccountAdministration,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ChangeAccountStatusCommand): Promise<Result<UserAccountView>> {
    const target = await this.administration.loadTarget(
      command.actor,
      Permissions.users.manage,
      command.userId,
    );
    if (!target.ok) return target;

    const now = this.clock.now();
    const from = target.value.status;
    const updated = changeStatus(target.value, command.status, now);
    if (!updated.ok) return updated;
    await this.users.save(updated.value);

    const reason = SESSION_END_REASON[command.status];
    const sessionsEnded =
      endsSessions(command.status) && reason !== undefined
        ? await this.sessions.revokeAllForUser(target.value.id, reason, now)
        : 0;

    await this.audit.record(
      auditEntry(
        {
          action: auditActionFor(command.status),
          actorUserId: command.actor.userId,
          resourceType: USER_RESOURCE,
          resourceId: target.value.id,
          at: now,
          metadata: { from, to: command.status, sessionsEnded },
        },
        command.meta,
      ),
    );
    await this.events.publish([
      accountStatusChanged(
        target.value.id,
        from,
        command.status,
        command.actor.userId,
        now,
        command.meta.correlationId,
      ),
    ]);
    return ok(toUserAccountView(updated.value));
  }
}
