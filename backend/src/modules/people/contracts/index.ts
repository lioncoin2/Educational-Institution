/**
 * People — the human record behind a login.
 *
 * Identity answers "who may sign in and what may they do". People answers "who
 * is this person in the institution": their profile, guardians, and which
 * teacher/student/supervisor roles they actually occupy.
 */
export interface PersonRef {
  readonly personId: string;
  /** The identity account, when the person has one (a young learner may not). */
  readonly userId: string | null;
  readonly displayName: string;
}

export type PersonKind = 'student' | 'teacher' | 'supervisor' | 'guardian' | 'staff';
