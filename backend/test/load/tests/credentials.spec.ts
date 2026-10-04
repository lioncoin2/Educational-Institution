import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOOPBACK_ROOM_SERVICE, parseLivekitKeys, readFleetEnv } from '../livekit/credentials';

/**
 * Unit tests for the SUT-side credential reader (design §2, §19): only the two
 * LiveKit keys are parsed, into a local object (never `process.env`), and
 * RoomService is pinned to loopback whatever the file or the caller says.
 * Every env file here is a synthetic temp file — never infra/env/*.env.
 */

/** A deployment-shaped env file: the two keys among secrets that must never be parsed. */
const DEPLOYMENT_ENV = [
  '# staging deployment',
  'NODE_ENV=production',
  'DATABASE_URL=postgres://app:db-password@db:5432/institution',
  'REDIS_URL=redis://:redis-password@cache:6379',
  'JWT_SECRET=jwt-secret-value-0123456789abcdef0123456789abcdef',
  'STORAGE_SIGNING_SECRET=storage-secret-value',
  'LIVEKIT_URL=wss://livekit-staging.example.test',
  'LIVEKIT_API_URL=https://livekit-staging.example.test',
  'LIVEKIT_API_KEY=APIstagingkey',
  'LIVEKIT_API_SECRET=staging-livekit-secret-value',
  'LOADTEST_LIVEKIT_API_KEY=APIwrongkey',
  'LOADTEST_LIVEKIT_API_SECRET=wrong-secret',
  '',
].join('\n');

describe('livekit/credentials — parseLivekitKeys (pure)', () => {
  it('returns exactly the two keys and nothing else from a deployment file', () => {
    const keys = parseLivekitKeys(DEPLOYMENT_ENV);
    expect(keys).toEqual({ apiKey: 'APIstagingkey', apiSecret: 'staging-livekit-secret-value' });
    expect(Object.keys(keys!).sort()).toEqual(['apiKey', 'apiSecret']);
  });

  it('never parses another variable: no value of the file other than the two keys appears', () => {
    const keys = parseLivekitKeys(DEPLOYMENT_ENV)!;
    const out = JSON.stringify(keys);
    for (const leaked of [
      'db-password',
      'redis-password',
      'jwt-secret-value',
      'storage-secret-value',
      'livekit-staging.example.test',
      'APIwrongkey',
      'wrong-secret',
    ])
      expect(out).not.toContain(leaked);
  });

  it('accepts the `export` prefix, leading whitespace and spaces around =', () => {
    expect(
      parseLivekitKeys('export LIVEKIT_API_KEY=k1\n  export   LIVEKIT_API_SECRET = s1  \n'),
    ).toEqual({ apiKey: 'k1', apiSecret: 's1' });
  });

  it('strips one pair of matching double or single quotes (inner spaces kept)', () => {
    expect(parseLivekitKeys('LIVEKIT_API_KEY="k 2"\nLIVEKIT_API_SECRET=\'s=2#x\'\n')).toEqual({
      apiKey: 'k 2',
      apiSecret: 's=2#x',
    });
    expect(parseLivekitKeys('export LIVEKIT_API_KEY = "k3" \nLIVEKIT_API_SECRET="s3"')).toEqual({
      apiKey: 'k3',
      apiSecret: 's3',
    });
  });

  it('ignores look-alike names: LOADTEST_ prefix, suffixes, comments', () => {
    const text = [
      'LOADTEST_LIVEKIT_API_KEY=lk',
      'LOADTEST_LIVEKIT_API_SECRET=ls',
      'LIVEKIT_API_KEY_OLD=old',
      'LIVEKIT_API_SECRET_PREVIOUS=prev',
      '# LIVEKIT_API_KEY=commented',
      '#LIVEKIT_API_SECRET=commented',
      'MY_LIVEKIT_API_KEY=mine',
    ].join('\n');
    expect(parseLivekitKeys(text)).toBeNull();
    expect(parseLivekitKeys(`${text}\nLIVEKIT_API_KEY=k\nLIVEKIT_API_SECRET=s`)).toEqual({
      apiKey: 'k',
      apiSecret: 's',
    });
  });

  it('a later assignment wins, as when the file is sourced', () => {
    expect(
      parseLivekitKeys(
        'LIVEKIT_API_KEY=first\nLIVEKIT_API_SECRET=s1\nLIVEKIT_API_KEY=second\nLIVEKIT_API_SECRET=s2',
      ),
    ).toEqual({ apiKey: 'second', apiSecret: 's2' });
  });

  it('is null when either key is missing or empty', () => {
    expect(parseLivekitKeys('')).toBeNull();
    expect(parseLivekitKeys('DATABASE_URL=postgres://x')).toBeNull();
    expect(parseLivekitKeys('LIVEKIT_API_KEY=k')).toBeNull();
    expect(parseLivekitKeys('LIVEKIT_API_SECRET=s')).toBeNull();
    expect(parseLivekitKeys('LIVEKIT_API_KEY=\nLIVEKIT_API_SECRET=s')).toBeNull();
    expect(parseLivekitKeys('LIVEKIT_API_KEY=k\nLIVEKIT_API_SECRET=""')).toBeNull();
    expect(parseLivekitKeys("LIVEKIT_API_KEY=''\nLIVEKIT_API_SECRET=s")).toBeNull();
    expect(parseLivekitKeys('LIVEKIT_API_KEY=   \nLIVEKIT_API_SECRET=s')).toBeNull();
  });

  it('LOOPBACK_ROOM_SERVICE is http://127.0.0.1:7880', () => {
    expect(LOOPBACK_ROOM_SERVICE).toBe('http://127.0.0.1:7880');
  });
});

describe('livekit/credentials — readFleetEnv (temp file)', () => {
  let dir = '';
  const file = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'p84-cred-spec-'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('client URL as given, keys from the file, RoomService pinned to loopback', async () => {
    const env = await readFleetEnv(
      file('staging.env', DEPLOYMENT_ENV),
      'wss://livekit-staging.example.test',
    );
    expect(env).toEqual({
      url: 'wss://livekit-staging.example.test',
      apiUrl: 'http://127.0.0.1:7880',
      apiKey: 'APIstagingkey',
      apiSecret: 'staging-livekit-secret-value',
    });
    expect(Object.keys(env).sort()).toEqual(['apiKey', 'apiSecret', 'apiUrl', 'url']);
  });

  it('apiUrl stays loopback whatever the file, the client URL or process.env say', async () => {
    const saved = process.env.LOADTEST_LIVEKIT_API_URL;
    process.env.LOADTEST_LIVEKIT_API_URL = 'https://public.example.test';
    try {
      const env = await readFleetEnv(
        file(
          'override.env',
          'LIVEKIT_API_URL=https://evil.example.test\nLIVEKIT_API_KEY=k\nLIVEKIT_API_SECRET=s\n',
        ),
        'https://public-vhost.example.test',
      );
      expect(env.apiUrl).toBe(LOOPBACK_ROOM_SERVICE);
      expect(env.url).toBe('https://public-vhost.example.test');
    } finally {
      if (saved === undefined) delete process.env.LOADTEST_LIVEKIT_API_URL;
      else process.env.LOADTEST_LIVEKIT_API_URL = saved;
    }
  });

  it('does not touch process.env (nothing added, removed or changed)', async () => {
    const before = { ...process.env };
    await readFleetEnv(file('touch.env', DEPLOYMENT_ENV), 'wss://lk.example.test');
    expect({ ...process.env }).toEqual(before);
    expect(process.env.LIVEKIT_API_SECRET).not.toBe('staging-livekit-secret-value');
    expect(process.env.LIVEKIT_API_KEY).not.toBe('APIstagingkey');
  });

  it('rejects when a key is missing, naming the file but no value from it', async () => {
    const path = file(
      'partial.env',
      'DATABASE_URL=postgres://app:db-password@db/x\nLIVEKIT_API_KEY=APIonlythekey\n',
    );
    const err: unknown = await readFleetEnv(path, 'wss://lk.example.test').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('LIVEKIT_API_KEY / LIVEKIT_API_SECRET not found');
    expect(message).toContain(path);
    expect(message).not.toContain('APIonlythekey');
    expect(message).not.toContain('db-password');
  });

  it('rejects when the file does not exist', async () => {
    await expect(readFleetEnv(join(dir, 'absent.env'), 'wss://lk.example.test')).rejects.toThrow(
      /ENOENT/,
    );
  });
});
