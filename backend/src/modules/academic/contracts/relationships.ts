/** DI token. */
export const ACADEMIC_RELATIONSHIPS = Symbol('ACADEMIC_RELATIONSHIPS');

/** Upper bound on one page of `activeStudentIds`. */
export const ACADEMIC_RELATIONSHIPS_MAX_PAGE = 1000;

/**
 * Who is in a halaqa, as of now — for modules that act per halaqa without
 * owning it (attendance, assignments, a teacher's workspace, notifications).
 *
 * Answers come from academic's records: an ACTIVE enrollment, an ACTIVE
 * teacher assignment. Nothing here says whether an account may sign in or
 * what its roles allow — that is identity's question, asked separately.
 */
export interface AcademicRelationships {
  /** Whether the account is enrolled in the halaqa now. */
  isEnrolled(studentUserId: string, halaqaId: string): Promise<boolean>;

  /** Whether the account teaches the halaqa now, in any teaching role. */
  isTeaching(teacherUserId: string, halaqaId: string): Promise<boolean>;

  /**
   * Accounts enrolled in the halaqa now, in enrollment order, a page at a
   * time (at most `ACADEMIC_RELATIONSHIPS_MAX_PAGE`). `cursor` is the last
   * page's `nextCursor`; it is opaque.
   */
  activeStudentIds(
    halaqaId: string,
    page: { readonly cursor?: string; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}
