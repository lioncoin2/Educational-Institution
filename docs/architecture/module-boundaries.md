# Module Boundaries

One section per module. Each states: **responsibility**, **owned entities**,
**use cases**, **public contract**, **events**, **dependencies**, and — the part
that actually does the work — **what it must not know**.

A module is a unit of ownership, not a folder. If two modules need the same
table, one of them is wrong.

**Implementation state** is marked on every module. Eight of the twelve are
deliberately empty: contracts and a Nest module, no implementation. Deciding the
boundary before the code arrives is cheap; retrofitting one is not.

---

## identity

**State:** implemented — domain, use cases, adapters, HTTP, guards, tests.

**Responsibility.** Who may sign in, and what they are allowed to do. It is the
only module that answers an authorization question.

**Owned entities.** `User`, `Role`, `Permission`, `PolicyRule`, `Principal`
(resolved, not stored).

**Use cases.**
- `AuthenticateUseCase` — verify credentials. Returns one indistinguishable
  failure for unknown-user and wrong-password, and equalizes timing against a
  dummy hash so response time does not reveal whether an account exists.
- `LoginUseCase` — authenticate, then mint an access token.
- `PolicyAuthorizationService` — evaluate a permission against roles and
  policies.

**Public contract** (`identity/contracts/`).
- `Permissions` — the permission catalog, as a nested const object. `Permission`
  is a union type derived from it, so a typo is a compile error rather than a
  silent `false`.
- `AuthorizationService` — `can()`, `authorize()`, `principalFor()`.
- `RequirePermission(...)` — the route decorator.
- `PublicRoute()` — re-exported from platform.

**Events.** `identity.user.registered`, `identity.role.granted`,
`identity.role.revoked`. (Declared; not yet raised, as registration is not
implemented.)

**Depends on.** `shared`, `platform` (config, audit).

**Must not know.** Anything about programs, halaqat, attendance, messages or
live rooms. A permission string is an opaque token to identity — it does not
know that `live.moderate` concerns audio. That ignorance is what lets any module
define permissions without identity changing.

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

**State:** contract only.

**Responsibility.** The catalogue of what is taught: departments, programs,
levels, halaqat as structural entities.

**Owned entities.** `Program`, `Level`, `Curriculum`, `Halaqa`.

**Public contract.** `ProgramRef`, `LevelRef`, `HalaqaRef`.

**Depends on.** `shared`.

**Must not know.** Schedules, attendance, who turned up. A halaqa *exists* in
academic; a halaqa *meets* in operations.

---

## operations

**State:** contract only.

**Responsibility.** The institution in motion: scheduling, enrolment, sessions,
attendance.

**Owned entities.** `Enrolment`, `ScheduledSession`, `AttendanceRecord`.

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

**State:** contract only. See [messaging.md](messaging.md) for the full design.

**Responsibility.** Direct conversations, groups and channels.

**Owned entities.** `Conversation`, `Participant`, `Message`, `ReadReceipt`.

**Public contract.** `ConversationType`, `MessageKind`, `ConversationRef`,
`MessageRef`, `MessageAttachmentRef`, `ReadReceipt`.

The contract is shaped so that reactions, edits, deletions, threads, pins and
moderation are **additive**: a message already carries an id, a nullable
`inReplyToMessageId`, and a list of attachment references rather than inline
payloads. None of those features are implemented; none of them will require the
existing shape to change.

**Events.** `messaging.message.sent`, `messaging.conversation.created`.

**Depends on.** `identity/contracts`, `files/contracts`.

**Must not know.** How notifications are delivered. It raises
`messaging.message.sent` and stops caring.

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

---

## files

**State:** partially implemented — upload policy, storage port and local adapter
with signing, plus tests. The receiving endpoint is deferred. See
[storage.md](storage.md).

**Responsibility.** What may be uploaded, where its bytes live, and who may
fetch them.

**Owned entities.** `FileAsset` (metadata and a storage key — never bytes).

**Public contract.** `FileKind`, `FileAssetRef`, `STORAGE_PROVIDER`.

**Depends on.** `shared`, `platform/config`.

**Must not know.** What a file *means*. A voice message, a homework submission
and a certificate scan are one thing to this module: validated bytes behind a
signed URL. Meaning belongs to the module that referenced the asset.

---

## notifications

**State:** contract only.

**Responsibility.** Reaching a person, whatever the channel.

**Owned entities.** `NotificationPreference`, `DeliveryAttempt`.

**Public contract.** `NotificationChannel`, `NotificationRequest`,
`NotificationSender`, `NOTIFICATION_SENDER`. `collapseKey` is in the contract
from the start because a burst of twenty messages must be able to become one
notification without every calling module learning about batching.

**Depends on.** `identity/contracts`, `people/contracts`.

**Must not know.** Why something happened. It receives a template key and
parameters, not a domain event.

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
