import { sql } from 'drizzle-orm';

import {
  describeWithPostgres,
  migrateTo,
  scratchDatabase,
  type ScratchDatabase,
} from '../support/postgres';

/**
 * Live's migration (0013) on a database already in use: it adds exactly
 * Live's four tables with their indexes, and nothing else — no function,
 * view, sequence, schema or extension — and every table that was there
 * before — its columns with their types, nullability and defaults, its
 * constraints, indexes and triggers, and every row in it, identity's seeded
 * catalogue included (P6 audit §17.12) — is exactly as it was.
 */
describeWithPostgres('migration 0013 on a database already in use', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    // Up to and including 0012.
    scratch = await scratchDatabase({ upTo: 13 });
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  const rows = async (query: ReturnType<typeof sql>) => (await scratch.db.execute(query)).rows;

  const tables = async () =>
    (await rows(sql`select tablename from pg_tables where schemaname = 'public' order by 1`)).map(
      (row) => row.tablename as string,
    );

  /** The catalogue's word on every table in `names`: its whole shape, from pg_catalog. */
  const shapeOf = async (names: readonly string[]) => {
    const list = sql.param([...names]);
    return {
      columns: await rows(sql`
        select c.relname as table, a.attnum as position, a.attname as column,
               format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
               pg_get_expr(d.adbin, d.adrelid) as default_value, a.attidentity as identity,
               a.attgenerated as generated, a.attcollation as collation
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where n.nspname = 'public' and c.relname = any(${list}::text[])
           and a.attnum > 0 and not a.attisdropped
         order by 1, 2`),
      constraints: await rows(sql`
        select conrelid::regclass::text as table, conname as name, contype as kind,
               pg_get_constraintdef(oid) as definition
          from pg_constraint
         where connamespace = 'public'::regnamespace
           and (conrelid::regclass::text = any(${list}::text[])
                or confrelid::regclass::text = any(${list}::text[]))
         order by 1, 2`),
      indexes: await rows(sql`
        select tablename as table, indexname as name, indexdef as definition
          from pg_indexes
         where schemaname = 'public' and tablename = any(${list}::text[])
         order by 1, 2`),
      triggers: await rows(sql`
        select tgrelid::regclass::text as table, tgname as name,
               pg_get_triggerdef(oid) as definition, tgenabled as enabled
          from pg_trigger
         where tgrelid::regclass::text = any(${list}::text[])
         order by 1, 2`),
    };
  };

  /** Every row of every table in `names`, as JSON, in a stable order. */
  const contentsOf = async (names: readonly string[]) => {
    const contents: Record<string, unknown> = {};
    for (const name of names) {
      const [row] = await rows(
        sql`select coalesce(json_agg(t order by t::text), '[]'::json) as data
              from ${sql.identifier(name)} t`,
      );
      contents[name] = row?.data;
    }
    return contents;
  };

  /**
   * Everything a migration could create, by kind and name: every relation
   * (table, index, sequence, view), function, type, schema and extension
   * outside the system catalogues.
   */
  const objects = async () =>
    (
      await rows(sql`
        select object from (
          select 'relation ' || c.relkind::text || ' ' || n.nspname || '.' || c.relname as object
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
          union all
          select 'function ' || n.nspname || '.' || p.proname
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname not in ('pg_catalog', 'information_schema')
          union all
          select 'type ' || n.nspname || '.' || t.typname
            from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
          union all
          select 'schema ' || nspname from pg_namespace
          union all
          select 'extension ' || extname from pg_extension
        ) catalogued`)
    )
      .map((row) => row.object as string)
      .sort();

  it('adds exactly Live’s four tables, and leaves every table and row that was there as it was', async () => {
    // A database in use: accounts, a community with members and a delegated
    // live moderator, its chat with a message, and an audit entry.
    await scratch.db.execute(sql`
      insert into users (id, display_name, status, password_hash, password_changed_at,
                         created_at, updated_at)
      values ('u-owner', 'المالك', 'ACTIVE', '$scrypt$16384$8$1$c2FsdA==$aGFzaA==', now(), now(), now()),
             ('u-member', 'عضو', 'ACTIVE', '$scrypt$16384$8$1$c2FsdA==$aGFzaA==', now(), now(), now())`);
    await scratch.db.execute(sql`
      insert into user_identifiers (user_id, kind, value)
      values ('u-owner', 'email', 'owner@example.com')`);
    await scratch.db.execute(sql`
      insert into user_roles (user_id, role) values ('u-owner', 'TEACHER'), ('u-member', 'STUDENT')`);
    await scratch.db.execute(sql`
      insert into communities (id, title, status, membership_version, member_count,
                               created_by, created_at, updated_at)
      values ('c-kept', 'حلقة الفجر', 'OPEN', 2, 2, 'u-owner', now(), now())`);
    await scratch.db.execute(sql`
      insert into community_members (id, community_id, user_id, status, standing, source,
                                     added_by, joined_at, version)
      values ('m-owner', 'c-kept', 'u-owner', 'ACTIVE', 'OWNER', 'ADDED', 'u-owner', now(), 1),
             ('m-member', 'c-kept', 'u-member', 'ACTIVE', 'MEMBER', 'ADDED', 'u-owner', now(), 2)`);
    await scratch.db.execute(sql`
      insert into communities_capability_grants (id, community_id, membership_id, user_id,
                                                 capability, granted_by, granted_at)
      values ('g-live', 'c-kept', 'm-member', 'u-member', 'community.live.moderate',
              'u-owner', now())`);
    await scratch.db.execute(sql`
      insert into conversations (id, type, title, created_by, created_at, last_sequence,
                                 last_message_at, member_count, community_id,
                                 projected_membership_version)
      values ('chat-kept', 'GROUP', null, 'u-owner', now(), 1, now(), 2, 'c-kept', 2)`);
    await scratch.db.execute(sql`
      insert into conversation_participants (conversation_id, user_id, role, joined_at, added_by)
      values ('chat-kept', 'u-owner', 'OWNER', now(), 'u-owner'),
             ('chat-kept', 'u-member', 'MEMBER', now(), 'u-owner')`);
    await scratch.db.execute(sql`
      insert into messages (id, conversation_id, sequence, sender_id, type, body,
                            client_message_id, created_at)
      values ('msg-kept', 'chat-kept', 1, 'u-member', 'TEXT', 'السلام عليكم',
              'client-0001', now())`);
    await scratch.db.execute(sql`
      insert into audit_log (id, actor_user_id, action, resource_type, resource_id)
      values ('audit-kept', 'u-owner', 'communities.capability.granted', 'community', 'c-kept')`);

    const before = await tables();
    const shapeBefore = await shapeOf(before);
    const contentsBefore = await contentsOf(before);
    // Not vacuous: the database is in use, across modules.
    expect(before).toEqual(
      expect.arrayContaining(['users', 'communities', 'community_members', 'messages']),
    );
    expect(
      Object.values(contentsBefore).filter((data) => Array.isArray(data) && data.length > 0).length,
    ).toBeGreaterThan(8);
    const objectsBefore = await objects();

    // Up to and including 0013.
    await migrateTo(scratch.db, 14);

    const after = await tables();
    expect(after.filter((table) => !before.includes(table))).toEqual([
      'live_moderation_actions',
      'live_presenter_grants',
      'live_sessions',
      'live_speaker_requests',
    ]);
    expect(before.filter((table) => !after.includes(table))).toEqual([]);
    // Nothing else was created, and nothing removed: no function, trigger
    // function, view, sequence, type, schema or extension — only Live's
    // tables, their row types and their indexes.
    const objectsAfter = await objects();
    expect(objectsBefore.filter((object) => !objectsAfter.includes(object))).toEqual([]);
    const tablesOfLive = [
      'live_moderation_actions',
      'live_presenter_grants',
      'live_sessions',
      'live_speaker_requests',
    ];
    expect(objectsAfter.filter((object) => !objectsBefore.includes(object))).toEqual(
      [
        ...tablesOfLive.map((table) => `relation r public.${table}`),
        ...tablesOfLive.flatMap((table) => [`type public.${table}`, `type public._${table}`]),
        ...[
          'live_moderation_actions_pkey',
          'live_moderation_actions_session_idx',
          'live_presenter_grants_closed_idx',
          'live_presenter_grants_one_open_per_session',
          'live_presenter_grants_pkey',
          'live_sessions_community_history_idx',
          'live_sessions_live_page_idx',
          'live_sessions_one_live_per_community',
          'live_sessions_pkey',
          'live_speaker_requests_floor_closed_idx',
          'live_speaker_requests_granted_idx',
          'live_speaker_requests_one_open_per_person',
          'live_speaker_requests_pkey',
          'live_speaker_requests_queue_idx',
        ].map((index) => `relation i public.${index}`),
      ].sort(),
    );
    // Every table that was there: the same shape, and no key into it or out
    // of it that was not there before…
    expect(await shapeOf(before)).toEqual(shapeBefore);
    // …and every row, identity's seeded descriptions of live.speak and
    // live.moderate included, exactly as it was.
    expect(await contentsOf(before)).toEqual(contentsBefore);
    expect(
      (
        await rows(sql`select description from permissions
                        where code in ('live.speak', 'live.moderate') order by code`)
      ).map((row) => row.description),
    ).toEqual([
      'Grant, revoke and mute speakers in live sessions one hosts.',
      'Speak in live sessions one hosts.',
    ]);
    // Live's tables start empty.
    for (const table of tablesOfLive) {
      expect(await rows(sql`select count(*)::int as n from ${sql.identifier(table)}`)).toEqual([
        { n: 0 },
      ]);
    }
  });
});
