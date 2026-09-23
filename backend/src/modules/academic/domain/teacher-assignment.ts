import type { Id } from '../../../shared/identifier';
import { err, failure, ok, type Result } from '../../../shared/result';
import type { AssignmentStatus, TeachingRole } from '../contracts/vocabulary';
import type { HalaqaId } from './structure';

export type TeacherAssignmentId = Id<'AcademicTeacherAssignment'>;

/**
 * That a teacher account teaches one halaqa, in one role, from a date.
 *
 * Teaching authority is contextual: this record — not the TEACHER role, not
 * `academic.teach` — is what lets a teacher see a halaqa's students. A halaqa
 * may have several teachers; the same person holds at most one ACTIVE
 * assignment per halaqa.
 *
 * Never deleted: it ends, and stays as history.
 */
export interface TeacherAssignment {
  readonly id: TeacherAssignmentId;
  readonly halaqaId: HalaqaId;
  readonly teacherUserId: string;
  readonly role: TeachingRole;
  readonly status: AssignmentStatus;
  readonly startedAt: Date;
  readonly assignedBy: string | null;
  readonly endedAt: Date | null;
  readonly endedBy: string | null;
}

export function newAssignment(input: {
  readonly id: TeacherAssignmentId;
  readonly halaqaId: HalaqaId;
  readonly teacherUserId: string;
  readonly role: TeachingRole;
  readonly assignedBy: string | null;
  readonly at: Date;
}): TeacherAssignment {
  return {
    id: input.id,
    halaqaId: input.halaqaId,
    teacherUserId: input.teacherUserId,
    role: input.role,
    status: 'ACTIVE',
    startedAt: input.at,
    assignedBy: input.assignedBy,
    endedAt: null,
    endedBy: null,
  };
}

/** The ACTIVE → ENDED transition, as data — applied atomically by the repository. */
export function assignmentEnded(
  assignment: TeacherAssignment,
  by: string | null,
  at: Date,
): TeacherAssignment {
  const endedAt = at < assignment.startedAt ? assignment.startedAt : at;
  return { ...assignment, status: 'ENDED', endedAt, endedBy: by };
}

/**
 * Asked to assign someone already teaching the halaqa. In the same role it is
 * a retry and succeeds; in another role it is refused — a role is changed by
 * ending the assignment and making a new one, so history shows both.
 */
export function alreadyAssigned(
  existing: TeacherAssignment,
  role: TeachingRole,
): Result<TeacherAssignment> {
  if (existing.role === role) return ok(existing);
  return err(
    failure(
      'conflict',
      'academic.teacher_already_assigned',
      'This person already teaches this halaqa in another role. End that assignment first.',
      { role: existing.role },
    ),
  );
}
