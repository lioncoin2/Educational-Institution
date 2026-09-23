import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type RateLimiter,
  type Result,
} from '../../../shared';
import { authenticationRejection } from '../domain/account-status';
import { openSession, sanitizeDevice } from '../domain/auth-session';
import { normalizeIdentifier, type IdentifierKind } from '../domain/login-identifier';
import {
  AUTH_SESSION_REPOSITORY,
  PASSWORD_HASHER,
  SECURE_TOKEN_GENERATOR,
  TOKEN_ISSUER,
  USER_REPOSITORY,
  type AuthSessionRepository,
  type PasswordHasher,
  type SecureTokenGenerator,
  type TokenIssuer,
  type UserRepository,
} from '../domain/ports';
import { formatRefreshToken } from '../domain/refresh-token';
import { rehashPassword, roleCodes, type User } from '../domain/user';
import { IdentityAudit, SESSION_RESOURCE, USER_RESOURCE, auditEntry } from './audit-actions';
import { IDENTITY_SETTINGS, type IdentitySettings } from './identity-settings';
import { AuthRateLimits } from './rate-limit-policies';
import { RolePermissions } from './role-permissions';
import { toCurrentUserView, type SignedIn } from './views';

export interface LoginCommand {
  readonly identifierKind: IdentifierKind;
  readonly identifier: string;
  readonly password: string;
  readonly device: {
    readonly platform?: string | null;
    readonly label?: string | null;
    readonly appVersion?: string | null;
  };
  readonly meta: CallMetadata;
}

const INVALID_CREDENTIALS = failure(
  'unauthenticated',
  'identity.invalid_credentials',
  'The identifier or password is incorrect.',
);

/**
 * Signs a person in on one device: verifies the password, opens a session,
 * and returns an access token and a refresh token for it.
 *
 * Three properties matter more than the happy path:
 *
 *  - Account enumeration is not possible. An unknown identifier and a wrong
 *    password produce the same error, and the unknown path still runs a full
 *    password hash so the two take the same time.
 *
 *  - Account state is revealed only to someone who knew the password. A
 *    suspended account's owner is told it is suspended; a guesser is told the
 *    password is wrong.
 *
 *  - Guessing is throttled per account, in the use case itself — so it holds
 *    whatever transport the attempt arrives through.
 */
@Injectable()
export class LoginUseCase {
  /** A real hash of nothing, so the unknown-user path does identical work. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    @Inject(SECURE_TOKEN_GENERATOR) private readonly secrets: SecureTokenGenerator,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    private readonly rolePermissions: RolePermissions,
  ) {}

  async execute(command: LoginCommand): Promise<Result<SignedIn>> {
    const identifier = normalizeIdentifier(command.identifierKind, command.identifier);
    if (!identifier.ok) {
      await this.burnHashWork(command.password);
      return err(INVALID_CREDENTIALS);
    }

    // The counter key is a hash, so the limiter's store never holds an address.
    const limitKey = this.secrets.hash(`${identifier.value.kind}:${identifier.value.value}`);
    const throttle = await this.limiter.consume(limitKey, AuthRateLimits.loginPerIdentifier);
    if (!throttle.allowed) {
      await this.recordFailure(null, 'rate_limited', command.meta);
      return err(
        failure(
          'rate_limited',
          'identity.too_many_attempts',
          'Too many sign-in attempts. Try again later.',
          {
            retryAfterSeconds: throttle.retryAfterSeconds,
          },
        ),
      );
    }

    const user = await this.users.findByIdentifier(identifier.value);
    if (user === null) {
      await this.burnHashWork(command.password);
      await this.recordFailure(null, 'invalid_credentials', command.meta);
      return err(INVALID_CREDENTIALS);
    }

    if (!(await this.hasher.verify(command.password, user.passwordHash))) {
      await this.recordFailure(user.id, 'invalid_credentials', command.meta);
      return err(INVALID_CREDENTIALS);
    }

    // From here on the caller has proven they know the password.
    const rejection = authenticationRejection(user.status);
    if (rejection !== null) {
      await this.recordFailure(user.id, `account_${user.status.toLowerCase()}`, command.meta);
      return err(rejection);
    }

    await this.limiter.reset(limitKey, AuthRateLimits.loginPerIdentifier);
    const account = await this.upgradeHashIfNeeded(user, command.password);
    return ok(await this.openSession(account, command));
  }

  private async openSession(user: User, command: LoginCommand): Promise<SignedIn> {
    const now = this.clock.now();
    const secret = this.secrets.generateSecret();
    const session = openSession({
      id: this.ids.next<'AuthSession'>(),
      userId: user.id,
      device: sanitizeDevice(command.device),
      refreshTokenHash: this.secrets.hash(secret),
      now,
      lifetimeSeconds: this.settings.refreshSessionTtlSeconds,
    });
    await this.sessions.create(session);

    const access = await this.tokens.issueAccessToken({ userId: user.id, sessionId: session.id });
    const permissions = await this.rolePermissions.permissionsFor(roleCodes(user));

    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.loginSucceeded,
          actorUserId: user.id,
          resourceType: SESSION_RESOURCE,
          resourceId: session.id,
          at: now,
          metadata: { platform: session.device.platform },
          includeIp: true,
        },
        command.meta,
      ),
    );

    return {
      accessToken: access.token,
      accessTokenExpiresInSeconds: access.expiresInSeconds,
      refreshToken: formatRefreshToken(session.id, secret),
      refreshTokenExpiresAt: session.expiresAt,
      sessionId: session.id,
      user: toCurrentUserView(user, permissions),
    };
  }

  /** Raising scrypt's cost later must not strand existing accounts on the old cost. */
  private async upgradeHashIfNeeded(user: User, password: string): Promise<User> {
    if (!this.hasher.needsRehash(user.passwordHash)) return user;
    const upgraded = rehashPassword(user, await this.hasher.hash(password), this.clock.now());
    await this.users.save(upgraded);
    return upgraded;
  }

  private async burnHashWork(password: string): Promise<void> {
    this.dummyHash ??= this.hasher.hash('timing-equalization');
    await this.hasher.verify(password, await this.dummyHash);
  }

  private async recordFailure(
    userId: string | null,
    reason: string,
    meta: CallMetadata,
  ): Promise<void> {
    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.loginFailed,
          actorUserId: null,
          resourceType: USER_RESOURCE,
          // Never the attempted identifier: people type passwords into the
          // username field, and whatever they type would land here verbatim.
          resourceId: userId ?? 'unknown',
          at: this.clock.now(),
          metadata: { reason },
          includeIp: true,
        },
        meta,
      ),
    );
  }
}
