import { EventEmitter } from 'node:events';

import { Logger } from '@nestjs/common';

import type { AppConfig } from '../config/app-config';
import { createPool } from './database';

describe('the connection pool', () => {
  afterEach(() => jest.restoreAllMocks());

  it('outlives an idle connection failing, and logs it by code and class only', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pool = createPool({
      database: { url: 'postgresql://pool-probe-user@db.invalid/app' },
    } as AppConfig);
    // What node-postgres emits for an idle client when Postgres ends its
    // session — here with connection details in the message, as a driver may.
    const ended = Object.assign(
      new Error('terminating connection due to administrator command (pool-probe-user@db.invalid)'),
      { code: '57P01', severity: 'FATAL' },
    );
    try {
      expect(() => pool.emit('error', ended)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        { err: { name: 'Error', code: '57P01' } },
        'an idle database connection failed; the pool dropped it',
      );
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('pool-probe-user');
      expect(logged).not.toContain('db.invalid');
    } finally {
      await pool.end();
    }
  });

  // Found by the readiness integration suite: a client checked out by a
  // transaction when its socket died emitted an unheard 'error' — fatal to the
  // process. Every client the pool opens now carries its own listener.
  it('outlives a connection failing while it is checked out, and logs it by code and class only', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pool = createPool({
      database: { url: 'postgresql://pool-probe-user@db.invalid/app' },
    } as AppConfig);
    const client = new EventEmitter();
    try {
      pool.emit('connect', client);
      const lost = Object.assign(
        new Error('Connection terminated unexpectedly (pool-probe-user@db.invalid)'),
        { code: 'ECONNRESET' },
      );
      expect(() => client.emit('error', lost)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        { err: { name: 'Error', code: 'ECONNRESET' } },
        'a database connection in use failed; the work on it was refused',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('db.invalid');
    } finally {
      await pool.end();
    }
  });

  it("leaves an idle connection's failure to the pool's own report — one line, not two", async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pool = createPool({
      database: { url: 'postgresql://pool-probe-user@db.invalid/app' },
    } as AppConfig);
    const client = new EventEmitter();
    try {
      pool.emit('connect', client);
      // An idle client: the pool's own listener is attached beside ours.
      client.on('error', () => undefined);
      client.emit('error', Object.assign(new Error('terminated'), { code: '57P01' }));
      expect(warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'a database connection in use failed; the work on it was refused',
      );
    } finally {
      await pool.end();
    }
  });
});
