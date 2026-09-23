/**
 * The role catalogue.
 *
 * A role is a named bundle of permissions. Code never branches on one — it
 * checks permissions — so this list exists to name the roles that are ACTIVE in
 * the system and to type the provisional matrix.
 *
 * Six roles are active. Parent, Auditor, Content Manager and Support are
 * deliberately not: they are named in the brief as future roles, and activating
 * one means deciding what it may see, which has not been decided.
 *
 * Roles are also rows in the `roles` table, and the table — not this constant —
 * is what assignment is validated against at runtime. A future role therefore
 * needs a migration inserting the role and its grants; it does not need a code
 * change, because nothing in code enumerates roles to make a decision.
 *
 * OWNER and ADMIN are separate roles on purpose. They may hold the same
 * permissions today; the institution may separate them later, and nothing may
 * assume one implies the other.
 */
export const Roles = {
  owner: 'OWNER',
  admin: 'ADMIN',
  supervisor: 'SUPERVISOR',
  teacher: 'TEACHER',
  assistantTeacher: 'ASSISTANT_TEACHER',
  student: 'STUDENT',
} as const;

/** One of the six roles active today. */
export type KnownRoleCode = (typeof Roles)[keyof typeof Roles];

/**
 * A role code as stored. Deliberately `string`: a role added by migration must
 * be assignable and must resolve to its permissions without a deploy.
 */
export type RoleCode = string;

export const ACTIVE_ROLES: readonly KnownRoleCode[] = Object.freeze(Object.values(Roles));

/** Uppercase snake case, as the codes above. Rejects anything else outright. */
export const ROLE_CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function isWellFormedRoleCode(value: string): boolean {
  return ROLE_CODE_SHAPE.test(value);
}
