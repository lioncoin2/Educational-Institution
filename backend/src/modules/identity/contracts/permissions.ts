/**
 * The permission catalogue — the vocabulary of authorization.
 *
 * Permissions, not roles, are what code checks. A route says
 * `@RequirePermission(Permissions.live.moderate)`; it never asks whether the
 * caller "is a teacher". That indirection is what lets roles be added, renamed
 * or re-scoped without touching a call site.
 *
 * Names are `<namespace>.<action>`. A namespace is a capability area, not a
 * module: `attendance.*` will be enforced by Operations, `users.*` by Identity.
 *
 * This file answers "what CAN be granted". It says nothing about who holds
 * what — that is the role matrix, which is provisional (see
 * `domain/provisional-policy.ts` and docs/architecture/open-questions.md, Q1).
 *
 * Adding a permission is a code change AND a migration: the `permissions` table
 * is seeded from this catalogue, and a test fails if the two disagree.
 */
export const Permissions = {
  /** Accounts: who may sign in. Distinct from `people.*`, which is the human record. */
  users: {
    read: 'users.read',
    manage: 'users.manage',
  },
  roles: {
    assign: 'roles.assign',
  },
  /** Acting on OTHER people's sessions. Everyone may manage their own. */
  sessions: {
    manage: 'sessions.manage',
  },
  audit: {
    read: 'audit.read',
  },
  settings: {
    manage: 'settings.manage',
  },
  people: {
    read: 'people.read',
    manage: 'people.manage',
  },
  academic: {
    read: 'academic.read',
    manage: 'academic.manage',
  },
  attendance: {
    read: 'attendance.read',
    manage: 'attendance.manage',
  },
  assignments: {
    read: 'assignments.read',
    submit: 'assignments.submit',
    manage: 'assignments.manage',
  },
  messaging: {
    read: 'messaging.read',
    send: 'messaging.send',
    manage: 'messaging.manage',
  },
  live: {
    join: 'live.join',
    raiseHand: 'live.raise_hand',
    speak: 'live.speak',
    moderate: 'live.moderate',
  },
  files: {
    read: 'files.read',
    upload: 'files.upload',
  },
  reports: {
    read: 'reports.read',
  },
} as const;

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];

/** Every permission string in the catalogue, as a union type. */
export type Permission = Leaves<typeof Permissions>;

/** Flat list — used to seed storage and to validate role definitions. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(
  Object.values(Permissions).flatMap((group) => Object.values(group)),
);

const KNOWN = new Set<string>(ALL_PERMISSIONS);

/**
 * Narrows an arbitrary string to a catalogued permission.
 *
 * Anything read from storage or a request passes through here, so a permission
 * that is not in the catalogue can never be granted, required or checked — it
 * is simply not a permission.
 */
export function isPermission(value: string): value is Permission {
  return KNOWN.has(value);
}
