import { Global, Logger, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import {
  AUDIT_LOG,
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  type Clock,
  type DomainEvent,
  type IdGenerator,
} from '../shared';
import { DrizzleAuditLog } from './audit/drizzle-audit-log';
import { LoggingAuditLog } from './audit/logging-audit-log';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/app-config';
import { DATABASE, type Database } from './database';
import { EVENT_PUBLISHER, InProcessEventBus } from './events/event-bus';
import { HealthController } from './health/health.controller';
import { RateLimitGuard } from './http/rate-limit';
import { loggerOptions } from './logging/logger-options';
import { SystemClock } from './primitives/system-clock';
import { UuidIdGenerator } from './primitives/uuid-id-generator';
import { InMemoryRateLimiter } from './rate-limit/in-memory-rate-limiter';

const config = loadConfig();

/**
 * The technical substrate every module stands on: configuration, logging,
 * time, identifiers, the event bus, the audit trail and rate limiting.
 *
 * Platform knows nothing about business modules — that rule is enforced by
 * dependency-cruiser and is what keeps a module extractable later.
 */
@Global()
@Module({
  imports: [LoggerModule.forRoot(loggerOptions(config))],
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
    {
      provide: AUDIT_LOG,
      inject: [APP_CONFIG, DATABASE, ID_GENERATOR],
      useFactory: (appConfig: AppConfig, db: Database, ids: IdGenerator) =>
        appConfig.database.configured ? new DrizzleAuditLog(db, ids) : new LoggingAuditLog(),
    },
    {
      // In-process: correct for one instance. See the adapter for why a Redis
      // limiter is the production path.
      provide: RATE_LIMITER,
      inject: [CLOCK],
      useFactory: (clock: Clock) => new InMemoryRateLimiter(clock),
    },
    RateLimitGuard,
    {
      provide: EVENT_PUBLISHER,
      useFactory: (): InProcessEventBus => {
        const logger = new Logger('EventBus');
        return new InProcessEventBus((event: DomainEvent, error: unknown) =>
          logger.error(
            { event: event.name, aggregateId: event.aggregateId, err: error },
            'event subscriber failed',
          ),
        );
      },
    },
  ],
  exports: [
    APP_CONFIG,
    CLOCK,
    ID_GENERATOR,
    EVENT_PUBLISHER,
    AUDIT_LOG,
    RATE_LIMITER,
    RateLimitGuard,
  ],
})
export class PlatformModule {}

export type { AppConfig };
