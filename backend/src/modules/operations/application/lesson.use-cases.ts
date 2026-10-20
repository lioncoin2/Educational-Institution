/**
 * Scheduling use cases — create, read, list, reschedule and cancel individual
 * dated lessons. Every one re-authorizes `operations.schedule_manage` through
 * the identity port (never trusting the HTTP guard), resolves wall-clock time
 * DST-correctly, and enforces the approved policy (future-only; no recurrence,
 * no attendance, no notification, no live session). Nothing here reads the
 * quiet-hours resource.
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  clampLimit,
  err,
  failure,
  ID_GENERATOR,
  ok,
  type Clock,
  type Failure,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import { ACADEMIC_RELATIONSHIPS, type AcademicRelationships } from '../../academic/contracts';
import { isModifiable, LESSON_TITLE_MAX, normaliseTitle, type Lesson } from '../domain/lesson';
import {
  INSTITUTION_TIMEZONE,
  LESSON_REPOSITORY,
  type CreateLessonOutcome,
  type InstitutionTimezone,
  type LessonRepository,
} from '../domain/ports';
import { evaluateScheduleTime } from '../domain/scheduling-policy';
import { resolveLocalToInstant, type TimeResolution } from '../domain/time-resolution';
import { decodeLessonCursor, pagedLessons } from './cursors';
import { OperationsAccess } from './operations-access';

const TITLE_TOO_LONG: Failure = failure(
  'validation',
  'operations.title_too_long',
  `A lesson title may be at most ${LESSON_TITLE_MAX} characters.`,
  { max: LESSON_TITLE_MAX },
);

const NOT_FOUND: Failure = failure('not_found', 'operations.lesson_not_found', 'No such lesson.');

const NOT_MODIFIABLE: Failure = failure(
  'precondition_failed',
  'operations.lesson_not_modifiable',
  'A cancelled lesson cannot be rescheduled or cancelled again.',
);

/** Map a non-`resolved` time outcome to the matching validation failure, else null. */
function resolutionFailure(resolution: TimeResolution): Failure | null {
  switch (resolution.status) {
    case 'resolved':
      return null;
    case 'invalid_timezone':
      return failure(
        'validation',
        'operations.timezone_invalid',
        'The timezone must be an IANA zone identifier, for example Asia/Riyadh.',
      );
    case 'invalid_local':
      return failure(
        'validation',
        'operations.local_time_invalid',
        'The date and time must be a real calendar date in HH:MM 24-hour form.',
      );
    case 'nonexistent':
      return failure(
        'validation',
        'operations.local_time_nonexistent',
        'That local time does not occur in this timezone — the clocks skip it on a daylight-saving change. Pick another time.',
      );
  }
}

function pastFailure(scheduledAt: Date, now: Date): Failure {
  return failure(
    'validation',
    'operations.lesson_in_the_past',
    'A lesson must be scheduled for a time in the future.',
    { scheduledAt: scheduledAt.toISOString(), now: now.toISOString() },
  );
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export interface ScheduleLessonCommand {
  readonly principal: Principal;
  readonly halaqaId: string;
  readonly title?: string | null;
  readonly date: string;
  readonly time: string;
  /** IANA zone; when absent, the institution default is used (may be none). */
  readonly timezone?: string | null;
  /** Optional idempotency key — a repeated create with the same key is a no-op. */
  readonly clientRequestId?: string | null;
}

@Injectable()
export class ScheduleLessonUseCase {
  constructor(
    private readonly access: OperationsAccess,
    @Inject(LESSON_REPOSITORY) private readonly lessons: LessonRepository,
    @Inject(ACADEMIC_RELATIONSHIPS) private readonly academic: AcademicRelationships,
    @Inject(INSTITUTION_TIMEZONE) private readonly institution: InstitutionTimezone,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ScheduleLessonCommand): Promise<Result<CreateLessonOutcome>> {
    const allowed = this.access.authorizeScheduleManage(command.principal);
    if (!allowed.ok) return allowed;

    const timezone = trimmedOrNull(command.timezone) ?? this.institution.default();
    if (timezone === null) {
      return err(
        failure(
          'validation',
          'operations.timezone_required',
          'A timezone is required: the institution has no default timezone configured.',
        ),
      );
    }

    const title = normaliseTitle(command.title);
    if (!title.ok) return err(TITLE_TOO_LONG);

    if (!(await this.academic.halaqaExists(command.halaqaId))) {
      return err(
        failure('not_found', 'operations.halaqa_not_found', 'No such halaqa.', {
          halaqaId: command.halaqaId,
        }),
      );
    }

    const resolution = resolveLocalToInstant({ date: command.date, time: command.time }, timezone);
    const resolutionError = resolutionFailure(resolution);
    if (resolutionError !== null) return err(resolutionError);
    if (resolution.status !== 'resolved') return err(NOT_FOUND); // unreachable; satisfies narrowing
    const scheduledAt = resolution.instant;

    const now = this.clock.now();
    if (!evaluateScheduleTime(scheduledAt, now).ok) return err(pastFailure(scheduledAt, now));

    const lesson: Lesson = {
      id: this.ids.next<'OperationsLesson'>(),
      halaqaId: command.halaqaId,
      title: title.value,
      local: { date: command.date, time: command.time },
      timezone,
      scheduledAt,
      status: 'SCHEDULED',
      createdAt: now,
      createdBy: command.principal.userId,
      updatedAt: now,
      cancelledAt: null,
      cancelledBy: null,
    };
    return ok(await this.lessons.create(lesson, trimmedOrNull(command.clientRequestId)));
  }
}

export interface ListLessonsCommand {
  readonly principal: Principal;
  readonly halaqaId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

@Injectable()
export class ListLessonsUseCase {
  constructor(
    private readonly access: OperationsAccess,
    @Inject(LESSON_REPOSITORY) private readonly lessons: LessonRepository,
  ) {}

  async execute(
    command: ListLessonsCommand,
  ): Promise<Result<{ readonly items: readonly Lesson[]; readonly nextCursor?: string }>> {
    const allowed = this.access.authorizeScheduleManage(command.principal);
    if (!allowed.ok) return allowed;

    const after = decodeLessonCursor(command.cursor);
    if (!after.ok) return after;

    const limit = clampLimit(command.limit);
    const rows = await this.lessons.list({
      halaqaId: trimmedOrNull(command.halaqaId) ?? undefined,
      after: after.value,
      limit: limit + 1,
    });
    return ok(pagedLessons(rows, limit));
  }
}

@Injectable()
export class GetLessonUseCase {
  constructor(
    private readonly access: OperationsAccess,
    @Inject(LESSON_REPOSITORY) private readonly lessons: LessonRepository,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly lessonId: string;
  }): Promise<Result<Lesson>> {
    // Authorization first, so a guessed id leaks nothing to someone who may not
    // manage the schedule — they are refused identically whether or not it exists.
    const allowed = this.access.authorizeScheduleManage(command.principal);
    if (!allowed.ok) return allowed;

    const lesson = await this.lessons.findById(command.lessonId);
    if (lesson === null) return err(NOT_FOUND);
    return ok(lesson);
  }
}

export interface RescheduleLessonCommand {
  readonly principal: Principal;
  readonly lessonId: string;
  readonly date?: string;
  readonly time?: string;
  readonly timezone?: string | null;
  /** Provided (even as null) replaces the title; absent leaves it unchanged. */
  readonly title?: string | null;
}

@Injectable()
export class RescheduleLessonUseCase {
  constructor(
    private readonly access: OperationsAccess,
    @Inject(LESSON_REPOSITORY) private readonly lessons: LessonRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: RescheduleLessonCommand): Promise<Result<Lesson>> {
    const allowed = this.access.authorizeScheduleManage(command.principal);
    if (!allowed.ok) return allowed;

    const existing = await this.lessons.findById(command.lessonId);
    if (existing === null) return err(NOT_FOUND);
    if (!isModifiable(existing)) return err(NOT_MODIFIABLE);

    let title = existing.title;
    if (command.title !== undefined) {
      const normalised = normaliseTitle(command.title);
      if (!normalised.ok) return err(TITLE_TOO_LONG);
      title = normalised.value;
    }

    const now = this.clock.now();
    const timeChanged =
      command.date !== undefined ||
      command.time !== undefined ||
      trimmedOrNull(command.timezone) !== null;

    let local = existing.local;
    let timezone = existing.timezone;
    let scheduledAt = existing.scheduledAt;

    if (timeChanged) {
      const date = command.date ?? existing.local.date;
      const time = command.time ?? existing.local.time;
      timezone = trimmedOrNull(command.timezone) ?? existing.timezone;
      const resolution = resolveLocalToInstant({ date, time }, timezone);
      const resolutionError = resolutionFailure(resolution);
      if (resolutionError !== null) return err(resolutionError);
      if (resolution.status !== 'resolved') return err(NOT_FOUND); // unreachable; narrowing
      scheduledAt = resolution.instant;
      // Only the new time is checked against "future"; a title-only edit of a
      // lesson whose time has since passed is still allowed.
      if (!evaluateScheduleTime(scheduledAt, now).ok) return err(pastFailure(scheduledAt, now));
      local = { date, time };
    }

    const updated: Lesson = { ...existing, title, local, timezone, scheduledAt, updatedAt: now };
    await this.lessons.save(updated);
    return ok(updated);
  }
}

@Injectable()
export class CancelLessonUseCase {
  constructor(
    private readonly access: OperationsAccess,
    @Inject(LESSON_REPOSITORY) private readonly lessons: LessonRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly lessonId: string;
  }): Promise<Result<Lesson>> {
    const allowed = this.access.authorizeScheduleManage(command.principal);
    if (!allowed.ok) return allowed;

    const existing = await this.lessons.findById(command.lessonId);
    if (existing === null) return err(NOT_FOUND);
    if (!isModifiable(existing)) return err(NOT_MODIFIABLE);

    const now = this.clock.now();
    const cancelled: Lesson = {
      ...existing,
      status: 'CANCELLED',
      updatedAt: now,
      cancelledAt: now,
      cancelledBy: command.principal.userId,
    };
    await this.lessons.save(cancelled);
    return ok(cancelled);
  }
}
