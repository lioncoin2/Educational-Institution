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
    const code = (error as { code?: unknown }).code;
    logger.warn(
      { err: { name: error.name, code: typeof code === 'string' ? code : undefined } },
      'an idle database connection failed; the pool dropped it',
    );
  });
  return pool;
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool);
}
