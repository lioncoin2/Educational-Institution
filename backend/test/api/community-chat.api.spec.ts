import { COMMUNITY_AUTHORIZATION } from '../../src/modules/communities/contracts/authorization';
import { CommunityChatSync } from '../../src/modules/messaging/application/community-chat-sync';
import { MessagingModule } from '../../src/modules/messaging/messaging.module';
import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * A community's chat over HTTP and the realtime endpoint — the application
 * exactly as the server runs it without a database: AppModule's wiring
 * (MessagingModule importing CommunitiesModule), the real guards, pipes and
 * filter, both modules' in-memory stores, and Communities' events reaching
 * messaging through the real in-process bus.
 */
describe('community chat API', () => {
  let r: RealtimeApi;
  let admin: Account;
  let teacher: Account;
  let student: Account;
  let outsider: Account;
  let communityId: string;
  let chatId: string;
  let keys = 0;

  beforeAll(async () => {
    r = await startRealtimeApi();
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة عائشة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    outsider = await r.provision('outsider', 'STUDENT', 'زينب');
    const created = await call('POST', '/communities', admin, { title: 'حلقة التجويد' });
    communityId = created.body.id as string;
    const added = await call('POST', `/communities/${communityId}/members`, admin, {
      userIds: [teacher.id, student.id],
    });
    expect(added.status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  function call(
    method: string,
    path: string,
    account?: Account,
    body?: unknown,
  ): Promise<ApiResponse> {
    return r.api.call(method, path, { token: account?.token, body });
  }

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;

  const withoutRequestId = (response: ApiResponse) => {
    const { requestId: _ignored, ...rest } = response.body;
    return JSON.stringify({ status: response.status, ...rest });
  };

  const text = (account: Account, conversationId: string, body = 'السلام عليكم') =>
    call('POST', `/messaging/conversations/${conversationId}/messages/text`, account, {
      clientMessageId: `api-key-${(keys += 1).toString().padStart(6, '0')}`,
      body,
    });

  it('wires Communities’ authorization into messaging — one instance, from Communities', () => {
    const inMessaging = r.api.app.select(MessagingModule).get(COMMUNITY_AUTHORIZATION);
    expect(inMessaging).toBe(r.api.app.get(COMMUNITY_AUTHORIZATION));
    expect(r.api.app.select(MessagingModule).get(CommunityChatSync)).toBeInstanceOf(
      CommunityChatSync,
    );
  });

  it('refuses an anonymous caller', async () => {
    expect((await call('GET', `/messaging/communities/${communityId}/conversation`)).status).toBe(
      401,
    );
  });

  it('opens a member’s community chat: CHANNEL, the community’s id and title, no management', async () => {
    const opened = await call('GET', `/messaging/communities/${communityId}/conversation`, student);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      type: 'CHANNEL',
      communityId,
      title: 'حلقة التجويد',
      myRole: 'MEMBER',
      canPost: false,
      canManageMembers: false,
      memberCount: 3,
    });
    chatId = opened.body.id as string;
    const again = await call('GET', `/messaging/communities/${communityId}/conversation`, admin);
    expect(again.body).toMatchObject({ id: chatId, canPost: true });
  });

  it('answers a non-member and an unknown community with the same 404', async () => {
    const real = await call('GET', `/messaging/communities/${communityId}/conversation`, outsider);
    const unknown = await call(
      'GET',
      '/messaging/communities/no-such-community/conversation',
      outsider,
    );
    expect({ status: real.status, code: code(real) }).toEqual({
      status: 404,
      code: 'messaging.conversation_not_found',
    });
    expect(withoutRequestId(real)).toBe(withoutRequestId(unknown));
    const conversation = await call('GET', `/messaging/conversations/${chatId}`, outsider);
    const missing = await call('GET', '/messaging/conversations/no-such-chat', outsider);
    expect(withoutRequestId(conversation)).toBe(withoutRequestId(missing));
  });

  it('lets the owner post and a member read; refuses a member without the capability with 403', async () => {
    expect((await text(admin, chatId, 'موعد الحلقة بعد العصر')).status).toBe(201);
    const refused = await text(student, chatId);
    expect({ status: refused.status, code: code(refused) }).toEqual({
      status: 403,
      code: 'messaging.posting_not_allowed',
    });
    const page = await call('GET', `/messaging/conversations/${chatId}/messages`, student);
    expect(page.status).toBe(200);
    expect((page.body.items as { body: string }[]).map((item) => item.body)).toEqual([
      'موعد الحلقة بعد العصر',
    ]);
  });

  it('lets a delegated poster post once the owner grants community.chat.post', async () => {
    const granted = await call('POST', `/communities/${communityId}/grants`, admin, {
      userId: teacher.id,
      capabilities: ['community.chat.post'],
    });
    expect(granted.status).toBe(201);
    expect((await text(teacher, chatId, 'أحسنتم')).status).toBe(201);
  });

  it('refuses add, remove and leave with 412, and never lists the members (403)', async () => {
    for (const [method, path, account, body] of [
      [
        'POST',
        `/messaging/conversations/${chatId}/participants`,
        admin,
        { userIds: [outsider.id] },
      ],
      ['DELETE', `/messaging/conversations/${chatId}/participants/${student.id}`, admin, undefined],
      ['POST', `/messaging/conversations/${chatId}/leave`, student, undefined],
    ] as const) {
      const refused = await call(method, path, account, body);
      expect({ path, status: refused.status, code: code(refused) }).toEqual({
        path,
        status: 412,
        code: 'messaging.membership_managed_by_community',
      });
    }
    const participants = await call(
      'GET',
      `/messaging/conversations/${chatId}/participants`,
      admin,
    );
    expect({ status: participants.status, code: code(participants) }).toEqual({
      status: 403,
      code: 'messaging.members_hidden',
    });
  });

  it('lists the chat with its community among a member’s conversations — and communityId null elsewhere', async () => {
    const group = await r.group(teacher, [student]);
    const list = await call('GET', '/messaging/conversations', student);
    const items = list.body.items as { id: string; communityId: string | null }[];
    expect(items.find((item) => item.id === chatId)?.communityId).toBe(communityId);
    expect(items.find((item) => item.id === group)?.communityId).toBeNull();
  });

  it('delivers the chat’s messages over the existing realtime endpoint — typed CHANNEL', async () => {
    const socket = await r.connect(student);
    try {
      socket.send({ type: 'subscribe', conversationId: chatId, id: 'sub-chat' });
      await socket.waitFor((frame) => frame.type === 'subscribed' && frame.id === 'sub-chat');
      const sent = await text(admin, chatId, 'رسالة حية');
      const frame = await socket.waitFor(
        (candidate) => candidate.type === 'message.sent' && candidate.messageId === sent.body.id,
      );
      expect(frame).toMatchObject({ conversationId: chatId, conversationType: 'CHANNEL' });
    } finally {
      await socket.close();
    }
  });

  it('shuts a member Communities removes out of the chat at once', async () => {
    expect((await call('GET', `/messaging/conversations/${chatId}`, student)).status).toBe(200);
    const removed = await call(
      'DELETE',
      `/communities/${communityId}/members/${student.id}`,
      admin,
    );
    expect(removed.status).toBe(204);
    for (const path of [
      `/messaging/conversations/${chatId}`,
      `/messaging/conversations/${chatId}/messages`,
      `/messaging/communities/${communityId}/conversation`,
    ]) {
      const refused = await call('GET', path, student);
      expect({ path, status: refused.status, code: code(refused) }).toEqual({
        path,
        status: 404,
        code: 'messaging.conversation_not_found',
      });
    }
  });

  it('limits how often one person may look a community’s chat up', async () => {
    let limited: ApiResponse | undefined;
    for (let i = 0; i < 70 && limited === undefined; i++) {
      const response = await call(
        'GET',
        `/messaging/communities/${communityId}/conversation`,
        teacher,
      );
      if (response.status === 429) limited = response;
    }
    expect(limited).toBeDefined();
    expect(code(limited as ApiResponse)).toBe('messaging.too_many_community_chat_lookups');
  });
});
