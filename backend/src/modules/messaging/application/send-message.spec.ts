import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { principalWith } from '../../../../test/support/principals';
import { Roles } from '../../identity/domain/role';
import { MessagingEvents } from '../contracts/events';
import { SENDS_PER_USER } from './messaging-settings';

const KEY = '0f4a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('sending messages', () => {
  let h: MessagingHarness;
  beforeEach(async () => {
    h = await messagingHarness();
  });
  afterEach(() => h.cleanup());

  async function setting() {
    const teacher = h.person(Roles.teacher, 'الأستاذ');
    const student = h.person(Roles.student, 'الطالب');
    const group = await h.group(teacher, [student]);
    return { teacher, student, group };
  }

  describe('text', () => {
    it('stores messages in server order, one sequence each', async () => {
      const { teacher, student, group } = await setting();
      const first = await h.text(teacher, group.id, 'السلام عليكم');
      const second = await h.text(student, group.id, '  وعليكم السلام \r\n');
      const third = await h.text(teacher, group.id, 'ابدأ بالتلاوة');

      expect([first, second, third].map((sent) => sent.message.sequence)).toEqual([1, 2, 3]);
      expect(second.message).toMatchObject({ type: 'TEXT', body: 'وعليكم السلام' });
      expect(second.created).toBe(true);
    });

    it('announces a new message with ids only — never its text', async () => {
      const { teacher, group } = await setting();
      const sent = await h.text(teacher, group.id, 'a private thought');

      const event = h.events.published.find((e) => e.name === MessagingEvents.messageSent);
      expect(event).toMatchObject({
        aggregateId: group.id,
        correlationId: META.correlationId,
        payload: {
          conversationId: group.id,
          conversationType: 'GROUP',
          messageId: sent.message.id,
          sequence: 1,
          senderId: teacher.userId,
          messageType: 'TEXT',
        },
      });
      expect(JSON.stringify(h.events.published)).not.toContain('a private thought');
    });

    it('counts the sender as having read up to their own message', async () => {
      const { teacher, student, group } = await setting();
      await h.text(teacher, group.id, 'one');
      await h.text(teacher, group.id, 'two');
      await h.text(student, group.id, 'reply');
      const studentView = expectOk(
        await h.getConversation.execute({ principal: student, conversationId: group.id }),
      );
      expect(studentView).toMatchObject({ lastReadSequence: 3, unreadCount: 0 });
      const teacherView = expectOk(
        await h.getConversation.execute({ principal: teacher, conversationId: group.id }),
      );
      expect(teacherView).toMatchObject({ lastReadSequence: 2, unreadCount: 1 });
    });

    it.each([
      ['empty text', { body: '  \n ' }, 'messaging.body_required'],
      ['an overlong text', { body: 'x'.repeat(4001) }, 'messaging.body_too_long'],
      [
        'a malformed key',
        { clientMessageId: 'no spaces allowed' },
        'messaging.client_message_id_invalid',
      ],
    ])('refuses %s', async (_label, override, code) => {
      const { teacher, group } = await setting();
      const result = await h.sendText.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: KEY,
        body: 'hello',
        meta: META,
        ...override,
      });
      expect(expectErr(result)).toMatchObject({ kind: 'validation', code });
    });
  });

  describe('idempotency — the client retries with the same key', () => {
    it('returns the original on a retry, stores nothing twice, announces nothing twice', async () => {
      const { teacher, group } = await setting();
      const send = () =>
        h.sendText.execute({
          principal: teacher,
          conversationId: group.id,
          clientMessageId: KEY,
          body: 'once only',
          meta: META,
        });
      const first = expectOk(await send());
      const retry = expectOk(await send());

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.message).toEqual(first.message);
      expect(h.events.published.filter((e) => e.name === MessagingEvents.messageSent)).toHaveLength(
        1,
      );
      const page = expectOk(
        await h.listMessages.execute({ principal: teacher, conversationId: group.id }),
      );
      expect(page.items).toHaveLength(1);
    });

    it('refuses the same key for different content', async () => {
      const { teacher, group } = await setting();
      await h.text(teacher, group.id, 'first', KEY);
      const result = await h.sendText.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: KEY,
        body: 'something else',
        meta: META,
      });
      expect(expectErr(result)).toMatchObject({
        kind: 'conflict',
        code: 'messaging.client_message_id_reused',
      });
    });

    it('scopes the key to one sender in one conversation', async () => {
      const { teacher, student, group } = await setting();
      const other = await h.group(teacher, [student], 'Second');
      await h.text(teacher, group.id, 'hello', KEY);
      expect((await h.text(student, group.id, 'hello', KEY)).created).toBe(true);
      expect((await h.text(teacher, other.id, 'hello', KEY)).created).toBe(true);
    });

    it('shows the key to its sender only', async () => {
      const { teacher, student, group } = await setting();
      await h.text(teacher, group.id, 'hello', KEY);
      const asStudent = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: group.id }),
      );
      const asTeacher = expectOk(
        await h.listMessages.execute({ principal: teacher, conversationId: group.id }),
      );
      expect(asStudent.items[0]?.clientMessageId).toBeNull();
      expect(asTeacher.items[0]?.clientMessageId).toBe(KEY);
    });
  });

  describe('voice, images and files — references to verified uploads', () => {
    it('sends a voice message carrying its recording', async () => {
      const { student, group } = await setting();
      const recording = await h.files.upload(student, {
        kind: 'VOICE',
        contentType: 'audio/mp4',
        fileName: 'تلاوة.m4a',
        durationMs: 42_000,
      });
      const sent = expectOk(
        await h.sendVoice.execute({
          principal: student,
          conversationId: group.id,
          clientMessageId: KEY,
          fileAssetId: recording.id,
          meta: META,
        }),
      );
      expect(sent.message).toMatchObject({
        type: 'VOICE',
        body: null,
        attachments: [
          {
            fileAssetId: recording.id,
            file: { kind: 'VOICE', contentType: 'audio/mp4', durationMs: 42_000 },
          },
        ],
      });
    });

    it('sends an image with a caption', async () => {
      const { teacher, group } = await setting();
      const photo = await h.files.upload(teacher, {
        kind: 'IMAGE',
        contentType: 'image/png',
        fileName: 'board.png',
        width: 1200,
        height: 800,
      });
      const sent = expectOk(
        await h.sendImage.execute({
          principal: teacher,
          conversationId: group.id,
          clientMessageId: KEY,
          fileAssetId: photo.id,
          caption: 'الواجب',
          meta: META,
        }),
      );
      expect(sent.message).toMatchObject({
        type: 'IMAGE',
        body: 'الواجب',
        attachments: [{ file: { kind: 'IMAGE', width: 1200, height: 800 } }],
      });
    });

    it('sends documents and audio recordings as files', async () => {
      const { teacher, group } = await setting();
      const pdf = await h.files.upload(teacher, {
        kind: 'DOCUMENT',
        contentType: 'application/pdf',
        fileName: 'plan.pdf',
      });
      const mp3 = await h.files.upload(teacher, {
        kind: 'AUDIO',
        contentType: 'audio/mpeg',
        fileName: 'recitation.mp3',
      });
      for (const asset of [pdf, mp3]) {
        const sent = expectOk(
          await h.sendFile.execute({
            principal: teacher,
            conversationId: group.id,
            clientMessageId: `file-${asset.id}`.slice(0, 64),
            fileAssetId: asset.id,
            meta: META,
          }),
        );
        expect(sent.message.type).toBe('FILE');
      }
    });

    it('refuses a file of the wrong kind for the message type', async () => {
      const { teacher, group } = await setting();
      const photo = await h.files.upload(teacher, { kind: 'IMAGE', contentType: 'image/png' });
      const result = await h.sendVoice.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: KEY,
        fileAssetId: photo.id,
        meta: META,
      });
      expect(expectErr(result).code).toBe('messaging.attachment_kind_invalid');
    });

    // Attaching someone else's upload would be a way to read it.
    it("refuses someone else's upload exactly like a missing one", async () => {
      const { teacher, student, group } = await setting();
      const teachers = await h.files.upload(teacher, { kind: 'IMAGE', contentType: 'image/png' });
      for (const fileAssetId of [teachers.id, 'no-such-asset']) {
        const result = await h.sendImage.execute({
          principal: student,
          conversationId: group.id,
          clientMessageId: KEY,
          fileAssetId,
          meta: META,
        });
        expect(expectErr(result).code).toBe('messaging.attachment_not_found');
      }
    });

    it('refuses an upload that was never completed', async () => {
      const { teacher, group } = await setting();
      const ticket = expectOk(
        await h.files.requestUpload.execute({
          principal: teacher,
          declaration: { kind: 'IMAGE', contentType: 'image/png', byteSize: 64, fileName: 'x.png' },
        }),
      );
      const result = await h.sendImage.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: KEY,
        fileAssetId: ticket.asset.id,
        meta: META,
      });
      expect(expectErr(result)).toMatchObject({
        kind: 'precondition_failed',
        code: 'messaging.attachment_not_ready',
      });
    });
  });

  describe('who may post where', () => {
    it('lets channel publishers and the owner post, and nobody else', async () => {
      const admin = h.person(Roles.admin);
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const channel = expectOk(
        await h.createChannel.execute({
          principal: admin,
          title: 'Announcements',
          memberIds: [student.userId],
          publisherIds: [teacher.userId],
          meta: META,
        }),
      );
      await h.text(admin, channel.id, 'from the owner');
      await h.text(teacher, channel.id, 'from a publisher');
      const result = await h.sendText.execute({
        principal: student,
        conversationId: channel.id,
        clientMessageId: KEY,
        body: 'from a reader',
        meta: META,
      });
      expect(expectErr(result)).toMatchObject({
        kind: 'forbidden',
        code: 'messaging.posting_not_allowed',
      });
    });

    it('treats a conversation one is not in exactly like one that does not exist', async () => {
      const { group } = await setting();
      const outsider = h.person(Roles.teacher);
      for (const conversationId of [group.id, 'no-such-conversation']) {
        const result = await h.sendText.execute({
          principal: outsider,
          conversationId,
          clientMessageId: KEY,
          body: 'let me in',
          meta: META,
        });
        expect(expectErr(result)).toMatchObject({
          kind: 'not_found',
          code: 'messaging.conversation_not_found',
        });
      }
    });

    it('requires messaging.send even of a member', async () => {
      const { teacher, group } = await setting();
      const readOnly = principalWith(teacher.userId, []);
      const result = await h.sendText.execute({
        principal: { ...readOnly, permissions: new Set(['messaging.read']) },
        conversationId: group.id,
        clientMessageId: KEY,
        body: 'hi',
        meta: META,
      });
      expect(expectErr(result).code).toBe('identity.permission_denied');
    });

    it('limits how fast one person may send', async () => {
      const { teacher, group } = await setting();
      for (let i = 0; i < SENDS_PER_USER.limit; i++) await h.text(teacher, group.id, `m${i}`);
      const result = await h.sendText.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: KEY,
        body: 'one too many',
        meta: META,
      });
      expect(expectErr(result)).toMatchObject({
        kind: 'rate_limited',
        code: 'messaging.too_many_messages',
      });
    });
  });

  describe('replies', () => {
    it('replies to a message in the same conversation', async () => {
      const { teacher, student, group } = await setting();
      const question = await h.text(teacher, group.id, 'من يقرأ؟');
      const answer = expectOk(
        await h.sendText.execute({
          principal: student,
          conversationId: group.id,
          clientMessageId: KEY,
          body: 'أنا',
          replyToMessageId: question.message.id,
          meta: META,
        }),
      );
      expect(answer.message.replyToMessageId).toBe(question.message.id);
    });

    it("refuses a reply to another conversation's message, or to one the sender cannot see", async () => {
      const { teacher, student, group } = await setting();
      const elsewhere = await h.group(teacher, [], 'Private notes');
      const secret = await h.text(teacher, elsewhere.id, 'not for students');

      const early = await h.text(teacher, group.id, 'before the newcomer');
      const newcomer = h.person(Roles.student);
      expectOk(
        await h.addParticipants.execute({
          principal: teacher,
          conversationId: group.id,
          userIds: [newcomer.userId],
          meta: META,
        }),
      );

      for (const [principal, target] of [
        [student, secret.message.id],
        [newcomer, early.message.id],
      ] as const) {
        const result = await h.sendText.execute({
          principal,
          conversationId: group.id,
          clientMessageId: KEY,
          body: 'reply',
          replyToMessageId: target,
          meta: META,
        });
        expect(expectErr(result).code).toBe('messaging.reply_target_not_found');
      }
    });
  });
});
