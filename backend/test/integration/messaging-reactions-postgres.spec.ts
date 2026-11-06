import { sql } from 'drizzle-orm';

import {
  newGroupConversation,
  type NewConversation,
} from '../../src/modules/messaging/domain/conversation';
import { textDraft, type MessageId } from '../../src/modules/messaging/domain/message';
import { DrizzleMessagingReadModel } from '../../src/modules/messaging/infrastructure/drizzle-messaging-read-model';
import { DrizzleMessagingRepository } from '../../src/modules/messaging/infrastructure/drizzle-messaging-repository';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

const ids = new UuidIdGenerator();
const AT = new Date('2026-11-06T08:00:00.000Z');

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
 * Chat reactions on the real schema: the toggle (add → swap → off) under the
 * primary key that keeps one reaction per member per message; the aggregated
 * counts and `mine` the read model builds for a viewer; the `message_not_found`
 * for a cross-conversation id; and two simultaneous toggles by one member
 * settling to a single reaction (the message-row lock serializes them).
 */
describeWithPostgres('message reactions on Postgres', () => {
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

  async function stored(author: string, members: string[] = []) {
    const conversation = group(author, members);
    await repository.createConversation(conversation);
    const outcome = await repository.appendMessage(
      created(
        textDraft({
          id: ids.next<'Message'>(),
          conversationId: conversation.conversation.id,
          senderId: author,
          clientMessageId: ids.next(),
          replyToMessageId: null,
          body: 'react to me',
          at: AT,
        }),
      ),
    );
    if (outcome.kind !== 'appended') throw new Error(outcome.kind);
    return {
      conversationId: conversation.conversation.id,
      messageId: outcome.message.id,
    };
  }

  const react = (conversationId: string, messageId: MessageId, userId: string, emoji: string) =>
    repository.react({ conversationId: conversationId as never, messageId, userId, emoji, at: AT });

  const viewOf = async (messageId: MessageId, viewer: string) =>
    (await readModel.reactionsOf([messageId], viewer)).get(messageId) ?? [];

  it('adds, swaps and toggles off — one row per member', async () => {
    const u = `u-${ids.next()}`;
    const { conversationId, messageId } = await stored(u);
    expect((await react(conversationId, messageId, u, '👍')).kind).toBe('changed');
    expect(await viewOf(messageId, u)).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    await react(conversationId, messageId, u, '😂'); // swap
    expect(await viewOf(messageId, u)).toEqual([{ emoji: '😂', count: 1, mine: true }]);
    await react(conversationId, messageId, u, '😂'); // same again → off
    expect(await viewOf(messageId, u)).toEqual([]);
    const [{ n }] = await rows<{ n: number }>(
      sql`select count(*)::int as n from message_reactions where message_id = ${messageId}`,
    );
    expect(n).toBe(0);
  });

  it('counts distinct members and marks `mine` per viewer', async () => {
    const a = `a-${ids.next()}`;
    const b = `b-${ids.next()}`;
    const { conversationId, messageId } = await stored(a, [b]);
    await react(conversationId, messageId, a, '🙏');
    await react(conversationId, messageId, b, '🙏');
    expect(await viewOf(messageId, a)).toEqual([{ emoji: '🙏', count: 2, mine: true }]);
    expect(await viewOf(messageId, `c-${ids.next()}`)).toEqual([
      { emoji: '🙏', count: 2, mine: false },
    ]);
  });

  it('is message_not_found for a cross-conversation id', async () => {
    const u = `u-${ids.next()}`;
    const { conversationId } = await stored(u);
    expect((await react(conversationId, 'no-such-message' as MessageId, u, '👍')).kind).toBe(
      'message_not_found',
    );
  });

  it('two simultaneous toggles by one member settle to a single reaction', async () => {
    const u = `race-${ids.next()}`;
    const { conversationId, messageId } = await stored(u);
    await Promise.all([
      react(conversationId, messageId, u, '👍'),
      react(conversationId, messageId, u, '❤️'),
    ]);
    const total = (await viewOf(messageId, u)).reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(1);
  });
});
