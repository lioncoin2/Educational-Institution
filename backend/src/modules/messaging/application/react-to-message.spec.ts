import type { Principal } from '../../../shared';
import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import type { MessageId } from '../domain/message';

/**
 * Toggling a reaction on a message, over the REAL authorization. A reaction
 * rides the send seam — a member who may post here may react — and is a toggle:
 * the same emoji again removes it, a different one swaps it. The counts it
 * reports are authoritative, and `mine` is the viewer's own.
 */
describe('reacting to a message (chat reactions)', () => {
  let h: MessagingHarness;
  let owner: Principal;
  let member: Principal;
  let outsider: Principal;
  let chatId: string;
  let messageId: string;

  async function reactionsFor(userId: string) {
    const map = await h.readModel.reactionsOf([messageId as MessageId], userId);
    return map.get(messageId) ?? [];
  }

  beforeEach(async () => {
    h = await messagingHarness();
    owner = h.person('ADMIN', 'Umm Salamah');
    member = h.person('STUDENT', 'Zayd');
    outsider = h.person('TEACHER', 'Elsewhere');
    const communityId = await h.community(owner, [member]);
    await h.deliverCommunityEvents();
    chatId = (await h.openCommunityChat(owner, communityId)).id;
    messageId = (await h.text(owner, chatId, 'a message to react to')).message.id;
  });

  const react = (who: Principal, emoji: string) =>
    h.reactToMessage.execute({
      principal: who,
      conversationId: chatId,
      messageId,
      emoji,
      meta: META,
    });

  it('adds a member reaction, with counts and `mine`', async () => {
    expectOk(await react(member, '👍'));
    const mine = await reactionsFor(member.userId);
    expect(mine).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    // Another viewer sees the same count, but not as theirs.
    const theirs = await reactionsFor(owner.userId);
    expect(theirs).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('toggles the same emoji off', async () => {
    expectOk(await react(member, '❤️'));
    expectOk(await react(member, '❤️'));
    expect(await reactionsFor(member.userId)).toEqual([]);
  });

  it('swaps to a different emoji (still one per member)', async () => {
    expectOk(await react(member, '👍'));
    expectOk(await react(member, '😂'));
    expect(await reactionsFor(member.userId)).toEqual([{ emoji: '😂', count: 1, mine: true }]);
  });

  it('counts two members on the same emoji', async () => {
    expectOk(await react(owner, '🙏'));
    expectOk(await react(member, '🙏'));
    const view = await reactionsFor(owner.userId);
    expect(view).toEqual([{ emoji: '🙏', count: 2, mine: true }]);
  });

  it('rejects an emoji outside the set (422), storing nothing', async () => {
    expect(expectErr(await react(member, '🍕')).code).toBe('messaging.reaction_invalid');
    expect(await reactionsFor(member.userId)).toEqual([]);
  });

  it('refuses a non-member (they cannot post here)', async () => {
    expectErr(await react(outsider, '👍'));
    expect(await reactionsFor(outsider.userId)).toEqual([]);
  });

  it('reports message_not_found for an unknown message', async () => {
    const result = await h.reactToMessage.execute({
      principal: owner,
      conversationId: chatId,
      messageId: 'no-such-message',
      emoji: '👍',
      meta: META,
    });
    expect(expectErr(result).code).toBe('messaging.message_not_found');
  });

  it('sends a new message without reading reactions — it has none yet', async () => {
    const read = jest.spyOn(h.readModel, 'reactionsOf');
    const sent = await h.text(owner, chatId, 'a fresh one');
    expect(sent.created).toBe(true);
    expect(sent.message.reactions).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('shows a retried send the reactions its message received since', async () => {
    const first = await h.text(owner, chatId, 'sent twice', 'retried-send');
    expectOk(
      await h.reactToMessage.execute({
        principal: member,
        conversationId: chatId,
        messageId: first.message.id,
        emoji: '👍',
        meta: META,
      }),
    );
    const again = await h.text(owner, chatId, 'sent twice', 'retried-send');
    expect(again.created).toBe(false);
    expect(again.message.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('keeps reactions scoped to their conversation', async () => {
    expectOk(await react(member, '👍'));
    // A different conversation id for the same message id finds nothing live.
    const elsewhere = await h.reactToMessage.execute({
      principal: owner,
      conversationId: 'another-conversation',
      messageId,
      emoji: '👍',
      meta: META,
    });
    expectErr(elsewhere);
  });
});
