import { verify } from 'node:crypto';

import {
  ScriptedFetch,
  TEST_CLIENT_EMAIL,
  TEST_PRIVATE_KEY_ID,
  TEST_PUBLIC_KEY,
  granted,
  json,
  serviceAccountJson,
} from '../../../../../test/support/fcm-fixtures';
import { AdjustableClock } from '../../../../../test/support/identity-harness';
import { FCM_SCOPE, FcmAccessTokens } from './fcm-access-tokens';
import { GOOGLE_TOKEN_URI, parseServiceAccount } from './fcm-credentials';

describe('FCM access tokens (OAuth 2.0 JWT-bearer)', () => {
  const credentials = parseServiceAccount(serviceAccountJson());
  let clock: AdjustableClock;
  let google: ScriptedFetch;
  let tokens: FcmAccessTokens;

  beforeEach(() => {
    clock = new AdjustableClock();
    google = new ScriptedFetch();
    tokens = new FcmAccessTokens(credentials, clock, google.fetch);
  });

  const decode = (part: string): unknown =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

  it('exchanges an RS256 assertion Google can verify, for the messaging scope only', async () => {
    google.respond(granted('ya29.first'));
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.first' });

    const [call] = google.calls;
    expect(call?.url).toBe(GOOGLE_TOKEN_URI);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    const sent = call?.init.body;
    const form = new URLSearchParams(typeof sent === 'string' ? sent : '');
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const [header, claims, signature] = (form.get('assertion') ?? '').split('.');
    expect(decode(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT', kid: TEST_PRIVATE_KEY_ID });
    const issuedAt = Math.floor(clock.now().getTime() / 1000);
    expect(decode(claims ?? '')).toEqual({
      iss: TEST_CLIENT_EMAIL,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URI,
      iat: issuedAt,
      exp: issuedAt + 3600,
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        TEST_PUBLIC_KEY,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });

  it('shares one token across sends, replacing it five minutes before it expires', async () => {
    google.respond(granted('ya29.first', 3600), granted('ya29.second', 3600));
    await tokens.get();
    clock.advance(3600 - 5 * 60 - 1);
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.first' });
    expect(google.calls).toHaveLength(1);
    clock.advance(1);
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.second' });
    expect(google.calls).toHaveLength(2);
  });

  it('asks Google once however many sends wait for a token', async () => {
    google.respond(granted('ya29.first'));
    const all = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(all.every((result) => result.ok && result.token === 'ya29.first')).toBe(true);
    expect(google.calls).toHaveLength(1);
  });

  it('forgets a token FCM refused — but not a newer one that replaced it', async () => {
    google.respond(granted('ya29.first'), granted('ya29.second'));
    await tokens.get();
    tokens.invalidate('ya29.first');
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.second' });
    tokens.invalidate('ya29.first'); // a late refusal of the old one
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.second' });
    expect(google.calls).toHaveLength(2);
  });

  it.each([
    ['Google failing', () => json(503, {}), 'retryable', 'oauth_http_503'],
    ['throttling', () => json(429, {}), 'retryable', 'oauth_http_429'],
    [
      'a refused grant (a deleted key, a wrong clock)',
      () => json(400, { error: 'invalid_grant' }),
      'rejected',
      'oauth_http_400',
    ],
    [
      'an unknown account',
      () => json(401, { error: 'invalid_client' }),
      'rejected',
      'oauth_http_401',
    ],
    [
      'an answer without a token',
      () => json(200, { token_type: 'Bearer' }),
      'retryable',
      'oauth_malformed',
    ],
    ['no answer at all', () => new TypeError('fetch failed'), 'retryable', 'oauth_network'],
    [
      'a timeout',
      () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      'retryable',
      'oauth_timeout',
    ],
  ])('reports %s by kind and code, never by text', async (_case, answer, kind, reason) => {
    google.respond(answer());
    expect(await tokens.get()).toEqual({
      ok: false,
      failure: { kind, reason, retryAfterSeconds: 10 },
    });
  });

  it('remembers a failed exchange for ten seconds — and says how long, so a retry waits it out', async () => {
    google.respond(json(503, {}), granted('ya29.later'));
    await tokens.get();
    clock.advance(4);
    expect(await tokens.get()).toEqual({
      ok: false,
      failure: { kind: 'retryable', reason: 'oauth_http_503', retryAfterSeconds: 6 },
    });
    expect(google.calls).toHaveLength(1);
    clock.advance(6);
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.later' });
  });

  it('keeps using a token that has not expired when Google fails to renew it', async () => {
    google.respond(granted('ya29.first', 3600), json(503, {}));
    await tokens.get();
    clock.advance(3600 - 60); // inside the renewal margin, a minute before it expires
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.first' });
    expect(await tokens.get()).toEqual({ ok: true, token: 'ya29.first' }); // failure remembered
    expect(google.calls).toHaveLength(2);
    clock.advance(60); // now it has expired
    expect((await tokens.get()).ok).toBe(false);
  });
});
