import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { Pool } from 'pg';

import { createDatabase, type Database } from '../../../platform/database';
import { asId } from '../../../shared';
import type { User } from '../domain/user';
import { DrizzleUserRepository } from './drizzle-user-repository';
import { userRoles, users } from './schema';

/**
 * Runs against a real Postgres when `TEST_DATABASE_URL` is set, and is skipped
 * otherwise so the suite stays runnable with no infrastructure.
 *
 * The skip is announced rather than silent: a test that quietly disappears is
 * indistinguishable from a test that passes, and this is the only coverage the
 * SQL layer has.
 */
const url = process.env.TEST_DATABASE_URL;
if (url === undefined) {
  console.warn(
    '[skip] DrizzleUserRepository: set TEST_DATABASE_URL to run the Postgres integration tests.',
  );
}
const describeWithDatabase = url === undefined ? describe.skip : describe;

const user = (overrides: Partial<User> = {}): User => ({
  id: asId<'User'>('usr-1'),
  email: 'Teacher@Example.COM',
  displayName: 'A Teacher',
  status: 'active',
  roles: ['teacher'],
  passwordHash: '$scrypt$16384$8$1$salt$hash',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describeWithDatabase('DrizzleUserRepository', () => {
  let pool: Pool;
  let db: Database;
  let repository: DrizzleUserRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    db = createDatabase(pool);
    // The committed migrations are what production runs; testing against a
    // hand-built schema would prove the repository works on a schema nobody
    // deploys.
    await migrate(db, { migrationsFolder: join(__dirname, '..', '..', '..', '..', 'drizzle') });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.delete(userRoles);
    await db.delete(users);
    repository = new DrizzleUserRepository(db);
  });

  it('returns null for a user that does not exist', async () => {
    expect(await repository.findById(asId<'User'>('missing'))).toBeNull();
    expect(await repository.findByEmail('nobody@example.com')).toBeNull();
  });

  it('round-trips a user with its roles', async () => {
    const saved = user({ roles: ['teacher', 'supervisor'] });
    await repository.save(saved);

    const found = await repository.findById(saved.id);

    expect(found).not.toBeNull();
    expect(found?.displayName).toBe('A Teacher');
    expect(found?.status).toBe('active');
    expect(found?.passwordHash).toBe(saved.passwordHash);
    expect([...(found?.roles ?? [])].sort()).toEqual(['supervisor', 'teacher']);
  });

  // Case-insensitive lookup is what stops one person holding two accounts.
  it('normalizes email on write and on lookup', async () => {
    await repository.save(user({ email: 'Teacher@Example.COM' }));

    const found = await repository.findByEmail('  TEACHER@example.com  ');

    expect(found?.id).toBe('usr-1');
    expect(found?.email).toBe('teacher@example.com');
  });

  it('refuses a second account on the same email', async () => {
    await repository.save(user({ id: asId<'User'>('usr-1'), email: 'same@example.com' }));

    await expect(
      repository.save(user({ id: asId<'User'>('usr-2'), email: 'SAME@example.com' })),
    ).rejects.toThrow();
  });

  it('replaces roles on save rather than accumulating them', async () => {
    await repository.save(user({ roles: ['teacher', 'supervisor'] }));
    await repository.save(user({ roles: ['teacher'] }));

    const found = await repository.findById(asId<'User'>('usr-1'));

    expect(found?.roles).toEqual(['teacher']);
  });

  it('updates a user in place rather than inserting a duplicate', async () => {
    await repository.save(user({ displayName: 'Before', status: 'invited' }));
    await repository.save(user({ displayName: 'After', status: 'active' }));

    const found = await repository.findById(asId<'User'>('usr-1'));
    const all = await db.select().from(users);

    expect(all).toHaveLength(1);
    expect(found?.displayName).toBe('After');
    expect(found?.status).toBe('active');
  });

  it('rejects a status outside the allowed set', async () => {
    const invalid = { ...user(), status: 'deleted' as User['status'] };
    await expect(repository.save(invalid)).rejects.toThrow();
  });

  it('removes role rows when the user is deleted', async () => {
    await repository.save(user({ roles: ['teacher'] }));
    await db.delete(users);

    expect(await db.select().from(userRoles)).toHaveLength(0);
  });

  it('stores a user with no roles at all', async () => {
    await repository.save(user({ roles: [] }));

    const found = await repository.findById(asId<'User'>('usr-1'));

    expect(found?.roles).toEqual([]);
  });

  it('keeps users independent of one another', async () => {
    await repository.save(
      user({ id: asId<'User'>('usr-1'), email: 'a@example.com', roles: ['teacher'] }),
    );
    await repository.save(
      user({ id: asId<'User'>('usr-2'), email: 'b@example.com', roles: ['student'] }),
    );

    expect((await repository.findById(asId<'User'>('usr-1')))?.roles).toEqual(['teacher']);
    expect((await repository.findById(asId<'User'>('usr-2')))?.roles).toEqual(['student']);
  });
});
