import { Inject, Injectable } from '@nestjs/common';

import { DEFAULT_PAGE_LIMIT, ok, type Page, type Principal, type Result } from '../../../shared';
import { ATTENDANCE_SNAPSHOT_REPOSITORY, type AttendanceSnapshotRepository } from '../domain/ports';
import type { AttendanceSnapshotHeader } from '../domain/snapshot';
import { AttendanceAccess } from './attendance-access';
import { validateSnapshotCursor } from './cursors';

export interface ListCommunitySnapshotsCommand {
  readonly principal: Principal;
  readonly communityId: string;
  readonly liveSessionId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * List a community's snapshots, newest first (attendance.md §15.1). It validates
 * the cursor first (422 before any read), then authorizes through
 * `AttendanceAccess.listView`: `community.attendance.view`, or the §11.3 fallback
 * for a caller who hosted or recorded in the supplied `liveSessionId`
 * (`recordedOrHostedInSession`). It then reads attendance's own tables — never
 * Live. A `liveSessionId` of another community yields an empty page: the query
 * filters on the community id and the session id together.
 */
@Injectable()
export class ListCommunitySnapshotsUseCase {
  constructor(
    private readonly access: AttendanceAccess,
    @Inject(ATTENDANCE_SNAPSHOT_REPOSITORY)
    private readonly repository: AttendanceSnapshotRepository,
  ) {}

  async execute(
    command: ListCommunitySnapshotsCommand,
  ): Promise<Result<Page<AttendanceSnapshotHeader>>> {
    const cursor = validateSnapshotCursor(command.cursor);
    if (!cursor.ok) return cursor;

    const hostedOrRecorded =
      command.liveSessionId === undefined
        ? false
        : await this.repository.recordedOrHostedInSession(
            command.liveSessionId,
            command.principal.userId,
          );
    const permit = await this.access.listView(command.principal, {
      communityId: command.communityId,
      hostedOrRecorded,
    });
    if (!permit.ok) return permit;

    const page = await this.repository.listByCommunity(
      {
        communityId: command.communityId,
        ...(command.liveSessionId === undefined ? {} : { liveSessionId: command.liveSessionId }),
      },
      {
        limit: command.limit ?? DEFAULT_PAGE_LIMIT,
        ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
      },
    );
    return ok(page);
  }
}
