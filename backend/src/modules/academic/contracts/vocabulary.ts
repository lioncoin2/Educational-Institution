/**
 * Academic vocabulary — the codes other modules and clients may rely on.
 *
 * The hierarchy is Section → Program → Halaqa. A halaqa (الحلقة) is the unit
 * the institution teaches in: a specific group within a program, which is the
 * educational offering, within a section, the top-level educational area.
 */

/**
 * What kind of area a section is — as the printed institution profile groups
 * them (the owner's seven core sections are not yet mapped onto these: Q35):
 *
 *   PROGRESSIVE    the graded sections of profile page 6 (محو الأمية … تجويد متقدم)
 *   SPECIAL        the sections with their own pages: التهجي، البراعم، اللغات (pp. 7–9)
 *   ACCOMPANYING   البرامج المرافقة (page 10) — the programs that accompany the sections
 *
 * Whether the PROGRESSIVE sections must be taken in order is NOT decided here
 * (open-questions.md Q29); `order` is their position, not a prerequisite.
 */
export const SECTION_KINDS = ['PROGRESSIVE', 'SPECIAL', 'ACCOMPANYING'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/**
 * Sections, programs and halaqat are never deleted — history refers to them.
 * INACTIVE means "accepts no new enrollment"; what exists stays readable.
 */
export const STRUCTURE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type StructureStatus = (typeof STRUCTURE_STATUSES)[number];

/**
 * An enrollment is ACTIVE until it is ended, explicitly, one way or the other.
 * An ended enrollment is history and is never reopened: enrolling again makes
 * a new one. What "completed" requires is the institution's to say (Q30).
 */
export const ENROLLMENT_STATUSES = ['ACTIVE', 'COMPLETED', 'WITHDRAWN'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/**
 * How an enrollment may end. Provisional (Q30), and known NOT to cover every
 * ending the institution describes: a placement correction, a support move, a
 * move under «نظام الضخ بين الأقسام» or a merge is neither (Q37). An ended
 * outcome is never rewritten, so those moves are not recorded as either one
 * until Q37 is answered.
 */
export const ENROLLMENT_OUTCOMES = ['COMPLETED', 'WITHDRAWN'] as const;
export type EnrollmentOutcome = (typeof ENROLLMENT_OUTCOMES)[number];

/**
 * Someone's role IN ONE HALAQA — named after the institution's existing roles.
 * It is contextual: holding the TEACHER role (or `academic.teach`) never means
 * teaching every halaqa; an assignment does, for that halaqa only.
 */
export const TEACHING_ROLES = ['TEACHER', 'ASSISTANT_TEACHER'] as const;
export type TeachingRole = (typeof TEACHING_ROLES)[number];

export const ASSIGNMENT_STATUSES = ['ACTIVE', 'ENDED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export function isSectionKind(value: unknown): value is SectionKind {
  return typeof value === 'string' && (SECTION_KINDS as readonly string[]).includes(value);
}

export function isEnrollmentOutcome(value: unknown): value is EnrollmentOutcome {
  return typeof value === 'string' && (ENROLLMENT_OUTCOMES as readonly string[]).includes(value);
}

export function isTeachingRole(value: unknown): value is TeachingRole {
  return typeof value === 'string' && (TEACHING_ROLES as readonly string[]).includes(value);
}
