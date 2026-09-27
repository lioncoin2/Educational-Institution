import { ConfigurationError, loadConfig } from './app-config';

const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app@db/institution',
  REDIS_URL: 'redis://cache:6379',
  JWT_SECRET: 'a'.repeat(48),
  LIVEKIT_URL: 'wss://rtc.example.org',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: 'a-real-livekit-secret',
  STORAGE_SIGNING_SECRET: 'b'.repeat(48),
};

describe('loadConfig', () => {
  it('accepts a complete production configuration', () => {
    const config = loadConfig(PRODUCTION);
    expect(config.auth.accessTtlSeconds).toBe(900);
    expect(config.auth.refreshSessionTtlSeconds).toBe(30 * 24 * 60 * 60);
    expect(config.http.trustProxy).toBe(false);
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
  /** What real media needs besides the opt-in: its own room names, a real key, a strong secret. */
  const REAL_MEDIA = {
    LIVE_MEDIA_PROVIDER: 'livekit',
    LIVE_ROOM_NAME_PREFIX: 'live-prod-',
    LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6',
    LIVEKIT_API_SECRET: 's'.repeat(32),
  };

  it('seats 300 listeners plus a reserve of 10, with no prefix and real media off, unless told otherwise', () => {
    expect(loadConfig({}).live).toEqual({
      maxParticipantsPerSession: 300,
      moderatorReserve: 10,
      roomNamePrefix: null,
      mediaProvider: null,
    });
    expect(
      loadConfig({
        LIVE_MAX_PARTICIPANTS_PER_SESSION: '1000',
        LIVE_MODERATOR_RESERVE: '0',
        LIVE_ROOM_NAME_PREFIX: 'live-staging.eu_1-',
      }).live,
    ).toEqual({
      maxParticipantsPerSession: 1000,
      moderatorReserve: 0,
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

  it.each(['LiveKit', 'fake', 'none', 'disabled', ' livekit'])(
    'refuses LIVE_MEDIA_PROVIDER=%j: real media is enabled by exactly "livekit", or not at all',
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

  it('refuses the development defaults outright once real media is enabled', () => {
    expect(() => loadConfig({ LIVE_MEDIA_PROVIDER: 'livekit' })).toThrow(
      new RegExp(
        [
          'LIVE_ROOM_NAME_PREFIX is required',
          'LIVEKIT_API_KEY must not be a placeholder',
          'LIVEKIT_API_SECRET must not be a placeholder',
          'LIVEKIT_API_SECRET must be at least 32 bytes',
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
      roomNamePrefix: null,
      mediaProvider: null,
    });
    expect(loadConfig({ ...PRODUCTION, LIVEKIT_API_KEY: 'devkey' }).livekit.apiKey).toBe('devkey');
  });
});
