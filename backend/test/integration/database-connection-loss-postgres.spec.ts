import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

import type { AppConfig } from '../../src/platform/config/app-config';
import { createPool } from '../../src/platform/database';
import { TEST_DATABASE_URL, describeWithPostgres } from '../support/postgres';

const IDLE = 'an idle database connection failed; the pool dropped it';
const IN_USE = 'a database connection in use failed; the work on it was refused';

/**
 * The application pool's two error listeners on the REAL node-postgres pool
 * (`platform/database/database.ts`): a connection Postgres ends while it is
 * idle is reported once, by the pool's listener; one it ends while checked
 * out is reported once, by the client's own listener — and neither ends the
 * process. The unit spec simulates both with a bare EventEmitter; this pins
 * them to the pg-pool actually installed, whose idle listener the client
 * listener defers to.
 */
describeWithPostgres('application pool — connections Postgres ends (real pg-pool)', () => {
  let admin: Pool;
  let warn: jest.SpyInstance;

  const warnings = (message: string): unknown[][] =>
    (warn.mock.calls as unknown[][]).filter((call) => call[1] === message);

  /** Ends one backend from outside, as an administrator or a restart would. */
  async function terminate(pid: number): Promise<void> {
    await admin.query('select pg_terminate_backend($1)', [pid]);
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  beforeAll(() => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const appPool = () => createPool({ database: { url: TEST_DATABASE_URL ?? '' } } as AppConfig);

  it('reports an idle connection ended by Postgres once — as idle — and stays usable', async () => {
    const pool = appPool();
    try {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        .pid;
      client.release(); // idle now: the pool's own listener is attached

      await terminate(pid);
      await until(() => warnings(IDLE).length > 0);

      expect(warnings(IDLE)).toHaveLength(1);
      expect(warnings(IN_USE)).toHaveLength(0);
      // The pool replaced it: the next query runs on a fresh connection.
      expect((await pool.query('select 1 as one')).rows[0]).toEqual({ one: 1 });
    } finally {
      await pool.end();
    }
  });

  it('reports a checked-out connection ended by Postgres once — as in use — without ending the process', async () => {
    const pool = appPool();
    const client = await pool.connect();
    let released = false;
    try {
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        .pid;

      // pg emits 'error' twice for this one loss (57P01, then "terminated
      // unexpectedly"); wait for both before counting.
      await terminate(pid);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(warnings(IN_USE)).toHaveLength(1);
      expect(warnings(IDLE)).toHaveLength(0);
      await expect(client.query('select 1')).rejects.toThrow(/not queryable/);
      client.release(new Error('the connection ended'));
      released = true;
      expect((await pool.query('select 1 as one')).rows[0]).toEqual({ one: 1 });
    } finally {
      // Always hand the client back: the pool cannot end while one is out.
      if (!released) client.release(new Error('test teardown'));
      await pool.end();
    }
  });
});
