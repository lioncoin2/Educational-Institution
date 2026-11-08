import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { Device, DeviceId, DeviceRegistration } from '../domain/device';
import type { DeviceRepository } from '../domain/ports';
import { notificationDevices } from './schema';

type Row = typeof notificationDevices.$inferSelect;

/**
 * The class key of notifications' per-session advisory locks, in the two-key
 * form `pg_advisory_xact_lock(class, hashtext(<session id>))` — a key space no
 * other module's locks share. ("Ntfy", as an int4.)
 */
const SESSION_LOCK_CLASS = 1_316_251_257;

/**
 * Devices in Postgres. The token is written and read here, and handed only
 * to the push provider; nothing in this file logs.
 */
@Injectable()
export class DrizzleDeviceRepository implements DeviceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async register(input: {
    readonly id: DeviceId;
    readonly userId: string;
    readonly sessionId: string;
    readonly registration: DeviceRegistration;
    readonly at: Date;
  }): Promise<{
    readonly device: Device;
    readonly previousUserId: string | null;
    readonly superseded: readonly Device[];
  }> {
    const { provider, platform, token } = input.registration;
    return this.db.transaction(async (tx) => {
      // One registration per session at a time — a lock on the session, not
      // its rows, which may not exist yet: two tokens registered at once
      // through one session (a token refreshed mid-registration) would
      // otherwise both insert, each blind to the other's uncommitted row.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${SESSION_LOCK_CLASS}::int4, hashtext(${input.sessionId}))`,
      );
      // Whose it was, if anyone's — locked, so a concurrent registration of
      // the same token waits and then sees this one's outcome.
      const [previous] = await tx
        .select({ userId: notificationDevices.userId })
        .from(notificationDevices)
        .where(
          and(eq(notificationDevices.provider, provider), eq(notificationDevices.token, token)),
        )
        .for('update');
      const [row] = await tx
        .insert(notificationDevices)
        .values({
          id: input.id,
          userId: input.userId,
          platform,
          provider,
          token,
          createdAt: input.at,
          lastSeenAt: input.at,
          disabledAt: null,
          sessionId: input.sessionId,
        })
        .onConflictDoUpdate({
          target: [notificationDevices.provider, notificationDevices.token],
          // The row keeps its id, so the app's handle stays valid across
          // registrations; it moves to whoever is signed in on the device now,
          // and to the session they are signed in through (ADR 0058) — a row
          // left on an ended session would be removed at the next push.
          set: {
            userId: input.userId,
            platform,
            lastSeenAt: sql`greatest(${notificationDevices.lastSeenAt}, ${input.at.toISOString()}::timestamptz)`,
            disabledAt: null,
            sessionId: input.sessionId,
          },
        })
        .returning();
      if (row === undefined) throw new Error('device registration returned no row');
      // One push row per session: an older token of this installation (a
      // refreshed token) would otherwise announce everything twice.
      const superseded = await tx
        .delete(notificationDevices)
        .where(
          and(
            eq(notificationDevices.sessionId, input.sessionId),
            ne(notificationDevices.id, row.id),
          ),
        )
        .returning();
      const previousUserId =
        previous === undefined || previous.userId === input.userId ? null : previous.userId;
      return { device: toDevice(row), previousUserId, superseded: superseded.map(toDevice) };
    });
  }

  async removeIfSession(id: DeviceId, sessionId: string | null): Promise<boolean> {
    const removed = await this.db
      .delete(notificationDevices)
      .where(
        and(
          eq(notificationDevices.id, id),
          sessionId === null
            ? isNull(notificationDevices.sessionId)
            : eq(notificationDevices.sessionId, sessionId),
        ),
      )
      .returning({ id: notificationDevices.id });
    return removed.length > 0;
  }

  async find(userId: string, id: string): Promise<Device | null> {
    const [row] = await this.db
      .select()
      .from(notificationDevices)
      .where(and(eq(notificationDevices.userId, userId), eq(notificationDevices.id, id)))
      .limit(1);
    return row === undefined ? null : toDevice(row);
  }

  async remove(userId: string, id: string): Promise<Device | null> {
    const [row] = await this.db
      .delete(notificationDevices)
      .where(and(eq(notificationDevices.userId, userId), eq(notificationDevices.id, id)))
      .returning();
    return row === undefined ? null : toDevice(row);
  }

  async trim(userId: string, max: number): Promise<readonly Device[]> {
    // A handful of rows per person: read them in order, forget the tail.
    const enabled = await this.db
      .select()
      .from(notificationDevices)
      .where(and(eq(notificationDevices.userId, userId), isNull(notificationDevices.disabledAt)))
      .orderBy(desc(notificationDevices.lastSeenAt), desc(notificationDevices.id));
    const stale = enabled.slice(max);
    if (stale.length === 0) return [];
    const removed = await this.db
      .delete(notificationDevices)
      .where(
        and(
          eq(notificationDevices.userId, userId),
          inArray(
            notificationDevices.id,
            stale.map((row) => row.id),
          ),
        ),
      )
      .returning();
    return removed.map(toDevice);
  }

  async enabledForUsers(userIds: readonly string[]): Promise<readonly Device[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(notificationDevices)
      .where(
        and(
          inArray(notificationDevices.userId, [...new Set(userIds)]),
          isNull(notificationDevices.disabledAt),
        ),
      );
    return rows.map(toDevice);
  }

  async disable(id: DeviceId, at: Date): Promise<void> {
    await this.db
      .update(notificationDevices)
      .set({ disabledAt: at })
      .where(and(eq(notificationDevices.id, id), isNull(notificationDevices.disabledAt)));
  }
}

function toDevice(row: Row): Device {
  return {
    id: row.id as DeviceId,
    userId: row.userId,
    platform: row.platform,
    provider: row.provider,
    token: row.token,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    disabledAt: row.disabledAt,
    sessionId: row.sessionId,
  };
}
