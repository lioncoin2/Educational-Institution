# Open Questions

> If something is ambiguous: DO NOT invent institutional rules.

Every question below is one where a sensible-looking guess would have hardened
into a rule nobody agreed to. Inventing them is worse than leaving them open,
because a written-down guess stops looking like a guess within about a week.

Each entry states: **the question**, **why it was not guessed**, **what was
built instead**, and **what changes when it is answered**. The last line is the
important one — in every case the answer is configuration or a small addition,
not a rewrite. That is the point of leaving the seam.

---

## Q1 — What may each role actually do?

**Question.** Six roles are active: OWNER, ADMIN, SUPERVISOR, TEACHER,
ASSISTANT_TEACHER, STUDENT. The exact permission set of each is an institutional
decision. Concretely, and none of these is rhetorical:

- Should the **owner** hold every permission, including `messaging.manage`, the
  power to read other people's private conversations?
- May an **admin** hold `messaging.manage` at all? (Withheld provisionally.)
- May a **supervisor** amend attendance, or only view it? Moderate a teacher's
  live room?
- May an **assistant teacher** speak in, or moderate, a live room?
- May anyone other than a room's **host** moderate it: supervisor, admin, owner?
  (Provisionally no one, including the owner.)
- Should **teachers** be limited to their own halaqat for attendance and
  assignments? (The mechanism, resource-scoped policy rules, exists; no rule is
  defined.)

**Why not guessed.** Each of these encodes a position on delegation, privacy
and accountability. "Supervisors can edit attendance" is obviously right or
obviously wrong depending on the institution, and getting it wrong silently is
a governance failure, not a bug.

**Built instead.** The whole mechanism, tested: permission catalogue, role
catalogue in the database, deny-overrides evaluation, resource-scoped rules,
guards, and use-case checks. A provisional matrix and one provisional rule
(host-only moderation) sit together in
`identity/domain/provisional-policy.ts`, named so no reader mistakes them for
decisions. [authorization.md §4](authorization.md) explains the two technical
constraints that shaped the matrix.

**When answered.** A reviewed migration rewriting `role_permissions`, plus
policy rules for any scoping. No use case, guard or controller changes. A test
keeps the code constant and the table in step.

---

## Q2 — Who is the first owner, and how are accounts created after that?

**Question.** The system ships with no users and no default credential. How
should the first owner be provisioned in production, and by whom? After that,
is staff-only creation of accounts right for every group, or will some people,
guardians for instance, ever register themselves?

**Why not guessed.** Seeding `owner@institution / changeme` is a security hole
that reliably survives into production, and an invented rule about who the
owner is. Public registration is a policy the institution has not asked for.

**Built instead.** A mechanism, not a decision. `bootstrap-owner`, a
command-line tool run on the server, creates the first OWNER from credentials
typed at that moment (password on stdin). It refuses while any active owner
exists. After that, accounts are created only through `/admin/users` by holders
of `users.manage`. There is no registration endpoint.

**When answered.** Who runs the bootstrap is an operational decision; the tool
exists. Self-registration, if ever wanted, is a new use case with its own
permissions and abuse controls. Nothing existing changes.

---

## Q3 — What is the retention policy for files, messages, audit entries and session history?

**Question.** How long are audit entries kept, including the client IP
addresses recorded on sign-in events? How long is the history of revoked and
expired sessions kept? How long are voice messages kept? Homework submissions after a
programme ends? Messages in a channel nobody uses any more? Does a deleted
message's attachment get deleted, and immediately or on a schedule?

**Why not guessed.** Retention is where legal obligation, storage cost and
safeguarding meet. It is also close to irreversible: bytes deleted on a guessed
schedule do not come back.

**Built instead.** `StorageProvider.delete()` exists; nothing calls it on a
schedule. `FileAsset` carries `createdAt`, so any retention rule is expressible
later.

**When answered.** A scheduled job in `automation` calling
`StorageProvider.delete()`. No change to how files are written or read.

---

## Q4 — How many concurrent speakers, and in what order?

**Question.** `MAX_CONCURRENT_SPEAKERS = 4` is an engineering safeguard, not an
institutional rule. And the raise-hand queue is first-come-first-served — but
should it be? By seniority, by level, by who has spoken least this term, by
teacher-pinned priority?

**Why not guessed.** Queue fairness is pedagogy. A teacher who wants to hear
from quiet students first has a legitimate policy that FCFS actively defeats.

**Built instead.** FCFS in `pendingQueue()` — a single sort, in one function,
with a comment saying exactly this. The cap is one exported constant.

**When answered.** Change a comparator, or make it strategy-shaped. Everything
else about the queue is unaffected.

---

## Q5 — What happens when the media provider and our record disagree?

**Question.** `ModerateSpeakerUseCase` updates our own state, then calls the RTC
provider. If the provider call fails, our record says "granted" and the SFU says
"listener". Who wins, and how is it repaired? Retry with backoff? A
reconciliation sweep? Surface it to the teacher immediately?

**Why not guessed.** This is a distributed-systems consistency choice with a
visible classroom consequence, and the tolerable failure mode ("the student
appears able to speak but cannot" vs "the teacher is told the grant failed") is
a product decision.

**Built instead.** A deliberate ordering — own state first, provider second —
chosen so that a failure leaves us *more* restrictive on record rather than
holding a silent grant. The divergence is not yet detected or repaired.

**When answered.** A reconciliation step in the live module. The ordering and
the ports do not change.

---

## Q6 — Who may message whom?

**Question.** May a student DM a teacher directly? May students DM each other?
May a parent message a teacher? Are there hours during which messaging is
closed? Does a supervisor see a teacher–student conversation?

**Why not guessed.** This is a safeguarding decision before it is a technical
one, and defaults in this area are exactly the kind that nobody revisits.

**Built instead (Messaging V1).** Starting a conversation is its own
permission, separate from taking part: `messaging.start_direct`,
`messaging.create_group`, `messaging.create_channel`. PROVISIONAL grants:
teachers and supervisors may start DMs and groups; owners and admins may also
create channels; **students and assistants start nothing** — they read and
reply in conversations staff place them in. Anyone ACTIVE with
`messaging.read` may be addressed. Nobody reads a conversation they are not in
— not a supervisor, not the owner (see Q23).

Still open: may students message each other or a teacher of their choosing?
Should a teacher reach only *their own* students (an academic relationship the
academic module does not model yet)? Quiet hours? Parents?

**When answered.** Grants in the provisional matrix (a migration), and — for
"only their own students" — a policy rule with the conversation's members as
context, the mechanism from Q1. No contract changes.

---

## Q8 — Who may amend attendance, and is a reason mandatory?

**Question.** Attendance is the record most likely to be quietly edited after
the fact. Who may amend it, how long after the session, and must they give a
reason?

**Why not guessed.** This is an integrity control. Guessing it wrong in either
direction — too permissive, or so strict that a genuine correction is
impossible — has real consequences for people.

**Built instead.** `AttendanceAmendment` in operations' contract **requires**
`reason` and `amendedBy`. That much is a technical position we are willing to
take: an unexplained amendment should not be representable. *Who* may amend, and
*for how long*, remain open.

**When answered.** Permissions plus a policy rule with a time bound.

---

## Q9 — Who issues certificates, and on what evidence?

**Question.** Automatic on programme completion, or explicitly awarded by a
named person? What evidence must exist? Can one be revoked?

**Why not guessed.** A certificate is an institutional assertion about a person.
Its issuance rule is the institution's to state.

**Built instead.** Nothing. The prototype displays certificates; no issuance
logic exists on the backend.

**When answered.** A `certificates` module, or a slice of `academic`. Nothing
existing changes.

---

## Q10 — What can a Parent see?

**Question.** Their child's attendance, grades, teacher comments, message
history? Both parents where guardianship is shared? What about a student who is
an adult?

**Why not guessed.** Privacy, and the age of majority, and family arrangements
that vary by jurisdiction. There is no safe default.

**Built instead.** `people/contracts` carries `Guardianship` as a concept
without implying what it grants. The Parent role exists with a deliberately
minimal provisional permission set.

**When answered.** Policy rules scoped by guardianship. The mechanism exists.

---

## Q11 — Languages, localization and text direction

**Question.** The institution is a Qur'anic one and the existing prototype is
Arabic-facing. Is the backend expected to return localized content, or only
keys? Are programme and halaqa names multilingual? Do notification templates
need per-language variants?

**Why not guessed.** It changes the shape of stored data — one name column or
several — and retrofitting multilingual content is a migration across every
table that holds a human-readable string.

**Built instead.** `NotificationRequest` carries a `template` key plus
parameters rather than a rendered string, so localization can happen at
delivery. Nothing else assumes a language.

**When answered.** Possibly a schema change for content tables. This is the
question on this list with the largest cost of being answered late, which is
why it is on it.

---

## Q12 — Timezone and academic calendar

**Question.** Is the institution single-timezone? Are sessions scheduled in
local time or UTC? What defines a term, and does attendance roll up by term?

**Why not guessed.** "Store UTC" is right for instants and wrong for recurrence:
a class at 5pm local should stay at 5pm across a DST change, which means
recurrence must be stored with a timezone, not as a UTC instant.

**Built instead.** All timestamps are `timestamptz`, and `Clock` is injected
everywhere rather than `new Date()` being called. No recurrence model exists
yet, so nothing has been decided wrongly.

**When answered.** The recurrence model in `operations`.

---

## Q13 — What do SUSPENDED and DISABLED mean, and who may move an account between them?

**Question.** Accounts have four states: PENDING (created, never usable),
ACTIVE, SUSPENDED and DISABLED. What distinguishes a suspension from a
disablement for this institution: unpaid fees, a disciplinary matter, leaving
the institution? May a disabled account ever be re-enabled? Should suspensions
expire automatically?

**Why not guessed.** Only the *mechanics* are technical: only ACTIVE may sign
in, and suspending or disabling ends every session. The *meaning* of each state,
and who may use it on whom, is policy.

**Built instead.** The four states and a transition table (no way back into
PENDING; DISABLED may return to ACTIVE, so the state is not a dead end by fiat).
PENDING was added beyond the brief's three because provisioning is
create → assign roles → activate. Without it, "not yet switched on" would be
stored as DISABLED, and a brand-new account would be indistinguishable from one
deliberately turned off. Who may change status is `users.manage`, bounded by the
no-escalation rule.

**When answered.** Permissions or policy rules per transition; perhaps an
expiry on suspensions (an `automation` job). The states themselves are unlikely
to change.

---

## Q14 — Password policy: minimum length, and a breached-password check

**Question.** Is 8 characters the right minimum for this institution, perhaps
higher for staff? Should new passwords be checked against a list of known
breached passwords, as NIST SP 800-63B recommends?

**Why not guessed.** The minimum is a usability trade-off against security,
and many users here are children. A breached-password check means either
shipping a large list or calling an external service, and the latter sends
(hashed prefixes of) passwords to a third party.

**Built instead.** NIST's floor of 8 and a ceiling of 128, counted in characters,
applied only when a password is set. Marked provisional in
`identity/domain/password-policy.ts`.

**When answered.** Two constants, and possibly one more domain check.

---

## Q15 — After an administrator sets someone's password, must they change it?

**Question.** Staff can set an account's initial password and reset a
forgotten one; for learners without email, that is the realistic path. Should
the person be forced to choose their own password at next sign-in? Should staff
be able to see or choose the password at all, or should the system generate a
one-time one?

**Why not guessed.** A forced change is safer, and adds a step for small
children using shared devices. A generated one-time password changes what the
admin UI shows. Both are product decisions.

**Built instead.** Reset sets the password and ends every session of the
account. Nothing forces a change.

**When answered.** A `mustChangePassword` flag and a check in login. Contained
to identity.

---

## Q16 — How long should a sign-in last?

**Question.** Sessions last 30 days, absolutely, and refreshing never extends
them. There is no idle timeout. Is 30 days right, and should it differ for
staff, or for shared devices? Should an unused session expire sooner? That
would mean re-entering a password after the summer break.

**Why not guessed.** It trades convenience for children against exposure on
lost or shared devices, and the institution knows which devices are shared.

**Built instead.** Absolute expiry, configurable (`REFRESH_SESSION_TTL_SECONDS`);
15-minute access tokens (`JWT_ACCESS_TTL`). Strict refresh rotation with no
grace window: a client that refreshes twice at once signs itself out. That is
the safe default and is documented as a client requirement.

**When answered.** Configuration, and possibly an idle-timeout check in refresh.
If telemetry shows real users signed out by double refreshes, reconsider a
short grace window, knowing it opens a replay window.

---

## Q17 — How does the web app hold its refresh token?

**Question.** Mobile apps keep tokens in Keychain/Keystore. A browser has no
equivalent: `localStorage` is readable by any script that runs on the page. The
usual answer is an httpOnly, Secure, SameSite cookie scoped to `/auth/refresh`,
which brings CSRF considerations and a CORS policy with credentials.

**Why not guessed.** It depends on how the web app will be deployed (same
origin as the API, or not), and the Flutter web build is not connected to the
API yet.

**Built instead.** Refresh tokens travel in the response body, which is right
for mobile. The `AuthRepository` contract states the storage rule. Messaging V1
connected the app to the API, including on the web, with two safeguards: a
**CORS allow-list** (`CORS_ORIGINS` — explicit origins only, never a wildcard,
never credentials), and a web client that keeps tokens **in memory only** —
never `localStorage` — so a reload signs the person out, and nothing persists
for a script to find later. That is safe but inconvenient; it is not the
answer to this question.

**When answered.** A cookie mode on `/auth/login` and `/auth/refresh` for the
web client, with CSRF protection. The allow-list already exists.

---

## Q18 — May an admin create other admins?

**Question.** Under the provisional matrix, an ADMIN holds everything an ADMIN
holds, so the no-escalation rule allows one admin to grant ADMIN to another
account, and to suspend or reset the password of another admin. Should creating
and managing admins be reserved to the owner?

**Why not guessed.** Delegation of administrative power is exactly the kind of
governance choice this document exists for.

**Built instead.** The mechanically consistent default: no one may create or
manage an account more powerful than their own. Admins cannot touch owners;
among equals it is allowed.

**When answered.** A policy rule denying `roles.assign` of ADMIN to non-owners,
or a permission split. No structural change.

---

## Q19 — What may be uploaded, and how much?

**Question.** Which file types does the institution need — are Word and
PowerPoint documents required, or is PDF enough? How large may a voice
message, an image, a recording, a document be? Is there a per-person or
per-institution storage quota? How long are uploads that were started but
never completed kept?

**Why not guessed.** Office formats are ZIP containers that can carry macros;
accepting them is a security trade-off the institution should make knowingly.
Size caps are cost and bandwidth decisions for the institution's users and
connections.

**Built instead.** An allow-list per kind (storage.md §4): JPEG/PNG/WebP
images ≤ 10 MB; AAC/Opus voice ≤ 5 MB and ≤ 10 minutes; MP3/AAC/Ogg audio
≤ 50 MB; PDF documents only, ≤ 25 MB. Every limit is marked PROVISIONAL in
`file-policy.ts`. No quotas. Abandoned uploads are kept (indexed for a future
sweep).

**When answered.** Constants in `file-policy.ts` (plus a signature for any new
type); a quota check in `RequestUploadUseCase`; a sweep job.

---

## Q20 — Messaging limits

**Question.** How long may a message be? How many members may a group or a
channel have? How many messages may one person send per minute?

**Why not guessed.** They shape how the institution uses messaging — one
2,500-student announcements channel, or one per halaqa.

**Built instead.** PROVISIONAL engineering defaults in `messaging-policy.ts`
and `messaging-settings.ts`: 4,000 characters; groups ≤ 500 members; channels
≤ 10,000; 200 people added per request; 120 messages per minute per person;
60 new conversations per hour per person.

**When answered.** Constants. No structural change.

---

## Q21 — Does someone joining a group see what was said before?

**Question.** When a student is added to an existing group, should they see
its earlier messages? And in a channel?

**Why not guessed.** Earlier group messages were written to a smaller
audience; showing them to newcomers is a disclosure their authors did not
choose. Channels are the opposite case — notices meant for everyone.

**Built instead.** GROUP: history hidden, starting at the join
(`hidden_through_sequence`). CHANNEL: full history. DIRECT: n/a. One function,
`historyHiddenThrough()`, marked PROVISIONAL.

**When answered.** That function. Existing members' windows are stored per
participant, so a change applies to future joins without a migration.

---

## Q22 — Who may see who is in a conversation?

**Question.** Should the subscribers of an announcements channel see one
another? Should group members see each other's names?

**Why not guessed.** A channel of all students would publish the full roll
to every student — a privacy decision, especially for minors.

**Built instead.** Groups and DMs: members see members. Channels: only the
owner and publishers may list members; readers get
`messaging.members_hidden`. Realtime tells only the person added or removed —
announcing membership changes to the other members waits on this answer.

**When answered.** One condition in `ListParticipantsUseCase`, and the
matching audience for realtime's `participant.*` events.

---

## Q23 — Moderation, deletion and review

**Question.** May anyone read a conversation they are not in — for
safeguarding review, after a complaint? When a message is deleted, is its text
wiped, or kept for review? Who may delete others' messages? How long are
messages kept (see also Q3)?

**Why not guessed.** Each is a safeguarding and privacy decision with legal
weight, and the conservative defaults conflict: wiping protects privacy,
keeping protects review.

**Built instead.** Nobody reads a conversation they are not in — not even the
owner, who holds every permission (tested). `messaging.manage` lets a
moderator **remove** someone from a group or channel, audited as moderation,
and grants no access. Deletion is schema-ready (`deleted_at`, tombstones in
every read path, a CHECK that permits a wiped body) but not exposed.

**When answered.** A review capability would be a new, audited use case with
its own permission and probably a second approval — not a widening of
`messaging.read`. Deletion is one use case either way.

---

## Q24 — Notifications: push provider, lock-screen previews, quiet hours, mute

**Question.** Which push provider — FCM for Android (and perhaps iOS and the
web), APNs directly for iOS, web push? May a push show the sender's name, or
the message text, on a lock screen — on a child's phone, on a shared classroom
tablet? Quiet hours, per person or institution-wide? Per-conversation mute?

**Why not guessed.** A provider is an account and a data-processing agreement:
Google or Apple sees every push's metadata. Lock-screen previews of children's
messages are a safeguarding decision. Quiet hours are an institutional policy
whose times depend on Q12 (timezone).

**Built instead (Notifications V1, [ADR 0013](decisions/0013-notifications-v1.md)).**
Everything except the provider: a stored inbox; per-category preferences with
a separate PUSH switch; device registration (`POST /notifications/devices`,
the token never returned or logged); and `PushDelivery` behind the
`PushProvider` port, with retries classified and dead tokens disabled. The
only adapter logs that a push would have gone out, and sends nothing. The
candidate packages were evaluated (versions, licences, platforms —
[notifications.md §12](notifications.md#12-push)) and none installed, because
none can be built or verified without a Firebase project, an Apple team and a
device. **PROVISIONAL lock-screen policy:** a push says only what kind of thing
happened — "رسالة جديدة" / "لديك رسالة جديدة." — with no sender and no text; the
full notification is in the app, behind sign-in. There are no quiet hours and
no mute.

**When answered.** One adapter implementing `PushProvider` in
`notifications/infrastructure/` and one line in `notifications.module.ts`, with
credentials in configuration; in the app, `PushTokenSource` implemented with
the chosen SDK, plus the platform project files. A preview, if allowed, is a
different body key and arguments in `pushMessageFor` (`domain/push.ts`). Quiet
hours and mute are filters in `PushDelivery`, which every source's
notifications already pass through, plus a preference field.

---

## Q25 — May members see how far others have read?

**Question.** Read receipts: should a teacher see which students have read an
announcement? Should the two people in a direct conversation see "seen"? And
in a group?

**Why not guessed.** Read state is behaviour data about individuals, many of
them children. In a channel it would also reveal who the readers are, which
Q22 already withholds; "seen" in a DM puts pressure on the person who read
and did not reply.

**Built instead.** Each person's read mark is stored and moves only forward.
Realtime delivers it to that person's own devices, so a badge cleared on one
clears on the others — and to nobody else. No API exposes another member's
mark, and reading never creates a notification for anyone (Q28).

**When answered.** A per-conversation-type audience for `message.read` in the
realtime relay, and a read-model query for "seen by", gated by whatever this
answer allows.

---

## Q26 — Realtime limits

**Question.** How many live connections may one account hold? How often may
a client reconnect, and how many handshakes may come from one address (a
school's NAT)? How long may a revoked session keep receiving before the
server notices?

**Why not guessed.** The right numbers depend on how the app is really used —
shared classroom tablets, many tabs, a whole school behind one address — and
on load that has not been measured.

**Built instead.** Development-safe defaults, generous to honest clients, in
one file (`realtime/domain/realtime-policy.ts`), each with its reasoning in
[realtime.md §M8](realtime.md): 10 connections per account; 30 new
connections per account per minute; 300 handshakes per address per minute;
60 frames per connection per minute; 4 KiB frames; a 25-second heartbeat;
revalidation every 60 seconds; 10,000 connections per instance.

**When answered.** Constants in that file — after a load test on the
production topology, not before.

---

## Q27 — How long are notifications kept?

**Question.** Are read notifications deleted after a while (30 days? a term? a
year?), and unread ones? Are they kept after an account is disabled, and for
how long? Should they follow the retention of what they point at (Q3)?

**Why not guessed.** A notification is a small record of what someone was
told — useful to them, and sometimes the evidence that a message reached a
guardian. Deleting on a guessed schedule is irreversible; keeping everything
forever has a storage and privacy cost. It is tied to Q3 (retention) and Q13
(what DISABLED means).

**Built instead.** Kept indefinitely: nothing deletes a notification — not
suspension, not disabling (tested). Nothing slows down as they accumulate:
pages are keyset range scans, the unread count reads at most 100 rows, and
"mark all read" works in chunks. A row holds keys, ids and at most a display
name.

**When answered.** A scheduled job deleting by `created_at` in chunks — the
`(recipient_user_id, created_at, id)` index already serves a per-person sweep;
an institution-wide sweep would add a `created_at` index by migration. No
change to the model or the API.

---

## Q28 — What deserves a notification, and how loudly?

**Question.**

- **Defaults.** Every channel is on for messages today. Should a channel's
  posts push by default? Should students get pushes by default?
- **Collapsing.** Should twenty messages in a busy group be twenty
  notifications, or one ("20 رسالة جديدة في …")?
- **Large channels.** Should a post to a 2,000-member channel notify everyone,
  or only those who opt in?
- **Priority.** May an administrator send an announcement that is always
  delivered — above a person's preferences, or through quiet hours? Who may?
- **Read receipts.** Should reading a message ever notify the sender? (It does
  not; see Q25.)
- **Future categories.** When assignments, announcements, certificates and
  halaqas arrive, which of their facts notify, whom, and do parents receive
  their child's?

**Why not guessed.** These are questions of attention and trust, not
mechanics. A school that notifies too much trains everyone to ignore it; one
that notifies too little misses the message that mattered. The answers differ
by role, age and institution, and "always delivered" is a power that needs an
owner (Q1).

**Built instead.** One notification per message per reader (never the
sender), per new conversation and per addition — the three messaging types
only. Defaults are all on (PROVISIONAL), and each person may turn each channel
off per category. There is no collapsing, no priority and no exception to
preferences, and a read never notifies anyone. The five reserved types
(assignments, announcements, certificates, halaqas) have no source and are
refused. The model is ready: every notification has a type and a category, a
type is activated by one catalog line, and each push already carries a thread
key that groups a conversation's pushes on the device.

**When answered.** Defaults are one constant (`DEFAULT_CHANNEL_PREFERENCES`),
or per-role defaults read where `preferencesFor` fills in missing rows.
Collapsing is a key in the translator (one unread notification per
conversation, updated in place) — no change to the dispatcher or the
clients. Priority is a request field the dispatcher weighs against
preferences, plus a permission for who may set it. New categories arrive with
their types.

---

## How to close one

1. Record the decision as an ADR in `decisions/`.
2. Make the change — in almost every case above, a constant, a policy rule or
   one adapter.
3. Delete the entry here, with the ADR number in the commit message.

A question that is answered in a conversation and not written down is still
open.
