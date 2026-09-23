import { ALL_PERMISSIONS, type Permission, Permissions } from '../contracts/permissions';

/**
 * Roles the institution can grant. Defining a role here does NOT surface it in
 * any UI — it only makes it grantable.
 */
export const RoleNames = {
  owner: 'owner',
  administrator: 'administrator',
  supervisor: 'supervisor',
  teacher: 'teacher',
  assistantTeacher: 'assistant_teacher',
  student: 'student',
  parent: 'parent',
  contentManager: 'content_manager',
  support: 'support',
  auditor: 'auditor',
} as const;

export type RoleName = (typeof RoleNames)[keyof typeof RoleNames];

/**
 * PROVISIONAL role → permission matrix.
 *
 * Only the owner grant is self-evident (the owner is the institution's top
 * authority). Every other row encodes an institutional policy decision that has
 * NOT been confirmed — for example whether a supervisor may amend attendance
 * after the fact, or whether an assistant teacher may grant the microphone.
 * These defaults are deliberately conservative and are tracked in
 * docs/architecture/open-questions.md (Q1).
 *
 * This is data, not logic: once confirmed it moves into the database and becomes
 * editable by the owner without a deploy. Nothing in the codebase branches on a
 * role name, so changing a row here changes behaviour everywhere at once.
 */
export const PROVISIONAL_ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  [RoleNames.owner]: ALL_PERMISSIONS,

  [RoleNames.administrator]: [
    Permissions.identity.readUser,
    Permissions.identity.createUser,
    Permissions.identity.updateUser,
    Permissions.identity.assignRole,
    Permissions.academic.readProgram,
    Permissions.academic.manageProgram,
    Permissions.operations.startSession,
    Permissions.operations.endSession,
    Permissions.operations.recordAttendance,
    Permissions.reporting.view,
    Permissions.files.read,
  ],

  [RoleNames.supervisor]: [
    Permissions.identity.readUser,
    Permissions.academic.readProgram,
    Permissions.operations.recordAttendance,
    Permissions.reporting.view,
    Permissions.files.read,
  ],

  [RoleNames.teacher]: [
    Permissions.academic.readProgram,
    Permissions.operations.startSession,
    Permissions.operations.endSession,
    Permissions.operations.recordAttendance,
    Permissions.assignments.publish,
    Permissions.assignments.grade,
    Permissions.messaging.sendMessage,
    Permissions.messaging.readConversation,
    Permissions.live.startRoom,
    Permissions.live.endRoom,
    Permissions.live.joinRoom,
    Permissions.live.grantSpeaker,
    Permissions.live.revokeSpeaker,
    Permissions.live.muteParticipant,
    Permissions.files.upload,
    Permissions.files.read,
  ],

  [RoleNames.assistantTeacher]: [
    Permissions.academic.readProgram,
    Permissions.operations.recordAttendance,
    Permissions.messaging.sendMessage,
    Permissions.messaging.readConversation,
    Permissions.live.joinRoom,
    Permissions.files.read,
  ],

  [RoleNames.student]: [
    Permissions.academic.readProgram,
    Permissions.assignments.submit,
    Permissions.messaging.sendMessage,
    Permissions.messaging.readConversation,
    Permissions.live.joinRoom,
    Permissions.live.requestSpeaker,
    Permissions.files.upload,
    Permissions.files.read,
  ],

  [RoleNames.parent]: [Permissions.academic.readProgram, Permissions.reporting.view],

  [RoleNames.contentManager]: [
    Permissions.academic.readProgram,
    Permissions.academic.manageProgram,
    Permissions.files.upload,
    Permissions.files.read,
  ],

  [RoleNames.support]: [Permissions.identity.readUser, Permissions.messaging.readConversation],

  [RoleNames.auditor]: [Permissions.audit.read, Permissions.reporting.view],
};

/** Resolves the effective permission set for a set of granted roles. */
export function permissionsForRoles(roles: readonly string[]): ReadonlySet<string> {
  const effective = new Set<string>();
  for (const role of roles) {
    const granted = PROVISIONAL_ROLE_PERMISSIONS[role as RoleName];
    if (granted === undefined) continue; // Unknown role grants nothing.
    for (const permission of granted) effective.add(permission);
  }
  return effective;
}
