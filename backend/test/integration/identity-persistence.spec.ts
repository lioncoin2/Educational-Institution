import { and, eq, sql } from 'drizzle-orm';

import { auditLog } from '../../src/platform/audit/schema';
import { DrizzleAuditLog } from '../../src/platform/audit/drizzle-audit-log';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { asId } from '../../src/shared';
import { ALL_PERMISSIONS } from '../../src/modules/identity/contracts/permissions';
import { openSession, type AuthSession } from '../../src/modules/identity/domain/auth-session';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../src/modules/identity/domain/provisional-policy';
import { ACTIVE_ROLES } from '../../src/modules/identity/domain/role';
import {
  assignRole,
  changeStatus,
  createUser,
  type User,
} from '../../src/modules/identity/domain/user';
import { DrizzleAuthSessionRepository } from '../../src/modules/identity/infrastructure/drizzle-auth-session-repository';
import { DrizzleRoleCatalog } from '../../src/modules/identity/infrastructure/drizzle-role-catalog';
import { DrizzleUserRepository } from '../../src/modules/identity/infrastructure/drizzle-user-repository';
import {
  authSessions,
  permissions,
  rolePermissions,
  roles,
  userIdentifiers,
  userRoles,
  users,
} from '../../src/modules/identity/infrastructure/schema';
import { META, expectErr, expectOk, identityHarness } from '../support/identity-harness';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

const AT = new Date('2026-09-01T08:00:00.000Z');
const ids = new UuidIdGenerator();

function account(email: string, extra: { roles?: string[]; status?: 'ACTIVE' } = {}): User {
  let user = expectOk(
    createUser({
      id: ids.next<'User'>(),
      displayName: email,
      identifier: { kind: 'email', value: email },
      passwordHash: '$scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      at: AT,
    }),
  );
  for (const role of extra.roles ?? []) user = expectOk(assignRole(user, role, null, AT));
  if (extra.status === 'ACTIVE') user = expectOk(changeStatus(user, 'ACTIVE', AT));
  return user;
}

function session(userId: string, overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    ...openSession({
      id: ids.next<'AuthSession'>(),
      userId: asId<'User'>(userId),
      device: { platform: 'web', label: 'Browser', appVersion: null },
      refreshTokenHash: 'hash-0',
      now: AT,
      lifetimeSeconds: 3600,
    }),
    ...overrides,
  };
}

describeWithPostgres('identity persistence (PostgreSQL, committed migrations)', () => {
  let scratch: ScratchDatabase;
  let usersRepo: DrizzleUserRepository;
  let sessionsRepo: DrizzleAuthSessionRepository;

  beforeAll(async () => {
    scratch = await scratchDatabase();
    usersRepo = new DrizzleUserRepository(scratch.db);
    sessionsRepo = new DrizzleAuthSessionRepository(scratch.db);
  }, 60_000);

  afterAll(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await scratch.db.delete(auditLog);
    await scratch.db.delete(users); // cascades to identifiers, roles and sessions
  });

  describe('the seeded access catalogue', () => {
    it('holds exactly the permission catalogue from code', async () => {
      const rows = await scratch.db.select({ code: permissions.code }).from(permissions);
      expect(rows.map((row) => row.code).sort()).toEqual([...ALL_PERMISSIONS].sort());
    });

    it('holds exactly the six active roles', async () => {
      const rows = await scratch.db.select({ code: roles.code }).from(roles);
      expect(rows.map((row) => row.code).sort()).toEqual([...ACTIVE_ROLES].sort());
    });

    // The constant and the table must never drift apart silently.
    it('holds exactly the provisional role → permission matrix from code', async () => {
      const rows = await scratch.db.select().from(rolePermissions);
      const seeded = rows.map((row) => `${row.roleCode}:${row.permissionCode}`).sort();
      const expected = Object.entries(PROVISIONAL_ROLE_PERMISSIONS)
        .flatMap(([role, granted]) => granted.map((permission) => `${role}:${permission}`))
        .sort();
      expect(seeded).toEqual(expected);
    });

    it('is what the runtime role catalogue reads', async () => {
      const definitions = await new DrizzleRoleCatalog(scratch.db).list();
      const teacher = definitions.find((definition) => definition.code === 'TEACHER');
      expect([...(teacher?.permissions ?? [])].sort()).toEqual(
        [...PROVISIONAL_ROLE_PERMISSIONS.TEACHER].sort(),
      );
    });

    it('rejects a role_permissions row for an unknown permission', async () => {
      await expect(
        scratch.db
          .insert(rolePermissions)
          .values({ roleCode: 'TEACHER', permissionCode: 'live.teleport' }),
      ).rejects.toThrow();
    });
  });

  describe('users, identifiers and roles', () => {
    it('round-trips an account with identifiers and role assignments', async () => {
      const user = account('amina@example.com', {
        roles: ['TEACHER', 'SUPERVISOR'],
        status: 'ACTIVE',
      });
      expect(await usersRepo.create(user)).toBe('created');

      const found = await usersRepo.findByIdentifier({ kind: 'email', value: 'amina@example.com' });
      // Role assignments are a set; storage returns them in (granted_at, code) order.
      const byRole = (a: { role: string }, b: { role: string }) => a.role.localeCompare(b.role);
      expect(found && { ...found, roles: [...found.roles].sort(byRole) }).toEqual({
        ...user,
        roles: [...user.roles].sort(byRole),
      });
    });

    // Enforced by the primary key, so it holds even for two concurrent creates.
    it('reports a taken identifier as an outcome, not an exception', async () => {
      expect(await usersRepo.create(account('same@example.com'))).toBe('created');
      expect(await usersRepo.create(account('same@example.com'))).toBe('identifier_taken');
      expect(await scratch.db.select().from(users)).toHaveLength(1);
    });

    it('keeps the second create atomic: no half-written account on conflict', async () => {
      await usersRepo.create(account('same@example.com'));
      const loser = account('same@example.com', { roles: ['STUDENT'] });
      await usersRepo.create(loser);
      expect(await usersRepo.findById(loser.id)).toBeNull();
    });

    it('refuses a role that does not exist in the roles table', async () => {
      const user = account('a@example.com');
      await usersRepo.create(user);
      await expect(
        scratch.db.insert(userRoles).values({ userId: user.id, role: 'PARENT' }),
      ).rejects.toThrow();
    });

    it('refuses to delete a role that someone holds', async () => {
      await usersRepo.create(account('a@example.com', { roles: ['STUDENT'] }));
      await expect(scratch.db.delete(roles).where(eq(roles.code, 'STUDENT'))).rejects.toThrow();
    });

    it('refuses a status outside the four states', async () => {
      const user = account('a@example.com');
      await usersRepo.create(user);
      await expect(
        scratch.db.execute(sql`update users set status = 'GRADUATED' where id = ${user.id}`),
      ).rejects.toThrow();
    });

    // A password change must not rewrite when and by whom each role was granted.
    it('saves role changes as a diff, preserving existing grants', async () => {
      const user = account('a@example.com', { roles: ['STUDENT'] });
      await usersRepo.create(user);
      const later = new Date(AT.getTime() + 86_400_000);
      const updated = expectOk(
        assignRole({ ...user, passwordHash: 'changed' }, 'TEACHER', 'admin-1', later),
      );

      await usersRepo.save(updated);

      const stored = await usersRepo.findById(user.id);
      expect(stored?.roles).toEqual([
        { role: 'STUDENT', grantedAt: AT, grantedBy: null },
        { role: 'TEACHER', grantedAt: later, grantedBy: 'admin-1' },
      ]);
      expect(stored?.passwordHash).toBe('changed');
    });

    it('removes identifiers, roles and sessions with the account', async () => {
      const user = account('a@example.com', { roles: ['STUDENT'] });
      await usersRepo.create(user);
      await sessionsRepo.create(session(user.id));

      await scratch.db.delete(users).where(eq(users.id, user.id));

      expect(await scratch.db.select().from(userIdentifiers)).toHaveLength(0);
      expect(await scratch.db.select().from(userRoles)).toHaveLength(0);
      expect(await scratch.db.select().from(authSessions)).toHaveLength(0);
    });

    it('pages with a stable keyset cursor', async () => {
      for (let i = 0; i < 5; i++) {
        const user = account(`u${i}@example.com`);
        await usersRepo.create({ ...user, createdAt: new Date(AT.getTime() + i * 1000) });
      }
      const first = await usersRepo.list({ limit: 2 });
      const second = await usersRepo.list({ limit: 2, cursor: first.nextCursor });
      const third = await usersRepo.list({ limit: 2, cursor: second.nextCursor });
      const seen = [...first.items, ...second.items, ...third.items].map(
        (user) => user.identifiers[0]?.value,
      );
      expect(seen).toEqual([
        'u0@example.com',
        'u1@example.com',
        'u2@example.com',
        'u3@example.com',
        'u4@example.com',
      ]);
      expect(third.nextCursor).toBeUndefined();
    });

    it('answers "is there an active owner?"', async () => {
      expect(await usersRepo.anyActiveWithRole('OWNER')).toBe(false);
      await usersRepo.create(account('pending-owner@example.com', { roles: ['OWNER'] }));
      expect(await usersRepo.anyActiveWithRole('OWNER')).toBe(false);
      await usersRepo.create(account('owner@example.com', { roles: ['OWNER'], status: 'ACTIVE' }));
      expect(await usersRepo.anyActiveWithRole('OWNER')).toBe(true);
    });
  });

  describe('sessions', () => {
    let owner: User;
    beforeEach(async () => {
      owner = account('owner@example.com', { status: 'ACTIVE' });
      await usersRepo.create(owner);
    });

    it('round-trips a session', async () => {
      const created = session(owner.id);
      await sessionsRepo.create(created);
      expect(await sessionsRepo.findById(created.id)).toEqual(created);
    });

    it('rotates only from the expected hash (compare-and-swap)', async () => {
      const created = session(owner.id);
      await sessionsRepo.create(created);
      const next = {
        ...created,
        refreshTokenHash: 'hash-1',
        previousRefreshTokenHash: 'hash-0',
        generation: 1,
      };

      expect(await sessionsRepo.rotate(next, 'hash-0')).toBe(true);
      expect(await sessionsRepo.rotate({ ...next, refreshTokenHash: 'hash-2' }, 'hash-0')).toBe(
        false,
      );
      expect((await sessionsRepo.findById(created.id))?.refreshTokenHash).toBe('hash-1');
    });

    it('never rotates a revoked session back to life', async () => {
      const created = session(owner.id);
      await sessionsRepo.create(created);
      await sessionsRepo.revoke(created.id, 'logout', AT);
      expect(await sessionsRepo.rotate({ ...created, refreshTokenHash: 'hash-1' }, 'hash-0')).toBe(
        false,
      );
    });

    it('keeps the first revocation reason', async () => {
      const created = session(owner.id);
      await sessionsRepo.create(created);
      await sessionsRepo.revoke(created.id, 'logout', AT);
      await sessionsRepo.revoke(created.id, 'revoked_by_admin', new Date(AT.getTime() + 1000));
      const stored = await sessionsRepo.findById(created.id);
      expect(stored?.revokedReason).toBe('logout');
      expect(stored?.revokedAt).toEqual(AT);
    });

    it('ends all live sessions but one, counting only live ones', async () => {
      const keep = session(owner.id);
      const endA = session(owner.id);
      const endB = session(owner.id);
      const alreadyExpired = session(owner.id, { expiresAt: new Date(AT.getTime() + 1) });
      for (const s of [keep, endA, endB, alreadyExpired]) await sessionsRepo.create(s);

      const ended = await sessionsRepo.revokeAllForUser(
        owner.id,
        'password_changed',
        new Date(AT.getTime() + 60_000),
        keep.id,
      );

      expect(ended).toBe(2);
      const live = await sessionsRepo.listActiveForUser(owner.id, new Date(AT.getTime() + 60_000));
      expect(live.map((s) => s.id)).toEqual([keep.id]);
    });

    it('enforces its CHECK constraints', async () => {
      const bad = [
        session(owner.id, { revokedAt: AT, revokedReason: null }), // revoked without a reason
        session(owner.id, { expiresAt: AT }), // expires the instant it is created
        session(owner.id, {
          device: { platform: 'blackberry' as 'web', label: null, appVersion: null },
        }),
      ];
      for (const s of bad) await expect(sessionsRepo.create(s)).rejects.toThrow();
    });
  });

  describe('the whole flow on real SQL', () => {
    it('signs in, rotates, detects a replay, and ends the session — storing no raw token', async () => {
      const h = identityHarness(
        {},
        { users: usersRepo, sessions: sessionsRepo, catalog: new DrizzleRoleCatalog(scratch.db) },
      );
      await h.seedUser({ email: 'teacher@example.com', roles: ['TEACHER'] });

      const first = await h.signIn('teacher@example.com');
      const second = expectOk(
        await h.refresh.execute({ refreshToken: first.refreshToken, meta: META }),
      );
      expect(
        (await h.resolvePrincipal.execute(second.accessToken))?.permissions.has('live.moderate'),
      ).toBe(true);

      // Neither refresh token — nor its secret half — appears anywhere in the table.
      const dump = JSON.stringify(await scratch.db.select().from(authSessions));
      for (const token of [first.refreshToken, second.refreshToken]) {
        expect(dump).not.toContain(token.split('.')[1]);
      }

      expect(
        expectErr(await h.refresh.execute({ refreshToken: first.refreshToken, meta: META })).code,
      ).toBe('identity.refresh_token_invalid');
      const [stored] = await scratch.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.id, first.sessionId));
      expect(stored?.revokedReason).toBe('refresh_token_reuse');
      expect(await h.resolvePrincipal.execute(second.accessToken)).toBeNull();
    });
  });

  describe('audit log', () => {
    it('persists entries with their metadata, append-only', async () => {
      const audit = new DrizzleAuditLog(scratch.db, ids);
      await audit.record({
        actorUserId: 'u-1',
        action: 'identity.login.succeeded',
        resourceType: 'identity.session',
        resourceId: 's-1',
        at: AT,
        metadata: { platform: 'ios', ip: '203.0.113.7' },
        correlationId: 'req-1',
      });
      const [row] = await scratch.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'identity.login.succeeded'), eq(auditLog.resourceId, 's-1')),
        );
      expect(row).toMatchObject({
        actorUserId: 'u-1',
        correlationId: 'req-1',
        occurredAt: AT,
        metadata: { platform: 'ios', ip: '203.0.113.7' },
      });
    });
  });
});
