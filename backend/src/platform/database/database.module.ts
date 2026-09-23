import { Global, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DATABASE, DATABASE_POOL, createDatabase, createPool } from './database';

/**
 * Closes the pool on shutdown so a redeploy does not leave sockets open against
 * Postgres. Nest calls this because `enableShutdownHooks()` is set in main.ts.
 */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('Database');

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('connection pool closed');
  }
}

/**
 * Provides the connection pool and the Drizzle handle.
 *
 * Not imported by `PlatformModule`: a unit test, and the app booted without a
 * database, should not open a pool. `AppModule` composes it explicitly.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPool(config),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool) => createDatabase(pool),
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE, DATABASE_POOL],
})
export class DatabaseModule {}
