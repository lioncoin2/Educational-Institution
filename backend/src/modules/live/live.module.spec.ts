import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

import {
  APP_CONFIG,
  ConfigurationError,
  loadConfig,
  type AppConfig,
} from '../../platform/config/app-config';
import { CLOCK, FixedClock, type Clock } from '../../shared';
import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { LIVE_SETTINGS, type LiveSettings } from './application/live-settings';
import { JOIN_TOKEN_TTL_SECONDS } from './domain/live-limits';
import {
  RTC_OBSERVER,
  RTC_PARTICIPANTS,
  RTC_PROVIDER,
  RTC_ROOMS,
  RTC_TOKENS,
  RtcUnavailableError,
  type RtcProvider,
} from './domain/rtc-provider';
import { capabilitiesFor } from './domain/standing';
import { DisabledRtcProvider } from './infrastructure/disabled-rtc-provider';
import { FakeRtcProvider } from './infrastructure/fake-rtc-provider';
import { LiveKitRtcProvider } from './infrastructure/livekit-rtc-provider';
import { LiveModule } from './live.module';

/** A provider as the module declares it. */
interface Declared {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory?: (...args: never[]) => unknown;
  readonly useExisting?: unknown;
}

function declared(token: unknown): Declared {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LiveModule) as unknown[];
  const found = providers.find(
    (provider): provider is Declared =>
      typeof provider === 'object' && provider !== null && (provider as Declared).provide === token,
  );
  if (found === undefined) throw new Error(`LiveModule declares no provider for ${String(token)}`);
  return found;
}

const clock: Clock = new FixedClock(new Date('2026-09-27T09:00:00.000Z'));

/**
 * A boot, as far as the media provider goes: the configuration is read and
 * validated as the platform reads it, then the module's OWN factory binds —
 * not a copy of its choice.
 */
function boot(env: Record<string, string>): RtcProvider {
  const bind = declared(RTC_PROVIDER).useFactory as (
    config: AppConfig,
    clock: Clock,
  ) => RtcProvider;
  return bind(loadConfig(env), clock);
}

/** A complete production configuration, with no real media asked for. */
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app@db/institution',
  REDIS_URL: 'redis://cache:6379',
  JWT_SECRET: 'j'.repeat(48),
  STORAGE_SIGNING_SECRET: 'k'.repeat(48),
  LIVEKIT_URL: 'wss://media.school.example',
  LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6',
  LIVEKIT_API_SECRET: 's'.repeat(40),
};

/** What enabling real media takes: the opt-in, this deployment's room prefix, a real key and secret. */
const REAL_MEDIA = {
  LIVE_MEDIA_PROVIDER: 'livekit',
  LIVE_ROOM_NAME_PREFIX: 'live-school-a-',
  LIVEKIT_URL: 'wss://media.school.example',
  LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6',
  LIVEKIT_API_SECRET: 's'.repeat(40),
};

describe('the Live module', () => {
  it('imports identity and Communities, and exports nothing until its contracts do', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, LiveModule)).toEqual([
      IdentityModule,
      CommunitiesModule,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, LiveModule)).toBeUndefined();
  });

  it('binds the provider once, from the configuration and the clock, and every narrow port to it', () => {
    expect(declared(RTC_PROVIDER).inject).toEqual([APP_CONFIG, CLOCK]);
    for (const port of [RTC_ROOMS, RTC_TOKENS, RTC_PARTICIPANTS, RTC_OBSERVER]) {
      expect(declared(port).useExisting).toBe(RTC_PROVIDER);
    }
  });

  it('hands the use cases the deployment’s cap, reserve and room prefix — `live-` when none — and the pinned join lifetime', () => {
    const settingsOf = declared(LIVE_SETTINGS).useFactory as (config: AppConfig) => LiveSettings;
    expect(declared(LIVE_SETTINGS).inject).toEqual([APP_CONFIG]);
    expect(settingsOf(loadConfig({}))).toEqual({
      roomNamePrefix: 'live-',
      participantCap: 300,
      moderatorReserve: 10,
      joinTokenTtlSeconds: JOIN_TOKEN_TTL_SECONDS,
    });
    expect(
      settingsOf(
        loadConfig({
          LIVE_ROOM_NAME_PREFIX: 'live-staging-',
          LIVE_MAX_PARTICIPANTS_PER_SESSION: '1000',
          LIVE_MODERATOR_RESERVE: '0',
        }),
      ),
    ).toEqual({
      roomNamePrefix: 'live-staging-',
      participantCap: 1000,
      moderatorReserve: 0,
      joinTokenTtlSeconds: 120,
    });
  });
});

/**
 * Which media provider a deployment gets (P6 audit, D19): fail closed. Real
 * media is bound only when asked for by name, the fake only for the
 * development secret, and anything else — every production boot today —
 * binds a provider that refuses every call, so Start answers 503 with nothing
 * stored and real credentials are never reached by accident.
 */
describe('the media provider Live binds', () => {
  let warned: jest.SpyInstance;
  let logged: jest.SpyInstance;

  beforeEach(() => {
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** The one line the binding logs: which provider, and the room prefix. */
  const bindingLine = (): unknown[][] => [
    ...(warned.mock.calls as unknown[][]),
    ...(logged.mock.calls as unknown[][]),
  ];

  it('binds the fake for the development secret, and says so with the room prefix', () => {
    expect(boot({})).toBeInstanceOf(FakeRtcProvider);
    expect(bindingLine()).toEqual([
      [
        { provider: 'fake', roomNamePrefix: 'live-' },
        'media provider: fake (development secret) — no live media will flow',
      ],
    ]);

    warned.mockClear();
    expect(boot({ LIVE_ROOM_NAME_PREFIX: 'live-dev-' })).toBeInstanceOf(FakeRtcProvider);
    expect(warned.mock.calls[0]?.[0]).toEqual({ provider: 'fake', roomNamePrefix: 'live-dev-' });
  });

  it('binds the LiveKit adapter on explicit opt-in, naming the host and the prefix — never the key or secret', () => {
    expect(boot(REAL_MEDIA)).toBeInstanceOf(LiveKitRtcProvider);
    expect(boot({ ...PRODUCTION, ...REAL_MEDIA })).toBeInstanceOf(LiveKitRtcProvider);
    expect(bindingLine()).toEqual([
      [
        { provider: 'livekit', host: 'media.school.example', roomNamePrefix: 'live-school-a-' },
        'media provider: LiveKit',
      ],
      [
        { provider: 'livekit', host: 'media.school.example', roomNamePrefix: 'live-school-a-' },
        'media provider: LiveKit',
      ],
    ]);
    expect(JSON.stringify(bindingLine())).not.toContain(REAL_MEDIA.LIVEKIT_API_SECRET);
    expect(JSON.stringify(bindingLine())).not.toContain(REAL_MEDIA.LIVEKIT_API_KEY);
  });

  it.each<[string, Record<string, string>]>([
    [
      'real credentials without the opt-in',
      { LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6', LIVEKIT_API_SECRET: 's'.repeat(40) },
    ],
    ['a production configuration', PRODUCTION],
    [
      'a production configuration with its own room prefix but no opt-in',
      { ...PRODUCTION, LIVE_ROOM_NAME_PREFIX: 'live-school-a-' },
    ],
    ['any secret but the development one', { LIVEKIT_API_SECRET: 'not-the-development-secret' }],
  ])('binds the disabled provider for %s, and says so', (_case, env) => {
    const provider = boot(env);
    expect(provider).toBeInstanceOf(DisabledRtcProvider);
    expect(bindingLine()).toEqual([
      [
        { provider: 'disabled', roomNamePrefix: env.LIVE_ROOM_NAME_PREFIX ?? 'live-' },
        'media provider: disabled — real media is not enabled (LIVE_MEDIA_PROVIDER), so no live session can start',
      ],
    ]);
  });

  it('refuses the start’s room and every token as an outage, once disabled', async () => {
    const provider = boot(PRODUCTION);
    await expect(
      provider.ensureRoom({
        roomName: 'live-00000000-0000-4000-8000-000000000001',
        maxParticipants: 310,
        emptyTimeoutSeconds: 1200,
        departureTimeoutSeconds: 1200,
      }),
    ).rejects.toBeInstanceOf(RtcUnavailableError);
    await expect(
      provider.issueAccessToken({
        roomName: 'live-00000000-0000-4000-8000-000000000001',
        identity: 'student-1',
        displayName: '',
        capabilities: capabilitiesFor({
          moderator: false,
          publishesByRight: false,
          speakerGrant: false,
          presenter: false,
        }),
        ttlSeconds: JOIN_TOKEN_TTL_SECONDS,
      }),
    ).rejects.toBeInstanceOf(RtcUnavailableError);
  });

  it.each<[string, Record<string, string>, RegExp]>([
    [
      'real media without this deployment’s room prefix',
      { ...REAL_MEDIA, LIVE_ROOM_NAME_PREFIX: '' },
      /LIVE_ROOM_NAME_PREFIX is required when LIVE_MEDIA_PROVIDER=livekit/,
    ],
    [
      'real media under a malformed room prefix',
      { ...REAL_MEDIA, LIVE_ROOM_NAME_PREFIX: 'live school/' },
      /LIVE_ROOM_NAME_PREFIX must be 1 to 48 characters/,
    ],
    [
      'real media with the placeholder API key',
      { ...REAL_MEDIA, LIVEKIT_API_KEY: 'devkey' },
      /LIVEKIT_API_KEY must not be a placeholder when LIVE_MEDIA_PROVIDER=livekit/,
    ],
    [
      'real media with no API key at all',
      { ...REAL_MEDIA, LIVEKIT_API_KEY: '' },
      /LIVEKIT_API_KEY must not be a placeholder when LIVE_MEDIA_PROVIDER=livekit/,
    ],
    [
      'real media with a secret under 32 bytes',
      { ...REAL_MEDIA, LIVEKIT_API_SECRET: 's'.repeat(31) },
      /LIVEKIT_API_SECRET must be at least 32 bytes when LIVE_MEDIA_PROVIDER=livekit/,
    ],
    [
      'real media with the development secret',
      { ...REAL_MEDIA, LIVEKIT_API_SECRET: 'development-only-secret' },
      /LIVEKIT_API_SECRET must not be a placeholder when LIVE_MEDIA_PROVIDER=livekit/,
    ],
    [
      'real media in production with a placeholder secret',
      { ...PRODUCTION, ...REAL_MEDIA, LIVEKIT_API_SECRET: 'change-me' },
      /LIVEKIT_API_SECRET still holds a placeholder value/,
    ],
    [
      'a media provider other than exactly "livekit"',
      { ...REAL_MEDIA, LIVE_MEDIA_PROVIDER: 'LiveKit' },
      /LIVE_MEDIA_PROVIDER must be "livekit" or unset/,
    ],
  ])('refuses to boot %s — and binds nothing', (_case, env, problem) => {
    expect(() => boot(env)).toThrow(ConfigurationError);
    expect(() => boot(env)).toThrow(problem);
    expect(bindingLine()).toEqual([]);
  });
});
