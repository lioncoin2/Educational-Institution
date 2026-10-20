/// Route names and path builders, kept in one place so screens never hand-roll
/// a URL string. These paths are real browser URLs on Flutter Web.
abstract final class Routes {
  static const String splash = '/splash';
  static const String home = '/home';
  static const String programs = '/programs';
  static const String path = '/path';
  static const String certificates = '/certificates';
  static const String profile = '/profile';

  /// The signed-in user changes their own password (`POST /auth/password`).
  static const String changePassword = '/profile/password';

  /// The signed-in user's own devices/sessions (`GET /auth/sessions`).
  static const String sessions = '/profile/sessions';

  /// The signed-in user sets or removes their profile picture (`/files/me`).
  static const String avatar = '/profile/avatar';
  static const String progress = '/progress';
  static const String notifications = '/notifications';
  static const String notificationSettings = '/notifications/settings';
  static const String announcements = '/announcements';
  static const String messages = '/messages';
  static const String communities = '/communities';
  static const String commandCenter = '/command-center';

  /// Mass publishing — one file / image / voice recording / notice to several
  /// communities at once (`POST /messaging/communities/publish`), for a holder
  /// of `messaging.send`. The server authorizes each community on its own.
  static const String publish = '/publish';
  static const String adminAccounts = '/admin/accounts';

  /// Managing the institution's academic structure (sections → programs →
  /// halaqat), for a holder of `academic.manage`.
  static const String academicStructure = '/admin/academic';

  /// Scheduling of individual dated lessons (operations, ADR 0042), for a holder
  /// of `operations.schedule_manage`. The server authorizes every call.
  static const String schedulingList = '/admin/scheduling';
  static String schedulingLesson(String lessonId) =>
      '$schedulingList/lessons/${Uri.encodeComponent(lessonId)}';

  /// The teacher's own workspace: the halaqat they actively teach
  /// (`academic.teach`). The server answers by the authenticated identity.
  static const String teacherWorkspace = '/teaching';

  /// The teacher's own assignment record: every assignment, current and past
  /// (`GET /academic/me/teaching`, `academic.read`).
  static const String teacherHistory = '/teaching/history';

  /// The student's own workspace: the halaqat they are enrolled in
  /// (`academic.read`/`academic.study`). The server answers by the identity.
  static const String studentWorkspace = '/my-halaqat';

  /// The student's own academic record: every enrollment, current and past
  /// (`GET /academic/me/enrollments`, `academic.read`).
  static const String studentRecord = '/my-halaqat/record';

  static const String signIn = '/sign-in';

  /// Where an invitation link opens. Its token is never in this path, a
  /// query or `extra`: it rides in the link's fragment, which the app takes
  /// out of the address bar before routing (lib/app/invite_link.dart).
  static const String invite = '/invite';

  /// One account's detail and lifecycle administration (OWNER/ADMIN).
  static String adminAccount(String userId) =>
      '$adminAccounts/${Uri.encodeComponent(userId)}';

  /// One of the teacher's own halaqat' student roster (read-only).
  static String teacherHalaqaRoster(String halaqaId) =>
      '$teacherWorkspace/halaqat/${Uri.encodeComponent(halaqaId)}/students';

  static String academicProgram(String programId) =>
      '$academicStructure/programs/${Uri.encodeComponent(programId)}';

  /// Administering a halaqa's students and teachers (`academic.manage`).
  static String academicHalaqaPeople(String halaqaId) =>
      '$academicStructure/halaqat/${Uri.encodeComponent(halaqaId)}/people';

  /// Read-only academic relationship history for one account (`academic.manage`).
  static String academicStudentHistory(String userId) =>
      '$academicStructure/students/${Uri.encodeComponent(userId)}/history';

  static String academicTeacherHistory(String userId) =>
      '$academicStructure/teachers/${Uri.encodeComponent(userId)}/history';

  static String program(String programId) => '$programs/$programId';

  static String levels(String programId) => '$programs/$programId/levels';

  static String episode(String programId, String halaqaId) =>
      '$programs/$programId/levels/$halaqaId';

  static String lesson(String programId, String halaqaId, String lessonId) =>
      '$programs/$programId/levels/$halaqaId/lessons/$lessonId';

  static String conversation(String conversationId) =>
      '$messages/${Uri.encodeComponent(conversationId)}';

  static String community(String communityId) =>
      '$communities/${Uri.encodeComponent(communityId)}';

  static String communityMembers(String communityId) =>
      '${community(communityId)}/members';

  static String communityInvitations(String communityId) =>
      '${community(communityId)}/invitations';

  static String communityLive(String communityId) =>
      '${community(communityId)}/live';

  static String communityAttendance(String communityId) =>
      '${community(communityId)}/attendance';

  static String communityAttendanceSnapshots(
    String communityId, {
    String? liveSessionId,
  }) {
    final base = '${communityAttendance(communityId)}/snapshots';
    return liveSessionId == null
        ? base
        : '$base?session=${Uri.encodeComponent(liveSessionId)}';
  }

  static String communityAttendanceSnapshot(
    String communityId,
    String snapshotId,
  ) =>
      '${communityAttendanceSnapshots(communityId)}/${Uri.encodeComponent(snapshotId)}';

  static String certificate(String certificateId) =>
      '$certificates/$certificateId';
}
