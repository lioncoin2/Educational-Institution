import type { DomainEvent } from '../../../shared/domain-event';
import type { EnrollmentOutcome, SectionKind, StructureStatus, TeachingRole } from './vocabulary';

/**
 * Facts academic publishes — after the database has them. No subscriber acts
 * on them yet: notifications, attendance and reporting will, once their
 * policies are decided (open-questions.md Q28, Q30).
 *
 * Payloads carry identifiers, codes and statuses only — never a name, an
 * email or any other personal detail. A subscriber that needs more asks
 * academic's contracts (and identity's, for people).
 *
 * `aggregateId` is the entity itself for structure events, and the HALAQA for
 * enrollment and teaching events: one halaqa's roster is one stream, so its
 * changes keep their order on any future partitioned transport.
 */
export const AcademicEvents = {
  sectionCreated: 'academic.section.created',
  sectionUpdated: 'academic.section.updated',
  sectionActivated: 'academic.section.activated',
  sectionDeactivated: 'academic.section.deactivated',
  programCreated: 'academic.program.created',
  programUpdated: 'academic.program.updated',
  programActivated: 'academic.program.activated',
  programDeactivated: 'academic.program.deactivated',
  halaqaCreated: 'academic.halaqa.created',
  halaqaUpdated: 'academic.halaqa.updated',
  halaqaActivated: 'academic.halaqa.activated',
  halaqaDeactivated: 'academic.halaqa.deactivated',
  studentEnrolled: 'academic.student.enrolled',
  enrollmentEnded: 'academic.student.enrollment_ended',
  teacherAssigned: 'academic.teacher.assigned',
  assignmentEnded: 'academic.teacher.assignment_ended',
} as const;

/** Which descriptive fields an update changed — names, never values. */
export type StructureField = 'name' | 'order' | 'description';

export type SectionCreated = DomainEvent<
  typeof AcademicEvents.sectionCreated,
  {
    readonly sectionId: string;
    readonly code: string;
    readonly kind: SectionKind;
    readonly status: StructureStatus;
  }
>;

export type SectionUpdated = DomainEvent<
  typeof AcademicEvents.sectionUpdated,
  { readonly sectionId: string; readonly changed: readonly StructureField[] }
>;

export type SectionStatusChanged = DomainEvent<
  typeof AcademicEvents.sectionActivated | typeof AcademicEvents.sectionDeactivated,
  { readonly sectionId: string }
>;

export type ProgramCreated = DomainEvent<
  typeof AcademicEvents.programCreated,
  {
    readonly programId: string;
    readonly sectionId: string;
    readonly code: string;
    readonly status: StructureStatus;
  }
>;

export type ProgramUpdated = DomainEvent<
  typeof AcademicEvents.programUpdated,
  {
    readonly programId: string;
    readonly sectionId: string;
    readonly changed: readonly StructureField[];
  }
>;

export type ProgramStatusChanged = DomainEvent<
  typeof AcademicEvents.programActivated | typeof AcademicEvents.programDeactivated,
  { readonly programId: string; readonly sectionId: string }
>;

export type HalaqaCreated = DomainEvent<
  typeof AcademicEvents.halaqaCreated,
  {
    readonly halaqaId: string;
    readonly programId: string;
    readonly code: string;
    readonly status: StructureStatus;
  }
>;

export type HalaqaUpdated = DomainEvent<
  typeof AcademicEvents.halaqaUpdated,
  {
    readonly halaqaId: string;
    readonly programId: string;
    readonly changed: readonly StructureField[];
  }
>;

export type HalaqaStatusChanged = DomainEvent<
  typeof AcademicEvents.halaqaActivated | typeof AcademicEvents.halaqaDeactivated,
  { readonly halaqaId: string; readonly programId: string }
>;

export type StudentEnrolled = DomainEvent<
  typeof AcademicEvents.studentEnrolled,
  {
    readonly enrollmentId: string;
    readonly studentUserId: string;
    readonly halaqaId: string;
    readonly programId: string;
    readonly sectionId: string;
  }
>;

export type EnrollmentEnded = DomainEvent<
  typeof AcademicEvents.enrollmentEnded,
  {
    readonly enrollmentId: string;
    readonly studentUserId: string;
    readonly halaqaId: string;
    readonly outcome: EnrollmentOutcome;
  }
>;

export type TeacherAssigned = DomainEvent<
  typeof AcademicEvents.teacherAssigned,
  {
    readonly assignmentId: string;
    readonly teacherUserId: string;
    readonly halaqaId: string;
    readonly role: TeachingRole;
  }
>;

export type AssignmentEnded = DomainEvent<
  typeof AcademicEvents.assignmentEnded,
  {
    readonly assignmentId: string;
    readonly teacherUserId: string;
    readonly halaqaId: string;
  }
>;

export type AcademicEvent =
  | SectionCreated
  | SectionUpdated
  | SectionStatusChanged
  | ProgramCreated
  | ProgramUpdated
  | ProgramStatusChanged
  | HalaqaCreated
  | HalaqaUpdated
  | HalaqaStatusChanged
  | StudentEnrolled
  | EnrollmentEnded
  | TeacherAssigned
  | AssignmentEnded;
