import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { createDatabase, type Database } from '../../src/platform/database';

export const MIGRATIONS = join(__dirname, '..', '..', 'drizzle');
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Integration suites run against a real Postgres when TEST_DATABASE_URL is set
 * and skip otherwise — announcing it, because a suite that silently vanishes is
 * indistinguishable from one that passes. CI always sets it.
 */
export function describeWithPostgres(name: string, body: () => void): void {
  if (TEST_DATABASE_URL === undefined) {
    describe.skip(name, body);
    process.stderr.write(
      `[skip] ${name}: set TEST_DATABASE_URL to run the Postgres integration tests.\n`,
    );
    return;
  }
  describe(name, body);
}

export interface ScratchDatabase {
  /** Its connection string — for booting the whole application against it. */
  readonly url: string;
  readonly pool: Pool;
  readonly db: Database;
  drop(): Promise<void>;
}

/**
 * A brand-new database for one suite: isolated from every other suite and from
 * previous runs, built only by the committed migrations (or a prefix of them).
 */
export async function scratchDatabase(options: { upTo?: number } = {}): Promise<ScratchDatabase> {
  const adminUrl = TEST_DATABASE_URL ?? '';
  const name = `it_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = withDatabase(adminUrl, name);
  const pool = tolerateTeardown(new Pool({ connectionString: url, max: 4 }));
  const db = createDatabase(pool);
  await migrateTo(db, options.upTo);

  return {
    url,
    pool,
    db,
    async drop() {
      await pool.end();
      const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/**
 * `pool.end()` resolves once the pool has let go of its clients, not once
 * their sockets have closed; dropping the database WITH (FORCE) straight
 * after can terminate one that is still closing (57P01). That is teardown,
 * not a failure — anything else an idle client reports still surfaces.
 */
export function tolerateTeardown(pool: Pool): Pool {
  pool.on('error', (error) => {
    if ((error as { code?: unknown }).code !== '57P01') throw error;
  });
  return pool;
}

/**
 * Points a connection string at another database. Not `new URL()`: libpq's
 * socket form, `postgresql://user@/db?host=/tmp`, has an empty host, which the
 * WHATWG parser rejects.
 */
function withDatabase(connectionString: string, database: string): string {
  const replaced = connectionString.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)[^?]*/, `$1${database}`);
  if (replaced === connectionString) throw new Error('TEST_DATABASE_URL must name a database');
  return replaced;
}

/** Applies all committed migrations, or only the first `upTo` of them. */
export async function migrateTo(db: Database, upTo?: number): Promise<void> {
  if (upTo === undefined) {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return;
  }
  // The migrator reads the journal, so a truncated journal in a copy of the
  // folder is exactly "the schema as it was after migration N".
  const folder = mkdtempSync(join(tmpdir(), 'migrations-'));
  try {
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, upTo);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
