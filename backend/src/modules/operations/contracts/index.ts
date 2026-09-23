/**
 * Operations — the institution in motion: scheduled sessions and scheduling.
 *
 * It turns the Academic catalogue into things that actually happen on a date.
 * Nothing is implemented yet, and this vocabulary is on hold with academic
 * attendance (docs/architecture/academic-reconciliation.md §13).
 *
 * It does NOT derive attendance from `live.session.*` events. Observations of
 * who is present in a live session belong to the attendance module (ADR 0020;
 * its implementation is held until the institution answers Q68/Q69), which
 * asks live's contracts at the moment a snapshot is taken. Whether a snapshot
 * ever feeds an `AttendanceRecord` here is open (Q70); `AttendanceState` below
 * is not a snapshot's vocabulary.
 */
export type AttendanceState = 'present' | 'absent' | 'late' | 'excused';

export interface SessionRef {
  readonly sessionId: string;
  readonly halaqaId: string;
  readonly scheduledAt: Date;
}

/** Why an attendance record was changed after the fact — always required. */
export interface AttendanceAmendment {
  readonly reason: string;
  readonly amendedBy: string;
}
