import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import type { ApiResponse } from '../support/api-client';
import { LogCapture } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import type { TestSocket } from '../support/realtime-client';

/**
 * A live session's own chat over HTTP and the WebSocket (owner decision F,
 * ADR 0047): participants read and post by default; a moderator locks it and
 * then only moderators post — refused by the server, whatever the app shows;
 * an ended session's chat is read-only; a non-member learns nothing.
 */
describe('live session chat API (ADR 0047)', () => {
  let r: RealtimeApi;
  let admin: Account; // creates — and so owns — the community, and hosts
  let teacher: Account; // a member without any grant
  let student: Account;
  let outsider: Account;
  let communityId: string;
  let sessionId: string;
  let socket: TestSocket;
  let keys = 0;

  beforeAll(async () => {
    r = await startRealtimeApi(
      { LIVEKIT_API_SECRET: 'development-only-secret', LIVE_MEDIA_PROVIDER: '' },
      { logger: new LogCapture() },
    );
    await r.api.app.get(LiveReconciler, { strict: false }).stop();
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة حفصة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    outsider = await r.provision('outsider', 'STUDENT', 'زائرة');
    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [teacher, student]);
    const started = await r.api.call('POST', `/live/communities/${communityId}/sessions`, {
      token: admin.token,
    });
    expect(started.status).toBe(201);
    sessionId = started.body.id as string;
    socket = await r.connect(student);
  }, 60_000);

  afterAll(async () => {
    await socket?.close();
    await r.close();
  });

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;
  const post = (by: Account, body: string, clientMessageId = `api-chat-${(keys += 1)}-key`) =>
    r.api.call('POST', `/live/sessions/${sessionId}/chat`, {
      token: by.token,
      body: { clientMessageId, body },
    });
  const read = (by: Account) =>
    r.api.call('GET', `/live/sessions/${sessionId}/chat`, { token: by.token });
  const lock = (by: Account, method: 'PUT' | 'DELETE') =>
    r.api.call(method, `/live/sessions/${sessionId}/chat/lock`, { token: by.token });

  it('lets a participant post (201, a retry 200) and every participant read it', async () => {
    const first = await post(student, 'سؤال عن المخارج', 'api-chat-retry-0001');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      sessionId,
      senderId: student.id,
      senderDisplayName: 'مريم',
      body: 'سؤال عن المخارج',
    });
    const retry = await post(student, 'سؤال عن المخارج', 'api-chat-retry-0001');
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);

    const page = await read(teacher);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      locked: false,
      lockVersion: 0,
      canPost: true,
      canModerate: false,
      nextCursor: null,
    });
    expect((page.body.items as { body: string }[]).map((m) => m.body)).toEqual(['سؤال عن المخارج']);
    // Delivered live to the connected participant, as the page shows it.
    const frame = await socket.waitFor((f) => f.type === 'live.chat.message');
    expect(frame).toMatchObject({ sessionId, message: { body: 'سؤال عن المخارج' } });
  });

  it('validates at the edge (400) and in the domain (422)', async () => {
    const unknown = await r.api.call('POST', `/live/sessions/${sessionId}/chat`, {
      token: student.token,
      body: { clientMessageId: 'api-chat-extra-001', body: 'x', senderId: admin.id },
    });
    expect(unknown.status).toBe(400);
    const blank = await post(student, '   ');
    expect(blank.status).toBe(422);
    expect(code(blank)).toBe('live.chat_body_required');
  });

  it('keeps a non-member out: 404 reading and posting, 403 at the edge locking', async () => {
    expect((await read(outsider)).status).toBe(404);
    expect((await post(outsider, 'من الخارج')).status).toBe(404);
    // A student holds no live.moderate at all: refused at the edge.
    const outsiderLock = await lock(outsider, 'PUT');
    expect(outsiderLock.status).toBe(403);
    expect(code(outsiderLock)).toBe('identity.permission_denied');
  });

  it('lets only a moderator lock; then participants are refused and moderators still post', async () => {
    const notModerator = await lock(teacher, 'PUT');
    expect(notModerator.status).toBe(403);
    expect(code(notModerator)).toBe('live.not_a_moderator');

    const locked = await lock(admin, 'PUT');
    expect(locked.status).toBe(200);
    expect(locked.body).toEqual({ locked: true, lockVersion: 1, changed: true });
    const changed = await socket.waitFor((f) => f.type === 'live.chat.changed');
    expect(changed).toMatchObject({ locked: true, lockVersion: 1 });

    const refused = await post(student, 'ممنوع الآن');
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('live.chat_locked');
    expect((await post(teacher, 'ولا أنا')).status).toBe(403);
    expect((await post(admin, 'تنبيه من المشرف')).status).toBe(201);
    expect((await read(student)).body).toMatchObject({ locked: true, canPost: false });

    const reopened = await lock(admin, 'DELETE');
    expect(reopened.body).toEqual({ locked: false, lockVersion: 2, changed: true });
    expect((await post(student, 'عاد الكلام')).status).toBe(201);
  });

  it('keeps an ended session’s chat readable and closed to everyone', async () => {
    const ended = await r.api.call('POST', `/live/sessions/${sessionId}/end`, {
      token: admin.token,
    });
    expect(ended.status).toBe(200);
    const late = await post(student, 'بعد النهاية');
    expect(late.status).toBe(412);
    expect(code(late)).toBe('live.session_not_live');
    expect((await lock(admin, 'PUT')).status).toBe(412);
    const page = await read(student);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ canPost: false, canModerate: false });
    expect((page.body.items as unknown[]).length).toBe(3);
  });
});
