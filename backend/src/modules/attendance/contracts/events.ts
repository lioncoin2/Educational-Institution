import type { DomainEvent } from '../../../shared';

/**
 * Attendance's one event (attendance.md §14, ADR 0021). Published once per
 * **created** snapshot, after the audit entry, by `AttendanceJournal`. Never for
 * a replay, a lost same-key race or a failure. Class R durability: the table is
 * the truth; a consumer reads it and tolerates duplicates.
 */
export const AttendanceEvents = { snapshotRecorded: 'attendance.snapshot.recorded' } as const;

/**
 * Ids, one timestamp and two counts. **Never** a participant id or name, a token
 * or a provider identity — nothing a snapshot's entries hold.
 */
export interface AttendanceSnapshotRecordedPayload {
  readonly snapshotId: string;
  readonly communityId: string;
  readonly liveSessionId: string;
  readonly recordedBy: string;
  /** ISO 8601. */
  readonly observedAt: string;
  readonly connectedCount: number;
  readonly connectingCount: number;
}

/** `aggregateId = liveSessionId`, so one session's snapshots form one ordered stream. */
export type AttendanceSnapshotRecorded = DomainEvent<
  typeof AttendanceEvents.snapshotRecorded,
  AttendanceSnapshotRecordedPayload
>;
