import type { Page, PageRequest } from '../../../shared';
import type { AccountSummary } from './account-directory';
import { Permissions, type Permission } from './permissions';

/** DI token. */
export const ACCOUNT_SEARCH = Symbol('ACCOUNT_SEARCH');

/**
 * Who counts as an "eligible teacher" — both as a recipient a student may start
 * a direct conversation with (Q6, messaging) and as a result of the teacher
 * directory (identity search). ONE definition, imported by both, so they cannot
 * drift: a holder of `academic.teach` (the catalogue's "is a teacher's account"
 * marker — teachers and assistant teachers) who is NOT an administrator, i.e.
 * holds no `users.manage` (only the owner and admins do). It deliberately
 * excludes students, supervisors, administrators and the owner.
 */
export const ELIGIBLE_TEACHER: { readonly holds: Permission; readonly notHolds: Permission } = {
  holds: Permissions.academic.teach,
  notHolds: Permissions.users.manage,
};

/**
 * Identity's answer to "which accounts' names begin with this?" — the one way
 * another module may enumerate accounts by name, for a staff member adding a
 * member or starting a conversation with someone they do not already hold an id
 * for.
 *
 * It only FINDS; the caller's RIGHT to search is the caller's, decided above
 * this port (People gates `GET /people` on `people.read`). The result is the
 * same deliberately-minimal {userId, displayName, active} shape as
 * [AccountDirectory] — never an email, a role or any security state — so a
 * searchable account discloses nothing a batch lookup would not.
 */
export interface AccountSearch {
  /**
   * A bounded, keyset-paged page of ACTIVE accounts whose display name begins
   * with `query` (case-insensitive, matched literally). A blank query is an
   * empty page: enumeration always starts from a typed name.
   */
  search(query: string, page: PageRequest): Promise<Page<AccountSummary>>;

  /**
   * Like [search], but only ELIGIBLE TEACHERS (see [ELIGIBLE_TEACHER]) — never
   * students, administrators or the owner. The one way a student may enumerate
   * teachers to find one to message (Q6); who may call it is decided above this
   * port (People gates it on the student's teacher-messaging capability), and
   * the projection is the same minimal {userId, displayName, active}.
   */
  searchTeachers(query: string, page: PageRequest): Promise<Page<AccountSummary>>;
}
