import { isDatabaseUnavailable, postgresErrorCode } from './postgres-errors';

/** A server error as node-postgres builds it: a SQLSTATE and a severity. */
const server = (code: string) =>
  Object.assign(new Error('server said no'), { code, severity: 'ERROR' });
/** Drizzle's wrapping: the driver error as the cause. */
const wrapped = (cause: unknown) => Object.assign(new Error('Failed query'), { cause });

describe('Postgres error classification', () => {
  it('reads a SQLSTATE through Drizzle’s wrapping, and only from a server error', () => {
    expect(postgresErrorCode(wrapped(server('40P01')))).toBe('40P01');
    // A socket error's five-letter code is not a SQLSTATE.
    expect(postgresErrorCode(Object.assign(new Error('pipe'), { code: 'EPIPE' }))).toBeUndefined();
    expect(postgresErrorCode('nope')).toBeUndefined();
  });

  it('calls an outage an outage: connection class, shutdowns, too many connections, sockets, the pool', () => {
    for (const unavailable of [
      server('08006'),
      wrapped(server('08001')),
      server('57P01'),
      server('57P03'),
      server('53300'),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      wrapped(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
      new Error('timeout exceeded when trying to connect'),
      wrapped(new Error('Connection terminated unexpectedly')),
    ]) {
      expect(isDatabaseUnavailable(unavailable)).toBe(true);
    }
  });

  it('never calls a fault or a refused statement an outage', () => {
    for (const fault of [
      server('23505'), // unique violation
      server('23514'), // check violation
      server('40P01'), // deadlock: retried by the caller, not an outage
      server('57014'), // statement timeout
      server('57P04'),
      new TypeError('cannot read properties of undefined'),
      null,
      'a string',
    ]) {
      expect(isDatabaseUnavailable(fault)).toBe(false);
    }
  });
});
