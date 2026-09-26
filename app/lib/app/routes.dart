/// Route names and path builders, kept in one place so screens never hand-roll
/// a URL string. These paths are real browser URLs on Flutter Web.
abstract final class Routes {
  static const String splash = '/splash';
  static const String home = '/home';
  static const String programs = '/programs';
  static const String path = '/path';
  static const String certificates = '/certificates';
  static const String profile = '/profile';
  static const String progress = '/progress';
  static const String notifications = '/notifications';
  static const String notificationSettings = '/notifications/settings';
  static const String announcements = '/announcements';
  static const String messages = '/messages';
  static const String communities = '/communities';
  static const String signIn = '/sign-in';

  /// Where an invitation link opens. Its token is never in this path, a
  /// query or `extra`: it rides in the link's fragment, which the app takes
  /// out of the address bar before routing (lib/app/invite_link.dart).
  static const String invite = '/invite';

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

  static String certificate(String certificateId) =>
      '$certificates/$certificateId';
}
