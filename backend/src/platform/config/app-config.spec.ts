import { ConfigurationError, loadConfig } from './app-config';

const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app@db/institution',
  REDIS_URL: 'redis://cache:6379',
  JWT_SECRET: 'a'.repeat(48),
  LIVEKIT_URL: 'wss://rtc.example.org',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: 'a-real-livekit-secret',
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

  it('runs locally with no configuration at all, and says no database is configured', () => {
    const config = loadConfig({});
    expect(config.database.configured).toBe(false);
  });
});
