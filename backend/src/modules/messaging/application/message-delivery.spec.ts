import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { Roles } from '../../identity/domain/role';
import { MAX_RECIPIENT_PAGE } from '../contracts/message-recipients';

/**
 * The contract a delivery module (realtime) relies on: what a message looks
 * like when delivered, who may receive it, and who may follow a conversation.
 */
describe('message delivery contract', () => {
  let h: MessagingHarness;
  beforeEach(async () => {
    h = await messagingHarness();
  });
  afterEach(() => h.cleanup());

  const NOT_FOUND = 'messaging.conversation_not_found';

  const members = async (conversationId: string, visibleSequence?: number) =>
    (await h.recipients.list(conversationId, { visibleSequence, limit: MAX_RECIPIENT_PAGE }))
      .userIds;

  describe('message()', () => {
    it('renders the message as the timeline does — the key for its sender only', async () => {
      const teacher = h.person(Roles.teacher, 'الأستاذ');
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const sent = await h.text(teacher, group.id, 'السلام عليكم', 'delivery-key-0001');

      const delivered = await h.delivery.message(group.id, sent.message.id);

      expect(delivered?.forSender).toEqual(sent.message);
      expect(delivered?.forSender.clientMessageId).toBe('delivery-key-0001');
      expect(delivered?.forMembers).toEqual({ ...sent.message, clientMessageId: null });
      const timeline = expectOk(
        await h.listMessages.execute({ principal: student, conversationId: group.id }),
      );
      expect(delivered?.forMembers).toEqual(timeline.items[0]);
      expect(delivered?.sender).toEqual({ userId: teacher.userId, displayName: 'الأستاذ' });
    });

    it('carries a file as a reference and a summary — never a link', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const dm = await h.direct(teacher, student);
      const photo = await h.files.upload(student, { kind: 'IMAGE', contentType: 'image/png' });
      const sent = expectOk(
        await h.sendImage.execute({
          principal: student,
          conversationId: dm.id,
          clientMessageId: 'delivery-photo-01',
          fileAssetId: photo.id,
          meta: META,
        }),
      );

      const delivered = await h.delivery.message(dm.id, sent.message.id);

      expect(delivered?.forMembers.attachments).toEqual([
        { fileAssetId: photo.id, file: expect.objectContaining({ kind: 'IMAGE' }) },
      ]);
      expect(JSON.stringify(delivered)).not.toMatch(/https?:|sig=|\/files\/local\//);
    });

    it('finds nothing for an unknown message, or one named under another conversation', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const one = await h.group(teacher, [student], 'one');
      const other = await h.group(teacher, [student], 'other');
      const sent = await h.text(teacher, one.id, 'hello');

      expect(await h.delivery.message(one.id, 'no-such-message')).toBeNull();
      expect(await h.delivery.message(other.id, sent.message.id)).toBeNull();
    });
  });

  describe('recipients for a sequence', () => {
    it('leaves out someone added after the message — a group hides earlier history', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const late = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const before = await h.text(teacher, group.id, 'before they joined');
      expectOk(
        await h.addParticipants.execute({
          principal: teacher,
          conversationId: group.id,
          userIds: [late.userId],
          meta: META,
        }),
      );
      const after = await h.text(teacher, group.id, 'after they joined');

      expect(await members(group.id, before.message.sequence)).not.toContain(late.userId);
      expect(await members(group.id, after.message.sequence)).toContain(late.userId);
      expect(await members(group.id)).toContain(late.userId);
    });

    it('includes a later channel subscriber — a channel shows its history', async () => {
      const owner = h.person(Roles.admin);
      const reader = h.person(Roles.student);
      const channel = expectOk(
        await h.createChannel.execute({
          principal: owner,
          title: 'إعلانات',
          memberIds: [],
          publisherIds: [],
          meta: META,
        }),
      );
      const post = await h.text(owner, channel.id, 'announcement');
      expectOk(
        await h.addParticipants.execute({
          principal: owner,
          conversationId: channel.id,
          userIds: [reader.userId],
          meta: META,
        }),
      );
      expect(await members(channel.id, post.message.sequence)).toContain(reader.userId);
    });

    it('leaves out a member who has been removed', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      const sent = await h.text(teacher, group.id, 'hello');
      expectOk(
        await h.removeParticipant.execute({
          principal: teacher,
          conversationId: group.id,
          userId: student.userId,
          meta: META,
        }),
      );
      expect(await members(group.id, sent.message.sequence)).toEqual([teacher.userId]);
    });
  });

  describe('position()', () => {
    it("gives a member the conversation's newest sequence and their own read mark", async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      await h.text(teacher, group.id, 'one');
      await h.text(teacher, group.id, 'two');

      expect(expectOk(await h.delivery.position(student, group.id))).toEqual({
        conversationId: group.id,
        lastSequence: 2,
        lastReadSequence: 0,
      });
      expect(expectOk(await h.delivery.position(teacher, group.id)).lastReadSequence).toBe(2);
    });

    it('refuses a stranger exactly as it refuses a conversation that does not exist', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const stranger = h.person(Roles.student);
      const group = await h.group(teacher, [student]);

      expect(expectErr(await h.delivery.position(stranger, group.id)).code).toBe(NOT_FOUND);
      expect(expectErr(await h.delivery.position(stranger, 'no-such-id')).code).toBe(NOT_FOUND);
    });

    it('refuses the institution owner in a conversation they are not in', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const owner = h.person(Roles.owner);
      const dm = await h.direct(teacher, student);

      expect(expectErr(await h.delivery.position(owner, dm.id)).code).toBe(NOT_FOUND);
    });

    it('refuses someone removed, from the moment of removal', async () => {
      const teacher = h.person(Roles.teacher);
      const student = h.person(Roles.student);
      const group = await h.group(teacher, [student]);
      expectOk(await h.delivery.position(student, group.id));
      expectOk(
        await h.removeParticipant.execute({
          principal: teacher,
          conversationId: group.id,
          userId: student.userId,
          meta: META,
        }),
      );
      expect(expectErr(await h.delivery.position(student, group.id)).code).toBe(NOT_FOUND);
    });
  });
});
