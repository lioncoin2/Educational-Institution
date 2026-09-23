/**
 * Operations — the institution in motion: sessions, attendance, scheduling.
 *
 * It turns the Academic catalogue into things that actually happen on a date,
 * and is the module that reacts to `live.session.*` events to record attendance.
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
