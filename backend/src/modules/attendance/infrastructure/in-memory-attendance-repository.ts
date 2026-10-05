import { clampLimit, type Page, type PageRequest } from '../../../shared';
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

const SEP = '\u0000';

function headerOf(snapshot: AttendanceSnapshot): AttendanceSnapshotHeader {
  const { entries: _entries, ...header } = snapshot;
  return header;
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The in-memory twin of `DrizzleAttendanceSnapshotRepository` for mock mode and
 * tests (attendance.md §22). It keeps the same guarantees as the table:
 * append-only (no update or delete), the idempotency key, one entry per account
 * per snapshot, and the same ordering. A primary-key collision or a duplicate
 * account surfaces as a fault, exactly as the database's constraints would.
 */
export class InMemoryAttendanceSnapshotRepository implements AttendanceSnapshotRepository {
  private readonly byId = new Map<string, AttendanceSnapshot>();
  private readonly byKey = new Map<string, string>();

  private keyString(key: SnapshotIdempotencyKey): string {
    return [key.liveSessionId, key.recordedBy, key.clientRequestId].join(SEP);
  }

  findByKey(key: SnapshotIdempotencyKey): Promise<AttendanceSnapshotHeader | null> {
    const id = this.byKey.get(this.keyString(key));
    const snapshot = id === undefined ? undefined : this.byId.get(id);
    return Promise.resolve(snapshot === undefined ? null : headerOf(snapshot));
  }

  findById(id: string): Promise<AttendanceSnapshotHeader | null> {
    const snapshot = this.byId.get(id);
    return Promise.resolve(snapshot === undefined ? null : headerOf(snapshot));
  }

  insert(snapshot: AttendanceSnapshot): Promise<SnapshotInsertOutcome> {
    const key = this.keyString({
      liveSessionId: snapshot.liveSessionId,
      recordedBy: snapshot.recordedBy,
      clientRequestId: snapshot.clientRequestId,
    });
    // Only the idempotency key is swallowed as a duplicate (§8).
    if (this.byKey.has(key)) return Promise.resolve('duplicate');
    // Any other collision is a fault, as the table's PK/CHECKs would raise — a
    // rejected promise, mirroring the Drizzle adapter's transaction.
    if (this.byId.has(snapshot.id)) {
      return Promise.reject(new Error('attendance: primary-key collision on snapshot id'));
    }
    if (new Set(snapshot.entries.map((entry) => entry.userId)).size !== snapshot.entries.length) {
      return Promise.reject(
        new Error('attendance: a snapshot may hold at most one entry per account'),
      );
    }
    this.byId.set(snapshot.id, snapshot);
    this.byKey.set(key, snapshot.id);
    return Promise.resolve('created');
  }

  listByCommunity(
    query: CommunitySnapshotQuery,
    page: PageRequest,
  ): Promise<Page<AttendanceSnapshotHeader>> {
    const matching = [...this.byId.values()]
      .filter(
        (snapshot) =>
          snapshot.communityId === query.communityId &&
          (query.liveSessionId === undefined || snapshot.liveSessionId === query.liveSessionId),
      )
      // Newest first: (observedAt, id) descending.
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || compareIds(b.id, a.id));

    let rows = matching;
    if (page.cursor !== undefined) {
      const after = decodeSnapshotCursor(page.cursor);
      rows = rows.filter(
        (snapshot) =>
          snapshot.observedAt.getTime() < after.observedAt.getTime() ||
          (snapshot.observedAt.getTime() === after.observedAt.getTime() &&
            compareIds(snapshot.id, after.id) < 0),
      );
    }

    const limit = clampLimit(page.limit);
    const shown = rows.slice(0, limit).map(headerOf);
    const last = shown[shown.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeSnapshotCursor({ observedAt: last.observedAt, id: last.id })
        : undefined;
    return Promise.resolve({ items: shown, ...(nextCursor === undefined ? {} : { nextCursor }) });
  }

  entries(query: SnapshotEntriesQuery, page: PageRequest): Promise<Page<SnapshotEntry>> {
    const snapshot = this.byId.get(query.snapshotId);
    const all: readonly SnapshotEntry[] = snapshot === undefined ? [] : snapshot.entries;

    let rows = [...all]
      .filter((entry) => query.connection === undefined || entry.connection === query.connection)
      .sort((a, b) => compareIds(a.userId, b.userId));
    if (page.cursor !== undefined) {
      const afterUser = decodeEntryCursor(page.cursor);
      rows = rows.filter((entry) => entry.userId > afterUser);
    }

    const limit = clampLimit(page.limit);
    const shown = rows.slice(0, limit);
    const last = shown[shown.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined ? encodeEntryCursor(last.userId) : undefined;
    return Promise.resolve({ items: shown, ...(nextCursor === undefined ? {} : { nextCursor }) });
  }
}
