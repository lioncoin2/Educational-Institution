import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { Roles } from '../../identity/domain/role';

/**
 * "Do not implement: user has messaging.read → user can read all messages."
 *
 * Every test here uses the most privileged principal the system has — an
 * OWNER, holding every permission including messaging.manage — against a
 * conversation they are not in. Permission alone must get them nothing.
 */
describe('permission never substitutes for membership', () => {
  let h: MessagingHarness;
  let conversationId: string;
  let messageId: string;
  let fileAssetId: string;
  let owner: ReturnType<MessagingHarness['person']>;
  let admin: ReturnType<MessagingHarness['person']>;

  beforeEach(async () => {
    h = await messagingHarness();
    const teacher = h.person(Roles.teacher);
    const student = h.person(Roles.student);
    const dm = await h.direct(teacher, student);
    conversationId = dm.id;
    const photo = await h.files.upload(student, { kind: 'IMAGE', contentType: 'image/png' });
    fileAssetId = photo.id;
    messageId = expectOk(
      await h.sendImage.execute({
        principal: student,
        conversationId,
        clientMessageId: 'private-photo-0001',
        fileAssetId,
        caption: 'private',
        meta: META,
      }),
    ).message.id;
    owner = h.person(Roles.owner);
    admin = h.person(Roles.admin);
  });
  afterEach(() => h.cleanup());

  const NOT_FOUND = 'messaging.conversation_not_found';

  it('grants the institution owner every messaging permission — the premise of this suite', () => {
    for (const permission of ['messaging.read', 'messaging.send', 'messaging.manage']) {
      expect(owner.permissions.has(permission)).toBe(true);
    }
  });

  it.each(['owner', 'admin'] as const)(
    'does not list other people’s conversations to an %s',
    async (who) => {
      const principal = who === 'owner' ? owner : admin;
      expect(expectOk(await h.listConversations.execute({ principal })).items).toEqual([]);
    },
  );

  it('does not open, page, or mark read a conversation the caller is not in', async () => {
    for (const principal of [owner, admin]) {
      expect(expectErr(await h.getConversation.execute({ principal, conversationId })).code).toBe(
        NOT_FOUND,
      );
      expect(expectErr(await h.listMessages.execute({ principal, conversationId })).code).toBe(
        NOT_FOUND,
      );
      expect(
        expectErr(await h.markRead.execute({ principal, conversationId, sequence: 1, meta: META }))
          .code,
      ).toBe(NOT_FOUND);
      expect(expectErr(await h.listParticipants.execute({ principal, conversationId })).code).toBe(
        NOT_FOUND,
      );
    }
  });

  it('does not send into a conversation the caller is not in', async () => {
    const result = await h.sendText.execute({
      principal: owner,
      conversationId,
      clientMessageId: 'intrusion-0001',
      body: 'hello',
      meta: META,
    });
    expect(expectErr(result).code).toBe(NOT_FOUND);
  });

  it('does not hand out links to its attachments', async () => {
    const result = await h.attachmentLink.execute({
      principal: owner,
      conversationId,
      messageId,
      fileAssetId,
    });
    expect(expectErr(result).code).toBe(NOT_FOUND);
  });

  // messaging.manage removes; it must never be a way IN.
  it('does not let a moderator add anyone — least of all themselves', async () => {
    const teacher = h.person(Roles.teacher);
    const group = await h.group(teacher, []);
    const result = await h.addParticipants.execute({
      principal: owner,
      conversationId: group.id,
      userIds: [owner.userId],
      meta: META,
    });
    expect(expectErr(result).code).toBe(NOT_FOUND);
  });

  it('reports a conversation one is not in exactly like one that does not exist', async () => {
    const real = await h.listMessages.execute({ principal: owner, conversationId });
    const fake = await h.listMessages.execute({ principal: owner, conversationId: 'nope' });
    expect(expectErr(real)).toEqual(expectErr(fake));
  });
});

describe('attachment links', () => {
  let h: MessagingHarness;
  beforeEach(async () => {
    h = await messagingHarness();
  });
  afterEach(() => h.cleanup());

  it('gives a member a short-lived link to a file on a message they can see', async () => {
    const teacher = h.person(Roles.teacher);
    const student = h.person(Roles.student);
    const group = await h.group(teacher, [student]);
    const photo = await h.files.upload(teacher, { kind: 'IMAGE', contentType: 'image/png' });
    const sent = expectOk(
      await h.sendImage.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: 'photo-00000001',
        fileAssetId: photo.id,
        meta: META,
      }),
    );
    const link = expectOk(
      await h.attachmentLink.execute({
        principal: student,
        conversationId: group.id,
        messageId: sent.message.id,
        fileAssetId: photo.id,
      }),
    );
    expect(link.url).toMatch(/^\/files\/local\//);
    expect(link.expiresAt.getTime() - h.clock.now().getTime()).toBe(5 * 60 * 1000);
  });

  it('refuses a file that is not on that message, and a message from before one joined', async () => {
    const teacher = h.person(Roles.teacher);
    const group = await h.group(teacher, []);
    const photo = await h.files.upload(teacher, { kind: 'IMAGE', contentType: 'image/png' });
    const other = await h.files.upload(teacher, { kind: 'IMAGE', contentType: 'image/png' });
    const sent = expectOk(
      await h.sendImage.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: 'photo-00000002',
        fileAssetId: photo.id,
        meta: META,
      }),
    );
    // A real file, a real message — but not together.
    expect(
      expectErr(
        await h.attachmentLink.execute({
          principal: teacher,
          conversationId: group.id,
          messageId: sent.message.id,
          fileAssetId: other.id,
        }),
      ).code,
    ).toBe('messaging.attachment_not_found');

    const newcomer = h.person(Roles.student);
    expectOk(
      await h.addParticipants.execute({
        principal: teacher,
        conversationId: group.id,
        userIds: [newcomer.userId],
        meta: META,
      }),
    );
    expect(
      expectErr(
        await h.attachmentLink.execute({
          principal: newcomer,
          conversationId: group.id,
          messageId: sent.message.id,
          fileAssetId: photo.id,
        }),
      ).code,
    ).toBe('messaging.attachment_not_found');
  });

  it('requires files.read as well as membership', async () => {
    const teacher = h.person(Roles.teacher);
    const group = await h.group(teacher, []);
    const photo = await h.files.upload(teacher, { kind: 'IMAGE', contentType: 'image/png' });
    const sent = expectOk(
      await h.sendImage.execute({
        principal: teacher,
        conversationId: group.id,
        clientMessageId: 'photo-00000003',
        fileAssetId: photo.id,
        meta: META,
      }),
    );
    const noFiles = { ...teacher, permissions: new Set(['messaging.read']) };
    const result = await h.attachmentLink.execute({
      principal: noFiles,
      conversationId: group.id,
      messageId: sent.message.id,
      fileAssetId: photo.id,
    });
    expect(expectErr(result).code).toBe('identity.permission_denied');
  });
});
