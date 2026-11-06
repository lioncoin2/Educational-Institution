import type { Principal } from '../../../shared';
import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';

/**
 * Forwarding a message into another conversation, over the REAL authorization.
 * Two gates: the forwarder may READ the source, and may POST in the target.
 * The copy carries the source's content and the ORIGINAL author's id; a forward
 * of a forward keeps the first origin; a media forward reuses the same file
 * asset even though the forwarder never uploaded it.
 */
describe('forwarding a message', () => {
  let h: MessagingHarness;
  let author: Principal;
  let forwarder: Principal;
  let outsider: Principal;
  let sourceId: string;
  let targetId: string;

  const forward = (
    who: Principal,
    source: { conversationId: string; messageId: string },
    targetConversationId: string,
  ) =>
    h.forwardMessage.execute({
      principal: who,
      targetConversationId,
      clientMessageId: `fwd-${Math.random().toString(36).slice(2, 12)}`,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.messageId,
      meta: META,
    });

  beforeEach(async () => {
    h = await messagingHarness();
    // Teachers so they can own (create) the groups used here; a member of a
    // group may post in it, which is all the forward needs.
    author = h.person('TEACHER', 'Khadijah');
    forwarder = h.person('TEACHER', 'Bilal');
    outsider = h.person('TEACHER', 'Elsewhere');
    // The forwarder reads the source (a member) and owns the target (can post).
    sourceId = (await h.group(author, [forwarder], 'المصدر')).id;
    targetId = (await h.group(forwarder, [], 'الوجهة')).id;
  });

  it('copies the text into the target, stamped with the original author', async () => {
    const original = await h.text(author, sourceId, 'الرسالة الأصلية');
    const sent = expectOk(
      await forward(
        forwarder,
        { conversationId: sourceId, messageId: original.message.id },
        targetId,
      ),
    );
    expect(sent.created).toBe(true);
    expect(sent.message.conversationId).toBe(targetId);
    expect(sent.message.body).toBe('الرسالة الأصلية');
    expect(sent.message.senderId).toBe(forwarder.userId);
    expect(sent.message.forwardedFromSenderId).toBe(author.userId);
    expect(sent.message.replyToMessageId).toBeNull();
  });

  it('keeps the first origin when a forward is forwarded again', async () => {
    const original = await h.text(author, sourceId, 'مرحبا');
    const once = expectOk(
      await forward(
        forwarder,
        { conversationId: sourceId, messageId: original.message.id },
        targetId,
      ),
    );
    // Forward the forwarded copy (which lives in the target the forwarder owns)
    // on to a third conversation: the label must still name the true author.
    const third = (await h.group(forwarder, [], 'الثالثة')).id;
    const twice = expectOk(
      await forward(forwarder, { conversationId: targetId, messageId: once.message.id }, third),
    );
    expect(twice.message.forwardedFromSenderId).toBe(author.userId);
  });

  it('forwards a media message, reusing the asset the forwarder never uploaded', async () => {
    const photo = await h.files.upload(author, { kind: 'IMAGE', contentType: 'image/png' });
    const picture = expectOk(
      await h.sendImage.execute({
        principal: author,
        conversationId: sourceId,
        clientMessageId: 'img-original-0001',
        fileAssetId: photo.id,
        caption: 'لقطة',
        meta: META,
      }),
    );
    const sent = expectOk(
      await forward(
        forwarder,
        { conversationId: sourceId, messageId: picture.message.id },
        targetId,
      ),
    );
    expect(sent.message.type).toBe('IMAGE');
    expect(sent.message.body).toBe('لقطة');
    expect(sent.message.attachments.map((a) => a.fileAssetId)).toEqual([photo.id]);
    expect(sent.message.forwardedFromSenderId).toBe(author.userId);
  });

  it('refuses to forward from a conversation the forwarder cannot read', async () => {
    const original = await h.text(author, sourceId, 'سرّي');
    const theirTarget = (await h.group(outsider, [], 'وجهة الغريب')).id;
    const refusal = expectErr(
      await forward(
        outsider,
        { conversationId: sourceId, messageId: original.message.id },
        theirTarget,
      ),
    );
    // A non-member cannot even address the source conversation: refused at the
    // membership gate, exactly as any non-member read is — no message leaks.
    expect(refusal.code).toBe('messaging.conversation_not_found');
  });

  it('refuses to forward a deleted message', async () => {
    const original = await h.text(author, sourceId, 'ستُحذف');
    expectOk(
      await h.deleteMessage.execute({
        principal: author,
        conversationId: sourceId,
        messageId: original.message.id,
        meta: META,
      }),
    );
    const refusal = expectErr(
      await forward(
        forwarder,
        { conversationId: sourceId, messageId: original.message.id },
        targetId,
      ),
    );
    expect(refusal.code).toBe('messaging.forward_source_not_found');
  });

  afterEach(async () => {
    await h.cleanup();
  });
});
