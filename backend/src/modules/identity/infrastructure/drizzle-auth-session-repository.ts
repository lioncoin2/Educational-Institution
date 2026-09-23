import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { AuthSession, AuthSessionId, RevocationReason } from '../domain/auth-session';
import type { AuthSessionRepository } from '../domain/ports';
import type { UserId } from '../domain/user';
import { authSessions } from './schema';

type SessionRow = typeof authSessions.$inferSelect;

/**
 * Sessions in Postgres.
 *
 * Rotation and revocation are single conditional UPDATEs, so their guarantees
 * come from the database rather than from a read-then-write in application
 * code: two refreshes racing on one token cannot both win, and a revoked
 * session can never be rotated back to life.
 */
@Injectable()
export class DrizzleAuthSessionRepository implements AuthSessionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: AuthSessionId): Promise<AuthSession | null> {
    const rows = await this.db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toSession(row);
  }

  async create(session: AuthSession): Promise<void> {
    await this.db.insert(authSessions).values({
      id: session.id,
      userId: session.userId,
      refreshTokenHash: session.refreshTokenHash,
      previousRefreshTokenHash: session.previousRefreshTokenHash,
      generation: session.generation,
      devicePlatform: session.device.platform,
      deviceLabel: session.device.label,
      appVersion: session.device.appVersion,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      revokedReason: session.revokedReason,
    });
  }

  async rotate(next: AuthSession, expectedHash: string): Promise<boolean> {
    const updated = await this.db
      .update(authSessions)
      .set({
        refreshTokenHash: next.refreshTokenHash,
        previousRefreshTokenHash: next.previousRefreshTokenHash,
        generation: next.generation,
        lastUsedAt: next.lastUsedAt,
      })
      .where(
        and(
          eq(authSessions.id, next.id),
          eq(authSessions.refreshTokenHash, expectedHash),
          isNull(authSessions.revokedAt),
        ),
      )
      .returning({ id: authSessions.id });
    return updated.length === 1;
  }

  async revoke(id: AuthSessionId, reason: RevocationReason, at: Date): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: at, revokedReason: reason })
      .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)));
  }

  async revokeAllForUser(
    userId: UserId,
    reason: RevocationReason,
    at: Date,
    except?: AuthSessionId,
  ): Promise<number> {
    const revoked = await this.db
      .update(authSessions)
      .set({ revokedAt: at, revokedReason: reason })
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, at),
          except === undefined ? undefined : ne(authSessions.id, except),
        ),
      )
      .returning({ id: authSessions.id });
    return revoked.length;
  }

  async listActiveForUser(userId: UserId, now: Date): Promise<readonly AuthSession[]> {
    const rows = await this.db
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .orderBy(desc(authSessions.lastUsedAt));
    return rows.map(toSession);
  }
}

function toSession(row: SessionRow): AuthSession {
  return {
    id: row.id as AuthSessionId,
    userId: row.userId as UserId,
    device: { platform: row.devicePlatform, label: row.deviceLabel, appVersion: row.appVersion },
    refreshTokenHash: row.refreshTokenHash,
    previousRefreshTokenHash: row.previousRefreshTokenHash,
    generation: row.generation,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  };
}
