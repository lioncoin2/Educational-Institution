import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import type { UserStatus } from '../domain/user';

/**
 * Identity's tables. Identity owns them; no other module may read them.
 *
 * Schema lives beside the adapter that uses it, rather than in one global file,
 * so table ownership matches module ownership and a module can be extracted
 * with its schema intact. `drizzle.config.ts` collects these by glob.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),

    /**
     * Stored already normalized (trimmed, lower-cased) by the repository, so a
     * plain unique constraint is a true case-insensitive uniqueness guarantee.
     * The alternative — a functional index on `lower(email)` — puts the
     * normalization rule in two places and lets them drift.
     */
    email: text('email').notNull().unique(),

    displayName: text('display_name').notNull(),

    /**
     * A CHECK rather than a Postgres enum. Adding a value to a pg enum is a
     * migration that locks the type; a CHECK constraint is a cheap re-validate,
     * and the authoritative list is the TypeScript union either way.
     */
    status: text('status').$type<UserStatus>().notNull().default('invited'),

    passwordHash: text('password_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('users_status_valid', sql`${table.status} in ('active', 'suspended', 'invited')`),
  ],
);

/**
 * Role assignment. A join table rather than an array column because role
 * changes are audited events — a row can carry who granted it and when, which
 * an array cannot.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null for roles created by provisioning rather than by a person. */
    grantedBy: text('granted_by'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.role] }),
    // Every authenticated request resolves a principal's roles by user id.
    index('user_roles_user_id_idx').on(table.userId),
  ],
);
