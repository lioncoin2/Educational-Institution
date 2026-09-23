import { sql } from 'drizzle-orm';

import {
  describeWithPostgres,
  migrateTo,
  scratchDatabase,
  type ScratchDatabase,
} from '../support/postgres';

/**
 * Communities' migrations, each asserting exactly its own delta on a database
 * already in use — so a later migration never has to re-state what an earlier
 * one added, and none can silently take anything away.
 */
describeWithPostgres('migration 0009 on a database already in use', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await scratchDatabase({ upTo: 9 });
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  const column = async (query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows.map((row) => Object.values(row)[0] as string);

  it('adds the four communities ceilings and their provisional grants, and nothing else', async () => {
    const permissions = () => column(sql`select code from permissions order by 1`);
    const grants = () =>
      column(sql`select role_code || ':' || permission_code from role_permissions order by 1`);
    const permissionsBefore = await permissions();
    const grantsBefore = await grants();
    await scratch.db.execute(sql`
      insert into users (id, display_name, status, password_hash, password_changed_at, created_at, updated_at)
      values ('u-kept', 'باقٍ', 'ACTIVE', '$scrypt$16384$8$1$c2FsdA==$aGFzaA==', now(), now(), now())`);

    // Up to and including 0009 — this test is about 0009 alone.
    await migrateTo(scratch.db, 10);

    const permissionsAfter = await permissions();
    const grantsAfter = await grants();
    expect(permissionsAfter.filter((code) => !permissionsBefore.includes(code))).toEqual([
      'communities.create',
      'communities.manage',
      'communities.moderate',
      'communities.read',
    ]);
    expect(grantsAfter.filter((grant) => !grantsBefore.includes(grant))).toEqual([
      'ADMIN:communities.create',
      'ADMIN:communities.manage',
      'ADMIN:communities.moderate',
      'ADMIN:communities.read',
      'ASSISTANT_TEACHER:communities.read',
      'OWNER:communities.create',
      'OWNER:communities.manage',
      'OWNER:communities.moderate',
      'OWNER:communities.read',
      'STUDENT:communities.read',
      'SUPERVISOR:communities.read',
      'TEACHER:communities.moderate',
      'TEACHER:communities.read',
    ]);
    expect(permissionsBefore.filter((code) => !permissionsAfter.includes(code))).toEqual([]);
    expect(grantsBefore.filter((grant) => !grantsAfter.includes(grant))).toEqual([]);
    expect(await column(sql`select display_name from users where id = 'u-kept'`)).toEqual(['باقٍ']);
  });
});

describeWithPostgres('migration 0010 on a database already in use', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await scratchDatabase({ upTo: 10 });
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  const column = async (query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows.map((row) => Object.values(row)[0] as string);

  it('adds exactly Communities’ three tables, empty, and changes nothing that was there', async () => {
    const tables = () =>
      column(sql`select tablename from pg_tables where schemaname = 'public' order by 1`);
    const grants = () =>
      column(sql`select role_code || ':' || permission_code from role_permissions order by 1`);
    const tablesBefore = await tables();
    const grantsBefore = await grants();

    // Up to and including 0010.
    await migrateTo(scratch.db, 11);

    const tablesAfter = await tables();
    expect(tablesAfter.filter((table) => !tablesBefore.includes(table))).toEqual([
      'communities',
      'community_invitations',
      'community_members',
    ]);
    expect(tablesBefore.filter((table) => !tablesAfter.includes(table))).toEqual([]);
    expect(await grants()).toEqual(grantsBefore);
    expect(await column(sql`select count(*)::text from community_members`)).toEqual(['0']);
  });
});
