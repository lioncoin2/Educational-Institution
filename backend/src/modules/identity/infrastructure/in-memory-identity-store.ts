import type { Page, PageRequest } from '../../../shared';
import { AccountStatuses } from '../domain/account-status';
import {
  isSessionActive,
  revokeSession,
  type AuthSession,
  type AuthSessionId,
  type RevocationReason,
} from '../domain/auth-session';
import type { LoginIdentifier } from '../domain/login-identifier';
import type {
  AuthSessionRepository,
  CreateUserOutcome,
  RoleCatalog,
  RoleDefinition,
  UserRepository,
} from '../domain/ports';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../domain/provisional-policy';
import type { RoleCode } from '../domain/role';
import type { User, UserId } from '../domain/user';

/**
 * In-memory adapters for the identity ports.
 *
 * Used by every unit test, and by the application when no database is
 * configured. They enforce the same invariants the Postgres schema does —
 * identifier uniqueness, compare-and-swap rotation, never-un-revoke — so a
 * use case cannot pass its tests here and then fail against Postgres on a
 * rule the fake forgot.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();

  constructor(seed: readonly User[] = []) {
    for (const user of seed) this.byId.set(user.id, user);
  }

  async findById(id: UserId): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdentifier(identifier: LoginIdentifier): Promise<User | null> {
    for (const user of this.byId.values()) {
      if (
        user.identifiers.some((i) => i.kind === identifier.kind && i.value === identifier.value)
      ) {
        return user;
      }
    }
    return null;
  }

  async create(user: User): Promise<CreateUserOutcome> {
    for (const identifier of user.identifiers) {
      if ((await this.findByIdentifier(identifier)) !== null) return 'identifier_taken';
    }
    this.byId.set(user.id, user);
    return 'created';
  }

  async save(user: User): Promise<void> {
    this.byId.set(user.id, user);
  }

  async list(page: PageRequest): Promise<Page<User>> {
    const all = [...this.byId.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const start = page.cursor === undefined ? 0 : all.findIndex((u) => u.id === page.cursor) + 1;
    const items = all.slice(start, start + page.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: start + page.limit < all.length && last !== undefined ? last.id : undefined,
    };
  }

  async anyActiveWithRole(role: RoleCode): Promise<boolean> {
    return [...this.byId.values()].some(
      (user) =>
        user.status === AccountStatuses.active && user.roles.some((held) => held.role === role),
    );
  }
}

export class InMemoryAuthSessionRepository implements AuthSessionRepository {
  private readonly byId = new Map<string, AuthSession>();

  async findById(id: AuthSessionId): Promise<AuthSession | null> {
    return this.byId.get(id) ?? null;
  }

  async create(session: AuthSession): Promise<void> {
    this.byId.set(session.id, session);
  }

  async rotate(next: AuthSession, expectedHash: string): Promise<boolean> {
    const stored = this.byId.get(next.id);
    if (
      stored === undefined ||
      stored.revokedAt !== null ||
      stored.refreshTokenHash !== expectedHash
    ) {
      return false;
    }
    this.byId.set(next.id, next);
    return true;
  }

  async revoke(id: AuthSessionId, reason: RevocationReason, at: Date): Promise<void> {
    const stored = this.byId.get(id);
    if (stored !== undefined) this.byId.set(id, revokeSession(stored, reason, at));
  }

  async revokeAllForUser(
    userId: UserId,
    reason: RevocationReason,
    at: Date,
    except?: AuthSessionId,
  ): Promise<number> {
    let ended = 0;
    for (const session of this.byId.values()) {
      if (session.userId !== userId || session.id === except || !isSessionActive(session, at))
        continue;
      this.byId.set(session.id, revokeSession(session, reason, at));
      ended += 1;
    }
    return ended;
  }

  async listActiveForUser(userId: UserId, now: Date): Promise<readonly AuthSession[]> {
    return [...this.byId.values()]
      .filter((session) => session.userId === userId && isSessionActive(session, now))
      .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
  }

  /** Test helper: every session, including revoked ones. */
  all(): readonly AuthSession[] {
    return [...this.byId.values()];
  }
}

/** The provisional matrix, served from memory — the same data migration 0002 seeds. */
export class InMemoryRoleCatalog implements RoleCatalog {
  constructor(
    private readonly matrix: Readonly<
      Record<string, readonly string[]>
    > = PROVISIONAL_ROLE_PERMISSIONS,
  ) {}

  async list(): Promise<readonly RoleDefinition[]> {
    return Object.entries(this.matrix).map(([code, permissions]) => ({
      code,
      permissions: new Set(permissions),
    }));
  }
}
