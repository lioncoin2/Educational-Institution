import { ALL_PERMISSIONS, type Permission, Permissions } from '../contracts/permissions';
import { restrictToResourceOwner, type PolicyRule } from './policy';
import { Roles, type KnownRoleCode } from './role';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROVISIONAL INSTITUTIONAL POLICY — NOT CONFIRMED BY THE INSTITUTION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything in this file is a placeholder for a decision the institution has
 * not yet made. It exists so the system is usable and testable meanwhile, and
 * it is kept in ONE file so that nobody mistakes it for settled policy.
 * Each choice is tracked in docs/architecture/open-questions.md (Q1).
 *
 * The matrix is seeded into the `role_permissions` table by migration, and the
 * table is what runs. A test fails if this constant and the seeded rows ever
 * disagree, so the two cannot drift silently.
 *
 * Two technical constraints shaped it — these are not policy choices:
 *
 *  1. No escalation. An actor may only grant a role, or administer an account,
 *     whose permissions are a subset of their own (see `administration.ts`).
 *     So ADMIN must hold everything the roles it onboards hold, or it could not
 *     onboard teachers at all.
 *
 *  2. OWNER must differ from ADMIN by at least one permission. If the two were
 *     equal, the no-escalation rule would let any admin reset an owner's
 *     password and sign in as them. `settings.manage` is that difference: it is
 *     the one permission in the brief's examples that is about governing the
 *     system itself.
 */
export const PROVISIONAL_ROLE_PERMISSIONS: Readonly<Record<KnownRoleCode, readonly Permission[]>> =
  {
    /** Provisional: every permission. Q1 — including reading others' messages? */
    [Roles.owner]: ALL_PERMISSIONS,

    /**
     * Provisional: everything except system settings (constraint 2) and
     * `messaging.manage`, which is a power over other people's private
     * conversations that should not be granted by default beyond the owner (Q6).
     */
    [Roles.admin]: ALL_PERMISSIONS.filter(
      (permission) =>
        permission !== Permissions.settings.manage && permission !== Permissions.messaging.manage,
    ),

    /** Provisional: oversight — read access, no management. Q1: may they amend attendance? */
    [Roles.supervisor]: [
      Permissions.users.read,
      Permissions.people.read,
      Permissions.academic.read,
      Permissions.attendance.read,
      Permissions.assignments.read,
      Permissions.reports.read,
      Permissions.messaging.read,
      Permissions.messaging.send,
      Permissions.messaging.startDirect,
      Permissions.messaging.createGroup,
      Permissions.live.join,
      Permissions.files.read,
    ],

    /**
     * `academic.teach`: eligible to be assigned to a halaqa. Which halaqat a
     * teacher then sees is decided by those assignments, never by the role.
     */
    [Roles.teacher]: [
      Permissions.people.read,
      Permissions.academic.read,
      Permissions.academic.teach,
      Permissions.attendance.read,
      Permissions.attendance.manage,
      Permissions.assignments.read,
      Permissions.assignments.manage,
      Permissions.messaging.read,
      Permissions.messaging.send,
      Permissions.messaging.startDirect,
      Permissions.messaging.createGroup,
      Permissions.live.join,
      Permissions.live.speak,
      Permissions.live.moderate,
      Permissions.files.read,
      Permissions.files.upload,
    ],

    /**
     * Provisional: Q1 — may an assistant speak in, or moderate, a live room?
     * Like students, assistants take part in conversations but do not start
     * them (Q6).
     */
    [Roles.assistantTeacher]: [
      Permissions.academic.read,
      Permissions.academic.teach,
      Permissions.attendance.read,
      Permissions.assignments.read,
      Permissions.messaging.read,
      Permissions.messaging.send,
      Permissions.live.join,
      Permissions.files.read,
    ],

    /**
     * Students may ask for the floor (`live.raise_hand`) but never take it
     * (`live.speak`) — speaking is granted per session by a host.
     *
     * Messaging: students read and reply in conversations staff place them in,
     * but may not START one — no direct messages to peers or to adults of their
     * choosing, no groups of their own. The conservative default for an
     * institution of children; the institution decides otherwise (Q6).
     *
     * `academic.study`: eligible to be enrolled in a halaqa. Only students
     * hold it (besides OWNER and ADMIN, which hold everything they grant); a
     * staff member who also studies holds the STUDENT role as well (Q30).
     */
    [Roles.student]: [
      Permissions.academic.read,
      Permissions.academic.study,
      Permissions.assignments.read,
      Permissions.assignments.submit,
      Permissions.messaging.read,
      Permissions.messaging.send,
      Permissions.live.join,
      Permissions.live.raiseHand,
      Permissions.files.read,
      Permissions.files.upload,
    ],
  };

/**
 * Provisional resource-scoped rules, evaluated after the role baseline.
 *
 * `live.moderate` is restricted to the room's host: holding the permission
 * means "may moderate rooms you run", not "may moderate any room". Whether a
 * supervisor, admin or owner may step into someone else's room is Q1.
 */
export const PROVISIONAL_POLICY_RULES: readonly PolicyRule[] = Object.freeze([
  restrictToResourceOwner('host-only-moderation', [Permissions.live.moderate]),
]);
