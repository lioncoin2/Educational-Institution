import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { AuthController } from './api/auth.controller';
import { AuthenticationGuard } from './api/guards/authentication.guard';
import { PermissionGuard } from './api/guards/permission.guard';
import { AuthenticateUseCase } from './application/authenticate.use-case';
import { POLICY_RULES, PolicyAuthorizationService } from './application/authorization.service';
import { LoginUseCase } from './application/login.use-case';
import { AUTHORIZATION_SERVICE } from './contracts';
import type { PolicyRule } from './domain/policy';
import { PASSWORD_HASHER, TOKEN_ISSUER, USER_REPOSITORY } from './domain/ports';
import { DrizzleUserRepository } from './infrastructure/drizzle-user-repository';
import { InMemoryUserRepository } from './infrastructure/in-memory-user-repository';
import { JwtTokenIssuer } from './infrastructure/jwt-token-issuer';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher';

/**
 * Identity & Access — the composition root for authentication and authorization.
 *
 * This module is the only one that knows how a permission is decided. It exports
 * `AUTHORIZATION_SERVICE` (a port from `contracts/`), which is the sole way any
 * other module asks an access question.
 *
 * The user store is chosen here and nowhere else: Postgres when a database is
 * configured, in-memory otherwise. Both satisfy the same `UserRepository` port,
 * so no use case and no test can tell which is in play.
 *
 * Deliberately NOT included: any seeded account. The system ships with no
 * default credentials — see docs/architecture/open-questions.md (Q2).
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.auth.jwtSecret,
        signOptions: { algorithm: 'HS256' as const },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: USER_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database) =>
        // Falling back to the in-memory store keeps `npm run start:dev` working
        // with no Postgres running, and makes the absence obvious rather than
        // producing connection errors on the first login attempt.
        config.database.configured ? new DrizzleUserRepository(db) : new InMemoryUserRepository(),
    },
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenIssuer },
    {
      // Resource-scoped rules are registered here. Empty by default: every rule
      // encodes an institutional policy, and none has been confirmed yet.
      provide: POLICY_RULES,
      useValue: [] as readonly PolicyRule[],
    },
    { provide: AUTHORIZATION_SERVICE, useClass: PolicyAuthorizationService },
    AuthenticateUseCase,
    LoginUseCase,
    AuthenticationGuard,
    PermissionGuard,
    // Registered globally here, inside the module that owns access control, so
    // the application root never has to reach into identity's internals.
    // Order matters: resolve the principal, then decide.
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },
  ],
  exports: [AUTHORIZATION_SERVICE, AuthenticationGuard, PermissionGuard],
})
export class IdentityModule {}
