import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';

import { SNAPSHOT_CONNECTIONS, type SnapshotConnection } from '../../contracts/vocabulary';

/**
 * Shared pagination query for the attendance list routes (the communities
 * `PageQuery` house style). `limit` is an optional integer — an oversize value
 * is **clamped** to 200 in the repository (attendance.md §7), never refused, so
 * there is no `@Max` here; a non-integer is 400 at the pipe. `cursor` is any
 * string, so a decode failure is decided later as 422 `attendance.cursor_invalid`
 * in the use case, not 400 at the edge. Unknown query fields are 400 (the global
 * whitelist pipe).
 */
export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

/** `GET /attendance/communities/:communityId/snapshots` query (§15.1). */
export class ListCommunitySnapshotsQuery extends PageQuery {
  /** Narrow to one of the community's sessions; one of another community yields an empty page. */
  @IsOptional()
  @IsString()
  liveSessionId?: string;
}

/** `GET /attendance/snapshots/:snapshotId/participants` query (§15.1). */
export class ListSnapshotParticipantsQuery extends PageQuery {
  /** Narrow to one connection state (`CONNECTED` | `CONNECTING`). */
  @IsOptional()
  @IsIn(SNAPSHOT_CONNECTIONS)
  connection?: SnapshotConnection;
}
