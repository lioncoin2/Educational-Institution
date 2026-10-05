/**
 * The only vocabulary a snapshot speaks (attendance.md §6.2 I6): how the media
 * provider held a participant at the moment of the press. There is deliberately
 * no "present", "absent", "late" or "excused" — those are policy words
 * attendance never computes (§12, Q68). A later observation rule could widen
 * this behind the same CHECK meaning (§6.4), with a new rule id.
 */
export const SNAPSHOT_CONNECTIONS = ['CONNECTED', 'CONNECTING'] as const;

export type SnapshotConnection = (typeof SNAPSHOT_CONNECTIONS)[number];
