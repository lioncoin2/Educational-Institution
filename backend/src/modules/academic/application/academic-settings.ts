/**
 * What academic records in the audit trail: every change to the structure,
 * to who is enrolled, and to who teaches — never a read. Entries carry ids,
 * codes, statuses and field names; never a person's name.
 */
export const AcademicAudit = {
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

export const AcademicResources = {
  section: 'academic.section',
  program: 'academic.program',
  halaqa: 'academic.halaqa',
  enrollment: 'academic.enrollment',
  teacherAssignment: 'academic.teacher_assignment',
} as const;

/** Page sizes: a default, and a ceiling no request can raise. */
export const AcademicPages = {
  roster: { default: 50, max: 200 },
  teachers: { default: 50, max: 200 },
  history: { default: 20, max: 100 },
} as const;

export function pageLimit(
  requested: number | undefined,
  limits: { readonly default: number; readonly max: number },
): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return limits.default;
  }
  return Math.min(requested, limits.max);
}
