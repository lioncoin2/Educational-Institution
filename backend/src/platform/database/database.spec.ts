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
});
