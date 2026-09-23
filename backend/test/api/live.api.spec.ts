import { asId } from '../../src/shared';
import {
  LIVE_ROOM_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  type LiveRoomRepository,
  type LiveSessionRepository,
} from '../../src/modules/live/domain/ports';
import { RTC_PROVIDER } from '../../src/modules/live/domain/rtc-provider';
import type { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * Live over HTTP — the application exactly as the server runs it without a
 * database or media credentials: in-memory sessions and the fake provider.
 * Sessions are placed in the store directly, because no route starts one
 * until community-scoped sessions land (P6).
 */
describe('live API', () => {
  let r: RealtimeApi;
  let host: Account;
  let otherTeacher: Account;
  let student: Account;
  let rtc: FakeRtcProvider;
  const SESSION = 'session-api-1';
  const liveTranscript: string[] = [];

  beforeAll(async () => {
    r = await startRealtimeApi();
    host = await r.provision('host', 'TEACHER', 'الأستاذة عائشة');
    otherTeacher = await r.provision('other-teacher', 'TEACHER', 'الأستاذة سودة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    rtc = r.api.app.get<FakeRtcProvider>(RTC_PROVIDER);

    const rooms = r.api.app.get<LiveRoomRepository>(LIVE_ROOM_REPOSITORY);
    const sessions = r.api.app.get<LiveSessionRepository>(LIVE_SESSION_REPOSITORY);
    await rooms.save({
      id: asId<'LiveRoom'>('room-api-1'),
      halaqaId: 'halaqa-1',
      title: 'Tajweed',
      hostUserId: host.id,
      maxParticipants: 300,
      createdAt: new Date(),
    });
    await sessions.save({
      id: asId<'LiveSession'>(SESSION),
      roomId: asId<'LiveRoom'>('room-api-1'),
      state: 'live',
      startedAt: new Date(),
      endedAt: null,
    });
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  async function call(
    method: string,
    path: string,
    account?: Account,
    body?: unknown,
  ): Promise<ApiResponse> {
    const response = await r.api.call(method, `/live${path}`, { token: account?.token, body });
    liveTranscript.push(response.raw);
    return response;
  }

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;

  it('refuses every live route to an anonymous caller', async () => {
    for (const [method, path] of [
      ['POST', `/sessions/${SESSION}/join`],
      ['POST', `/sessions/${SESSION}/hand`],
      ['DELETE', `/sessions/${SESSION}/hand`],
      ['POST', '/requests/x/grant'],
      ['POST', '/requests/x/decline'],
      ['POST', '/requests/x/revoke'],
    ]) {
      expect({ method, path, status: (await call(method, path)).status }).toEqual({
        method,
        path,
        status: 401,
      });
    }
  });

  it('joins a listener with a 120-second ticket, named by the directory — never by the client', async () => {
    const before = rtc.issued.length;
    const response = await call('POST', `/sessions/${SESSION}/join`, student, {
      displayName: 'الأستاذة عائشة',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      expiresInSeconds: 120,
      role: 'listener',
      media: { microphone: false, screen: false, screenAudio: false },
    });
    // The name a client sent is ignored: a student cannot appear as the teacher.
    expect(rtc.issued[before]).toMatchObject({ identity: student.id, displayName: 'مريم' });
    expect(rtc.issued[before]?.capabilities.canPublishData).toBe(false);
  });

  it('joins the host as moderator with the microphone', async () => {
    const response = await call('POST', `/sessions/${SESSION}/join`, host);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ role: 'moderator', media: { microphone: true } });
  });

  it('raises a hand with 201, answers the same hand with 200, and lowers it', async () => {
    const first = await call('POST', `/sessions/${SESSION}/hand`, student);
    expect(first.status).toBe(201);
    const request = first.body.request as Record<string, unknown>;
    expect(request).toMatchObject({ state: 'pending', userId: student.id });

    const again = await call('POST', `/sessions/${SESSION}/hand`, student);
    expect(again.status).toBe(200);
    expect((again.body.request as Record<string, unknown>).id).toBe(request.id);

    const lowered = await call('DELETE', `/sessions/${SESSION}/hand`, student);
    expect(lowered.status).toBe(200);
    expect(lowered.body.request).toMatchObject({ id: request.id, state: 'withdrawn' });

    const nothing = await call('DELETE', `/sessions/${SESSION}/hand`, student);
    expect(nothing.status).toBe(200);
    expect(nothing.body).toEqual({ request: null });
  });

  it('lets only the host give, refuse and take back the floor', async () => {
    const raised = await call('POST', `/sessions/${SESSION}/hand`, student);
    const id = (raised.body.request as Record<string, unknown>).id as string;

    expect((await call('POST', `/requests/${id}/grant`, student)).status).toBe(403);
    const notHost = await call('POST', `/requests/${id}/grant`, otherTeacher);
    expect(notHost.status).toBe(403);

    const granted = await call('POST', `/requests/${id}/grant`, host);
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ request: { state: 'granted' }, media: 'applied' });
    const repeat = await call('POST', `/requests/${id}/grant`, host);
    expect(repeat.body).toMatchObject({ request: { state: 'granted' }, media: 'unchanged' });

    // The speaker re-joins with the microphone; the decision was the server's.
    const rejoined = await call('POST', `/sessions/${SESSION}/join`, student);
    expect(rejoined.body).toMatchObject({ role: 'speaker', media: { microphone: true } });

    const revoked = await call('POST', `/requests/${id}/revoke`, host);
    expect(revoked.body).toMatchObject({ request: { state: 'revoked' }, media: 'applied' });
    expect(code(await call('POST', `/requests/${id}/decline`, host))).toBe(
      'live.invalid_transition',
    );
  });

  it('declines a pending hand', async () => {
    const raised = await call('POST', `/sessions/${SESSION}/hand`, student);
    const id = (raised.body.request as Record<string, unknown>).id as string;
    const declined = await call('POST', `/requests/${id}/decline`, host);
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ request: { id, state: 'declined' } });
  });

  it('reports an unknown session or request as not found', async () => {
    expect(code(await call('POST', '/sessions/nope/join', student))).toBe('live.session_not_found');
    expect(code(await call('POST', '/sessions/nope/hand', student))).toBe('live.session_not_found');
    expect(code(await call('POST', '/requests/nope/grant', host))).toBe('live.request_not_found');
  });

  it('never returns an email in any live response', () => {
    expect(liveTranscript.length).toBeGreaterThan(10);
    for (const raw of liveTranscript) expect(raw).not.toContain('@');
  });
});
