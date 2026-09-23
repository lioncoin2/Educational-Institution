import { Writable } from 'node:stream';

import pino from 'pino';

import { loadConfig } from '../config/app-config';
import { REDACTED_PATHS, loggerOptions } from './logger-options';

/** A pino logger with the application's real redaction, writing to a string. */
function capture(): { logger: pino.Logger; output: () => string } {
  let written = '';
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written += chunk.toString();
      done();
    },
  });
  return {
    logger: pino({ redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' } }, sink),
    output: () => written,
  };
}

const SECRETS = {
  password: 'pw-hunter2',
  currentPassword: 'pw-current',
  newPassword: 'pw-new',
  initialPassword: 'pw-initial',
  passwordHash: '$scrypt$16384$8$1$salt$hash',
  refreshToken: 'session.refresh-secret-value',
  refreshTokenHash: 'stored-refresh-hash',
  previousRefreshTokenHash: 'stored-previous-hash',
  accessToken: 'eyJ.access.token',
  token: 'bare-token-value',
  secret: 'generic-secret-value',
  jwtSecret: 'jwt-signing-key',
  apiSecret: 'livekit-api-secret',
};

describe('log redaction — secrets are never logged', () => {
  // Every depth a real call might use: the object itself, a wrapper, a
  // wrapper's wrapper, and one more.
  it.each([
    ['at the top level', (s: object) => s],
    ['one level down', (s: object) => ({ command: s })],
    ['two levels down', (s: object) => ({ request: { body: s } })],
    ['three levels down', (s: object) => ({ a: { b: { c: s } } })],
  ])('censors every secret-bearing field %s', (_depth, wrap) => {
    const { logger, output } = capture();
    logger.info(wrap(SECRETS), 'event');
    for (const value of Object.values(SECRETS)) expect(output()).not.toContain(value);
    expect(output()).toContain('[redacted]');
  });

  // The Foundation claimed this worked; it did not, until the depths above.
  it('censors secrets in a dump of the real application config', () => {
    const { logger, output } = capture();
    const config = loadConfig({
      JWT_SECRET: 'the-jwt-signing-key-in-this-dump',
      LIVEKIT_API_SECRET: 'the-livekit-secret-in-this-dump',
    });
    logger.info({ config }, 'config at boot');
    expect(output()).not.toContain('the-jwt-signing-key-in-this-dump');
    expect(output()).not.toContain('the-livekit-secret-in-this-dump');
  });

  it('censors the credentials in request headers', () => {
    const { logger, output } = capture();
    logger.info({
      req: { headers: { authorization: 'Bearer eyJ.secret.jwt', cookie: 'session=abc123' } },
    });
    expect(output()).not.toContain('eyJ.secret.jwt');
    expect(output()).not.toContain('abc123');
  });

  it('is the configuration the application actually uses', () => {
    const options = loggerOptions(loadConfig({})).pinoHttp as { redact: { paths: string[] } };
    expect(options.redact.paths).toEqual([...REDACTED_PATHS]);
  });

  it('refuses to adopt an inbound request id that could forge log lines', () => {
    const options = loggerOptions(loadConfig({})).pinoHttp as {
      genReqId: (req: { headers: Record<string, string> }) => string;
    };
    expect(options.genReqId({ headers: { 'x-request-id': 'abc-123' } })).toBe('abc-123');
    const forged = options.genReqId({
      headers: { 'x-request-id': 'x\n{"level":60,"msg":"forged"}' },
    });
    expect(forged).not.toContain('forged');
    expect(forged).toMatch(/^[0-9a-f-]{36}$/);
  });
});
