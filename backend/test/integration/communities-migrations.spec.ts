import { sql } from 'drizzle-orm';

import {
  describeWithPostgres,
  migrateTo,
  scratchDatabase,
  type ScratchDatabase,
} from '../support/postgres';

/**
 * The Communities package's migrations — Communities' own (0009–0011) and
 * messaging's community-chat link (0012) — each asserting exactly its own
 * delta on a database already in use, so a later migration never has to
 * re-state what an earlier one added, and none can silently take anything away.
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

describeWithPostgres('migration 0011 on a database already in use', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await scratchDatabase({ upTo: 11 });
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  const column = async (query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows.map((row) => Object.values(row)[0] as string);

  it('adds exactly the grants table, empty, and leaves every community as it was', async () => {
    const tables = () =>
      column(sql`select tablename from pg_tables where schemaname = 'public' order by 1`);
    const stints = () =>
      column(sql`select id || ':' || status || ':' || standing || ':' || version
                   from community_members order by 1`);
    await scratch.db.execute(sql`
      insert into communities (id, title, status, membership_version, member_count,
                               created_by, created_at, updated_at)
      values ('c-kept', 'باقية', 'LOCKED', 2, 2, 'u-owner', now(), now())`);
    await scratch.db.execute(sql`
      insert into community_members (id, community_id, user_id, status, standing, source,
                                     added_by, joined_at, version)
      values ('m-owner', 'c-kept', 'u-owner', 'ACTIVE', 'OWNER', 'ADDED', 'u-owner', now(), 1),
             ('m-member', 'c-kept', 'u-member', 'ACTIVE', 'MEMBER', 'ADDED', 'u-owner', now(), 2)`);
    const tablesBefore = await tables();
    const stintsBefore = await stints();

    // Up to and including 0011.
    await migrateTo(scratch.db, 12);

    const tablesAfter = await tables();
    expect(tablesAfter.filter((table) => !tablesBefore.includes(table))).toEqual([
      'communities_capability_grants',
    ]);
    expect(tablesBefore.filter((table) => !tablesAfter.includes(table))).toEqual([]);
    expect(await stints()).toEqual(stintsBefore);
    expect(
      await column(sql`select status || ':' || member_count from communities where id = 'c-kept'`),
    ).toEqual(['LOCKED:2']);
    expect(await column(sql`select count(*)::text from communities_capability_grants`)).toEqual([
      '0',
    ]);
    // Existing stints can take grants at once: the composite key's target came with 0010.
    await scratch.db.execute(sql`
      insert into communities_capability_grants (id, community_id, membership_id, user_id,
                                                 capability, granted_by, granted_at)
      values ('g-1', 'c-kept', 'm-member', 'u-member', 'community.lock', 'u-owner', now())`);
    expect(await column(sql`select capability from communities_capability_grants`)).toEqual([
      'community.lock',
    ]);
  });
});

describeWithPostgres('migration 0012 on a database already in use', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await scratchDatabase({ upTo: 12 });
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  const column = async (query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows.map((row) => Object.values(row)[0] as string);

  it('adds only the community-chat columns, indexes and CHECKs, and leaves every conversation as it was', async () => {
    const columns = () =>
      column(sql`select table_name || '.' || column_name from information_schema.columns
                  where table_schema = 'public'
                    and table_name in ('conversations', 'conversation_participants')
                  order by 1`);
    const constraints = () =>
      column(sql`select conname from pg_constraint
                  where conrelid in ('conversations'::regclass, 'conversation_participants'::regclass)
                  order by 1`);
    const indexes = () =>
      column(sql`select indexname from pg_indexes
                  where tablename in ('conversations', 'conversation_participants') order by 1`);
    const conversations = () =>
      column(sql`select id || ':' || type || ':' || coalesce(title, '-') || ':' || member_count
                   from conversations order by 1`);
    const participants = () =>
      column(sql`select conversation_id || ':' || user_id || ':' || role || ':' ||
                        (left_at is null)::text || ':' || last_read_sequence
                   from conversation_participants order by 1`);

    await scratch.db.execute(sql`
      insert into conversations (id, type, title, created_by, created_at, direct_user_low,
                                 direct_user_high, member_count)
      values ('dm-kept', 'DIRECT', null, 'u-a', now(), 'u-a', 'u-b', 2),
             ('group-kept', 'GROUP', 'حلقة', 'u-a', now(), null, null, 2),
             ('channel-kept', 'CHANNEL', 'إعلانات', 'u-a', now(), null, null, 1)`);
    await scratch.db.execute(sql`
      insert into conversation_participants (conversation_id, user_id, role, joined_at, added_by)
      values ('dm-kept', 'u-a', 'MEMBER', now(), 'u-a'), ('dm-kept', 'u-b', 'MEMBER', now(), 'u-a'),
             ('group-kept', 'u-a', 'OWNER', now(), 'u-a'), ('group-kept', 'u-b', 'MEMBER', now(), 'u-a'),
             ('channel-kept', 'u-a', 'OWNER', now(), 'u-a')`);
    const [columnsBefore, constraintsBefore, indexesBefore] = [
      await columns(),
      await constraints(),
      await indexes(),
    ];
    const [conversationsBefore, participantsBefore] = [await conversations(), await participants()];

    // Up to and including 0012.
    await migrateTo(scratch.db, 13);

    const added = <T>(after: T[], before: T[]) => after.filter((item) => !before.includes(item));
    expect(added(await columns(), columnsBefore)).toEqual([
      'conversation_participants.source_joined_at',
      'conversation_participants.source_membership_id',
      'conversation_participants.source_version',
      'conversations.community_id',
      'conversations.projected_membership_version',
    ]);
    // The title CHECK is replaced under its own name; nothing else goes.
    expect(added(await constraints(), constraintsBefore)).toEqual([
      'conversation_participants_source_shape',
      'conversations_community_chat_shape',
    ]);
    expect(added(constraintsBefore, await constraints())).toEqual([]);
    expect(added(await indexes(), indexesBefore)).toEqual([
      'conversation_participants_current_idx',
      'conversations_community_unique',
    ]);
    expect(added(indexesBefore, await indexes())).toEqual([]);
    expect(added(columnsBefore, await columns())).toEqual([]);

    // Every existing row, untouched, with NULLs where the new columns are.
    expect(await conversations()).toEqual(conversationsBefore);
    expect(await participants()).toEqual(participantsBefore);
    expect(
      await column(sql`select count(*)::text from conversations
                        where community_id is null and projected_membership_version is null`),
    ).toEqual(['3']);
    expect(
      await column(sql`select count(*)::text from conversation_participants
                        where source_version is null and source_membership_id is null
                          and source_joined_at is null`),
    ).toEqual(['5']);
  });
});
