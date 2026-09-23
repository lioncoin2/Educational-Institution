import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { UserRepository } from '../domain/ports';
import type { User, UserId } from '../domain/user';
import { userRoles, users } from './schema';

/** Emails are compared case-insensitively, so they are stored normalized. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Postgres-backed users, via Drizzle.
 *
 * It implements exactly the same `UserRepository` port as
 * `InMemoryUserRepository`, which is what lets every use-case test run without
 * a database while production runs against one. Neither the domain nor any use
 * case can tell the difference.
 */
@Injectable()
export class DrizzleUserRepository implements UserRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: UserId): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return this.hydrate(rows[0]);
  }

  async findByEmail(email: string): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1);
    return this.hydrate(rows[0]);
  }

  /**
   * Upsert of the user row plus a full replacement of its roles, in one
   * transaction. Roles are replaced rather than diffed because `User.roles` is
   * the complete intended set — a partial write would leave a user holding a
   * role the caller believed it had removed.
   */
  async save(user: User): Promise<void> {
    const email = normalizeEmail(user.email);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({
          id: user.id,
          email,
          displayName: user.displayName,
          status: user.status,
          passwordHash: user.passwordHash,
          createdAt: user.createdAt,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email,
            displayName: user.displayName,
            status: user.status,
            passwordHash: user.passwordHash,
            updatedAt: new Date(),
          },
        });

      await tx.delete(userRoles).where(eq(userRoles.userId, user.id));
      if (user.roles.length > 0) {
        await tx.insert(userRoles).values(user.roles.map((role) => ({ userId: user.id, role })));
      }
    });
  }

  private async hydrate(row: typeof users.$inferSelect | undefined): Promise<User | null> {
    if (row === undefined) return null;

    const assigned = await this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, row.id));

    return {
      id: row.id as UserId,
      email: row.email,
      displayName: row.displayName,
      status: row.status,
      roles: assigned.map((entry) => entry.role),
      passwordHash: row.passwordHash,
      createdAt: row.createdAt,
    };
  }
}
