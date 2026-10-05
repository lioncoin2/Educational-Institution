import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, lt, or, type SQL } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import { asId, clampLimit, type Page, type PageRequest } from '../../../shared';
import {
  decodeEntryCursor,
  decodeSnapshotCursor,
  encodeEntryCursor,
  encodeSnapshotCursor,
} from '../application/cursors';
import type {
  AttendanceSnapshotRepository,
  CommunitySnapshotQuery,
  SnapshotEntriesQuery,
  SnapshotIdempotencyKey,
  SnapshotInsertOutcome,
} from '../domain/ports';
import type {
  AttendanceSnapshot,
  AttendanceSnapshotHeader,
  SnapshotEntry,
} from '../domain/snapshot';
import { attendanceSnapshotEntries, attendanceSnapshots } from './schema';

/** At most this many entry rows per INSERT statement (attendance.md §7). */
const ENTRY_CHUNK = 1_000;

type HeaderRow = typeof attendanceSnapshots.$inferSelect;
type EntryRow = typeof attendanceSnapshotEntries.$inferSelect;

function toHeader(row: HeaderRow): AttendanceSnapshotHeader {
  return {
    id: asId<'AttendanceSnapshot'>(row.id),
    communityId: row.communityId,
    liveSessionId: row.liveSessionId,
    hostUserId: row.hostUserId,
    recordedBy: row.recordedBy,
    clientRequestId: row.clientRequestId,
    observationRule: row.observationRule,
    observationStartedAt: row.observationStartedAt,
    observedAt: row.observedAt,
    recordedAt: row.recordedAt,
    connectedCount: row.connectedCount,
    connectingCount: row.connectingCount,
  };
}

function toEntry(row: EntryRow): SnapshotEntry {
  return { userId: row.userId, connection: row.connection };
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Attendance snapshots in Postgres (attendance.md §7). Append-only — insert and
 * read, never update or delete. The write is one short transaction, after the
 * observation returned; reads are keyset ranges on attendance's own tables and
 * never touch Live or LiveKit.
 */
@Injectable()
export class DrizzleAttendanceSnapshotRepository implements AttendanceSnapshotRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findByKey(key: SnapshotIdempotencyKey): Promise<AttendanceSnapshotHeader | null> {
    const [row] = await this.db
      .select()
      .from(attendanceSnapshots)
      .where(
        and(
          eq(attendanceSnapshots.liveSessionId, key.liveSessionId),
          eq(attendanceSnapshots.recordedBy, key.recordedBy),
          eq(attendanceSnapshots.clientRequestId, key.clientRequestId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toHeader(row);
  }

  async findById(id: string): Promise<AttendanceSnapshotHeader | null> {
    const [row] = await this.db
      .select()
      .from(attendanceSnapshots)
      .where(eq(attendanceSnapshots.id, id))
      .limit(1);
    return row === undefined ? null : toHeader(row);
  }

  /**
   * Header then entries, in one transaction. `ON CONFLICT` targets **only** the
   * idempotency columns, so a concurrent same-key press that loses yields no row
   * and returns `duplicate`; any other violation (a primary-key collision, a
   * CHECK, the FK) is **not** swallowed — it throws and the transaction rolls
   * back, leaving nothing stored.
   */
  insert(snapshot: AttendanceSnapshot): Promise<SnapshotInsertOutcome> {
    return this.db.transaction(async (tx) => {
      const [header] = await tx
        .insert(attendanceSnapshots)
        .values({
          id: snapshot.id,
          communityId: snapshot.communityId,
          liveSessionId: snapshot.liveSessionId,
          hostUserId: snapshot.hostUserId,
          recordedBy: snapshot.recordedBy,
          clientRequestId: snapshot.clientRequestId,
          observationRule: snapshot.observationRule,
          observationStartedAt: snapshot.observationStartedAt,
          observedAt: snapshot.observedAt,
          recordedAt: snapshot.recordedAt,
          connectedCount: snapshot.connectedCount,
          connectingCount: snapshot.connectingCount,
        })
        .onConflictDoNothing({
          target: [
            attendanceSnapshots.liveSessionId,
            attendanceSnapshots.recordedBy,
            attendanceSnapshots.clientRequestId,
          ],
        })
        .returning({ id: attendanceSnapshots.id });

      if (header === undefined) return 'duplicate';

      for (const entries of chunk(snapshot.entries, ENTRY_CHUNK)) {
        await tx.insert(attendanceSnapshotEntries).values(
          entries.map((entry) => ({
            snapshotId: snapshot.id,
            userId: entry.userId,
            connection: entry.connection,
          })),
        );
      }
      return 'created';
    });
  }

  async listByCommunity(
    query: CommunitySnapshotQuery,
    page: PageRequest,
  ): Promise<Page<AttendanceSnapshotHeader>> {
    const limit = clampLimit(page.limit);
    const filters: SQL[] = [eq(attendanceSnapshots.communityId, query.communityId)];
    if (query.liveSessionId !== undefined) {
      filters.push(eq(attendanceSnapshots.liveSessionId, query.liveSessionId));
    }
    if (page.cursor !== undefined) {
      const after = decodeSnapshotCursor(page.cursor);
      // Newest first: continue strictly before the cursor's (observedAt, id).
      const keyset = or(
        lt(attendanceSnapshots.observedAt, after.observedAt),
        and(
          eq(attendanceSnapshots.observedAt, after.observedAt),
          lt(attendanceSnapshots.id, after.id),
        ),
      );
      if (keyset !== undefined) filters.push(keyset);
    }
    const rows = await this.db
      .select()
      .from(attendanceSnapshots)
      .where(and(...filters))
      .orderBy(desc(attendanceSnapshots.observedAt), desc(attendanceSnapshots.id))
      .limit(limit + 1);

    const shown = rows.slice(0, limit).map(toHeader);
    const last = shown[shown.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeSnapshotCursor({ observedAt: last.observedAt, id: last.id })
        : undefined;
    return { items: shown, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  async entries(query: SnapshotEntriesQuery, page: PageRequest): Promise<Page<SnapshotEntry>> {
    const limit = clampLimit(page.limit);
    const filters: SQL[] = [eq(attendanceSnapshotEntries.snapshotId, query.snapshotId)];
    if (query.connection !== undefined) {
      filters.push(eq(attendanceSnapshotEntries.connection, query.connection));
    }
    if (page.cursor !== undefined) {
      filters.push(gt(attendanceSnapshotEntries.userId, decodeEntryCursor(page.cursor)));
    }
    const rows = await this.db
      .select()
      .from(attendanceSnapshotEntries)
      .where(and(...filters))
      .orderBy(asc(attendanceSnapshotEntries.userId))
      .limit(limit + 1);

    const shown = rows.slice(0, limit).map(toEntry);
    const last = shown[shown.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined ? encodeEntryCursor(last.userId) : undefined;
    return { items: shown, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
}
