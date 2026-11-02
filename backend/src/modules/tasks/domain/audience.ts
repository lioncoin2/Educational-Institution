/**
 * Who a task can be addressed to (ADR 0052 §2, roadmap §2). Three staff
 * audiences, each the holders of a fixed set of identity roles. The owner is not
 * an audience: the administration does not send tasks to the owner.
 */
export const TASK_AUDIENCES = ['TEACHERS', 'SUPERVISORS', 'ADMINISTRATION'] as const;

export type TaskAudience = (typeof TASK_AUDIENCES)[number];

/** The identity roles whose ACTIVE holders make up each audience. */
export const AUDIENCE_ROLES: Readonly<Record<TaskAudience, readonly string[]>> = Object.freeze({
  TEACHERS: Object.freeze(['TEACHER', 'ASSISTANT_TEACHER']),
  SUPERVISORS: Object.freeze(['SUPERVISOR']),
  ADMINISTRATION: Object.freeze(['ADMIN']),
});

export function isTaskAudience(value: string): value is TaskAudience {
  return (TASK_AUDIENCES as readonly string[]).includes(value);
}

/**
 * A task's audiences, normalised: known values only, no duplicates, in the
 * canonical order. Null when the list is empty or names an unknown audience —
 * a task is always addressed to someone, and never to a guess.
 */
export function normaliseAudiences(values: readonly string[]): readonly TaskAudience[] | null {
  if (values.length === 0 || !values.every(isTaskAudience)) return null;
  const wanted = new Set<string>(values);
  return TASK_AUDIENCES.filter((audience) => wanted.has(audience));
}

/** The identity roles behind a set of audiences, without duplicates. */
export function rolesOf(audiences: readonly TaskAudience[]): readonly string[] {
  return [...new Set(audiences.flatMap((audience) => AUDIENCE_ROLES[audience]))];
}
