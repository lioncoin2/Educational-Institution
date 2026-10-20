/**
 * Operations persistence ports.
 *
 * One repository owns the scheduled-lessons table: it creates, reads, saves
 * (reschedule/cancel are a full save of the updated lesson) and lists. The
 * token is injected; a Drizzle adapter backs it when a database is configured,
 * an in-memory store otherwise — chosen in the module, never here.
 */

import type { Lesson } from './lesson';

/**
 * The institution's default scheduling timezone, injected so the application
 * layer never reads platform config (or anything else) directly. Its one
 * implementation reads the neutral `institution.timezone` deployment setting —
 * deliberately NOT the notifications quiet-hours timezone (owner-rejected for
 * new use). `null` means no default is configured, and the caller must then
 * name a zone explicitly.
 */
export const INSTITUTION_TIMEZONE = Symbol('INSTITUTION_TIMEZONE');

export interface InstitutionTimezone {
  default(): string | null;
}

export const LESSON_REPOSITORY = Symbol('LESSON_REPOSITORY');

/** Deterministic keyset for paging lessons by (instant, id). */
export interface LessonKeyset {
  readonly scheduledAt: Date;
  readonly id: string;
}

export interface LessonListQuery {
  /** Narrow to one halaqa, or list across all authorised scope when absent. */
  readonly halaqaId?: string;
  /** Page start — the last page's keyset, exclusive. */
  readonly after?: LessonKeyset;
  /**
   * How many rows to return. The repository returns AT MOST this many, already
   * ordered by (`scheduledAt`, `id`) ascending; the use case asks for one more
   * than the page size to tell whether a next page exists.
   */
  readonly limit: number;
}

/**
 * The outcome of a create. A create carrying a `clientRequestId` that was
 * already used by the same creator returns the EXISTING lesson (`duplicate`)
 * instead of inserting a second — so a retried request is safe.
 */
export type CreateLessonOutcome =
  | { readonly status: 'created'; readonly lesson: Lesson }
  | { readonly status: 'duplicate'; readonly lesson: Lesson };

export interface LessonRepository {
  /**
   * Insert a new lesson. When `clientRequestId` is non-null and the same
   * creator already used it, no row is inserted and the existing lesson is
   * returned as `duplicate` (idempotent retry). The pair (creator,
   * clientRequestId) is unique in the database.
   */
  create(lesson: Lesson, clientRequestId: string | null): Promise<CreateLessonOutcome>;

  findById(id: string): Promise<Lesson | null>;

  /** Persist an updated lesson (reschedule or cancel). Identity is unchanged. */
  save(lesson: Lesson): Promise<void>;

  /** A page of lessons ordered by (`scheduledAt`, `id`) ascending, at most `limit`. */
  list(query: LessonListQuery): Promise<readonly Lesson[]>;
}
