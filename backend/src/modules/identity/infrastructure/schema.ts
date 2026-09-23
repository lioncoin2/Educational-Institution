import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import type { AccountStatus } from '../domain/account-status';
import type { DevicePlatform, RevocationReason } from '../domain/auth-session';
import type { IdentifierKind } from '../domain/login-identifier';

/**
 * Identity's tables. Identity owns them; no other module may read them — other
 * modules ask identity's contracts instead (enforced by dependency-cruiser:
 * this file is under `infrastructure/`, which is private to the module).
 *
 * Status and platform columns are text + CHECK rather than Postgres enums:
 * widening a CHECK is a cheap re-validation, whereas altering an enum type is a
 * locking migration. The TypeScript unions remain the authoritative lists.
 */

/** The runtime role catalogue. Assignments are validated against this, not against code. */
export const roles = pgTable(
  'roles',
  {
    code: text('code').primaryKey(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('roles_code_shape', sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`)],
);

/** Seeded from the permission catalogue in code; a test keeps the two equal. */
export const permissions = pgTable(
  'permissions',
  {
    code: text('code').primaryKey(),
    description: text('description').notNull(),
  },
  (table) => [check('permissions_code_shape', sql`${table.code} ~ '^[a-z]+[.][a-z_]+$'`)],
);

/** The role → permission matrix — the policy that runs. Currently provisional (Q1). */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleCode: text('role_code')
      .notNull()
      .references(() => roles.code, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.roleCode, table.permissionCode] })],
);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    status: text('status').$type<AccountStatus>().notNull().default('PENDING'),
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'users_status_valid',
      sql`${table.status} in ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED')`,
    ),
  ],
);

/**
 * What a person types to sign in. The primary key on (kind, value) is the
 * uniqueness guarantee: an identifier belongs to at most one account. Values
 * are stored normalized by the domain, so the guarantee is case-insensitive.
 */
export const userIdentifiers = pgTable(
  'user_identifiers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<IdentifierKind>().notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.value] }),
    // Loading an account's identifiers by user id — not covered by the PK.
    index('user_identifiers_user_id_idx').on(table.userId),
    check('user_identifiers_kind_valid', sql`${table.kind} in ('email')`),
    check('user_identifiers_value_present', sql`length(${table.value}) > 0`),
  ],
);

/**
 * Role assignment. A join table rather than an array column because each
 * assignment carries who granted it and when. The FK to `roles` means only a
 * role that exists at runtime can be held.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role')
      .notNull()
      // RESTRICT: a role that people hold cannot be deleted out from under them.
      .references(() => roles.code, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null for provisioning. Not a FK: attribution must survive the granter's deletion. */
    grantedBy: text('granted_by'),
  },
  (table) => [
    // (user_id, role) also serves lookups by user_id — no separate index needed.
    primaryKey({ columns: [table.userId, table.role] }),
    // "Who holds this role?" — owner bootstrap, and future admin listings.
    index('user_roles_role_idx').on(table.role),
  ],
);

/**
 * One row per signed-in device. Holds hashes of the current and previous
 * refresh token — never a raw token. See docs/architecture/session-management.md.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    previousRefreshTokenHash: text('previous_refresh_token_hash'),
    generation: integer('generation').notNull().default(0),
    devicePlatform: text('device_platform').$type<DevicePlatform>().notNull().default('unknown'),
    deviceLabel: text('device_label'),
    appVersion: text('app_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason').$type<RevocationReason>(),
  },
  (table) => [
    // Listing and ending a user's live sessions; revoked rows are never scanned.
    index('auth_sessions_user_live_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
    check(
      'auth_sessions_platform_valid',
      sql`${table.devicePlatform} in ('ios', 'android', 'web', 'unknown')`,
    ),
    check(
      'auth_sessions_revocation_consistent',
      sql`(${table.revokedAt} is null) = (${table.revokedReason} is null)`,
    ),
    check(
      'auth_sessions_reason_valid',
      sql`${table.revokedReason} is null or ${table.revokedReason} in ('logout', 'revoked_by_user', 'revoked_by_admin', 'refresh_token_reuse', 'password_changed', 'password_reset', 'account_suspended', 'account_disabled', 'account_inactive')`,
    ),
    check('auth_sessions_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    check('auth_sessions_generation_nonnegative', sql`${table.generation} >= 0`),
  ],
);
