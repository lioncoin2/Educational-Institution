import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

import type { AppConfig } from '../config/app-config';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Everything about how the HTTP application behaves, in one place — so the
 * server and the API tests run exactly the same configuration. A test suite
 * that builds its own ValidationPipe is testing a different application.
 */
export function configureApp(app: INestApplication, config: AppConfig): void {
  (app as NestExpressApplication).set('trust proxy', config.http.trustProxy);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip unknown properties…
      forbidNonWhitelisted: true, // …and reject requests that send them.
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}
