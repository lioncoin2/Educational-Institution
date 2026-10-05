import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { SNAPSHOT_CONNECTIONS, type SnapshotConnection } from '../contracts/vocabulary';
import { OBSERVATION_RULE, type ObservationRule } from '../domain/snapshot';

/**
 * Attendance's tables (attendance.md §7). Attendance owns them; no other module
 * reads or writes them, and only `attendance/infrastructure`'s adapters touch
 * them. Every cross-module id (`community_id`, `live_session_id`, `host_user_id`,
 * `recorded_by`, `user_id`) is a plain text id with **no foreign key** — the
 * only FK is in-module, from an entry to its snapshot. Append-only: a snapshot
 * is inserted once, never updated or deleted (§10).
 *
 * The CHECKs mirror the domain exactly, generated from the committed vocabulary
 * so the database and `takeSnapshot` can never drift.
 */
const CONNECTION_LIST = sql.raw(SNAPSHOT_CONNECTIONS.map((value) => `'${value}'`).join(', '));
const OBSERVATION_RULE_LIST = sql.raw(`'${OBSERVATION_RULE}'`);

export const attendanceSnapshots = pgTable(
  'attendance_snapshots',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id').notNull(),
    liveSessionId: text('live_session_id').notNull(),
    hostUserId: text('host_user_id').notNull(),
    recordedBy: text('recorded_by').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    observationRule: text('observation_rule').$type<ObservationRule>().notNull(),
    observationStartedAt: timestamp('observation_started_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    connectedCount: integer('connected_count').notNull(),
    connectingCount: integer('connecting_count').notNull(),
  },
  (table) => [
    // The idempotency key (§8): at most one snapshot per session, recorder and request.
    unique('attendance_snapshots_idempotency_unique').on(
      table.liveSessionId,
      table.recordedBy,
      table.clientRequestId,
    ),
    // The community list, newest first by a backward scan (§7); session-filtered.
    index('attendance_snapshots_community_idx').on(table.communityId, table.observedAt, table.id),
    index('attendance_snapshots_session_idx').on(table.liveSessionId, table.observedAt, table.id),
    check(
      'attendance_snapshots_client_request_id_shape',
      sql`${table.clientRequestId} ~ '^[A-Za-z0-9_-]{8,64}$'`,
    ),
    check(
      'attendance_snapshots_observation_rule_valid',
      sql`${table.observationRule} in (${OBSERVATION_RULE_LIST})`,
    ),
    check(
      'attendance_snapshots_counts_non_negative',
      sql`${table.connectedCount} >= 0 and ${table.connectingCount} >= 0`,
    ),
    check(
      'attendance_snapshots_time_order',
      sql`${table.observedAt} >= ${table.observationStartedAt} and ${table.recordedAt} >= ${table.observedAt}`,
    ),
  ],
);

export const attendanceSnapshotEntries = pgTable(
  'attendance_snapshot_entries',
  {
    snapshotId: text('snapshot_id').notNull(),
    userId: text('user_id').notNull(),
    connection: text('connection').$type<SnapshotConnection>().notNull(),
  },
  (table) => [
    // One entry per account per snapshot (§6.2 I1).
    primaryKey({ columns: [table.snapshotId, table.userId] }),
    // The only FK — in-module; a snapshot with entries cannot be deleted from under them.
    foreignKey({
      name: 'attendance_snapshot_entries_snapshot_fk',
      columns: [table.snapshotId],
      foreignColumns: [attendanceSnapshots.id],
    }).onDelete('restrict'),
    check(
      'attendance_snapshot_entries_connection_valid',
      sql`${table.connection} in (${CONNECTION_LIST})`,
    ),
  ],
);
