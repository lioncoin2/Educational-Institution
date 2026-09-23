/**
 * The permission catalogue — the vocabulary of authorization.
 *
 * Permissions, not roles, are what code checks. A controller says
 * `@RequirePermission(Permissions.live.grantSpeaker)`; it never asks whether the
 * caller "is a teacher". That indirection is what lets roles be added, renamed
 * or re-scoped without touching a single call site.
 *
 * This lives in `contracts/` because every module needs to name permissions.
 */
export const Permissions = {
  identity: {
    readUser: 'identity.user.read',
    createUser: 'identity.user.create',
    updateUser: 'identity.user.update',
    assignRole: 'identity.role.assign',
  },
  academic: {
    readProgram: 'academic.program.read',
    manageProgram: 'academic.program.manage',
  },
  operations: {
    startSession: 'operations.session.start',
    endSession: 'operations.session.end',
    recordAttendance: 'operations.attendance.record',
    amendAttendance: 'operations.attendance.amend',
  },
  assignments: {
    publish: 'assignments.assignment.publish',
    submit: 'assignments.submission.create',
    grade: 'assignments.submission.grade',
  },
  messaging: {
    sendMessage: 'messaging.message.send',
    readConversation: 'messaging.conversation.read',
    moderate: 'messaging.message.moderate',
  },
  live: {
    startRoom: 'live.room.start',
    endRoom: 'live.room.end',
    joinRoom: 'live.room.join',
    requestSpeaker: 'live.speaker.request',
    grantSpeaker: 'live.speaker.grant',
    revokeSpeaker: 'live.speaker.revoke',
    muteParticipant: 'live.participant.mute',
  },
  files: {
    upload: 'files.asset.upload',
    read: 'files.asset.read',
  },
  reporting: {
    view: 'reporting.report.view',
  },
  audit: {
    read: 'audit.log.read',
  },
} as const;

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];

/** Every permission string in the catalogue, as a union type. */
export type Permission = Leaves<typeof Permissions>;

/** Flat list — used to seed storage and to validate role definitions. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permissions).flatMap((group) =>
  Object.values(group),
);
