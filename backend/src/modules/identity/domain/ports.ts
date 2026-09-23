import type { Page, PageRequest } from '../../../shared';
import type { AuthSession, AuthSessionId, RevocationReason } from './auth-session';
import type { LoginIdentifier } from './login-identifier';
import type { RoleCode } from './role';
import type { User, UserId } from './user';

/**
 * Ports the identity domain owns. Infrastructure implements them; nothing
 * above them learns whether an account lives in Postgres or in a test's memory.
 */

export type CreateUserOutcome = 'created' | 'identifier_taken';

export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  /** Batch lookup; unknown ids are absent from the result. One query, not N. */
  findManyByIds(ids: readonly UserId[]): Promise<readonly User[]>;
  findByIdentifier(identifier: LoginIdentifier): Promise<User | null>;
  /**
   * Inserts a new account. Reports a taken identifier as an outcome rather
   * than an exception: two administrators creating the same email at once is
   * an expected race, and the unique constraint is what settles it.
   */
  create(user: User): Promise<CreateUserOutcome>;
  /** Persists changes to an existing account, including role and identifier diffs. */
  save(user: User): Promise<void>;
  list(page: PageRequest): Promise<Page<User>>;
  /** True when at least one ACTIVE account holds `role`. */
  anyActiveWithRole(role: RoleCode): Promise<boolean>;
}

export interface AuthSessionRepository {
  findById(id: AuthSessionId): Promise<AuthSession | null>;
  create(session: AuthSession): Promise<void>;
  /**
   * Compare-and-swap rotation. Succeeds only if the stored current hash is
   * still `expectedHash` and the session is not revoked — so two concurrent
   * refreshes with the same token cannot both succeed.
   */
  rotate(next: AuthSession, expectedHash: string): Promise<boolean>;
  /** Records a revocation. Never un-revokes. */
  revoke(id: AuthSessionId, reason: RevocationReason, at: Date): Promise<void>;
  /** Ends every active session of a user, optionally sparing one. Returns how many ended. */
  revokeAllForUser(
    userId: UserId,
    reason: RevocationReason,
    at: Date,
    except?: AuthSessionId,
  ): Promise<number>;
  /** Unrevoked, unexpired sessions — what a user sees as "signed-in devices". */
  listActiveForUser(userId: UserId, now: Date): Promise<readonly AuthSession[]>;
}

export interface RoleDefinition {
  readonly code: RoleCode;
  readonly permissions: ReadonlySet<string>;
}

/**
 * The runtime role → permission policy. The `roles` and `role_permissions`
 * tables are its source of truth, so the institution's confirmed matrix can
 * replace the provisional one without a deploy.
 */
export interface RoleCatalog {
  list(): Promise<readonly RoleDefinition[]>;
}

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  /** Must be constant-time, and must do full work even for a malformed hash. */
  verify(plaintext: string, hash: string): Promise<boolean>;
  /** True when the hash was made with weaker parameters than today's. */
  needsRehash(hash: string): boolean;
}

export interface AccessTokenSubject {
  readonly userId: string;
  readonly sessionId: string;
}

export interface AccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

/** A token that passed every check: whose it is, which session, and until when. */
export interface VerifiedAccessToken extends AccessTokenSubject {
  /** The token's own expiry — a long-lived connection must re-authenticate before it. */
  readonly expiresAt: Date;
}

/**
 * Mints and checks access tokens. The domain states the need; infrastructure
 * picks JWT. No layer above infrastructure imports a JWT library.
 *
 * The token carries only the subject and the session — see
 * docs/architecture/authentication.md for why nothing else is in it.
 */
export interface TokenIssuer {
  issueAccessToken(subject: AccessTokenSubject): Promise<AccessToken>;
  /** The subject, or null for anything invalid, expired, or not ours. Never throws. */
  verifyAccessToken(token: string): Promise<VerifiedAccessToken | null>;
}

/**
 * Opaque high-entropy secrets (refresh tokens) and their one-way hashes.
 * Behind a port because randomness and constant-time comparison need
 * `node:crypto`, which the domain may not import.
 */
export interface SecureTokenGenerator {
  /** 32 random bytes, base64url — matches `REFRESH_SECRET_SHAPE`. */
  generateSecret(): string;
  hash(secret: string): string;
  /** Constant-time: whether `secret` hashes to `hash`. */
  matches(secret: string, hash: string): boolean;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const AUTH_SESSION_REPOSITORY = Symbol('AUTH_SESSION_REPOSITORY');
export const ROLE_CATALOG = Symbol('ROLE_CATALOG');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');
export const SECURE_TOKEN_GENERATOR = Symbol('SECURE_TOKEN_GENERATOR');
