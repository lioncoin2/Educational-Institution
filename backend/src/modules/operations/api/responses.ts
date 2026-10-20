import type { LessonStatusView, LessonView } from '../application/views';

/** The wire shape of a lesson — flat, ISO-8601 instants, nulls explicit. */
export interface LessonResponse {
  readonly id: string;
  readonly halaqaId: string;
  readonly title: string | null;
  /** The wall clock the lesson was scheduled at, as entered. */
  readonly localDate: string;
  readonly localTime: string;
  readonly timezone: string;
  /** The resolved instant (ISO-8601, UTC). */
  readonly scheduledAt: string;
  readonly status: LessonStatusView;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
}

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export function toLessonResponse(lesson: LessonView): LessonResponse {
  return {
    id: lesson.id,
    halaqaId: lesson.halaqaId,
    title: lesson.title,
    localDate: lesson.local.date,
    localTime: lesson.local.time,
    timezone: lesson.timezone,
    scheduledAt: iso(lesson.scheduledAt),
    status: lesson.status,
    createdAt: iso(lesson.createdAt),
    createdBy: lesson.createdBy,
    updatedAt: iso(lesson.updatedAt),
    cancelledAt: isoOrNull(lesson.cancelledAt),
    cancelledBy: lesson.cancelledBy,
  };
}

export interface LessonPageResponse {
  readonly items: readonly LessonResponse[];
  readonly nextCursor?: string;
}

export function toLessonPageResponse(page: {
  readonly items: readonly LessonView[];
  readonly nextCursor?: string;
}): LessonPageResponse {
  return {
    items: page.items.map(toLessonResponse),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}
