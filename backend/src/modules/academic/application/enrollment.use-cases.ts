import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import {
  ENROLLMENT_STATUSES,
  isEnrollmentOutcome,
  type EnrollmentStatus,
} from '../contracts/vocabulary';
import { alreadyEnded, newEnrollment } from '../domain/enrollment';
import { enrollmentEnded, studentEnrolled } from '../domain/events';
import {
  ACADEMIC_READ_MODEL,
  ACADEMIC_REPOSITORY,
  type AcademicReadModel,
  type AcademicRepository,
} from '../domain/ports';
import type { HalaqaId } from '../domain/structure';
import { AcademicAccess, HALAQA_NOT_FOUND } from './academic-access';
import { AcademicJournal } from './academic-journal';
import { AcademicPeople } from './academic-people';
import { AcademicAudit, AcademicPages, AcademicResources, pageLimit } from './academic-settings';
import { decodeCursor, paged } from './cursors';
import {
  enrollmentView,
  placementView,
  type EnrollmentView,
  type PageView,
  type PlacedEnrollmentView,
  type RosterEntryView,
} from './views';

const ENROLLMENT_NOT_FOUND = failure(
  'not_found',
  'academic.enrollment_not_found',
  'No such enrollment.',
);

export interface EnrolledView extends PlacedEnrollmentView {
  /** False when this person was already enrolled here: nothing new was made. */
  readonly created: boolean;
}

/**
 * Enrolling a student in a halaqa. An administrator's act (academic.manage):
 * students do not enroll themselves — whether they may is the institution's
 * decision (Q30), and nothing here invents a registration workflow.
 *
 *   the halaqa exists, and it, its program and its section are ACTIVE
 *     — checked again atomically by the write, so a concurrent deactivation
 *       cannot slip an enrollment into a closed halaqa;
 *   the account is ACTIVE and may study (`academic.study`), as identity decides;
 *   at most one ACTIVE enrollment per student and halaqa — the database's
 *     unique index, so a repeat or a race finds the one that exists (200)
 *     instead of making a second (201).
 *
 * Nothing limits how many halaqat, programs or sections someone may be in:
 * the profile states no such rule, so none is invented (Q30).
 */
@Injectable()
export class EnrollStudentUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly people: AcademicPeople,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly halaqaId: string;
    readonly studentUserId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<EnrolledView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage, {
      type: AcademicResources.halaqa,
      id: command.halaqaId,
    });
    if (!allowed.ok) return allowed;
    if ((await this.repository.findHalaqa(command.halaqaId)) === null) {
      return err(HALAQA_NOT_FOUND);
    }
    const eligible = await this.people.eligible(
      [command.studentUserId],
      Permissions.academic.study,
    );
    if (!eligible.has(command.studentUserId)) {
      // An unknown id and an ineligible account read the same: no probing.
      return err(
        failure(
          'validation',
          'academic.student_not_eligible',
          'This account cannot be enrolled: it is not an active student account.',
        ),
      );
    }

    const outcome = await this.repository.enroll(
      newEnrollment({
        id: this.ids.next<'AcademicEnrollment'>(),
        studentUserId: command.studentUserId,
        halaqaId: command.halaqaId as HalaqaId,
        enrolledBy: this.access.actorOf(command.principal),
        at: this.clock.now(),
      }),
    );
    switch (outcome.kind) {
      case 'halaqa_not_found':
        return err(HALAQA_NOT_FOUND);
      case 'closed':
        return err(outcome.failure);
      case 'existing':
        return ok({
          enrollment: enrollmentView(outcome.enrollment),
          placement: placementView(outcome.placement),
          created: false,
        });
      case 'created':
        break;
    }

    const { enrollment, placement } = outcome;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.studentEnrolled,
        resourceType: AcademicResources.enrollment,
        resourceId: enrollment.id,
        at: enrollment.enrolledAt,
        metadata: { studentUserId: enrollment.studentUserId, halaqaId: enrollment.halaqaId },
        correlationId: command.meta.correlationId,
      },
      studentEnrolled(enrollment, placement, command.meta.correlationId),
    );
    return ok({
      enrollment: enrollmentView(enrollment),
      placement: placementView(placement),
      created: true,
    });
  }
}

/**
 * Ending an enrollment — COMPLETED or WITHDRAWN, as the institution decides;
 * what either requires is its policy (Q30), not a rule here. The record
 * stays, as history. Ending it the same way again is a harmless retry;
 * ending it another way is refused rather than rewriting what happened.
 * Neither outcome describes a move (placement correction, support, ضخ,
 * merge): Q37. A move is not recorded through this until that is answered.
 */
@Injectable()
export class EndEnrollmentUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly enrollmentId: string;
    readonly outcome: string;
    readonly meta: CallMetadata;
  }): Promise<Result<EnrollmentView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage, {
      type: AcademicResources.enrollment,
      id: command.enrollmentId,
    });
    if (!allowed.ok) return allowed;
    if (!isEnrollmentOutcome(command.outcome)) {
      return err(
        failure(
          'validation',
          'academic.outcome_invalid',
          'An enrollment ends as COMPLETED or WITHDRAWN.',
          { field: 'outcome' },
        ),
      );
    }
    const outcome = command.outcome;
    const result = await this.repository.endEnrollment(
      command.enrollmentId,
      outcome,
      this.access.actorOf(command.principal),
      this.clock.now(),
    );
    if (result.kind === 'not_found') return err(ENROLLMENT_NOT_FOUND);
    if (result.kind === 'not_active') {
      const settled = alreadyEnded(result.entity, outcome);
      return settled.ok ? ok(enrollmentView(settled.value)) : settled;
    }

    const enrollment = result.entity;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.enrollmentEnded,
        resourceType: AcademicResources.enrollment,
        resourceId: enrollment.id,
        at: enrollment.endedAt ?? enrollment.updatedAt,
        metadata: {
          studentUserId: enrollment.studentUserId,
          halaqaId: enrollment.halaqaId,
          outcome,
        },
        correlationId: command.meta.correlationId,
      },
      enrollmentEnded({ ...enrollment, status: outcome }, command.meta.correlationId),
    );
    return ok(enrollmentView(enrollment));
  }
}

function statusFilter(raw: string | undefined): Result<EnrollmentStatus> {
  if (raw === undefined) return ok('ACTIVE');
  if ((ENROLLMENT_STATUSES as readonly string[]).includes(raw)) return ok(raw as EnrollmentStatus);
  return err(
    failure(
      'validation',
      'academic.status_filter_invalid',
      'List by status ACTIVE, COMPLETED or WITHDRAWN.',
      { field: 'status' },
    ),
  );
}

/**
 * Who is in a halaqa — its students, by status (ACTIVE unless asked
 * otherwise), in enrollment order, a page at a time, each with a display
 * name from identity: one enrollment query and one directory call per page.
 *
 * Visible to the halaqa's own teachers and to academic administrators only.
 */
@Injectable()
export class ListHalaqaStudentsUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly people: AcademicPeople,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly halaqaId: string;
    readonly status?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<PageView<RosterEntryView>>> {
    const reader = await this.access.halaqaMembers(command.principal, command.halaqaId);
    if (!reader.ok) return reader;
    const status = statusFilter(command.status);
    if (!status.ok) return status;
    const after = decodeCursor(command.cursor);
    if (!after.ok) return after;
    const limit = pageLimit(command.limit, AcademicPages.roster);

    const rows = await this.readModel.roster(command.halaqaId, status.value, {
      after: after.value,
      limit: limit + 1,
    });
    const page = paged(rows, limit, (row) => ({ at: row.enrolledAt, id: row.id }));
    const people = await this.people.describe(page.items.map((row) => row.studentUserId));
    return ok({
      items: page.items.map((row) => ({
        enrollment: enrollmentView(row),
        student: people.get(row.studentUserId) ?? {
          userId: row.studentUserId,
          displayName: null,
          active: false,
        },
      })),
      nextCursor: page.nextCursor,
    });
  }
}

/**
 * A student's enrollments — every status, newest first — for academic
 * administrators. (A student reads their own through /academic/me.)
 */
@Injectable()
export class ListStudentEnrollmentsUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly studentUserId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<PageView<PlacedEnrollmentView>>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage);
    if (!allowed.ok) return allowed;
    return enrollmentHistory(this.readModel, command.studentUserId, command);
  }
}

/** One page of someone's enrollments, newest first, each with where it sits. */
export async function enrollmentHistory(
  readModel: AcademicReadModel,
  studentUserId: string,
  request: { readonly cursor?: string; readonly limit?: number },
): Promise<Result<PageView<PlacedEnrollmentView>>> {
  const before = decodeCursor(request.cursor);
  if (!before.ok) return before;
  const limit = pageLimit(request.limit, AcademicPages.history);
  const rows = await readModel.enrollmentsOf(studentUserId, {
    before: before.value,
    limit: limit + 1,
  });
  const page = paged(rows, limit, (row) => ({
    at: row.enrollment.enrolledAt,
    id: row.enrollment.id,
  }));
  return ok({
    items: page.items.map((row) => ({
      enrollment: enrollmentView(row.enrollment),
      placement: placementView(row),
    })),
    nextCursor: page.nextCursor,
  });
}
