import type {
  CurrentUserView,
  IssuedTokens,
  SessionView,
  SignedIn,
  UserAccountView,
} from '../application/views';

/**
 * The public response shapes of identity's API — the contract clients build
 * against, including the Flutter AuthRepository.
 *
 * Every mapper below picks fields by name. A field added to an application
 * view does not appear on the wire until someone adds it here, on purpose:
 * that is the step at which "should a client see this?" gets asked.
 */

export interface CurrentUserResponse {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface TokenResponse {
  readonly tokenType: 'Bearer';
  readonly accessToken: string;
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly sessionId: string;
}

export interface LoginResponse extends TokenResponse {
  readonly user: CurrentUserResponse;
}

export interface SessionResponse {
  readonly id: string;
  readonly device: {
    readonly platform: string;
    readonly label: string | null;
    readonly appVersion: string | null;
  };
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
}

export interface UserAccountResponse {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly identifiers: readonly { readonly type: string; readonly value: string }[];
  readonly roles: readonly {
    readonly code: string;
    readonly grantedAt: string;
    readonly grantedBy: string | null;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCurrentUserResponse(view: CurrentUserView): CurrentUserResponse {
  return {
    id: view.id,
    displayName: view.displayName,
    status: view.status,
    roles: view.roles,
    permissions: view.permissions,
  };
}

export function toTokenResponse(tokens: IssuedTokens): TokenResponse {
  return {
    tokenType: 'Bearer',
    accessToken: tokens.accessToken,
    expiresIn: tokens.accessTokenExpiresInSeconds,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    sessionId: tokens.sessionId,
  };
}

export function toLoginResponse(signedIn: SignedIn): LoginResponse {
  return { ...toTokenResponse(signedIn), user: toCurrentUserResponse(signedIn.user) };
}

export function toSessionResponse(view: SessionView): SessionResponse {
  return {
    id: view.id,
    device: {
      platform: view.device.platform,
      label: view.device.label,
      appVersion: view.device.appVersion,
    },
    createdAt: view.createdAt.toISOString(),
    lastUsedAt: view.lastUsedAt.toISOString(),
    expiresAt: view.expiresAt.toISOString(),
    current: view.current,
  };
}

export function toUserAccountResponse(view: UserAccountView): UserAccountResponse {
  return {
    id: view.id,
    displayName: view.displayName,
    status: view.status,
    identifiers: view.identifiers.map(({ kind, value }) => ({ type: kind, value })),
    roles: view.roles.map(({ code, grantedAt, grantedBy }) => ({
      code,
      grantedAt: grantedAt.toISOString(),
      grantedBy,
    })),
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}
