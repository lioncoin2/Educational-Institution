import { ConfigurationError, isDeployed, loadConfig } from './app-config';
import {
  PINNED_LIVEKIT_SERVER_VERSION,
  apiUrlFault,
  apiUrlFor,
  clientUrlFault,
  isInternalHost,
} from './livekit-config';

/** A deployed environment's settings, every secret real, strong and its own; no real media. */
const DEPLOYED = {
  DATABASE_URL: 'postgresql://app@db/institution',
  REDIS_URL: 'redis://cache:6379',
  JWT_SECRET: 'j'.repeat(48),
  STORAGE_SIGNING_SECRET: 'k'.repeat(48),
  LIVEKIT_URL: 'wss://media.school.example',
  LIVEKIT_API_KEY: 'APIa1b2c3d4e5f6',
  LIVEKIT_API_SECRET: 's'.repeat(40),
};

/** What real media takes on top: the opt-in, the room prefix and the pinned server. */
const REAL_MEDIA = {
  LIVE_MEDIA_PROVIDER: 'livekit',
  LIVE_ROOM_NAME_PREFIX: 'live-school-a-',
  LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
};

const DEPLOYED_ENVIRONMENTS = ['staging', 'production'] as const;

/** The problems a configuration is refused with — none when it loads. */
function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return error.message.split('\n  - ').slice(1);
  }
}

describe('loadConfig — environments (P7.1, decision 2)', () => {
  it('knows exactly four environments, and runs as development when none is named', () => {
    expect(loadConfig({}).nodeEnv).toBe('development');
    expect(loadConfig({ NODE_ENV: '' }).nodeEnv).toBe('development');
    expect(loadConfig({ NODE_ENV: 'test' }).nodeEnv).toBe('test');
    for (const environment of DEPLOYED_ENVIRONMENTS) {
      expect(loadConfig({ ...DEPLOYED, NODE_ENV: environment }).nodeEnv).toBe(environment);
    }
  });

  it.each(['qa', 'prod', 'Production', 'STAGING', ' production', 'dev'])(
    'refuses to boot under NODE_ENV=%j',
    (value) => {
      expect(problemsOf({ ...DEPLOYED, NODE_ENV: value })).toEqual([
        `NODE_ENV must be development, test, staging or production, not ${JSON.stringify(value)}`,
      ]);
    },
  );

  it('treats staging and production as deployed, development and test as local', () => {
    expect(isDeployed('staging')).toBe(true);
    expect(isDeployed('production')).toBe(true);
    expect(isDeployed('development')).toBe(false);
    expect(isDeployed('test')).toBe(false);
  });

  it.each(DEPLOYED_ENVIRONMENTS)(
    'gives %s the production-grade checks: every setting, no placeholder, strong secrets kept apart',
    (environment) => {
      expect(problemsOf({ NODE_ENV: environment })).toEqual([
        `JWT_SECRET is required in ${environment}`,
        'JWT_SECRET still holds a placeholder value',
        `JWT_SECRET must be at least 32 bytes in ${environment}`,
        `STORAGE_SIGNING_SECRET is required in ${environment}`,
        'STORAGE_SIGNING_SECRET still holds a placeholder value',
        `STORAGE_SIGNING_SECRET must be at least 32 bytes in ${environment}`,
        `LIVEKIT_API_KEY is required in ${environment}`,
        `LIVEKIT_API_SECRET is required in ${environment}`,
        'LIVEKIT_API_SECRET still holds a placeholder value',
        `LIVEKIT_URL is required in ${environment}`,
        `DATABASE_URL is required in ${environment}`,
        `REDIS_URL is required in ${environment}`,
      ]);
      expect(
        problemsOf({
          ...DEPLOYED,
          NODE_ENV: environment,
          JWT_SECRET: 'change-me',
          STORAGE_SIGNING_SECRET: 'short-but-real',
        }),
      ).toEqual([
        'JWT_SECRET still holds a placeholder value',
        `JWT_SECRET must be at least 32 bytes in ${environment}`,
        `STORAGE_SIGNING_SECRET must be at least 32 bytes in ${environment}`,
      ]);
      expect(loadConfig({ ...DEPLOYED, NODE_ENV: environment }).logLevel).toBe('info');
    },
  );

  it('keeps local defaults for development and test', () => {
    for (const environment of ['development', 'test']) {
      const config = loadConfig({ NODE_ENV: environment });
      expect(config.auth.jwtSecret).toBe('development-only-secret');
      expect(config.livekit.apiSecret).toBe('development-only-secret');
      expect(config.logLevel).toBe('debug');
    }
  });
});

describe('loadConfig — the LiveKit server’s URLs (decision 3)', () => {
  it('takes the client URL as given and derives the API URL from it: ws→http, wss→https', () => {
    expect(loadConfig({}).livekit).toMatchObject({
      url: 'ws://localhost:7880',
      apiUrl: 'http://localhost:7880',
    });
    expect(loadConfig({ LIVEKIT_URL: 'wss://media.school.example' }).livekit).toMatchObject({
      url: 'wss://media.school.example',
      apiUrl: 'https://media.school.example',
    });
    expect(apiUrlFor('WSS://Media.School.Example:7443')).toBe('https://Media.School.Example:7443');
    expect(apiUrlFor('ws://127.0.0.1:7880')).toBe('http://127.0.0.1:7880');
  });

  it('takes a server-side API URL of its own — the private path to LiveKit', () => {
    expect(
      loadConfig({
        ...DEPLOYED,
        ...REAL_MEDIA,
        NODE_ENV: 'production',
        LIVEKIT_API_URL: 'http://livekit:7880',
      }).livekit,
    ).toMatchObject({ url: 'wss://media.school.example', apiUrl: 'http://livekit:7880' });
  });

  it('requires the client URL once real media is enabled — no default', () => {
    const { LIVEKIT_URL: _omitted, ...withoutUrl } = DEPLOYED;
    expect(problemsOf({ ...withoutUrl, ...REAL_MEDIA })).toEqual([
      'LIVEKIT_URL is required when LIVE_MEDIA_PROVIDER=livekit',
    ]);
    expect(problemsOf({ ...withoutUrl, ...REAL_MEDIA, LIVEKIT_URL: '  ' })).toEqual([
      'LIVEKIT_URL is required when LIVE_MEDIA_PROVIDER=livekit',
    ]);
    expect(problemsOf({ ...withoutUrl, ...REAL_MEDIA, NODE_ENV: 'staging' })).toEqual([
      'LIVEKIT_URL is required in staging',
    ]);
  });

  it.each(['not a url', 'livekit.example.org', 'https://media.school.example', 'http://x:7880'])(
    'refuses the client URL %j — a ws:// or wss:// URL, with real media or without',
    (url) => {
      const problem = 'LIVEKIT_URL must be a ws:// or wss:// URL';
      expect(problemsOf({ ...DEPLOYED, ...REAL_MEDIA, LIVEKIT_URL: url })).toEqual([problem]);
      expect(problemsOf({ LIVEKIT_URL: url })).toEqual([problem]);
      expect(problemsOf({ ...DEPLOYED, NODE_ENV: 'production', LIVEKIT_URL: url })).toEqual([
        problem,
      ]);
    },
  );

  it.each(DEPLOYED_ENVIRONMENTS)(
    'refuses a ws:// client URL for real media in %s — clients never connect in clear there',
    (environment) => {
      expect(
        problemsOf({
          ...DEPLOYED,
          ...REAL_MEDIA,
          NODE_ENV: environment,
          LIVEKIT_URL: 'ws://media.school.example',
        }),
      ).toEqual([`LIVEKIT_URL must use wss:// in ${environment}: clients never connect in clear`]);
    },
  );

  // P7.2 (audit §4.7): the URL every ticket hands to clients.
  it.each([
    'wss://localhost:7880',
    'wss://127.0.0.1',
    'wss://[::1]:7880',
    'wss://livekit:7880',
    'wss://10.0.0.7',
    'wss://172.16.4.2:443',
    'wss://192.168.1.10',
  ])('refuses the internal client URL %s in a deployed environment, real media or not', (url) => {
    for (const environment of DEPLOYED_ENVIRONMENTS) {
      const problem =
        `LIVEKIT_URL must name a public host in ${environment}, not an internal one ` +
        '(loopback, a single-label service name or a private IPv4 address): every join ' +
        'ticket hands it to clients';
      expect(
        problemsOf({ ...DEPLOYED, ...REAL_MEDIA, NODE_ENV: environment, LIVEKIT_URL: url }),
      ).toEqual([problem]);
      expect(problemsOf({ ...DEPLOYED, NODE_ENV: environment, LIVEKIT_URL: url })).toEqual([
        problem,
      ]);
    }
    // Development and test run on this machine: an internal host is what they use.
    expect(
      loadConfig({ ...DEPLOYED, ...REAL_MEDIA, NODE_ENV: 'test', LIVEKIT_URL: url }).livekit.url,
    ).toBe(url);
  });

  it('reports an internal host beside an insecure scheme — both are to fix', () => {
    expect(
      problemsOf({
        ...DEPLOYED,
        ...REAL_MEDIA,
        NODE_ENV: 'production',
        LIVEKIT_URL: 'ws://livekit:7880',
      }),
    ).toEqual([
      'LIVEKIT_URL must use wss:// in production: clients never connect in clear',
      'LIVEKIT_URL must name a public host in production, not an internal one ' +
        '(loopback, a single-label service name or a private IPv4 address): every join ' +
        'ticket hands it to clients',
    ]);
  });

  it('accepts ws:// in development and test, real media enabled or not', () => {
    for (const environment of ['development', 'test']) {
      expect(
        loadConfig({
          ...DEPLOYED,
          ...REAL_MEDIA,
          NODE_ENV: environment,
          LIVEKIT_URL: 'ws://127.0.0.1:7880',
        }).livekit.url,
      ).toBe('ws://127.0.0.1:7880');
      expect(
        loadConfig({ NODE_ENV: environment, LIVEKIT_URL: 'ws://media.school.example' }).livekit.url,
      ).toBe('ws://media.school.example');
    }
  });

  it.each(DEPLOYED_ENVIRONMENTS)(
    'refuses ws:// in %s even where real media is not enabled — never a clear URL there',
    (environment) => {
      expect(
        problemsOf({
          ...DEPLOYED,
          NODE_ENV: environment,
          LIVEKIT_URL: 'ws://media.school.example',
        }),
      ).toEqual([`LIVEKIT_URL must use wss:// in ${environment}: clients never connect in clear`]);
    },
  );

  it.each(['ws://livekit:7880', 'ftp://livekit', 'livekit:7880', 'nonsense'])(
    'refuses the API URL %j — an http:// or https:// URL',
    (apiUrl) => {
      expect(problemsOf({ LIVEKIT_API_URL: apiUrl })).toEqual([
        'LIVEKIT_API_URL must be an http:// or https:// URL',
      ]);
    },
  );

  it.each([
    'http://media.school.example',
    'http://8.8.8.8:7880',
    'http://172.15.0.1:7880',
    'http://172.32.0.1:7880',
    'http://192.169.0.1:7880',
    'http://11.0.0.1:7880',
    'http://livekit.internal:7880',
    'http://[fd00::1]:7880',
  ])('refuses a plain-http API URL to %s for real media in a deployed environment', (apiUrl) => {
    for (const environment of DEPLOYED_ENVIRONMENTS) {
      expect(
        problemsOf({ ...DEPLOYED, ...REAL_MEDIA, NODE_ENV: environment, LIVEKIT_API_URL: apiUrl }),
      ).toEqual([
        `LIVEKIT_API_URL must use https:// in ${environment} unless its host is internal ` +
          '(loopback, a single-label service name or a private IPv4 address)',
      ]);
    }
  });

  it.each([
    'http://livekit:7880',
    'http://localhost:7880',
    'http://127.0.0.1:7880',
    'http://127.200.3.4:7880',
    'http://[::1]:7880',
    'http://10.20.30.40:7880',
    'http://172.16.0.1:7880',
    'http://172.31.255.254:7880',
    'http://192.168.1.10:7880',
    'https://media.school.example',
  ])('accepts the API URL %s for real media in a deployed environment', (apiUrl) => {
    for (const environment of DEPLOYED_ENVIRONMENTS) {
      expect(
        loadConfig({ ...DEPLOYED, ...REAL_MEDIA, NODE_ENV: environment, LIVEKIT_API_URL: apiUrl })
          .livekit.apiUrl,
      ).toBe(apiUrl);
    }
  });

  it('refuses a plain-http API URL to a public host in a deployed environment, real media or not', () => {
    expect(
      problemsOf({
        ...DEPLOYED,
        NODE_ENV: 'production',
        LIVEKIT_API_URL: 'http://media.school.example',
      }),
    ).toEqual([
      'LIVEKIT_API_URL must use https:// in production unless its host is internal ' +
        '(loopback, a single-label service name or a private IPv4 address)',
    ]);
  });

  it('accepts a plain-http API URL to a public host in development', () => {
    expect(
      loadConfig({ ...DEPLOYED, ...REAL_MEDIA, LIVEKIT_API_URL: 'http://media.school.example' })
        .livekit.apiUrl,
    ).toBe('http://media.school.example');
  });

  it('never repeats a URL it refused — a URL can carry a credential', () => {
    const withPassword = 'https://operator:hunter2-password@media.school.example';
    expect(problemsOf({ LIVEKIT_URL: withPassword })).toEqual([
      'LIVEKIT_URL must be a ws:// or wss:// URL',
    ]);
    expect(problemsOf({ LIVEKIT_API_URL: withPassword.replace('https', 'wss') })).toEqual([
      'LIVEKIT_API_URL must be an http:// or https:// URL',
    ]);
  });
});

describe('the URL rules, as the readiness probe reuses them', () => {
  it('finds a client URL malformed unless ws: or wss:, and insecure unless wss: where required', () => {
    expect(clientUrlFault('wss://media.school.example', true)).toBeNull();
    expect(clientUrlFault('ws://media.school.example', false)).toBeNull();
    expect(clientUrlFault('ws://media.school.example', true)).toBe('insecure');
    expect(clientUrlFault('https://media.school.example', false)).toBe('malformed');
    expect(clientUrlFault('::', false)).toBe('malformed');
  });

  it('finds an API URL malformed unless http: or https:, and insecure over http to a public host where required', () => {
    expect(apiUrlFault('https://media.school.example', true)).toBeNull();
    expect(apiUrlFault('http://media.school.example', false)).toBeNull();
    expect(apiUrlFault('http://livekit:7880', true)).toBeNull();
    expect(apiUrlFault('http://media.school.example', true)).toBe('insecure');
    expect(apiUrlFault('wss://media.school.example', false)).toBe('malformed');
  });

  it('knows an internal host: loopback, a single-label name, an RFC 1918 address', () => {
    for (const host of ['localhost', '127.0.0.1', '127.255.0.9', '[::1]', 'livekit', 'lk-1']) {
      expect({ host, internal: isInternalHost(host) }).toEqual({ host, internal: true });
    }
    for (const host of ['10.0.0.1', '172.16.5.5', '172.31.0.1', '192.168.0.1']) {
      expect({ host, internal: isInternalHost(host) }).toEqual({ host, internal: true });
    }
    for (const host of [
      '',
      'media.school.example',
      'localhost.example',
      '8.8.8.8',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.1.1',
      '100.64.0.1',
      '[fd00::1]',
      '[::ffff:7f00:1]',
    ]) {
      expect({ host, internal: isInternalHost(host) }).toEqual({ host, internal: false });
    }
  });
});

describe('loadConfig — the pinned LiveKit server (decision 1)', () => {
  it('pins v1.13.7', () => {
    expect(PINNED_LIVEKIT_SERVER_VERSION).toBe('1.13.7');
  });

  it.each([undefined, '', '1.13.6', '1.13.8', 'v1.13.7', 'latest', '1.13'])(
    'refuses to boot real media with LIVEKIT_VERSION=%j',
    (version) => {
      const env: Record<string, string> = { ...DEPLOYED, ...REAL_MEDIA };
      if (version === undefined) delete env.LIVEKIT_VERSION;
      else env.LIVEKIT_VERSION = version;
      expect(problemsOf(env)).toEqual([
        'LIVEKIT_VERSION must be 1.13.7, the pinned LiveKit server, when LIVE_MEDIA_PROVIDER=livekit',
      ]);
    },
  );

  it('boots real media on the pinned version, and records the version it was given', () => {
    expect(loadConfig({ ...DEPLOYED, ...REAL_MEDIA }).livekit.version).toBe('1.13.7');
    expect(loadConfig({}).livekit.version).toBeNull();
    // Without real media the version is only recorded: nothing talks to a server.
    expect(loadConfig({ LIVEKIT_VERSION: '1.12.0' }).livekit.version).toBe('1.12.0');
  });
});

describe('loadConfig — the LiveKit credentials (decision 4)', () => {
  it('requires a key and a secret set on purpose once real media is enabled — no default', () => {
    const { LIVEKIT_API_KEY: _key, LIVEKIT_API_SECRET: _secret, ...withoutBoth } = DEPLOYED;
    expect(problemsOf({ ...withoutBoth, ...REAL_MEDIA })).toEqual([
      'LIVEKIT_API_KEY is required when LIVE_MEDIA_PROVIDER=livekit',
      'LIVEKIT_API_SECRET is required when LIVE_MEDIA_PROVIDER=livekit',
    ]);
    // Deployed, a missing one is reported once, as every missing setting is.
    expect(problemsOf({ ...withoutBoth, ...REAL_MEDIA, NODE_ENV: 'production' })).toEqual([
      'LIVEKIT_API_KEY is required in production',
      'LIVEKIT_API_SECRET is required in production',
      'LIVEKIT_API_SECRET still holds a placeholder value',
    ]);
  });

  it('refuses a LiveKit secret equal to the JWT secret — in every environment', () => {
    for (const environment of ['development', 'test', 'staging', 'production']) {
      expect(
        problemsOf({
          ...DEPLOYED,
          ...REAL_MEDIA,
          NODE_ENV: environment,
          LIVEKIT_API_SECRET: DEPLOYED.JWT_SECRET,
        }),
      ).toEqual(['LIVEKIT_API_SECRET must differ from JWT_SECRET']);
    }
  });

  it('refuses a LiveKit secret equal to the storage signing secret — in every environment', () => {
    for (const environment of ['development', 'test', 'staging', 'production']) {
      expect(
        problemsOf({
          ...DEPLOYED,
          ...REAL_MEDIA,
          NODE_ENV: environment,
          LIVEKIT_API_SECRET: DEPLOYED.STORAGE_SIGNING_SECRET,
        }),
      ).toEqual(['LIVEKIT_API_SECRET must differ from STORAGE_SIGNING_SECRET']);
    }
  });

  it('never repeats a secret in a refusal', () => {
    const message = (() => {
      try {
        loadConfig({ ...DEPLOYED, ...REAL_MEDIA, LIVEKIT_API_SECRET: DEPLOYED.JWT_SECRET });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('LIVEKIT_API_SECRET must differ from JWT_SECRET');
    expect(message).not.toContain(DEPLOYED.JWT_SECRET);
  });

  it('leaves an unused LiveKit secret alone in development and test without real media', () => {
    // The fake and the disabled provider sign nothing, and no LiveKit server
    // is handed the secret there.
    for (const environment of ['development', 'test']) {
      expect(
        loadConfig({ NODE_ENV: environment, LIVEKIT_API_SECRET: 'development-only-secret' }).live
          .mediaProvider,
      ).toBeNull();
    }
  });

  it.each(DEPLOYED_ENVIRONMENTS)(
    'keeps the LiveKit secret apart in %s even where real media is not enabled — the server still gets it',
    (environment) => {
      // Compose hands the LiveKit server its secret whatever the API binds.
      expect(
        problemsOf({
          ...DEPLOYED,
          NODE_ENV: environment,
          LIVEKIT_API_SECRET: DEPLOYED.JWT_SECRET,
        }),
      ).toEqual(['LIVEKIT_API_SECRET must differ from JWT_SECRET']);
      expect(
        problemsOf({
          ...DEPLOYED,
          NODE_ENV: environment,
          LIVEKIT_API_SECRET: DEPLOYED.STORAGE_SIGNING_SECRET,
        }),
      ).toEqual(['LIVEKIT_API_SECRET must differ from STORAGE_SIGNING_SECRET']);
    },
  );

  it.each(DEPLOYED_ENVIRONMENTS)(
    'boots real media in %s with everything set as it must be',
    (environment) => {
      const config = loadConfig({ ...DEPLOYED, ...REAL_MEDIA, NODE_ENV: environment });
      expect(config.live.mediaProvider).toBe('livekit');
      expect(config.livekit).toEqual({
        url: 'wss://media.school.example',
        apiUrl: 'https://media.school.example',
        apiKey: 'APIa1b2c3d4e5f6',
        apiSecret: 's'.repeat(40),
        version: '1.13.7',
      });
    },
  );
});
