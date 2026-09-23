import { randomUUID } from 'node:crypto';

import { Global, Logger, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';

import { AUDIT_LOG, type DomainEvent } from '../shared';
import { LoggingAuditLog } from './audit/logging-audit-log';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/app-config';
import { EVENT_PUBLISHER, InProcessEventBus } from './events/event-bus';
import { HealthController } from './health/health.controller';
import { CLOCK, SystemClock } from './primitives/system-clock';
import { ID_GENERATOR, UuidIdGenerator } from './primitives/uuid-id-generator';

const config = loadConfig();

/**
 * The technical substrate every module stands on: configuration, logging,
 * time, identifiers and the event bus.
 *
 * Platform knows nothing about business modules — that rule is enforced by
 * dependency-cruiser and is what keeps a module extractable later.
 */
@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.logLevel,
        // Correlates every log line of one request; also returned on errors.
        genReqId: (req: IncomingMessage) =>
          (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        // Secrets must never reach a log sink.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            '*.jwtSecret',
            '*.apiSecret',
            '*.password',
            '*.token',
          ],
          censor: '[redacted]',
        },
      },
    }),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: CLOCK, useClass: SystemClock },
    { provide: AUDIT_LOG, useClass: LoggingAuditLog },
    { provide: ID_GENERATOR, useClass: UuidIdGenerator },
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
  exports: [APP_CONFIG, CLOCK, ID_GENERATOR, EVENT_PUBLISHER, AUDIT_LOG],
})
export class PlatformModule {}

export type { AppConfig };
