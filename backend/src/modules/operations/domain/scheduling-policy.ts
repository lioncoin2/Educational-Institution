/**
 * Scheduling POLICY — kept apart from the lesson's identity and from time
 * resolution, so the rules most likely to change by owner decision live in one
 * small place.
 *
 * The only rule approved for this release is: a new (or rescheduled) lesson's
 * resolved instant must be STRICTLY AFTER `now`. This is where a future
 * scheduling HORIZON (an upper bound on how far ahead a lesson may be placed)
 * and the boundary of a future CONFLICT policy would be added — deliberately,
 * here — rather than scattered through the use cases. No horizon and no
 * conflict rule are imposed now (owner decisions D3/D4: v1 is shape + past
 * only; conflict is a separate later decision).
 */

/** Why a requested time is not schedulable. */
export type ScheduleTimeRejection = 'in_the_past';

export type ScheduleTimeDecision =
  { readonly ok: true } | { readonly ok: false; readonly reason: ScheduleTimeRejection };

/**
 * The approved v1 time policy. Comparison rule: the lesson instant must be
 * strictly greater than `now` — an instant equal to `now` (or before it) is
 * "in the past". `now` comes from the injected Clock; this function never reads
 * the wall clock itself, so the rule is deterministic under test.
 *
 * Lesson instants are minute-aligned (seconds zero); `now` may carry seconds,
 * so a lesson placed in the current minute resolves to an instant at or before
 * `now` and is correctly rejected as past.
 */
export function evaluateScheduleTime(instant: Date, now: Date): ScheduleTimeDecision {
  if (instant.getTime() <= now.getTime()) return { ok: false, reason: 'in_the_past' };
  return { ok: true };
}
