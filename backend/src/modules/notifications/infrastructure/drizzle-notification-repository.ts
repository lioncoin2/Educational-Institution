import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import {
  isNotificationType,
  parseParams,
  parseTarget,
  type Notification,
  type NotificationId,
} from '../domain/notification';
import type { NotificationCursor, NotificationRepository } from '../domain/ports';
import { notifications } from './schema';

type Row = typeof notifications.$inferSelect;

/**
 * Notifications in Postgres. Each operation is a bounded number of index
 * scans of ONE recipient's rows, whatever the size of the table:
 *
 *   insert        one multi-row INSERT … ON CONFLICT DO NOTHING RETURNING id —
 *                 the unique constraint, not a prior SELECT, decides what is
 *                 new, so two concurrent deliveries of one fact store one row
 *   list          a range scan of (recipient, created_at desc, id desc)
 *   unread count  the partial unread index, stopped at the cap
 *   mark all      chunks of the partial unread index, each its own statement
 *
 * No OFFSET: every page starts from a key, so page 1000 costs what page 1 does.
 */
@Injectable()
export class DrizzleNotificationRepository implements NotificationRepository {
  private readonly logger = new Logger(DrizzleNotificationRepository.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insertMany(batch: readonly Notification[]): Promise<readonly Notification[]> {
    if (batch.length === 0) return [];
    const inserted = await this.db
      .insert(notifications)
      .values(batch.map(toRow))
      .onConflictDoNothing({ target: [notifications.recipientUserId, notifications.dedupeKey] })
      .returning({ id: notifications.id });
    const created = new Set(inserted.map((row) => row.id));
    return batch.filter((notification) => created.has(notification.id));
  }

  async list(
    recipientUserId: string,
    page: { readonly limit: number; readonly after?: NotificationCursor },
  ) {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientUserId, recipientUserId),
          page.after === undefined ? undefined : before(page.after),
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(page.limit + 1);
    const items = this.fromRows(rows.slice(0, page.limit));
    const last = rows.length > page.limit ? rows[page.limit - 1] : undefined;
    return {
      items,
      next: last === undefined ? null : { createdAt: last.createdAt, id: last.id },
    };
  }

  async countUnread(recipientUserId: string, cap: number): Promise<number> {
    const result = await this.db.execute(sql`
      select count(*)::int as count from (
        select 1 from ${notifications}
        where ${notifications.recipientUserId} = ${recipientUserId}
          and ${notifications.readAt} is null
        limit ${cap}
      ) capped
    `);
    return Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
  }

  async find(recipientUserId: string, id: string): Promise<Notification | null> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.recipientUserId, recipientUserId), eq(notifications.id, id)))
      .limit(1);
    return this.fromRows(rows)[0] ?? null;
  }

  async markRead(recipientUserId: string, id: string, at: Date) {
    const updated = await this.db
      .update(notifications)
      // Never before its own creation, whatever another instance's clock says.
      .set({ readAt: sql`greatest(${notifications.createdAt}, ${at.toISOString()}::timestamptz)` })
      .where(
        and(
          eq(notifications.recipientUserId, recipientUserId),
          eq(notifications.id, id),
          isNull(notifications.readAt),
        ),
      )
      .returning();
    const changed = this.fromRows(updated)[0];
    if (changed !== undefined) return { notification: changed, changed: true };
    const existing = await this.find(recipientUserId, id);
    return existing === null ? null : { notification: existing, changed: false };
  }

  async markReadThrough(
    recipientUserId: string,
    through: { readonly createdAt: Date; readonly id: string | null },
    at: Date,
    limit: number,
  ): Promise<number> {
    const boundary =
      through.id === null
        ? sql`${notifications.createdAt} <= ${through.createdAt.toISOString()}::timestamptz`
        : sql`(${notifications.createdAt}, ${notifications.id}) <= (${through.createdAt.toISOString()}::timestamptz, ${through.id})`;
    // One chunk: the unread index gives the candidates, and `read_at is null`
    // is checked again on the rows themselves, so a notification read
    // concurrently is neither re-stamped nor counted twice.
    const result = await this.db.execute(sql`
      update ${notifications}
      set read_at = greatest(created_at, ${at.toISOString()}::timestamptz)
      where read_at is null and id in (
        select id from ${notifications}
        where ${notifications.recipientUserId} = ${recipientUserId}
          and ${notifications.readAt} is null
          and ${boundary}
        order by ${notifications.createdAt} desc, ${notifications.id} desc
        limit ${limit}
      )
    `);
    return result.rowCount ?? 0;
  }

  async findByIds(ids: readonly string[]): Promise<readonly Notification[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(notifications)
      .where(inArray(notifications.id, [...ids]));
    return this.fromRows(rows);
  }

  /**
   * Stored rows back into notifications. A row this version cannot read — a
   * target kind from a newer release, after a rollback — is left out and
   * logged, rather than served half-understood.
   */
  private fromRows(rows: readonly Row[]): Notification[] {
    return rows.flatMap((row) => {
      const notification = fromRow(row);
      if (notification === null) {
        this.logger.warn({ notificationId: row.id, type: row.type }, 'unreadable notification row');
        return [];
      }
      return [notification];
    });
  }
}

/** Strictly after the cursor, in newest-first order. */
function before(cursor: NotificationCursor) {
  return sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id})`;
}

function toRow(notification: Notification): typeof notifications.$inferInsert {
  return {
    id: notification.id,
    recipientUserId: notification.recipientUserId,
    type: notification.type,
    category: notification.category,
    titleKey: notification.titleKey,
    bodyKey: notification.bodyKey,
    params: { ...notification.params },
    target: { ...notification.target },
    dedupeKey: notification.dedupeKey,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  };
}

function fromRow(row: Row): Notification | null {
  const target = parseTarget(row.target);
  const params = parseParams(row.params);
  if (target === null || params === null || !isNotificationType(row.type)) return null;
  return {
    id: row.id as NotificationId,
    recipientUserId: row.recipientUserId,
    type: row.type,
    category: row.category,
    titleKey: row.titleKey,
    bodyKey: row.bodyKey,
    params,
    target,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}
