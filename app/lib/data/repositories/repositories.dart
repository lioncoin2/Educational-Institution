import '../models/academic.dart';
import '../models/attendance.dart';
import '../models/auth.dart';
import '../models/certificate.dart';
import '../models/communities.dart';
import '../models/data_origin.dart';
import '../models/feed.dart';
import '../models/institution.dart';
import '../models/learning.dart';
import '../models/live.dart';
import '../models/messaging.dart';
import '../models/notifications.dart';
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

/// Academic — the institution's sections, programs and halaqat, and the
/// signed-in person's own place in them (`/academic`).
///
/// Every method throws [AcademicException] with the server's code on
/// refusal. There is no way to name another person: [me] is always the
/// caller's own record, and the server decides what anyone may see.
///
/// Enrolling and assigning teachers are staff acts on the server. This app
/// offers neither — the institution has not said students may enrol
/// themselves, so no registration flow is invented here.
abstract interface class AcademicRepository {
  /// Where the structure comes from: the printed profile (the demo build),
  /// or the institution's own records (the server).
  DataOrigin get origin;

  /// Every section in order, each with its programs — every status: callers
  /// decide what an inactive one means for them.
  Future<List<AcademicSection>> catalogue();

  /// One program with its section and halaqat, by the server's id — null
  /// when there is no such program.
  Future<AcademicProgramDetail?> program(String programId);

  /// One halaqa and where it sits — null when there is no such halaqa.
  Future<AcademicHalaqaDetail?> halaqa(String halaqaId);

  /// What the caller studies and teaches, now.
  Future<MyAcademic> me();
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
  /// The learner's standing — or null when nothing is recorded to stand on:
  /// no progress is ever computed from nothing, or made up.
  Future<ProgressSummary?> getProgress();
}

abstract interface class CertificateRepository {
  Future<List<Certificate>> getCertificates();
  Future<Certificate?> getCertificate(String id);
}

abstract interface class FeedRepository {
  Future<List<Announcement>> getAnnouncements();
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

  /// A community's chat — an ordinary conversation, typed CHANNEL and
  /// carrying the community's id — resolved from the community, for a person
  /// whose membership lets them read it now. Everything after uses the
  /// ordinary conversation routes with the returned id. Not the viewer's to
  /// read (any more), or no such community: `messaging.conversation_not_found`.
  Future<Conversation> conversationForCommunity(String communityId);

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

/// Communities — the groups the signed-in person belongs to
/// (`/communities`).
///
/// Every method throws [CommunityException] with the server's code on
/// refusal. What the viewer may do in a community is the server's `me`
/// block, and a community the viewer is not (or no longer) in is, to this
/// API, one that does not exist. Pages are the server's, by opaque cursor —
/// a roster is never loaded whole.
///
/// Each write is one request, never retried here: creating a link is not
/// idempotent, and a refusal is the server's answer, not a fault. Nobody is
/// ever added by id — people join through a link, by their own request.
abstract interface class CommunityRepository {
  /// The viewer's own communities, most recently joined first.
  Future<CommunityPage> communities({String? cursor});

  Future<Community> community(String communityId);

  /// The roster, a page at a time — for a viewer whose `me.capabilities`
  /// holds `community.members.view`; anyone else is refused.
  Future<CommunityMemberPage> members(String communityId, {String? cursor});

  // ── Invitation links ──

  /// A new link, on the server's own terms (none are asked for). Its token
  /// is in this answer and in no other, ever.
  Future<CreatedInvitation> createInvitation(String communityId);

  /// The community's links, newest first, in every state — never a token.
  Future<InvitationPage> invitations(String communityId, {String? cursor});

  /// The link as it now stands: revoked — also when it already was.
  Future<CommunityInvitation> revokeInvitation(
    String communityId,
    String invitationId,
  );

  /// Joins the community a link names, by its token — sent in the request
  /// body, nowhere else. The community as the viewer now stands in it:
  /// joined just now or a member already, alike.
  Future<Community> join(String token);

  // ── Membership ──

  /// Ends [userId]'s membership.
  Future<void> removeMember(String communityId, String userId);

  /// Ends the viewer's own membership: from then on, to this API, the
  /// community does not exist.
  Future<void> leave(String communityId);

  // ── Lifecycle ──

  /// The community as it now stands: locked — also when it already was.
  Future<Community> lock(String communityId);

  /// The community as it now stands: open — also when it already was.
  Future<Community> unlock(String communityId);

  // ── Delegated capabilities and ownership ──

  /// [userId]'s grants, as the server shows them to the viewer: to one it
  /// allows `community.grants.manage`, anyone's; to anyone else, only their
  /// own — another member's come back empty.
  Future<GrantPage> grants(
    String communityId, {
    required String userId,
    String? cursor,
  });

  /// Grants [capabilities] to [userId]: those created, and those the member
  /// already held.
  Future<GrantChange> grant(
    String communityId, {
    required String userId,
    required Set<CommunityCapability> capabilities,
  });

  /// Ends a grant — also one already ended.
  Future<void> revokeGrant(String communityId, String grantId);

  /// Hands the community to [userId]. The answer is the community as the
  /// VIEWER now stands in it, not as the new owner does.
  Future<Community> transferOwnership(String communityId, String userId);
}

/// Live sessions — a community's live audio room, read-only
/// (`/live/communities/:id/sessions/current`).
///
/// The non-media foundation: it answers whether a community has a session
/// running now and who hosts it. Joining and media are a separate seam
/// (lib/data/media/live_media_seams.dart), Unavailable in this build — never
/// this repository's concern. A refusal throws [LiveException] with the
/// server's code; what the viewer may do is the server's `me`, never worked
/// out here.
abstract interface class LiveRepository {
  /// The community's running session, or null when none is live now.
  Future<LiveSession?> currentSession(String communityId);

  /// One session by id — running or ended. Throws [LiveException] when it is
  /// not the viewer's to see (`live.session_not_found`, a 404 all the same).
  Future<LiveSession> getSession(String sessionId);

  /// The moderators' hands page: the pending queue, or who holds the floor
  /// (`state`), keyset-paged by an opaque `cursor`. A refusal — including one
  /// for a caller who may not moderate — throws [LiveException], never an
  /// empty page.
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  });

  // ── Moderator commands ─────────────────────────────────────────────────
  // Each command goes to the server, which is the sole authority; the app
  // never recomputes who may act. Nothing here mutates local state: after a
  // command the server emits its realtime fact and the session read is the
  // truth (the live controller reconciles). These return the server's own
  // answer, never an optimistic guess. A refusal throws [LiveException] with
  // the server's code (403 forbidden, 404 gone, 409 conflict, 412
  // precondition, 503 unavailable). Speaking/hand moderation (grant, revoke,
  // decline, raise, lower) is the media/floor flow and is NOT here.

  /// Ends the session — any of its moderators (`POST …/end`). Returns the
  /// session as the server now sees it; ending an ended session succeeds too.
  Future<LiveSession> endSession(String sessionId);

  /// Removes [userId] from the session's media room (Q64, `POST
  /// …/participants/:userId/remove`): an administrative disconnect, never a
  /// ban — they may re-join at once. [reason] is an optional short code the
  /// server validates. `true` when they were connected and removed, `false`
  /// when they were not in the room.
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  });

  /// Resets the session's media room (Q64, `POST …/reset`). `true` when this
  /// call moved the room to a new generation, `false` when a concurrent reset
  /// or the end already did.
  Future<bool> resetRoom(String sessionId);

  /// The caller claims a screen-share (presenter) slot for themselves (Q56,
  /// `POST …/screen-share`). 409 `live.presenter_slots_full` at the cap.
  Future<LiveSession> claimPresenter(String sessionId);

  /// The caller stops their OWN screen share (Q56, `DELETE …/screen-share`);
  /// nothing open succeeds too. No permit needed — it reduces own privilege.
  Future<LiveSession> stopPresenter(String sessionId);

  /// A moderator grants [userId] a delegated screen-share slot (Q56, `POST
  /// …/screen-share/:userId/grant`). The grant does not imply `live.speak`.
  Future<LiveSession> grantPresenter(String sessionId, String userId);

  /// A moderator revokes [userId]'s screen-share grant (Q56, `DELETE
  /// …/screen-share/:userId`); nothing open for them succeeds too.
  Future<LiveSession> revokePresenter(String sessionId, String userId);
}

/// Attendance — recording a live session's attendance snapshot
/// (`/attendance`).
///
/// Record-only in this foundation (attendance.md §17): one press takes a
/// server-side observation of who Live holds connected now and returns the
/// stored header (counts only). Viewing past snapshots and their participants
/// is a later slice. A refusal throws [AttendanceException] with the server's
/// code; the recorder, the community and whom to count are the server's to
/// know — the caller sends only its idempotency key.
abstract interface class AttendanceRepository {
  /// Records a snapshot of [liveSessionId]. [clientRequestId] is generated
  /// once per press and resent verbatim on every retry, so the server stores
  /// exactly one snapshot however many times the network fails (§8); a 201
  /// (new) and a 200 (replay) return the same [SnapshotView].
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  });

  /// A community's snapshots, newest first, one keyset page at a time (§15.1).
  /// [cursor] is the server's opaque token, passed back as received. The view
  /// needs `community.attendance.view`; [liveSessionId] narrows to one session
  /// (also the §11.3 host/recorder path) — the current UI omits it.
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
  });

  /// One snapshot's header (counts only). `attendance.snapshot_not_found` when
  /// unknown, invisible or not permitted — all alike.
  Future<SnapshotView> snapshot(String snapshotId);

  /// One snapshot's participants, keyset-paged on the account id (§15.1).
  /// [connection] narrows to one state; the current UI omits it.
  Future<SnapshotParticipantPage> participants(
    String snapshotId, {
    SnapshotConnection? connection,
    String? cursor,
  });
}

/// Notifications — the signed-in person's own inbox, preferences and push
/// devices (`/notifications`).
///
/// Every method throws [NotificationsException] with the server's code on
/// refusal. There is no way to name another account: the server scopes every
/// call to the caller, and another person's notification is, to this API,
/// one that does not exist.
abstract interface class NotificationsRepository {
  /// Newest first; pass [cursor] from the previous page to continue.
  Future<NotificationPage> list({String? cursor, int limit = 20});

  /// Counted up to 99; beyond that the server only says "more".
  Future<UnreadCount> unreadCount();

  /// Idempotent: returns the notification as stored, read.
  Future<AppNotification> markRead(String notificationId);

  /// Marks read everything up to [throughId] (the newest one the person was
  /// looking at) — or, without it, everything until now. Returns how many.
  Future<int> markAllRead({String? throughId});

  Future<List<ChannelPreferences>> preferences();

  /// Changes one category's channels; switches left null keep their value.
  Future<List<ChannelPreferences>> updatePreferences(
    String category, {
    bool? inApp,
    bool? realtime,
    bool? push,
  });

  /// Registers this device for push, for the signed-in account. The token is
  /// sent once and never comes back.
  Future<RegisteredDevice> registerDevice({
    required String platform,
    required String provider,
    required String token,
  });

  Future<void> unregisterDevice(String deviceId);
}
