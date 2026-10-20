import {
  ConfigurationError,
  DEFAULT_LIVE_JOIN_TOKEN_TTL_SECONDS,
  MAX_LIVE_JOIN_TOKEN_TTL_SECONDS,
  loadConfig,
} from './app-config';
import { PINNED_LIVEKIT_SERVER_VERSION } from './livekit-config';

const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app@db/institution',
  REDIS_URL: 'redis://cache:6379',
  JWT_SECRET: 'a'.repeat(48),
  LIVEKIT_URL: 'wss://rtc.example.org',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: 'a-real-livekit-secret',
  STORAGE_SIGNING_SECRET: 'b'.repeat(48),
  TRUST_PROXY: 'false',
};

describe('loadConfig', () => {
  it('accepts a complete production configuration', () => {
    const config = loadConfig(PRODUCTION);
    expect(config.auth.accessTtlSeconds).toBe(900);
    expect(config.auth.refreshSessionTtlSeconds).toBe(30 * 24 * 60 * 60);
    expect(config.http.trustProxy).toBe(false);
  });

  it('defaults the institution timezone to null when unset', () => {
    expect(loadConfig({}).institution).toEqual({ timezone: null });
  });

  it('accepts a valid IANA institution timezone', () => {
    expect(loadConfig({ INSTITUTION_TIMEZONE: 'Asia/Riyadh' }).institution.timezone).toBe(
      'Asia/Riyadh',
    );
  });

  it('rejects a fixed-offset or unknown institution timezone', () => {
    expect(() => loadConfig({ INSTITUTION_TIMEZONE: '+03:00' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ INSTITUTION_TIMEZONE: 'Not/AZone' })).toThrow(ConfigurationError);
  });

  // HS256 is only as strong as its key (RFC 7518 §3.2: at least 256 bits).
  it('refuses a JWT secret shorter than 32 bytes in production', () => {
    expect(() =>
      loadConfig({ ...PRODUCTION, JWT_SECRET: 'too-short-but-not-a-placeholder' }),
    ).toThrow(/JWT_SECRET must be at least 32 bytes/);
  });

  it.each(['development-only-secret', 'change-me', 'secret'])(
    'refuses the placeholder %j in production',
    (placeholder) => {
      expect(() => loadConfig({ ...PRODUCTION, JWT_SECRET: placeholder })).toThrow(
        ConfigurationError,
      );
    },
  );

  it('requires its own storage signing secret in production', () => {
    const { STORAGE_SIGNING_SECRET: _omitted, ...withoutStorageSecret } = PRODUCTION;
    expect(() => loadConfig(withoutStorageSecret)).toThrow(/STORAGE_SIGNING_SECRET is required/);
    expect(() =>
      loadConfig({ ...PRODUCTION, STORAGE_SIGNING_SECRET: 'short-storage-key' }),
    ).toThrow(/STORAGE_SIGNING_SECRET must be at least 32 bytes/);
    expect(() => loadConfig({ ...PRODUCTION, STORAGE_SIGNING_SECRET: 'change-me' })).toThrow(
      /STORAGE_SIGNING_SECRET still holds a placeholder/,
    );
  });

  // One leaked key must not forge both sessions and file links.
  it('refuses a storage signing secret equal to the JWT secret', () => {
    expect(() =>
      loadConfig({ ...PRODUCTION, STORAGE_SIGNING_SECRET: PRODUCTION.JWT_SECRET }),
    ).toThrow(/STORAGE_SIGNING_SECRET must differ from JWT_SECRET/);
  });

  it('refuses a session shorter than its access token', () => {
    expect(() =>
      loadConfig({ ...PRODUCTION, JWT_ACCESS_TTL: '900', REFRESH_SESSION_TTL_SECONDS: '600' }),
    ).toThrow(/REFRESH_SESSION_TTL_SECONDS/);
  });

  it('does not trust a proxy unless told to', () => {
    expect(loadConfig({}).http.trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '1' }).http.trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: 'true' }).http.trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'false' }).http.trustProxy).toBe(false);
  });

  // A mistyped value used to read as `false`: every client one address behind
  // the proxy, and every per-IP rate limit one limit shared by everybody.
  it.each(['yes', '1abc', '-1', '1.5', 'TRUE', '100'])(
    'refuses the proxy setting %j rather than guessing',
    (value) => {
      expect(() => loadConfig({ TRUST_PROXY: value })).toThrow(
        /TRUST_PROXY must be true, false or a number of hops/,
      );
    },
  );

  it('requires a deployed environment to name its proxy setting, `false` included', () => {
    const { TRUST_PROXY: _omitted, ...withoutProxy } = PRODUCTION;
    expect(() => loadConfig(withoutProxy)).toThrow(/TRUST_PROXY is required in production/);
    expect(() => loadConfig({ ...withoutProxy, NODE_ENV: 'staging' })).toThrow(
      /TRUST_PROXY is required in staging/,
    );
    expect(loadConfig(PRODUCTION).http.trustProxy).toBe(false);
  });

  it('allows no browser origin unless one is listed, and never a wildcard', () => {
    expect(loadConfig({}).http.corsOrigins).toEqual([]);
    expect(
      loadConfig({ CORS_ORIGINS: 'https://app.example.org, http://localhost:8080' }).http
        .corsOrigins,
    ).toEqual(['https://app.example.org', 'http://localhost:8080']);
    for (const bad of ['*', 'https://app.example.org/path', 'app.example.org', 'ftp://x.org']) {
      expect(() => loadConfig({ CORS_ORIGINS: bad })).toThrow(/CORS_ORIGINS entry/);
    }
  });

  it('serves community-chat posts up to 250 members unless told otherwise, and never a negative bound', () => {
    expect(loadConfig({}).messaging.communityChatMaxServedMembers).toBe(250);
    expect(
      loadConfig({ MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS: '1000' }).messaging
        .communityChatMaxServedMembers,
    ).toBe(1000);
    expect(() => loadConfig({ MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS: '-1' })).toThrow(
      /MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS/,
    );
  });

  it('runs locally with no configuration at all, and says no database is configured', () => {
    const config = loadConfig({});
    expect(config.database.configured).toBe(false);
  });
});

describe('loadConfig — live sessions', () => {
  /**
   * What real media needs besides the opt-in: its own room names, the server's
   * URL and pinned version, a real key, a strong secret.
   */
  const REAL_MEDIA = {
    LIVE_MEDIA_PROVIDER: 'livekit',
    LIVE_ROOM_NAME_PREFIX: 'live-prod-',
    LIVEKIT_URL: 'wss://rtc.example.org',
    LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
    LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6',
    LIVEKIT_API_SECRET: 's'.repeat(32),
  };

  it('seats 300 listeners plus a reserve of 10, with 120-second join tickets, no prefix and real media off, unless told otherwise', () => {
    expect(loadConfig({}).live).toEqual({
      maxParticipantsPerSession: 300,
      moderatorReserve: 10,
      joinTokenTtlSeconds: 120,
      roomNamePrefix: null,
      mediaProvider: null,
    });
    expect(
      loadConfig({
        LIVE_MAX_PARTICIPANTS_PER_SESSION: '1000',
        LIVE_MODERATOR_RESERVE: '0',
        LIVE_JOIN_TOKEN_TTL_SECONDS: '45',
        LIVE_ROOM_NAME_PREFIX: 'live-staging.eu_1-',
      }).live,
    ).toEqual({
      maxParticipantsPerSession: 1000,
      moderatorReserve: 0,
      joinTokenTtlSeconds: 45,
      roomNamePrefix: 'live-staging.eu_1-',
      mediaProvider: null,
    });
    // Blank means unset.
    expect(loadConfig({ LIVE_ROOM_NAME_PREFIX: ' ', LIVE_MEDIA_PROVIDER: '' }).live).toMatchObject({
      roomNamePrefix: null,
      mediaProvider: null,
    });
  });

  it.each(['0', '-5', '1.5', '12abc', 'many', '99999999999999999999'])(
    'refuses %j participants per session: a whole number of at least 1',
    (value) => {
      expect(() => loadConfig({ LIVE_MAX_PARTICIPANTS_PER_SESSION: value })).toThrow(
        /LIVE_MAX_PARTICIPANTS_PER_SESSION must be a whole number of at least 1/,
      );
    },
  );

  it.each(['-1', '2.5', 'ten'])(
    'refuses a moderator reserve of %j: a whole number, 0 or more',
    (value) => {
      expect(() => loadConfig({ LIVE_MODERATOR_RESERVE: value })).toThrow(/LIVE_MODERATOR_RESERVE/);
    },
  );

  // P7.2 decision Q-C: from configuration, never a constant in the use case —
  // and checked at boot, so a deployment never runs with a lifetime the mint
  // would refuse on every join.
  it.each(['1', '120', '600', ' 300 '])('takes a join ticket lifetime of %j seconds', (value) => {
    expect(loadConfig({ LIVE_JOIN_TOKEN_TTL_SECONDS: value }).live.joinTokenTtlSeconds).toBe(
      Number(value),
    );
  });

  it.each(['0', '-1', '601', '21600', '1.5', '2m', 'NaN', '99999999999999999999'])(
    'refuses a join ticket lifetime of %j: whole seconds from 1 to 600',
    (value) => {
      expect(() => loadConfig({ LIVE_JOIN_TOKEN_TTL_SECONDS: value })).toThrow(
        'LIVE_JOIN_TOKEN_TTL_SECONDS must be a whole number of seconds from 1 to 600',
      );
    },
  );

  it('bounds a join ticket at ten minutes — a token the media server refreshes lives that long', () => {
    expect(DEFAULT_LIVE_JOIN_TOKEN_TTL_SECONDS).toBe(120);
    expect(MAX_LIVE_JOIN_TOKEN_TTL_SECONDS).toBe(600);
    // Blank means unset.
    expect(loadConfig({ LIVE_JOIN_TOKEN_TTL_SECONDS: ' ' }).live.joinTokenTtlSeconds).toBe(120);
  });

  it.each(['live prod', 'live/', 'live*', 'ライブ-', 'x'.repeat(49)])(
    'refuses the room name prefix %j: 1 to 48 letters, digits, ".", "_" or "-"',
    (prefix) => {
      expect(() => loadConfig({ LIVE_ROOM_NAME_PREFIX: prefix })).toThrow(/LIVE_ROOM_NAME_PREFIX/);
    },
  );

  it('accepts a 48-character prefix', () => {
    expect(loadConfig({ LIVE_ROOM_NAME_PREFIX: 'p'.repeat(48) }).live.roomNamePrefix).toBe(
      'p'.repeat(48),
    );
  });

  it.each(['LiveKit', 'Fake', 'none', 'disabled', ' livekit', ' fake'])(
    'refuses LIVE_MEDIA_PROVIDER=%j: a provider is chosen by exactly "livekit" or "fake", or not at all',
    (value) => {
      expect(() => loadConfig({ LIVE_MEDIA_PROVIDER: value })).toThrow(/LIVE_MEDIA_PROVIDER/);
    },
  );

  it('enables real media only on explicit opt-in, with a prefix, a real key and a 32-byte secret', () => {
    expect(loadConfig(REAL_MEDIA).live).toMatchObject({
      mediaProvider: 'livekit',
      roomNamePrefix: 'live-prod-',
    });
    expect(loadConfig({ ...PRODUCTION, ...REAL_MEDIA }).live.mediaProvider).toBe('livekit');
  });

  it('refuses to boot real media without this deployment’s own room prefix', () => {
    const { LIVE_ROOM_NAME_PREFIX: _omitted, ...withoutPrefix } = REAL_MEDIA;
    expect(() => loadConfig(withoutPrefix)).toThrow(
      /LIVE_ROOM_NAME_PREFIX is required when LIVE_MEDIA_PROVIDER=livekit/,
    );
  });

  it.each(['devkey', 'change-me', 'secret', ''])(
    'refuses to boot real media with the placeholder API key %j',
    (key) => {
      expect(() => loadConfig({ ...REAL_MEDIA, LIVEKIT_API_KEY: key })).toThrow(
        /LIVEKIT_API_KEY must not be a placeholder/,
      );
    },
  );

  it('refuses to boot real media with a secret under 32 bytes, or a placeholder one', () => {
    expect(() => loadConfig({ ...REAL_MEDIA, LIVEKIT_API_SECRET: 's'.repeat(31) })).toThrow(
      /LIVEKIT_API_SECRET must be at least 32 bytes when LIVE_MEDIA_PROVIDER=livekit/,
    );
    expect(() =>
      loadConfig({ ...REAL_MEDIA, LIVEKIT_API_SECRET: 'development-only-secret' }),
    ).toThrow(/LIVEKIT_API_SECRET must not be a placeholder/);
    expect(() =>
      loadConfig({ ...PRODUCTION, ...REAL_MEDIA, LIVEKIT_API_SECRET: 'change-me' }),
    ).toThrow(/LIVEKIT_API_SECRET still holds a placeholder value/);
    // Bytes, not characters: 16 two-byte characters are 32 bytes.
    expect(
      loadConfig({ ...REAL_MEDIA, LIVEKIT_API_SECRET: 'ش'.repeat(16) }).live.mediaProvider,
    ).toBe('livekit');
  });

  // P7.1: real media has no development defaults at all — each is set on purpose.
  it('refuses the development defaults outright once real media is enabled', () => {
    expect(() => loadConfig({ LIVE_MEDIA_PROVIDER: 'livekit' })).toThrow(
      new RegExp(
        [
          'LIVEKIT_URL is required when LIVE_MEDIA_PROVIDER=livekit',
          'LIVEKIT_VERSION must be 1\\.13\\.7',
          'LIVE_ROOM_NAME_PREFIX is required',
          'LIVEKIT_API_KEY is required when LIVE_MEDIA_PROVIDER=livekit',
          'LIVEKIT_API_SECRET is required when LIVE_MEDIA_PROVIDER=livekit',
        ].join('[\\s\\S]*'),
      ),
    );
  });

  // The binding of audit D19 is the module's; configuration only says whether
  // real media was asked for. Without the opt-in nothing new is required.
  it('changes nothing for a configuration without LIVE_MEDIA_PROVIDER', () => {
    expect(PRODUCTION.LIVEKIT_API_SECRET.length).toBeLessThan(32);
    expect(loadConfig(PRODUCTION).live).toEqual({
      maxParticipantsPerSession: 300,
      moderatorReserve: 10,
      joinTokenTtlSeconds: 120,
      roomNamePrefix: null,
      mediaProvider: null,
    });
    expect(loadConfig({ ...PRODUCTION, LIVEKIT_API_KEY: 'devkey' }).livekit.apiKey).toBe('devkey');
  });
});

/**
 * The Trial (ADR 0037): reachable from the internet, so it carries the full
 * deployed baseline — but it runs no media server, which it says by declaring
 * the fake rather than by pretending to be development.
 */
describe('loadConfig — the trial environment', () => {
  const TRIAL = {
    NODE_ENV: 'trial',
    DATABASE_URL: 'postgresql://trial@trial-db/trial',
    REDIS_URL: 'redis://trial-redis:6379',
    JWT_SECRET: 'j'.repeat(54),
    STORAGE_SIGNING_SECRET: 's'.repeat(54),
    TRUST_PROXY: '1',
    CORS_ORIGINS: 'https://trial.example.org',
    LIVE_MEDIA_PROVIDER: 'fake',
  };
  const without = (key: keyof typeof TRIAL): Record<string, string> => {
    const { [key]: _omitted, ...rest } = TRIAL;
    return rest;
  };

  it('boots with its own secrets, database, Redis and proxy, and the fake declared — no LiveKit setting needed', () => {
    const config = loadConfig(TRIAL);
    expect(config.nodeEnv).toBe('trial');
    expect(config.live.mediaProvider).toBe('fake');
    expect(config.http.trustProxy).toBe(1);
    expect(config.database).toEqual({ url: TRIAL.DATABASE_URL, configured: true });
    expect(config.logLevel).toBe('info');
  });

  it.each([
    'JWT_SECRET',
    'STORAGE_SIGNING_SECRET',
    'DATABASE_URL',
    'REDIS_URL',
    'TRUST_PROXY',
  ] as const)('refuses to boot without %s — never a local default', (key) => {
    expect(() => loadConfig(without(key))).toThrow(new RegExp(`${key} is required in trial`));
    expect(() => loadConfig({ ...TRIAL, [key]: '   ' })).toThrow(
      new RegExp(`${key} is required in trial`),
    );
  });

  it.each([
    'development-only-secret',
    'development-only-storage-secret',
    'change-me',
    'change-me-in-every-environment',
    'devkey',
    'secret',
  ])('refuses the placeholder %j for either secret', (placeholder) => {
    expect(() => loadConfig({ ...TRIAL, JWT_SECRET: placeholder })).toThrow(
      /JWT_SECRET still holds a placeholder value/,
    );
    expect(() => loadConfig({ ...TRIAL, STORAGE_SIGNING_SECRET: placeholder })).toThrow(
      /STORAGE_SIGNING_SECRET still holds a placeholder value/,
    );
  });

  it('refuses a secret under 32 bytes, and one key for two jobs — naming the setting, never its value', () => {
    const weak = 'a-real-but-short-value';
    let refusal = '';
    try {
      loadConfig({ ...TRIAL, JWT_SECRET: weak });
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toMatch(/JWT_SECRET must be at least 32 bytes in trial/);
    expect(refusal).not.toContain(weak);

    expect(() => loadConfig({ ...TRIAL, STORAGE_SIGNING_SECRET: 'x'.repeat(31) })).toThrow(
      /STORAGE_SIGNING_SECRET must be at least 32 bytes in trial/,
    );
    expect(() => loadConfig({ ...TRIAL, STORAGE_SIGNING_SECRET: TRIAL.JWT_SECRET })).toThrow(
      /STORAGE_SIGNING_SECRET must differ from JWT_SECRET/,
    );
  });

  it('counts bytes, not characters: 16 two-byte characters are a 32-byte secret', () => {
    expect(loadConfig({ ...TRIAL, JWT_SECRET: 'é'.repeat(16) }).auth.jwtSecret).toHaveLength(16);
    expect(() => loadConfig({ ...TRIAL, JWT_SECRET: 'é'.repeat(15) })).toThrow(
      /JWT_SECRET must be at least 32 bytes/,
    );
  });

  it('without the fake declared, demands a media server like any deployed environment', () => {
    const { LIVE_MEDIA_PROVIDER: _omitted, ...noMedia } = TRIAL;
    expect(() => loadConfig(noMedia)).toThrow(
      new RegExp(
        [
          'LIVEKIT_API_KEY is required in trial',
          'LIVEKIT_API_SECRET is required in trial',
          'LIVEKIT_URL is required in trial',
        ].join('[\\s\\S]*'),
      ),
    );
  });

  it('still keeps a LiveKit secret, when one is given, apart from the other keys', () => {
    expect(() => loadConfig({ ...TRIAL, LIVEKIT_API_SECRET: TRIAL.JWT_SECRET })).toThrow(
      /LIVEKIT_API_SECRET must differ from JWT_SECRET/,
    );
  });

  it('is refused the fake in production, and any provider it does not know', () => {
    expect(() => loadConfig({ ...PRODUCTION, LIVE_MEDIA_PROVIDER: 'fake' })).toThrow(
      /LIVE_MEDIA_PROVIDER=fake is refused in production/,
    );
    expect(
      loadConfig({ ...PRODUCTION, NODE_ENV: 'staging', LIVE_MEDIA_PROVIDER: 'fake' }).live
        .mediaProvider,
    ).toBe('fake');
    expect(() => loadConfig({ ...TRIAL, LIVE_MEDIA_PROVIDER: 'Fake' })).toThrow(
      /LIVE_MEDIA_PROVIDER must be "livekit", "fake" or unset/,
    );
  });

  it('refuses an environment it does not know, checking it as production meanwhile', () => {
    expect(() => loadConfig({ ...TRIAL, NODE_ENV: 'trail' })).toThrow(
      /NODE_ENV must be development, test, trial, staging or production/,
    );
  });
});
