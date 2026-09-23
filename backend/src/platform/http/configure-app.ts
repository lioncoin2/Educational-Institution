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

  // Browsers only: an explicit allow-list, or nothing. Credentials travel as a
  // bearer header, never a cookie, so no origin is ever allowed credentials.
  if (config.http.corsOrigins.length > 0) {
    app.enableCors({
      origin: [...config.http.corsOrigins],
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['authorization', 'content-type', 'range', 'x-request-id'],
      exposedHeaders: ['content-range', 'content-disposition', 'retry-after', 'x-request-id'],
      credentials: false,
      maxAge: 600,
    });
  }
  app.enableShutdownHooks();
}
