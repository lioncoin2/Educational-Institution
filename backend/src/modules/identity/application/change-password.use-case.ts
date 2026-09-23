import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type RateLimiter,
  type Result,
} from '../../../shared';
import type { Principal } from '../contracts/principal';
import type { AuthSessionId } from '../domain/auth-session';
import { validateNewPassword } from '../domain/password-policy';
import {
  AUTH_SESSION_REPOSITORY,
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type AuthSessionRepository,
  type PasswordHasher,
  type UserRepository,
} from '../domain/ports';
import { changePasswordHash, type UserId } from '../domain/user';
import { IdentityAudit, USER_RESOURCE, auditEntry } from './audit-actions';
import { AuthRateLimits } from './rate-limit-policies';

export interface ChangeMyPasswordCommand {
  readonly principal: Principal;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly meta: CallMetadata;
}

/**
 * A person changing their own password.
 *
 * Requires the current password even though the caller is already signed in:
 * a borrowed, unlocked phone must not be enough to take over the account.
 *
 * Every OTHER session ends. If the password is being changed because someone
 * else knows it, the devices they signed in on must stop working now — while
 * the device the owner is holding stays signed in.
 */
@Injectable()
export class ChangeMyPasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ChangeMyPasswordCommand): Promise<Result<void>> {
    const userId = command.principal.userId as UserId;

    // Otherwise a stolen access token is an unthrottled oracle for the password.
    const throttle = await this.limiter.consume(userId, AuthRateLimits.passwordPerUser);
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'identity.too_many_attempts',
          'Too many attempts. Try again later.',
          {
            retryAfterSeconds: throttle.retryAfterSeconds,
          },
        ),
      );
    }

    const user = await this.users.findById(userId);
    if (user === null) {
      return err(failure('not_found', 'identity.user_not_found', 'No such account.'));
    }

    if (!(await this.hasher.verify(command.currentPassword, user.passwordHash))) {
      return err(
        failure(
          'validation',
          'identity.current_password_incorrect',
          'The current password is incorrect.',
        ),
      );
    }

    const policy = validateNewPassword(command.newPassword);
    if (!policy.ok) return policy;
    if (command.newPassword === command.currentPassword) {
      return err(
        failure(
          'validation',
          'identity.password_unchanged',
          'The new password must differ from the current one.',
        ),
      );
    }

    const now = this.clock.now();
    await this.users.save(
      changePasswordHash(user, await this.hasher.hash(command.newPassword), now),
    );
    const ended = await this.sessions.revokeAllForUser(
      userId,
      'password_changed',
      now,
      command.principal.sessionId as AuthSessionId | undefined,
    );
    await this.limiter.reset(userId, AuthRateLimits.passwordPerUser);

    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.passwordChanged,
          actorUserId: userId,
          resourceType: USER_RESOURCE,
          resourceId: userId,
          at: now,
          metadata: { otherSessionsEnded: ended },
          includeIp: true,
        },
        command.meta,
      ),
    );
    return ok(undefined);
  }
}
