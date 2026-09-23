import { domainEvent } from '../../../shared/domain-event';
import {
  AcademicEvents,
  type AssignmentEnded,
  type EnrollmentEnded,
  type HalaqaCreated,
  type HalaqaStatusChanged,
  type HalaqaUpdated,
  type ProgramCreated,
  type ProgramStatusChanged,
  type ProgramUpdated,
  type SectionCreated,
  type SectionStatusChanged,
  type SectionUpdated,
  type StructureField,
  type StudentEnrolled,
  type TeacherAssigned,
} from '../contracts/events';
import type { EnrollmentOutcome } from '../contracts/vocabulary';
import type { Enrollment } from './enrollment';
import type { Halaqa, Program, Section } from './structure';
import type { TeacherAssignment } from './teacher-assignment';

/** Every payload is ids, codes and statuses — built field by field, never spread from an entity. */

export function sectionCreated(section: Section, correlationId?: string): SectionCreated {
  return domainEvent(
    AcademicEvents.sectionCreated,
    section.id,
    { sectionId: section.id, code: section.code, kind: section.kind, status: section.status },
    section.createdAt,
    correlationId,
  );
}

export function sectionUpdated(
  section: Section,
  changed: readonly StructureField[],
  correlationId?: string,
): SectionUpdated {
  return domainEvent(
    AcademicEvents.sectionUpdated,
    section.id,
    { sectionId: section.id, changed: [...changed] },
    section.updatedAt,
    correlationId,
  );
}

export function sectionStatusChanged(
  section: Section,
  correlationId?: string,
): SectionStatusChanged {
  return domainEvent(
    section.status === 'ACTIVE'
      ? AcademicEvents.sectionActivated
      : AcademicEvents.sectionDeactivated,
    section.id,
    { sectionId: section.id },
    section.updatedAt,
    correlationId,
  );
}

export function programCreated(program: Program, correlationId?: string): ProgramCreated {
  return domainEvent(
    AcademicEvents.programCreated,
    program.id,
    {
      programId: program.id,
      sectionId: program.sectionId,
      code: program.code,
      status: program.status,
    },
    program.createdAt,
    correlationId,
  );
}

export function programUpdated(
  program: Program,
  changed: readonly StructureField[],
  correlationId?: string,
): ProgramUpdated {
  return domainEvent(
    AcademicEvents.programUpdated,
    program.id,
    { programId: program.id, sectionId: program.sectionId, changed: [...changed] },
    program.updatedAt,
    correlationId,
  );
}

export function programStatusChanged(
  program: Program,
  correlationId?: string,
): ProgramStatusChanged {
  return domainEvent(
    program.status === 'ACTIVE'
      ? AcademicEvents.programActivated
      : AcademicEvents.programDeactivated,
    program.id,
    { programId: program.id, sectionId: program.sectionId },
    program.updatedAt,
    correlationId,
  );
}

export function halaqaCreated(halaqa: Halaqa, correlationId?: string): HalaqaCreated {
  return domainEvent(
    AcademicEvents.halaqaCreated,
    halaqa.id,
    {
      halaqaId: halaqa.id,
      programId: halaqa.programId,
      code: halaqa.code,
      status: halaqa.status,
    },
    halaqa.createdAt,
    correlationId,
  );
}

export function halaqaUpdated(
  halaqa: Halaqa,
  changed: readonly StructureField[],
  correlationId?: string,
): HalaqaUpdated {
  return domainEvent(
    AcademicEvents.halaqaUpdated,
    halaqa.id,
    { halaqaId: halaqa.id, programId: halaqa.programId, changed: [...changed] },
    halaqa.updatedAt,
    correlationId,
  );
}

export function halaqaStatusChanged(halaqa: Halaqa, correlationId?: string): HalaqaStatusChanged {
  return domainEvent(
    halaqa.status === 'ACTIVE' ? AcademicEvents.halaqaActivated : AcademicEvents.halaqaDeactivated,
    halaqa.id,
    { halaqaId: halaqa.id, programId: halaqa.programId },
    halaqa.updatedAt,
    correlationId,
  );
}

export function studentEnrolled(
  enrollment: Enrollment,
  placement: { readonly program: Program; readonly section: Section },
  correlationId?: string,
): StudentEnrolled {
  return domainEvent(
    AcademicEvents.studentEnrolled,
    enrollment.halaqaId,
    {
      enrollmentId: enrollment.id,
      studentUserId: enrollment.studentUserId,
      halaqaId: enrollment.halaqaId,
      programId: placement.program.id,
      sectionId: placement.section.id,
    },
    enrollment.enrolledAt,
    correlationId,
  );
}

export function enrollmentEnded(
  enrollment: Enrollment & { readonly status: EnrollmentOutcome },
  correlationId?: string,
): EnrollmentEnded {
  return domainEvent(
    AcademicEvents.enrollmentEnded,
    enrollment.halaqaId,
    {
      enrollmentId: enrollment.id,
      studentUserId: enrollment.studentUserId,
      halaqaId: enrollment.halaqaId,
      outcome: enrollment.status,
    },
    enrollment.endedAt ?? enrollment.updatedAt,
    correlationId,
  );
}

export function teacherAssigned(
  assignment: TeacherAssignment,
  correlationId?: string,
): TeacherAssigned {
  return domainEvent(
    AcademicEvents.teacherAssigned,
    assignment.halaqaId,
    {
      assignmentId: assignment.id,
      teacherUserId: assignment.teacherUserId,
      halaqaId: assignment.halaqaId,
      role: assignment.role,
    },
    assignment.startedAt,
    correlationId,
  );
}

export function assignmentEnded(
  assignment: TeacherAssignment,
  correlationId?: string,
): AssignmentEnded {
  return domainEvent(
    AcademicEvents.assignmentEnded,
    assignment.halaqaId,
    {
      assignmentId: assignment.id,
      teacherUserId: assignment.teacherUserId,
      halaqaId: assignment.halaqaId,
    },
    assignment.endedAt ?? assignment.startedAt,
    correlationId,
  );
}
