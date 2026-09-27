import { randomBytes } from 'node:crypto';

import { RTC_PROVIDER } from '../../src/modules/live/domain/rtc-provider';
import { LiveKitRtcProvider } from '../../src/modules/live/infrastructure/livekit-rtc-provider';
import { PINNED_LIVEKIT_SERVER_VERSION } from '../../src/platform/config/livekit-config';
import { LogCapture } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import { mediaClients } from './support/media-client';
import { ServerView, leakedCredentials } from './support/server-view';
import { testServer } from './support/test-servers';

/**
 * The application exactly as a deployment runs it — AppModule, the HTTP
 * server, the module's own binding (D19) — with real media enabled by its
 * environment alone, against the pinned server: the LiveKit adapter bound on
 * the explicit opt-in and logged without a key or a secret, Start over HTTP
 * once the self-check passes, and a ticket from `/join` that admits a real
 * client into the room Start made. (The platform module reads its
 * configuration once, when first imported: one application per file.)
 */
describe('the application with real media enabled, against the pinned LiveKit server', () => {
  const server = testServer('policy');
  const view = new ServerView(server);
  const clients = mediaClients();
  const logs = new LogCapture();
  const saved = { ...process.env };
  const prefix = `suite-${randomBytes(4).toString('hex')}-`;
  let r: RealtimeApi;
  let host: Account;
  let student: Account;
  let communityId: string;

  beforeAll(async () => {
    r = await startRealtimeApi(
      {
        LIVE_MEDIA_PROVIDER: 'livekit',
        LIVE_ROOM_NAME_PREFIX: prefix,
        LIVEKIT_URL: server.url,
        LIVEKIT_API_KEY: server.apiKey,
        LIVEKIT_API_SECRET: server.apiSecret,
        LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
      },
      { logger: logs },
    );
    const admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    host = await r.provision('host', 'TEACHER', 'الأستاذة عائشة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [host, student]);
    await r.grantCapabilities(admin, communityId, host.id, ['community.live.start']);
  }, 60_000);

  afterAll(async () => {
    await clients.closeAll();
    await r.close();
    // startApi set these for the application it booted; the next file in
    // this worker starts from the environment it had.
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  it('binds the LiveKit adapter, and logs where it talks — never a key or a secret', () => {
    expect(r.api.app.get(RTC_PROVIDER, { strict: false })).toBeInstanceOf(LiveKitRtcProvider);
    const where = new URL(server.url).host;
    expect(logs.logged().map(([fields]) => fields)).toContainEqual({
      event: 'live.provider.initialize',
      provider: 'livekit',
      apiHost: where,
      clientHost: where,
      roomNamePrefix: prefix,
      version: PINNED_LIVEKIT_SERVER_VERSION,
    });
  });

  it('starts a session over HTTP, and admits a real client with the ticket /join issues', async () => {
    const started = await r.api.call('POST', `/live/communities/${communityId}/sessions`, {
      token: host.token,
    });
    expect(started.status).toBe(201);
    const sessionId = started.body.id as string;
    const room = `${prefix}${sessionId}`;
    expect(await view.roomsNamed(prefix)).toEqual([room]);
    expect(logs.logged().map(([fields]) => fields)).toContainEqual({
      event: 'live.provider.health_check',
      status: 'ready',
    });

    const joined = await r.api.call('POST', `/live/sessions/${sessionId}/join`, {
      token: student.token,
    });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ url: server.url, role: 'listener' });
    const client = await clients.connect({
      url: joined.body.url as string,
      token: joined.body.token as string,
    });
    expect({ identity: client.identity, name: client.name }).toEqual({
      identity: student.id,
      name: 'مريم',
    });
    expect(await view.identities(room)).toEqual([student.id]);

    const ended = await r.api.call('POST', `/live/sessions/${sessionId}/end`, {
      token: host.token,
    });
    expect(ended.status).toBe(200);
    expect(await view.roomsNamed(prefix)).toEqual([]);
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the server', () => {
    const written = [logs.text(), view.logText()].join('\n');
    expect(leakedCredentials(written, [server.apiSecret])).toEqual([]);
  });
});
