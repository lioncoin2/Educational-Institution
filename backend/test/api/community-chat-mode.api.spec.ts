import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * Groups & channels over real HTTP + WebSocket (ADR 0039). An open group lets a
 * member post; an admin restricts and restores it; a channel refuses members;
 * every message type follows the one server-side rule; and a restriction is
 * pushed to a connected member and takes effect on their next send even if
 * their client is stale. Enforcement is the server's — never the UI.
 */
describe('group & channel posting API', () => {
  let r: RealtimeApi;
  let admin: Account;
  let member: Account;
  let outsider: Account;

  beforeAll(async () => {
    r = await startRealtimeApi();
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    member = await r.provision('member', 'STUDENT', 'مريم');
    outsider = await r.provision('outsider', 'STUDENT', 'زينب');
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  const call = (
    method: string,
    path: string,
    account?: Account,
    body?: unknown,
  ): Promise<ApiResponse> => r.api.call(method, path, { token: account?.token, body });

  const code = (res: ApiResponse) => (res.body.error as { code: string } | undefined)?.code;

  let keyCounter = 0;
  const key = () => `cm-${String(++keyCounter).padStart(8, '0')}`;

  const text = (who: Account, chatId: string) =>
    call('POST', `/messaging/conversations/${chatId}/messages/text`, who, {
      clientMessageId: key(),
      body: 'رسالة',
    });
  const media = (who: Account, chatId: string, kind: 'image' | 'voice' | 'file') =>
    call('POST', `/messaging/conversations/${chatId}/messages/${kind}`, who, {
      clientMessageId: key(),
      fileAssetId: 'not-a-real-asset', // posting is refused before the attachment is read
    });

  async function makeCommunity(kind: 'GROUP' | 'CHANNEL'): Promise<{ id: string; chatId: string }> {
    const created = await call('POST', '/communities', admin, { title: 'حلقة', kind });
    const id = created.body.id as string;
    await call('POST', `/communities/${id}/members`, admin, { userIds: [member.id] });
    const chat = await call('GET', `/messaging/communities/${id}/conversation`, member);
    return { id, chatId: chat.body.id as string };
  }

  it('a new group is open: a member posts every message type without a grant', async () => {
    const { chatId } = await makeCommunity('GROUP');
    expect((await text(member, chatId)).status).toBe(201);
    // A real image round-trip is covered elsewhere; here a member reaching the
    // send path for image/voice/file is what matters (a real asset is verified
    // after posting is allowed). A member posting is allowed, so these pass the
    // posting gate and fail only later on the fake asset — never with 403.
    for (const kind of ['image', 'voice', 'file'] as const) {
      expect(code(await media(member, chatId, kind))).not.toBe('messaging.posting_not_allowed');
    }
  });

  it('an admin restricts member posting: every message type is then refused 403', async () => {
    const { id, chatId } = await makeCommunity('GROUP');
    expect((await text(member, chatId)).status).toBe(201); // open first

    const restricted = await call('PUT', `/communities/${id}/chat-mode`, admin, {
      membersMayPost: false,
    });
    expect(restricted.status).toBe(200);
    expect(restricted.body.chatMode).toBe('GROUP_RESTRICTED');

    for (const send of [
      () => text(member, chatId),
      () => media(member, chatId, 'image'),
      () => media(member, chatId, 'voice'),
      () => media(member, chatId, 'file'),
    ]) {
      const refused = await send();
      expect(refused.status).toBe(403);
      expect(code(refused)).toBe('messaging.posting_not_allowed');
    }
    // The admin still posts; restoring reopens it for the member.
    expect((await text(admin, chatId)).status).toBe(201);
    expect(
      (await call('PUT', `/communities/${id}/chat-mode`, admin, { membersMayPost: true })).body
        .chatMode,
    ).toBe('GROUP_OPEN');
    expect((await text(member, chatId)).status).toBe(201);
  });

  it('a restriction is pushed to a connected member and a stale client cannot bypass it', async () => {
    const { id, chatId } = await makeCommunity('GROUP');
    const socket = await r.connect(member);
    try {
      expect((await text(member, chatId)).status).toBe(201);
      await call('PUT', `/communities/${id}/chat-mode`, admin, { membersMayPost: false });
      // The member's live connection is told their access changed (ids only).
      const frame = await socket.waitFor(
        (f) =>
          f.type === 'community.access.changed' &&
          (f as { communityId?: string }).communityId === id,
      );
      expect(frame.type).toBe('community.access.changed');
      // A stale client that never refreshed still cannot send — the server re-checks.
      const refused = await text(member, chatId);
      expect(refused.status).toBe(403);
      expect(code(refused)).toBe('messaging.posting_not_allowed');
    } finally {
      await socket.close();
    }
  });

  it('a channel refuses an ordinary member and admits the owner', async () => {
    const { chatId } = await makeCommunity('CHANNEL');
    const refused = await text(member, chatId);
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('messaging.posting_not_allowed');
    expect((await text(admin, chatId)).status).toBe(201);
  });

  it('an ordinary member cannot change the posting restriction', async () => {
    const { id } = await makeCommunity('GROUP');
    const refused = await call('PUT', `/communities/${id}/chat-mode`, member, {
      membersMayPost: false,
    });
    expect(refused.status).toBe(403);
    // An outsider (non-member) is told what anyone is told about a community.
    const outsiderTry = await call('PUT', `/communities/${id}/chat-mode`, outsider, {
      membersMayPost: false,
    });
    expect([403, 404]).toContain(outsiderTry.status);
  });
});
