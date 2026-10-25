import { sql } from 'drizzle-orm';

import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { Roles } from '../../src/modules/identity/domain/role';
import {
  newGroupConversation,
  type ConversationId,
  type NewConversation,
} from '../../src/modules/messaging/domain/conversation';
import { textDraft } from '../../src/modules/messaging/domain/message';
import { DrizzleMessagingReadModel } from '../../src/modules/messaging/infrastructure/drizzle-messaging-read-model';
import { DrizzleMessagingRepository } from '../../src/modules/messaging/infrastructure/drizzle-messaging-repository';
import { expectErr, expectOk } from '../support/identity-harness';
import { META, messagingHarness, type MessagingHarness } from '../support/messaging-harness';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

const ids = new UuidIdGenerator();
const AT = new Date('2026-10-25T08:00:00.000Z');

function created<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const group = (owner: string, members: string[]): NewConversation =>
  created(
    newGroupConversation({
      id: ids.next<'Conversation'>(),
      creator: owner,
      title: 'Halaqa',
      memberIds: members,
      at: AT,
    }),
  );

/**
 * An author's own edit and delete (ADR 0045) on the real schema: the
 * conditional UPDATE that never revives a tombstone, whatever races it; the
 * edit stamp and the unchanged attachments; and the use cases end to end on
 * Postgres — the author edits and deletes in a group, nobody else does.
 */
describeWithPostgres('message edit and author delete on Postgres (ADR 0045)', () => {
  let scratch: ScratchDatabase;
  let repository: DrizzleMessagingRepository;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  beforeAll(async () => {
    scratch = await scratchDatabase();
    repository = new DrizzleMessagingRepository(scratch.db);
  }, 60_000);

  afterAll(async () => {
    await scratch.drop();
  });

  async function stored(author: string, body: string) {
    const conversation = group(author, []);
    await repository.createConversation(conversation);
    const outcome = await repository.appendMessage(
      created(
        textDraft({
          id: ids.next<'Message'>(),
          conversationId: conversation.conversation.id,
          senderId: author,
          clientMessageId: ids.next(),
          replyToMessageId: null,
          body,
          at: AT,
        }),
      ),
    );
    if (outcome.kind !== 'appended') throw new Error(outcome.kind);
    return { conversationId: conversation.conversation.id, message: outcome.message };
  }

  describe('the repository', () => {
    it('edits only the author’s own, stamps editedAt, and keeps sequence and order', async () => {
      const author = `edit-a-${ids.next()}`;
      const { conversationId, message } = await stored(author, 'before');
      const at = new Date('2026-10-25T08:05:00.000Z');

      expect(
        await repository.editMessage({
          conversationId,
          messageId: message.id,
          authorId: `someone-else-${ids.next()}`,
          body: 'hijack',
          at,
        }),
      ).toEqual({ kind: 'not_found' });

      const edited = await repository.editMessage({
        conversationId,
        messageId: message.id,
        authorId: author,
        body: 'after',
        at,
      });
      expect(edited).toMatchObject({
        kind: 'edited',
        message: { body: 'after', sequence: message.sequence, editedAt: at },
      });
      const [row] = await rows<{ body: string; edited_ms: string; sequence: string }>(sql`
        select body, (extract(epoch from edited_at) * 1000)::bigint::text as edited_ms,
          sequence::text from messages where id = ${message.id}`);
      expect(row).toEqual({
        body: 'after',
        edited_ms: String(at.getTime()),
        sequence: String(message.sequence),
      });

      expect(
        await repository.editMessage({
          conversationId,
          messageId: message.id,
          authorId: author,
          body: 'after',
          at: new Date('2026-10-25T08:06:00.000Z'),
        }),
      ).toMatchObject({ kind: 'unchanged', message: { editedAt: at } });
    });

    it('never finds a message through another conversation', async () => {
      const author = `edit-x-${ids.next()}`;
      const first = await stored(author, 'in the first');
      const second = await stored(author, 'in the second');
      expect(
        await repository.editMessage({
          conversationId: second.conversationId,
          messageId: first.message.id,
          authorId: author,
          body: 'moved',
          at: AT,
        }),
      ).toEqual({ kind: 'not_found' });
    });

    it('lets a delete win every race with edits: the tombstone is never revived', async () => {
      const author = `race-${ids.next()}`;
      for (let round = 0; round < 10; round++) {
        const { conversationId, message } = await stored(author, `round ${round}`);
        const at = new Date(AT.getTime() + 60_000);
        const work = [
          ...Array.from({ length: 5 }, (_, i) =>
            repository.editMessage({
              conversationId,
              messageId: message.id,
              authorId: author,
              body: `edit ${round}.${i}`,
              at,
            }),
          ),
          repository.softDeleteMessage({
            conversationId,
            messageId: message.id,
            deletedBy: author,
            at,
          }),
        ];
        await Promise.all(work);
        // Whatever order the statements landed in, the row is a deletion now —
        // and an edit after it changes nothing.
        expect(
          await repository.editMessage({
            conversationId,
            messageId: message.id,
            authorId: author,
            body: 'too late',
            at,
          }),
        ).toEqual({ kind: 'deleted' });
        const [row] = await rows<{
          deleted_at: Date | null;
          deleted_by: string | null;
          body: string;
        }>(sql`select deleted_at, deleted_by, body from messages where id = ${message.id}`);
        expect(row?.deleted_at).not.toBeNull();
        expect(row?.deleted_by).toBe(author);
        expect(row?.body).not.toBe('too late');
      }
    });

    it('serializes concurrent edits: exactly one stored text, one of those written', async () => {
      const author = `edits-${ids.next()}`;
      const { conversationId, message } = await stored(author, 'v0');
      const bodies = Array.from({ length: 12 }, (_, i) => `v${i + 1}`);
      const outcomes = await Promise.all(
        bodies.map((body, i) =>
          repository.editMessage({
            conversationId,
            messageId: message.id,
            authorId: author,
            body,
            at: new Date(AT.getTime() + (i + 1) * 1000),
          }),
        ),
      );
      expect(outcomes.every((outcome) => outcome.kind === 'edited')).toBe(true);
      const [row] = await rows<{ body: string }>(
        sql`select body from messages where id = ${message.id}`,
      );
      expect(bodies).toContain(row?.body);
    });
  });

  describe('the use cases, on Postgres', () => {
    let h: MessagingHarness;

    beforeAll(async () => {
      h = await messagingHarness({
        repository: new DrizzleMessagingRepository(scratch.db),
        readModel: new DrizzleMessagingReadModel(scratch.db),
      });
    });

    afterAll(() => h.cleanup());

    it('the author edits and deletes in a group; another member does neither', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const conversationId = group.id as ConversationId;
      const sent = await h.text(student, conversationId, 'كتبتها خطأ');

      const notMine = expectErr(
        await h.editMessage.execute({
          principal: teacher,
          conversationId,
          messageId: sent.message.id,
          body: 'تعديل من غير الكاتب',
          meta: META,
        }),
      );
      expect(notMine.code).toBe('messaging.message_not_found');
      expect(
        expectErr(
          await h.deleteMessage.execute({
            principal: teacher,
            conversationId,
            messageId: sent.message.id,
            meta: META,
          }),
        ).code,
      ).toBe('messaging.conversation_not_found');

      const edited = expectOk(
        await h.editMessage.execute({
          principal: student,
          conversationId,
          messageId: sent.message.id,
          body: 'كتبتها صحيحة',
          meta: META,
        }),
      );
      expect(edited.body).toBe('كتبتها صحيحة');
      expect(edited.editedAt).not.toBeNull();

      expectOk(
        await h.deleteMessage.execute({
          principal: student,
          conversationId,
          messageId: sent.message.id,
          meta: META,
        }),
      );
      const page = expectOk(await h.listMessages.execute({ principal: teacher, conversationId }));
      const tombstone = page.items.find((item) => item.id === sent.message.id);
      expect(tombstone).toMatchObject({ body: null, attachments: [] });
      expect(tombstone?.deletedAt).not.toBeNull();
      const [row] = await rows<{ deleted_by: string }>(
        sql`select deleted_by from messages where id = ${sent.message.id}`,
      );
      expect(row?.deleted_by).toBe(student.userId);
    });
  });
});
