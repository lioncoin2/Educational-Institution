import type { Principal } from '../../../shared';
import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { Roles } from '../../identity/domain/role';
import { MessagingEvents } from '../contracts/events';
import { CONVERSATION_RESOURCE, MessagingAudit } from './messaging-settings';

/**
 * An author's own edit and delete (owner decision D, ADR 0045), over the REAL
 * authorization of messaging and Communities: authors edit and delete their own
 * messages in direct conversations, groups, channels and community chats;
 * nobody edits anyone else's — a moderator included; moderators still delete
 * in their own community's chat, and nowhere else.
 */
describe('editing and deleting one’s own message (ADR 0045)', () => {
  let h: MessagingHarness;

  beforeEach(async () => {
    h = await messagingHarness();
  });

  afterEach(() => h.cleanup());

  const edit = (principal: Principal, conversationId: string, messageId: string, body: string) =>
    h.editMessage.execute({ principal, conversationId, messageId, body, meta: META });

  const remove = (principal: Principal, conversationId: string, messageId: string) =>
    h.deleteMessage.execute({ principal, conversationId, messageId, meta: META });

  async function seen(viewer: Principal, conversationId: string, messageId: string) {
    const page = expectOk(await h.listMessages.execute({ principal: viewer, conversationId }));
    return page.items.find((item) => item.id === messageId);
  }

  const eventsNamed = (name: string) => h.events.published.filter((event) => event.name === name);

  describe('the author edits, in every kind of conversation', () => {
    it('in a direct conversation: new text, editedAt stamped, everyone reads it', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'first words');
      h.clock.advance(30);

      const edited = expectOk(await edit(student, dm.id, sent.message.id, 'better words'));
      expect(edited).toMatchObject({ id: sent.message.id, body: 'better words' });
      expect(edited.editedAt).toEqual(h.clock.now());
      // The counterpart reads the new text; the sequence and order are unchanged.
      expect(await seen(teacher, dm.id, sent.message.id)).toMatchObject({
        body: 'better words',
        sequence: sent.message.sequence,
        editedAt: h.clock.now(),
      });
    });

    it('in a group', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const sent = await h.text(student, group.id, 'a typo');
      expectOk(await edit(student, group.id, sent.message.id, 'no typo'));
      expect((await seen(teacher, group.id, sent.message.id))?.body).toBe('no typo');
    });

    it('in a channel, as a publisher', async () => {
      const admin = h.person(Roles.admin);
      const reader = h.person(Roles.student);
      const channel = expectOk(
        await h.createChannel.execute({
          principal: admin,
          title: 'News',
          memberIds: [reader.userId],
          publisherIds: [],
          meta: META,
        }),
      );
      const sent = await h.text(admin, channel.id, 'Tomorrow at 8');
      expectOk(await edit(admin, channel.id, sent.message.id, 'Tomorrow at 9'));
      expect((await seen(reader, channel.id, sent.message.id))?.body).toBe('Tomorrow at 9');
    });

    it('in a community chat, as a member who may post', async () => {
      const owner = h.person(Roles.admin);
      const member = h.person(Roles.student);
      const communityId = await h.community(owner, [member]);
      await h.deliverCommunityEvents();
      const chat = await h.openCommunityChat(owner, communityId);
      const sent = await h.text(member, chat.id, 'salaam');
      expectOk(await edit(member, chat.id, sent.message.id, 'as-salaamu alaykum'));
      expect((await seen(owner, chat.id, sent.message.id))?.body).toBe('as-salaamu alaykum');
    });

    it('audits the edit without its text and announces it with ids only', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'the old text');
      expectOk(await edit(student, dm.id, sent.message.id, 'the new text'));

      const entry = h.audit.last(MessagingAudit.messageEdited);
      expect(entry).toMatchObject({
        actorUserId: student.userId,
        resourceType: CONVERSATION_RESOURCE,
        resourceId: dm.id,
        metadata: { messageId: sent.message.id, sequence: sent.message.sequence },
      });
      const [event] = eventsNamed(MessagingEvents.messageEdited);
      expect(event?.payload).toEqual({
        conversationId: dm.id,
        messageId: sent.message.id,
        sequence: sent.message.sequence,
      });
      // Neither text leaves messaging in the audit trail or the event.
      const leaked = JSON.stringify([entry, event]);
      expect(leaked).not.toContain('the old text');
      expect(leaked).not.toContain('the new text');
    });

    it('changes nothing for the same text: no stamp, no audit, no event', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'unchanged');
      const result = expectOk(await edit(student, dm.id, sent.message.id, '  unchanged  '));
      expect(result.editedAt).toBeNull();
      expect(h.audit.last(MessagingAudit.messageEdited)).toBeUndefined();
      expect(eventsNamed(MessagingEvents.messageEdited)).toHaveLength(0);
    });

    it('keeps text a text message needs, and bounds it as a send does', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'words');
      expect(expectErr(await edit(student, dm.id, sent.message.id, '   ')).code).toBe(
        'messaging.body_required',
      );
      expect(expectErr(await edit(student, dm.id, sent.message.id, 'x'.repeat(4001))).code).toBe(
        'messaging.body_too_long',
      );
      expect((await seen(teacher, dm.id, sent.message.id))?.body).toBe('words');
    });

    it('edits a media caption — and may clear it — but never its attachment', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const photo = await h.files.upload(student, { kind: 'IMAGE', contentType: 'image/png' });
      const sent = expectOk(
        await h.sendImage.execute({
          principal: student,
          conversationId: dm.id,
          clientMessageId: 'edit-caption-photo-000000000000000',
          fileAssetId: photo.id,
          caption: 'old caption',
          meta: META,
        }),
      );
      const recaptioned = expectOk(await edit(student, dm.id, sent.message.id, 'new caption'));
      expect(recaptioned.body).toBe('new caption');
      expect(recaptioned.attachments.map((a) => a.fileAssetId)).toEqual([photo.id]);

      const cleared = expectOk(await edit(student, dm.id, sent.message.id, ''));
      expect(cleared.body).toBeNull();
      expect(cleared.attachments.map((a) => a.fileAssetId)).toEqual([photo.id]);
      expect(await seen(teacher, dm.id, sent.message.id)).toMatchObject({
        type: 'IMAGE',
        body: null,
      });
    });
  });

  describe('nobody else edits', () => {
    it('another member’s edit is the 404 a missing message is, and nothing changes', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const sent = await h.text(student, group.id, 'mine');
      const error = expectErr(await edit(teacher, group.id, sent.message.id, 'yours now'));
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.message_not_found' });
      expect((await seen(student, group.id, sent.message.id))?.body).toBe('mine');
    });

    it('a community chat’s owner and a delegated moderator delete — and still may not edit', async () => {
      const owner = h.person(Roles.admin);
      const moderator = h.person(Roles.teacher);
      const member = h.person(Roles.student);
      const communityId = await h.community(owner, [moderator, member]);
      await h.communities.delegate(
        owner,
        communityId,
        moderator.userId,
        'community.messages.moderate',
      );
      await h.deliverCommunityEvents();
      const chat = await h.openCommunityChat(owner, communityId);
      const sent = await h.text(member, chat.id, 'a member speaks');

      for (const actor of [owner, moderator]) {
        const error = expectErr(await edit(actor, chat.id, sent.message.id, 'rewritten'));
        expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.message_not_found' });
      }
      expect((await seen(owner, chat.id, sent.message.id))?.body).toBe('a member speaks');
      // …but the moderator may delete it: moderation is deletion, not editing.
      expectOk(await remove(moderator, chat.id, sent.message.id));
      expect((await seen(owner, chat.id, sent.message.id))?.body).toBeNull();
      expect(h.audit.last(MessagingAudit.moderationMessageDeleted)).toMatchObject({
        actorUserId: moderator.userId,
      });
    });

    it('a non-member hears the 404 everyone outside hears', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const outsider = h.person(Roles.teacher);
      const group = await h.group(teacher, [student]);
      const sent = await h.text(student, group.id, 'members only');
      const error = expectErr(await edit(outsider, group.id, sent.message.id, 'hijacked'));
      expect(error).toMatchObject({ kind: 'not_found', code: 'messaging.conversation_not_found' });
    });

    it('an author removed from the conversation may no longer edit or delete there', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const sent = await h.text(student, group.id, 'said while a member');
      expectOk(
        await h.removeParticipant.execute({
          principal: teacher,
          conversationId: group.id,
          userId: student.userId,
          meta: META,
        }),
      );
      expect(expectErr(await edit(student, group.id, sent.message.id, 'after')).code).toBe(
        'messaging.conversation_not_found',
      );
      expect(expectErr(await remove(student, group.id, sent.message.id)).code).toBe(
        'messaging.conversation_not_found',
      );
      expect((await seen(teacher, group.id, sent.message.id))?.body).toBe('said while a member');
    });

    it('a message id from another conversation is not found here', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const first = await h.group(teacher, [student], 'first');
      const second = await h.group(teacher, [student], 'second');
      const sent = await h.text(student, first.id, 'in the first');
      expect(expectErr(await edit(student, second.id, sent.message.id, 'moved')).code).toBe(
        'messaging.message_not_found',
      );
      expect(expectErr(await remove(student, second.id, sent.message.id)).code).toBe(
        'messaging.conversation_not_found',
      );
      expect((await seen(teacher, first.id, sent.message.id))?.body).toBe('in the first');
    });
  });

  describe('the author deletes, in every kind of conversation', () => {
    it('in a direct conversation and a group: a tombstone everyone sees, audited as the author’s own', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const group = await h.group(teacher, [student]);
      for (const conversationId of [dm.id, group.id]) {
        const sent = await h.text(student, conversationId, 'regretted words');
        expectOk(await remove(student, conversationId, sent.message.id));
        const tombstone = await seen(teacher, conversationId, sent.message.id);
        expect(tombstone).toMatchObject({ body: null, attachments: [] });
        expect(tombstone?.deletedAt).not.toBeNull();
        expect(h.audit.last(MessagingAudit.messageDeletedByAuthor)).toMatchObject({
          actorUserId: student.userId,
          resourceId: conversationId,
          metadata: { messageId: sent.message.id, sequence: sent.message.sequence },
        });
      }
      const deleted = eventsNamed(MessagingEvents.messageDeleted);
      expect(deleted).toHaveLength(2);
      expect(JSON.stringify(deleted)).not.toContain('regretted words');
      // Not moderation: nothing was recorded as a moderator's act.
      expect(h.audit.last(MessagingAudit.moderationMessageDeleted)).toBeUndefined();
    });

    it('in a community chat, as a plain member', async () => {
      const owner = h.person(Roles.admin);
      const member = h.person(Roles.student);
      const communityId = await h.community(owner, [member]);
      await h.deliverCommunityEvents();
      const chat = await h.openCommunityChat(owner, communityId);
      const sent = await h.text(member, chat.id, 'my own words');
      expectOk(await remove(member, chat.id, sent.message.id));
      expect((await seen(owner, chat.id, sent.message.id))?.body).toBeNull();
    });

    it('is idempotent: a second delete changes nothing and announces nothing', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'once');
      expectOk(await remove(student, dm.id, sent.message.id));
      expectOk(await remove(student, dm.id, sent.message.id));
      expect(eventsNamed(MessagingEvents.messageDeleted)).toHaveLength(1);
    });

    it('a deleted message can no longer be edited (409) and stays deleted', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'gone soon');
      expectOk(await remove(student, dm.id, sent.message.id));
      const error = expectErr(await edit(student, dm.id, sent.message.id, 'revived?'));
      expect(error).toMatchObject({ kind: 'conflict', code: 'messaging.message_deleted' });
      expect((await seen(teacher, dm.id, sent.message.id))?.body).toBeNull();
    });

    it('another member’s message in a private conversation stays theirs: 404, nothing deleted', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const sent = await h.text(student, group.id, 'the student’s');
      // Even the group's owner: moderation is a community-chat authority only.
      expect(expectErr(await remove(teacher, group.id, sent.message.id)).code).toBe(
        'messaging.conversation_not_found',
      );
      expect((await seen(teacher, group.id, sent.message.id))?.body).toBe('the student’s');
    });

    it('a plain member may not delete someone else’s message in a community chat', async () => {
      const owner = h.person(Roles.admin);
      const member = h.person(Roles.student);
      const communityId = await h.community(owner, [member]);
      await h.deliverCommunityEvents();
      const chat = await h.openCommunityChat(owner, communityId);
      const sent = await h.text(owner, chat.id, 'the owner’s');
      expect(expectErr(await remove(member, chat.id, sent.message.id))).toMatchObject({
        kind: 'forbidden',
        code: 'messaging.message_moderation_forbidden',
      });
    });
  });

  describe('concurrency', () => {
    it('an edit racing a delete never revives the tombstone', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'racing');
      const [edited, deleted] = await Promise.all([
        edit(student, dm.id, sent.message.id, 'edited in the race'),
        remove(student, dm.id, sent.message.id),
      ]);
      expectOk(deleted);
      // Whichever ran first, the delete wins: the message is a tombstone now.
      if (!edited.ok) expect(edited.error.code).toBe('messaging.message_deleted');
      const after = await seen(teacher, dm.id, sent.message.id);
      expect(after?.body).toBeNull();
      expect(after?.deletedAt).not.toBeNull();
    });

    it('two edits: the last one written is what everyone reads', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(student, teacher);
      const sent = await h.text(student, dm.id, 'v1');
      expectOk(await edit(student, dm.id, sent.message.id, 'v2'));
      h.clock.advance(5);
      expectOk(await edit(student, dm.id, sent.message.id, 'v3'));
      expect(await seen(teacher, dm.id, sent.message.id)).toMatchObject({
        body: 'v3',
        editedAt: h.clock.now(),
      });
      expect(eventsNamed(MessagingEvents.messageEdited)).toHaveLength(2);
    });
  });
});
