import { randomBytes } from 'node:crypto';

import { LiveKitRtcProvider } from '../../../src/modules/live/infrastructure/livekit-rtc-provider';
import { liveSettingsFor, rtcProviderFor } from '../../../src/modules/live/live.module';
import { loadConfig, type AppConfig } from '../../../src/platform/config/app-config';
import { PINNED_LIVEKIT_SERVER_VERSION } from '../../../src/platform/config/livekit-config';
import { communitiesHarness } from '../../support/communities-harness';
import { AdjustableClock } from '../../support/identity-harness';
import { liveHarness, type LiveHarness } from '../../support/live-harness';
import { ServerView } from './server-view';
import { testServer, type TestServer, type TestServerName } from './test-servers';

/**
 * Real media, configured as a deployment enables it — `loadConfig` over
 * LIVE_MEDIA_PROVIDER=livekit, the server's URL, key and secret, the pinned
 * version, and a room prefix of this harness's own (no other test file's
 * rooms are ever its orphans) — with `env` changed on top: another secret,
 * another URL…
 */
export function realMediaEnv(
  server: TestServer,
  env: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    LIVE_MEDIA_PROVIDER: 'livekit',
    LIVE_ROOM_NAME_PREFIX: `suite-${randomBytes(4).toString('hex')}-`,
    LIVEKIT_URL: server.url,
    LIVEKIT_API_KEY: server.apiKey,
    LIVEKIT_API_SECRET: server.apiSecret,
    LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
    ...env,
  };
}

/** The media provider the module binds for this configuration — LiveKit, or a failure. */
export function realAdapter(config: AppConfig, clock = new AdjustableClock(new Date())) {
  const provider = rtcProviderFor(config, clock);
  if (!(provider instanceof LiveKitRtcProvider)) {
    throw new Error(`The module bound ${provider.constructor.name}, not the LiveKit adapter.`);
  }
  return provider;
}

export interface RealLiveOptions {
  /** The server the application talks to; the policy server by default. */
  readonly server?: TestServerName;
  /** Settings changed on top of `realMediaEnv`. */
  readonly env?: Readonly<Record<string, string>>;
}

export type RealLive = LiveHarness & {
  readonly config: AppConfig;
  readonly adapter: LiveKitRtcProvider;
  readonly server: TestServer;
  /** The server's own view — never the adapter's. */
  readonly view: ServerView;
};

/**
 * Live as `liveHarness` assembles it — the use cases, the reconciler and
 * `LiveMediaReadiness` over the real Communities — with the REAL LiveKit
 * adapter bound where the fake would be, exactly as the module binds it
 * (`rtcProviderFor`), talking to one of the suite's servers. The clock
 * starts at the real time, as the server's does.
 */
export function realLive(options: RealLiveOptions = {}): RealLive {
  const server = testServer(options.server ?? 'policy');
  const config = loadConfig(realMediaEnv(server, options.env));
  const communities = communitiesHarness({ clock: new AdjustableClock(new Date()) });
  const adapter = realAdapter(config, communities.clock);
  const h = liveHarness({ communities, provider: adapter, settings: liveSettingsFor(config) });
  return Object.assign(h, { config, adapter, server, view: new ServerView(server) });
}
