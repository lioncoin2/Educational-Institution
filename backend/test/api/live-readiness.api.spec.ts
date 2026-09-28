import { LiveMediaReadiness } from '../../src/modules/live/application/live-media-readiness';
import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import { ProtectLiveSessions } from '../../src/modules/live/application/protect-live-sessions';
import { RTC_PROVIDER } from '../../src/modules/live/domain/rtc-provider';
import type { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * Start's gate and the room sweep, as the module wires them (live.md §9,
 * P7.1): one `LiveMediaReadiness` behind both, so the answer a room sweep
 * gets from the provider's self-check is the one Start gives over HTTP —
 * 503 `live.media_unavailable` while it is not ready — without asking the
 * provider again.
 */
describe('live media readiness in the application', () => {
  let r: RealtimeApi;
  let host: Account;
  let communityId: string;
  let rtc: FakeRtcProvider;
  let reconciler: LiveReconciler;

  beforeAll(async () => {
    // The fake media provider, bound as development binds it.
    r = await startRealtimeApi({
      LIVEKIT_API_SECRET: 'development-only-secret',
      LIVE_MEDIA_PROVIDER: '',
      LIVE_ROOM_NAME_PREFIX: '',
    });
    // Only the sweeps called below run: no timer, and no Communities-driven check.
    reconciler = r.api.app.get(LiveReconciler, { strict: false });
    await reconciler.stop();
    await r.api.app.get(ProtectLiveSessions, { strict: false }).onModuleDestroy();
    rtc = r.api.app.get<FakeRtcProvider>(RTC_PROVIDER, { strict: false });

    const admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    host = await r.provision('host', 'TEACHER', 'الأستاذة عائشة');
    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [host]);
    await r.grantCapabilities(admin, communityId, host.id, ['community.live.start']);
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  const start = (): Promise<ApiResponse> =>
    r.api.call('POST', `/live/communities/${communityId}/sessions`, { token: host.token });

  it('gives Start the answer the room sweep got — refused while not ready, started once ready', async () => {
    const readiness = r.api.app.get(LiveMediaReadiness, { strict: false });
    const check = jest.spyOn(rtc, 'check');
    try {
      rtc.setReadiness({ ready: false, reason: 'auto_create_enabled' });
      await reconciler.sweepRooms();
      expect(readiness.current?.report).toEqual({ ready: false, reason: 'auto_create_enabled' });
      const refused = await start();
      // A server with auto-create on is this deployment's configuration: an
      // operator must fix it (P7.2, Q-B).
      expect({ status: refused.status, error: refused.body.error }).toEqual({
        status: 503,
        error: {
          kind: 'unavailable',
          code: 'live.media_misconfigured',
          message: expect.any(String) as string,
        },
      });
      expect(rtc.roomNames()).toEqual([]);

      // An outage is told apart: waiting may fix it.
      rtc.setReadiness({ ready: false, reason: 'unreachable' });
      await reconciler.sweepRooms();
      const unreachable = await start();
      expect(unreachable.status).toBe(503);
      expect(unreachable.body.error).toMatchObject({
        kind: 'unavailable',
        code: 'live.media_unavailable',
      });
      expect(rtc.roomNames()).toEqual([]);

      rtc.setReadiness({ ready: true });
      await reconciler.sweepRooms();
      expect((await start()).status).toBe(201);
      expect(rtc.roomNames()).toHaveLength(1);
      // One self-check per sweep; Start asked the provider nothing itself.
      expect(check).toHaveBeenCalledTimes(3);
    } finally {
      check.mockRestore();
    }
  });
});
