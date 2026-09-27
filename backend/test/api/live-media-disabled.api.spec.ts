import {
  EVENT_SUBSCRIBER,
  FixedClock,
  type DomainEvent,
  type EventSubscriber,
} from '../../src/shared';
import { LiveEvents } from '../../src/modules/live/contracts';
import {
  LIVE_SESSION_REPOSITORY,
  type LiveSessionRepository,
} from '../../src/modules/live/domain/ports';
import { RTC_PROVIDER } from '../../src/modules/live/domain/rtc-provider';
import { DisabledRtcProvider } from '../../src/modules/live/infrastructure/disabled-rtc-provider';
import { InMemoryLiveStore } from '../../src/modules/live/infrastructure/in-memory-live-repositories';
import { LiveKitRtcProvider } from '../../src/modules/live/infrastructure/livekit-rtc-provider';
import type * as LiveKitAdapter from '../../src/modules/live/infrastructure/livekit-rtc-provider';
import { LIVE_STORE, rtcProviderFor, type LiveStore } from '../../src/modules/live/live.module';
import { loadConfig } from '../../src/platform/config/app-config';
import type { ApiResponse } from '../support/api-client';
import { LogCapture, credentialsIn } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

// The LiveKit adapter, counted: each construction is recorded, then made as
// the module would make it. Nothing else about the adapter changes.
jest.mock('../../src/modules/live/infrastructure/livekit-rtc-provider', () => {
  const actual = jest.requireActual<typeof LiveKitAdapter>(
    '../../src/modules/live/infrastructure/livekit-rtc-provider',
  );
  return {
    ...actual,
    LiveKitRtcProvider: jest.fn(
      (...args: ConstructorParameters<typeof actual.LiveKitRtcProvider>) =>
        new actual.LiveKitRtcProvider(...args),
    ),
  };
});
const constructed = LiveKitRtcProvider as unknown as jest.Mock;

/** Real credentials in the environment — a deployment that has not asked for real media. */
const LIVEKIT_SECRET = 'a-real-looking-livekit-secret-of-48-bytes-000000';

/**
 * The provider binding (P6 audit, D19), through the real application: a
 * deployment that holds LiveKit credentials but has not set
 * `LIVE_MEDIA_PROVIDER=livekit` never constructs the LiveKit adapter, and
 * Start answers 503 `live.media_unavailable` with nothing stored — no row,
 * no audit entry, no event. The module's own factory, fed the opt-in, is the
 * control that the count sees a construction at all.
 */
describe('live without real media enabled', () => {
  const logs = new LogCapture();
  const events: DomainEvent[] = [];
  let r: RealtimeApi;
  let host: Account;
  let delegate: Account;
  let member: Account;
  let communityId: string;

  beforeAll(async () => {
    r = await startRealtimeApi(
      {
        LIVEKIT_URL: 'wss://media.school.example',
        LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6',
        LIVEKIT_API_SECRET: LIVEKIT_SECRET,
        LIVE_MEDIA_PROVIDER: '',
        LIVE_ROOM_NAME_PREFIX: 'live-school-a-',
      },
      { logger: logs },
    );
    const bus = r.api.app.get<EventSubscriber>(EVENT_SUBSCRIBER, { strict: false });
    for (const name of Object.values(LiveEvents)) {
      bus.subscribe(name, (event) => {
        events.push(event);
      });
    }
    const admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    host = await r.provision('host', 'TEACHER', 'الأستاذة عائشة');
    delegate = await r.provision('delegate', 'TEACHER', 'الأستاذة سودة');
    member = await r.provision('member', 'STUDENT', 'مريم');
    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [host, delegate, member]);
    await r.grantCapabilities(admin, communityId, host.id, ['community.live.start']);
    await r.grantCapabilities(admin, communityId, delegate.id, [
      'community.live.start',
      'community.live.moderate',
    ]);
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  const call = (method: string, path: string, account: Account): Promise<ApiResponse> =>
    r.api.call(method, `/live${path}`, { token: account.token });

  const liveAudits = () =>
    logs
      .logged()
      .map(([first]) => first as Record<string, unknown> | null)
      .filter(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          entry.audit === true &&
          String(entry.action).startsWith('live.'),
      );

  it('binds the disabled provider, and never constructs the LiveKit adapter', () => {
    expect(r.api.app.get(RTC_PROVIDER, { strict: false })).toBeInstanceOf(DisabledRtcProvider);
    expect(constructed).not.toHaveBeenCalled();
    expect(logs.text()).toContain('media provider: disabled');

    // The control: the module's own factory, given the opt-in, constructs it
    // — so the count above would have seen a construction.
    const clock = new FixedClock(new Date('2026-09-27T09:00:00.000Z'));
    const optedIn = rtcProviderFor(
      loadConfig({
        LIVE_MEDIA_PROVIDER: 'livekit',
        LIVE_ROOM_NAME_PREFIX: 'live-school-a-',
        LIVEKIT_URL: 'wss://media.school.example',
        LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6',
        LIVEKIT_API_SECRET: LIVEKIT_SECRET,
      }),
      clock,
      { log: () => undefined, warn: () => undefined },
    );
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(optedIn).toBe(constructed.mock.results[0]?.value);
    constructed.mockClear();
  });

  it('answers Start with 503 live.media_unavailable and stores nothing — no row, no audit entry, no event', async () => {
    const store = r.api.app.get<LiveStore>(LIVE_STORE, { strict: false });
    expect(store).toBeInstanceOf(InMemoryLiveStore);
    const sessions = r.api.app.get<LiveSessionRepository>(LIVE_SESSION_REPOSITORY, {
      strict: false,
    });
    const start = jest.spyOn(sessions, 'start');
    try {
      for (const account of [host, delegate, host]) {
        const refused = await call('POST', `/communities/${communityId}/sessions`, account);
        expect({ status: refused.status, error: refused.body.error }).toEqual({
          status: 503,
          error: {
            kind: 'unavailable',
            code: 'live.media_unavailable',
            message: expect.any(String) as string,
          },
        });
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }

    expect(await sessions.findLiveByCommunity(communityId)).toBeNull();
    expect(await sessions.listLive(null, 100)).toEqual([]);
    expect(
      (await call('GET', `/communities/${communityId}/sessions/current`, member)).body,
    ).toEqual({ session: null });
    expect(liveAudits()).toEqual([]);
    expect(events).toEqual([]);
    expect(constructed).not.toHaveBeenCalled();

    // Nothing the deployment logged, or answered, holds its LiveKit secret or a token.
    expect(logs.text()).not.toContain(LIVEKIT_SECRET);
    expect(r.api.transcript.join('\n')).not.toContain(LIVEKIT_SECRET);
    expect(credentialsIn(logs.text())).toEqual([]);
  });
});
