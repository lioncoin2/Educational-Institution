<!-- GENERATED — do not edit by hand.
     Regenerate: cd backend && npm run arch:index
     Freshness is enforced by backend/test/architecture/architecture-index.spec.ts
     (npm run verify, and CI) and by `npm run arch:index:check`.
     Every edge below is a STATIC IMPORT, never a runtime call — modules
     collaborate at runtime through events (docs/architecture/events.md). -->

# Architecture Index

A generated, code-derived map of the repository, for finding the owner of a
behaviour and its files before reading code. It is mechanical fact only;
responsibility and what each module must not know live in
[module-boundaries.md](module-boundaries.md), the enforced edges in
[dependency-rules.md](dependency-rules.md).

> **Edges are static imports, not runtime calls.** Cross-module collaboration
> is mostly events over the in-process bus ([events.md](events.md)); a module's
> declared events below are read from its `contracts/events.ts`. Every module
> also depends on `shared` and `platform`; that is not repeated per row.

## Backend modules (`backend/src/modules/`)

### academic

- **Path:** `backend/src/modules/academic/`
- **Nest module:** `academic.module.ts` — exports: `ACADEMIC_RELATIONSHIPS`, `ACADEMIC_STRUCTURE_SUMMARY`
- **Public contract (`contracts/`):** `ACADEMIC_RELATIONSHIPS`, `ACADEMIC_RELATIONSHIPS_MAX_PAGE`, `ACADEMIC_STRUCTURE_SUMMARY`, `ASSIGNMENT_STATUSES`, `AcademicEvent`, `AcademicEvents`, `AcademicRelationships`, `AcademicStructureReporting`, `AcademicStructureSummary`, `AssignmentEnded`, `AssignmentStatus`, `ENROLLMENT_OUTCOMES`, `ENROLLMENT_STATUSES`, `EnrollmentEnded`, `EnrollmentOutcome`, `EnrollmentStatus`, `HalaqaCreated`, `HalaqaStatusChanged`, `HalaqaUpdated`, `ProgramCreated`, `ProgramStatusChanged`, `ProgramUpdated`, `SECTION_KINDS`, `STRUCTURE_STATUSES`, `SectionCreated`, `SectionKind`, `SectionStatusChanged`, `SectionUpdated`, `StructureCount`, `StructureField`, `StructureStatus`, `StudentEnrolled`, `TEACHING_ROLES`, `TeacherAssigned`, `TeachingRole`, `isEnrollmentOutcome`, `isSectionKind`, `isTeachingRole`
- **Declared domain events:** `academic.halaqa.activated`, `academic.halaqa.created`, `academic.halaqa.deactivated`, `academic.halaqa.updated`, `academic.program.activated`, `academic.program.created`, `academic.program.deactivated`, `academic.program.updated`, `academic.section.activated`, `academic.section.created`, `academic.section.deactivated`, `academic.section.updated`, `academic.student.enrolled`, `academic.student.enrollment_ended`, `academic.teacher.assigned`, `academic.teacher.assignment_ended`
- **Static imports → modules:** `files`, `identity`
- **Docs:** [module-boundaries.md#academic](module-boundaries.md#academic)

### assignments

- **Path:** `backend/src/modules/assignments/`
- **Nest module:** `assignments.module.ts` — exports: —
- **Public contract (`contracts/`):** —
- **Declared domain events:** —
- **Static imports → modules:** —
- **Docs:** [module-boundaries.md#assignments](module-boundaries.md#assignments)

### attendance

- **Path:** `backend/src/modules/attendance/`
- **Nest module:** `attendance.module.ts` — exports: —
- **Public contract (`contracts/`):** `AttendanceEvents`, `AttendanceSnapshotRecorded`, `AttendanceSnapshotRecordedPayload`, `SNAPSHOT_CONNECTIONS`, `SnapshotConnection`
- **Declared domain events:** `attendance.snapshot.recorded`
- **Static imports → modules:** `communities`, `identity`, `live`
- **Docs:** [module-boundaries.md#attendance](module-boundaries.md#attendance)

### automation

- **Path:** `backend/src/modules/automation/`
- **Nest module:** `automation.module.ts` — exports: —
- **Public contract (`contracts/`):** —
- **Declared domain events:** —
- **Static imports → modules:** —
- **Docs:** [module-boundaries.md#automation](module-boundaries.md#automation)

### communities

- **Path:** `backend/src/modules/communities/`
- **Nest module:** `communities.module.ts` — exports: `COMMUNITY_AUTHORIZATION`, `COMMUNITY_CAPABILITY_HOLDERS`, `COMMUNITY_DIRECTORY`, `COMMUNITY_MEMBERSHIP`
- **Public contract (`contracts/`):** `COMMUNITY_ACTS`, `COMMUNITY_AUTHORIZATION`, `COMMUNITY_CAPABILITIES`, `COMMUNITY_CAPABILITY_HOLDERS`, `COMMUNITY_CHAT_MODES`, `COMMUNITY_CHAT_READ_CEILING`, `COMMUNITY_DERIVED_ACTS`, `COMMUNITY_DIRECTORY`, `COMMUNITY_KINDS`, `COMMUNITY_MEMBERSHIP`, `COMMUNITY_OPERATIONS`, `COMMUNITY_PARTICIPATION`, `COMMUNITY_RESOURCE`, `COMMUNITY_STATUSES`, `COMMUNITY_VIEW_CEILING`, `CapabilityGranted`, `CapabilityRevoked`, `CommunityAct`, `CommunityAuthorityBasis`, `CommunityAuthorization`, `CommunityCapability`, `CommunityCapabilityHolders`, `CommunityChatMode`, `CommunityChatModeChanged`, `CommunityCreated`, `CommunityDerivedAct`, `CommunityDirectory`, `CommunityEvent`, `CommunityEvents`, `CommunityHead`, `CommunityKind`, `CommunityLocked`, `CommunityMembership`, `CommunityOperation`, `CommunityParticipationAct`, `CommunityPermit`, `CommunityStatus`, `CommunitySummary`, `CommunityUnlocked`, `INVITATION_STATES`, `InvitationCreated`, `InvitationRevoked`, `InvitationState`, `LifecycleEffects`, `MAX_AUTHORIZE_BATCH`, `MAX_HOLDER_PAGE`, `MAX_MEMBER_PAGE`, `MEMBERSHIP_SOURCES`, `MEMBERSHIP_STANDINGS`, `MEMBERSHIP_STATUSES`, `MemberAdded`, `MemberRemoved`, `MemberState`, `MembershipChanges`, `MembershipSource`, `MembershipStanding`, `MembershipStatus`, `OwnershipTransferred`, `chatModeForKind`, `isCommunityAct`, `isCommunityCapability`, `isCommunityChatMode`, `isCommunityKind`, `isCommunityOperation`, `isCommunityParticipationAct`, `isCommunityStatus`, `isInvitationState`, `isMembershipSource`, `isMembershipStanding`, `isMembershipStatus`, `kindOfChatMode`
- **Declared domain events:** `communities.capability.granted`, `communities.capability.revoked`, `communities.community.chat_mode_changed`, `communities.community.created`, `communities.community.locked`, `communities.community.unlocked`, `communities.invitation.created`, `communities.invitation.revoked`, `communities.member.added`, `communities.member.removed`, `communities.ownership.transferred`
- **Static imports → modules:** `academic`, `files`, `identity`
- **Docs:** [module-boundaries.md#communities](module-boundaries.md#communities)

### files

- **Path:** `backend/src/modules/files/`
- **Nest module:** `files.module.ts` — exports: `FILE_ASSETS`
- **Public contract (`contracts/`):** `DownloadLink`, `FILE_ASSETS`, `FILE_KINDS`, `FileAssetSummary`, `FileAssets`, `FileKind`, `isFileKind`
- **Declared domain events:** —
- **Static imports → modules:** `identity`
- **Docs:** [module-boundaries.md#files](module-boundaries.md#files)

### identity

- **Path:** `backend/src/modules/identity/`
- **Nest module:** `identity.module.ts` — exports: `ACCESS_TOKEN_AUTHENTICATOR`, `ACCOUNT_AVATAR_WRITER`, `ACCOUNT_DIRECTORY`, `ACCOUNT_DIRECTORY_SUMMARY`, `ACCOUNT_SEARCH`, `AUTHORIZATION_SERVICE`
- **Public contract (`contracts/`):** `ACCESS_TOKEN_AUTHENTICATOR`, `ACCOUNT_AVATAR_WRITER`, `ACCOUNT_DIRECTORY`, `ACCOUNT_DIRECTORY_MAX_IDS`, `ACCOUNT_DIRECTORY_SUMMARY`, `ACCOUNT_SEARCH`, `ALL_PERMISSIONS`, `AUTHORIZATION_SERVICE`, `AccessTokenAuthenticator`, `AccountAvatarWriter`, `AccountDirectory`, `AccountDirectorySummary`, `AccountSearch`, `AccountStatusCounts`, `AccountSummary`, `Authenticated`, `Authentication`, `AuthorizationContext`, `AuthorizationService`, `ELIGIBLE_TEACHER`, `Permission`, `Permissions`, `REQUIRE_AUTHENTICATION`, `REQUIRE_PERMISSION`, `RequirePermission`, `SYSTEM_PRINCIPAL_PREFIX`, `SessionReference`, `isPermission`, `isSystemPrincipal`, `systemPrincipal`
- **Declared domain events:** —
- **Static imports → modules:** —
- **Docs:** [module-boundaries.md#identity](module-boundaries.md#identity)

### live

- **Path:** `backend/src/modules/live/`
- **Nest module:** `live.module.ts` — exports: `LIVE_AUDIENCE`, `LIVE_CHAT`, `LIVE_PRESENCE`, `LIVE_SESSIONS`
- **Public contract (`contracts/`):** `LIVE_AUDIENCE`, `LIVE_CHAT`, `LIVE_SESSIONS`, `LiveAudience`, `LiveChat`, `LiveChatLockChanged`, `LiveChatMessageView`, `LiveChatPosted`, `LiveEvent`, `LiveEvents`, `LiveMediaReset`, `LiveParticipantRemoved`, `LiveParticipantRole`, `LiveSessionEnded`, `LiveSessionScope`, `LiveSessionStarted`, `LiveSessions`, `LiveSpeakerFact`, `MAX_AUDIENCE_PROBE`, `MODERATOR_FRAME_COALESCE_MS`, `ScreenShareStarted`, `ScreenShareStopped`, `SpeakerPermissionGranted`, `SpeakerPermissionRevoked`, `SpeakerRequestDeclined`, `SpeakerRequestExpired`, `SpeakerRequestWithdrawn`, `SpeakerRequested`
- **Declared domain events:** `live.chat.lock_changed`, `live.chat.posted`, `live.participant.removed`, `live.screen_share.started`, `live.screen_share.stopped`, `live.session.ended`, `live.session.media_reset`, `live.session.started`, `live.speaker.declined`, `live.speaker.expired`, `live.speaker.granted`, `live.speaker.requested`, `live.speaker.revoked`, `live.speaker.withdrawn`
- **Static imports → modules:** `communities`, `identity`
- **Docs:** [module-boundaries.md#live](module-boundaries.md#live)

### messaging

- **Path:** `backend/src/modules/messaging/`
- **Nest module:** `messaging.module.ts` — exports: `MESSAGE_DELIVERY`, `MESSAGE_NOTIFICATION_CONTEXT`, `MESSAGE_RECIPIENTS`
- **Public contract (`contracts/`):** `AttachmentView`, `CONVERSATION_TYPES`, `ConversationCreated`, `ConversationPosition`, `ConversationType`, `MAX_NOTIFICATION_CONTEXT_REFS`, `MAX_RECIPIENT_PAGE`, `MESSAGE_DELIVERY`, `MESSAGE_NOTIFICATION_CONTEXT`, `MESSAGE_RECIPIENTS`, `MESSAGE_TYPES`, `MessageDeleted`, `MessageDelivery`, `MessageEdited`, `MessageForDelivery`, `MessageNotificationContext`, `MessagePinned`, `MessageRead`, `MessageRecipients`, `MessageSearch`, `MessageSearchHit`, `MessageSearchQuery`, `MessageSent`, `MessageType`, `MessageView`, `MessagingEvent`, `MessagingEvents`, `NotificationContext`, `NotificationContextRef`, `PARTICIPANT_ROLES`, `ParticipantAdded`, `ParticipantRemoved`, `ParticipantRole`, `PersonView`, `RecipientPage`
- **Declared domain events:** `messaging.conversation.created`, `messaging.message.deleted`, `messaging.message.edited`, `messaging.message.pinned`, `messaging.message.read`, `messaging.message.sent`, `messaging.participant.added`, `messaging.participant.removed`
- **Static imports → modules:** `communities`, `files`, `identity`
- **Docs:** [module-boundaries.md#messaging](module-boundaries.md#messaging)

### notifications

- **Path:** `backend/src/modules/notifications/`
- **Nest module:** `notifications.module.ts` — exports: `NOTIFICATION_READER`
- **Public contract (`contracts/`):** `AllNotificationsRead`, `DEVICE_PLATFORMS`, `DevicePlatform`, `NOTIFICATION_CATEGORIES`, `NOTIFICATION_CHANNELS`, `NOTIFICATION_READER`, `NOTIFICATION_READER_MAX_IDS`, `NOTIFICATION_TARGET_FIELDS`, `NOTIFICATION_TYPES`, `NotificationCategory`, `NotificationChannel`, `NotificationCreated`, `NotificationEvent`, `NotificationEvents`, `NotificationParams`, `NotificationRead`, `NotificationReader`, `NotificationTarget`, `NotificationTargetKind`, `NotificationType`, `NotificationView`, `PUSH_PROVIDER_NAMES`, `PushProviderName`
- **Declared domain events:** `notifications.notification.all_read`, `notifications.notification.created`, `notifications.notification.read`
- **Static imports → modules:** `attendance`, `communities`, `identity`, `live`, `messaging`
- **Docs:** [module-boundaries.md#notifications](module-boundaries.md#notifications)

### operations

- **Path:** `backend/src/modules/operations/`
- **Nest module:** `operations.module.ts` — exports: —
- **Public contract (`contracts/`):** —
- **Declared domain events:** —
- **Static imports → modules:** `academic`, `identity`
- **Docs:** [module-boundaries.md#operations](module-boundaries.md#operations)

### people

- **Path:** `backend/src/modules/people/`
- **Nest module:** `people.module.ts` — exports: —
- **Public contract (`contracts/`):** —
- **Declared domain events:** —
- **Static imports → modules:** `files`, `identity`
- **Docs:** [module-boundaries.md#people](module-boundaries.md#people)

### realtime

- **Path:** `backend/src/modules/realtime/`
- **Nest module:** `realtime.module.ts` — exports: —
- **Public contract (`contracts/`):** —
- **Declared domain events:** —
- **Static imports → modules:** `communities`, `identity`, `live`, `messaging`, `notifications`
- **Docs:** [module-boundaries.md#realtime](module-boundaries.md#realtime)

### reporting

- **Path:** `backend/src/modules/reporting/`
- **Nest module:** `reporting.module.ts` — exports: —
- **Public contract (`contracts/`):** —
- **Declared domain events:** —
- **Static imports → modules:** `academic`, `communities`, `identity`
- **Docs:** [module-boundaries.md#reporting](module-boundaries.md#reporting)

## Flutter features (`app/lib/features/`)

### academic_admin

- **Path:** `app/lib/features/academic_admin/`
- **Controllers:** `academic_history_controller.dart`, `academic_structure_controller.dart`, `halaqa_people_controller.dart`, `program_halaqat_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`

### admin

- **Path:** `app/lib/features/admin/`
- **Controllers:** `account_detail_controller.dart`, `admin_accounts_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`

### announcements

- **Path:** `app/lib/features/announcements/`
- **Controllers:** —
- **Static imports → areas:** `core`, `data`, `providers`
- **Static imports → features:** —

### attendance

- **Path:** `app/lib/features/attendance/`
- **Controllers:** `attendance_snapshot_detail_controller.dart`, `attendance_snapshots_controller.dart`, `record_attendance_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `communities`, `live`

### auth

- **Path:** `app/lib/features/auth/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** —

### certificates

- **Path:** `app/lib/features/certificates/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** —

### command_center

- **Path:** `app/lib/features/command_center/`
- **Controllers:** `command_center_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** —

### communities

- **Path:** `app/lib/features/communities/`
- **Controllers:** `community_controller.dart`, `community_invitations_controller.dart`, `community_list_controller.dart`, `community_members_controller.dart`, `invitation_join_controller.dart`, `member_grants_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`, `messaging`

### episode

- **Path:** `app/lib/features/episode/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`, `communities`

### home

- **Path:** `app/lib/features/home/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `notifications`

### learning_path

- **Path:** `app/lib/features/learning_path/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`

### lesson

- **Path:** `app/lib/features/lesson/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** —

### live

- **Path:** `app/lib/features/live/`
- **Controllers:** `live_chat_controller.dart`, `live_hands_controller.dart`, `live_media_controller.dart`, `live_moderation_controller.dart`, `live_session_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `communities`

### messaging

- **Path:** `app/lib/features/messaging/`
- **Controllers:** `conversation_controller.dart`, `conversation_list_controller.dart`, `conversation_mutes_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`, `communities`, `live`

### notifications

- **Path:** `app/lib/features/notifications/`
- **Controllers:** `notification_list_controller.dart`, `notification_preferences_controller.dart`, `unread_count_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`

### profile

- **Path:** `app/lib/features/profile/`
- **Controllers:** `sessions_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `academic_admin`, `admin`, `auth`, `command_center`, `notifications`, `publish`, `scheduling`, `student`, `teacher`

### programs

- **Path:** `app/lib/features/programs/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `home`, `notifications`

### progress

- **Path:** `app/lib/features/progress/`
- **Controllers:** —
- **Static imports → areas:** `core`, `data`, `providers`
- **Static imports → features:** —

### publish

- **Path:** `app/lib/features/publish/`
- **Controllers:** `publish_controller.dart`
- **Static imports → areas:** `core`, `data`, `providers`
- **Static imports → features:** —

### scheduling

- **Path:** `app/lib/features/scheduling/`
- **Controllers:** `scheduling_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `auth`

### splash

- **Path:** `app/lib/features/splash/`
- **Controllers:** —
- **Static imports → areas:** `app`, `core`, `data`
- **Static imports → features:** —

### student

- **Path:** `app/lib/features/student/`
- **Controllers:** `student_enrollments_controller.dart`, `student_record_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `academic_admin`, `auth`, `messaging`

### teacher

- **Path:** `app/lib/features/teacher/`
- **Controllers:** `teacher_assignments_controller.dart`, `teacher_history_controller.dart`
- **Static imports → areas:** `app`, `core`, `data`, `providers`
- **Static imports → features:** `academic_admin`, `auth`, `messaging`

## Flutter data seam (`app/lib/data/`, `app/lib/app/`)

- **Repository contracts (`data/repositories/repositories.dart`):** `AcademicRepository`, `AdminRepository`, `AttendanceRepository`, `AuthRepository`, `CatalogRepository`, `CertificateRepository`, `CommunityRepository`, `FeedRepository`, `FilesRepository`, `InstitutionRepository`, `LearningRepository`, `LiveChatRepository`, `LiveRepository`, `MessagingRepository`, `NotificationsRepository`, `PeopleRepository`, `ProgressRepository`, `ReportingRepository`, `SchedulingRepository`
- **Routes (`app/routes.dart`):** `academicStructure` → `/admin/academic`, `adminAccounts` → `/admin/accounts`, `announcements` → `/announcements`, `avatar` → `/profile/avatar`, `certificates` → `/certificates`, `changePassword` → `/profile/password`, `commandCenter` → `/command-center`, `communities` → `/communities`, `home` → `/home`, `invite` → `/invite`, `messages` → `/messages`, `notificationSettings` → `/notifications/settings`, `notifications` → `/notifications`, `path` → `/path`, `profile` → `/profile`, `programs` → `/programs`, `progress` → `/progress`, `publish` → `/publish`, `schedulingList` → `/admin/scheduling`, `sessions` → `/profile/sessions`, `signIn` → `/sign-in`, `splash` → `/splash`, `studentRecord` → `/my-halaqat/record`, `studentWorkspace` → `/my-halaqat`, `teacherHistory` → `/teaching/history`, `teacherWorkspace` → `/teaching`
- **Route builders:** `academicHalaqaPeople`, `academicProgram`, `academicStudentHistory`, `academicTeacherHistory`, `adminAccount`, `certificate`, `community`, `communityAttendance`, `communityAttendanceSnapshot`, `communityAttendanceSnapshots`, `communityInvitations`, `communityLive`, `communityMembers`, `conversation`, `episode`, `lesson`, `levels`, `program`, `schedulingLesson`, `teacherHalaqaRoster`
- **Entry points:** `app/lib/main.dart`, `app/lib/app/app.dart`, `app/lib/app/router.dart`, `app/lib/providers/app_providers.dart`

## Architecture Decision Records (`docs/architecture/decisions/`)

- [0001 — TypeScript and NestJS for the backend](decisions/0001-backend-stack.md)
- [0002 — Modular monolith, not microservices](decisions/0002-modular-monolith.md)
- [0003 — Abstract the RTC provider behind a port](decisions/0003-rtc-provider-abstraction.md)
- [0004 — Abstract binary storage behind a port](decisions/0004-storage-provider-abstraction.md)
- [0005 — Centralized permission and policy authorization](decisions/0005-authorization-architecture.md)
- [0006 — In-process domain events, outbox-ready](decisions/0006-event-architecture.md)
- [0007 — One conversation model; references, not payloads](decisions/0007-messaging-architecture.md)
- [0008 — Drizzle ORM rather than Prisma](decisions/0008-drizzle-over-prisma.md)
- [0009 — Enforce boundaries with dependency-cruiser in CI](decisions/0009-executable-architecture-rules.md)
- [0010 — Stateful sessions, checked per request, with rotating refresh tokens](decisions/0010-stateful-sessions-and-rotating-refresh-tokens.md)
- [0011 — Messaging V1: server-ordered, idempotent, membership-first](decisions/0011-messaging-v1.md)
- [0012 — Realtime messaging: plain WebSocket, membership decided per event](decisions/0012-realtime-messaging-transport.md)
- [0013 — Notifications V1: a stored inbox, idempotent by the database, delivered by subscribers](decisions/0013-notifications-v1.md)
- [0014 — Academic Core V1: academic owns the structure and who is in it](decisions/0014-academic-core-v1.md)
- [0015 — Academic structure reconciliation: the owner's section/halaqa answers (Q35/Q36)](decisions/0015-academic-structure-reconciliation.md)
- [0016 — Communities: a new module owns communities, membership, invitation links and lifecycle](decisions/0016-communities-module.md)
- [0017 — Community-scoped authorization: identity ceilings AND community standing; delegated capabilities; host-only moderation retired](decisions/0017-community-scoped-authorization.md)
- [0018 — Community chat: messaging keeps a named, versioned projection of community membership](decisions/0018-community-chat-projection.md)
- [0019 — Community-scoped live sessions: Postgres truth, level-triggered LiveKit convergence, a presenter slot, narrow RTC ports](decisions/0019-community-scoped-live-sessions.md)
- [0020 — Attendance snapshots are observations owned by a new attendance module (implementation HELD)](decisions/0020-attendance-snapshots.md)
- [0021 — Cross-cutting rules for the new modules: events in contracts, journals, durability classes, the realtime transport matrix, protocol v1 growth, `FailureKind 'unavailable'`, executable guards](decisions/0021-cross-cutting-rules-for-new-modules.md)
- [0022 — Community chat: every recipient page is checked against Communities, and a divergence rebuilds the projection](decisions/0022-community-chat-delivery-check.md)
- [0023 — Attendance authorization uses academic relationship AND community standing; attendance policy answers (Q8, Q12, Q69)](decisions/0023-attendance-authorization-and-policy.md)
- [0024 — Notification policy for P10 (answers Q67 and the P10 scope of Q28)](decisions/0024-notification-policy-p10.md)
- [0025 — Defer persistent live-session-start notifications (P10)](decisions/0025-defer-persistent-live-session-start-notifications.md)
- [0026 — Moderator-commanded live participant control: a kick that is not a ban, and a shared media reset](decisions/0026-live-participant-control-and-media-reset.md)
- [0027 — No hidden live listeners: every admitted participant is visible](decisions/0027-no-hidden-live-listeners.md)
- [0028 — Screen sharing: two presenters, and delegated student access](decisions/0028-screen-sharing-two-presenters-and-delegated-student-access.md)
- [0029 — Community message moderation: delete, review, retention](decisions/0029-community-message-moderation.md)
- [0030 — Flutter LiveKit media client (P7b)](decisions/0030-flutter-livekit-media-client.md)
- [0031 — A generated, code-derived architecture index and a root entry point](decisions/0031-architecture-navigation-index.md)
- [0032 — People discovery is not membership, authorization, or attendance](decisions/0032-discovery-membership-attendance-separation.md)
- [0033 — Optional community–halaqa link, conversation member-list visibility, and the current-student roster](decisions/0033-community-halaqa-link-and-member-list-visibility.md)
- [0034 — Q50: enrollment-sourced community membership and derived capabilities](decisions/0034-q50-enrollment-sourced-membership-and-derived-capabilities.md)
- [0035 — Community membership governance: enrollment, membership and capabilities stay separate (owner decision)](decisions/0035-community-membership-governance-separation.md)
- [0036 — Quiet hours and conversation mute: institution policy with user override, push-only (owner decision)](decisions/0036-quiet-hours-and-conversation-mute.md)
- [0037 — The Trial is a deployed environment: full security baseline, media declared explicitly](decisions/0037-trial-environment-and-explicit-fake-media.md)
- [0038 — Profile pictures and community profile editing, on the Files module](decisions/0038-identity-and-community-profile-media.md)
- [0039 — Groups vs channels: a community chat mode, posting by capability](decisions/0039-groups-and-channels-chat-mode.md)
- [0040 — Owner Command Center: a reporting widget registry over existing facts](decisions/0040-owner-command-center-reporting-registry.md)
- [0041 — Mass publishing: one post to several communities, authorized per community](decisions/0041-mass-publish-to-communities.md)
- [0042 — Operations: scheduling of individual dated lessons](decisions/0042-operations-scheduled-lessons.md)
- [0043 — Pinned messages: one server-authoritative pin per conversation, reconciled by a monotonic version](decisions/0043-pinned-messages.md)
- [0044 — Community role policy revision: who starts broadcasts, who adds members, and how ownership is recovered](decisions/0044-community-role-policy-revision.md)
- [0045 — Authors edit and delete their own messages; moderators delete, never edit](decisions/0045-author-message-edit-and-delete.md)
- [0046 — Notifications say who, where and what to an authorized recipient — resolved when shown, never stored, never on the lock screen](decisions/0046-notification-content-for-authorized-recipients.md)
- [0047 — A live session's own chat: Live's table, a server-side lock, delivered to participants only](decisions/0047-live-session-chat.md)
