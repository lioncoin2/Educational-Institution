import type { User, UserId } from './user';

/**
 * Ports the identity domain owns. Infrastructure implements them; the domain
 * never learns whether a user lives in Postgres, an LDAP directory or a test
 * double.
 */
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<void>;
}

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  /** Must be constant-time. */
  verify(plaintext: string, hash: string): Promise<boolean>;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/** Mints access tokens. The domain states the need; infrastructure picks JWT. */
export interface AccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

export interface TokenIssuer {
  issue(userId: string, roles: readonly string[]): Promise<AccessToken>;
}

export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');
