import '../models/auth.dart';
import '../models/certificate.dart';
import '../models/feed.dart';
import '../models/institution.dart';
import '../models/learning.dart';
import '../models/messaging.dart';
import '../models/progress.dart';
import '../models/program.dart';
import '../models/student.dart';

/// Repository contracts.
///
/// Screens depend only on these interfaces. Swapping the prototype's in-memory
/// implementations for real network-backed ones means writing new classes that
/// implement these same contracts — no screen changes.

abstract interface class InstitutionRepository {
  Future<Institution> getInstitution();
  Future<StudentProfile> getStudent();
}

abstract interface class CatalogRepository {
  /// The five graded departments (profile page 6).
  Future<List<Program>> getDepartments();

  /// التهجي، البراعم، اللغات (pages 7–9).
  Future<List<Program>> getSpecialSections();

  /// البرامج المرافقة (page 10).
  Future<List<Program>> getCompanionPrograms();

  Future<Program?> getProgram(String id);
}

abstract interface class LearningRepository {
  /// The learner's position along the graded ladder.
  Future<List<PathStep>> getPath();

  /// Halaqat belonging to a program.
  Future<List<Halaqa>> getHalaqat(String programId);

  Future<Halaqa?> getHalaqa(String halaqaId);

  Future<Lesson?> getLesson(String halaqaId, String lessonId);

  /// The halaqa surfaced on the home screen.
  Future<Halaqa?> getCurrentHalaqa();
}

abstract interface class ProgressRepository {
  Future<ProgressSummary> getProgress();
}

abstract interface class CertificateRepository {
  Future<List<Certificate>> getCertificates();
  Future<Certificate?> getCertificate(String id);
}

abstract interface class FeedRepository {
  Future<List<Announcement>> getAnnouncements();
  Future<List<AppNotification>> getNotifications();
}

/// Authentication — the only way the app signs a person in or out.
///
/// Screens depend on this contract, never on HTTP, tokens or storage. A
/// network-backed implementation (next milestone) must:
///
///  * keep the access and refresh tokens in platform secure storage
///    (Keychain / Keystore), never in plain preferences, and never log them;
///  * refresh with ONE request at a time. The server rotates refresh tokens
///    and treats a token presented twice as stolen — two concurrent refreshes
///    will sign the user out on purpose;
///  * on a refresh that fails, discard both tokens and return to sign-in;
///  * hold no secret of its own. The app has no API key, and never sees the
///    LiveKit secret — live rooms are joined with a short-lived token the
///    server issues per session.
///
/// There is deliberately no `register`: accounts are created by staff.
abstract interface class AuthRepository {
  /// Throws [AuthException] with the server's code on refusal.
  Future<CurrentUser> signIn({
    required String identifier,
    required String password,
  });

  /// Ends this device's session on the server, then forgets its tokens.
  Future<void> signOut();

  /// The signed-in account, or null when nobody is signed in on this device.
  Future<CurrentUser?> currentUser();

  Future<List<DeviceSession>> sessions();

  /// Signs one of the user's devices out.
  Future<void> endSession(String sessionId);
}

/// Messaging — conversations the signed-in person takes part in.
///
/// Every method throws [MessagingException] with the server's code on
/// refusal. The contract mirrors the backend's typed use cases: one method
/// per message type, never "send(type, anything)".
///
/// Sends take a `clientMessageId` generated once per message and resent
/// verbatim on every retry; the server stores each message exactly once.
/// Media methods upload the file first (declare → PUT → verify) and only
/// then send the message referencing it.
abstract interface class MessagingRepository {
  /// Whose conversations these are — to tell "mine" from "theirs".
  Future<String> viewerId();

  Future<ConversationPage> conversations({String? cursor});

  Future<Conversation> conversation(String conversationId);

  /// Newest page when neither cursor is given; [before]/[after] are sequences.
  Future<MessagePage> messages(
    String conversationId, {
    int? before,
    int? after,
    int limit = 30,
  });

  Future<Message> sendText(
    String conversationId, {
    required String clientMessageId,
    required String body,
  });

  Future<Message> sendVoice(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile recording,
  });

  Future<Message> sendImage(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile image,
    String? caption,
  });

  /// A document or an audio file.
  Future<Message> sendFile(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile file,
    String? caption,
  });

  /// Returns the watermark after the call — never lower than before.
  Future<int> markRead(String conversationId, int sequence);

  /// A short-lived URL to an attachment the viewer may see.
  Future<Uri> attachmentUrl(
    String conversationId,
    String messageId,
    String fileAssetId,
  );
}
