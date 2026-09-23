import { Inject, Injectable } from '@nestjs/common';

import { ok, type Principal, type Result } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { AcademicLimits } from '../domain/academic-policy';
import { ACADEMIC_READ_MODEL, type AcademicReadModel } from '../domain/ports';
import { AcademicAccess } from './academic-access';
import { AcademicPeople } from './academic-people';
import { enrollmentHistory } from './enrollment.use-cases';
import { assignmentHistory } from './teaching.use-cases';
import {
  assignmentView,
  enrollmentView,
  placementView,
  type MyAcademicView,
  type PageView,
  type PlacedAssignmentView,
  type PlacedEnrollmentView,
} from './views';

/**
 * The caller's own academic relationships, now: the halaqat they are enrolled
 * in (with where each sits, and who teaches it) and the halaqat they teach.
 *
 * Always the caller's — there is no id to pass, so no one else's record can be
 * asked for. A student sees their own halaqa's teachers by name and role;
 * never their classmates, nobody's account state, and no administrative
 * metadata (who enrolled whom).
 *
 * Nothing here is progress: there is no percentage and no "completed 3 of
 * 10", because no progress is recorded yet.
 */
@Injectable()
export class GetMyAcademicUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly people: AcademicPeople,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: { readonly principal: Principal }): Promise<Result<MyAcademicView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read);
    if (!allowed.ok) return allowed;
    const bound = AcademicLimits.myActiveRelationships;
    const userId = command.principal.userId;

    const enrolled = await this.readModel.activeEnrollmentsOf(userId, bound + 1);
    const teaching = await this.readModel.activeAssignmentsOf(userId, bound + 1);
    const enrollments = enrolled.slice(0, bound);

    const teachers = await this.readModel.activeTeachersOf(enrollments.map((row) => row.halaqa.id));
    const names = await this.people.describe(teachers.map((row) => row.teacherUserId));

    return ok({
      enrollments: enrollments.map((row) => ({
        enrollment: enrollmentView(row.enrollment),
        placement: placementView(row),
        teachers: teachers
          .filter((assignment) => assignment.halaqaId === row.halaqa.id)
          .map((assignment) => ({
            userId: assignment.teacherUserId,
            displayName: names.get(assignment.teacherUserId)?.displayName ?? null,
            role: assignment.role,
          })),
      })),
      teaching: teaching.slice(0, bound).map((row) => ({
        assignment: assignmentView(row.assignment),
        placement: placementView(row),
      })),
      truncated: enrolled.length > bound || teaching.length > bound,
    });
  }
}

/** The caller's enrollments — every status, newest first: their academic history. */
@Injectable()
export class ListMyEnrollmentsUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<PageView<PlacedEnrollmentView>>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read);
    if (!allowed.ok) return allowed;
    return enrollmentHistory(this.readModel, command.principal.userId, command);
  }
}

/** The caller's teaching assignments — every status, newest first. */
@Injectable()
export class ListMyTeachingUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<PageView<PlacedAssignmentView>>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read);
    if (!allowed.ok) return allowed;
    return assignmentHistory(this.readModel, command.principal.userId, command);
  }
}
