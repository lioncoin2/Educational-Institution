import type { Page, PageRequest } from '../../../shared';
import type { SnapshotConnection } from '../contracts/vocabulary';
import type { AttendanceSnapshot, AttendanceSnapshotHeader, SnapshotEntry } from './snapshot';

/** DI token. */
export const ATTENDANCE_SNAPSHOT_REPOSITORY = Symbol('ATTENDANCE_SNAPSHOT_REPOSITORY');

/** A snapshot's idempotency key (attendance.md §7, §8): unique per session, recorder and request. */
export interface SnapshotIdempotencyKey {
  readonly liveSessionId: string;
  readonly recordedBy: string;
  readonly clientRequestId: string;
}

/** `created` when this call inserted the snapshot; `duplicate` when its key already existed (§7). */
export type SnapshotInsertOutcome = 'created' | 'duplicate';

/** A community's snapshot list, optionally narrowed to one of its sessions (attendance.md §15.1). */
export interface CommunitySnapshotQuery {
  readonly communityId: string;
  readonly liveSessionId?: string;
}

/** One snapshot's entries, optionally narrowed to one connection state (§15.1 `?connection`). */
export interface SnapshotEntriesQuery {
  readonly snapshotId: string;
  readonly connection?: SnapshotConnection;
}

/**
 * The store behind attendance snapshots (attendance.md §22). It is **append-only**:
 * a snapshot is written once and read afterwards — there is **no update and no
 * delete**, here or in any adapter (§6.2 I5, §10). Reads never touch Live or
 * LiveKit (§7): they are keyset ranges on attendance's own tables.
 */
export interface AttendanceSnapshotRepository {
  /** The idempotency replay read (§8): the stored header, or null — never the entries. */
  findByKey(key: SnapshotIdempotencyKey): Promise<AttendanceSnapshotHeader | null>;

  /** Insert the header and its entries in one transaction; `duplicate` when the key already exists (§7). */
  insert(snapshot: AttendanceSnapshot): Promise<SnapshotInsertOutcome>;

  /** One snapshot's header by id (§15.1), or null when there is none. */
  findById(id: string): Promise<AttendanceSnapshotHeader | null>;

  /**
   * Whether `userId` hosted or recorded any snapshot of `liveSessionId` — a
   * read-only existence check on attendance's own rows (the prefix read on the
   * idempotency index for `recordedBy`, and the session's `hostUserId`). It is
   * the view fallback of attendance.md §11.3: a host or recorder of a session
   * may view its snapshots even without `community.attendance.view`. Never
   * touches Live.
   */
  recordedOrHostedInSession(liveSessionId: string, userId: string): Promise<boolean>;

  /** A community's snapshots, newest first, keyset-paged — headers only (§7, §15.1). */
  listByCommunity(
    query: CommunitySnapshotQuery,
    page: PageRequest,
  ): Promise<Page<AttendanceSnapshotHeader>>;

  /** One snapshot's entries, keyset-paged on the account id (§7, §15.1). */
  entries(query: SnapshotEntriesQuery, page: PageRequest): Promise<Page<SnapshotEntry>>;
}
