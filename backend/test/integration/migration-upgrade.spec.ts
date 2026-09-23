import { sql } from 'drizzle-orm';

import {
  describeWithPostgres,
  migrateTo,
  scratchDatabase,
  type ScratchDatabase,
} from '../support/postgres';

/**
 * Migrations are tested the way they will actually run: against a database
 * that already holds data from the schema before them.
 *
 * This builds the Foundation V1 schema (migration 0000 only), fills it with
 * rows in the old vocabulary, then applies everything after and checks that
 * every row arrived intact in the new shape.
 */
describeWithPostgres('migration 0000 → current, with Foundation-era data', () => {
  let scratch: ScratchDatabase;
  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  beforeAll(async () => {
    scratch = await scratchDatabase({ upTo: 1 });

    await scratch.db.execute(sql`
      insert into users (id, email, display_name, status, password_hash, created_at, updated_at) values
        ('u-owner',   'owner@example.com', 'Owner',  'active',    '$scrypt$16384$8$1$c2FsdA==$aGFzaA==', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
        ('u-invited', 'new@example.com',   'New',    'invited',   '$scrypt$16384$8$1$c2FsdA==$aGFzaA==', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('u-susp',    'susp@example.com',  'Susp',   'suspended', '$scrypt$16384$8$1$c2FsdA==$aGFzaA==', '2026-01-03T00:00:00Z', '2026-03-01T00:00:00Z')`);
    await scratch.db.execute(sql`
      insert into user_roles (user_id, role) values
        ('u-owner', 'owner'), ('u-owner', 'administrator'), ('u-invited', 'student'), ('u-susp', 'parent')`);

    await migrateTo(scratch.db);
  }, 60_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('moves every email into user_identifiers', async () => {
    expect(
      await rows(sql`select user_id, kind, value from user_identifiers order by user_id`),
    ).toEqual([
      { user_id: 'u-invited', kind: 'email', value: 'new@example.com' },
      { user_id: 'u-owner', kind: 'email', value: 'owner@example.com' },
      { user_id: 'u-susp', kind: 'email', value: 'susp@example.com' },
    ]);
  });

  it('translates account states — "invited" becomes PENDING', async () => {
    expect(await rows(sql`select id, status from users order by id`)).toEqual([
      { id: 'u-invited', status: 'PENDING' },
      { id: 'u-owner', status: 'ACTIVE' },
      { id: 'u-susp', status: 'SUSPENDED' },
    ]);
  });

  it('translates role codes and drops roles that are not active in V1', async () => {
    expect(await rows(sql`select user_id, role from user_roles order by user_id, role`)).toEqual([
      { user_id: 'u-invited', role: 'STUDENT' },
      { user_id: 'u-owner', role: 'ADMIN' },
      { user_id: 'u-owner', role: 'OWNER' },
    ]);
  });

  it('dates the recorded password change to the last update, not to migration day', async () => {
    const [owner] = await rows<{ changed: string }>(
      sql`select password_changed_at::text as changed from users where id = 'u-owner'`,
    );
    expect(owner?.changed.startsWith('2026-02-01')).toBe(true);
  });

  it('drops users.email, whose job user_identifiers now does', async () => {
    const columns = await rows<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'users'`,
    );
    expect(columns.map((column) => column.column_name)).not.toContain('email');
  });

  it('leaves the tightened constraints in force', async () => {
    await expect(
      scratch.db.execute(sql`update users set status = 'active' where id = 'u-owner'`),
    ).rejects.toThrow();
    await expect(
      scratch.db.execute(sql`insert into user_roles (user_id, role) values ('u-owner', 'auditor')`),
    ).rejects.toThrow();
  });
});
