import { Inject, Injectable } from '@nestjs/common';

import { err, ok, type Principal, type Result } from '../../../shared';
import { ATTENDANCE_SNAPSHOT_REPOSITORY, type AttendanceSnapshotRepository } from '../domain/ports';
import type { AttendanceSnapshotHeader } from '../domain/snapshot';
import { AttendanceAccess } from './attendance-access';
import { AttendanceRefusals } from './attendance-settings';

export interface GetAttendanceSnapshotCommand {
  readonly principal: Principal;
  readonly snapshotId: string;
}

/**
 * Read one snapshot's header (attendance.md §15.1). It loads the header first,
 * then authorizes on its community through `AttendanceAccess.snapshotView`: a
 * member without `community.attendance.view` is answered 404
 * `snapshot_not_found`, the same as an unknown id (§11.3 masking). A host or a
 * recorder of the session may view it without the view act — the §11.3 fallback,
 * computed from the header and `recordedOrHostedInSession`. Reads never touch
 * Live, so an ended session's snapshot stays readable (§10, §15.1).
 */
@Injectable()
export class GetAttendanceSnapshotUseCase {
  constructor(
    private readonly access: AttendanceAccess,
    @Inject(ATTENDANCE_SNAPSHOT_REPOSITORY)
    private readonly repository: AttendanceSnapshotRepository,
  ) {}

  async execute(command: GetAttendanceSnapshotCommand): Promise<Result<AttendanceSnapshotHeader>> {
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
    return ok(header);
  }
}
