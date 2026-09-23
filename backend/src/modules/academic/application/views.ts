import type {
  AssignmentStatus,
  EnrollmentStatus,
  SectionKind,
  StructureStatus,
  TeachingRole,
} from '../contracts/vocabulary';
import type { Enrollment } from '../domain/enrollment';
import type { Placement } from '../domain/ports';
import type { Halaqa, Program, Section } from '../domain/structure';
import type { TeacherAssignment } from '../domain/teacher-assignment';

/**
 * What academic's use cases return — built field by field from entities.
 *
 * Who enrolled or assigned someone (`enrolledBy`, `endedBy`, …) is
 * administrative metadata: it is in the audit trail and never in a view.
 */

export interface SectionView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: SectionKind;
  readonly order: number;
  readonly description: string | null;
  readonly status: StructureStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProgramView {
  readonly id: string;
  readonly code: string;
  readonly sectionId: string;
  readonly name: string;
  readonly order: number;
  readonly description: string | null;
  readonly status: StructureStatus;
  /** How many of its halaqat are ACTIVE. */
  readonly activeHalaqaCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface HalaqaView {
  readonly id: string;
  readonly code: string;
  readonly programId: string;
  readonly name: string;
  readonly order: number;
  readonly status: StructureStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A section with its programs — one entry of the catalogue. */
export interface CatalogueSectionView extends SectionView {
  readonly programs: readonly ProgramView[];
}

export interface ProgramDetailView {
  readonly program: ProgramView;
  readonly section: SectionView;
  readonly halaqat: readonly HalaqaView[];
}

/** Where something sits, briefly — enough to show and to link. */
export interface SectionRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: SectionKind;
  readonly order: number;
  readonly status: StructureStatus;
}

export interface ProgramRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly order: number;
  readonly status: StructureStatus;
}

export interface HalaqaRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly order: number;
  readonly status: StructureStatus;
}

export interface PlacementView {
  readonly section: SectionRef;
  readonly program: ProgramRef;
  readonly halaqa: HalaqaRef;
}

export interface HalaqaDetailView {
  readonly halaqa: HalaqaView;
  readonly program: ProgramRef;
  readonly section: SectionRef;
}

export interface EnrollmentView {
  readonly id: string;
  readonly studentUserId: string;
  readonly halaqaId: string;
  readonly status: EnrollmentStatus;
  readonly enrolledAt: Date;
  readonly endedAt: Date | null;
}

export interface AssignmentView {
  readonly id: string;
  readonly halaqaId: string;
  readonly teacherUserId: string;
  readonly role: TeachingRole;
  readonly status: AssignmentStatus;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

/**
 * Someone as academic shows them: a display name from identity — never an
 * email or other identifier — and whether their account can sign in. An
 * account identity no longer knows shows as `displayName: null`.
 */
export interface PersonView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly active: boolean;
}

export interface RosterEntryView {
  readonly enrollment: EnrollmentView;
  readonly student: PersonView;
}

export interface TeacherEntryView {
  readonly assignment: AssignmentView;
  readonly teacher: PersonView;
}

export interface PlacedEnrollmentView {
  readonly enrollment: EnrollmentView;
  readonly placement: PlacementView;
}

export interface PlacedAssignmentView {
  readonly assignment: AssignmentView;
  readonly placement: PlacementView;
}

/** A teacher as their student sees them: a name and a role — no account state. */
export interface MyTeacherView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly role: TeachingRole;
}

export interface MyEnrollmentView extends PlacedEnrollmentView {
  readonly teachers: readonly MyTeacherView[];
}

/** The caller's own academic relationships, now. */
export interface MyAcademicView {
  readonly enrollments: readonly MyEnrollmentView[];
  readonly teaching: readonly PlacedAssignmentView[];
  /** True when there were more ACTIVE relationships than listed; the paged histories have all. */
  readonly truncated: boolean;
}

export interface PageView<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function sectionView(section: Section): SectionView {
  return {
    id: section.id,
    code: section.code,
    name: section.name,
    kind: section.kind,
    order: section.order,
    description: section.description,
    status: section.status,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
  };
}

export function programView(program: Program, activeHalaqaCount: number): ProgramView {
  return {
    id: program.id,
    code: program.code,
    sectionId: program.sectionId,
    name: program.name,
    order: program.order,
    description: program.description,
    status: program.status,
    activeHalaqaCount,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
}

export function halaqaView(halaqa: Halaqa): HalaqaView {
  return {
    id: halaqa.id,
    code: halaqa.code,
    programId: halaqa.programId,
    name: halaqa.name,
    order: halaqa.order,
    status: halaqa.status,
    createdAt: halaqa.createdAt,
    updatedAt: halaqa.updatedAt,
  };
}

export function placementView(placement: Placement): PlacementView {
  const { section, program, halaqa } = placement;
  return {
    section: {
      id: section.id,
      code: section.code,
      name: section.name,
      kind: section.kind,
      order: section.order,
      status: section.status,
    },
    program: {
      id: program.id,
      code: program.code,
      name: program.name,
      order: program.order,
      status: program.status,
    },
    halaqa: {
      id: halaqa.id,
      code: halaqa.code,
      name: halaqa.name,
      order: halaqa.order,
      status: halaqa.status,
    },
  };
}

export function enrollmentView(enrollment: Enrollment): EnrollmentView {
  return {
    id: enrollment.id,
    studentUserId: enrollment.studentUserId,
    halaqaId: enrollment.halaqaId,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt,
    endedAt: enrollment.endedAt,
  };
}

export function assignmentView(assignment: TeacherAssignment): AssignmentView {
  return {
    id: assignment.id,
    halaqaId: assignment.halaqaId,
    teacherUserId: assignment.teacherUserId,
    role: assignment.role,
    status: assignment.status,
    startedAt: assignment.startedAt,
    endedAt: assignment.endedAt,
  };
}
