import '../models/academic.dart';
import '../models/admin.dart';
import '../models/attendance.dart';
import '../models/auth.dart';
import '../models/certificate.dart';
import '../models/communities.dart';
import '../models/data_origin.dart';
import '../models/feed.dart';
import '../models/institution.dart';
import '../models/learning.dart';
import '../models/live.dart';
import '../models/live_media.dart';
import '../models/messaging.dart';
import '../models/notifications.dart';
import '../models/people.dart';
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

  // ── Structure management (academic.manage; OWNER/ADMIN) ──
  // Staff provisioning of the catalogue. The server gates these on
  // `academic.manage` and re-authorises every call. A `code` and a section's
  // `kind` are set at creation and never change; a parent (`sectionId` /
  // `programId`) is fixed at creation — there is no reparenting route. Nothing
  // is ever deleted: deactivating withholds new enrollment while history stays
  // readable (`setSectionActive`/`setProgramActive`/`setHalaqaActive`). A
  // refusal throws [AcademicException] with the server's code
  // (`academic.code_taken`, `academic.code_invalid`, `academic.name_invalid`,
  // `academic.order_invalid`, `academic.kind_invalid`,
  // `academic.halaqa_has_active_enrollments`, `academic.too_many_*`,
  // `identity.permission_denied`, …). Enrolment and teacher assignment are NOT
  // here — they need the unresolved people-discovery policy (Q6/Q22/Q31).

  Future<AcademicSection> createSection({
    required String code,
    required String name,
    required int order,
    required SectionKind kind,
    String? description,
  });

  /// Edits a section's `name`, `order` and `description` (null clears it). The
  /// code and kind cannot change.
  Future<AcademicSection> updateSection(
    String sectionId, {
    required String name,
    required int order,
    String? description,
  });

  Future<AcademicSection> setSectionActive(
    String sectionId, {
    required bool active,
  });

  Future<AcademicProgram> createProgram({
    required String sectionId,
    required String code,
    required String name,
    required int order,
    String? description,
  });

  /// Edits a program's `name`, `order` and `description` (null clears it). The
  /// code and parent section cannot change.
  Future<AcademicProgram> updateProgram(
    String programId, {
    required String name,
    required int order,
    String? description,
  });

  Future<AcademicProgram> setProgramActive(
    String programId, {
    required bool active,
  });

  Future<AcademicHalaqa> createHalaqa({
    required String programId,
    required String code,
    required String name,
    required int order,
  });

  /// Edits a halaqa's `name` and `order`. A halaqa has no description, and its
  /// code and parent program cannot change.
  Future<AcademicHalaqa> updateHalaqa(
    String halaqaId, {
    required String name,
    required int order,
  });

  /// Deactivation is refused with `academic.halaqa_has_active_enrollments`
  /// (412) while it still has active enrollments.
  Future<AcademicHalaqa> setHalaqaActive(
    String halaqaId, {
    required bool active,
  });

  // ── Relationships (academic.manage; OWNER/ADMIN) ──
  // Enrolling a student and assigning a teacher are administrators' acts. The
  // student/teacher is found through the people directory (PeopleRepository,
  // `people.read`); the server re-authorises every write and confirms, on its
  // own, that the account is an ACTIVE, eligible student (`academic.study`) or
  // teacher (`academic.teach`) — this app never infers eligibility from a name
  // or a client claim (a refusal carries `academic.student_not_eligible` /
  // `academic.teacher_not_eligible`). Ending preserves history; there is no
  // move (Q37). These never enrol anyone automatically from community
  // membership, and never the reverse.

  /// A halaqa's current students (keyset page). [status] filters by enrollment
  /// status (e.g. `ACTIVE`); omit for all.
  Future<AcademicPage<HalaqaRosterEntry>> halaqaStudents(
    String halaqaId, {
    String? status,
    String? cursor,
  });

  /// Enrols [studentUserId] in the halaqa. Returns the enrollment (existing if
  /// already enrolled). Throws [AcademicException] on refusal (nothing added).
  Future<EnrollmentRecord> enrollStudent(
    String halaqaId, {
    required String studentUserId,
  });

  /// Ends an enrollment with [outcome]; the record is never deleted or reopened.
  Future<EnrollmentRecord> endEnrollment(
    String enrollmentId, {
    required EnrollmentOutcome outcome,
  });

  /// A halaqa's teachers (keyset page). [status] filters by assignment status.
  Future<AcademicPage<HalaqaTeacherEntry>> halaqaTeachers(
    String halaqaId, {
    String? status,
    String? cursor,
  });

  /// Assigns [teacherUserId] to the halaqa in [role]. Returns the assignment
  /// (existing if already assigned in that role). Assigning the same teacher in
  /// a different role is refused (`academic.teacher_already_assigned`).
  Future<AssignmentRecord> assignTeacher(
    String halaqaId, {
    required String teacherUserId,
    required TeachingRole role,
  });

  /// Ends a teaching assignment; the record is never deleted or reopened.
  Future<AssignmentRecord> endAssignment(String assignmentId);
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

/// Admin account provisioning (`/admin/users`) — staff create and view the
/// institution's accounts. There is no self-registration; this is the only way
/// an account comes into existence. The server is the authority: it gates the
/// list on `users.read` and creation on `users.manage`, and re-authorises every
/// request. A refusal throws [AdminException] with the server's code. No
/// password or credential is ever returned.
abstract interface class AdminRepository {
  /// The institution's accounts, a keyset page at a time (newest-registered
  /// first) — for a holder of `users.read`.
  Future<AdminAccountPage> accounts({String? cursor});

  /// Provisions a new account (status PENDING, no roles) with [displayName], an
  /// email [identifier] and an [initialPassword] — for a holder of
  /// `users.manage`. The server normalises/validates (email shape; password
  /// ≥ 8); a taken identifier throws [AdminException] `identity.identifier_taken`.
  Future<AdminAccount> createAccount({
    required String displayName,
    required String identifier,
    required String initialPassword,
  });
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

  /// Start — or return — the direct conversation with [userId] (Q6, owner
  /// GROUP A ruling). The server decides who the viewer may reach: a student
  /// reaches another student (`messaging.start_direct_peer`), staff any
  /// addressable account (`messaging.start_direct`). A counterpart the viewer
  /// may not reach and an unknown account are refused alike
  /// (`messaging.participant_not_eligible`), so the app cannot probe. Idempotent:
  /// the same pair always yields the one canonical conversation, whether it was
  /// just created or already existed.
  Future<Conversation> startDirect(String userId);

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

  // ── Moderation (community chat only, ADR 0029) ──────────────────────────
  // The server is the sole authority: it asks Communities for
  // `community.messages.moderate` per call. The app shows these only when the
  // community's `me` already grants it, but every call still re-authorizes. A
  // refusal throws [MessagingException] with the server's code (403
  // `messaging.message_moderation_forbidden`, 404 for a non-member / a
  // non-community chat / an absent message, 503 when Communities is
  // unreachable).

  /// Deletes a message in a community's chat as a moderator — a tombstone, not
  /// a hard delete. Idempotent: deleting an already-deleted message succeeds
  /// too. Returns nothing; the message then reads as deleted (its body and
  /// attachments blanked), and the original is reviewable for 7 days.
  Future<void> deleteMessage(String conversationId, String messageId);

  /// Reveals a deleted message's original for the review window (7 days) — the
  /// one disclosure of the content and who deleted it, audited server-side. Past
  /// the window, or with no such deleted message, throws [MessagingException]
  /// (`messaging.deleted_message_review_expired` / `_not_found`).
  Future<ReviewedMessage> reviewDeletedMessage(
    String conversationId,
    String messageId,
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

  /// Creates a community the viewer will own and be the first member of, with
  /// [title] — for a holder of `communities.create` (OWNER/ADMIN). The server
  /// normalises and validates the title (1–100 characters) and decides afresh
  /// on every request; a refusal throws [CommunityException]
  /// (`identity.permission_denied`, `communities.title_invalid`, a rate limit).
  /// Not idempotent — each call makes a new community.
  Future<Community> create(String title);

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

  /// Candidates to add to THIS community, by display-name prefix (a blank query
  /// is an empty page), a keyset page at a time by an opaque [cursor]. The
  /// server gates it on `community.members.invite` IN this community — a
  /// community-scoped search, never the institution-wide directory — and
  /// discloses only {userId, displayName}. A refusal (the caller lacks invite
  /// authority here) throws [PeopleException]. Finding a candidate is not adding
  /// them: [addMembers] is a separate, re-authorised mutation.
  Future<PeopleSearchPage> memberCandidates(
    String communityId,
    String query, {
    String? cursor,
  });

  /// Adds (or re-adds) accounts to the community by id — the owner, or a holder
  /// of `community.members.invite`. Idempotent: an account already a member is
  /// left as it is. The server decides afresh (the capability, and that each id
  /// is an account that may take part); a refusal throws [CommunityException].
  /// The ids come from [memberCandidates], a search the viewer was authorised to
  /// run in this community, never an open directory.
  Future<void> addMembers(String communityId, List<String> userIds);

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

  // ── Academic halaqa link (Q50) ──

  /// Associates the community with academic halaqa [halaqaId] — institutional
  /// oversight only (the server gates it on `communities.manage`, surfaced as
  /// `me.canManageHalaqa`). The link is inert metadata: it adds and removes no
  /// member and confers no capability. The server validates that the halaqa
  /// exists; a missing one throws [CommunityException]
  /// (`communities.halaqa_not_found`). The answer is the community as it now
  /// stands, with its `halaqaId` set.
  Future<Community> linkHalaqa(String communityId, String halaqaId);

  /// Clears the community's academic halaqa association. Idempotent; the
  /// answer is the community with `halaqaId` null.
  Future<Community> unlinkHalaqa(String communityId);
}

/// People discovery — finding an account by name. [search] is the OWNER/ADMIN
/// institution-wide directory (`GET /people`, `people.read`); the student-facing
/// teacher directory ([searchTeachers]) is separate. Community add-member
/// discovery is NOT here — it is `CommunityRepository.memberCandidates`, scoped
/// to the community. Not an open directory: a result discloses only
/// {userId, displayName}, and the server decides whom the caller may find
/// (finding an account is not adding it anywhere — ADR 0032). A refusal throws
/// [PeopleException].
abstract interface class PeopleRepository {
  /// Accounts whose display name begins with [query] (a blank query is an
  /// empty page), a keyset page at a time by an opaque [cursor]. Gated on the
  /// server by `people.read` (OWNER/ADMIN only since migration 0020).
  Future<PeopleSearchPage> search(String query, {String? cursor});

  /// Eligible TEACHERS whose display name begins with [query] — the
  /// student-facing teacher directory (Q6), gated on the server by the
  /// student's `messaging.start_direct_teacher`. Returns only teachers (never
  /// students, administrators or the owner), same minimal {userId, displayName}.
  Future<PeopleSearchPage> searchTeachers(String query, {String? cursor});
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

  /// Starts a live session for [communityId] and returns it — for a holder of
  /// `community.live.start` here (the server re-authorises). Idempotent: when a
  /// session is already running, that one is returned (the caller need not tell
  /// the cases apart). Throws [LiveException] on refusal, or when the media room
  /// cannot be made (`live.media_unavailable`).
  Future<LiveSession> start(String communityId);

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

  // ── Media ──────────────────────────────────────────────────────────────

  /// Asks the server for a media credential to join the session's room (`POST
  /// …/join`) — the only call that returns a token. The server decides the
  /// identity and what may be published and encodes them; this is transport,
  /// safe to call again (it is the way back in after a disconnect). A refusal
  /// — 403 forbidden, 404 gone, 412 not live, 429 too many joins, 503 media
  /// unavailable — throws [LiveException] with the server's code. The returned
  /// [LiveMediaGrant] is ephemeral and carries the credential; only the media
  /// client ever consumes it.
  Future<LiveMediaGrant> join(String sessionId);
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
