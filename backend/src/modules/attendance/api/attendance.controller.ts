import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';

import type { CallMetadata, Principal } from '../../../shared';
import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import { ACCOUNT_DIRECTORY, Authenticated, type AccountDirectory } from '../../identity/contracts';
import { GetAttendanceSnapshotUseCase } from '../application/get-attendance-snapshot.use-case';
import { ListCommunitySnapshotsUseCase } from '../application/list-community-snapshots.use-case';
import { ListSnapshotEntriesUseCase } from '../application/list-snapshot-entries.use-case';
import { RecordAttendanceSnapshotUseCase } from '../application/record-attendance-snapshot.use-case';
import { RecordSnapshotDto } from './dto/record-snapshot.dto';
import {
  ListCommunitySnapshotsQuery,
  ListSnapshotParticipantsQuery,
} from './dto/view-snapshots.dto';
import { toParticipantsPageResponse, toSnapshotPageResponse, toSnapshotView } from './responses';

/**
 * /attendance — recording live-session attendance snapshots (attendance.md
 * §15.1, P9).
 *
 * One authenticated route: a press records whom the media provider held
 * connected now. The edge asks only for an authenticated account; the decision
 * is the use case's, which asks Communities for the recorder's standing in the
 * session's own community (`AttendanceAccess`, §11.3). The edge is never the
 * decision, so a caller learns nothing about a session or a community they may
 * not record for — one 404, whether it exists or not.
 *
 * The caller sends only an idempotency key (on the press) or a page cursor (on
 * a read). Who the recorder is (`principal.userId`), which community, which host
 * and whom to count are the server's to know, never a claim in a request. Every
 * route is `@Authenticated()`; the decision is always the use case's community
 * standing (`AttendanceAccess`). Snapshots are immutable and append-only — there
 * is no update or delete route. Reads never touch Live, so a past session's
 * snapshots stay readable; a store that cannot be reached answers 503
 * `unavailable` (the interceptor), never an answer computed without it.
 */
@Controller('attendance')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class AttendanceController {
  constructor(
    private readonly recordSnapshot: RecordAttendanceSnapshotUseCase,
    private readonly listCommunitySnapshots: ListCommunitySnapshotsUseCase,
    private readonly getSnapshot: GetAttendanceSnapshotUseCase,
    private readonly listSnapshotEntries: ListSnapshotEntriesUseCase,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
  ) {}

  /**
   * Record one snapshot on a press (§18 S1). 201 with the snapshot this call
   * took; 200 with the one an earlier press with the same key already took
   * (idempotency replay, §8) — the same `SnapshotView` either way. The use case
   * runs the whole sequence; the controller only transports input and formats
   * output, so nothing here can bypass authorization, idempotency, the rate
   * limit or the observation. 422 malformed key, 404 session the caller may not
   * record for, 412 session not running, 429 pressing too fast, 503 the
   * observation could not be taken.
   */
  @Post('live-sessions/:liveSessionId/snapshots')
  @Authenticated()
  async record(
    @CurrentPrincipal() principal: Principal,
    @Param('liveSessionId') liveSessionId: string,
    @Body() body: RecordSnapshotDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(
      await this.recordSnapshot.execute({
        principal,
        meta,
        liveSessionId,
        clientRequestId: body.clientRequestId,
      }),
    );
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return toSnapshotView(result.snapshot, this.directory);
  }

  /**
   * A community's snapshots, newest first, keyset-paged (§15.1). `community.
   * attendance.view` on the path's community, or — without it — only a
   * `liveSessionId` the caller hosted or recorded in (§11.3). A `liveSessionId`
   * of another community yields an empty page. Never calls Live.
   */
  @Get('communities/:communityId/snapshots')
  @Authenticated()
  async listSnapshots(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Query() query: ListCommunitySnapshotsQuery,
  ) {
    const page = unwrap(
      await this.listCommunitySnapshots.execute({
        principal,
        communityId,
        liveSessionId: query.liveSessionId,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return toSnapshotPageResponse(page, this.directory);
  }

  /** One snapshot's header (§15.1); 404 `snapshot_not_found` when unknown, invisible or not permitted. */
  @Get('snapshots/:snapshotId')
  @Authenticated()
  async getSnapshotById(
    @CurrentPrincipal() principal: Principal,
    @Param('snapshotId') snapshotId: string,
  ) {
    return toSnapshotView(
      unwrap(await this.getSnapshot.execute({ principal, snapshotId })),
      this.directory,
    );
  }

  /**
   * One snapshot's participants, keyset-paged on the account id (§15.1).
   * Authorized exactly like the single snapshot; names resolved at view time
   * (one directory call per page, §6.3); never an email, never a "present" field.
   */
  @Get('snapshots/:snapshotId/participants')
  @Authenticated()
  async listParticipants(
    @CurrentPrincipal() principal: Principal,
    @Param('snapshotId') snapshotId: string,
    @Query() query: ListSnapshotParticipantsQuery,
  ) {
    const page = unwrap(
      await this.listSnapshotEntries.execute({
        principal,
        snapshotId,
        connection: query.connection,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return toParticipantsPageResponse(page, this.directory);
  }
}
