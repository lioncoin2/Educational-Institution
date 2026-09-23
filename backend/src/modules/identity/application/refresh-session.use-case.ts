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
import { authenticationRejection } from '../domain/account-status';
import {
  isSessionActive,
  rotateRefreshToken,
  type AuthSession,
  type AuthSessionId,
} from '../domain/auth-session';
import {
  AUTH_SESSION_REPOSITORY,
  SECURE_TOKEN_GENERATOR,
  TOKEN_ISSUER,
  USER_REPOSITORY,
  type AuthSessionRepository,
  type SecureTokenGenerator,
  type TokenIssuer,
  type UserRepository,
} from '../domain/ports';
import { formatRefreshToken, parseRefreshToken } from '../domain/refresh-token';
import { IdentityAudit, SESSION_RESOURCE, auditEntry } from './audit-actions';
import type { IssuedTokens } from './views';

export interface RefreshSessionCommand {
  readonly refreshToken: string;
  readonly meta: CallMetadata;
}

/**
 * One answer for every way a refresh can fail. The client's response is the
 * same in all of them — sign in again — and a distinct answer per cause would
 * tell a thief which of their stolen tokens still means something.
 */
const INVALID_REFRESH = failure(
  'unauthenticated',
  'identity.refresh_token_invalid',
  'The refresh token is invalid or has expired. Sign in again.',
);

/**
 * Exchanges a refresh token for a new access token AND a new refresh token.
 *
 * Rotation with reuse detection:
 *
 *   presented == current   → issue a new pair; current becomes previous
 *   presented == previous  → the token was used twice. Only one party can have
 *                            legitimately used it; the other copied it. End the
 *                            session, which cuts off both.
 *   anything else          → reject, and change nothing
 *
 * The third case deliberately does not end the session: knowing a session id
 * is not proof of anything, and letting it end sessions would let anyone who
 * saw an id sign its owner out.
 *
 * Refreshing never extends the session's absolute expiry.
 */
@Injectable()
export class RefreshSessionUseCase {
  constructor(
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    @Inject(SECURE_TOKEN_GENERATOR) private readonly secrets: SecureTokenGenerator,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: RefreshSessionCommand): Promise<Result<IssuedTokens>> {
    const parts = parseRefreshToken(command.refreshToken);
    if (parts === null) return err(INVALID_REFRESH);

    const session = await this.sessions.findById(parts.sessionId as AuthSessionId);
    const now = this.clock.now();
    if (session === null || !isSessionActive(session, now)) return err(INVALID_REFRESH);

    if (!this.secrets.matches(parts.secret, session.refreshTokenHash)) {
      const isPrevious =
        session.previousRefreshTokenHash !== null &&
        this.secrets.matches(parts.secret, session.previousRefreshTokenHash);

      if (isPrevious) {
        await this.endForReuse(session, now, command.meta, 'replayed');
      } else {
        await this.record(IdentityAudit.refreshRejected, null, session, now, command.meta, {
          reason: 'token_mismatch',
        });
      }
      return err(INVALID_REFRESH);
    }

    const user = await this.users.findById(session.userId);
    const rejection = user === null ? INVALID_REFRESH : authenticationRejection(user.status);
    if (rejection !== null) {
      // The account was suspended or disabled after this session began.
      await this.sessions.revoke(session.id, 'account_inactive', now);
      await this.record(IdentityAudit.sessionRevoked, null, session, now, command.meta, {
        reason: 'account_inactive',
      });
      return err(rejection);
    }

    const secret = this.secrets.generateSecret();
    const next = rotateRefreshToken(session, this.secrets.hash(secret), now);
    if (!(await this.sessions.rotate(next, session.refreshTokenHash))) {
      // The swap failed: either the session was ended meanwhile (a logout in
      // the same instant) — nothing to add — or another refresh with this same
      // token got there first, so ours is now the previous token and two
      // parties held it at once. Only the second is reuse, and the audit trail
      // must not say otherwise.
      const current = await this.sessions.findById(session.id);
      if (current !== null && current.revokedAt === null) {
        await this.endForReuse(session, now, command.meta, 'concurrent');
      }
      return err(INVALID_REFRESH);
    }

    const access = await this.tokens.issueAccessToken({
      userId: session.userId,
      sessionId: session.id,
    });
    await this.record(IdentityAudit.sessionRefreshed, session.userId, next, now, command.meta, {
      generation: next.generation,
    });

    return ok({
      accessToken: access.token,
      accessTokenExpiresInSeconds: access.expiresInSeconds,
      refreshToken: formatRefreshToken(session.id, secret),
      refreshTokenExpiresAt: session.expiresAt,
      sessionId: session.id,
    });
  }

  private async endForReuse(
    session: AuthSession,
    now: Date,
    meta: CallMetadata,
    detection: 'replayed' | 'concurrent',
  ): Promise<void> {
    await this.sessions.revoke(session.id, 'refresh_token_reuse', now);
    await this.record(IdentityAudit.refreshReuseDetected, null, session, now, meta, {
      userId: session.userId,
      detection,
      generation: session.generation,
    });
  }

  private async record(
    action: (typeof IdentityAudit)[keyof typeof IdentityAudit],
    actorUserId: string | null,
    session: AuthSession,
    at: Date,
    meta: CallMetadata,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      auditEntry(
        {
          action,
          actorUserId,
          resourceType: SESSION_RESOURCE,
          resourceId: session.id,
          at,
          metadata,
          includeIp: true,
        },
        meta,
      ),
    );
  }
}
