import { JwtService } from '@nestjs/jwt';

import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import type { AuditEntry, AuditLog, Clock, DomainEvent, EventPublisher } from '../../src/shared';
import { AccountAdministration } from '../../src/modules/identity/application/admin/account-administration';
import { ChangeAccountStatusUseCase } from '../../src/modules/identity/application/admin/account-status.use-case';
import { CreateUserUseCase } from '../../src/modules/identity/application/admin/create-user.use-case';
import { ResetPasswordUseCase } from '../../src/modules/identity/application/admin/password-reset.use-case';
import {
  GetUserUseCase,
  ListUsersUseCase,
} from '../../src/modules/identity/application/admin/read-users.use-cases';
import {
  AssignRoleUseCase,
  RevokeRoleUseCase,
} from '../../src/modules/identity/application/admin/role-assignment.use-cases';
import { RevokeUserSessionsUseCase } from '../../src/modules/identity/application/admin/user-sessions.use-case';
import { PolicyAuthorizationService } from '../../src/modules/identity/application/authorization.service';
import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { ChangeMyPasswordUseCase } from '../../src/modules/identity/application/change-password.use-case';
import { GetCurrentUserUseCase } from '../../src/modules/identity/application/current-user.use-case';
import type { IdentitySettings } from '../../src/modules/identity/application/identity-settings';
import { LoginUseCase } from '../../src/modules/identity/application/login.use-case';
import { RefreshSessionUseCase } from '../../src/modules/identity/application/refresh-session.use-case';
import { ResolvePrincipalUseCase } from '../../src/modules/identity/application/resolve-principal.use-case';
import { RolePermissions } from '../../src/modules/identity/application/role-permissions';
import {
  ListMySessionsUseCase,
  LogoutUseCase,
  RevokeMySessionUseCase,
} from '../../src/modules/identity/application/session-management.use-cases';
import type { SignedIn } from '../../src/modules/identity/application/views';
import type { Principal } from '../../src/modules/identity/contracts';
import {
  AccountStatuses,
  type AccountStatus,
} from '../../src/modules/identity/domain/account-status';
import { normalizeIdentifier } from '../../src/modules/identity/domain/login-identifier';
import type {
  AuthSessionRepository,
  RoleCatalog,
  UserRepository,
} from '../../src/modules/identity/domain/ports';
import { PROVISIONAL_POLICY_RULES } from '../../src/modules/identity/domain/provisional-policy';
import {
  assignRole,
  changeStatus,
  createUser,
  type User,
  type UserId,
} from '../../src/modules/identity/domain/user';
import { CryptoSecureTokenGenerator } from '../../src/modules/identity/infrastructure/crypto-secure-token-generator';
import {
  InMemoryAuthSessionRepository,
  InMemoryRoleCatalog,
  InMemoryUserRepository,
} from '../../src/modules/identity/infrastructure/in-memory-identity-store';
import { JwtTokenIssuer } from '../../src/modules/identity/infrastructure/jwt-token-issuer';
import { ScryptPasswordHasher } from '../../src/modules/identity/infrastructure/scrypt-password-hasher';

export const TEST_JWT_SECRET = 'test-only-secret-that-is-at-least-32-bytes-long';
export const START = new Date('2026-09-01T08:00:00.000Z');
const DAY = 24 * 60 * 60;

/** A clock tests can move. */
export class AdjustableClock implements Clock {
  private instant: number;

  constructor(start: Date = START) {
    this.instant = start.getTime();
  }

  now(): Date {
    return new Date(this.instant);
  }

  advance(seconds: number): void {
    this.instant += seconds * 1000;
  }
}

export class RecordingAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }

  last(action: string): AuditEntry | undefined {
    return [...this.entries].reverse().find((entry) => entry.action === action);
  }
}

export class RecordingEvents implements EventPublisher {
  readonly published: DomainEvent[] = [];

  async publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
  }
}

export interface SeedUser {
  readonly email: string;
  readonly password?: string;
  readonly roles?: readonly string[];
  readonly status?: AccountStatus;
  readonly displayName?: string;
}

/**
 * The identity application layer, wired by hand with in-memory adapters, a
 * real scrypt hasher, a real JWT issuer and a clock the test controls.
 *
 * Wiring by hand keeps unit tests fast and their dependencies explicit; the
 * API suite covers the real Nest wiring end to end.
 */
export interface HarnessAdapters {
  readonly users?: UserRepository;
  readonly sessions?: AuthSessionRepository;
  readonly catalog?: RoleCatalog;
}

export function identityHarness(
  overrides: Partial<IdentitySettings> = {},
  adapters: HarnessAdapters = {},
) {
  const clock = new AdjustableClock();
  const ids = new UuidIdGenerator();
  const users = adapters.users ?? new InMemoryUserRepository();
  const memorySessions = new InMemoryAuthSessionRepository();
  const sessions = adapters.sessions ?? memorySessions;
  const catalog = adapters.catalog ?? new InMemoryRoleCatalog();
  const hasher = new ScryptPasswordHasher();
  const secrets = new CryptoSecureTokenGenerator();
  const tokens = new JwtTokenIssuer(
    new JwtService({}),
    { secret: TEST_JWT_SECRET, issuer: 'test-api', audience: 'test-clients', ttlSeconds: 900 },
    clock,
  );
  const limiter = new InMemoryRateLimiter(clock);
  const audit = new RecordingAuditLog();
  const events = new RecordingEvents();
  const settings: IdentitySettings = {
    refreshSessionTtlSeconds: 30 * DAY,
    rolePolicyCacheSeconds: 0,
    ...overrides,
  };
  const rolePermissions = new RolePermissions(catalog, clock, settings);
  const authorization = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);
  const administration = new AccountAdministration(authorization, users, rolePermissions);

  const h = {
    clock,
    ids,
    users,
    /** In unit tests, the in-memory store (with its `all()` helper). */
    sessions: sessions as InMemoryAuthSessionRepository,
    catalog,
    hasher,
    secrets,
    tokens,
    limiter,
    audit,
    events,
    settings,
    rolePermissions,
    authorization,
    login: new LoginUseCase(
      users,
      sessions,
      hasher,
      tokens,
      secrets,
      limiter,
      audit,
      clock,
      ids,
      settings,
      rolePermissions,
    ),
    refresh: new RefreshSessionUseCase(sessions, users, tokens, secrets, audit, clock),
    logout: new LogoutUseCase(sessions, audit, clock),
    listSessions: new ListMySessionsUseCase(sessions, clock),
    revokeSession: new RevokeMySessionUseCase(sessions, audit, clock),
    currentUser: new GetCurrentUserUseCase(users),
    changePassword: new ChangeMyPasswordUseCase(users, sessions, hasher, limiter, audit, clock),
    resolvePrincipal: new ResolvePrincipalUseCase(tokens, sessions, users, clock, rolePermissions),
    createUser: new CreateUserUseCase(authorization, users, hasher, audit, events, clock, ids),
    assignRole: new AssignRoleUseCase(administration, rolePermissions, users, audit, events, clock),
    revokeRole: new RevokeRoleUseCase(administration, users, audit, events, clock),
    changeStatus: new ChangeAccountStatusUseCase(
      administration,
      users,
      sessions,
      audit,
      events,
      clock,
    ),
    resetPassword: new ResetPasswordUseCase(administration, users, sessions, hasher, audit, clock),
    revokeUserSessions: new RevokeUserSessionsUseCase(administration, sessions, audit, clock),
    listUsers: new ListUsersUseCase(authorization, users),
    getUser: new GetUserUseCase(authorization, users),
    bootstrapOwner: new BootstrapOwnerUseCase(users, hasher, audit, events, clock, ids),

    /** Puts an account straight into storage — ACTIVE by default. */
    async seedUser(seed: SeedUser): Promise<User> {
      const identifier = normalizeIdentifier('email', seed.email);
      if (!identifier.ok) throw new Error(`bad seed email ${seed.email}`);
      let user = expectOk(
        createUser({
          id: ids.next<'User'>(),
          displayName: seed.displayName ?? seed.email.split('@')[0] ?? 'user',
          identifier: identifier.value,
          passwordHash: await hasher.hash(seed.password ?? DEFAULT_PASSWORD),
          at: clock.now(),
        }),
      );
      for (const role of seed.roles ?? [])
        user = expectOk(assignRole(user, role, null, clock.now()));
      // Walk the real lifecycle — PENDING → ACTIVE → target — so a seeded
      // account can only be in a state a real one could reach.
      const status = seed.status ?? AccountStatuses.active;
      if (status !== AccountStatuses.pending) {
        user = expectOk(changeStatus(user, AccountStatuses.active, clock.now()));
        if (status !== AccountStatuses.active)
          user = expectOk(changeStatus(user, status, clock.now()));
      }
      if ((await users.create(user)) !== 'created') throw new Error(`duplicate seed ${seed.email}`);
      return user;
    },

    async signIn(email: string, password = DEFAULT_PASSWORD): Promise<SignedIn> {
      return expectOk(
        await h.login.execute({
          identifierKind: 'email',
          identifier: email,
          password,
          device: { platform: 'ios', label: 'Test device' },
          meta: { correlationId: 'test-request', ipAddress: '203.0.113.7' },
        }),
      );
    },

    /** Signs in and resolves the resulting principal the way the HTTP guard does. */
    async principalOf(email: string, password = DEFAULT_PASSWORD): Promise<Principal> {
      const signedIn = await h.signIn(email, password);
      const principal = await h.resolvePrincipal.execute(signedIn.accessToken);
      if (principal === null) throw new Error(`could not resolve principal for ${email}`);
      return principal;
    },

    async userById(id: string): Promise<User> {
      const user = await users.findById(id as UserId);
      if (user === null) throw new Error(`no user ${id}`);
      return user;
    },
  };
  return h;
}

export type IdentityHarness = ReturnType<typeof identityHarness>;

export const DEFAULT_PASSWORD = 'correct horse battery staple';
export const META = { correlationId: 'test-request', ipAddress: '203.0.113.7' } as const;

export function expectOk<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

export function expectErr(
  result: { ok: true } | { ok: false; error: { code: string; kind: string } },
): { code: string; kind: string } {
  if (result.ok) throw new Error('expected a failure, got ok');
  return result.error;
}
