import type { Principal } from '../../../shared';
import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import type { ConversationId } from '../domain/conversation';
import type { MessageId } from '../domain/message';
import { MessagingEvents } from '../contracts/events';
import { CONVERSATION_RESOURCE, MessagingAudit } from './messaging-settings';

/**
 * Pinning a message in a community's chat (ADR 0043), over the REAL
 * authorization of both modules. Pinning reuses the moderation authority
 * (`community.messages.moderate`): the owner implicitly, or a delegated
 * moderator; never a plain member, never a non-member, never a non-community
 * chat. A pin is a reference to a live message of THIS conversation, replacing
 * any current one; unpinning clears it and never deletes the message.
 */
describe('pinning a community chat message (ADR 0043)', () => {
  let h: MessagingHarness;
  let owner: Principal;
  let moderator: Principal; // a member, delegated community.messages.moderate
  let student: Principal; // a plain member
  let outsider: Principal; // holds communities.moderate, a member of nothing
  let communityId: string;
  let chatId: string;

  async function post(body = 'a message to pin'): Promise<string> {
    return (await h.text(owner, chatId, body)).message.id;
  }

  async function pinnedId(): Promise<string | null> {
    const conversation = await h.repository.findConversation(chatId as ConversationId);
    return conversation?.pinnedMessageId ?? null;
  }

  beforeEach(async () => {
    h = await messagingHarness();
    owner = h.person('ADMIN', 'Umm Salamah');
    moderator = h.person('TEACHER', 'Ustadh Bilal');
    student = h.person('STUDENT', 'Zayd');
    outsider = h.person('TEACHER', 'A teacher elsewhere');
    communityId = await h.community(owner, [moderator, student]);
    await h.communities.delegate(
      owner,
      communityId,
      moderator.userId,
      'community.messages.moderate',
    );
    await h.deliverCommunityEvents();
    chatId = (await h.openCommunityChat(owner, communityId)).id;
  });

  afterEach(() => h.cleanup());

  describe('authorization', () => {
    it('lets the owner pin a message, and records it', async () => {
      const messageId = await post();
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(await pinnedId()).toBe(messageId);
      expect(h.audit.entries).toContainEqual(
        expect.objectContaining({
          actorUserId: owner.userId,
          action: MessagingAudit.messagePinned,
          resourceType: CONVERSATION_RESOURCE,
          resourceId: chatId,
        }),
      );
    });

    it('lets a delegated moderator pin a message', async () => {
      const messageId = await post();
      expectOk(
        await h.pinMessage.execute({
          principal: moderator,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(await pinnedId()).toBe(messageId);
    });

    it('refuses a plain member (a student): 403, and nothing is pinned', async () => {
      const messageId = await post();
      const error = expectErr(
        await h.pinMessage.execute({
          principal: student,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'forbidden' });
      expect(await pinnedId()).toBeNull();
    });

    it('refuses a non-member with the 404 a non-member always hears', async () => {
      const messageId = await post();
      const error = expectErr(
        await h.pinMessage.execute({
          principal: outsider,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.conversation_not_found' });
    });

    it('404s a non-community conversation — pinning is a community-chat act only', async () => {
      const peer = h.person('TEACHER', 'A colleague');
      const direct = expectOk(
        await h.startDirect.execute({
          principal: owner,
          counterpartUserId: peer.userId,
          meta: META,
        }),
      );
      const message = (await h.text(owner, direct.conversation.id, 'hi')).message.id;
      const error = expectErr(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: direct.conversation.id,
          messageId: message,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.conversation_not_found' });
    });
  });

  describe('the pin target', () => {
    it('refuses a message from another conversation (no cross-conversation pin)', async () => {
      const other = await h.community(owner, []);
      await h.deliverCommunityEvents();
      const otherChat = (await h.openCommunityChat(owner, other)).id;
      const elsewhere = (await h.text(owner, otherChat, 'not here')).message.id;
      const error = expectErr(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: elsewhere,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.message_not_found' });
      expect(await pinnedId()).toBeNull();
    });

    it('404s an unknown message id', async () => {
      const error = expectErr(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: 'no-such-message',
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.message_not_found' });
    });

    it('refuses to pin a deleted (tombstoned) message', async () => {
      const messageId = await post();
      expectOk(
        await h.moderateMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      const error = expectErr(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.message_not_found' });
    });

    it('pins any supported message type — an image as readily as text', async () => {
      const photo = await h.files.upload(owner, { kind: 'IMAGE', contentType: 'image/png' });
      const image = expectOk(
        await h.sendImage.execute({
          principal: owner,
          conversationId: chatId,
          clientMessageId: 'pin-image-000000000000000000000000000',
          fileAssetId: photo.id,
          meta: META,
        }),
      );
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: image.message.id,
          meta: META,
        }),
      );
      expect(await pinnedId()).toBe(image.message.id);
    });
  });

  describe('idempotency and replacement', () => {
    it('a repeat pin of the same message changes nothing and is not re-recorded', async () => {
      const messageId = await post();
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      const before = h.audit.entries.filter(
        (r) => r.action === MessagingAudit.messagePinned,
      ).length;
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      const after = h.audit.entries.filter((r) => r.action === MessagingAudit.messagePinned).length;
      expect(after).toBe(before);
      expect(await pinnedId()).toBe(messageId);
    });

    it('pinning another message replaces the current pin (most-recent wins)', async () => {
      const first = await post('first');
      const second = await post('second');
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: first,
          meta: META,
        }),
      );
      expect(await pinnedId()).toBe(first);
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: second,
          meta: META,
        }),
      );
      expect(await pinnedId()).toBe(second);
    });
  });

  describe('unpinning', () => {
    it('clears the pin without deleting the message, and records it', async () => {
      const messageId = await post();
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expectOk(
        await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META }),
      );
      expect(await pinnedId()).toBeNull();
      // The original message is untouched: still a live message of the chat.
      const message = await h.repository.findMessage(
        chatId as ConversationId,
        messageId as MessageId,
      );
      expect(message?.deletedAt ?? null).toBeNull();
      expect(h.audit.entries).toContainEqual(
        expect.objectContaining({ action: MessagingAudit.messageUnpinned, resourceId: chatId }),
      );
    });

    it('a repeated unpin is idempotent', async () => {
      expectOk(
        await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META }),
      );
      expectOk(
        await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META }),
      );
      expect(await pinnedId()).toBeNull();
    });

    it('refuses a plain member to unpin: 403', async () => {
      const messageId = await post();
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      const error = expectErr(
        await h.unpinMessage.execute({ principal: student, conversationId: chatId, meta: META }),
      );
      expect(error).toMatchObject({ kind: 'forbidden' });
      expect(await pinnedId()).toBe(messageId);
    });
  });

  // Real-time synchronization (ADR 0043): a successful change publishes ONE
  // messaging.message.pinned event carrying the new authoritative id (or null) —
  // never content, never who pinned. No event on a refusal or an idempotent
  // no-op.
  describe('publishing the pin event', () => {
    const pinnedEvents = () =>
      h.events.published.filter((e) => e.name === MessagingEvents.messagePinned);

    it('a successful pin publishes the new id, after persistence', async () => {
      const messageId = await post();
      expectOk(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(pinnedEvents()).toHaveLength(1);
      expect(pinnedEvents()[0]).toMatchObject({
        name: MessagingEvents.messagePinned,
        aggregateId: chatId,
        payload: { conversationId: chatId, pinnedMessageId: messageId, pinVersion: 1 },
      });
      // The event never carries content or the actor.
      expect(JSON.stringify(pinnedEvents()[0])).not.toContain('a message to pin');
      expect(JSON.stringify(pinnedEvents()[0].payload)).not.toContain(owner.userId);
    });

    it('a successful unpin publishes pinnedMessageId: null', async () => {
      const messageId = await post();
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      expectOk(
        await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META }),
      );
      const last = pinnedEvents().at(-1);
      // The unpin is the second real change: pin bumped to 1, unpin to 2.
      expect(last).toMatchObject({
        payload: { conversationId: chatId, pinnedMessageId: null, pinVersion: 2 },
      });
    });

    it('replacing a pin publishes the replacement id and a strictly higher version', async () => {
      const first = await post('first');
      const second = await post('second');
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId: first,
        meta: META,
      });
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId: second,
        meta: META,
      });
      expect(pinnedEvents().map((e) => (e.payload as { pinVersion: number }).pinVersion)).toEqual([
        1, 2,
      ]);
      expect(pinnedEvents().at(-1)).toMatchObject({
        payload: { pinnedMessageId: second, pinVersion: 2 },
      });
    });

    it('a refused pin (a student) publishes no event', async () => {
      const messageId = await post();
      expectErr(
        await h.pinMessage.execute({
          principal: student,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(pinnedEvents()).toHaveLength(0);
    });

    it('an invalid or cross-conversation target publishes no event', async () => {
      expectErr(
        await h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: 'no-such-message',
          meta: META,
        }),
      );
      expect(pinnedEvents()).toHaveLength(0);
    });

    it('an idempotent repeat pin publishes no second event', async () => {
      const messageId = await post();
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      expect(pinnedEvents()).toHaveLength(1);
    });

    it('an idempotent unpin (nothing pinned) publishes no event', async () => {
      expectOk(
        await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META }),
      );
      expect(pinnedEvents()).toHaveLength(0);
    });
  });

  // The per-conversation pin version is the authoritative monotonic order the
  // client reconciles against. It advances by exactly one on every real change,
  // never on an idempotent no-op, and the version published in the event is the
  // one read from the same committed state as the pin id it carries.
  describe('the authoritative pin version', () => {
    const pinnedEvents = () =>
      h.events.published.filter((e) => e.name === MessagingEvents.messagePinned);
    const versionOf = (e: { payload: unknown }) => (e.payload as { pinVersion: number }).pinVersion;

    async function version(): Promise<number> {
      const conversation = await h.repository.findConversation(chatId as ConversationId);
      return conversation?.pinVersion ?? -1;
    }

    it('starts at zero and advances by one on each real change', async () => {
      const first = await post('first');
      const second = await post('second');
      expect(await version()).toBe(0);

      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId: first,
        meta: META,
      });
      expect(await version()).toBe(1);

      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId: second,
        meta: META,
      });
      expect(await version()).toBe(2);

      await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META });
      expect(await version()).toBe(3);
    });

    it('does not advance on an idempotent repeat pin', async () => {
      const messageId = await post();
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      expect(await version()).toBe(1);
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      // A re-pin of the already-pinned message is a no-op: no bump, no event.
      expect(await version()).toBe(1);
      expect(pinnedEvents()).toHaveLength(1);
    });

    it('does not advance on an idempotent unpin of an empty pin', async () => {
      await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META });
      expect(await version()).toBe(0);
      expect(pinnedEvents()).toHaveLength(0);
    });

    it('does not advance on a refused pin', async () => {
      const messageId = await post();
      expectErr(
        await h.pinMessage.execute({
          principal: student,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(await version()).toBe(0);
    });

    it('publishes the exact version that was committed, in increasing order', async () => {
      const first = await post('first');
      const second = await post('second');
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId: first,
        meta: META,
      });
      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId: second,
        meta: META,
      });
      await h.unpinMessage.execute({ principal: owner, conversationId: chatId, meta: META });
      const versions = pinnedEvents().map(versionOf);
      expect(versions).toEqual([1, 2, 3]);
      // The last published version equals the version now in committed state.
      expect(versions.at(-1)).toBe(await version());
    });

    it('serializes two competing pins into one surviving pin and a strict version order', async () => {
      const x = await post('X');
      const y = await post('Y');
      // Two moderators pin different messages "at once". The per-conversation
      // row lock serializes them; neither is lost, and the versions are
      // consecutive — the later commit wins the final state.
      await Promise.all([
        h.pinMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: x,
          meta: META,
        }),
        h.pinMessage.execute({
          principal: moderator,
          conversationId: chatId,
          messageId: y,
          meta: META,
        }),
      ]);
      const versions = pinnedEvents()
        .map(versionOf)
        .sort((a, b) => a - b);
      expect(versions).toEqual([1, 2]);
      // Exactly one message survives as THE pin, and it is one of the two.
      const finalId = await pinnedId();
      expect([x, y]).toContain(finalId);
      expect(await version()).toBe(2);
    });

    it('keeps every conversation version independent of the others', async () => {
      const otherChatId = (await h.openCommunityChat(owner, await h.community(owner, [student])))
        .id;
      const here = await post('here');
      const there = (await h.text(owner, otherChatId, 'there')).message.id;

      await h.pinMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId: here,
        meta: META,
      });
      await h.pinMessage.execute({
        principal: owner,
        conversationId: otherChatId,
        messageId: there,
        meta: META,
      });

      expect(await version()).toBe(1);
      const other = await h.repository.findConversation(otherChatId as ConversationId);
      expect(other?.pinVersion).toBe(1);
      expect(other?.pinnedMessageId).toBe(there);
    });
  });
});
