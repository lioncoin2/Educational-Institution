import { META } from '../../../../test/support/messaging-harness';
import {
  realtimeHarness,
  type Client,
  type Frame,
  type Person,
  type RealtimeHarness,
} from '../../../../test/support/realtime-harness';
import type { KnownRoleCode } from '../../identity/domain/role';
import { Roles } from '../../identity/domain/role';

const sentTo = (client: Client) => client.link.ofType('message.sent');
const errorOf = (client: Client): Frame | undefined => client.link.ofType('error').pop();

/**
 * A community chat travels the existing realtime pipeline unchanged
 * (community-chat.md §12.5): the same `message.sent` frame, typed CHANNEL,
 * to the recipients MESSAGE_RECIPIENTS names — which, for a community chat,
 * Communities narrows. No new protocol, no new frame.
 */
describe('a community chat, in real time', () => {
  let h: RealtimeHarness;
  let owner: Person;
  let member: Person;
  let leaving: Person;
  let communityId: string;
  let chatId: string;

  /** A person known to identity, messaging and Communities alike. */
  async function person(role: KnownRoleCode, name: string): Promise<Person> {
    const created = await h.person(role, name);
    h.messaging.communities.accounts.add(created.userId, [role], name);
    return created;
  }

  beforeEach(async () => {
    h = await realtimeHarness();
    owner = await person(Roles.admin, 'المشرفة');
    member = await person(Roles.student, 'الطالبة');
    leaving = await person(Roles.student, 'المغادِرة');
    communityId = await h.messaging.community(owner.principal, [
      member.principal,
      leaving.principal,
    ]);
    await h.messaging.deliverCommunityEvents();
    chatId = (await h.messaging.openCommunityChat(owner.principal, communityId)).id;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await h.cleanup();
  });

  it('delivers message.sent typed CHANNEL to members — never to one Communities removed, even before the projection heard', async () => {
    const present = await h.connect(member.accessToken);
    const gone = await h.connect(leaving.accessToken);
    // While a member, they hear the chat like anyone else.
    const before = await h.messaging.text(owner.principal, chatId, 'قبل الإزالة');
    await h.settle();
    expect(sentTo(gone).map((frame) => frame.messageId)).toEqual([before.message.id]);

    const removed = await h.messaging.communities.remove.execute({
      principal: owner.principal,
      communityId,
      userId: leaving.userId,
      meta: META,
    });
    expect(removed.ok).toBe(true);

    const { message } = await h.messaging.text(owner.principal, chatId, 'درس اليوم');
    await h.settle();

    expect(sentTo(present).map((frame) => frame.messageId)).toEqual([
      before.message.id,
      message.id,
    ]);
    expect(sentTo(present).pop()).toMatchObject({
      conversationId: chatId,
      conversationType: 'CHANNEL',
      messageId: message.id,
    });
    expect(sentTo(gone).map((frame) => frame.messageId)).toEqual([before.message.id]);
  });

  it('confirms a member’s subscribe, and refuses a removed member’s exactly like a missing conversation', async () => {
    const present = await h.connect(member.accessToken);
    await present.send({ type: 'subscribe', conversationId: chatId, id: 's1' });
    expect(present.link.last()).toMatchObject({ type: 'subscribed', conversationId: chatId });

    await h.messaging.communities.remove.execute({
      principal: owner.principal,
      communityId,
      userId: leaving.userId,
      meta: META,
    });
    const gone = await h.connect(leaving.accessToken);
    await gone.send({ type: 'subscribe', conversationId: chatId });
    const refusedReal = errorOf(gone);
    await gone.send({ type: 'subscribe', conversationId: 'does-not-exist' });
    const refusedMissing = errorOf(gone);
    expect(refusedReal).toMatchObject({ code: 'CONVERSATION_NOT_FOUND', conversationId: chatId });
    expect({ ...refusedMissing, conversationId: chatId }).toEqual(refusedReal);
  });

  it('answers a subscribe with SERVER_ERROR — never a confirmation — when Communities cannot answer', async () => {
    jest
      .spyOn(h.messaging.communities.authorization, 'authorize')
      .mockRejectedValue(new Error('store down'));
    const present = await h.connect(member.accessToken);
    await present.send({ type: 'subscribe', conversationId: chatId });
    expect(errorOf(present)).toMatchObject({ code: 'SERVER_ERROR', conversationId: chatId });
    expect(present.link.ofType('subscribed')).toEqual([]);
  });
});
