import { createHmac } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';

import { AdjustableClock } from '../../../../test/support/identity-harness';
import { JwtTokenIssuer } from './jwt-token-issuer';

const SECRET = 'test-only-secret-that-is-at-least-32-bytes-long';

function issuer(
  clock = new AdjustableClock(),
  overrides: Partial<{ secret: string; issuer: string; audience: string }> = {},
) {
  return new JwtTokenIssuer(
    new JwtService({}),
    { secret: SECRET, issuer: 'test-api', audience: 'test-clients', ttlSeconds: 900, ...overrides },
    clock,
  );
}

const decode = (token: string, part: 0 | 1): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[part] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('JwtTokenIssuer', () => {
  it('round-trips the subject and session, and reports when the token expires', async () => {
    const clock = new AdjustableClock();
    const tokens = issuer(clock);
    const issuedAt = Math.floor(clock.now().getTime() / 1000);
    const { token, expiresInSeconds } = await tokens.issueAccessToken({
      userId: 'u-1',
      sessionId: 's-1',
    });
    expect(expiresInSeconds).toBe(900);
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual({
      userId: 'u-1',
      sessionId: 's-1',
      expiresAt: new Date((issuedAt + 900) * 1000),
    });
  });

  // Anything in a JWT is readable by whoever holds it and stays true until
  // expiry. So: identifiers and times, and nothing else.
  it('carries exactly sub, sid, iat, exp, iss and aud — no email, roles or permissions', async () => {
    const { token } = await issuer().issueAccessToken({ userId: 'u-1', sessionId: 's-1' });
    const claims = decode(token, 1);
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
    expect(claims.exp).toBe((claims.iat as number) + 900);
    expect(decode(token, 0)).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('refuses an expired token', async () => {
    const clock = new AdjustableClock();
    const tokens = issuer(clock);
    const { token } = await tokens.issueAccessToken({ userId: 'u-1', sessionId: 's-1' });
    clock.advance(899);
    await expect(tokens.verifyAccessToken(token)).resolves.not.toBeNull();
    clock.advance(1);
    await expect(tokens.verifyAccessToken(token)).resolves.toBeNull();
  });

  it('refuses a token signed with another key, or for another issuer or audience', async () => {
    const tokens = issuer();
    for (const other of [
      issuer(new AdjustableClock(), { secret: 'a-completely-different-secret-of-32-bytes!' }),
      issuer(new AdjustableClock(), { issuer: 'someone-else' }),
      issuer(new AdjustableClock(), { audience: 'someone-elses-clients' }),
    ]) {
      const { token } = await other.issueAccessToken({ userId: 'u-1', sessionId: 's-1' });
      await expect(tokens.verifyAccessToken(token)).resolves.toBeNull();
    }
  });

  it('refuses a token whose payload was edited', async () => {
    const tokens = issuer();
    const { token } = await tokens.issueAccessToken({ userId: 'u-1', sessionId: 's-1' });
    const [header, payload, signature] = token.split('.');
    const original = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const edited = { ...original, sub: 'u-admin' };
    await expect(
      tokens.verifyAccessToken(`${header}.${b64(edited)}.${signature}`),
    ).resolves.toBeNull();
  });

  // The classic JWT attacks: a token that chooses its own algorithm.
  it('refuses alg "none" and any algorithm other than HS256', async () => {
    const tokens = issuer();
    const now = Math.floor(new AdjustableClock().now().getTime() / 1000);
    const claims = {
      sub: 'u-1',
      sid: 's-1',
      iat: now,
      exp: now + 900,
      iss: 'test-api',
      aud: 'test-clients',
    };

    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    await expect(tokens.verifyAccessToken(unsigned)).resolves.toBeNull();

    const body = `${b64({ alg: 'HS512', typ: 'JWT' })}.${b64(claims)}`;
    const hs512 = `${body}.${createHmac('sha512', SECRET).update(body).digest('base64url')}`;
    await expect(tokens.verifyAccessToken(hs512)).resolves.toBeNull();
  });

  it('refuses a validly signed token missing the session claim', async () => {
    const jwt = new JwtService({});
    const token = await jwt.signAsync(
      { sub: 'u-1' },
      {
        secret: SECRET,
        algorithm: 'HS256',
        issuer: 'test-api',
        audience: 'test-clients',
        expiresIn: 900,
      },
    );
    const clockNow = new AdjustableClock(new Date());
    await expect(issuer(clockNow).verifyAccessToken(token)).resolves.toBeNull();
  });

  it('never throws on garbage', async () => {
    for (const token of ['', '.', '..', 'a.b.c', 'x'.repeat(10_000)]) {
      await expect(issuer().verifyAccessToken(token)).resolves.toBeNull();
    }
  });
});
