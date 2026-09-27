import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import { ProtectLiveSessions } from '../../src/modules/live/application/protect-live-sessions';
import type { ApiResponse } from '../support/api-client';
import { credentialsIn } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import type { Frame, TestSocket } from '../support/realtime-client';

const liveFrames = (socket: TestSocket): Frame[] =>
  socket.frames.filter((frame) => frame.type.startsWith('live.'));

/**
 * Live's frames over real sockets (P6, commit E): the application exactly as
 * the server runs it without a database or media credentials — AppModule's
 * wiring, RealtimeModule importing LiveModule, the real in-process bus from
 * Live's journal to LiveRealtimeRelay, the fake media provider — driven over
 * HTTP, received by a `ws` client. Every frame is a hint the client answers
 * over HTTP.
 */
describe('live frames over the realtime API', () => {
  let r: RealtimeApi;
  let admin: Account;
  let host: Account;
  let delegate: Account;
  let student: Account;
  let outsider: Account;
  let communityId: string;
  /** Every join ticket's token, as issued. */
  const tickets: string[] = [];

  beforeAll(async () => {
    // The fake media provider, bound as development binds it, whatever the
    // shell running the tests exports.
    r = await startRealtimeApi({
      LIVEKIT_API_SECRET: 'development-only-secret',
      LIVE_MEDIA_PROVIDER: '',
      LIVE_ROOM_NAME_PREFIX: '',
    });
    // Nothing but the requests below changes a session: the reconciler's
    // timers and Communities-driven checks are tested on their own.
    await r.api.app.get(LiveReconciler, { strict: false }).stop();
    await r.api.app.get(ProtectLiveSessions, { strict: false }).onModuleDestroy();

    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    host = await r.provision('host', 'TEACHER', 'الأستاذة عائشة');
    delegate = await r.provision('delegate', 'TEACHER', 'الأستاذة حفصة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    outsider = await r.provision('outsider', 'STUDENT', 'زينب');

    // The admin makes the community, hands it to the host and leaves.
    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [host, delegate, student]);
    await expectStatus(
      r.api.call('PUT', `/communities/${communityId}/owner`, {
        token: admin.token,
        body: { userId: host.id },
      }),
      200,
    );
    await expectStatus(
      r.api.call('POST', `/communities/${communityId}/leave`, { token: admin.token }),
      204,
    );
    await r.grantCapabilities(host, communityId, delegate.id, ['community.live.moderate']);
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  async function expectStatus(response: Promise<ApiResponse>, status: number): Promise<void> {
    const answered = await response;
    if (answered.status !== status) throw new Error(`${answered.status}: ${answered.raw}`);
  }

  async function call(method: string, path: string, account: Account): Promise<ApiResponse> {
    const response = await r.api.call(method, `/live${path}`, { token: account.token });
    if (path.endsWith('/join') && response.status === 200) {
      tickets.push(response.body.token as string);
    }
    return response;
  }

  it('tells a start to a connected member and not to a connected outsider; a grant to the requester and a moderator — never a token', async () => {
    const s = await r.connect(student);
    const m = await r.connect(delegate);
    const stranger = await r.connect(outsider);
    try {
      const started = await call('POST', `/communities/${communityId}/sessions`, host);
      expect(started.status).toBe(201);
      const sessionId = started.body.id as string;

      expect(await s.waitFor((f) => f.type === 'live.session.started')).toEqual({
        type: 'live.session.started',
        eventId: `live.session.started:${sessionId}`,
        occurredAt: expect.any(String) as string,
        communityId,
        sessionId,
        version: 1,
      });
      await m.waitFor((f) => f.type === 'live.session.started');

      // The student joins (a ticket over HTTP only), raises a hand, and is given the floor.
      expect((await call('POST', `/sessions/${sessionId}/join`, student)).status).toBe(200);
      expect((await call('POST', `/sessions/${sessionId}/hand`, student)).status).toBe(201);
      const hands = await call('GET', `/sessions/${sessionId}/hands`, delegate);
      const [hand] = hands.body.items as { id: string }[];
      expect((await call('POST', `/requests/${hand.id}/grant`, delegate)).status).toBe(200);
      const session = await call('GET', `/sessions/${sessionId}`, student);
      const granted = session.body.stateVersion as number;

      const changedTo = (socket: TestSocket) =>
        socket.waitFor((f) => f.type === 'live.session.changed' && f.stateVersion === granted);
      expect(await changedTo(s)).toEqual({
        type: 'live.session.changed',
        eventId: `live.session.changed:${sessionId}:${granted}`,
        occurredAt: expect.any(String) as string,
        communityId,
        sessionId,
        stateVersion: granted,
        version: 1,
      });
      // The moderator hears of it too — once the coalescing window has closed.
      expect(await changedTo(m)).toMatchObject({ communityId, sessionId, stateVersion: granted });

      expect((await call('POST', `/sessions/${sessionId}/end`, host)).status).toBe(200);
      for (const socket of [s, m]) {
        expect(await socket.waitFor((f) => f.type === 'live.session.ended')).toMatchObject({
          eventId: `live.session.ended:${sessionId}`,
          reason: 'moderator',
        });
      }
      await r.liveRelay.idle();

      // The outsider heard nothing of the session at all.
      expect(liveFrames(stranger)).toEqual([]);
      // Ids, a reason and versions: no name, no email, and never a token — the ticket included.
      expect(tickets).toHaveLength(1);
      const wire = JSON.stringify([...s.frames, ...m.frames, ...stranger.frames]);
      expect(wire).not.toContain(tickets[0]);
      expect(credentialsIn(wire)).toEqual([]);
      expect(wire).not.toMatch(/عائشة|حفصة|مريم|حلقة|@/);
    } finally {
      await Promise.all([s.close(), m.close(), stranger.close()]);
    }
  });
});
