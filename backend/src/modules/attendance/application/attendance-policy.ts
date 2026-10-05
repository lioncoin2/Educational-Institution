import type { RateLimitPolicy } from '../../../shared';

/**
 * The per-recorder press limit (attendance.md §5.4, §8, Q72) — PROVISIONAL,
 * calibrated by the load test before production use. It bounds bursts from one
 * recorder; it is **not** a per-session cap on how often attendance may be
 * taken (that would be policy, Q72). Keyed by the recorder's account id.
 */
export const ATTENDANCE_SNAPSHOT_POLICY: RateLimitPolicy = Object.freeze({
  name: 'attendance.snapshot.user',
  limit: 6,
  windowSeconds: 60,
});
