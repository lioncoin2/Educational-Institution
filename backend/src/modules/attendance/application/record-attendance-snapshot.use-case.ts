import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  domainEvent,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import { LIVE_SESSIONS, type LiveSessions } from '../../live/contracts/live-sessions';
import { LIVE_PRESENCE, type LivePresence } from '../../live/contracts/presence';
import { AttendanceEvents, type AttendanceSnapshotRecordedPayload } from '../contracts/events';
import {
  ATTENDANCE_SNAPSHOT_REPOSITORY,
  type AttendanceSnapshotRepository,
  type SnapshotIdempotencyKey,
} from '../domain/ports';
import {
  CLIENT_REQUEST_ID_INVALID,
  isValidClientRequestId,
  takeSnapshot,
  type AttendanceSnapshotHeader,
} from '../domain/snapshot';
import { AttendanceAccess, permitOf } from './attendance-access';
import { AttendanceJournal } from './attendance-journal';
import { ATTENDANCE_SNAPSHOT_POLICY } from './attendance-policy';
import { AttendanceRefusals } from './attendance-settings';

/** The session was observed to be not running (before or after the read) (§15.2). */
const SESSION_NOT_LIVE = failure(
  'precondition_failed',
  'attendance.session_not_live',
  'The live session is not running.',
);
/** The provider could not be read (error, deadline or oversize); nothing stored, retry-safe (§15.2). */
const OBSERVATION_UNAVAILABLE = failure(
  'unavailable',
  'attendance.observation_unavailable',
  'The attendance observation could not be taken; retrying with the same key is safe.',
);

function tooManySnapshots(retryAfterSeconds: number) {
  return failure(
    'rate_limited',
    'attendance.too_many_snapshots',
    'Too many attendance snapshots; try again shortly.',
    { retryAfterSeconds },
  );
}

export interface RecordSnapshotCommand {
  readonly principal: Principal;
  readonly meta: CallMetadata;
  readonly liveSessionId: string;
  readonly clientRequestId: string;
}

export interface RecordSnapshotResult {
  /** True when this call created the snapshot (201); false for a replay or a lost race (200). */
  readonly created: boolean;
  readonly snapshot: AttendanceSnapshotHeader;
}

/**
 * Record one attendance snapshot (attendance.md §18 S1/S2/S3). One observation,
 * taken on a press, stored once and never changed. Authorization is community
 * standing through `AttendanceAccess` (no `attendance.*` permission); presence
 * comes from `LIVE_PRESENCE`; the snapshot is built by the pure `takeSnapshot`
 * and persisted through the repository port. Idempotent by
 * `(liveSessionId, recordedBy, clientRequestId)`.
 */
@Injectable()
export class RecordAttendanceSnapshotUseCase {
  constructor(
    private readonly access: AttendanceAccess,
    @Inject(ATTENDANCE_SNAPSHOT_REPOSITORY)
    private readonly repository: AttendanceSnapshotRepository,
    @Inject(LIVE_SESSIONS) private readonly liveSessions: LiveSessions,
    @Inject(LIVE_PRESENCE) private readonly presence: LivePresence,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    private readonly journal: AttendanceJournal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: RecordSnapshotCommand): Promise<Result<RecordSnapshotResult>> {
    const { principal, liveSessionId, clientRequestId } = command;

    // 1. Validate the client request id first (§18 S1 step 2): before any
    //    lookup, authorization, rate-limit charge or observation. A malformed
    //    key never reaches Live, the store, the rate limiter or the audit.
    if (!isValidClientRequestId(clientRequestId)) return err(CLIENT_REQUEST_ID_INVALID);

    const key: SnapshotIdempotencyKey = {
      liveSessionId,
      recordedBy: principal.userId,
      clientRequestId,
    };

    // 2. The session's scope, from Live's own record (never from the client).
    const scope = await this.liveSessions.describe(liveSessionId);
    if (scope === null) return err(AttendanceRefusals.sessionNotFound);

    // 3. Authorization — the only one (§11.3, the record fallback order).
    const permit = await this.access.record(principal, {
      communityId: scope.communityId,
      hostUserId: scope.hostUserId,
    });
    if (!permit.ok) return permit;

    // 4. Idempotency: a retry finds the stored snapshot and stops here — no
    //    observation, no rate-limit charge, no audit, no event (even after the
    //    session has ended). Runs after authorization (S2 steps 5-6).
    const replay = await this.repository.findByKey(key);
    if (replay !== null) return ok({ created: false, snapshot: replay });

    // 5. The session must still be live, before any charge or observation.
    if (!scope.active) return err(SESSION_NOT_LIVE);

    // 6. Rate limit, per recorder, charged before the observation (a failed
    //    observation still counts; a replay above never reaches here).
    const decision = await this.rateLimiter.consume(principal.userId, ATTENDANCE_SNAPSHOT_POLICY);
    if (!decision.allowed) return err(tooManySnapshots(decision.retryAfterSeconds));

    // 7. One observation; map its outcome (§9, §15.2).
    const observation = await this.presence.observe(liveSessionId);
    if (observation.kind === 'not_found') return err(AttendanceRefusals.sessionNotFound);
    if (observation.kind === 'not_active') return err(SESSION_NOT_LIVE);
    if (observation.kind === 'unavailable') return err(OBSERVATION_UNAVAILABLE);

    // 8. The observation must be of the authorized community, else a fault — a
    //    500, with nothing stored (§6.2 I9).
    if (observation.communityId !== scope.communityId) {
      throw new Error(
        'attendance: the observation community does not match the authorized community',
      );
    }

    // 9. Build the snapshot (pure), mapping the observed connection states. The
    //    key is already valid (step 1); takeSnapshot re-checks as an invariant.
    const built = takeSnapshot({
      id: this.ids.next<'AttendanceSnapshot'>(),
      communityId: scope.communityId,
      liveSessionId,
      hostUserId: scope.hostUserId,
      recordedBy: principal.userId,
      clientRequestId,
      observationStartedAt: observation.observationStartedAt,
      observedAt: observation.observedAt,
      now: this.clock.now(),
      entries: observation.participants.map((participant) => ({
        userId: participant.userId,
        connection: participant.connection === 'connected' ? 'CONNECTED' : 'CONNECTING',
      })),
    });
    if (!built.ok) return built;
    const snapshot = built.value;

    // 10. Persist. A concurrent same-key race loses here: the winner is
    //     returned, its own observation discarded, nothing audited or published.
    const outcome = await this.repository.insert(snapshot);
    if (outcome === 'duplicate') {
      const winner = await this.repository.findByKey(key);
      if (winner === null) {
        throw new Error('attendance: insert reported a duplicate but no snapshot was found');
      }
      return ok({ created: false, snapshot: winner });
    }

    // 11. Created: audit then event, after the commit (AttendanceJournal).
    const payload: AttendanceSnapshotRecordedPayload = {
      snapshotId: snapshot.id,
      communityId: snapshot.communityId,
      liveSessionId: snapshot.liveSessionId,
      recordedBy: snapshot.recordedBy,
      observedAt: snapshot.observedAt.toISOString(),
      connectedCount: snapshot.connectedCount,
      connectingCount: snapshot.connectingCount,
    };
    await this.journal.record(
      {
        actorUserId: principal.userId,
        action: AttendanceEvents.snapshotRecorded,
        resourceType: 'attendance.snapshot',
        resourceId: snapshot.id,
        at: snapshot.recordedAt,
        metadata: {
          communityId: snapshot.communityId,
          liveSessionId: snapshot.liveSessionId,
          connectedCount: snapshot.connectedCount,
          connectingCount: snapshot.connectingCount,
          observationRule: snapshot.observationRule,
          // The permit this ran on (ADR 0017), ceiling included (§14).
          authority: { ...permitOf(permit.value), ceiling: permit.value.ceiling },
        },
        correlationId: command.meta.correlationId,
      },
      domainEvent(
        AttendanceEvents.snapshotRecorded,
        snapshot.liveSessionId,
        payload,
        snapshot.recordedAt,
        command.meta.correlationId,
      ),
    );

    return ok({ created: true, snapshot });
  }
}
