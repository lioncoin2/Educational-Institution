# Module Boundaries

One section per module. Each states: **responsibility**, **owned entities**,
**use cases**, **public contract**, **events**, **dependencies**, and — the part
that actually does the work — **what it must not know**.

A module is a unit of ownership, not a folder. If two modules need the same
table, one of them is wrong.

**Implementation state** is marked on every module. Of the fourteen business
modules, nine are implemented (identity, live, files, messaging, realtime,
notifications, academic, communities, attendance); the other five are
deliberately empty: contracts and a Nest module, no implementation. Deciding the
boundary before the code arrives is cheap; retrofitting one is not.

> **Landed (P2, P3):** the `communities` module
> ([communities.md](communities.md),
> [ADR 0016](decisions/0016-communities-module.md) Accepted) owns
> communities, their membership, invitation links and lifecycle, and has its
> own section below. It is what the brief calls "groups". The code name is
> Community because "group" already means messaging's `GROUP` conversation
> type, and is used for Tahajji's «مجموعة» in
> [Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups).
>
> **Landed (P9, 2026-10):** the `attendance` module
> ([attendance.md](attendance.md),
> [ADR 0020](decisions/0020-attendance-snapshots.md) Accepted,
> [ADR 0023](decisions/0023-attendance-authorization-and-policy.md)) owns
> attendance snapshots taken during a community's live session — an immutable,
> append-only observation of who the media provider held, and the read surface
> over it. It has its own section below. The
> [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules)
> hold ([ADR 0016](decisions/0016-communities-module.md)) and the attendance
> policy questions (Q8/Q12/Q69, [ADR 0023](decisions/0023-attendance-authorization-and-policy.md))
> are resolved; the sections below describe the modules that exist today.

---

## identity

**State:** implemented — Identity & Access V1. Domain, use cases, Postgres and
in-memory adapters, HTTP, the access guard, a CLI, and tests on real Postgres.
See [authentication.md](authentication.md),
[session-management.md](session-management.md), and
[authorization.md](authorization.md).

**Responsibility.** Who may sign in, on which devices, and what they may do. It
is the only module that answers an authorization question.

**Owned entities.** `User` (an account), `LoginIdentifier`, `RoleAssignment`,
`AuthSession`, role and permission catalogues, `PolicyRule`. `Principal` is
resolved per request, never stored.

**Use cases.** Sign-in, refresh with rotation, logout; list and end your own
sessions; current user; change your password; provisioning (create, assign and
revoke roles, change status, reset password, end someone's sessions, list and
read accounts); owner bootstrap; per-request principal resolution. It also
*stores* a reference to each account's profile picture (`avatarFileAssetId`, a
Files asset id) — surfaced on `/auth/me` and `AccountSummary`, and written only
through `ACCOUNT_AVATAR_WRITER` — but never verifies or serves the image: that
is Files' (ADR 0038).

**Public contract** (`identity/contracts/`): `AuthorizationService`
(`can`, `authorize`), the permission catalogue, the route declarations
(`RequirePermission`, `Authenticated`, `PublicRoute`), `Principal`,
`systemPrincipal`, and `AccountDirectory` — who an account is (id, display
name, avatar reference, active) and whether it may take part in something, for
modules that reference accounts they did not create; `ACCOUNT_AVATAR_WRITER` —
the only way another module records which Files asset is an account's picture,
so Files (which verifies the image) can store it without identity depending on
Files (ADR 0038); and `AccessTokenAuthenticator` — the HTTP guard's own
authentication (`ResolvePrincipalUseCase`), for a connection that is not a
request, plus `revalidate` to re-check a live session without holding its
token. The module exports exactly five providers: `AUTHORIZATION_SERVICE`,
`ACCOUNT_DIRECTORY`, `ACCOUNT_AVATAR_WRITER`, `ACCOUNT_SEARCH` and
`ACCESS_TOKEN_AUTHENTICATOR`.

**Events.** `identity.user.created`, `identity.role.assigned`,
`identity.role.revoked`, `identity.account.status_changed`. Payloads carry ids
and codes only, never an email or a name.

**Depends on.** `shared`, `platform` (config, database, audit, rate limiter,
HTTP plumbing).

**Must not know.** Programs, halaqat, attendance, messages, rooms. Nor Files:
it stores a picture's asset id as an opaque reference and never imports Files
(the dependency runs files → identity, so it could not without a cycle). A
permission string is opaque to identity: it does not know that `live.moderate`
concerns audio. Adding a permission is still identity's change — its catalogue, its
provisional matrix and a seed migration, kept in step by a test — even though
identity never learns what the permission means. And no other module may read
identity's tables. A test asserts that nothing outside identity imports its
schema.

> **Rewritten in Phase 0 (2026-09-23)** to match the correction below.
>
> **Correction (2026-09-23):** the claim that "any module can define
> permissions without identity changing" is false. A permission exists only
> if it is in identity's catalogue (`identity/contracts/permissions.ts:16-17`:
> "Adding a permission is a code change AND a migration"). Who holds it is
> identity's provisional matrix (`identity/domain/provisional-policy.ts:32`).
> A migration seeds both into identity's own `permissions` and
> `role_permissions` tables, and a test fails if code and tables drift
> (`test/integration/identity-persistence.spec.ts:84-103`). Messaging and
> academic each added their permissions this way
> (`drizzle/0005_seed_messaging_permissions.sql`,
> `drizzle/0008_seed_academic_permissions.sql`).

---

## people

**State:** contract only.

**Responsibility.** The human record behind a login: profile, guardians, and
which institutional roles a person occupies.

The split from `identity` is deliberate and is the one most likely to be
questioned. Identity answers *"may this login do X"*; people answers *"who is
this human"*. A young learner may exist as a person with no login at all; a
support account may exist as a login with no person record. Merging them would
make both cases awkward.

**Owned entities.** `Person`, `Guardianship`, `StaffProfile`.

**Public contract.** `PersonRef`, `PersonKind`.

**Depends on.** `identity/contracts` (to link a person to a user, and — for the
people search — to find and authorize through `ACCOUNT_SEARCH`,
`ACCOUNT_DIRECTORY` and `AUTHORIZATION_SERVICE`); `files/contracts` (to turn a
search result's picture reference into a short-lived link through `FILE_ASSETS`,
`GET /people/:userId/avatar`, after re-asking `people.read` — ADR 0038).

**Must not know.** Passwords, tokens, permission evaluation. It never stores or
serves the picture bytes — only resolves a link to a reference Files owns.

---

## academic

**State:** implemented — Academic Core V1 ([academic.md](academic.md),
[ADR 0014](decisions/0014-academic-core-v1.md)).

**Responsibility.** The institution's academic structure and who is in it:
sections, programs and halaqat; which students are enrolled in a halaqa, and
which teachers teach it — with history.

**Owned entities.** `Section`, `Program`, `Halaqa`, `Enrollment`,
`TeacherAssignment` (tables `academic_*`).

**Use cases.** Read the catalogue; create, edit, activate and deactivate
structure; enroll a student and end the enrollment; assign a teacher and end
the assignment; read a halaqa's students and teachers (resource-scoped);
read someone's history (administrators); read one's own record; seed the
structure from the printed institution profile (provisional — see
[academic-reconciliation.md](academic-reconciliation.md)).

**Public contract.** `ACADEMIC_RELATIONSHIPS` — `isEnrolled`, `isTeaching`,
`activeStudentIds` — plus the vocabulary (`SectionKind`, statuses, roles) and
the `academic.*` event types.

**Events.** `academic.section|program|halaqa.created|updated|activated|deactivated`,
`academic.student.enrolled`, `academic.student.enrollment_ended`,
`academic.teacher.assigned`, `academic.teacher.assignment_ended` — ids and
codes only.

**Depends on.** `identity/contracts` (authorization, the account directory),
`shared`. Nothing else.

**Must not know.** Passwords, sessions, roles as names, account status,
emails; identity's, messaging's, notifications' or files' tables (an
architecture test); schedules, attendance, lessons, grades. A halaqa
*exists* — and has its people — in academic; a halaqa *meets* in operations.

---

## communities

**State:** implemented — P2, Communities core, and P3, delegation
([communities.md](communities.md),
[ADR 0016](decisions/0016-communities-module.md),
[ADR 0017](decisions/0017-community-scoped-authorization.md)).

**Responsibility.** Persistent spaces — the brief's "groups" — and who belongs
to them: membership stints with history, invitation links, the OPEN/LOCKED
lifecycle, and the one decision every module asks before acting in a
community for a person.

**Owned entities.** `Community`, `Stint` (a membership), `Invitation`,
`CapabilityGrant` (tables `communities`, `community_members`,
`community_invitations`, `communities_capability_grants`).

**Use cases.** Create a community (its creator becomes owner and first
member); view one; list one's own, or — for an overseer — all; lock and
unlock; edit the profile — title, description and picture (`community.profile.edit`,
ADR 0038); restrict or restore a group's member posting — its `chat_mode`
(`community.chat.manage`, ADR 0039); add members; remove a member; leave; list
members; create, list and revoke invitation links; join by link; grant
capabilities to a member, revoke a grant, list grants; transfer ownership; and
serve a short-lived link to the community's picture to anyone who may view it.
One use case per act, one evaluator, one journal — no `CommunitiesService`.

**Groups vs channels (ADR 0039).** A community carries a `chat_mode`:
`GROUP_OPEN` (every member posts), `GROUP_RESTRICTED` (a group an admin made
read-only for ordinary members), or `CHANNEL` (owner + delegated publishers
only). It is the product kind and, for a group, its posting policy — never the
authorization itself. Posting is still the one act `community.chat.post`, asked
on every send: in a GROUP_OPEN community a member posts on the membership basis
(a member ceiling, no grant); otherwise only the owner and
`community.chat.post` grantees do. The lifecycle lock is a separate axis that
closes posting for everyone, whatever the mode. The chat remains a CHANNEL
conversation (ADR 0018); the conversation type never decides community posting.

**Public contract.** `COMMUNITY_AUTHORIZATION` (`authorize`, `authorizeEach`, and since P6
`permittedAmong`, the same evaluator for a list of people with no principal
and never on oversight:
ceiling AND membership, ownership, a grant or oversight AND the lifecycle
gate, as a `CommunityPermit` naming its basis and grant),
`COMMUNITY_MEMBERSHIP` (`heads`, `listHeads`, `statesOf`, `changesSince`,
`members` — facts for trusted consumers, never access),
`COMMUNITY_CAPABILITY_HOLDERS` (`list`: the owner and the effective grantees
of one capability, keyset-paged — never an overseer), `COMMUNITY_DIRECTORY`
(titles, for display); the act vocabulary (`community.*`) with the identity
ceilings that principal-less consumers narrow by (`COMMUNITY_CHAT_READ_CEILING`
for messaging, P4; `COMMUNITY_VIEW_CEILING` for realtime, P5), the wire
vocabulary (since P5.1 also `COMMUNITY_OPERATIONS`, the operations that are
not acts, which the HTTP `me` block reports as `me.operations` for clients;
no module consumes it) and the event types.

**Events.** `communities.community.created|locked|unlocked`,
`communities.community.chat_mode_changed` (ADR 0039; relayed as the existing
`community.access.changed` hint), `communities.member.added|removed`,
`communities.invitation.created|revoked`,
`communities.capability.granted|revoked`, `communities.ownership.transferred`
— ids, codes and versions only; never a title, a name, a token or its hash.

**Depends on.** `identity/contracts` (authorization, the account directory,
the permission catalogue); `academic/contracts/relationships` (Q50, ADR 0033 —
only to confirm a referenced halaqa exists); `files/contracts` (ADR 0038 — only
to verify a community picture is an image the editor owns and to mint a
short-lived link to it); `shared`. Nothing else — an architecture test
(`communities-boundaries.spec.ts`) and the module's own wiring test pin exactly
these edges.

**Must not know.** Conversations and chat data, live sessions and LiveKit,
attendance, realtime, notifications, and every other module's tables — it reads
no foreign table. What it knows of academic is one fact through a contract (does
this halaqa exist?) and of files two (is this picture a valid owned image, and a
link to it); it learns nothing else of either, and nothing at all of the rest.
Messaging, Realtime, Live and Attendance ask Communities; Communities never asks
them.

---

## operations

**State:** scheduling of individual dated lessons implemented
([ADR 0042](decisions/0042-operations-scheduled-lessons.md)); attendance records still contract only
(Q70).

**Responsibility.** The institution in motion: scheduling, sessions,
attendance. Who is enrolled in a halaqa is academic's
([ADR 0014](decisions/0014-academic-core-v1.md)); operations asks
`ACADEMIC_RELATIONSHIPS` rather than keep its own copy.

**Scheduling (built).** `/operations/lessons` (create / list / get / reschedule / cancel), every route
behind `operations.schedule_manage` (OWNER/ADMIN). Owns the `operations_lessons` table (migration 0026):
the lesson's local date/time, the IANA zone captured at creation, the resolved `scheduled_at`, and a
`SCHEDULED → CANCELLED` lifecycle (never deleted). Validates halaqa existence through
`ACADEMIC_RELATIONSHIPS.halaqaExists` only — no foreign key into academic. Its default zone comes from the
neutral `AppConfig.institution.timezone` (injected as `INSTITUTION_TIMEZONE`), never from the
notifications quiet-hours resource. It exports no token yet, emits no event, creates no attendance,
notification or live session.

**Owned entities.** `ScheduledLesson` (built), `ScheduledSession`, `AttendanceRecord` (not built).

**Public contract.** `AttendanceState`, `SessionRef`, `AttendanceAmendment` —
the last of which requires a reason and an amender for every after-the-fact
change, because attendance is exactly the kind of record that gets quietly
edited.

**Events.** `operations.attendance.recorded`, `operations.attendance.amended`.

**Depends on.** `academic/contracts`, `people/contracts`.

**Must not know.** How a session is delivered. A session held in a live audio
room is the same session to operations. Presence in a live session is not
operations' record: it is an attendance-module snapshot
([ADR 0020](decisions/0020-attendance-snapshots.md), approved; implementation
held), and whether a snapshot ever feeds `AttendanceRecord` is
[Q70](open-questions.md#q70--is-a-snapshot-the-attendance-record). *(Until
2026-09-23 this said operations subscribes to `live.session.ended` and records
attendance from it; nothing ever did.)*

> **Proposed change:** see
> [attendance.md §3](attendance.md#3-the-smallest-change-to-existing-documents)
> (approved design, [ADR 0020](decisions/0020-attendance-snapshots.md) Accepted).
> Presence in a live session would be recorded as attendance-module
> snapshots, not derived by operations from `live.session.ended`. Operations
> would depend on `attendance/contracts` only if
> [Q70](open-questions.md#q70--is-a-snapshot-the-attendance-record) says
> snapshots feed `AttendanceRecord`.

---

## assignments

**State:** contract only.

**Responsibility.** Tasks set to learners and what they hand back.

**Owned entities.** `Assignment`, `Submission`, `Grade`.

**Public contract.** `SubmissionState`, `AssignmentRef`, `SubmissionRef`.

**Depends on.** `academic/contracts`, `people/contracts`, `files/contracts`.

**Must not know.** How a file is stored. A submission holds a `fileAssetId`, not
a path, not a URL, not bytes.

---

## messaging

**State:** implemented — Messaging V1, plus community chats (P4) and mass
publishing to communities (ADR 0041). Domain, use cases, Postgres and in-memory
adapters, HTTP, events, tests on real Postgres. See [messaging.md](messaging.md),
[ADR 0011](decisions/0011-messaging-v1.md), and for community chats
[community-chat.md](community-chat.md),
[ADR 0018](decisions/0018-community-chat-projection.md) and
[ADR 0041](decisions/0041-mass-publish-to-communities.md).

**Mass publishing.** `POST /messaging/communities/publish` (edge `messaging.send`)
posts one message — text, or one image/voice/document — to several communities at
once, authorizing each on its own `community.chat.post` via Communities'
`authorizeEach` and posting through the same `MessageSender` path; a per-community
outcome, idempotent by a deterministic per-community key. It adds no module edge
(reuses `communities/contracts` and `files/contracts`) and no new policy.

**Responsibility.** Direct conversations, groups and channels: membership,
server-decided ordering, idempotent sends, read state, and who may read an
attachment. For a community's chat, everything but membership: messages,
order, idempotency, attachments, read state, pagination and delivery — who
belongs, reads and posts is Communities' answer.

**Owned entities.** `Conversation` (with `communityId` for a community's
chat), `Participant` (membership, role, read watermark, visibility window;
for a community chat, a row of the named projection with its `source_*`
provenance), `Message`, `MessageAttachment` (a file reference).

**Use cases.** Start a DM; create a group or channel; send text, voice, image
or file (four typed use cases); list conversations; open one; page messages;
list members; mark read; add and remove people; leave; get an attachment
link; open a community's chat (`GetCommunityChatUseCase`). Background, for
community chats: `CommunityChatSync`, `CommunityChatSweeper`,
`CommunityChatReconciler` — the projection's only writers.

**Public contract** (`messaging/contracts/`): the vocabulary
(`ConversationType`, `MessageType`, `ParticipantRole`), the event names and
payload types, `MessageView` (what a member sees of a message),
`MESSAGE_RECIPIENTS` (current members, paged, optionally only those who can
see a sequence, only those who may read the conversation now — active
accounts whose roles grant `messaging.read` — or only named people; for
delivery modules), `MESSAGE_DELIVERY` (a stored message
rendered for delivery; a principal's position in a conversation they may
read — for realtime), and `MessageSearch` (an extension point nothing
implements yet). It exports two providers: `MESSAGE_RECIPIENTS` and
`MESSAGE_DELIVERY`.

**Events.** `messaging.conversation.created`, `messaging.participant.added`,
`messaging.participant.removed`, `messaging.message.sent`,
`messaging.message.read` — ids and codes only. A community chat raises only
`message.sent` and `message.read`. **Subscribes to** `communities.member.added`
and `communities.member.removed` as wake-ups for its projection, reading
nothing from them but the community id.

**Depends on.** `identity/contracts` (authorization, account directory),
`files/contracts` (attachable uploads, download links),
`communities/contracts` (`COMMUNITY_AUTHORIZATION`, `COMMUNITY_MEMBERSHIP`,
`COMMUNITY_DIRECTORY`, `COMMUNITY_CHAT_READ_CEILING`, the event names — from
the application layer only), `shared`, `platform`. `MessagingModule` imports
`CommunitiesModule`; the edge points one way: Communities never reaches
messaging, so no cycle can close.

**Must not know.** How notifications are delivered, how anything is pushed in
real time, how bytes are stored, LiveKit, or Communities' tables, rules and
internals. Architecture tests assert each: nothing in messaging reaches
`notifications`, `realtime`, `live`, a WebSocket library, a push or
object-store SDK, the filesystem, files' internals, or anything of
Communities but its contracts (and its module file, for wiring); Communities
reaches nothing of messaging; `MessagingModule` still exports exactly
`MESSAGE_RECIPIENTS` and `MESSAGE_DELIVERY` — no way to write a
conversation's members (`messaging-boundaries.spec.ts`).

---

## live

**State:** implemented — P1 hardening and P6 community-scoped sessions:
domain, use cases, Postgres and in-memory stores, RTC adapters, HTTP, the
reconciler, contracts and tests. See [live.md](live.md) (the P1 and P6 notes
above its §1) and [ADR 0019](decisions/0019-community-scoped-live-sessions.md).

**Responsibility.** A community's live sessions: starting and ending them,
joining with a short-lived media ticket, the raise-hand queue, the speaker
floor and the presenter slot; keeping the media provider in line with that
record.

**Owned entities.** `LiveSession`, `SpeakerRequest` (a speaker's grant is a
request in state `granted`), `PresenterGrant`, `ModerationAction` (tables
`live_sessions`, `live_speaker_requests`, `live_presenter_grants`,
`live_moderation_actions`, migration 0013). No participant, presence or token
is stored.

**Use cases.** Start, end, get, current, join, raise, lower, list hands,
grant / decline / revoke, claim and stop the presenter slot — one use case
per act, each asking `LiveAccess`, which asks `COMMUNITY_AUTHORIZATION`
about the community the session's own record names. `LiveReconciler` (room
sweep, participant sweep, targeted watch, media reset) and
`ProtectLiveSessions` (Communities' events as accelerators) keep the provider
in line; `LiveMedia` pushes a person's full set after a change. No
`LiveService`.

**Public contract.** `LIVE_AUDIENCE` (`participantsAmong`, `moderators`: who
a session's facts may reach, as Communities answers it) and `LIVE_SESSIONS`
(`describe`: a session's scope from Live's own record) — the module's only
exports; the event names and payload types (`LiveEvents`);
`LiveParticipantRole`; `MODERATOR_FRAME_COALESCE_MS`, the interval realtime
coalesces moderators' frames to. `LIVE_PRESENCE` is P9's (held).

**Events.** `live.session.started`, `live.session.ended`,
`live.speaker.requested`, `.granted`, `.declined`, `.revoked`, `.withdrawn`,
`.expired`, `live.screen_share.started`, `.stopped` — ids, codes and versions
only. Subscribes to `communities.member.removed`,
`communities.capability.revoked`, `communities.ownership.transferred`,
`communities.community.locked` and `.unlocked` (`ProtectLiveSessions`).

**Depends on.** `identity/contracts` (authorization, the account directory,
the permission catalogue), `communities/contracts` (`COMMUNITY_AUTHORIZATION`
including `permittedAmong`, `COMMUNITY_MEMBERSHIP.heads`,
`COMMUNITY_CAPABILITY_HOLDERS`, the events), `shared`, `platform`.
`LiveModule` imports `IdentityModule` and `CommunitiesModule` only.

**Must not know.** LiveKit above its one adapter: the domain declares the
narrow RTC ports, and exactly one file imports `livekit-server-sdk`.
Membership storage and community rules (it asks); messaging, realtime,
notifications, academic, operations and attendance. `live-boundaries.spec.ts`
asserts each: Communities only through its contracts and module file; none of
the others, derived from the source tree; exactly the two exports; Live's
tables touched only by its own adapters.

> **Correction (2026-09-23):** three statements in this section do not match
> the code that exists today.
>
> - **Entities.** No `SpeakerPermission` type or entity exists under
>   `backend/src`. A speaker's grant is a `SpeakerRequest` in state `granted`
>   (`live/domain/speaker-request.ts:12-24`). `Participant` exists only as
>   the type `LiveParticipant` (`live/domain/participant.ts:5-11`), and
>   nothing uses it.
> - **Events.** The list omits `live.speaker.requested`, which
>   `RequestSpeakerUseCase` publishes
>   (`live/application/request-speaker.use-case.ts:90`).
>   `live.session.started` and `live.session.ended` are declared
>   (`live/domain/events.ts:34-50`) but never raised, because no use case
>   starts or ends a session.
> - **Attendance.** Nothing derives attendance from these events: no module
>   subscribes to any `live.*` event, and operations is contract only.
>
> *(Since then P0 added `live.speaker.requested` to the events list above, and
> P1 deleted `live/domain/participant.ts`; the entity list is unchanged.)*
> *(P6 rewrote this section, on 2026-09-27, to describe the module it built;
> the correction above describes the section as it stood before.)*
>
> **Proposed change:** see [live.md](live.md) (the P6 design,
> [ADR 0019](decisions/0019-community-scoped-live-sessions.md) Accepted; its
> P1 hardening has landed, above). A
> community-scoped `LiveSession` would replace the halaqa-bound `LiveRoom`.
> Live would depend on `communities/contracts` and export `LIVE_AUDIENCE`,
> `LIVE_SESSIONS` and `LIVE_PRESENCE`; only attendance may import
> `LIVE_PRESENCE`. Live would never import attendance.
>
> **Landed in P6 (2026-09-27)**, as the section above now describes, except
> `LIVE_PRESENCE`, which stays with P9 (held).

---

## attendance

**State:** implemented — P9 ([attendance.md](attendance.md),
[ADR 0020](decisions/0020-attendance-snapshots.md) Accepted,
[ADR 0023](decisions/0023-attendance-authorization-and-policy.md)). Backend: the
snapshot write and the read surface, `AttendanceAccess`, Postgres and in-memory
repositories, the API with full error-coverage E2E, and
`attendance-boundaries.spec.ts`. Flutter: the record and viewing foundations
([attendance.md §17](attendance.md#17-flutter-attendancerepository-p9-only)).

**Responsibility.** An immutable, append-only record of who the media provider
held during a community's live session: a snapshot taken on command during a
broadcast, and the read surface over the snapshots. It *observes*; it decides no
one "present" by any threshold, duration or percentage
([attendance.md §12](attendance.md#12-no-threshold-duration-or-percentage)).

**Owned entities.** `Snapshot` (immutable, append-only) and its participant
entries, in attendance's own tables, written only by attendance's adapters.

**Use cases.** Record a snapshot of the current live session (idempotent on a
client request id); list a community's snapshots; read one snapshot; list a
snapshot's participants — the reads keyset-paginated, names resolved at view time
through `ACCOUNT_DIRECTORY`. One use case per act, one journal — no
`AttendanceService`.

**Public contract** (`attendance/contracts/`): the event name and payload type
(`attendance.snapshot.recorded`) and the vocabulary. `AttendanceModule` exports
**nothing**: attendance's facts travel as its one event and its read API; no
module calls into it synchronously.

**Events.** Publishes `attendance.snapshot.recorded` (once per created snapshot,
after the audit entry) — ids, one timestamp and two counts only, never a
participant id or name. Subscribes to nothing; notifications' P10 translator
subscribes to this event, through contracts only.

**Depends on.** `live/contracts` (`LIVE_SESSIONS`, and `LIVE_PRESENCE` — which
only attendance may import), `communities/contracts` (`COMMUNITY_AUTHORIZATION`,
through `AttendanceAccess`), `identity/contracts` (`ACCOUNT_DIRECTORY`, the
route-access declarations), `shared`, `platform`. `AttendanceModule` imports
`IdentityModule`, `CommunitiesModule` and `LiveModule` only.

**Must not know.** LiveKit and the RTC provider above live's `LIVE_PRESENCE`
observation; live's and communities' internals and rules (it asks); operations,
academic, realtime, notifications and messaging — a vocabulary firewall that
keeps halaqa ids and the rest out; `COMMUNITY_MEMBERSHIP` and
`COMMUNITY_CAPABILITY_HOLDERS` (it asks only `COMMUNITY_AUTHORIZATION`, and a
snapshot never enumerates members); the reserved permission strings
`attendance.read` / `attendance.manage`; and every other module's tables.
`attendance-boundaries.spec.ts` asserts each, non-vacuously.

---

## files

**State:** implemented — Messaging V1. The upload policy, `FileAsset` with its
Postgres table, the declare → PUT → verify flow, the local adapter and its
transfer routes, signed links, tests. See [storage.md](storage.md).

**Responsibility.** What may be stored, verified storage of it, and
short-lived links to it. **Not** who may read a file — the module that
attached it decides that. It also owns the two profile-picture-adjacent acts
that are its own concern (ADR 0038): the self-service endpoints that set and
clear a user's avatar (`PUT`/`DELETE /files/me/avatar`) — it verifies the asset
is an `IMAGE` the caller owns, then records the reference through identity's
`ACCOUNT_AVATAR_WRITER`, the one read path it authorizes itself being the
owner's link to their own asset (`POST /files/me/assets/:id/link`).

**Owned entities.** `FileAsset` (metadata and a generated storage key — never
bytes).

**Public contract.** `FileKind`, and `FILE_ASSETS` (`describe`,
`verifyAttachable`, `createDownloadLink`). The raw `StorageProvider` port is
**internal**: the Foundation exported it, which let any holder mint a link to
any stored object; that defect is fixed and a test keeps it fixed.

**Depends on.** `identity/contracts`, `shared`, `platform`.

**Must not know.** What a file *means*. A voice message, a homework submission
and a certificate scan are one thing to this module: validated bytes behind a
signed URL. Meaning belongs to the module that referenced the asset.

---

## notifications

**State:** implemented — Notifications V1. A persistent inbox per person, fed
by messaging's facts, delivered live through realtime and to devices through
a push-provider port (a logging adapter until a provider is chosen, Q24). See
[notifications.md](notifications.md) and
[ADR 0013](decisions/0013-notifications-v1.md).

**Responsibility.** What a person is told, and whether it has been read:
deciding — the same way for every source — whether a notification is valid,
for an active account, wanted, and new; storing it; announcing it; and
sending it to the person's devices.

**Owned entities.** `Notification` (recipient, type, category, title and body
keys, params, typed target, dedupe key, created, read), the per-category
channel preferences, and the push `Device` registrations. Tables
`notifications`, `notification_preferences`, `notification_devices` — no
foreign keys into other modules' tables.

**Parts.** `domain/` — the model and its validation, the type catalog
(active and reserved), preference semantics, device-token rules, the push
port and the lock-screen payload. `application/` — one translator per source
module (`MessagingNotificationTranslator` today), the event-agnostic
`NotificationDispatcher`, the inbox, preference and device use cases,
`PushDelivery`. `infrastructure/` — Drizzle and in-memory repositories,
`LoggingPushProvider`, the only place a push SDK may ever be imported
(dependency-cruiser rule). `api/` — `/notifications`, every route
`@Authenticated()`.

**Public contract** (`notifications/contracts/`): the vocabulary (types,
categories, channels, platforms, providers), `NotificationTarget` and params
types, the event names and payload types, and `NOTIFICATION_READER`
(stored notifications rendered for delivery, by id — for realtime). It
exports one provider: `NOTIFICATION_READER`.

**Events.** Publishes `notifications.notification.created` (once per row
actually stored, with the channel decisions), `.read` and `.all_read` — ids,
codes and flags, never parameters; `aggregateId` is the recipient.
Subscribes to `messaging.message.sent`, `messaging.conversation.created`,
`messaging.participant.added`, and its own `notification.created` (push).

**Depends on.** `messaging/contracts` (events, `MESSAGE_RECIPIENTS`),
`identity/contracts` (`ACCOUNT_DIRECTORY` for active accounts, the
route-access declarations), `shared` (event bus ports, audit log, rate
limiter, clock, ids), `platform` (database, configuration, HTTP plumbing).

**Must not know.** Why a source module does what it does — membership,
visibility and account rules are asked of their owners, never copied. Any
module's tables but its own. A socket library, or any push SDK outside its
infrastructure (architecture tests).

**Only realtime knows notifications, and only its contracts.** Messaging,
identity, live, academic, assignments and the rest publish events and contain
no notification logic; architecture tests assert that nothing but realtime
(contracts only) and the composition root imports it. The Foundation's rule —
notifications receives templates, never domain events — holds at the right
layer: the translators know their source's events; the dispatcher and
delivery know requests and recipients, never why.

---

## realtime

**State:** implemented — Realtime Messaging V1, plus community frames (P5)
and live-session frames (P6). See [realtime.md Part M](realtime.md),
[Part C](realtime.md#part-c--communities-in-real-time) and
[Part L](realtime.md#part-l--live-sessions-in-real-time), and
[ADR 0012](decisions/0012-realtime-messaging-transport.md).

**Responsibility.** Delivering messaging's facts, each person's own
notifications, and Communities' facts to the people entitled to them while
they are connected — nothing else. It stores nothing and decides no
messaging, notification or community rule.

**Owned state.** In memory, per instance: authenticated connections
(connection id, account, session, expiry, last seen — no roles, memberships
or content) and connections still authenticating.

**Parts.** `domain/` — the wire protocol v1 (frames, error and close codes),
the `ClientLink` port, provisional limits. `application/` —
`ConnectionManager` (register, unregister, per-account lookup, the accounts
online, send to one or many accounts, drop dead connections),
`RealtimeSessions` (authenticate, re-authenticate, subscribe, ping, sweep),
`MessagingRealtimeRelay` (the event subscriber: recipients, render once, fan
out), `NotificationRealtimeRelay` (notifications' events → the recipient's
own connections), `CommunitiesRealtimeRelay` (Communities' events → the
person concerned, or a community's ACTIVE members online, asked of
Communities at delivery time), `LiveRealtimeRelay` (P6: Live's events → a
community's members online whom Live accepts, the person concerned, and a
session's moderators, coalesced), and `onlineAudience` (an audience ∩ the
accounts online here, in at most 1 + ⌈A/1000⌉ calls; both group relays use
it). `infrastructure/` — `WebSocketTransport`, the only code that knows a
socket library (`ws`).

**Public contract.** None: nothing depends on realtime, and only the
composition root imports it (architecture test). Its API is the wire
protocol at `/realtime`.

**Events.** Subscribes to `messaging.conversation.created`,
`messaging.message.sent`, `messaging.message.read`,
`messaging.participant.added`, `messaging.participant.removed`,
`notifications.notification.created`, `notifications.notification.read`,
`notifications.notification.all_read`, and (P5)
`communities.member.added`, `communities.member.removed`,
`communities.capability.granted`, `communities.capability.revoked`,
`communities.ownership.transferred`, `communities.community.locked`,
`communities.community.unlocked`, and (P6) the ten `live.*` events.
Publishes none.

**Depends on.** `identity/contracts` (`ACCESS_TOKEN_AUTHENTICATOR`,
`AUTHORIZATION_SERVICE`, the `messaging.read` permission, and
`ACCOUNT_DIRECTORY.withPermission` for the community view ceiling),
`messaging/contracts` (events, `MESSAGE_RECIPIENTS`, `MESSAGE_DELIVERY`,
`MessageView`), `notifications/contracts` (events, `NOTIFICATION_READER`),
`communities/contracts` (P5: `COMMUNITY_MEMBERSHIP` — `statesOf`, `heads`,
`members` —, `COMMUNITY_VIEW_CEILING`, `CommunityEvents`), `live/contracts`
(P6: `LIVE_AUDIENCE`, `LiveEvents`, `MAX_AUDIENCE_PROBE`,
`MODERATOR_FRAME_COALESCE_MS`), `shared` (event
subscriber, rate limiter, clock, ids), `platform` (configuration, for the
handshake's origins and proxy trust). `RealtimeModule` imports
`IdentityModule`, `MessagingModule`, `NotificationsModule`,
`CommunitiesModule` and (P6) `LiveModule`.

**Must not know.** Messaging's, notifications', Communities' or Live's
tables and rules, identity's internals, LiveKit. Architecture tests assert
each — realtime reaches messaging, identity, notifications, Communities and
(P6) Live through their contracts only (and each module file, for wiring),
and stores no notification; `realtime-boundaries.spec.ts` also proves it does
use Communities' `membership.ts`, `events.ts` and `capabilities.ts`, and
Live's contracts, so those checks are not vacuous — and that no module but
this one's infrastructure imports a WebSocket library. Communities and Live
never import realtime (`communities-boundaries.spec.ts`,
`realtime-boundaries.spec.ts`).

> **Proposed change:** see
> [communities-live-attendance.md §3](communities-live-attendance.md#3-dependency-graph)
> and [§16](communities-live-attendance.md#16-realtime-transport-matrix)
> (design only,
> [ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md)
> Accepted). Realtime would gain `LiveRealtimeRelay` (P7), and so also
> depend on `live/contracts` (`LIVE_AUDIENCE`, `LiveEvents`). It would still
> export nothing and be imported only by the composition root.
> `CommunitiesRealtimeRelay`, proposed here for P5, landed in P5 (above).
> `LiveRealtimeRelay` landed in P6 (2026-09-27), brought forward from P7
> (above).

---

## automation

**State:** contract only.

**Responsibility.** "When X happens, do Y."

**Public contract.** `AutomationRule`.

**Depends on.** the event bus, and other modules' `contracts/`.

**Must not know.** Any module's internals. Automation subscribes to events and
calls public use cases — nothing else. Keeping it in its own module is what
stops "when a session ends, notify the supervisor" from being buried inside
`live`.

---

## reporting

**State:** implemented — Owner Command Center v1 (ADR 0040) + actions/accounts (ADR 0041). Was contract-only.

**Responsibility.** Read models and the Owner Command Center.

**Public contract.** `WidgetCategory`, `WidgetDescriptor`, `WidgetData`,
`WidgetProvider`, `WIDGET_PROVIDERS`, `CommandActionDescriptor`, `COMMAND_ACTIONS`.

The command centre is a **registry, not a screen**. A module contributes a
widget by registering a `WidgetProvider` (a descriptor + a resolver); adding one
later is one more provider, never a change to the resolver (`GetCommandCenterUseCase`)
or the screen. The providers are bound **inside `ReportingModule`** (there is no
`multi:true` precedent, and a contributing module exporting reporting's token
would break the "a module exports only its own contracts' tokens" boundary
test), so reporting owns the registry and no other module depends on it.

`GET /reporting/command-center` is gated `reports.read` at the edge; the use case
re-checks it and, per `WidgetDescriptor.requiredPermission` (and, for quick
actions, `CommandActionDescriptor.requiredPermission`), hides any widget OR action
the viewer may not see — the same centralized check every route uses. An empty set
is a valid answer, never an error. The actions are a second registry alongside the
widgets: static descriptors filtered by permission (a client maps an action id to a
screen; the operation re-authorizes on use), so no cross-module dependency is added
for them.

**Depends on.** other modules' `contracts/`, read-only (today: `identity`
`AUTHORIZATION_SERVICE` + `ACCOUNT_DIRECTORY_SUMMARY`; `communities`
`COMMUNITY_MEMBERSHIP`; `academic` `ACADEMIC_STRUCTURE_SUMMARY`). Acyclic;
dependency-cruiser-clean.

**Must not know.** How any module stores its data. v1 resolves each widget from
a **bounded count/summary** read of another module's public contract at request
time — never that module's tables, and never a figure it invented (a count of
existing authorized data only; present/absent and KPIs stay owner-gated, Q70). A
heavier future widget may build its own event-sourced projection rather than a
request-time read, but it still reads only `contracts/` and events — the rule
that keeps reporting from making every other module unextractable.

---

## platform (not a business module)

Technical substrate: configuration, structured logging, HTTP plumbing (exception
filter, decorators), the in-process event bus, the audit log adapter, health
checks.

**Must not know** any business module. Enforced by `platform-knows-no-modules`.
This is why `Principal` and the DI tokens live in `shared/` — platform needs to
name them, and may not depend on identity to do it.

## shared (the kernel)

`Id`, `Result`, `Failure`, `Clock`, `DomainEvent`, `EventPublisher`,
`Principal`, `AuditLog`, pagination, DI tokens.

Imported by every layer including domain, so it carries the domain's purity
requirement: no npm packages, no Node core, no frameworks.

It is kept small on purpose. A growing shared kernel becomes a second,
unversioned dependency for every module — precisely what module boundaries exist
to prevent. The test for adding something: *would every module reasonably need
this, and is it free of any policy decision?* If not, it belongs to a module.
