/**
 * TECHNICAL BOUNDS — development-safe, provisional, and NOT institutional
 * policy. They are not capacities: the institution's own figures (page 7's
 * «استيعاب 40 مجموعة» for التهجي, say) are facts the app displays, not limits
 * enforced here, and nothing below restricts how many halaqat a student may
 * join or a teacher may teach (open-questions.md Q30, Q31).
 *
 * What they buy: the catalogue — every section, its programs and a program's
 * halaqat — is bounded by invariant, so each catalogue read is one bounded
 * query instead of a paged one. Rosters and histories, which grow without
 * bound, are paged by cursor instead.
 *
 * Each cap is enforced where it is written, under a lock (see the
 * repositories), so concurrent creations cannot overshoot it.
 */
export const AcademicLimits = Object.freeze({
  maxSections: 50,
  maxProgramsPerSection: 50,
  maxHalaqatPerProgram: 200,
  /**
   * `GET /academic/me` lists this many ACTIVE enrollments and assignments at
   * most, and says when there were more (the paged history has them all).
   */
  myActiveRelationships: 200,
});
