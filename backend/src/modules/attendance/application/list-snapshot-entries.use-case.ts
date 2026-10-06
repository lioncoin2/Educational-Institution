import { Inject, Injectable } from '@nestjs/common';

import {
  DEFAULT_PAGE_LIMIT,
  err,
  ok,
  type Page,
  type Principal,
  type Result,
} from '../../../shared';
import type { SnapshotConnection } from '../contracts/vocabulary';
import { ATTENDANCE_SNAPSHOT_REPOSITORY, type AttendanceSnapshotRepository } from '../domain/ports';
import type { SnapshotEntry } from '../domain/snapshot';
import { AttendanceAccess } from './attendance-access';
import { AttendanceRefusals } from './attendance-settings';
import { validateEntryCursor } from './cursors';

export interface ListSnapshotEntriesCommand {
  readonly principal: Principal;
  readonly snapshotId: string;
  readonly connection?: SnapshotConnection;
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * List one snapshot's participants, keyset-paged on the account id (§15.1). It
 * validates the cursor first (422), loads the header (404 `snapshot_not_found`
 * when there is none), authorizes exactly like the single snapshot
 * (`AttendanceAccess.snapshotView`, with the §11.3 host/recorder fallback), then
 * reads the entries — optionally narrowed to one connection state. Names are
 * resolved at view time in the API layer; this returns ids and connections only.
 */
@Injectable()
export class ListSnapshotEntriesUseCase {
  constructor(
    private readonly access: AttendanceAccess,
    @Inject(ATTENDANCE_SNAPSHOT_REPOSITORY)
    private readonly repository: AttendanceSnapshotRepository,
  ) {}

  async execute(command: ListSnapshotEntriesCommand): Promise<Result<Page<SnapshotEntry>>> {
    const cursor = validateEntryCursor(command.cursor);
    if (!cursor.ok) return cursor;

    const header = await this.repository.findById(command.snapshotId);
    if (header === null) return err(AttendanceRefusals.snapshotNotFound);

    const recorderOrHost =
      command.principal.userId === header.hostUserId ||
      command.principal.userId === header.recordedBy ||
      (await this.repository.recordedOrHostedInSession(
        header.liveSessionId,
        command.principal.userId,
      ));
    const permit = await this.access.snapshotView(command.principal, {
      communityId: header.communityId,
      recorderOrHost,
    });
    if (!permit.ok) return permit;

    const page = await this.repository.entries(
      {
        snapshotId: command.snapshotId,
        ...(command.connection === undefined ? {} : { connection: command.connection }),
      },
      {
        limit: command.limit ?? DEFAULT_PAGE_LIMIT,
        ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
      },
    );
    return ok(page);
  }
}
