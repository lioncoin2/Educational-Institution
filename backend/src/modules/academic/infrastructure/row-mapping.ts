import type { Enrollment, EnrollmentId } from '../domain/enrollment';
import type { Halaqa, HalaqaId, Program, ProgramId, Section, SectionId } from '../domain/structure';
import type { TeacherAssignment, TeacherAssignmentId } from '../domain/teacher-assignment';
import type {
  academicEnrollments,
  academicHalaqat,
  academicPrograms,
  academicSections,
  academicTeacherAssignments,
} from './schema';

type SectionRow = typeof academicSections.$inferSelect;
type ProgramRow = typeof academicPrograms.$inferSelect;
type HalaqaRow = typeof academicHalaqat.$inferSelect;
type EnrollmentRow = typeof academicEnrollments.$inferSelect;
type AssignmentRow = typeof academicTeacherAssignments.$inferSelect;

/** Rows ⇄ entities, field by field — nothing a row carries is passed through unnamed. */

export function toSection(row: SectionRow): Section {
  return {
    id: row.id as SectionId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    order: row.sortOrder,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function sectionRow(section: Section): SectionRow {
  return {
    id: section.id,
    code: section.code,
    name: section.name,
    kind: section.kind,
    sortOrder: section.order,
    description: section.description,
    status: section.status,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
  };
}

export function toProgram(row: ProgramRow): Program {
  return {
    id: row.id as ProgramId,
    code: row.code,
    sectionId: row.sectionId as SectionId,
    name: row.name,
    order: row.sortOrder,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function programRow(program: Program): ProgramRow {
  return {
    id: program.id,
    code: program.code,
    sectionId: program.sectionId,
    name: program.name,
    sortOrder: program.order,
    description: program.description,
    status: program.status,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
}

export function toHalaqa(row: HalaqaRow): Halaqa {
  return {
    id: row.id as HalaqaId,
    code: row.code,
    programId: row.programId as ProgramId,
    name: row.name,
    order: row.sortOrder,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function halaqaRow(halaqa: Halaqa): HalaqaRow {
  return {
    id: halaqa.id,
    code: halaqa.code,
    programId: halaqa.programId,
    name: halaqa.name,
    sortOrder: halaqa.order,
    status: halaqa.status,
    createdAt: halaqa.createdAt,
    updatedAt: halaqa.updatedAt,
  };
}

export function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id as EnrollmentId,
    studentUserId: row.studentUserId,
    halaqaId: row.halaqaId as HalaqaId,
    status: row.status,
    enrolledAt: row.enrolledAt,
    enrolledBy: row.enrolledBy,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
    updatedAt: row.updatedAt,
  };
}

export function enrollmentRow(enrollment: Enrollment): EnrollmentRow {
  return {
    id: enrollment.id,
    studentUserId: enrollment.studentUserId,
    halaqaId: enrollment.halaqaId,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt,
    enrolledBy: enrollment.enrolledBy,
    endedAt: enrollment.endedAt,
    endedBy: enrollment.endedBy,
    createdAt: enrollment.enrolledAt,
    updatedAt: enrollment.updatedAt,
  };
}

export function toAssignment(row: AssignmentRow): TeacherAssignment {
  return {
    id: row.id as TeacherAssignmentId,
    halaqaId: row.halaqaId as HalaqaId,
    teacherUserId: row.teacherUserId,
    role: row.role,
    status: row.status,
    startedAt: row.startedAt,
    assignedBy: row.assignedBy,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
  };
}

export function assignmentRow(assignment: TeacherAssignment): AssignmentRow {
  return {
    id: assignment.id,
    halaqaId: assignment.halaqaId,
    teacherUserId: assignment.teacherUserId,
    role: assignment.role,
    status: assignment.status,
    startedAt: assignment.startedAt,
    assignedBy: assignment.assignedBy,
    endedAt: assignment.endedAt,
    endedBy: assignment.endedBy,
    createdAt: assignment.startedAt,
  };
}
