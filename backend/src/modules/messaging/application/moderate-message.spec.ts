import type { Principal } from '../../../shared';
import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { MessagingEvents } from '../contracts/events';
import { CONVERSATION_RESOURCE, MESSAGE_MODERATION, MessagingAudit } from './messaging-settings';

/**
 * Community message moderation (Q51/Q23, P12, ADR 0029), over the REAL
 * authorization of both modules: who may delete and review, that deletion is a
 * tombstone whose original is reviewable for exactly 7 days and then wiped, and
 * that moderation is a distinct authority — never chat read, never a projected
 * row. Communities answers every request; its wake-ups reach the chat
 * projection only when a test delivers them.
 */
describe('community message moderation (Q51/Q23)', () => {
  let h: MessagingHarness;
  let owner: Principal; // creates the community, so owns it — moderates implicitly
  let moderator: Principal; // a member, delegated community.messages.moderate
  let student: Principal; // a plain member: reads, never moderates
  let outsider: Principal; // holds communities.moderate, a member of nothing
  let communityId: string;
  let chatId: string;

  const DAY = 24 * 60 * 60;

  /** The owner posts a message to the chat and returns its id. */
  async function post(body = 'the secret message'): Promise<string> {
    return (await h.text(owner, chatId, body)).message.id;
  }

  /** The chat's messages as `viewer` sees them now. */
  async function timeline(viewer: Principal) {
    const page = expectOk(
      await h.listMessages.execute({ principal: viewer, conversationId: chatId }),
    );
    return page.items;
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
    it('lets the owner delete any message', async () => {
      const messageId = await post();
      expectOk(
        await h.moderateMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      const [message] = await timeline(owner);
      expect(message).toMatchObject({ id: messageId, body: null, attachments: [] });
      expect(message?.deletedAt).not.toBeNull();
    });

    it('lets a delegated moderator (a teacher) delete any message', async () => {
      const messageId = await post();
      expectOk(
        await h.moderateMessage.execute({
          principal: moderator,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect((await timeline(owner))[0]?.body).toBeNull();
    });

    it('refuses a plain member (a student): 403, and nothing is deleted', async () => {
      const messageId = await post();
      const error = expectErr(
        await h.moderateMessage.execute({
          principal: student,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({
        kind: 'forbidden',
        code: 'messaging.message_moderation_forbidden',
      });
      // Still the original: the student changed nothing.
      expect((await timeline(owner))[0]?.body).toBe('the secret message');
    });

    it('refuses a non-member with the same 404 a non-member always hears', async () => {
      const messageId = await post();
      const error = expectErr(
        await h.moderateMessage.execute({
          principal: outsider,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.conversation_not_found' });
      expect((await timeline(owner))[0]?.body).toBe('the secret message');
    });

    it('resolves the authority from the message’s own community — a grant elsewhere does not carry', async () => {
      // A second community where `moderator` is nothing, with its own chat and message.
      const otherOwner = h.person('ADMIN', 'Another owner');
      const otherCommunity = await h.community(otherOwner, []);
      await h.deliverCommunityEvents();
      const otherChat = (await h.openCommunityChat(otherOwner, otherCommunity)).id;
      const foreignMessage = (await h.text(otherOwner, otherChat, 'in the other room')).message.id;

      // The moderator holds community.messages.moderate in `communityId`, not here.
      const error = expectErr(
        await h.moderateMessage.execute({
          principal: moderator,
          conversationId: otherChat,
          messageId: foreignMessage,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.conversation_not_found' });
    });

    it('refuses to moderate a message in a private conversation — community chats only', async () => {
      const group = await h.group(owner, [student], 'A private group');
      const inGroup = (await h.text(owner, group.id, 'a private message')).message.id;
      const error = expectErr(
        await h.moderateMessage.execute({
          principal: owner,
          conversationId: group.id,
          messageId: inGroup,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.conversation_not_found' });
    });
  });

  describe('read isolation — moderation, read and review are three things', () => {
    it('a student reads the chat but may not review a deleted message', async () => {
      const messageId = await post();
      // The student can read the chat — membership grants that.
      expect(await timeline(student)).toHaveLength(1);
      await h.moderateMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      // …but reviewing the original needs community.messages.moderate, which the
      // student does not hold: reading never becomes reviewing.
      const error = expectErr(
        await h.reviewMessage.execute({
          principal: student,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({
        kind: 'forbidden',
        code: 'messaging.message_moderation_forbidden',
      });
    });

    it('a non-member may not review — 404, learning nothing', async () => {
      const messageId = await post();
      await h.moderateMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      const error = expectErr(
        await h.reviewMessage.execute({
          principal: outsider,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.conversation_not_found' });
    });
  });

  describe('deletion', () => {
    it('tombstones the message in normal history and never exposes the original', async () => {
      const messageId = await post('contact me at a bad place');
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });

      const [seen] = await timeline(student);
      expect(seen).toMatchObject({ id: messageId, body: null, attachments: [] });
      expect(seen?.deletedAt).not.toBeNull();
      // The original text is nowhere in what a normal reader receives, and the
      // moderator's id is not on the tombstone either.
      const serialized = JSON.stringify(await timeline(student));
      expect(serialized).not.toContain('contact me at a bad place');
      expect(serialized).not.toContain(moderator.userId);
    });

    it('is idempotent: a second delete changes nothing and raises no second event or audit', async () => {
      const messageId = await post();
      const first = await h.moderateMessage.execute({
        principal: owner,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      expectOk(first);
      const deletedEventsAfterFirst = h.events.published.filter(
        (event) => event.name === MessagingEvents.messageDeleted,
      ).length;
      const auditsAfterFirst = h.audit.entries.filter(
        (entry) => entry.action === MessagingAudit.moderationMessageDeleted,
      ).length;

      expectOk(
        await h.moderateMessage.execute({
          principal: moderator,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(
        h.events.published.filter((event) => event.name === MessagingEvents.messageDeleted),
      ).toHaveLength(deletedEventsAfterFirst);
      expect(
        h.audit.entries.filter((entry) => entry.action === MessagingAudit.moderationMessageDeleted),
      ).toHaveLength(auditsAfterFirst);
    });

    it('404s a message that is not in the conversation', async () => {
      const error = expectErr(
        await h.moderateMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId: 'no-such-message',
          meta: META,
        }),
      );
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.message_not_found' });
    });

    it('emits messaging.message.deleted with ids only — no body, no sender, no deleter', async () => {
      const messageId = await post('leak check');
      const sent = (await timeline(owner))[0];
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      const event = h.events.published.find((e) => e.name === MessagingEvents.messageDeleted);
      expect(event?.payload).toEqual({
        conversationId: chatId,
        messageId,
        sequence: sent?.sequence,
      });
      expect(JSON.stringify(event)).not.toContain('leak check');
      expect(JSON.stringify(event)).not.toContain(moderator.userId);
    });

    it('audits the deletion as moderation, naming the permit — the actor is the principal, never the request', async () => {
      const messageId = await post();
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      const entry = h.audit.last(MessagingAudit.moderationMessageDeleted);
      expect(entry).toMatchObject({
        actorUserId: moderator.userId,
        resourceType: CONVERSATION_RESOURCE,
        resourceId: chatId,
        correlationId: META.correlationId,
        metadata: {
          messageId,
          communityId,
          act: 'community.messages.moderate',
          basis: 'grant',
        },
      });
    });
  });

  describe('review', () => {
    it('reveals the original and the deleter within the window, and audits the disclosure', async () => {
      const messageId = await post('the original words');
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      h.clock.advance(6 * DAY);

      const reviewed = expectOk(
        await h.reviewMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(reviewed).toMatchObject({
        id: messageId,
        body: 'the original words',
        deletedBy: moderator.userId,
        deletedByName: 'Ustadh Bilal',
      });
      expect(reviewed.deletedAt).not.toBeNull();
      expect(h.audit.last(MessagingAudit.moderationMessageReviewed)).toMatchObject({
        actorUserId: owner.userId,
        resourceId: chatId,
        metadata: { messageId, act: 'community.messages.moderate' },
      });
    });

    it('refuses once the 7-day window has passed — the original is gone', async () => {
      const messageId = await post('words past their window');
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      h.clock.advance(MESSAGE_MODERATION.reviewWindowMs / 1000); // exactly 7 days later

      const error = expectErr(
        await h.reviewMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({
        kind: 'not_found',
        code: 'messaging.deleted_message_review_expired',
      });
    });

    it('has nothing to review for a message that is not deleted', async () => {
      const messageId = await post();
      const error = expectErr(
        await h.reviewMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(error).toMatchObject({
        kind: 'not_found',
        code: 'messaging.deleted_message_not_found',
      });
    });

    it('does not emit a deletion event — a review discloses, it does not re-delete', async () => {
      const messageId = await post();
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      const before = h.events.published.length;
      expectOk(
        await h.reviewMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(h.events.published).toHaveLength(before);
    });
  });

  // Replying to a deleted message is deliberately ALLOWED (a reply must not be a
  // way to probe which messages exist, and keeping the thread readable is the
  // intent): `checkReply` finds a tombstone like any other message. What must
  // never happen is the deleted content travelling back through that reply — the
  // reply carries only `replyToMessageId`, and the target reads as a tombstone.
  describe('replies to a deleted message (ADR 0029)', () => {
    it('accepts a reply to a deleted message, and the tombstone leaks nothing', async () => {
      const target = await post('the question that was deleted');
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId: target,
        meta: META,
      });

      // The reply is accepted and keeps its reference to the (now tombstoned) target.
      const reply = expectOk(
        await h.sendText.execute({
          principal: owner,
          conversationId: chatId,
          clientMessageId: 'reply-to-a-tombstone-text',
          body: 'a reply to a ghost',
          replyToMessageId: target,
          meta: META,
        }),
      );
      expect(reply.message.replyToMessageId).toBe(target);

      // The timeline shows the target as a content-free tombstone, the reply
      // pointing at it — and the deleted words appear nowhere, not even through
      // the reply's metadata.
      const items = await timeline(student);
      const tombstone = items.find((m) => m.id === target);
      expect(tombstone).toMatchObject({ body: null, attachments: [] });
      expect(tombstone?.deletedAt).not.toBeNull();
      expect(items.find((m) => m.id === reply.message.id)?.replyToMessageId).toBe(target);
      expect(JSON.stringify(items)).not.toContain('the question that was deleted');
    });

    it('accepts a reply to a deleted MEDIA message; no attachment reference survives', async () => {
      const image = await h.files.upload(owner, { kind: 'IMAGE', contentType: 'image/png' });
      const sent = expectOk(
        await h.sendImage.execute({
          principal: owner,
          conversationId: chatId,
          clientMessageId: 'media-target-to-delete',
          fileAssetId: image.id,
          caption: 'a caption that must not resurface',
          meta: META,
        }),
      );
      // The live message does carry the attachment, so the tombstone test is meaningful.
      expect(sent.message.attachments.map((a) => a.fileAssetId)).toEqual([image.id]);

      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId: sent.message.id,
        meta: META,
      });

      const reply = expectOk(
        await h.sendText.execute({
          principal: owner,
          conversationId: chatId,
          clientMessageId: 'reply-to-a-deleted-image',
          body: 'replying to the image',
          replyToMessageId: sent.message.id,
          meta: META,
        }),
      );
      expect(reply.message.replyToMessageId).toBe(sent.message.id);

      const items = await timeline(student);
      const tombstone = items.find((m) => m.id === sent.message.id);
      expect(tombstone).toMatchObject({ body: null, attachments: [] });
      // Neither the caption nor the file reference reaches a reader through the
      // tombstone or the reply that points at it.
      const serialized = JSON.stringify(items);
      expect(serialized).not.toContain('a caption that must not resurface');
      expect(serialized).not.toContain(image.id);
    });

    it('preserves an existing reply relationship when its target is later deleted', async () => {
      const target = await post('original words, soon to be gone');
      const reply = expectOk(
        await h.sendText.execute({
          principal: owner,
          conversationId: chatId,
          clientMessageId: 'reply-made-before-delete',
          body: 'my standing answer',
          replyToMessageId: target,
          meta: META,
        }),
      );

      // Now the target is moderated away.
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId: target,
        meta: META,
      });

      // The reply survives intact and still points at the target; the target is
      // a tombstone and its words are gone from every read path.
      const items = await timeline(student);
      expect(items.find((m) => m.id === target)).toMatchObject({ body: null, attachments: [] });
      const seenReply = items.find((m) => m.id === reply.message.id);
      expect(seenReply?.body).toBe('my standing answer');
      expect(seenReply?.replyToMessageId).toBe(target);
      expect(JSON.stringify(items)).not.toContain('original words, soon to be gone');
    });
  });

  describe('retention', () => {
    /** Wipe everything retention finds now; returns messages wiped. */
    async function sweep(): Promise<number> {
      const report = await h.retentionSweeper.tick();
      return report?.wiped ?? -1;
    }

    it('wipes an expired deleted message’s content but keeps its tombstone', async () => {
      const messageId = await post('to be forgotten');
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });
      h.clock.advance(8 * DAY);

      expect(await sweep()).toBe(1);
      // The tombstone remains in history; the original is unrecoverable, even
      // to the moderator — the review window is closed and the content is gone.
      const [seen] = await timeline(student);
      expect(seen).toMatchObject({ id: messageId, body: null });
      expect(seen?.deletedAt).not.toBeNull();
      const raw = await h.repository.findMessage(chatId as never, messageId as never);
      expect(raw?.body).toBeNull();
      expect(raw?.deletedAt).not.toBeNull();
    });

    it('leaves a not-yet-expired deleted message and a live message untouched', async () => {
      const expiring = await post('still reviewable');
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId: expiring,
        meta: META,
      });
      const live = await post('a normal message');
      h.clock.advance(3 * DAY); // well within the 7-day window

      expect(await sweep()).toBe(0);
      const raw = await h.repository.findMessage(chatId as never, expiring as never);
      expect(raw?.body).toBe('still reviewable'); // reviewable content intact
      expect((await timeline(owner)).find((m) => m.id === live)?.body).toBe('a normal message');
    });

    it('draws the 7-day boundary deterministically — reviewable-and-kept just before, gone just after', async () => {
      const messageId = await post('boundary words');
      await h.moderateMessage.execute({
        principal: moderator,
        conversationId: chatId,
        messageId,
        meta: META,
      });

      // One second before the boundary: still reviewable, and retention skips it.
      h.clock.advance(MESSAGE_MODERATION.reviewWindowMs / 1000 - 1);
      expectOk(
        await h.reviewMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(await sweep()).toBe(0);

      // At the boundary: no longer reviewable, and retention wipes it.
      h.clock.advance(1);
      expectErr(
        await h.reviewMessage.execute({
          principal: owner,
          conversationId: chatId,
          messageId,
          meta: META,
        }),
      );
      expect(await sweep()).toBe(1);
    });
  });
});
