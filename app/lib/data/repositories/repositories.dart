import '../models/academic.dart';
import '../models/admin.dart';
import '../models/attendance.dart';
import '../models/auth.dart';
import '../models/certificate.dart';
import '../models/command_center.dart';
import '../models/communities.dart';
import '../models/data_origin.dart';
import '../models/feed.dart';
import '../models/institution.dart';
import '../models/learning.dart';
import '../models/live.dart';
import '../models/live_chat.dart';
import '../models/live_media.dart';
import '../models/live_room.dart';
import '../models/messaging.dart';
import '../models/notifications.dart';
import '../models/people.dart';
import '../models/progress.dart';
import '../models/program.dart';
import '../models/publication.dart';
import '../models/scheduling.dart';
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

  /// Binds [coverFileAssetId] (an image the manager uploaded via
  /// `FilesRepository.uploadImage`) as the program's cover (ADR 0038) —
  /// `academic.manage` only. Replacing simply binds a new id. The answer is the
  /// program with its `coverFileAssetId` set.
  Future<AcademicProgram> setProgramCover(String programId, String coverFileAssetId);

  /// Clears the program's cover image. Idempotent; the answer has `coverFileAssetId`
  /// null.
  Future<AcademicProgram> clearProgramCover(String programId);

  /// A short-lived signed link to the program's cover image — readable by anyone
  /// who may read the catalogue (`academic.read`). Throws [AcademicException]
  /// (`academic.program_cover_not_found`) when there is no cover.
  Future<Uri> programCoverUrl(String programId);

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

  // ── Relationship history (read-only; academic.manage; OWNER/ADMIN) ──
  // A person's full academic history, newest first, every status, a keyset page
  // at a time — an academic administrator's view (never reached through a
  // teaching assignment, Q31). The server re-authorises each read.

  /// One student's enrollment history (`GET /academic/students/:id/enrollments`),
  /// each record with where it sits. Paginated; pass [cursor] for the next page.
  Future<AcademicPage<PlacedEnrollment>> studentEnrollments(
    String userId, {
    String? cursor,
  });

  /// One teacher's assignment history (`GET /academic/teachers/:id/assignments`),
  /// each record with where it sits. Paginated; pass [cursor] for the next page.
  Future<AcademicPage<PlacedAssignment>> teacherAssignments(
    String userId, {
    String? cursor,
  });

  /// The SIGNED-IN student's own enrollment history (`GET /academic/me/
  /// enrollments`), every status, newest first, each record with where it sits.
  /// The server answers by the authenticated identity — no user id — so a
  /// student reads only their own record (`academic.read`). Paginated; pass
  /// [cursor] for the next page.
  Future<AcademicPage<PlacedEnrollment>> myEnrollments({String? cursor});

  /// The SIGNED-IN teacher's own assignment history (`GET /academic/me/
  /// teaching`), every status, newest first, each record with where it sits.
  /// The server answers by the authenticated identity — no user id — so a
  /// teacher reads only their own record (`academic.read`). Paginated; pass
  /// [cursor] for the next page.
  Future<AcademicPage<PlacedAssignment>> myTeaching({String? cursor});
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

  /// Changes THIS account's password. The server verifies [currentPassword],
  /// enforces the policy (≥ 8 code points, not blank, and different from the
  /// current), and ends every OTHER device's session — this device stays
  /// signed in. Throws [AuthException] with the server's code on refusal
  /// (`identity.current_password_incorrect`, `identity.password_too_short`,
  /// `identity.password_unchanged`, …).
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  });
}

/// The signed-in user's own files: profile picture, and uploads they own
/// (`/files/*`). The upload itself (`/files/uploads` declare → PUT → complete)
/// is one flow the server verifies (size, signature, that it is an image); only
/// then may a reference be bound. A refusal throws a `FilesException` with the
/// server's code.
abstract interface class FilesRepository {
  /// Uploads [image] and returns its Files asset id — the reference other
  /// things (an avatar, a community picture) point at. Does not bind it to
  /// anything; the caller does that next.
  Future<String> uploadImage(OutgoingFile image);

  /// Uploads any [file] (image, document or voice recording) and returns its
  /// Files asset id — the same declare→PUT→complete flow as [uploadImage], for
  /// any accepted kind. Upload once, then reference the id wherever it is
  /// attached (e.g. a mass publish to several communities).
  Future<String> upload(OutgoingFile file);

  /// Points the signed-in account at [fileAssetId] as its profile picture. The
  /// server verifies it is an image the caller owns.
  Future<void> setMyAvatar(String fileAssetId);

  /// Removes the signed-in account's profile picture.
  Future<void> removeMyAvatar();

  /// A short-lived link to an asset the caller owns — how the app renders its
  /// own picture (whose reference it already holds from `/auth/me`).
  Future<Uri> ownAssetLink(String fileAssetId);
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

  // ── Account lifecycle administration (OWNER/ADMIN) ──
  // Each act re-authorises on the server, which also enforces what a route
  // cannot: the target is not the caller (`identity.self_administration`), the
  // caller outranks the target (`identity.target_outranks_actor`), and a role
  // granted carries no permission the caller lacks (`identity.role_outranks_actor`).
  // The app never assumes a role or transition is permitted because the UI
  // offers it. Role/status writes return the fresh account; password and
  // session revocation return no account and expose no credential.

  /// One account's full record (`GET /admin/users/:id`) — for `users.read`.
  Future<AdminAccount> account(String userId);

  /// Grants [role] to the account; returns the updated account. Gated on
  /// `roles.assign`; refused with `identity.role_outranks_actor` /
  /// `identity.role_unknown` and the shared guard's codes.
  Future<AdminAccount> assignRole(String userId, {required String role});

  /// Removes [role] from the account; returns the updated account
  /// (`roles.assign`).
  Future<AdminAccount> removeRole(String userId, {required String role});

  /// Moves the account to [status] (`users.manage`). Only transitions the
  /// server allows succeed; others throw `identity.status_transition_invalid`.
  Future<AdminAccount> setStatus(
    String userId, {
    required AccountStatus status,
  });

  /// Sets a new password for the account (`users.manage`). Sent once and kept
  /// nowhere; returns nothing. A too-short password throws
  /// `identity.password_too_short`.
  Future<void> resetPassword(String userId, {required String newPassword});

  /// Ends every session the account holds (`sessions.manage`); returns how many
  /// were ended.
  Future<int> revokeSessions(String userId);
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

    /// The id of a message in THIS conversation this one answers, when it is a
    /// reply. The server validates it (same conversation, visible to the
    /// sender) — the client never forges the relationship.
    String? replyToMessageId,
  });

  Future<Message> sendVoice(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile recording,
    String? replyToMessageId,
  });

  Future<Message> sendImage(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile image,
    String? caption,
    String? replyToMessageId,
  });

  /// A document or an audio file. [replyToMessageId], when set, answers a
  /// message in this conversation (the server validates it, as it does for
  /// text — same conversation, visible to the sender).
  Future<Message> sendFile(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile file,
    String? caption,
    String? replyToMessageId,
  });

  /// Publish one notice / image / voice recording / document to several
  /// communities at once ("النشر الجماعي", `POST /messaging/communities/publish`).
  /// The server authorizes each community on its own `community.chat.post`, so
  /// the report carries a per-community outcome: partial failure is normal, not
  /// an error. Retrying with the SAME [clientBatchId] re-posts nothing a
  /// community already received (idempotent), so only transient failures need a
  /// resend. Media is uploaded first (see [FilesRepository.upload]); pass its
  /// [fileAssetId] and the matching [kind] ('IMAGE'/'VOICE'/'FILE'), or [kind]
  /// 'TEXT' with a [body]. A request-level problem (empty body, an attachment
  /// the viewer does not own) throws [MessagingException].
  Future<PublicationReport> publishToCommunities({
    required String clientBatchId,
    required List<String> communityIds,
    required String kind,
    String? body,
    String? fileAssetId,
  });

  /// Returns the watermark after the call — never lower than before.
  Future<int> markRead(String conversationId, int sequence);

  /// A short-lived URL to an attachment the viewer may see.
  Future<Uri> attachmentUrl(
    String conversationId,
    String messageId,
    String fileAssetId,
  );

  /// A short-lived link to the picture of the sender of [messageId] in
  /// [conversationId] — resolved at view time, like the sender's name. Throws
  /// [MessagingException] `messaging.sender_avatar_not_found` when the sender
  /// has no picture (the UI then shows initials).
  Future<Uri> senderAvatarUrl(String conversationId, String messageId);

  /// Edits the viewer's OWN message (ADR 0045): a text message's [body], or a
  /// media message's caption ('' clears it) — never its attachments. Only the
  /// author edits; anyone else's message is `messaging.message_not_found`, a
  /// deleted one `messaging.message_deleted`. Returns the message as it now
  /// reads, `editedAt` set (unset when the text did not change).
  Future<Message> editMessage(
    String conversationId,
    String messageId, {
    required String body,
  });

  // ── Moderation (community chat only, ADR 0029) ──────────────────────────
  // The server is the sole authority: it asks Communities for
  // `community.messages.moderate` per call. The app shows these only when the
  // community's `me` already grants it, but every call still re-authorizes. A
  // refusal throws [MessagingException] with the server's code (403
  // `messaging.message_moderation_forbidden`, 404 for a non-member / a
  // non-community chat / an absent message, 503 when Communities is
  // unreachable).

  /// Deletes a message — the viewer's OWN, in any conversation (ADR 0045), or,
  /// as a community chat's moderator, anyone's there (ADR 0029). A tombstone,
  /// not a hard delete. Idempotent: deleting an already-deleted message
  /// succeeds too. Returns nothing; the message then reads as deleted (its
  /// body and attachments blanked), and the original is reviewable for 7 days.
  Future<void> deleteMessage(String conversationId, String messageId);

  /// Reveals a deleted message's original for the review window (7 days) — the
  /// one disclosure of the content and who deleted it, audited server-side. Past
  /// the window, or with no such deleted message, throws [MessagingException]
  /// (`messaging.deleted_message_review_expired` / `_not_found`).
  Future<ReviewedMessage> reviewDeletedMessage(
    String conversationId,
    String messageId,
  );

  /// Pin a message in a community's chat (ADR 0043). The server authorizes via
  /// `community.messages.moderate` and validates that the message is a live
  /// message of this conversation; it replaces any current pin (one per
  /// conversation) and is idempotent. Throws [MessagingException] on refusal.
  Future<void> pinMessage(String conversationId, String messageId);

  /// Clear the community chat's pin (ADR 0043). Never deletes the message;
  /// idempotent. Throws [MessagingException] on refusal.
  Future<void> unpinMessage(String conversationId);
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
  /// [title] and [kind] (ADR 0039) — for a holder of `communities.create`
  /// (OWNER/ADMIN). A [CommunityKind.group] opens posting to its members; a
  /// [CommunityKind.channel] restricts publishing to the owner and delegated
  /// publishers. The server normalises and validates the title (1–100
  /// characters) and decides afresh on every request; a refusal throws
  /// [CommunityException] (`identity.permission_denied`,
  /// `communities.title_invalid`, a rate limit). Not idempotent — each call
  /// makes a new community.
  Future<Community> create(String title, {CommunityKind kind = CommunityKind.group});

  /// Restricts ordinary-member posting ([membersMayPost] false → read-only) or
  /// restores it (true) in a GROUP (ADR 0039) — for a holder of
  /// `community.chat.manage` in THIS community (surfaced as
  /// `me.has(CommunityCapability.chatManage)`). A channel cannot be changed and
  /// is refused; the server re-authorises and decides. A refusal throws
  /// [CommunityException] (`identity.permission_denied`,
  /// `communities.capability_required`, `communities.chat_mode_transition_invalid`).
  /// Returns the community as it now stands — never optimistic.
  Future<Community> setChatMode(String communityId, {required bool membersMayPost});

  /// Replaces the community's own [title], [description] and picture together —
  /// for a holder of `community.profile.edit` in THIS community (surfaced as
  /// `me.has(CommunityCapability.profileEdit)`). [description] and
  /// [avatarFileAssetId] are null to clear; a new picture's id comes from
  /// [FilesRepository.uploadImage]. The server re-authorises and verifies a new
  /// picture is an image the editor owns; a refusal throws [CommunityException]
  /// (`identity.permission_denied`, `communities.capability_required`,
  /// `communities.title_invalid`, `communities.avatar_invalid`). Returns the
  /// community as it now stands.
  Future<Community> updateProfile(
    String communityId, {
    required String title,
    String? description,
    String? avatarFileAssetId,
  });

  /// A short-lived link to the community's picture, for anyone who may view the
  /// community. Throws [CommunityException] `communities.avatar_not_found` when
  /// there is none.
  Future<Uri> communityAvatarUrl(String communityId);

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

  // ── Academic halaqa links (Q50) ──

  /// Adds an academic halaqa association ([halaqaId]) to the community —
  /// institutional oversight only (the server gates it on `communities.manage`,
  /// surfaced as `me.canManageHalaqa`). A group or channel may be associated
  /// with many halaqat; linking the same one twice is a no-op. The link is
  /// inert metadata: it adds and removes no member and confers no capability.
  /// The server validates that the halaqa exists; a missing one throws
  /// [CommunityException] (`communities.halaqa_not_found`). The answer is the
  /// community as it now stands, with the halaqa in its `halaqaIds`.
  Future<Community> linkHalaqa(String communityId, String halaqaId);

  /// Removes one academic halaqa association ([halaqaId]) from the community.
  /// Idempotent; the answer is the community with that id gone from `halaqaIds`.
  Future<Community> unlinkHalaqa(String communityId, String halaqaId);
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

  /// A short-lived link to a search result's picture (`GET /people/:userId/avatar`),
  /// for a caller who may read the directory (`people.read`). Throws
  /// [PeopleException] `people.person_avatar_not_found` when the person has no
  /// picture — the view then shows the default (initials). Only call it for a
  /// result whose [PersonSearchResult.hasAvatar] is true.
  Future<Uri> personAvatarUrl(String userId);
}

/// A live session's own chat (`/live/sessions/:id/chat`, ADR 0047) — the
/// session's, never the community's conversation, and a separate seam from
/// [LiveRepository] so the session's state never waits on it.
///
/// Every refusal throws [LiveException] with the server's code: 404
/// `live.session_not_found` (not a participant, or no such session), 403
/// `live.chat_locked` (a moderator closed it), 412 `live.session_not_live`
/// (ended), 403 `live.not_a_moderator` for a lock by a non-moderator.
abstract interface class LiveChatRepository {
  /// The newest page, or the one older than [before] (a previous page's
  /// `nextCursor`), with the lock and what the viewer may do now.
  Future<LiveChatPage> page(String sessionId, {String? before});

  /// Posts [body]. [clientMessageId] is generated once per message and resent
  /// verbatim on a retry: the server stores it once.
  Future<LiveChatMessage> post(
    String sessionId, {
    required String clientMessageId,
    required String body,
  });

  /// A moderator closes ([locked] true) or re-opens the chat. Idempotent.
  Future<LiveChatLockState> setLocked(String sessionId, {required bool locked});
}

/// The live room's presentation reads and ephemeral acts (C15) — kept beside,
/// not inside, [LiveRepository], whose many test doubles stay as they are.
/// A refusal throws [LiveException] with the server's code.
abstract interface class LiveRoomRepository {
  /// A short-lived link to [userId]'s profile picture in this session (ADR
  /// 0048), or null when they have none or are not the viewer's to see — the
  /// room then shows initials. Only people the room already names to the viewer
  /// resolve: themself, the host and presenters; anyone, for a moderator.
  Future<Uri?> participantAvatarUrl(String sessionId, String userId);

  /// Sends one of the room's four reactions (ADR 0049). Nothing is stored;
  /// the session's other participants see it as it happens.
  Future<void> react(String sessionId, LiveReactionKind kind);
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
  // precondition, 503 unavailable). The speaking (floor) flow — a participant
  // raising or lowering their own hand, and a moderator granting, declining or
  // revoking it — is the section below.

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

  // ── Speaking: the floor (raise a hand, and moderate it) ─────────────────
  // The server is the sole authority. A command returns the speaker request
  // as the server now records it; the authoritative `me.hand`, the speaker
  // count and the moderators' queue arrive through the session read and the
  // hands re-read, never fabricated here. A refusal throws [LiveException]
  // with the server's code. The floor permits speaking (audio); the audio
  // itself is the media seam, unavailable in this build — a granted floor is a
  // standing the server tracks, never a claim that audio flows.

  /// The caller raises a hand — asks for the floor (`POST …/hand`,
  /// `live.raise_hand`). Idempotent: a hand already up returns that one.
  /// Returns the speaker request as stored; the authoritative `me.hand` then
  /// arrives through the session read.
  Future<LiveHand> raiseHand(String sessionId);

  /// The caller lowers their OWN hand, or yields the floor (`DELETE …/hand`).
  /// Returns the now-withdrawn request, or null when none was up. No permit —
  /// it only reduces the caller's own standing.
  Future<LiveHand?> lowerHand(String sessionId);

  /// A moderator gives the floor to a waiting hand (`POST
  /// /live/requests/:requestId/grant`, `live.moderate`); [requestId] is the
  /// hand's own id (from the roster). A repeat is accepted unchanged.
  Future<LiveHand> grantFloor(String requestId);

  /// A moderator passes over a waiting hand (`POST
  /// /live/requests/:requestId/decline`): the request is closed, no floor given.
  Future<LiveHand> declineHand(String requestId);

  /// A moderator takes the floor back (`POST /live/requests/:requestId/revoke`);
  /// the speaker stays in the room as a listener.
  Future<LiveHand> revokeFloor(String requestId);

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

  /// The caller's own muted conversations — the set of conversation ids whose
  /// PUSH the viewer has silenced (Q6 / ADR 0036). Self-scoped on the server
  /// (`GET /notifications/mutes`); in-app and realtime delivery are unaffected.
  Future<Set<String>> mutedConversations();

  /// Silences push for one conversation (`PUT /notifications/mutes/:id`,
  /// idempotent). Throws [NotificationsException] on refusal.
  Future<void> muteConversation(String conversationId);

  /// Restores push for one conversation (`DELETE /notifications/mutes/:id`,
  /// idempotent). Throws [NotificationsException] on refusal.
  Future<void> unmuteConversation(String conversationId);
}

/// Reporting — the Owner Command Center read model
/// (`GET /reporting/command-center`).
///
/// READ-ONLY. It asks the server for the widgets the viewer may see, each
/// already resolved to its current facts; the server authorizes (`reports.read`
/// at the edge, and each widget filtered to the viewer's permissions), so the
/// app never decides who may see what. A refusal — forbidden, unavailable,
/// unauthenticated — throws [ReportingException] with the server's code, never
/// a fabricated or empty dashboard.
abstract interface class ReportingRepository {
  /// The command center as the server resolves it for the caller now. An empty
  /// set of widgets is a valid answer (nothing registered, or nothing the
  /// viewer may see), not an error.
  Future<CommandCenter> commandCenter();
}

/// Scheduling of individual dated lessons (ADR 0042).
///
/// Every call requires `operations.schedule_manage` server-side (owner/admin);
/// the app only surfaces it to a holder as a courtesy. A refusal — forbidden,
/// not found, a nonexistent/past time, a bad timezone — throws a
/// [SchedulingException] with the server's code; nothing is fabricated.
abstract interface class SchedulingRepository {
  DataOrigin get origin;

  /// A page of lessons ordered by scheduled instant, optionally one halaqa's.
  Future<LessonPage> lessons({String? halaqaId, String? cursor});

  /// One lesson by id. Throws `operations.lesson_not_found` if there is none.
  Future<ScheduledLesson> lesson(String id);

  /// Schedule a dated lesson for one halaqa. `date` is 'YYYY-MM-DD', `time` is
  /// 'HH:MM', `timezone` an IANA zone id. `clientRequestId` makes a retried
  /// create idempotent.
  Future<ScheduledLesson> schedule({
    required String halaqaId,
    String? title,
    required String date,
    required String time,
    required String timezone,
    String? clientRequestId,
  });

  /// Reschedule an existing lesson's time/zone and (optionally) its title.
  /// `title` null clears it; a SCHEDULED lesson only.
  Future<ScheduledLesson> reschedule(
    String id, {
    required String date,
    required String time,
    required String timezone,
    String? title,
  });

  /// Cancel a lesson — an auditable state transition, never a delete.
  Future<ScheduledLesson> cancel(String id);
}
