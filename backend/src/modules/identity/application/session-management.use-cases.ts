import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type Result,
} from '../../../shared';
import type { Principal } from '../contracts/principal';
import { isSessionActive, type AuthSessionId } from '../domain/auth-session';
import { AUTH_SESSION_REPOSITORY, type AuthSessionRepository } from '../domain/ports';
import type { UserId } from '../domain/user';
import { IdentityAudit, SESSION_RESOURCE, auditEntry } from './audit-actions';
import { toSessionView, type SessionView } from './views';

const NO_SESSION = failure(
  'precondition_failed',
  'identity.no_session',
  'This caller is not acting through a session.',
);

/**
 * A person managing their OWN sessions: sign out here, see where they are
 * signed in, sign a lost device out.
 *
 * None of these need a grantable permission — they are inherent to having an
 * account — but every one of them is scoped to the principal's own user id, in
 * the use case, so the same code is safe whatever calls it.
 */
@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const sessionId = command.principal.sessionId;
    if (sessionId === undefined) return err(NO_SESSION);

    const now = this.clock.now();
    await this.sessions.revoke(sessionId as AuthSessionId, 'logout', now);
    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.logout,
          actorUserId: command.principal.userId,
          resourceType: SESSION_RESOURCE,
          resourceId: sessionId,
          at: now,
        },
        command.meta,
      ),
    );
    return ok(undefined);
  }
}

@Injectable()
export class ListMySessionsUseCase {
  constructor(
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
  }): Promise<Result<readonly SessionView[]>> {
    const active = await this.sessions.listActiveForUser(
      command.principal.userId as UserId,
      this.clock.now(),
    );
    return ok(active.map((session) => toSessionView(session, command.principal.sessionId)));
  }
}

@Injectable()
export class RevokeMySessionUseCase {
  constructor(
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const now = this.clock.now();
    const session = await this.sessions.findById(command.sessionId as AuthSessionId);

    // Someone else's session is reported exactly like a missing one, so this
    // endpoint cannot be used to learn which session ids exist.
    if (
      session === null ||
      session.userId !== command.principal.userId ||
      !isSessionActive(session, now)
    ) {
      return err(failure('not_found', 'identity.session_not_found', 'No such session.'));
    }

    const isCurrent = session.id === command.principal.sessionId;
    await this.sessions.revoke(session.id, isCurrent ? 'logout' : 'revoked_by_user', now);
    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.sessionRevoked,
          actorUserId: command.principal.userId,
          resourceType: SESSION_RESOURCE,
          resourceId: session.id,
          at: now,
          metadata: { reason: isCurrent ? 'logout' : 'revoked_by_user' },
        },
        command.meta,
      ),
    );
    return ok(undefined);
  }
}
