import type { Failure } from '../../../shared/result';
import type {
  AssignmentStatus,
  EnrollmentOutcome,
  EnrollmentStatus,
  StructureStatus,
} from '../contracts/vocabulary';
import type { Enrollment } from './enrollment';
import type { Halaqa, Program, Section } from './structure';
import type { TeacherAssignment } from './teacher-assignment';

export const ACADEMIC_REPOSITORY = Symbol('ACADEMIC_REPOSITORY');
export const ACADEMIC_READ_MODEL = Symbol('ACADEMIC_READ_MODEL');

/** Where a halaqa sits: the halaqa, its program and that program's section. */
export interface Placement {
  readonly section: Section;
  readonly program: Program;
  readonly halaqa: Halaqa;
}

export interface PlacedEnrollment extends Placement {
  readonly enrollment: Enrollment;
}

export interface PlacedAssignment extends Placement {
  readonly assignment: TeacherAssignment;
}

/** A position in a list ordered by (instant, id). */
export interface Keyset {
  readonly at: Date;
  readonly id: string;
}

export type CreateOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'code_taken' }
  | { readonly kind: 'parent_not_found' }
  | { readonly kind: 'limit_reached'; readonly limit: number };

export type StatusOutcome<T> =
  | { readonly kind: 'changed'; readonly entity: T }
  | { readonly kind: 'unchanged'; readonly entity: T }
  | { readonly kind: 'not_found' };

export type EnrollOutcome =
  | { readonly kind: 'created'; readonly enrollment: Enrollment; readonly placement: Placement }
  | { readonly kind: 'existing'; readonly enrollment: Enrollment; readonly placement: Placement }
  | { readonly kind: 'halaqa_not_found' }
  /** Section, program or halaqa not ACTIVE — the reason, from `openForEnrollment`. */
  | { readonly kind: 'closed'; readonly failure: Failure };

export type AssignOutcome =
  | { readonly kind: 'created'; readonly assignment: TeacherAssignment }
  | { readonly kind: 'existing'; readonly assignment: TeacherAssignment }
  | { readonly kind: 'halaqa_not_found' };

export type EndOutcome<T> =
  | { readonly kind: 'ended'; readonly entity: T }
  | { readonly kind: 'not_active'; readonly entity: T }
  | { readonly kind: 'not_found' };

/**
 * Academic's writes, and the reads its rules need. Every invariant that must
 * hold under concurrency is decided here, atomically — by a unique index or a
 * row lock in Postgres, by the single thread in memory — never by a check in
 * the use case followed by a separate write.
 */
export interface AcademicRepository {
  findSection(id: string): Promise<Section | null>;
  findProgram(id: string): Promise<Program | null>;
  findHalaqa(id: string): Promise<Halaqa | null>;
  /** The halaqa with its program and section, in one read. */
  placement(halaqaId: string): Promise<Placement | null>;
  sectionByCode(code: string): Promise<Section | null>;
  programByCode(code: string): Promise<Program | null>;
  halaqaByCode(code: string): Promise<Halaqa | null>;

  /** Codes are unique per kind of entity; `limit` caps the siblings (AcademicLimits). */
  createSection(section: Section, limit: number): Promise<CreateOutcome>;
  createProgram(program: Program, limit: number): Promise<CreateOutcome>;
  createHalaqa(halaqa: Halaqa, limit: number): Promise<CreateOutcome>;

  /** Name, order, description and `updatedAt` — nothing else is ever rewritten. */
  saveSection(section: Section): Promise<void>;
  saveProgram(program: Program): Promise<void>;
  saveHalaqa(halaqa: Halaqa): Promise<void>;

  setSectionStatus(id: string, status: StructureStatus, at: Date): Promise<StatusOutcome<Section>>;
  setProgramStatus(id: string, status: StructureStatus, at: Date): Promise<StatusOutcome<Program>>;
  activateHalaqa(id: string, at: Date): Promise<StatusOutcome<Halaqa>>;
  /** INACTIVE — unless the halaqa has an ACTIVE enrollment, decided in the same atomic step. */
  deactivateHalaqa(
    id: string,
    at: Date,
  ): Promise<StatusOutcome<Halaqa> | { readonly kind: 'has_active_enrollments' }>;

  /**
   * Enrolls — provided the halaqa, its program and its section are all open
   * AS OF THE WRITE, and returning the existing ACTIVE enrollment instead of
   * a second one (for a repeat, a double submit, or a race).
   */
  enroll(enrollment: Enrollment): Promise<EnrollOutcome>;
  findEnrollment(id: string): Promise<Enrollment | null>;
  /** ACTIVE → the outcome; anything else is reported, never rewritten. */
  endEnrollment(
    id: string,
    outcome: EnrollmentOutcome,
    by: string | null,
    at: Date,
  ): Promise<EndOutcome<Enrollment>>;

  /** One ACTIVE assignment per teacher and halaqa; a repeat finds the existing one. */
  assignTeacher(assignment: TeacherAssignment): Promise<AssignOutcome>;
  findAssignment(id: string): Promise<TeacherAssignment | null>;
  endAssignment(id: string, by: string | null, at: Date): Promise<EndOutcome<TeacherAssignment>>;

  isEnrolled(studentUserId: string, halaqaId: string): Promise<boolean>;
  isTeaching(teacherUserId: string, halaqaId: string): Promise<boolean>;
}

/** The whole catalogue — bounded by AcademicLimits. */
export interface Catalogue {
  readonly sections: readonly Section[];
  readonly programs: readonly Program[];
  /** Per program id: how many of its halaqat are ACTIVE. Absent means none. */
  readonly activeHalaqaCounts: ReadonlyMap<string, number>;
}

/**
 * Academic's lists. Each is one query (or one per page): no row is fetched
 * to find the next.
 *
 *   catalogue, halaqatOf           bounded by invariant (AcademicLimits); by (order, code)
 *   roster, teachersOf             by (enrolledAt | startedAt, id), oldest first, keyset
 *   enrollmentsOf, assignmentsOf   newest first, keyset
 */
export interface AcademicReadModel {
  catalogue(): Promise<Catalogue>;
  /** One section and its programs; null when there is no such section. */
  sectionCatalogue(sectionId: string): Promise<Catalogue | null>;
  halaqatOf(programId: string): Promise<readonly Halaqa[]>;

  roster(
    halaqaId: string,
    status: EnrollmentStatus,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly Enrollment[]>;
  teachersOf(
    halaqaId: string,
    status: AssignmentStatus,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly TeacherAssignment[]>;
  /** The ACTIVE assignments of several halaqat at once. */
  activeTeachersOf(halaqaIds: readonly string[]): Promise<readonly TeacherAssignment[]>;

  enrollmentsOf(
    studentUserId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly PlacedEnrollment[]>;
  activeEnrollmentsOf(studentUserId: string, limit: number): Promise<readonly PlacedEnrollment[]>;
  assignmentsOf(
    teacherUserId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly PlacedAssignment[]>;
  activeAssignmentsOf(teacherUserId: string, limit: number): Promise<readonly PlacedAssignment[]>;
}
