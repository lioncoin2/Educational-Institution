/**
 * Application-owned view of a lesson — the shape the API layer maps to the
 * wire. It mirrors the domain `Lesson` but lives in application so the API
 * never imports the domain directly (the layering rule). A domain `Lesson` is
 * structurally a `LessonView`, so use cases may return domain objects and the
 * controller passes them straight to the response mapper.
 */

export type LessonStatusView = 'SCHEDULED' | 'CANCELLED';

export interface LessonView {
  readonly id: string;
  readonly halaqaId: string;
  readonly title: string | null;
  readonly local: { readonly date: string; readonly time: string };
  readonly timezone: string;
  readonly scheduledAt: Date;
  readonly status: LessonStatusView;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
}

export interface LessonPageView {
  readonly items: readonly LessonView[];
  readonly nextCursor?: string;
}
