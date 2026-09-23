import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { Page, PageRequest } from '../../../shared';
import { AccountStatuses } from '../domain/account-status';
import type { LoginIdentifier } from '../domain/login-identifier';
import type { CreateUserOutcome, UserRepository } from '../domain/ports';
import type { RoleCode } from '../domain/role';
import type { RoleAssignment, User, UserId } from '../domain/user';
import { isUniqueViolation } from './postgres-errors';
import { userIdentifiers, userRoles, users } from './schema';

type UserRow = typeof users.$inferSelect;

/** The identifier PK is what makes an identifier belong to at most one account. */
const IDENTIFIER_UNIQUE = 'user_identifiers_kind_value_pk';

/**
 * Accounts in Postgres.
 *
 * Implements the same port as the in-memory repository, which is what lets
 * every use-case test run without a database. `save` writes role and
 * identifier changes as diffs, so an unrelated update (a password change)
 * never rewrites when and by whom a role was granted.
 */
@Injectable()
export class DrizzleUserRepository implements UserRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: UserId): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : ((await this.hydrate([row]))[0] ?? null);
  }

  async findByIdentifier(identifier: LoginIdentifier): Promise<User | null> {
    const rows = await this.db
      .select({ user: users })
      .from(userIdentifiers)
      .innerJoin(users, eq(users.id, userIdentifiers.userId))
      .where(
        and(eq(userIdentifiers.kind, identifier.kind), eq(userIdentifiers.value, identifier.value)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : ((await this.hydrate([row.user]))[0] ?? null);
  }

  async create(user: User): Promise<CreateUserOutcome> {
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: user.id,
          displayName: user.displayName,
          status: user.status,
          passwordHash: user.passwordHash,
          passwordChangedAt: user.passwordChangedAt,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        });
        await tx.insert(userIdentifiers).values(
          user.identifiers.map((identifier) => ({
            userId: user.id,
            kind: identifier.kind,
            value: identifier.value,
            createdAt: user.createdAt,
          })),
        );
        if (user.roles.length > 0) {
          await tx
            .insert(userRoles)
            .values(user.roles.map((assignment) => toRoleRow(user.id, assignment)));
        }
      });
      return 'created';
    } catch (error) {
      if (isUniqueViolation(error, IDENTIFIER_UNIQUE)) return 'identifier_taken';
      throw error;
    }
  }

  async save(user: User): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          displayName: user.displayName,
          status: user.status,
          passwordHash: user.passwordHash,
          passwordChangedAt: user.passwordChangedAt,
          updatedAt: user.updatedAt,
        })
        .where(eq(users.id, user.id));

      const heldRoles = await tx
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, user.id));
      const held = new Set(heldRoles.map((row) => row.role));
      const wanted = new Set(user.roles.map((assignment) => assignment.role));

      const removed = [...held].filter((role) => !wanted.has(role));
      if (removed.length > 0) {
        await tx
          .delete(userRoles)
          .where(and(eq(userRoles.userId, user.id), inArray(userRoles.role, removed)));
      }
      const added = user.roles.filter((assignment) => !held.has(assignment.role));
      if (added.length > 0) {
        await tx
          .insert(userRoles)
          .values(added.map((assignment) => toRoleRow(user.id, assignment)));
      }

      const heldIdentifiers = await tx
        .select({ kind: userIdentifiers.kind, value: userIdentifiers.value })
        .from(userIdentifiers)
        .where(eq(userIdentifiers.userId, user.id));
      const key = (i: { kind: string; value: string }) => `${i.kind}\u0000${i.value}`;
      const wantedIdentifiers = new Set(user.identifiers.map(key));
      const heldKeys = new Set(heldIdentifiers.map(key));

      for (const stale of heldIdentifiers.filter((i) => !wantedIdentifiers.has(key(i)))) {
        await tx
          .delete(userIdentifiers)
          .where(and(eq(userIdentifiers.kind, stale.kind), eq(userIdentifiers.value, stale.value)));
      }
      const fresh = user.identifiers.filter((i) => !heldKeys.has(key(i)));
      if (fresh.length > 0) {
        await tx.insert(userIdentifiers).values(
          fresh.map((identifier) => ({
            userId: user.id,
            kind: identifier.kind,
            value: identifier.value,
            createdAt: user.updatedAt,
          })),
        );
      }
    });
  }

  /**
   * Keyset pagination by (created_at, id): stable under concurrent inserts and
   * constant-cost at any depth, unlike OFFSET.
   */
  async list(page: PageRequest): Promise<Page<User>> {
    const cursor = decodeCursor(page.cursor);
    const rows = await this.db
      .select()
      .from(users)
      .where(
        cursor === null
          ? undefined
          : or(
              gt(users.createdAt, cursor.createdAt),
              and(eq(users.createdAt, cursor.createdAt), gt(users.id, cursor.id)),
            ),
      )
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(page.limit + 1);

    const pageRows = rows.slice(0, page.limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: await this.hydrate(pageRows),
      nextCursor:
        rows.length > page.limit && last !== undefined
          ? encodeCursor(last.createdAt, last.id)
          : undefined,
    };
  }

  async anyActiveWithRole(role: RoleCode): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.role, role), eq(users.status, AccountStatuses.active)))
      .limit(1);
    return rows.length > 0;
  }

  /** Loads identifiers and roles for many users in two queries, not 2 × N. */
  private async hydrate(rows: readonly UserRow[]): Promise<User[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);

    const [identifierRows, roleRows] = await Promise.all([
      this.db.select().from(userIdentifiers).where(inArray(userIdentifiers.userId, ids)),
      this.db
        .select()
        .from(userRoles)
        .where(inArray(userRoles.userId, ids))
        .orderBy(asc(userRoles.grantedAt), asc(userRoles.role)),
    ]);

    return rows.map((row) => ({
      id: row.id as UserId,
      displayName: row.displayName,
      status: row.status,
      identifiers: identifierRows
        .filter((identifier) => identifier.userId === row.id)
        .map(({ kind, value }) => ({ kind, value })),
      roles: roleRows
        .filter((assignment) => assignment.userId === row.id)
        .map(({ role, grantedAt, grantedBy }) => ({ role, grantedAt, grantedBy })),
      passwordHash: row.passwordHash,
      passwordChangedAt: row.passwordChangedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}

function toRoleRow(userId: string, assignment: RoleAssignment) {
  return {
    userId,
    role: assignment.role,
    grantedAt: assignment.grantedAt,
    grantedBy: assignment.grantedBy,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

/** A malformed cursor reads as "from the start" rather than an error. */
function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
      return null;
    }
    const createdAt = new Date(parsed[0]);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: parsed[1] };
  } catch {
    return null;
  }
}
