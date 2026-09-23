import type { AccountStatus } from '../domain/account-status';
import type { AuthSession, DeviceInfo } from '../domain/auth-session';
import type { IdentifierKind } from '../domain/login-identifier';
import { roleCodes, type User } from '../domain/user';

/**
 * Application-level read models.
 *
 * These are what use cases return — never a domain User, which carries a
 * password hash. Every field here was chosen to be safe to hand to the caller
 * who asked for it; the API layer then maps these to its own response types.
 */

export interface CurrentUserView {
  readonly id: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface SessionView {
  readonly id: string;
  readonly device: DeviceInfo;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  /** True for the session the request itself was made with. */
  readonly current: boolean;
}

export interface UserAccountView {
  readonly id: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly identifiers: readonly { readonly kind: IdentifierKind; readonly value: string }[];
  readonly roles: readonly {
    readonly code: string;
    readonly grantedAt: Date;
    readonly grantedBy: string | null;
  }[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Tokens handed to a client at sign-in or refresh — and only then. */
export interface IssuedTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresInSeconds: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
}

export interface SignedIn extends IssuedTokens {
  readonly user: CurrentUserView;
}

export function toCurrentUserView(user: User, permissions: ReadonlySet<string>): CurrentUserView {
  return {
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    roles: [...roleCodes(user)].sort(),
    permissions: [...permissions].sort(),
  };
}

export function toSessionView(session: AuthSession, currentSessionId?: string): SessionView {
  return {
    id: session.id,
    device: session.device,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    current: session.id === currentSessionId,
  };
}

export function toUserAccountView(user: User): UserAccountView {
  return {
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    identifiers: user.identifiers.map(({ kind, value }) => ({ kind, value })),
    roles: user.roles.map(({ role, grantedAt, grantedBy }) => ({
      code: role,
      grantedAt,
      grantedBy,
    })),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
