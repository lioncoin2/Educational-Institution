import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { FileKind } from '../contracts/file-kind';
import type { FileAssetStatus } from '../domain/file-asset';

/**
 * Stored-file metadata. The bytes are never here — only the opaque key that
 * points at them in the storage provider.
 *
 * `owner_user_id` is deliberately not a foreign key: accounts are identity's
 * table, and no module holds a constraint on another's. The uploader is
 * attribution plus an attach-permission check, both done in code.
 *
 * Text + CHECK rather than enums, as elsewhere: widening a CHECK is cheap.
 */
export const fileAssets = pgTable(
  'file_assets',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull(),
    kind: text('kind').$type<FileKind>().notNull(),
    contentType: text('content_type').notNull(),
    // bigint: today's caps fit an int, a future video kind would not.
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull().unique('file_assets_storage_key_unique'),
    displayName: text('display_name').notNull(),
    status: text('status').$type<FileAssetStatus>().notNull().default('PENDING'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    // Uploads that were started and never completed — what a cleanup job
    // sweeps (deferred; see storage.md). Completed rows are never scanned.
    index('file_assets_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'PENDING'`),
    check('file_assets_kind_valid', sql`${table.kind} in ('IMAGE', 'VOICE', 'AUDIO', 'DOCUMENT')`),
    check('file_assets_status_valid', sql`${table.status} in ('PENDING', 'AVAILABLE', 'REJECTED')`),
    check(
      'file_assets_completion_consistent',
      sql`(${table.status} = 'PENDING') = (${table.completedAt} is null)`,
    ),
    check('file_assets_size_positive', sql`${table.byteSize} > 0`),
    check('file_assets_content_type_shape', sql`${table.contentType} ~ '^[a-z]+/[a-z0-9.+-]+$'`),
    check('file_assets_display_name_present', sql`length(${table.displayName}) between 1 and 255`),
    check(
      'file_assets_duration_valid',
      sql`${table.durationMs} is null or (${table.durationMs} > 0 and ${table.kind} in ('VOICE', 'AUDIO'))`,
    ),
    check(
      'file_assets_dimensions_valid',
      sql`(${table.width} is null) = (${table.height} is null) and (${table.width} is null or (${table.width} > 0 and ${table.height} > 0 and ${table.kind} = 'IMAGE'))`,
    ),
  ],
);
