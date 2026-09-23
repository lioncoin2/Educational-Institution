import { sql } from 'drizzle-orm';

import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import {
  pendingAsset,
  markAvailable,
  type FileAssetId,
} from '../../src/modules/files/domain/file-asset';
import { DrizzleFileAssetRepository } from '../../src/modules/files/infrastructure/drizzle-file-asset-repository';
import { Roles } from '../../src/modules/identity/domain/role';
import {
  newChannelConversation,
  newDirectConversation,
  newGroupConversation,
  type ConversationId,
  type NewConversation,
} from '../../src/modules/messaging/domain/conversation';
import { textDraft } from '../../src/modules/messaging/domain/message';
import { UNREAD_COUNT_CAP } from '../../src/modules/messaging/domain/messaging-policy';
import { DrizzleMessagingReadModel } from '../../src/modules/messaging/infrastructure/drizzle-messaging-read-model';
import { DrizzleMessagingRepository } from '../../src/modules/messaging/infrastructure/drizzle-messaging-repository';
import { expectOk } from '../support/identity-harness';
import { META, messagingHarness } from '../support/messaging-harness';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

const ids = new UuidIdGenerator();
const AT = new Date('2026-09-01T08:00:00.000Z');

function created<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const group = (owner: string, members: string[], at = AT): NewConversation =>
  created(
    newGroupConversation({
      id: ids.next<'Conversation'>(),
      creator: owner,
      title: 'Halaqa',
      memberIds: members,
      at,
    }),
  );

const text = (conversationId: string, senderId: string, body: string, key: string = ids.next()) =>
  created(
    textDraft({
      id: ids.next<'Message'>(),
      conversationId: conversationId as ConversationId,
      senderId,
      clientMessageId: key,
      replyToMessageId: null,
      body,
      at: AT,
    }),
  );

/** Postgres error code, whether the driver error arrives bare or wrapped by Drizzle. */
async function pgError(work: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    return cause as { code?: string; constraint?: string };
  }
  throw new Error('expected the database to refuse this');
}

describeWithPostgres('messaging and files on Postgres', () => {
  let scratch: ScratchDatabase;
  let repository: DrizzleMessagingRepository;
  let readModel: DrizzleMessagingReadModel;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  beforeAll(async () => {
    scratch = await scratchDatabase();
    repository = new DrizzleMessagingRepository(scratch.db);
    readModel = new DrizzleMessagingReadModel(scratch.db);
  }, 60_000);

  afterAll(async () => {
    await scratch.drop();
  });

  describe('the schema the migrations built', () => {
    it('has every constraint the design relies on, by name', async () => {
      const names = (
        await rows<{ conname: string }>(sql`
          select conname from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          where t.relname in ('conversations', 'conversation_participants', 'messages',
                              'message_attachments', 'file_assets')`)
      ).map((row) => row.conname);
      for (const expected of [
        'conversations_direct_pair_unique',
        'conversations_direct_pair_shape',
        'conversations_title_shape',
        'conversations_activity_consistent',
        'conversation_participants_conversation_id_user_id_pk',
        'conversation_participants_read_state_valid',
        'conversation_participants_conversation_id_conversations_id_fk',
        'messages_conversation_sequence_unique',
        'messages_idempotency_unique',
        'messages_client_message_id_shape',
        'messages_text_has_body',
        'messages_conversation_id_conversations_id_fk',
        'messages_reply_to_message_id_messages_id_fk',
        'message_attachments_message_id_messages_id_fk',
        'file_assets_storage_key_unique',
        'file_assets_completion_consistent',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('has the partial indexes the list and sweep queries use', async () => {
      const indexes = await rows<{ indexname: string; indexdef: string }>(sql`
        select indexname, indexdef from pg_indexes
        where tablename in ('conversation_participants', 'file_assets')`);
      const byName = Object.fromEntries(indexes.map((index) => [index.indexname, index.indexdef]));
      expect(byName.conversation_participants_user_current_idx).toMatch(
        /WHERE \(left_at IS NULL\)/,
      );
      expect(byName.file_assets_pending_idx).toMatch(/WHERE \(status = 'PENDING'::text\)/);
    });

    it('holds no foreign key into another module’s tables', async () => {
      const foreign = await rows<{ source: string; target: string }>(sql`
        select s.relname as source, t.relname as target from pg_constraint c
        join pg_class s on s.oid = c.conrelid
        join pg_class t on t.oid = c.confrelid
        where c.contype = 'f'
          and s.relname in ('conversations', 'conversation_participants', 'messages',
                            'message_attachments', 'file_assets')`);
      const messagingTables = new Set([
        'conversations',
        'conversation_participants',
        'messages',
        'message_attachments',
      ]);
      expect(foreign.filter((fk) => !messagingTables.has(fk.target))).toEqual([]);
    });
  });

  describe('direct conversations — one per pair, decided by the database', () => {
    it('creates exactly one under twenty simultaneous requests from both sides', async () => {
      const [a, b] = [`dm-a-${ids.next()}`, `dm-b-${ids.next()}`];
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          repository.createDirectConversation(
            created(
              newDirectConversation({
                id: ids.next<'Conversation'>(),
                initiator: i % 2 === 0 ? a : b,
                counterpart: i % 2 === 0 ? b : a,
                at: AT,
              }),
            ),
          ),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => outcome.conversation.id)).size).toBe(1);

      const conversationId = outcomes[0].conversation.id;
      const [counts] = await rows<{ members: number; member_count: number }>(sql`
        select (select count(*)::int from conversation_participants where conversation_id = ${conversationId}) as members,
               (select member_count from conversations where id = ${conversationId}) as member_count`);
      expect(counts).toEqual({ members: 2, member_count: 2 });
    });

    it('refuses a second row for the same pair even without the repository', async () => {
      const low = `pair-low-${ids.next()}`;
      const high = `pair-z-${ids.next()}`;
      const insert = (id: string) =>
        scratch.db.execute(sql`
        insert into conversations (id, type, created_by, direct_user_low, direct_user_high)
        values (${id}, 'DIRECT', ${low}, ${low}, ${high})`);
      await insert(ids.next());
      expect(await pgError(insert(ids.next()))).toMatchObject({
        code: '23505',
        constraint: 'conversations_direct_pair_unique',
      });
    });
  });

  describe('ordering — sequences assigned under the conversation lock', () => {
    it('gives fifty simultaneous sends fifty distinct, gapless positions', async () => {
      const members = Array.from({ length: 5 }, (_, i) => `seq-u${i}-${ids.next()}`);
      const conversation = group(members[0], members.slice(1));
      await repository.createConversation(conversation);

      const outcomes = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          repository.appendMessage(text(conversation.conversation.id, members[i % 5], `m${i}`)),
        ),
      );
      const sequences = outcomes
        .map((outcome) => (outcome.kind === 'appended' ? outcome.message.sequence : -1))
        .sort((x, y) => x - y);
      expect(sequences).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

      const [state] = await rows<{ last_sequence: string; stored: number }>(sql`
        select c.last_sequence::text, (select count(*)::int from messages m where m.conversation_id = c.id) as stored
        from conversations c where c.id = ${conversation.conversation.id}`);
      expect(state).toEqual({ last_sequence: '50', stored: 50 });
    });

    it('stores a retry storm once: one appended, every other a duplicate of it', async () => {
      const [owner] = [`retry-${ids.next()}`];
      const conversation = group(owner, []);
      await repository.createConversation(conversation);
      const key = ids.next();
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, () =>
          repository.appendMessage(text(conversation.conversation.id, owner, 'same', key)),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.kind === 'appended')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(11);
      const messageIds = new Set(
        outcomes.map((outcome) =>
          outcome.kind === 'appended' || outcome.kind === 'duplicate' ? outcome.message.id : null,
        ),
      );
      expect(messageIds.size).toBe(1);
      const [stored] = await rows<{ n: number }>(
        sql`select count(*)::int as n from messages where conversation_id = ${conversation.conversation.id}`,
      );
      expect(stored?.n).toBe(1);
    });

    it('refuses a reused key with different content, and a non-member', async () => {
      const owner = `key-${ids.next()}`;
      const conversation = group(owner, []);
      await repository.createConversation(conversation);
      const key = ids.next();
      await repository.appendMessage(text(conversation.conversation.id, owner, 'first', key));
      expect(
        (await repository.appendMessage(text(conversation.conversation.id, owner, 'other', key)))
          .kind,
      ).toBe('key_reused');
      expect(
        (await repository.appendMessage(text(conversation.conversation.id, 'stranger', 'hi'))).kind,
      ).toBe('not_participant');
    });

    it('refuses a removed member at append, whatever they checked earlier', async () => {
      const owner = `rm-owner-${ids.next()}`;
      const member = `rm-member-${ids.next()}`;
      const conversation = group(owner, [member]);
      await repository.createConversation(conversation);
      await repository.removeParticipant(conversation.conversation.id, member, AT);
      expect(
        (await repository.appendMessage(text(conversation.conversation.id, member, 'late'))).kind,
      ).toBe('not_participant');
    });
  });

  describe("the database's own guards", () => {
    let conversationId: string;
    const owner = `guard-${ids.next()}`;

    beforeAll(async () => {
      const conversation = group(owner, []);
      conversationId = conversation.conversation.id;
      await repository.createConversation(conversation);
      await repository.appendMessage(text(conversationId, owner, 'one', 'guard-key-0001'));
    });

    const insertMessage = (fields: {
      conversationId?: string;
      sequence?: number;
      clientMessageId?: string;
      type?: string;
      body?: string | null;
    }) =>
      scratch.db.execute(sql`
        insert into messages (id, conversation_id, sequence, sender_id, type, body, client_message_id)
        values (${ids.next()}, ${fields.conversationId ?? conversationId}, ${fields.sequence ?? 99},
                ${owner}, ${fields.type ?? 'TEXT'}, ${fields.body === undefined ? 'x' : fields.body},
                ${fields.clientMessageId ?? ids.next()})`);

    it.each([
      ['a message in a conversation that does not exist', { conversationId: 'nope' }, '23503'],
      ['a second message at the same position', { sequence: 1 }, '23505'],
      ['a second message with the same client key', { clientMessageId: 'guard-key-0001' }, '23505'],
      ['a malformed client key', { clientMessageId: 'bad key' }, '23514'],
      ['a text message without text', { body: null }, '23514'],
      ['an unknown message type', { type: 'VIDEO' }, '23514'],
    ])('refuses %s', async (_label, fields, code) => {
      expect((await pgError(insertMessage(fields))).code).toBe(code);
    });

    it('refuses a read watermark below the history window, and a titled DM', async () => {
      expect(
        (
          await pgError(
            scratch.db.execute(sql`
              insert into conversation_participants (conversation_id, user_id, role, last_read_sequence, hidden_through_sequence)
              values (${conversationId}, ${ids.next()}, 'MEMBER', 1, 5)`),
          )
        ).code,
      ).toBe('23514');
      expect(
        (
          await pgError(
            scratch.db.execute(sql`
              insert into conversations (id, type, title, created_by, direct_user_low, direct_user_high)
              values (${ids.next()}, 'DIRECT', 'A title', 'a', 'a', 'b')`),
          )
        ).code,
      ).toBe('23514');
    });
  });

  describe('membership — counts and caps under concurrency', () => {
    it('keeps member_count equal to the current members through concurrent adds', async () => {
      const owner = `count-${ids.next()}`;
      const conversation = group(owner, []);
      await repository.createConversation(conversation);
      const newcomers = Array.from({ length: 12 }, (_, i) => `count-u${i}-${ids.next()}`);
      await Promise.all(
        newcomers.map((userId, i) =>
          repository.addParticipants({
            conversationId: conversation.conversation.id,
            // Overlapping batches: everyone is named by two requests.
            userIds: [userId, newcomers[(i + 1) % newcomers.length]],
            role: 'MEMBER',
            addedBy: owner,
            at: AT,
            capacity: 500,
          }),
        ),
      );
      const [state] = await rows<{ member_count: number; current: number }>(sql`
        select c.member_count,
               (select count(*)::int from conversation_participants p
                where p.conversation_id = c.id and p.left_at is null) as current
        from conversations c where c.id = ${conversation.conversation.id}`);
      expect(state).toEqual({ member_count: 13, current: 13 });
    });

    it('never exceeds the cap, however many adds race for the last places', async () => {
      const owner = `cap-${ids.next()}`;
      const conversation = group(owner, [`cap-m-${ids.next()}`]);
      await repository.createConversation(conversation);
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repository.addParticipants({
            conversationId: conversation.conversation.id,
            userIds: [`cap-u${i}-${ids.next()}`],
            role: 'MEMBER',
            addedBy: owner,
            at: AT,
            capacity: 5,
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.kind === 'added')).toHaveLength(3);
      expect(outcomes.filter((outcome) => outcome.kind === 'capacity_exceeded')).toHaveLength(7);
    });

    it('lets someone who left rejoin, with a fresh window', async () => {
      const owner = `rejoin-${ids.next()}`;
      const member = `rejoin-m-${ids.next()}`;
      const conversation = group(owner, [member]);
      const id = conversation.conversation.id;
      await repository.createConversation(conversation);
      await repository.appendMessage(text(id, owner, 'one'));
      await repository.removeParticipant(id, member, AT);
      await repository.appendMessage(text(id, owner, 'two'));
      const outcome = await repository.addParticipants({
        conversationId: id,
        userIds: [member],
        role: 'MEMBER',
        addedBy: owner,
        at: new Date(AT.getTime() + 1000),
        capacity: 500,
      });
      expect(outcome.kind === 'added' && outcome.added.map((p) => p.userId)).toEqual([member]);
      expect(await repository.findParticipant(id, member)).toMatchObject({
        leftAt: null,
        hiddenThroughSequence: 2,
        lastReadSequence: 2,
      });
    });
  });

  describe('read state', () => {
    it('ends at the highest request, clamped, whatever order concurrent requests land in', async () => {
      const owner = `read-${ids.next()}`;
      const reader = `read-r-${ids.next()}`;
      const conversation = group(owner, [reader]);
      const id = conversation.conversation.id;
      await repository.createConversation(conversation);
      for (let i = 0; i < 10; i++) await repository.appendMessage(text(id, owner, `m${i}`));

      await Promise.all(
        [3, 9, 1, 7, 40, 2, 8].map((sequence) => repository.markRead(id, reader, sequence)),
      );
      expect((await repository.findParticipant(id, reader))?.lastReadSequence).toBe(10);
      expect(await repository.markRead(id, reader, 4)).toEqual({
        kind: 'unchanged',
        lastReadSequence: 10,
      });
      expect(await repository.markRead(id, 'stranger', 4)).toEqual({ kind: 'not_participant' });
    });
  });

  describe('the read model at volume', () => {
    let conversationId: ConversationId;
    const owner = `volume-${ids.next()}`;
    const reader = `volume-r-${ids.next()}`;
    const TOTAL = 2000;

    beforeAll(async () => {
      const conversation = group(owner, [reader]);
      conversationId = conversation.conversation.id;
      await repository.createConversation(conversation);
      // Bulk history in one statement, then the counters the append path would keep.
      await scratch.db.execute(sql`
        insert into messages (id, conversation_id, sequence, sender_id, type, body, client_message_id, created_at)
        select 'vol-' || n, ${conversationId}, n, ${owner}, 'TEXT', 'message ' || n,
               'vol-key-' || lpad(n::text, 8, '0'), ${AT.toISOString()}::timestamptz + (n || ' seconds')::interval
        from generate_series(1, ${TOTAL}) as n`);
      await scratch.db.execute(sql`
        update conversations set last_sequence = ${TOTAL},
          last_message_at = ${AT.toISOString()}::timestamptz + (${TOTAL} || ' seconds')::interval
        where id = ${conversationId}`);
      // Noise: other conversations' rows the timeline query must not scan.
      for (let c = 0; c < 5; c++) {
        const other = group(`noise-${c}-${ids.next()}`, []);
        await repository.createConversation(other);
        await scratch.db.execute(sql`
          insert into messages (id, conversation_id, sequence, sender_id, type, body, client_message_id)
          select 'noise-${sql.raw(String(c))}-' || n, ${other.conversation.id}, n, 'noise', 'TEXT', 'x',
                 'noise-key-' || lpad(n::text, 8, '0')
          from generate_series(1, 2000) as n`);
      }
      await scratch.db.execute(sql`analyze messages`);
    }, 60_000);

    it('walks the whole history backwards with keyset cursors, each message exactly once', async () => {
      const seen: number[] = [];
      let before: number | undefined;
      for (;;) {
        const slice = await readModel.listMessages(conversationId, {
          hiddenThroughSequence: 0,
          lastSequence: TOTAL,
          before,
          limit: 100,
        });
        seen.push(...slice.items.map((message) => message.sequence).reverse());
        if (!slice.hasOlder) break;
        before = slice.items[0]?.sequence;
      }
      expect(seen).toHaveLength(TOTAL);
      expect(seen[0]).toBe(TOTAL);
      expect(new Set(seen).size).toBe(TOTAL);
    });

    it('answers a timeline page from the index, not a scan', async () => {
      const plan = (
        await rows<{ 'QUERY PLAN': string }>(sql`
          explain select * from messages
          where conversation_id = ${conversationId} and sequence > 0 and sequence < 1500
          order by sequence desc limit 51`)
      )
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      expect(plan).toMatch(/Index Scan Backward using messages_conversation_sequence_unique/);
      expect(plan).not.toMatch(/Seq Scan on messages/);
    });

    it('counts unread only up to the cap, however long the backlog', async () => {
      const summary = await readModel.conversationSummary(conversationId, reader);
      expect(summary?.unreadCount).toBe(UNREAD_COUNT_CAP);
      expect(summary?.lastMessage).toMatchObject({ sequence: TOTAL, body: `message ${TOTAL}` });
    });

    it('renders a deleted message as a tombstone in the right place', async () => {
      await scratch.db.execute(sql`
        update messages set deleted_at = created_at + interval '1 minute'
        where conversation_id = ${conversationId} and sequence = ${TOTAL - 1}`);
      const slice = await readModel.listMessages(conversationId, {
        hiddenThroughSequence: 0,
        lastSequence: TOTAL,
        limit: 3,
      });
      expect(slice.items.map((message) => [message.sequence, message.deletedAt !== null])).toEqual([
        [TOTAL - 2, false],
        [TOTAL - 1, true],
        [TOTAL, false],
      ]);
    });
  });

  describe('conversation lists', () => {
    it('pages a member’s conversations by activity, ties broken by id, each once', async () => {
      const member = `list-${ids.next()}`;
      const expected: string[] = [];
      for (let i = 0; i < 9; i++) {
        // Three share each timestamp: the id must break the tie consistently.
        const conversation = group(member, [], new Date(AT.getTime() + Math.floor(i / 3) * 1000));
        await repository.createConversation(conversation);
        expected.push(conversation.conversation.id);
      }
      const seen: string[] = [];
      let after: { activityAt: Date; id: string } | undefined;
      do {
        const page = await readModel.listConversations(member, { limit: 4, after });
        seen.push(...page.items.map((row) => row.conversation.id));
        after = page.next ?? undefined;
      } while (after !== undefined);
      expect(new Set(seen).size).toBe(9);
      expect([...seen].sort()).toEqual([...expected].sort());
    });

    it('pages a large audience for fan-out without its sender', async () => {
      const admin = `fan-${ids.next()}`;
      const members = Array.from(
        { length: 250 },
        (_, i) => `fan-u${String(i).padStart(3, '0')}-${ids.next()}`,
      );
      const channel = created(
        newChannelConversation({
          id: ids.next<'Conversation'>(),
          creator: admin,
          title: 'All students',
          memberIds: members,
          publisherIds: [],
          at: AT,
        }),
      );
      await repository.createConversation(channel);
      const collected: string[] = [];
      let afterUserId: string | undefined;
      do {
        const page = await readModel.listMemberIds(channel.conversation.id, {
          limit: 100,
          afterUserId,
          excludeUserId: admin,
        });
        collected.push(...page.userIds);
        afterUserId = page.next ?? undefined;
      } while (afterUserId !== undefined);
      expect(collected).toEqual([...members].sort());
    });

    it('leaves out, for a given message, members whose window starts after it', async () => {
      const owner = `window-${ids.next()}`;
      const early = `window-early-${ids.next()}`;
      const late = `window-late-${ids.next()}`;
      const conversation = group(owner, [early]);
      const id = conversation.conversation.id;
      await repository.createConversation(conversation);
      await repository.appendMessage(text(id, owner, 'before'));
      await repository.addParticipants({
        conversationId: id,
        userIds: [late],
        role: 'MEMBER',
        addedBy: owner,
        at: AT,
        capacity: 500,
      });
      await repository.appendMessage(text(id, owner, 'after'));

      const audience = async (visibleSequence: number) =>
        [...(await readModel.listMemberIds(id, { limit: 10, visibleSequence })).userIds].sort();
      expect(await audience(1)).toEqual([early, owner].sort());
      expect(await audience(2)).toEqual([early, late, owner].sort());
    });
  });

  describe('file assets', () => {
    it('completes an upload exactly once under concurrent completion', async () => {
      const assets = new DrizzleFileAssetRepository(scratch.db);
      const id = ids.next<'FileAsset'>() as FileAssetId;
      const pending = pendingAsset({
        id,
        ownerUserId: 'uploader',
        storageKey: `image/2026/09/${id}`,
        upload: {
          kind: 'IMAGE',
          contentType: 'image/png',
          byteSize: 64,
          displayName: 'a.png',
          durationMs: null,
          width: 10,
          height: 10,
        },
        at: AT,
      });
      await assets.create(pending);
      const available = expectOk(markAvailable(pending, AT));
      const wins = await Promise.all(
        Array.from({ length: 8 }, () => assets.transition(available, 'PENDING')),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(await assets.findById(id)).toMatchObject({ status: 'AVAILABLE', width: 10 });
      expect((await assets.findManyByIds([id, 'missing' as FileAssetId])).map((a) => a.id)).toEqual(
        [id],
      );
      expect((await pgError(assets.create({ ...pending, id: ids.next() }))).code).toBe('23505');
    });
  });

  describe('the use cases, end to end over Postgres', () => {
    it('runs a real exchange: group, text, image, read state, list', async () => {
      const h = await messagingHarness({ repository, readModel });
      try {
        const teacher = h.person(Roles.teacher, 'الأستاذ');
        const student = h.person(Roles.student, 'الطالب');
        const halaqa = await h.group(teacher, [student]);
        await h.text(teacher, halaqa.id, 'السلام عليكم');
        const photo = await h.files.upload(student, { kind: 'IMAGE', contentType: 'image/png' });
        expectOk(
          await h.sendImage.execute({
            principal: student,
            conversationId: halaqa.id,
            clientMessageId: 'pg-photo-000001',
            fileAssetId: photo.id,
            caption: 'واجبي',
            meta: META,
          }),
        );

        const page = expectOk(
          await h.listMessages.execute({ principal: teacher, conversationId: halaqa.id }),
        );
        expect(page.items.map((m) => [m.sequence, m.type, m.body])).toEqual([
          [1, 'TEXT', 'السلام عليكم'],
          [2, 'IMAGE', 'واجبي'],
        ]);
        expect(page.items[1]?.attachments[0]?.file?.kind).toBe('IMAGE');

        const list = expectOk(await h.listConversations.execute({ principal: teacher }));
        expect(list.items[0]).toMatchObject({
          id: halaqa.id,
          unreadCount: 1,
          lastMessage: { sequence: 2, senderName: 'الطالب', text: 'واجبي' },
        });
        expectOk(
          await h.markRead.execute({
            principal: teacher,
            conversationId: halaqa.id,
            sequence: 2,
            meta: META,
          }),
        );
        const after = expectOk(
          await h.getConversation.execute({ principal: teacher, conversationId: halaqa.id }),
        );
        expect(after.unreadCount).toBe(0);
      } finally {
        await h.cleanup();
      }
    });
  });
});
