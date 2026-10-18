import { Logger } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { AppConfig } from '../config/app-config';

/**
 * The database handle, and the one place a connection pool is created.
 *
 * Deliberately schema-less: `drizzle(pool)` without a registered schema. Each
 * module declares and imports its own tables, so platform never learns what
 * tables exist and `platform-knows-no-modules` holds. The cost is that
 * Drizzle's relational query API (`db.query.users...`) is unavailable; the
 * select/insert builder, which is what the repositories use, is not affected.
 *
 * That trade is the whole reason this project uses Drizzle rather than Prisma —
 * see decisions/0008-drizzle-over-prisma.md.
 */
export type Database = NodePgDatabase<Record<string, never>>;

export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');

const logger = new Logger('Database');

export function createPool(config: AppConfig): Pool {
  const pool = new Pool({
    connectionString: config.database.url,
    // A pool per process, sized for a modest API instance. Raise deliberately,
    // with Postgres's own max_connections in view — not by guesswork.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // A connection that fails while idle — Postgres restarting, a failover, an
  // administrator ending the session — is reported on the pool, which has
  // already dropped it; the next query opens a fresh one. Unheard, that report
  // would be an uncaught 'error' and end the process. Logged by code and
  // class only: the message can echo connection details.
  pool.on('error', (error: Error) => {
    logger.warn(
      { err: errorClass(error) },
      'an idle database connection failed; the pool dropped it',
    );
  });
  // A connection can also fail while it is checked out — mid-transaction, when
  // Postgres restarts or the network drops. node-postgres then emits 'error' on
  // the CLIENT, which the pool listens to only while the client is idle; unheard,
  // that is an uncaught exception and the whole process ends with every request
  // in it. The work in flight already fails on its own (its query rejects, and
  // its caller answers with the failure), and the pool discards the broken
  // client when it is released — so this listener only keeps the event from
  // ending the process. Logged by code and class only, as above.
  pool.on('connect', (client) => {
    let reported = false;
    client.on('error', (error: Error) => {
      // While the client is idle the pool listens too, and reports it above;
      // this listener speaks only for a client in use.
      if (client.listenerCount('error') > 1) return;
      // pg reports one lost connection more than once (Postgres's own 57P01,
      // then "Connection terminated unexpectedly"): one line per connection.
      if (reported) return;
      reported = true;
      logger.warn(
        { err: errorClass(error) },
        'a database connection in use failed; the work on it was refused',
      );
    });
  });
  return pool;
}

/** What may be logged of a driver error: its class and code, never its message. */
function errorClass(error: Error): { name: string; code: string | undefined } {
  const code = (error as { code?: unknown }).code;
  return { name: error.name, code: typeof code === 'string' ? code : undefined };
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool);
}
