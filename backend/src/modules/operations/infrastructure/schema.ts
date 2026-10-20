import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import type { LessonStatus } from '../domain/lesson';

/**
 * Scheduled lessons. The wall-clock the lesson was entered as (`local_date` +
 * `local_time`) and the IANA `timezone` captured at creation are stored
 * alongside the resolved `scheduled_at` instant — so a later institution-
 * timezone change never moves an existing lesson. Account/halaqa ids are opaque
 * `text` (no cross-module foreign keys, as everywhere). Cancellation is a
 * status transition with its own audit columns, never a delete.
 */
export const operationsLessons = pgTable(
  'operations_lessons',
  {
    id: text('id').primaryKey(),
    halaqaId: text('halaqa_id').notNull(),
    title: text('title'),
    localDate: text('local_date').notNull(),
    localTime: text('local_time').notNull(),
    timezone: text('timezone').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    status: text('status').$type<LessonStatus>().notNull(),
    clientRequestId: text('client_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by'),
  },
  (table) => [
    check('operations_lessons_status_valid', sql`${table.status} in ('SCHEDULED', 'CANCELLED')`),
    check(
      'operations_lessons_local_date_shape',
      sql`${table.localDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    check(
      'operations_lessons_local_time_shape',
      sql`${table.localTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    // CANCELLED iff both audit columns are set; SCHEDULED iff both are null.
    check(
      'operations_lessons_cancelled_consistent',
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} is not null and ${table.cancelledBy} is not null)`,
    ),
    check(
      'operations_lessons_updated_after_created',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    index('operations_lessons_by_schedule').on(table.scheduledAt, table.id),
    index('operations_lessons_by_halaqa_schedule').on(table.halaqaId, table.scheduledAt, table.id),
    // Idempotency: one lesson per (creator, client request id) when a key is given.
    uniqueIndex('operations_lessons_client_request_unique')
      .on(table.createdBy, table.clientRequestId)
      .where(sql`${table.clientRequestId} is not null`),
  ],
);
