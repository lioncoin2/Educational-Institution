import { randomBytes } from 'node:crypto';

import {
  RtcMisconfiguredError,
  RtcUnavailableError,
} from '../../src/modules/live/domain/rtc-provider';
import { ConfigurationError, loadConfig } from '../../src/platform/config/app-config';
import { PINNED_LIVEKIT_SERVER_VERSION } from '../../src/platform/config/livekit-config';
import { META, captureLogs, codeOf } from '../support/live-harness';
import { closedPort, startStubHttpServer, type StubHttpServer } from '../support/stub-http-server';
import { realAdapter, realLive, realMediaEnv, type RealLive } from './support/real-live';
import { ServerView, leakedCredentials } from './support/server-view';
import { serverLog, testServer } from './support/test-servers';

/**
 * A key no server holds: the server logs a request that carries it, as
 * `apiKey` (SRV pkg/service/auth.go:90-93).
 */
const unknownKey = () => `APIunknown${randomBytes(4).toString('hex')}`;

/** A room of the harness's deployment, as Start would ensure it. */
const anyRoom = (live: RealLive) => ({
  roomName: `${live.settings.roomNamePrefix}any`,
  maxParticipants: 10,
  emptyTimeoutSeconds: 60,
  departureTimeoutSeconds: 60,
});

/**
 * Start, where the provider is not ready: 503 — live.media_unavailable for
 * an outage, live.media_misconfigured for this deployment's configuration
 * (P7.2, Q-B) — and nothing stored: no session, no audit, no event, no room
 * on the server.
 */
async function expectStartRefused(
  live: RealLive,
  code: 'live.media_unavailable' | 'live.media_misconfigured',
): Promise<void> {
  const { id, owner } = await live.community('teacher-1');
  const started = await live.start.execute({ principal: owner, communityId: id, meta: META });
  expect(codeOf(started)).toBe(code);
  expect(await live.sessions.findLiveByCommunity(id)).toBeNull();
  expect([...live.audits(), ...live.eventNames()]).toEqual([]);
  expect(await live.view.roomsNamed(live.settings.roomNamePrefix)).toEqual([]);
}

/**
 * The provider's self-check (P7.1, decision 7) against the pinned server —
 * `/rtc/validate` and the room API, for real — and the Start gate it
 * drives (brief §10, items 14, 16, 17 and 18):
 *
 *   - the suite's servers are the pinned release, started from the
 *     committed policy file, on loopback;
 *   - the right server, key and secret: READY, and Start makes the room;
 *   - a secret or a key the server does not hold: NOT_READY `unauthorized`;
 *   - a server where LIVEKIT_ROOM_AUTO_CREATE=true overrides the file:
 *     NOT_READY `auto_create_enabled`;
 *   - a deployed environment with a ws:// client URL: boot refused, and
 *     `insecure_url` before any request is made;
 *   - a wrong endpoint — something else answering, nothing listening, no
 *     such host: NOT_READY, and every call a provider failure.
 *
 * Every NOT_READY stops Start with 503 and nothing stored: an outage
 * `live.media_unavailable`, anything else `live.media_misconfigured` (P7.2,
 * Q-B).
 */
describe('readiness against the pinned LiveKit server', () => {
  const policy = testServer('policy');
  const autoCreate = testServer('auto_create');
  /** Every secret this file configures: none may be logged, by either side. */
  const secrets = [policy.apiSecret, autoCreate.apiSecret];
  let logs: ReturnType<typeof captureLogs>;
  let stub: StubHttpServer;

  beforeAll(async () => {
    logs = captureLogs();
    stub = await startStubHttpServer();
  });

  afterAll(async () => {
    await stub.close();
    jest.restoreAllMocks();
  });

  it('runs the pinned release from the committed policy file, on loopback, its per-host values given through LiveKit’s variables', () => {
    for (const server of [policy, autoCreate]) {
      const lines = serverLog(server);
      expect(lines.find((line) => line.msg === 'starting LiveKit server')).toMatchObject({
        version: PINNED_LIVEKIT_SERVER_VERSION,
        portHttp: Number(new URL(server.httpUrl).port),
        bindAddresses: ['127.0.0.1'],
        nodeIP: '127.0.0.1',
      });
      // The file's `logging` in effect: JSON lines (LiveKit's default is
      // console text), at info and above.
      expect(lines.length).toBeGreaterThan(0);
      expect(
        lines.filter((line) => !['info', 'warn', 'error'].includes(String(line.level))),
      ).toEqual([]);
    }
  });

  it('is READY against the policy server — reachable, our credentials taken, auto_create off — and Start makes the room', async () => {
    const live = realLive();
    expect(await live.adapter.check()).toEqual({ ready: true });

    const { id, owner } = await live.community('teacher-1');
    const session = await live.startSession(owner, id);
    const room = live.room(session.id);
    const [created] = await live.view.rooms.listRooms([room]);
    expect(created?.name).toBe(room);
    // Sized by the application — the session's cap plus its reserve.
    const stored = await live.session(session.id);
    expect(created?.maxParticipants).toBe(stored.participantCap + stored.moderatorReserve);
    expect(logs.lines.map((line) => line.fields)).toContainEqual({
      event: 'live.provider.health_check',
      status: 'ready',
    });
    await live.end.execute({ principal: owner, sessionId: session.id, meta: META });
  });

  it('is NOT_READY unauthorized with a secret the server does not hold — and Start stores nothing', async () => {
    const secret = randomBytes(32).toString('base64url');
    secrets.push(secret);
    const live = realLive({ env: { LIVEKIT_API_SECRET: secret } });
    expect(await live.adapter.check()).toEqual({ ready: false, reason: 'unauthorized' });
    await expectStartRefused(live, 'live.media_misconfigured');
  });

  it('is NOT_READY unauthorized with a key the server does not know — and Start stores nothing', async () => {
    const key = unknownKey();
    const live = realLive({ env: { LIVEKIT_API_KEY: key } });
    expect(await live.adapter.check()).toEqual({ ready: false, reason: 'unauthorized' });
    // The server saw the request, and says so: the check below relies on it.
    expect(serverLog(policy).some((line) => line.apiKey === key)).toBe(true);
    await expectStartRefused(live, 'live.media_misconfigured');
  });

  it('is NOT_READY auto_create_enabled where LIVEKIT_ROOM_AUTO_CREATE=true overrides the file — and Start stores nothing', async () => {
    const live = realLive({ server: 'auto_create' });
    expect(await live.adapter.check()).toEqual({ ready: false, reason: 'auto_create_enabled' });
    await expectStartRefused(live, 'live.media_misconfigured');
    expect(logs.lines.map((line) => line.fields)).toContainEqual({
      event: 'live.provider.health_check',
      status: 'not_ready',
      reason: 'auto_create_enabled',
    });
  });

  it('refuses to boot a deployed environment with a ws:// client URL, and reports insecure_url before any request', async () => {
    for (const environment of ['staging', 'production']) {
      expect(() => loadConfig(realMediaEnv(policy, { NODE_ENV: environment }))).toThrow(
        ConfigurationError,
      );
      expect(() => loadConfig(realMediaEnv(policy, { NODE_ENV: environment }))).toThrow(
        `LIVEKIT_URL must use wss:// in ${environment}: clients never connect in clear`,
      );
    }
    // Past the boot check anyway (defence in depth): the adapter itself
    // refuses, and sends nothing — the server never saw its key.
    const key = unknownKey();
    const deployed = {
      ...loadConfig(realMediaEnv(policy, { LIVEKIT_API_KEY: key })),
      nodeEnv: 'production' as const,
    };
    expect(await realAdapter(deployed).check()).toEqual({ ready: false, reason: 'insecure_url' });
    expect(serverLog(policy).some((line) => line.apiKey === key)).toBe(false);
  });

  describe('a wrong endpoint is a provider failure, and never READY', () => {
    it('something that is not LiveKit answering: NOT_READY incompatible_response, and the room API a misconfiguration', async () => {
      stub.answer({ status: 404, contentType: 'text/html', body: '<h1>404 Not Found</h1>' });
      const live = realLive({ env: { LIVEKIT_URL: stub.url.replace(/^http/, 'ws') } });
      expect(await live.adapter.check()).toEqual({
        ready: false,
        reason: 'incompatible_response',
      });
      for (const call of [live.adapter.listRooms(), live.adapter.ensureRoom(anyRoom(live))]) {
        await expect(call).rejects.toThrow(RtcMisconfiguredError);
        await expect(call).rejects.toMatchObject({ reason: 'incompatible_response' });
      }
      await expectStartRefused(live, 'live.media_misconfigured');
    });

    it.each([
      ['nothing listening', async () => `ws://127.0.0.1:${await closedPort()}`],
      ['a host that does not resolve', async () => 'ws://livekit.invalid:7880'],
    ])('%s: NOT_READY unreachable, and the room API an outage', async (_case, url) => {
      const live = realLive({ env: { LIVEKIT_URL: await url() } });
      expect(await live.adapter.check()).toEqual({ ready: false, reason: 'unreachable' });
      await expect(live.adapter.listRooms()).rejects.toThrow(RtcUnavailableError);
      await expect(live.adapter.ensureRoom(anyRoom(live))).rejects.toThrow(RtcUnavailableError);
      await expectStartRefused(live, 'live.media_unavailable');
    });
  });

  it('logs no secret, no token and no Authorization header — neither the application nor the servers', () => {
    const written = [
      JSON.stringify(logs.lines),
      new ServerView(policy).logText(),
      new ServerView(autoCreate).logText(),
    ].join('\n');
    expect(leakedCredentials(written, secrets)).toEqual([]);
  });
});
