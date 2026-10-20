/**
 * A scheduled lesson — one dated teaching session for exactly one halaqa.
 *
 * A lesson records the WALL-CLOCK time it was scheduled at (`local` + `timezone`,
 * both captured at creation) alongside the resolved UTC `scheduledAt` instant.
 * Keeping the captured timezone means a later change to the institution's
 * timezone never silently moves an existing lesson: its instant was fixed from
 * the zone it was created in (owner decision D2).
 *
 * The lifecycle is deliberately tiny: a lesson is SCHEDULED, and may be
 * CANCELLED. Cancellation is an explicit, auditable STATE TRANSITION — the row
 * is never deleted, so the history of what was planned is preserved. There is
 * no recurrence, no attendance, no notification and no live session here (owner
 * decision §8 exclusions).
 */

import type { LocalDateTime } from './time-resolution';

export type LessonStatus = 'SCHEDULED' | 'CANCELLED';

export const LESSON_STATUSES: readonly LessonStatus[] = Object.freeze(['SCHEDULED', 'CANCELLED']);

/** Upper bound on a lesson's optional human title. */
export const LESSON_TITLE_MAX = 200;

export interface Lesson {
  readonly id: string;
  /** Opaque reference to an academic halaqa — validated via the academic contract, never an FK. */
  readonly halaqaId: string;
  /** Optional human label, trimmed; null when none was given. */
  readonly title: string | null;
  /** The wall-clock date/time the lesson was scheduled at, as entered. */
  readonly local: LocalDateTime;
  /** The IANA zone captured at creation; the instant was resolved against it. */
  readonly timezone: string;
  /** The resolved UTC instant (minute-aligned). */
  readonly scheduledAt: Date;
  readonly status: LessonStatus;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  /** Set only once the lesson is CANCELLED; null while SCHEDULED. */
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
}

/**
 * Only a SCHEDULED lesson may be rescheduled or cancelled. A CANCELLED lesson
 * is terminal — every mutating transition from it is rejected (an invalid
 * lifecycle transition), so cancellation is never undone and a cancelled lesson
 * is never silently re-timed.
 */
export function isModifiable(lesson: Lesson): boolean {
  return lesson.status === 'SCHEDULED';
}

/** Normalise an optional title: trim, treat blank as absent, reject over-length. */
export function normaliseTitle(
  title: string | null | undefined,
): { ok: true; value: string | null } | { ok: false } {
  if (title === null || title === undefined) return { ok: true, value: null };
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > LESSON_TITLE_MAX) return { ok: false };
  return { ok: true, value: trimmed };
}
