import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import type { Principal } from '../contracts/principal';
import { canAuthenticate } from '../domain/account-status';
import { isSessionActive, type AuthSessionId } from '../domain/auth-session';
import {
  AUTH_SESSION_REPOSITORY,
  TOKEN_ISSUER,
  USER_REPOSITORY,
  type AuthSessionRepository,
  type TokenIssuer,
  type UserRepository,
} from '../domain/ports';
import { roleCodes, type UserId } from '../domain/user';
import { RolePermissions } from './role-permissions';

/**
 * Turns an access token into a Principal — on every request.
 *
 * A valid signature is necessary and not sufficient. The token's session must
 * still be live and the account must still be ACTIVE, and roles are read from
 * storage rather than from the token. So:
 *
 *   logout, session revocation      → effective on the next request
 *   suspension, disabling           → effective on the next request
 *   a role revoked                  → effective on the next request
 *
 * The price is two primary-key reads per authenticated request (the role
 * matrix itself is cached). That is deliberate: a token that outlives the
 * decision to revoke it is the failure mode this exists to prevent.
 */
@Injectable()
export class ResolvePrincipalUseCase {
  constructor(
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly rolePermissions: RolePermissions,
  ) {}

  /** The principal, or null when the caller must be treated as anonymous. */
  async execute(accessToken: string): Promise<Principal | null> {
    const subject = await this.tokens.verifyAccessToken(accessToken);
    if (subject === null) return null;

    const session = await this.sessions.findById(subject.sessionId as AuthSessionId);
    if (
      session === null ||
      session.userId !== subject.userId ||
      !isSessionActive(session, this.clock.now())
    ) {
      return null;
    }

    const user = await this.users.findById(subject.userId as UserId);
    if (user === null || !canAuthenticate(user.status)) return null;

    const roles = roleCodes(user);
    return {
      userId: user.id,
      roles,
      permissions: await this.rolePermissions.permissionsFor(roles),
      sessionId: session.id,
    };
  }
}
