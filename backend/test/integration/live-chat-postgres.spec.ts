import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../../src/platform/database';
import { DrizzleLiveStore } from '../../src/modules/live/infrastructure/drizzle-live-repositories';
import { META, liveHarnessOver } from '../support/live-harness';
import {
  describeWithPostgres,
  migrateTo,
  scratchDatabase,
  tolerateTeardown,
  type ScratchDatabase,
} from '../support/postgres';

/**
 * A live session's own chat on Postgres (owner decision F, ADR 0047):
 *
 *   - migration 0033 on a database already holding live sessions: it adds the
 *     chat table and the session's two chat columns, defaulted — every
 *     existing row kept, every other table untouched;
 *   - the lock decided AT THE WRITE: a post that reaches the session row while
 *     a lock change holds it waits, and is refused once the lock commits;
 *   - a retry storm lands one message; posts never wait on each other.
 */
describeWithPostgres('live session chat on Postgres (ADR 0047)', () => {
  describe('migration 0033 on a database already in use', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      // 0000 … 0032: the state Trial is in before this release.
      scratch = await scratchDatabase({ upTo: 33 });
    }, 60_000);

    afterAll(async () => {
      await scratch?.drop();
    });

    const rows = async (query: ReturnType<typeof sql>) => (await scratch.db.execute(query)).rows;

    it('adds the chat, defaults the existing sessions, and keeps every row', async () => {
      expect(
        await rows(sql`select 1 from pg_tables where tablename = 'live_chat_messages'`),
      ).toEqual([]);
      await scratch.db.execute(sql`
        insert into live_sessions (id, community_id, host_user_id, state, state_version, started_at,
                                   ended_at, ended_by, end_reason, participant_cap, moderator_reserve)
        values ('00000000-0000-4000-8000-000000000001', 'c-1', 'u-1', 'live', 3, now(),
                null, null, null, 300, 10),
               ('00000000-0000-4000-8000-000000000002', 'c-2', 'u-2', 'ended', 5, now(),
                now(), 'u-2', 'moderator', 300, 10)`);
      const counts = async () =>
        Object.fromEntries(
          await Promise.all(
            (
              await rows(sql`select tablename from pg_tables where schemaname = 'public'
                              and tablename <> 'live_chat_messages' order by 1`)
            ).map(async (row) => {
              const name = row.tablename as string;
              const [counted] = await rows(
                sql`select count(*)::int as n from ${sql.identifier(name)}`,
              );
              return [name, counted?.n] as const;
            }),
          ),
        );
      const before = await counts();
      const sessionsBefore = await rows(
        sql`select id, state, state_version from live_sessions order by id`,
      );

      await migrateTo(scratch.db);

      expect(await counts()).toEqual(before);
      expect(
        await rows(
          sql`select id, state, state_version, chat_locked, chat_lock_version
                from live_sessions order by id`,
        ),
      ).toEqual(
        sessionsBefore.map((row) => ({ ...row, chat_locked: false, chat_lock_version: 0 })),
      );
      expect(
        (
          await rows(sql`select conname from pg_constraint
                          where conrelid = 'live_chat_messages'::regclass order by 1`)
        ).map((row) => row.conname),
      ).toEqual([
        'live_chat_messages_body_length',
        'live_chat_messages_pkey',
        'live_chat_messages_session_id_live_sessions_id_fk',
      ]);
      expect(
        (
          await rows(sql`select indexname from pg_indexes
                          where tablename = 'live_chat_messages' order by 1`)
        ).map((row) => row.indexname),
      ).toEqual([
        'live_chat_messages_one_per_client_key',
        'live_chat_messages_pkey',
        'live_chat_messages_session_page_idx',
      ]);
    });
  });

  describe('the chat, on the real store', () => {
    let scratch: ScratchDatabase;
    let pool: Pool;
    let db: Database;

    beforeAll(async () => {
      scratch = await scratchDatabase();
      pool = tolerateTeardown(
        new Pool({ connectionString: scratch.url, max: 16, options: '-c statement_timeout=15000' }),
      );
      db = drizzle(pool);
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
      await scratch?.drop();
    });

    async function running() {
      // Each harness numbers its ids from the start again: Live's tables start empty too.
      await db.execute(sql`truncate live_chat_messages, live_moderation_actions,
                                    live_presenter_grants, live_speaker_requests, live_sessions`);
      const h = liveHarnessOver(new DrizzleLiveStore(db));
      const community = await h.community('teacher-1', 'student-1');
      const session = await h.startSession(community.owner, community.id);
      return { h, owner: community.owner, student: community.students[0], sessionId: session.id };
    }

    it('posts, reads, locks and re-opens as it does in memory', async () => {
      const { h, owner, student, sessionId } = await running();
      const post = (who: typeof owner, body: string, key: string) =>
        h.postChat.execute({ principal: who, sessionId, clientMessageId: key, body, meta: META });
      expect((await post(student, 'أولى', 'pg-chat-key-0001')).ok).toBe(true);
      const lock = await h.chatLock.execute({
        principal: owner,
        sessionId,
        locked: true,
        meta: META,
      });
      expect(lock.ok && lock.value).toEqual({ changed: true, locked: true, lockVersion: 1 });
      const refused = await post(student, 'ممنوعة', 'pg-chat-key-0002');
      expect(!refused.ok && refused.error.code).toBe('live.chat_locked');
      expect((await post(owner, 'من المشرف', 'pg-chat-key-0003')).ok).toBe(true);
      const page = await h.listChat.execute({ principal: student, sessionId });
      expect(page.ok && page.value.items.map((m) => m.body)).toEqual(['من المشرف', 'أولى']);
      expect(page.ok && page.value).toMatchObject({ locked: true, lockVersion: 1, canPost: false });
    });

    it('lands a retry storm once: one posted, every other the same message', async () => {
      const { h, student, sessionId } = await running();
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          h.chat.post(
            {
              id: h.ids.next<'LiveChatMessage'>(),
              sessionId,
              senderId: student.userId,
              clientMessageId: 'pg-storm-key-0001',
              body: 'مرة واحدة',
              createdAt: h.clock.now(),
            },
            { moderator: false },
          ),
        ),
      );
      expect(outcomes.filter((o) => o.kind === 'posted')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'duplicate')).toHaveLength(19);
      const [stored] = (
        await db.execute(
          sql`select count(*)::int as n from live_chat_messages where session_id = ${sessionId}`,
        )
      ).rows;
      expect(stored?.n).toBe(1);
    });

    it('decides the lock at the write: a post waiting on a lock change is refused once it commits', async () => {
      const { h, student, sessionId } = await running();
      const holder = await pool.connect();
      try {
        // A lock change in progress: the session row held FOR UPDATE.
        await holder.query('begin');
        await holder.query('select 1 from live_sessions where id = $1 for update', [sessionId]);
        const pending = h.chat.post(
          {
            id: h.ids.next<'LiveChatMessage'>(),
            sessionId,
            senderId: student.userId,
            clientMessageId: 'pg-race-key-00001',
            body: 'في السباق',
            createdAt: h.clock.now(),
          },
          { moderator: false },
        );
        // The post reached the row and waits on it.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await holder.query(
          'update live_sessions set chat_locked = true, chat_lock_version = chat_lock_version + 1 where id = $1',
          [sessionId],
        );
        await holder.query('commit');
        expect(await pending).toEqual({ kind: 'locked' });
      } finally {
        holder.release();
      }
      const [count] = (
        await db.execute(
          sql`select count(*)::int as n from live_chat_messages where session_id = ${sessionId}`,
        )
      ).rows;
      expect(count?.n).toBe(0);
    });

    it('lets posts run side by side — none waits on another', async () => {
      const { h, student, owner, sessionId } = await running();
      const outcomes = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          h.chat.post(
            {
              id: h.ids.next<'LiveChatMessage'>(),
              sessionId,
              senderId: i % 2 === 0 ? student.userId : owner.userId,
              clientMessageId: `pg-many-key-${String(i).padStart(5, '0')}`,
              body: `m${i}`,
              createdAt: h.clock.now(),
            },
            { moderator: false },
          ),
        ),
      );
      expect(outcomes.every((o) => o.kind === 'posted')).toBe(true);
      const positions = outcomes.map((o) => (o.kind === 'posted' ? o.message.position : -1));
      expect(new Set(positions).size).toBe(30);
    });
  });
});
