import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { AdminUsersController } from './api/admin-users.controller';
import { AuthController } from './api/auth.controller';
import { AccessGuard } from './api/guards/access.guard';
import { IdentityAccountDirectory } from './application/account-directory.service';
import { AccountAdministration } from './application/admin/account-administration';
import { ChangeAccountStatusUseCase } from './application/admin/account-status.use-case';
import { CreateUserUseCase } from './application/admin/create-user.use-case';
import { ResetPasswordUseCase } from './application/admin/password-reset.use-case';
import { GetUserUseCase, ListUsersUseCase } from './application/admin/read-users.use-cases';
import {
  AssignRoleUseCase,
  RevokeRoleUseCase,
} from './application/admin/role-assignment.use-cases';
import { RevokeUserSessionsUseCase } from './application/admin/user-sessions.use-case';
import { POLICY_RULES, PolicyAuthorizationService } from './application/authorization.service';
import { BootstrapOwnerUseCase } from './application/bootstrap-owner.use-case';
import { ChangeMyPasswordUseCase } from './application/change-password.use-case';
import { GetCurrentUserUseCase } from './application/current-user.use-case';
import { IDENTITY_SETTINGS, type IdentitySettings } from './application/identity-settings';
import { LoginUseCase } from './application/login.use-case';
import { RefreshSessionUseCase } from './application/refresh-session.use-case';
import { ResolvePrincipalUseCase } from './application/resolve-principal.use-case';
import { RolePermissions } from './application/role-permissions';
import {
  ListMySessionsUseCase,
  LogoutUseCase,
  RevokeMySessionUseCase,
} from './application/session-management.use-cases';
import { ACCOUNT_DIRECTORY } from './contracts/account-directory';
import { AUTHORIZATION_SERVICE } from './contracts/authorization';
import {
  AUTH_SESSION_REPOSITORY,
  PASSWORD_HASHER,
  ROLE_CATALOG,
  SECURE_TOKEN_GENERATOR,
  TOKEN_ISSUER,
  USER_REPOSITORY,
  type AuthSessionRepository,
  type RoleCatalog,
  type UserRepository,
} from './domain/ports';
import { PROVISIONAL_POLICY_RULES } from './domain/provisional-policy';
import { CryptoSecureTokenGenerator } from './infrastructure/crypto-secure-token-generator';
import { DrizzleAuthSessionRepository } from './infrastructure/drizzle-auth-session-repository';
import { DrizzleRoleCatalog } from './infrastructure/drizzle-role-catalog';
import { DrizzleUserRepository } from './infrastructure/drizzle-user-repository';
import {
  InMemoryAuthSessionRepository,
  InMemoryRoleCatalog,
  InMemoryUserRepository,
} from './infrastructure/in-memory-identity-store';
import {
  ACCESS_TOKEN_SETTINGS,
  JwtTokenIssuer,
  type AccessTokenSettings,
} from './infrastructure/jwt-token-issuer';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher';

/** Postgres when a database is configured; memory otherwise. Same ports either way. */
function persistent<T>(
  config: AppConfig,
  db: Database,
  drizzle: (db: Database) => T,
  memory: () => T,
): T {
  return config.database.configured ? drizzle(db) : memory();
}

/**
 * Identity & Access — the composition root.
 *
 * It exports exactly two things: `AUTHORIZATION_SERVICE`, the only way any
 * other module asks an access question, and `ACCOUNT_DIRECTORY`, the only way
 * one learns who an account is (id, display name, active). Everything else —
 * users, sessions, tokens, the role matrix — is private to this module.
 *
 * No account is seeded and no default credential exists. The first owner is
 * created with `npm run identity:bootstrap-owner` (see backend/README.md).
 */
@Module({
  // No defaults: the token issuer passes every option explicitly, so all of the
  // access-token policy is visible in one file.
  imports: [JwtModule.register({})],
  controllers: [AuthController, AdminUsersController],
  providers: [
    {
      provide: IDENTITY_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): IdentitySettings => ({
        refreshSessionTtlSeconds: config.auth.refreshSessionTtlSeconds,
        rolePolicyCacheSeconds: config.auth.rolePolicyCacheSeconds,
      }),
    },
    {
      provide: ACCESS_TOKEN_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AccessTokenSettings => ({
        secret: config.auth.jwtSecret,
        issuer: config.auth.jwtIssuer,
        audience: config.auth.jwtAudience,
        ttlSeconds: config.auth.accessTtlSeconds,
      }),
    },
    {
      provide: USER_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database) =>
        persistent<UserRepository>(
          config,
          db,
          (d) => new DrizzleUserRepository(d),
          () => new InMemoryUserRepository(),
        ),
    },
    {
      provide: AUTH_SESSION_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database) =>
        persistent<AuthSessionRepository>(
          config,
          db,
          (d) => new DrizzleAuthSessionRepository(d),
          () => new InMemoryAuthSessionRepository(),
        ),
    },
    {
      provide: ROLE_CATALOG,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database) =>
        persistent<RoleCatalog>(
          config,
          db,
          (d) => new DrizzleRoleCatalog(d),
          () => new InMemoryRoleCatalog(),
        ),
    },
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenIssuer },
    { provide: SECURE_TOKEN_GENERATOR, useClass: CryptoSecureTokenGenerator },
    // PROVISIONAL: every rule here is unconfirmed institutional policy (Q1).
    { provide: POLICY_RULES, useValue: PROVISIONAL_POLICY_RULES },
    { provide: AUTHORIZATION_SERVICE, useClass: PolicyAuthorizationService },
    { provide: ACCOUNT_DIRECTORY, useClass: IdentityAccountDirectory },

    RolePermissions,
    AccountAdministration,
    ResolvePrincipalUseCase,
    LoginUseCase,
    RefreshSessionUseCase,
    LogoutUseCase,
    ListMySessionsUseCase,
    RevokeMySessionUseCase,
    GetCurrentUserUseCase,
    ChangeMyPasswordUseCase,
    CreateUserUseCase,
    AssignRoleUseCase,
    RevokeRoleUseCase,
    ChangeAccountStatusUseCase,
    ResetPasswordUseCase,
    RevokeUserSessionsUseCase,
    ListUsersUseCase,
    GetUserUseCase,
    BootstrapOwnerUseCase,

    AccessGuard,
    // Registered here, inside the module that owns access control, so the
    // application root never reaches into identity's internals.
    { provide: APP_GUARD, useExisting: AccessGuard },
  ],
  exports: [AUTHORIZATION_SERVICE, ACCOUNT_DIRECTORY],
})
export class IdentityModule {}
