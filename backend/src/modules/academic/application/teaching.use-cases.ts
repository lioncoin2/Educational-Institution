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
  ASSIGNMENT_STATUSES,
  isTeachingRole,
  type AssignmentStatus,
} from '../contracts/vocabulary';
import { assignmentEnded, teacherAssigned } from '../domain/events';
import {
  ACADEMIC_READ_MODEL,
  ACADEMIC_REPOSITORY,
  type AcademicReadModel,
  type AcademicRepository,
} from '../domain/ports';
import type { HalaqaId } from '../domain/structure';
import { alreadyAssigned, newAssignment } from '../domain/teacher-assignment';
import { AcademicAccess, HALAQA_NOT_FOUND } from './academic-access';
import { AcademicJournal } from './academic-journal';
import { AcademicPeople } from './academic-people';
import { AcademicAudit, AcademicPages, AcademicResources, pageLimit } from './academic-settings';
import { decodeCursor, paged } from './cursors';
import {
  assignmentView,
  placementView,
  type AssignmentView,
  type PageView,
  type PlacedAssignmentView,
  type TeacherEntryView,
} from './views';

const ASSIGNMENT_NOT_FOUND = failure(
  'not_found',
  'academic.teacher_assignment_not_found',
  'No such teacher assignment.',
);

export interface AssignedView {
  readonly assignment: AssignmentView;
  /** False when this person already taught here in this role: nothing new was made. */
  readonly created: boolean;
}

/**
 * Assigning a teacher to a halaqa — contextual teaching authority: this, not
 * the TEACHER role, is what lets them see the halaqa's students.
 *
 *   the account is ACTIVE and may teach (`academic.teach`), as identity decides;
 *   the role in THIS halaqa is TEACHER or ASSISTANT_TEACHER;
 *   one ACTIVE assignment per teacher and halaqa (a unique index); a repeat
 *     in the same role finds it (200), another role is refused — end, then
 *     reassign, so history shows the change.
 *
 * A halaqa may have several teachers; one teacher may teach several halaqat.
 * Neither is limited, because the profile does not limit them (Q31). A
 * teacher may be assigned to an inactive halaqa — preparing one before it
 * opens is not forbidden anywhere.
 */
@Injectable()
export class AssignTeacherUseCase {
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
    readonly teacherUserId: string;
    readonly role: string;
    readonly meta: CallMetadata;
  }): Promise<Result<AssignedView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage, {
      type: AcademicResources.halaqa,
      id: command.halaqaId,
    });
    if (!allowed.ok) return allowed;
    if (!isTeachingRole(command.role)) {
      return err(
        failure(
          'validation',
          'academic.role_invalid',
          'A teaching role is TEACHER or ASSISTANT_TEACHER.',
          { field: 'role' },
        ),
      );
    }
    const role = command.role;
    if ((await this.repository.findHalaqa(command.halaqaId)) === null) {
      return err(HALAQA_NOT_FOUND);
    }
    const eligible = await this.people.eligible(
      [command.teacherUserId],
      Permissions.academic.teach,
    );
    if (!eligible.has(command.teacherUserId)) {
      return err(
        failure(
          'validation',
          'academic.teacher_not_eligible',
          'This account cannot be assigned to teach: it is not an active teaching account.',
        ),
      );
    }

    const outcome = await this.repository.assignTeacher(
      newAssignment({
        id: this.ids.next<'AcademicTeacherAssignment'>(),
        halaqaId: command.halaqaId as HalaqaId,
        teacherUserId: command.teacherUserId,
        role,
        assignedBy: this.access.actorOf(command.principal),
        at: this.clock.now(),
      }),
    );
    if (outcome.kind === 'halaqa_not_found') return err(HALAQA_NOT_FOUND);
    if (outcome.kind === 'existing') {
      const settled = alreadyAssigned(outcome.assignment, role);
      return settled.ok
        ? ok({ assignment: assignmentView(settled.value), created: false })
        : settled;
    }

    const assignment = outcome.assignment;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.teacherAssigned,
        resourceType: AcademicResources.teacherAssignment,
        resourceId: assignment.id,
        at: assignment.startedAt,
        metadata: {
          teacherUserId: assignment.teacherUserId,
          halaqaId: assignment.halaqaId,
          role: assignment.role,
        },
        correlationId: command.meta.correlationId,
      },
      teacherAssigned(assignment, command.meta.correlationId),
    );
    return ok({ assignment: assignmentView(assignment), created: true });
  }
}

/** Ending a teacher's assignment. It stays as history; ending it again is a harmless retry. */
@Injectable()
export class EndTeacherAssignmentUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly assignmentId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<AssignmentView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage, {
      type: AcademicResources.teacherAssignment,
      id: command.assignmentId,
    });
    if (!allowed.ok) return allowed;
    const result = await this.repository.endAssignment(
      command.assignmentId,
      this.access.actorOf(command.principal),
      this.clock.now(),
    );
    if (result.kind === 'not_found') return err(ASSIGNMENT_NOT_FOUND);
    if (result.kind === 'not_active') return ok(assignmentView(result.entity));

    const assignment = result.entity;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.assignmentEnded,
        resourceType: AcademicResources.teacherAssignment,
        resourceId: assignment.id,
        at: assignment.endedAt ?? assignment.startedAt,
        metadata: { teacherUserId: assignment.teacherUserId, halaqaId: assignment.halaqaId },
        correlationId: command.meta.correlationId,
      },
      assignmentEnded(assignment, command.meta.correlationId),
    );
    return ok(assignmentView(assignment));
  }
}

function statusFilter(raw: string | undefined): Result<AssignmentStatus> {
  if (raw === undefined) return ok('ACTIVE');
  if ((ASSIGNMENT_STATUSES as readonly string[]).includes(raw)) return ok(raw as AssignmentStatus);
  return err(
    failure('validation', 'academic.status_filter_invalid', 'List by status ACTIVE or ENDED.', {
      field: 'status',
    }),
  );
}

/**
 * A halaqa's teachers, by status (ACTIVE unless asked otherwise), oldest
 * assignment first, a page at a time, with display names from identity.
 * Visible to the halaqa's own teachers and to academic administrators.
 */
@Injectable()
export class ListHalaqaTeachersUseCase {
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
  }): Promise<Result<PageView<TeacherEntryView>>> {
    const reader = await this.access.halaqaMembers(command.principal, command.halaqaId);
    if (!reader.ok) return reader;
    const status = statusFilter(command.status);
    if (!status.ok) return status;
    const after = decodeCursor(command.cursor);
    if (!after.ok) return after;
    const limit = pageLimit(command.limit, AcademicPages.teachers);

    const rows = await this.readModel.teachersOf(command.halaqaId, status.value, {
      after: after.value,
      limit: limit + 1,
    });
    const page = paged(rows, limit, (row) => ({ at: row.startedAt, id: row.id }));
    const people = await this.people.describe(page.items.map((row) => row.teacherUserId));
    return ok({
      items: page.items.map((row) => ({
        assignment: assignmentView(row),
        teacher: people.get(row.teacherUserId) ?? {
          userId: row.teacherUserId,
          displayName: null,
          active: false,
        },
      })),
      nextCursor: page.nextCursor,
    });
  }
}

/** A teacher's assignments — every status, newest first — for academic administrators. */
@Injectable()
export class ListTeacherAssignmentsUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly teacherUserId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<PageView<PlacedAssignmentView>>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage);
    if (!allowed.ok) return allowed;
    return assignmentHistory(this.readModel, command.teacherUserId, command);
  }
}

/** One page of someone's assignments, newest first, each with where it sits. */
export async function assignmentHistory(
  readModel: AcademicReadModel,
  teacherUserId: string,
  request: { readonly cursor?: string; readonly limit?: number },
): Promise<Result<PageView<PlacedAssignmentView>>> {
  const before = decodeCursor(request.cursor);
  if (!before.ok) return before;
  const limit = pageLimit(request.limit, AcademicPages.history);
  const rows = await readModel.assignmentsOf(teacherUserId, {
    before: before.value,
    limit: limit + 1,
  });
  const page = paged(rows, limit, (row) => ({
    at: row.assignment.startedAt,
    id: row.assignment.id,
  }));
  return ok({
    items: page.items.map((row) => ({
      assignment: assignmentView(row.assignment),
      placement: placementView(row),
    })),
    nextCursor: page.nextCursor,
  });
}
