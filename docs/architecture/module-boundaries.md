# Module Boundaries

One section per module. Each states: **responsibility**, **owned entities**,
**use cases**, **public contract**, **events**, **dependencies**, and — the part
that actually does the work — **what it must not know**.

A module is a unit of ownership, not a folder. If two modules need the same
table, one of them is wrong.

**Implementation state** is marked on every module. Of the twelve business
modules, seven are implemented (identity, live, files, messaging, realtime,
notifications, academic); the other five are deliberately empty: contracts
and a Nest module, no implementation. Deciding the boundary before the code
arrives is cheap; retrofitting one is not.

> **Proposed change:** see [communities.md](communities.md) (design only,
> [ADR 0016](decisions/0016-communities-module.md) Proposed): a new
> `communities` module owning communities, their membership, invitation
> links and lifecycle. It is what the brief calls "groups". The code name is
> Community because "group" already means messaging's `GROUP` conversation
> type, and is used for Tahajji's «مجموعة» in
> [Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups).
>
> **Proposed change:** see [attendance.md](attendance.md) (design only,
> [ADR 0020](decisions/0020-attendance-snapshots.md) Proposed): a new
> `attendance` module owning attendance snapshots taken during a live
> session. Its implementation is **held**.
>
> Neither module exists. Implementing either waits on
> [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules).
> The sections below describe the modules that exist today.

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
read accounts); owner bootstrap; per-request principal resolution.

**Public contract** (`identity/contracts/`): `AuthorizationService`
(`can`, `authorize`), the permission catalogue, the route declarations
(`RequirePermission`, `Authenticated`, `PublicRoute`), `Principal`,
`systemPrincipal`, and `AccountDirectory` — who an account is (id, display
name, active) and whether it may take part in something, for modules that
reference accounts they did not create; and `AccessTokenAuthenticator` —
the HTTP guard's own authentication (`ResolvePrincipalUseCase`), for a
connection that is not a request, plus `revalidate` to re-check a live
session without holding its token. The module exports exactly three
providers: `AUTHORIZATION_SERVICE`, `ACCOUNT_DIRECTORY` and
`ACCESS_TOKEN_AUTHENTICATOR`.

**Events.** `identity.user.created`, `identity.role.assigned`,
`identity.role.revoked`, `identity.account.status_changed`. Payloads carry ids
and codes only, never an email or a name.

**Depends on.** `shared`, `platform` (config, database, audit, rate limiter,
HTTP plumbing).

**Must not know.** Programs, halaqat, attendance, messages, rooms. A permission
string is opaque to identity: it does not know that `live.moderate` concerns
audio, which is why any module can define permissions without identity changing.
And no other module may read identity's tables. A test asserts that nothing
outside identity imports its schema.

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

**Depends on.** `identity/contracts` (to link a person to a user).

**Must not know.** Passwords, tokens, permission evaluation.

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

## operations

**State:** contract only.

**Responsibility.** The institution in motion: scheduling, sessions,
attendance. Who is enrolled in a halaqa is academic's
([ADR 0014](decisions/0014-academic-core-v1.md)); operations will ask
`ACADEMIC_RELATIONSHIPS` rather than keep its own copy.

**Owned entities.** `ScheduledSession`, `AttendanceRecord`.

**Public contract.** `AttendanceState`, `SessionRef`, `AttendanceAmendment` —
the last of which requires a reason and an amender for every after-the-fact
change, because attendance is exactly the kind of record that gets quietly
edited.

**Events.** `operations.attendance.recorded`, `operations.attendance.amended`.

**Depends on.** `academic/contracts`, `people/contracts`.

**Must not know.** How a session is delivered. A session held in a live audio
room is the same session to operations; it subscribes to `live.session.ended`
and records attendance from it, and would work identically for a room with
chairs.

> **Proposed change:** see
> [attendance.md §3](attendance.md#3-the-smallest-change-to-existing-documents)
> (design only, [ADR 0020](decisions/0020-attendance-snapshots.md) Proposed).
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

**State:** implemented — Messaging V1. Domain, use cases, Postgres and
in-memory adapters, HTTP, events, tests on real Postgres. See
[messaging.md](messaging.md) and [ADR 0011](decisions/0011-messaging-v1.md).

**Responsibility.** Direct conversations, groups and channels: membership,
server-decided ordering, idempotent sends, read state, and who may read an
attachment.

**Owned entities.** `Conversation`, `Participant` (membership, role, read
watermark, visibility window), `Message`, `MessageAttachment` (a file
reference).

**Use cases.** Start a DM; create a group or channel; send text, voice, image
or file (four typed use cases); list conversations; open one; page messages;
list members; mark read; add and remove people; leave; get an attachment link.

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
`messaging.message.read` — ids and codes only.

**Depends on.** `identity/contracts` (authorization, account directory),
`files/contracts` (attachable uploads, download links), `shared`, `platform`.

**Must not know.** How notifications are delivered, how anything is pushed in
real time, how bytes are stored, or LiveKit. Architecture tests assert each:
nothing in messaging reaches `notifications`, `realtime`, `live`, a WebSocket
library, a push or object-store SDK, the filesystem, or files' internals.

> **Proposed change:** see [community-chat.md](community-chat.md) (design
> only, [ADR 0018](decisions/0018-community-chat-projection.md) Proposed). A
> community's chat would be a `CHANNEL` conversation linked by
> `community_id`, and its participant rows a named, versioned projection of
> Communities membership. Messaging's application layer would depend on
> `communities/contracts` and ask Communities who may read and post. It would
> refuse its own add, remove and leave for that conversation, and still
> export the same two providers.

---

## live

**State:** implemented — domain, use cases, RTC adapters, HTTP, tests.
In-memory persistence. See [realtime.md](realtime.md).

**Responsibility.** Realtime audio rooms, the raise-hand queue, and host
moderation of who may speak.

**Owned entities.** `LiveRoom`, `LiveSession`, `Participant`, `SpeakerRequest`,
`SpeakerPermission`, `ModerationAction`.

**Use cases.**
- `JoinLiveSessionUseCase` — authorize, then mint a short-lived,
  capability-scoped join token. Listeners get a token that **cannot publish
  audio**; hosts and existing grant-holders get one that can.
- `RequestSpeakerUseCase` — enqueue a raise-hand. Deliberately does **not**
  touch the RTC provider; a raised hand is application state, not media state.
- `ModerateSpeakerUseCase` — grant or revoke speaking permission. Updates own
  state, then the provider, then audit, then raises an event.

**Public contract.** `ParticipantRole`.

**Events.** `live.speaker.granted`, `live.speaker.revoked`,
`live.session.started`, `live.session.ended`.

**Depends on.** `identity/contracts` (authorization), `shared`, `platform`.

**Must not know.** LiveKit. The domain declares `RtcProvider`; exactly one file
in the repository imports `livekit-server-sdk`. It also must not know about
attendance — operations derives that from the events.

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
> **Proposed change:** see [live.md](live.md) (design only,
> [ADR 0019](decisions/0019-community-scoped-live-sessions.md) Proposed). A
> community-scoped `LiveSession` would replace the halaqa-bound `LiveRoom`.
> Live would depend on `communities/contracts` and export `LIVE_AUDIENCE`,
> `LIVE_SESSIONS` and `LIVE_PRESENCE`; only attendance may import
> `LIVE_PRESENCE`. Live would never import attendance.

---

## files

**State:** implemented — Messaging V1. The upload policy, `FileAsset` with its
Postgres table, the declare → PUT → verify flow, the local adapter and its
transfer routes, signed links, tests. See [storage.md](storage.md).

**Responsibility.** What may be stored, verified storage of it, and
short-lived links to it. **Not** who may read a file — the module that
attached it decides that.

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

**State:** implemented — Realtime Messaging V1. See
[realtime.md Part M](realtime.md) and
[ADR 0012](decisions/0012-realtime-messaging-transport.md).

**Responsibility.** Delivering messaging's facts, and each person's own
notifications, to the people entitled to them while they are connected —
nothing else. It stores nothing and decides no messaging or notification
rule.

**Owned state.** In memory, per instance: authenticated connections
(connection id, account, session, expiry, last seen — no roles, memberships
or content) and connections still authenticating.

**Parts.** `domain/` — the wire protocol v1 (frames, error and close codes),
the `ClientLink` port, provisional limits. `application/` —
`ConnectionManager` (register, unregister, per-account lookup, send to one
or many accounts, drop dead connections), `RealtimeSessions` (authenticate,
re-authenticate, subscribe, ping, sweep), `MessagingRealtimeRelay` (the
event subscriber: recipients, render once, fan out),
`NotificationRealtimeRelay` (notifications' events → the recipient's own
connections). `infrastructure/` —
`WebSocketTransport`, the only code that knows a socket library (`ws`).

**Public contract.** None: nothing depends on realtime, and only the
composition root imports it (architecture test). Its API is the wire
protocol at `/realtime`.

**Events.** Subscribes to `messaging.conversation.created`,
`messaging.message.sent`, `messaging.message.read`,
`messaging.participant.added`, `messaging.participant.removed`,
`notifications.notification.created`, `notifications.notification.read`,
`notifications.notification.all_read`. Publishes none.

**Depends on.** `identity/contracts` (`ACCESS_TOKEN_AUTHENTICATOR`,
`AUTHORIZATION_SERVICE`, the `messaging.read` permission),
`messaging/contracts` (events, `MESSAGE_RECIPIENTS`, `MESSAGE_DELIVERY`,
`MessageView`), `notifications/contracts` (events, `NOTIFICATION_READER`),
`shared` (event subscriber, rate limiter, clock, ids), `platform`
(configuration, for the handshake's origins and proxy trust).

**Must not know.** Messaging's or notifications' tables and rules, identity's
internals. Architecture tests assert each — realtime reaches messaging,
identity and notifications through their contracts only, and stores no
notification — and that no module but this one's infrastructure imports a
WebSocket library.

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

**State:** contract only.

**Responsibility.** Read models, KPIs, and the Owner Command Center.

**Public contract.** `WidgetCategory`, `WidgetDescriptor`, `WidgetData`,
`WidgetProvider`, `WIDGET_PROVIDERS`.

The command centre is a **registry, not a screen**. A module contributes by
registering a descriptor plus a resolver. Adding "pending decisions" later means
registering one more widget — never editing a dashboard component. That is the
stated requirement (the dashboard must grow without being rewritten) expressed
as a type.

`WidgetDescriptor.requiredPermission` means the dashboard hides what the viewer
may not see, and the check is the same centralized one every other route uses.

**Depends on.** every module's `contracts/`, read-only.

**Must not know.** How any module stores its data. Reporting builds its own
projections from events; it does not query eight modules' tables at request
time. That is the rule that keeps reporting from becoming the thing that makes
every other module unextractable.

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
