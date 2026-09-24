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

**Proposed design (Q40–Q72).** PROVISIONAL
([Q54](#q54--who-starts-ends-and-moderates-a-live-session)):
[ADR 0017](decisions/0017-community-scoped-authorization.md) would revise
the host-only answer when it lands (P6): the host while `community.live.host`
holds, plus holders of `community.live.moderate`; no role, OWNER included,
moderates without community standing.

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

**Proposed design (Q40–Q72).** The proposed modules would delete nothing:
stints, links, grants, live sessions, hands and snapshots are kept until
this is answered ([Q71](#q71--correcting-retaining-and-erasing-snapshots)).

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

**Proposed design (Q40–Q72).** PROVISIONAL (this question and
[Q54](#q54--who-starts-ends-and-moderates-a-live-session)): community live
sessions would keep 4 speakers and FCFS; the presenter and moderators
publishing by right would use no speaker slot. Other floor rules are [Q62](#q62--floor-rules-beyond-first-come-first-served).

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

**Proposed design (Q40–Q72).** For community live sessions the design
proposes, PROVISIONALLY, that the record wins and a reconciler converges
LiveKit to it within 60 s ([live.md §11](live.md#11-the-reconciler)).

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
logic exists on the backend. The app's certificates are **mock data in both
modes**: `certificateRepositoryProvider` is always the mock one. Their titles
(«إتمام قسم محو الأمية / تلقين الحروف / تجويد مبتدئ») imply that a *section*
is completed, and completed in page-6 order. That is a placeholder, not a
rule. Page 13 of the profile speaks of passing «البرامج و الدورات» «وفق
معايير و ضوابط معتمدة» and states no criteria. The owner's information of
2026-09-23 (mastery, progression) bears on this; see
[Q37](#q37--moving-between-halaqat-and-sections-assessment-placement-strengthening-نظام-الضخ)
and [Q38](#q38--the-development-path-teacher-preparation-and-who-trains).

**When answered.** A `certificates` module, or a slice of `academic`. Nothing
existing changes, apart from the mock titles and the backend-mode wiring.

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
delivery. Academic names — sections, programs, halaqat — are one `name`
column each, Arabic as the profile states them; what identifies them is a
language-neutral `code` (`dep-literacy`), so a second language would add
columns or a table without touching any reference. Nothing else assumes a
language.

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

**Also bears on the academic structure.** The owner calls one core section a
«دورة» (course), and the profile's page 13 speaks of «الدورات». If a course
runs in intakes, it raises three questions:

- Should halaqat or programs carry dates or a term? They carry none today.
- Are groups opened again for each intake?
- Should the 200-halaqat-per-program cap still count INACTIVE halaqat? It
  counts them today, and they are never deleted.

See [Q36](#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups).

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

**Proposed design (Q40–Q72).** This also covers community size.
PROVISIONAL (this question): no member limit as policy, and messaging's caps
would not apply to community chats
([communities.md §5.4](communities.md#54-no-ceiling-as-policy)). Posting in
a community chat closes above `communityChatMaxServedMembers` (250), an
engineering switch, until gates G1–G4 hold
([community-chat.md §11.2](community-chat.md#112-gates-g1g4)). Built in P4:
the caps above apply only to conversations messaging manages; the switch is
the deployment setting `MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS`.

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

**Proposed design (Q40–Q72).** Community chats would follow the channel
rule (full history), PROVISIONALLY; see
[Q52](#q52--community-chat-history-for-newcomers-and-returners).

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

**Proposed design (Q40–Q72).** This also covers community rosters.
PROVISIONAL (this question): members would see the community, its count and
themselves; listing would need `community.members.view`, with display names
only. Inside a live session, every participant sees every other
participant's name until [Q59](#q59--visibility-inside-a-live-session) is
answered.

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

**Proposed design (Q40–Q72).** The design reserves
`community.messages.moderate` ([Q51](#q51--the-community-chat-who-may-post));
its oversight removes, never adds ([Q43](#q43--institutional-oversight-of-communities));
removal from a live session is [Q64](#q64--removing-a-participant-from-a-session).

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

**Proposed design (Q40–Q72).** Join rates through one link, community chat
fan-out and live capacity would also come from load tests (P8;
[Q57](#q57--live-session-size-and-concurrency),
[Q65](#q65--media-hosting-and-operations)).

**Community chats (P4, built).** Engineering bounds of the same kind, all
PROVISIONAL here ([community-chat.md §10](community-chat.md#10-caps-and-size),
[§20.2](community-chat.md#202-choices-made-during-implementation)):

- at most 1,000 member states per apply;
- a sweep every 60 s;
- two background connections (one sync worker and the sweeper);
- 60 chat lookups per person per minute on
  `GET /messaging/communities/:id/conversation`;
- the capacity switch `MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS`,
  default 250. Above it a community chat refuses new posts until gates G1–G4
  hold. It is never a limit on a community's size.

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

**Proposed design (Q40–Q72).** Under today's rules one post in a
30,000-member community chat would write 30,000 rows, kept forever. The
design keeps community chats above the load-tested size disabled (a send
returns 412 `messaging.community_chat_over_capacity`) until gates G1–G4
hold; G4 is this question and Q28 answered, or the cost accepted
([community-chat.md §11.2](community-chat.md#112-gates-g1g4)).

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
key that groups a conversation's pushes on the device. Academic now publishes
`academic.student.enrolled` and `academic.teacher.assigned` (and their
endings); none notifies anyone until this question says which should.

**When answered.** Defaults are one constant (`DEFAULT_CHANNEL_PREFERENCES`),
or per-role defaults read where `preferencesFor` fills in missing rows.
Collapsing is a key in the translator (one unread notification per
conversation, updated in place) — no change to the dispatcher or the
clients. Priority is a request field the dispatcher weighs against
preferences, plus a permission for who may set it. New categories arrive with
their types.

**Proposed design (Q40–Q72).** This also decides gate G4 for community chats
([community-chat.md §11.2](community-chat.md#112-gates-g1g4)). Community,
live and attendance facts wait on [Q67](#q67--notifications-for-community-live-and-attendance-facts).

---

## Q29 — How do the sections relate, and what moves a student on?

**Question.**

- Are the five graded sections of page 6 (محو الأمية، تلقين الحروف، تجويد
  مبتدئ، متوسط، متقدم — listed, not ordered, by the profile) **strictly
  sequential**? Must a student finish one before joining the next, and may
  they skip one?
- Are التهجي، البراعم and اللغات **parallel** to that ladder, alternatives to
  it, or entry points into it? Are the accompanying programs taken alongside
  a section, or on their own?
- What **promotes** a student to another halaqa or section — a teacher's
  decision, an examination, a count of completed halaqat? Who decides?
- Are a section's halaqat **levels** (taken in order) or **parallel groups**
  (the same level, different times or teachers)?

**Owner information (2026-09-23), still open.** The owner has since named
assessment, placement, mastery, progression to higher levels,
strengthening/support and «نظام الضخ بين الأقسام» as parts of progression
([owner-information.md](../owner-information.md), S3 and S5), and listed seven
core sections (S1). None of this states a sequence, a prerequisite, a
criterion or who decides. The owner's numbering 1–7 is a list, not an order
of study. What those words mean for the record is asked in
[Q37](#q37--moving-between-halaqat-and-sections-assessment-placement-strengthening-نظام-الضخ).

**Why not guessed.** Each answer is a promotion rule, a prerequisite or a
completion rule — academic policy the profile does not state. A ladder drawn
with locks and ticks, or an enrollment refused for a missing prerequisite,
would be a rule nobody agreed to.

**Built instead.** Section `kind` (`PROGRESSIVE`, `SPECIAL`, `ACCOMPANYING`)
and `order` — a **display position, never a prerequisite**. Enrollment checks
only that the halaqa, its program and its section are ACTIVE and that the
account may study. Against the server, مساري marks where the learner is
enrolled and claims nothing about any other rung (neither done, nor open,
nor locked). Nothing promotes anyone.

Three things in the app look like answers and are not:

- **The demo ladder** (and the public Pages build of it) is a placeholder.
  That covers its locked rungs «يفتح بعد إتمام ما قبله», the «متاح» next
  rung, «4 من 10» halaqa completion and "a section is complete when its
  halaqat are".
- **The "levels" wording** in routes and titles (`/programs/:id/levels/…`,
  «المسار والمستويات») is inherited prototype wording, not a model of
  halaqat as levels.
- **The test fixture** in `access.spec.ts` that ends a tajweed-2 enrollment
  as COMPLETED before a tajweed-3 one is test data exercising access, not a
  promotion rule.

None of these is a specification for Progress or Promotion.

**When answered.** A prerequisite, if one is stated, becomes a check in
`EnrollStudentUseCase`, reading the student's history through the read
model, which is already indexed. A move, if one is defined, becomes an
explicit operation in one transaction, with the ending and link Q37 decides.
The app's مساري then shows whatever shape the answer has, which may not be a
ladder. The "levels" copy changes to match. If the path ever changes,
`/levels` stays as a redirect so deep links survive.

---

## Q30 — Enrollment policy

**Question.**

- May a student **enrol themselves**, or request enrollment, or is it always
  done by staff? Who among staff: admins only, or supervisors, or teachers
  for their own halaqat?
- May a student be in **several halaqat at once** — in one section, across
  sections, in an accompanying program alongside a section?
- What **completes** a halaqa: a date, an examination, a teacher's word? Who
  records it? Is "withdrawn" the only other ending?
- May an enrollment be **transferred** directly to another halaqa, keeping
  one continuous record?
- May an owner or an administrator be enrolled as a student?

**Owner information (2026-09-23), still open.** Placement follows an
assessment (S3), which describes an act by the institution, not by the
student. Nothing was said about self-enrollment. "Strengthening/support" may
mean a second, simultaneous halaqa or a move, and teacher preparation inside
a core section makes serving staff possible learners. Both are asked in
[Q37](#q37--moving-between-halaqat-and-sections-assessment-placement-strengthening-نظام-الضخ)
and [Q38](#q38--the-development-path-teacher-preparation-and-who-trains).
**COMPLETED and WITHDRAWN are known not to cover every ending.** A placement
correction, a support move, a ضخ move or a merge is neither. Until Q37 is
answered, do not record those in real data as either: an ended outcome
cannot be changed.

**Why not guessed.** Self-enrollment is a registration workflow (forms,
approval, capacity) the profile does not describe; a one-halaqa limit or a
completion rule decides who may study what.

**Built instead.** Staff-only enrollment (`academic.manage`, OWNER and ADMIN
provisionally); **no limit** on concurrent halaqat, beyond one ACTIVE
enrollment per student per halaqa; an enrollment ends only when staff end it,
choosing `COMPLETED` or `WITHDRAWN` — no rule decides for them; a "transfer"
is an explicit end followed by a new enrollment. Only an ACTIVE account
holding `academic.study` can be enrolled — STUDENT provisionally, and OWNER
and ADMIN, because the no-escalation rule makes them hold what they grant
([authorization.md §4](authorization.md)). The app enrols nobody and shows a
student with no enrollment exactly that — not a "pending" state that does
not exist.

**When answered.** Self-enrollment needs a permission, a use case and a
route. A request or awaiting-placement stage, if one is needed, is a
**separate intake record in a new table**, not a new enrollment status. An
enrollment status would relax `academic_enrollments_ended_consistent` and
fall outside the ACTIVE unique index and the halaqa-deactivation check.

Limits, if the institution states any, are a check in the enroll use case;
the count is indexed already.

A transfer or move is one use case that ends and creates in a transaction,
with the ending and link decided in Q37. Who may enrol is the role matrix
(Q1).

---

## Q31 — Teaching scope, and what staff may see

**Question.**

- May a teacher teach **several halaqat**? May a halaqa have **several
  teachers**, and what does an assistant teacher do that a teacher does not?
- What may a teacher see **outside** the halaqat they teach — other halaqat
  in their section? Their former students?
- What may a **supervisor** see: every roster, a section's, none?

**Why not guessed.** These are privacy boundaries for children's records.
Widening them later is a decision; narrowing them after data has been seen
cannot be undone.

**Built instead.** Assignments are many-to-many with a role
(`TEACHER` / `ASSISTANT_TEACHER`), no limit either way. A teacher reads a
halaqa's students and teachers **only through an ACTIVE assignment to that
halaqa** — and only while their account holds `academic.teach`; nothing
outside it. Supervisors see no roster. Students see their own record and
their own halaqa's teachers by display name. Administrators (`academic.manage`)
see all.

**What ships and is not yet decided.**

- An assigned teacher can list a halaqa's **ended** enrollments (the roster's
  status filter). That includes students who left before the teacher's
  assignment started.
- Nothing ends a teacher's assignment when the halaqa closes, so a closed
  halaqa's teacher keeps reading its roster.

Both need an answer: may a teacher see former students, and those from
before their time?

**Owner information (2026-09-23), still open.** Leadership/management is a
stage of the owner's development path (S4), and page 12 trains supervisors
and section management. Neither says what a supervisor may see.
[Q38](#q38--the-development-path-teacher-preparation-and-who-trains) asks
whether supervision is scoped to a section.

**A precondition for Attendance and Assignments.** Identity's provisional
matrix gives:

- SUPERVISOR **unscoped** `attendance.read`, `assignments.read` and
  `reports.read`;
- TEACHER **unscoped** `attendance.manage` and `assignments.manage`.

Those modules must scope these grants through `ACADEMIC_RELATIONSHIPS` (or
leave them unexercised). Otherwise they bypass the roster boundary academic
enforces here, and answer this question by accident.

**When answered.** A resource rule in `AcademicAccess.halaqaMembers` (e.g.
"supervisors of section S", backed by a relationship table if supervision is
scoped), or a grant in the role matrix. Hiding enrollments from before a
teacher's assignment is a filter in the roster use case. Assistant teachers'
distinct duties would be permissions checked in the future modules that act
per halaqa.

**Proposed design (Q40–Q72).** No proposed module would exercise
`attendance.*`; community snapshots would be scoped by community standing,
which reviewers must accept ([Q69](#q69--who-records-and-who-views-snapshots)).

---

## Q32 — Closing structure: who may, and what happens to its people?

**Question.** Who may deactivate (or archive) a section, program or halaqa?
When a halaqa closes, what happens to its teachers' assignments — end with
it, or stay for the record? Should a program or section closing end its
enrollments, or only stop new ones? Is there an "archived" state beyond
inactive?

**Why not guessed.** Ending a student's enrollment chooses an outcome
(completed or withdrawn) for them; ending a teacher's assignment ends their
access to the roster.

**Built instead.** `academic.manage` (OWNER, ADMIN) activates and
deactivates; nothing is ever deleted. Deactivating a section or program
closes it to **new** enrollment only. A halaqa **cannot be deactivated while
it has ACTIVE enrollments** — staff end them first, with the outcome they
choose. Teacher assignments are left as they are.

**Owner information (2026-09-23), still open.** Additional halaqat are
opened "according to level and need" (S2), so closing a halaqa when the need
passes may become routine. Its students then need somewhere to go and an
ending that is neither completed nor withdrawn. Until
[Q37](#q37--moving-between-halaqat-and-sections-assessment-placement-strengthening-نظام-الضخ)
defines that ending, do not close such halaqat in real data by ending their
students as COMPLETED or WITHDRAWN.

Also still open:

- Is closure per student or for the whole cohort?
- May halaqat be merged or split?
- Who opens and closes additional halaqat?

Consumers should also know that `ACADEMIC_RELATIONSHIPS.isTeaching` and
`isEnrolled` read ACTIVE relationships **regardless of the halaqa's,
program's or section's status**. A module that must not act on a closed
halaqa checks the structure itself, and does not answer this question
by default.

**When answered.** Ending assignments on closure is a few lines in
`ChangeHalaqaStatusUseCase`, inside the same transaction. Moving a closing
halaqa's students uses the move operation from Q37. An `ARCHIVED` state is a
vocabulary value and a check-constraint migration.

---

## Q33 — How is each section organised inside, and what are its halaqat called?

**Question.** The profile names five graded sections with their halaqat
counts, but **no program inside any section**, and no halaqa by name. Is each
section one program? Are there tracks, levels or cohorts inside it? What does
the institution call its halaqat? Do البراعم's three levels, علوم النحو's
five levels, قسم اللغات's five languages and التهجي's "استيعاب 40 مجموعة"
correspond to programs or halaqat?

**Why not guessed.** Inventing programs, level names or halaqa names would
put words in the institution's mouth in every screen and report.

**Built instead.** Each graded section has **one provisional program named
after the section** (its code `<section>-program`); the special sections have
no programs; the four accompanying programs sit under one section named by
page 10's heading, with no halaqat. The 45 halaqat are named by number
(`الحلقة 1`…), coded `<section>-h<n>`. Levels, languages and capacities are
**not** turned into programs or halaqat. The six study fields (page 5) are
linked to nothing. All of it is in one file,
`backend/src/modules/academic/application/institution-structure.json`, which
the app's profile data is tested against.

**Owner information (2026-09-23), still open.** The owner says each section
has 10 basic halaqat and that more are opened "according to level and need"
(S2). That may mean levels inside a section, which is exactly this
question; it is asked again in
[Q35](#q35--the-seven-core-sections-against-the-printed-profile). The
Tahajji figure is asked in
[Q36](#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups).

**Levels or tracks must be settled before real enrollments exist.** A
halaqa's program never changes, and moving halaqat between programs would
silently move every past enrollment's placement. Afterwards, only new
halaqat can be created.

**When answered.** Rename or add programs and halaqat through the API, with
no schema change. The provisional program keeps its code, and nothing refers
to it by name.

The structure file changes **only through the provenance model** of
[academic-reconciliation.md §1](academic-reconciliation.md#1-sources-and-how-they-are-kept-apart):
an ADR that records the owner's answer and each code→name decision, and
owner-sourced entries marked as such. The file's tests keep printed-profile
entries pinned to the profile. Owner facts are never merged into the file
as if the profile stated them.

---

## Q34 — Page 8: «القيم الإيرانية»

**Question.** Page 8 describes قسم البراعم as instilling «محبة القرآن
والسنة والقيم **الإيرانية**». This is almost certainly a typing error for
«الإيمانية», but it is what the profile says
([pdf-content-extract.md](../pdf-content-extract.md), page 8). Which wording
does the institution want shown?

**Why not guessed.** Correcting source text silently is inventing it; showing
a likely typo to every parent is not neutral either. The decision belongs to
the institution.

**Built instead.** Academic seeds **no descriptions** at all, so the
server carries neither word. The app's existing transcription in
`ProfileData` (from an earlier milestone) omits the word, reading «…والقيم في
نفوسهم»; this milestone neither restores nor replaces it, and records it
here.

**When answered.** One string in `app/lib/data/sources/profile_data.dart`,
or — if the institution writes its own description — a `PATCH` to the
section, which the app then shows instead of the profile's text.

---

## Q35 — The seven core sections against the printed profile

**Question.** On 2026-09-23 the owner listed seven core academic sections
([owner-information.md](../owner-information.md), S1): محو الأمية، تلقين
الحروف، المبتدئ، تجويد الحروف، التجويد المتوسط، التجويد المتقدم، دورة التهجي
وإعداد المعلمات. The owner also said each section has **10 basic halaqat**,
with more opened "according to level and need" (S2). The printed profile has
five graded sections (page 6) and three special ones (pages 7–9). Neither
المبتدئ nor تجويد الحروف appears in it as a section name.

- **Mapping.** There are three readings; which is right?
  - (a) المبتدئ is «قسم تجويد مبتدئ» (`dep-tajweed-1`), and تجويد الحروف is
    new;
  - (b) تجويد الحروف is «قسم تجويد مبتدئ», and المبتدئ is new;
  - (c) both are new, and the printed section was split or renamed.

  Are the owner's other names the same sections as the printed ones
  («قسم تجويد متوسط» and «التجويد المتوسط», and so on)?
- **Completeness.** Are the seven *all* the academic sections, or the core
  ones among others? That question is continued in Q39.
- **Literacy.** Page 6 gives محو الأمية **5** halaqat. Does "10 basic"
  apply to it, and is page 6 out of date?
- **Basic and additional halaqat.** Does "10 basic" mean ten that run today,
  or a standard? Once opened, does an additional halaqa differ from a basic
  one, and must the record show which is which? Who opens and closes
  halaqat? Does "level" mean levels *inside* a section (Q33)? Does "need"
  mean waiting students or a kind of learner (page 4's audiences)?
- **Order.** Is the numbering 1–7 the order to *display* the sections? This
  is asked about display only, not as a rule for moving students (Q29).
- **Names.** Should the printed names be kept anywhere (for example as an
  official name), or does the owner's wording replace them? Should the name
  carry «قسم»?

**Why not guessed.** Choosing between the mapping readings decides which
existing code gets which name, and whether one or two sections are created.
Section codes and kinds are hard to undo: nothing is deleted, codes are
never reused, and kind cannot be changed through the API. Adding halaqat
6–10 to literacy, or labelling halaqat "additional", would each assert a fact
the owner has not confirmed.

**Built instead.** Nothing changed. The seeded structure is still the printed
profile's: 9 sections, 9 programs and 45 halaqat. It is now labelled as
that, provisional
([academic-reconciliation.md](academic-reconciliation.md)). Additional
halaqat can already be opened through the API.

Until this is answered:

- Do not run the seed command against a production or shared database.
- Do not open real halaqat with seed-style codes (`<section>-h<n>`); the seed
  would adopt them as "basic".
- Do not create a second halaqa-bearing program in a section.

**When answered.** No schema change for names, counts or order; that is data.
Renames and new sections go through the API. The structure file changes
through the provenance model: an ADR records each code→name decision with
its date and source, and owner-sourced entries are marked as such. The seed
gains a parent check and explicit per-entry halaqa codes. Only a basic or
additional **marker** with consequences would be a new nullable column, in a
new migration.

---

## Q36 — Tahajji: دورة التهجي وإعداد المعلمات، مدينة التهجي, and the 40 groups

**Question.** The printed profile has «قسم التهجي» (page 7). It describes
teaching reading from letters and harakat to correct recitation, with
«استيعاب 40 مجموعة» and no mention of teacher preparation. The owner (S1,
S6) names «دورة التهجي وإعداد المعلمات» as a core section, and «مدينة
التهجي» with 40 specialized groups and teacher preparation.

- Is دورة التهجي وإعداد المعلمات the printed «قسم التهجي»? If yes, which
  name is shown, and does page 7's description still apply?
- Is مدينة التهجي **(A)** the same structure as دورة التهجي, or **(B)** a
  separate one? If separate, is it its own section, a part of دورة التهجي, or
  an accompanying program like «مدينة الحفاظ»?
- Is a Tahajji «مجموعة» a halaqa (students enrolled, teachers assigned), a
  smaller group inside a halaqa, or a WhatsApp/Telegram group?
- Do 40 groups **exist now**, or is 40 the number it **can hold**? Can more
  be opened?
- How do the 40 groups relate to the section's 10 basic halaqat (Q35)?
- Who studies there: students from other sections, new applicants, or
  serving teachers? Is its «إعداد المعلمات» page 12's «تأهيل معلمات»?
- Does it run in **intakes** (دفعات), with groups opened again for each one
  (Q12)?
- Is it a step on the same path as the other six sections, or a separate
  track? This is asked as a description, not as a rule.

**Why not guessed.** Each answer changes a different entity:

- (A) renames `sec-spelling`, which is `SPECIAL` with no program or halaqa;
- (B) creates a new section or program;
- "a group is a halaqa" creates 40 halaqat;
- "a group is inside a halaqa" needs a new table.

Making `sec-spelling` a core or graded section cannot be done through the
API, because kind is immutable. It would also change the app's home page,
whose featured card is taken from the SPECIAL sections.

**Built instead.** `sec-spelling` stays `SPECIAL`, with no program and no
halaqa, and the 40 groups are **not** structure. The app shows the profile's
«استيعاب 40 مجموعة» as profile text only. The `prototype-spec.md` phrases
«مجموعات التهجي (من أصل 40)» and «من أصل 40» assume a ceiling and are marked
unconfirmed.

**When answered.**

- **(A)** is data: `PATCH` the name, then `POST` programs and halaqat.
- **(B)** is data: a new section or program. Its code must differ from
  `prog-hifz-city` and be unique across sections and programs.
- **40 halaqat** fit the current cap of 200 per program.
- **A sub-group unit** or **intakes** (dates) is an additive migration.
- **Re-classifying** `sec-spelling` is an explicit, audited change-kind
  operation, or a new section code. It is never a data migration: that would
  bypass the audit trail, and would be a no-op on fresh databases because
  migrations run before the seed.
- **Trainees** are Q38.

**Proposed design (Q40–Q72).** The proposed `communities` module is not
called "group" and has no halaqa link, so it answers nothing here; see
[Q40](#q40--governance-which-gates-apply-to-the-new-modules) and
[Q50](#q50--communities-and-the-academic-structure).

---

## Q37 — Moving between halaqat and sections: assessment, placement, strengthening, نظام الضخ

**Question.** The owner describes progression as assessment/evaluation,
appropriate placement, mastery, progression to higher levels,
strengthening/support, and «نظام الضخ بين الأقسام» (S3, S5). None of these
has a definition yet.

- **Assessment.** Is it recorded? Who performs it? Is only the decision
  recorded, or a result too? Is it done before the first placement, between
  levels, or both? Is there a **standard evaluation form**, and what does it
  record? (The prototype's الإتقان / التجويد / الطلاقة with مقبول / إعادة
  was invented and will not be used unless confirmed.)
- **Awaiting placement.** Is there a period when someone is registered with
  the institution but not yet assessed or placed? Should the app show it?
- **Who places and moves students?** Administration, a section head, a
  supervisor, the teacher, or a committee? May a student be placed above her
  level directly (skipping a section), or moved down?
- **نظام الضخ.** What does it move: a student, a whole halaqa, or trained
  teachers? In which direction? Who decides, and when?
- **The ending.** When a student leaves a halaqa because she is moved (after
  assessment, for support, or by ضخ), is the old enrollment "completed",
  "withdrawn", or something else? What does the institution call each kind of
  move?
- **Continuity.** Should successive halaqat be recorded as one path ("moved
  from X to Y"), with the move as one act?
- **Strengthening/support.** Is it a separate halaqa taken alongside the
  regular one or instead of it, help inside the same halaqa, or a status on
  the student?
- **Merges and closures.** When a halaqa closes or merges, are its students
  moved (Q32)? Is that recorded as a move?
- **Mastery.** Should mastery be recorded per student and level, or is it
  only the reason staff give for a move? This asks whether to record it, not
  for criteria.

**Why not guessed.** Each answer is a placement, promotion or completion rule,
which the brief forbids inventing. More concretely, the only endings that
exist are COMPLETED and WITHDRAWN, and an ended outcome can never be changed
(409). Guessing which one a move "is" would mislabel real students
permanently.

**Built instead.** Nothing new. A move today is two acts: end, then enroll.
There is no link between them and no move-specific ending. No assessment,
placement, mastery or awaiting state exists; the model says so rather than
pretending. **Operating rule:** until this is answered, placement corrections,
support moves, ضخ moves and merges are not recorded in real data as COMPLETED
or WITHDRAWN.

**When answered.** Each of these is an **additive** change in a new
migration; `0007` and `0008` are untouched.

- **A move ending:** widen `academic_enrollments_status_valid` to a superset
  (dropping and re-adding a CHECK loses no data), or add a nullable
  transition-type column. It also needs a vocabulary value, an event (see
  `events.md`) and a Q28 decision on notification.
- **Continuity:** a nullable self-reference on the enrollment, or a moves
  table, plus one transactional move operation.
- **Assessment or placement:** a new table, with only the columns the owner
  defines.
- **Awaiting placement:** a separate intake table, not an enrollment status
  (Q30).
- **Who may move students:** grants in the role matrix (Q1) and a resource
  rule.

---

## Q38 — The development path, teacher preparation, and who trains

**Question.** The owner describes a development path: educational level,
mastery, specialization, training, teacher preparation, leadership and
management (S4). One core section includes teacher preparation (S1), and so
does مدينة التهجي (S6). The profile's page 12, «تأهيل و بناء الكوادر»,
lists four tracks: تأهيل مشرفات، تأهيل معلمات، التدريب على إدارة الحلقات،
التدريب على إدارة الاقسام. Page 5 lists six «مجالات التعليم و التخصص».

- Are the path's stages sections or programs with halaqat and enrolled
  learners, or staff roles and qualifications? Is "mastery" a programme the
  institution runs (for example مدينة الحفاظ), or something a student shows
  within her section?
- Are they page 12's tracks? Is "specialization" page 5's fields, and which
  sections or programs serve each field?
- Who are teacher-preparation trainees: students, serving teachers, or both?
  When a graduate starts teaching, is it the same account?
- Must preparation be completed before someone may be assigned to teach, or
  is there no such requirement?
- May trainees teach or assist in real halaqat (practicum)? If so, may they
  see those rosters?
- May one person be a student in one halaqa and a teacher in another at the
  same time? In the same halaqa?
- Leadership and management: is it training (enrollments), roles, or both?
  Is a supervisor attached to a section, and should she see that section's
  rosters (Q31)?

**Why not guessed.** A prerequisite to teach, a trainee category, or
supervision scope would each be a rule nobody stated. Page 12 describes
*training*, which may be enrollments; so leadership cannot simply be assumed
to be an identity role.

**Built instead.** Nothing new. Only accounts holding `academic.study`
(STUDENT, plus OWNER and ADMIN) can be enrolled. A serving teacher who
trains needs the STUDENT role as well. Roles combine, so that grants the
teacher nothing she did not have. The comment in `provisional-policy.ts` now
says that the trainee model is open. Enrollment and assignment history,
together with roles, already records who studied and taught what. No path or
stage entity exists.

**When answered.**

- An extra STUDENT role for trainees is a data row.
- Granting `academic.study` to a staff role changes the policy constant
  **and** needs a new `role_permissions` migration; a test pins the two
  together.
- A prerequisite to teach is a check in the assign use case, reading
  enrollment history, which is already indexed.
- Section-scoped supervision is a relationship table plus an
  `AcademicAccess` rule.
- A study-field link is a fields vocabulary plus a join table.
- A new section category is a widened kind CHECK in a new migration, and
  also needs the app, which hides unknown kinds.

---

## Q39 — What is outside the seven core sections, and who are they for?

**Question.** The owner's seven core sections do not include:

- قسم البراعم (page 8, three levels);
- قسم اللغات (page 9, five languages);
- the accompanying programs (page 10): مدينة الحفاظ، علوم النحو، المقارئ،
  المتون.

The questions:

- Are these still offered? Where do they sit relative to the seven: taken
  alongside, instead, or as the "specialization" stage (Q38)?
- Does "core academic sections" separate them from the non-academic
  departments (page 11 «قسم الإعلام والإعلان والتصاميم», page 13 «قسم
  الشهادات»), from البراعم, اللغات and the accompanying programs, or both?
- Page 4 lists البراعم and محو الأمية as **target groups** as well as
  sections. Is البراعم a section, or an age group that studies within the
  seven? Are some halaqat set aside for a group (الناشئات، كبار السن، غير
  الناطقين باللغة العربية)?
- Does «المقارئ — لكل قسم» mean one مقرأة per section?

**Why not guessed.** Silence is not removal. Deactivating البراعم or اللغات
would erase a printed offering on the owner's silence, and making البراعم an
audience would invent a rule about who studies where.

**Built instead.** Nothing changed: the three special sections and the four
accompanying programs stay seeded and ACTIVE. The `accompanying` row is an
engineering container, not a profile section: programs need a parent. So the
honest comparison is the profile's **8** academic sections against the
owner's **7**. Pages 11–13 are deliberately not academic structure. No
halaqa is linked to an audience.

**When answered.** Data: deactivate (reversible, nothing deleted), rename, or
add programs and halaqat through the API. An audience attached to halaqat
would be additive, and only if the owner says halaqat are dedicated to
audiences.

---

> **Q40–Q72 — Communities, Live and Attendance.** The design package in
> [communities-live-attendance.md](communities-live-attendance.md) was
> approved on 2026-09-23 and is implemented in phases; Q40 is answered. Each
> **Built instead** below was written before implementation and reads
> "nothing", followed by the default the design uses; the phase that builds a
> default updates its entry (Q41–Q53 name the phase — P2, P3 or P4 — that
> built theirs). Every such default is PROVISIONAL, belongs to the question it sits
> under, and is not a decision — building it answered nothing.
>
> The brief's "group" is the **Community** aggregate here: "group" already
> means messaging's `GROUP` conversation type, and is used for Tahajji's
> «مجموعة» in
> [Q36](#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups).
> A community's membership is not a live audience: 30,000 members is not
> 30,000 live participants. LiveKit facts below come from its server and SDK
> source; LiveKit's documentation site could not be read from here. Every
> `file:line` below is at commit `9670c47`, documents included, as in the
> hub.

## Q40 — Governance: which gates apply to the new modules?

**Answered (2026-09-23), by the user; recorded in
[ADR 0016](decisions/0016-communities-module.md).** The heading stays so the
links to it keep working; the question is closed.

1. **Communities is not blocked** by the academic reconciliation hold. It
   proceeds after the Phase 0 guards.
2. **Live-session architecture and hardening may proceed.**
3. **Attendance is approved as designed, but its implementation is held**
   until the institutional attendance questions are answered — especially
   [Q68](#q68--what-counts-as-present-in-a-snapshot) and
   [Q69](#q69--who-records-and-who-views-snapshots), and the related ones
   (Q70–Q72).
4. **Academic Progress and Promotion remain blocked** by their own unanswered
   academic questions (Q29, Q37 and those the reconciliation lists).

The same ruling approved three visible changes to the existing live module
(P1): listeners lose the LiveKit data channel; a repeated equivalent
raise-hand answers 200 (the first 201); the join token lives 120 seconds,
provided reconnection stays reliable for legitimate participants.

---

## Q41 — What is a community, and who may create one?

**Question.**

- What is a community in the institution's own terms?
- Who may create one (`communities.create`)?
- Who may take part in communities at all (`communities.read`)?
- May parents or guardians join ([Q10](#q10--what-can-a-parent-see))?

**Why not guessed.** No institutional source mentions communities. Creating
spaces of up to 30,000 people, many of them minors, is a safeguarding
decision, like Q6 for conversations. What a «مجموعة» is remains Q36.

**Built instead.** Implemented as the default below — P2 (the ceilings, migration 0009)
([communities.md §6.2](communities.md#62-identity-ceilings);
[ADR 0016](decisions/0016-communities-module.md),
[ADR 0017](decisions/0017-community-scoped-authorization.md)). PROVISIONAL
default: `communities.create` for OWNER and ADMIN only; `communities.read`
for all six active roles, mirroring `messaging.read`; no `kind` field; the
creator becomes the owner and the first member; PARENT stays inactive.

**When answered.** Grants are rows in identity's data migration 0009 (P2),
or a later `role_permissions` migration, as in Q1. Kinds, if the institution
defines them, are a vocabulary column and a CHECK in a Communities
migration. Parents wait on Q10.

---

## Q42 — Community ownership

**Question.**

- One owner per community, or several?
- Does ownership carry every capability within the identity ceilings,
  including moderating sessions that others host?
- May the owner leave, or be removed?
- Who may transfer ownership, and to whom? May a `communities.manage` holder
  name themself?
- What happens when no eligible member remains to take over?

**Why not guessed.** Communities may outlive the staff who run them, so who
answers for one is institutional. What exists today is messaging's
conversation owner, who can neither be removed nor leave, with no transfer
(`membership.use-cases.ts:211-219, 297-302`); that was chosen for
conversations, not for communities.

**Built instead.** Implemented as the default below — P2 (one owner, who cannot leave or be removed), P3 (transfer)
([communities.md §6.7](communities.md#67-the-owner),
[§6.9](communities.md#69-transfer)). PROVISIONAL default:

- exactly one owner, as standing on an ACTIVE stint;
- the owner implicitly holds every capability within the identity ceilings;
- the owner cannot leave or be removed while owner;
- transfer is by the owner, or by a `communities.manage` holder, to an
  eligible ACTIVE member other than themself;
- the new owner's grants end, and the old owner becomes MEMBER with no
  grants;
- with no eligible member, there is no recovery path.

**When answered.** What ownership implies, leaving and transfer are rows in
Communities' act rules and checks in the transfer use case (P3). A recovery
path is one use case under `communities.manage`. Several owners would
replace the one-owner partial unique index by migration, the largest change
here; it is cheapest decided before P2.

---

## Q43 — Institutional oversight of communities

**Question.** What may a holder of `communities.manage` (the institution's
OWNER and ADMIN, provisionally) do in a community they do not belong to?

- View it, list its members, lock and unlock it, list and revoke its links,
  remove members, recover ownership?
- Ever add people, create links, read its chat, act in its live sessions or
  see its attendance?
- Override a lock that the community's owner set?
- Are their reads audited?

**Why not guessed.** The precedents conflict. Messaging's rule is that a
permission never substitutes for membership, although `messaging.manage` may
remove members (Q23). Academic's `academic.manage` acts on any halaqa.
Access to children's rosters is a privacy decision.

**Built instead.** Implemented as the default below — P2 (view, members, lock, links, removal, the audited reads), P3 (transfer), P4 (oversight never reads a community's chat: a permit without a stint is refused)
([communities.md §6.11](communities.md#611-oversight-communitiesmanage);
[ADR 0017](decisions/0017-community-scoped-authorization.md)). PROVISIONAL
default: `communities.manage` is held by OWNER and ADMIN. It may view, list
members, lock and unlock, list and revoke links, remove members, and
transfer ownership (not to oneself). It never adds members, creates links,
reads chat, acts in live sessions or views attendance. Every read on the
oversight basis is audited.

**When answered.** Rows for the oversight basis in Communities' act rules
(P2; transfer in P3). Messaging, Live and Attendance ask
`COMMUNITY_AUTHORIZATION` and do not change. Who holds the permission is the
role matrix (Q1).

---

## Q44 — Who may hold delegated capabilities?

**Question.**

- Which roles may own a community or hold a delegated capability
  (`communities.moderate`)?
- May a student (a class monitor, for example), an assistant teacher or a
  supervisor be a delegate?
- Should some capabilities need a narrower or different ceiling?
- May delegates delegate further?
- May a delegate holding `community.members.remove` remove another delegate?

**Why not guessed.** Giving children or assistants power over other members,
and building chains of delegation, are governance and safeguarding choices.
The brief names only the teacher.

**Built instead.** Implemented as the default below — P3
([communities.md §6.8](communities.md#68-delegation-and-the-no-escalation-rule-p3);
[ADR 0017](decisions/0017-community-scoped-authorization.md)). PROVISIONAL
default:

- `communities.moderate`: TEACHER, plus OWNER and ADMIN by construction;
- every delegable capability requires `communities.moderate`, plus
  `live.moderate` for live acts and `messaging.send` for
  `community.chat.post`;
- only the owner grants and revokes; there is no sub-delegation;
- a non-owner may remove a member only if that member's ACTIVE grants
  (dormant ones included) are a subset of the remover's effective
  capabilities, and never the owner.

**When answered.** Who holds `communities.moderate` is a `role_permissions`
migration, as in Q1. A different ceiling for one capability is one row in
the act-rules constant (P3). Sub-delegation is one new capability and a
check; the proposed grant row already records `granted_by`, so no data
migrates.

---

## Q45 — Capability grants: duration, handover and visibility

**Question.**

- Are grants time-boxed ("acting teacher until Friday")?
- Do they survive the granting owner handing over ownership?
- When a holder loses the identity ceiling, is the grant purged or kept
  dormant?
- Who may see who holds which capability, and are grants announced to
  members?

**Why not guessed.** Each answer changes who keeps power as staff rotate.
Revealing staff or monitor roles in large groups of minors is a privacy
decision (Q22). Time-boxed grants are already deferred in
[authorization.md §10](authorization.md#10-deferred).

**Built instead.** Implemented as the default below — P3
([communities.md §6.10](communities.md#610-how-grants-end-and-dormancy)).
PROVISIONAL default:

- grants do not expire;
- they survive a transfer, except the new owner's own grants, which end;
- on loss of the ceiling a grant is dormant, not deleted, and the owner's
  view shows it as dormant;
- the owner sees all grants; each holder sees their own;
- nothing is broadcast; only the affected user gets the
  `community.access.changed` frame.

**When answered.** An expiry is a nullable `expires_at` on the proposed
grants table and one condition in the evaluator (P3, or additive after it).
Purging is a sweep. Visibility is a view rule; announcing grants is a
realtime audience (P5) and, if notified, a translator (P10).

---

## Q46 — What does LOCKED mean, and who may lock?

**Question.** Brief §5 asks for these to be evaluated, not decided. While a
community is LOCKED:

- May anyone join, by any path? Are links suspended, and do they work again
  after unlock?
- May anyone post in the chat, and may members still read it?
- May a new live session start? Does a running one continue, and may members
  join, rejoin and raise hands in it?
- May managers still manage?

And: who may lock?

**Why not guessed.** Each is a moderation and safeguarding choice, and the
conservative answers carry costs of their own, such as cutting off a lesson
in progress. Brief §5 names teacher, owner or an explicitly delegated
principal. The default reads "teacher" as the owner or a `community.lock`
grantee ([communities.md §6.14](communities.md#614-not-every-teacher-can-lock-every-community)),
and adds `communities.manage` holders, which the brief does not name; both
need institutional confirmation.

**Built instead.** Implemented as the default below — P2 (P3 adds grant, revoke and transfer to management: never closed by LOCKED; P4 builds the chat's side: reading continues, posting stops for everyone, the owner included — [community-chat.md §20.4](community-chat.md#204-membership-changes-and-the-chat-p4-brief-9))
([communities.md §8.2](communities.md#82-what-locked-means--provisional);
[ADR 0016](decisions/0016-communities-module.md)). PROVISIONAL default, as
one Communities table (`statePermits` plus `LifecycleEffects`):

| While LOCKED | PROVISIONAL default |
| --- | --- |
| Joining | refused, by every path |
| Links | suspended: neither consumed nor revoked; valid again after unlock unless expired or revoked; no new links |
| Chat | no posting; reading continues |
| Live | no new session; a running session continues, and join, rejoin, raise hand and moderation continue in it |
| Management | continues: unlock, view members, revoke links, remove members; and (P3) grant and revoke capabilities, transfer ownership |
| Who may lock | the owner, a holder of a delegated `community.lock`, or a `communities.manage` holder (beyond brief §5; [Q43](#q43--institutional-oversight-of-communities)) |

The gate never blocks unlocking.

**When answered.** One row of that table (P2). Messaging, Live and Attendance
see it only as act refusals and effects flags, so none of them changes.

---

## Q47 — Retiring a community

**Question.** How is a community retired? Is there an ARCHIVED state? Who
may archive, and can it be undone? What stays readable: the chat, past
snapshots? Is a community ever deleted?

**Why not guessed.** Q32 left ARCHIVED undecided for the academic structure
for the same reason: its meaning is policy.

**Built instead.** Implemented as the default below — P2
([communities.md §8.1](communities.md#81-states);
[ADR 0016](decisions/0016-communities-module.md)). PROVISIONAL default: no
ARCHIVED state; LOCKED is the only closed state. A community is never
deleted: there is no delete route, and foreign keys RESTRICT.

**When answered.** ARCHIVED is a vocabulary value, a CHECK migration and one
row in the effects table; consumers do not change. Deleting anything is a
retention decision (Q3).

---

## Q48 — Invitation links

**Question.**

- Who may create and revoke links?
- What default and maximum lifetime? Are use limits required?
- Is joining immediate, or does it need approval?
- What may a link holder see before joining, signed in or not?
- Does joining need a particular role-wide permission? May guardians join?
- Does a link stop working when its creator loses the right to invite?

**Why not guessed.** A bearer link lets anyone holding it into a space with
children. Lifetime, limits and eligibility express the institution's risk
appetite. Q2 forbids self-registration. Brief §4: a teacher can add members
through a link; here "teacher" is the owner or a `community.members.invite`
grantee.

**Built instead.** Implemented as the default below — P2 (P3 adds the creator's grant lookup)
([communities.md §7](communities.md#7-invitation-links);
[ADR 0016](decisions/0016-communities-module.md)). PROVISIONAL default:

- holders of `community.members.invite` create links; `communities.manage`
  may only list and revoke them;
- `expiresAt` is required: default 7 days, maximum 30 days, minimum
  5 minutes;
- `maxUses` is optional; null means unlimited until expiry;
- joining is immediate, for signed-in accounts holding `communities.read`
  only; no account is ever created;
- there is no preview endpoint;
- redemption re-checks that the creator currently holds
  `community.members.invite`: from P2, the creator's identity ceiling and an
  ACTIVE OWNER stint; P3 adds only the grant lookup. If not, the link fails
  (404 `communities.invitation_invalid`), so a demoted creator's links stop
  admitting from P2;
- per-user and per-IP rate limits are development-safe defaults.

**When answered.** Lifetimes and limits are constants (P2). Eligibility is
one check in redemption. An approval step is a join-request record and a
route, both additive. A preview is a new endpoint. Letting links outlive
their creator's authority removes one check.

---

## Q49 — Leaving, removal and rejoining

**Question.**

- May an ordinary member leave on their own?
- May a removed member rejoin through a link still in circulation?
- Must a removal carry a reason?
- Are removals announced to other members, or notified?

**Why not guessed.** Removal is a moderation act with safeguarding weight.
Announcing it discloses membership (Q22).

**Built instead.** Implemented as the default below — P2 (P4: a community chat follows it — messaging refuses its own add, remove and leave there with 412 `messaging.membership_managed_by_community`, and a rejoin starts a new window and watermark)
([communities.md §3.2](communities.md#32-membership-stints)).
PROVISIONAL default:

- members other than the owner may leave;
- someone whose latest stint is REMOVED cannot rejoin by link; a manager may
  re-add them directly;
- there is no reason field;
- only the removed person is told, through the `community.member.removed`
  frame.

What removal does to a running live session is
[Q63](#q63--losing-standing-during-a-running-session).

**When answered.** Leaving and rejoining are act rules and one check in
redemption (P2). A reason is a nullable column on the stint, additive.
Announcing is a realtime audience (P5) and, for a notification, a translator
(P10, [Q67](#q67--notifications-for-community-live-and-attendance-facts)).

---

## Q50 — Communities and the academic structure

**Question.**

- Is a community linked to academic structure (a halaqa)?
- May its membership come from enrollment, joining and leaving
  automatically?
- May capabilities follow from teaching assignments?

**Why not guessed.** Q36 is open, and the academic reconciliation is on hold.
What exists today: `ACADEMIC_RELATIONSHIPS` reads ACTIVE relationships
whatever the halaqa's status (Q32), and academic's events are not durable,
so a synced copy would drift.

**Built instead.** Nothing — design only
([communities.md §18](communities.md#18-relation-to-academic-q50)).
PROVISIONAL default: no link, no enrollment-sourced membership and no
derived capabilities in v1.

**When answered.** If yes: a nullable, immutable `halaqa_id` set at creation
and validated through `ACADEMIC_RELATIONSHIPS`; a SYNC membership source
filled by a reconciliation job; a `CapabilitySource` seam inside
Communities. None of these needs a contract change. None comes before Q36
and ADR 0015 ([Q40](#q40--governance-which-gates-apply-to-the-new-modules)).

---

## Q51 — The community chat: who may post?

**Question.**

- Does every community have exactly one chat?
- Who may post in it: every member, the owner only, delegated posters?
  Nobody while the community is locked?
- Does the answer depend on the community's size?
- Who may delete or moderate others' messages in it?

**Why not guessed.** Posting rights in an audience of up to 30,000 that
includes minors set the abuse surface and the moderation load (Q23). The
only precedents are messaging's provisional GROUP and CHANNEL rules (Q6,
Q20).

**Built instead.** Implemented as the default below — P4
([community-chat.md §5](community-chat.md#5-what-a-community-chat-is),
[§20](community-chat.md#20-p4-as-implemented);
[ADR 0018](decisions/0018-community-chat-projection.md)). PROVISIONAL
default:

- at most one chat per community, stored as an ordinary `CHANNEL`
  conversation;
- posting is `community.chat.post`: the owner implicitly, or an explicit
  grant, with the ceiling `communities.moderate` + `messaging.send`;
  refused while LOCKED;
- size: no policy rule, but an engineering switch. Above
  `communityChatMaxServedMembers` (250) a send returns 412
  `messaging.community_chat_over_capacity` and `canPost` is false, until
  gates G1–G4 hold; reading is unaffected
  ([community-chat.md §11.2](community-chat.md#112-gates-g1g4));
- no moderation of messages in v1 (`community.messages.moderate` is
  reserved).

**When answered.** Posting rules change Communities' act rules only;
messaging does not change (it asks `community.chat.post` on every send). Moderating messages adds
`community.messages.moderate` together with Q23's answer (P12).

---

## Q52 — Community chat history for newcomers and returners

**Question.**

- Does someone who joins a community, including through a link, see its
  chat's earlier messages?
- Does someone who rejoins get back their earlier view and read position, or
  start fresh?

**Why not guessed.** This is Q21's disclosure question for communities. A
leaked link would expose the whole archive to someone who should never have
joined.

**Built instead.** Implemented as the default below — P4
([community-chat.md §9](community-chat.md#9-read-watermarks-and-history-windows);
[ADR 0018](decisions/0018-community-chat-projection.md)). PROVISIONAL
default: `COMMUNITY_HISTORY = 'FULL'`, following Q21's channel rule. A
rejoin (a new stint, told apart by `source_membership_id`) starts a new
window and watermark.

**When answered.** One constant (`messaging/domain/community-chat.ts`).
Windows are stored per participant row, so a change applies to future joins
only, without a migration.

---

## Q53 — System notices in a community chat

**Question.** Are system notices ("X joined", "a live session started",
"attendance was taken") posted into a community's chat?

**Why not guessed.** Messaging dropped system messages
([ADR 0011](decisions/0011-messaging-v1.md), decision 6), so every message
needs a sender who is a member allowed to post. Announcing to 30,000 people
is notification policy (Q28).

**Built instead.** Implemented as the default below — P4
([community-chat.md §5.2](community-chat.md#52-the-rules-that-override-the-type)).
PROVISIONAL default: no. The chat is written by people only; other facts
travel as their own ids-only events and frames.

**When answered.** "No" changes nothing. "Yes" needs a message kind with no
human sender, which ADR 0011 removed: a new ADR and a messaging vocabulary
change, after P4.

---

## Q54 — Who starts, ends and moderates a live session?

**Question.**

- Who may start a community's live session, end it and moderate it?
- What may the host do that other moderators may not? What may a delegated
  moderator do to the host: mute them, end the session, override them?
- May the institution's OWNER or ADMIN step in without a community
  capability?
- Do moderators other than the host speak by right, and do they count
  against the speaker cap ([Q4](#q4--how-many-concurrent-speakers-and-in-what-order))?

**Why not guessed.** Q1 keeps live roles provisional ("host only, not even
OWNER"). Where authority sits inside a live classroom is pedagogy and
governance. Brief §9: a teacher who may start also moderates and ends; the
default follows it with teacher = starter (host) or
`community.live.moderate` holder.

**Built instead.** Nothing — design only
([live.md §7.2](live.md#72-liveaccess-host-and-moderators);
[ADR 0017](decisions/0017-community-scoped-authorization.md),
[ADR 0019](decisions/0019-community-scoped-live-sessions.md)). PROVISIONAL
default:

- start: identity `live.moderate` plus `community.live.start`; the starter
  becomes host;
- end and moderate: `community.live.moderate`, or the host while
  `community.live.host` holds;
- delegated moderators act only on participants who are not the host;
- every session moderator holding `live.speak` publishes audio by right and
  uses no speaker slot; today only the host does
  (`join-live-session.use-case.ts:83-91`);
- no institution-wide override.

This would revise Q1's provisional answer through ADR 0017 (P6).

**When answered.** Rows in Communities' act rules and in Live's `LiveAccess`
(P6). An institution-wide override would be an oversight row for the live
acts ([Q43](#q43--institutional-oversight-of-communities)).

---

## Q55 — Parallel live sessions in one community

**Question.** May a community run more than one live session at the same
time: parallel teachers, breakouts?

**Why not guessed.** An organisational and teaching choice that the brief
does not bound.

**Built instead.** Nothing — design only
([live.md §4.3](live.md#43-one-live-session-per-community);
[ADR 0019](decisions/0019-community-scoped-live-sessions.md)). PROVISIONAL
default: at most one live session per community, enforced by a partial
unique index. A second start returns the running session.

**When answered.** Dropping one index and changing the start semantics (P6
or later).

---

## Q56 — Screen sharing

**Question.**

- Who may present: moderators only, current speakers, a student a moderator
  chooses?
- Is screen audio allowed? How many may present at once?
- What content rules apply in rooms with minors?
- Is anything recorded, and is the start and stop of a share recorded?

**Why not guessed.** Safeguarding and teaching policy. Brief §11 states only
the default: the teacher may share, and students only with an explicit
capability. The default below defers the brief §11 path (a student sharing
under an explicit capability) to P12; that deferral needs the user's
confirmation. Recording is deferred today
([realtime.md §6](realtime.md#6-deliberately-deferred)).

**Built instead.** Nothing — design only
([live.md §6](live.md#6-the-presenter-slot-screen-share);
[ADR 0019](decisions/0019-community-scoped-live-sessions.md)). PROVISIONAL
default:

- only a session moderator who holds `live.speak` may claim the presenter
  slot, and only for themselves;
- one presenter at a time, as an engineering bound on egress;
- no screen audio, no delegation, no recording;
- opening a presenter grant is audited; closing it is audited when a
  moderator revoked it.

**When answered.** Who may present is a rule in `LiveAccess` (P6). Delegated
or audio sharing is P12. Recording would need its own ADR, storage and a Q3
answer.

---

## Q57 — Live session size and concurrency

**Question.**

- How many people may be in one live session?
- How many sessions may run at once?
- When a session is full: refuse, keep a waitlist, or offer a listen-only
  overflow stream?

**Why not guessed.** Capacity must come from measurement on the real
topology. The 2,500 figure in today's live code (`rtc-provider.ts:12`) was
never load-tested. LiveKit's published figure of about 3,000 per room must
be benchmarked here, and a LiveKit room runs on a single node. 30,000
members is not 30,000 live participants. Overflow behaviour is a product
choice.

**Built instead.** Nothing — design only
([live.md §12.2](live.md#122-the-cap-and-the-reserve)).
PROVISIONAL default: `LIVE_MAX_PARTICIPANTS_PER_SESSION = 300` plus a
reserve of 10, copied onto each session and enforced as LiveKit's
`maxParticipants`. Over the soft cap, listeners get 412
`live.session_full`. No waitlist and no overflow. The values rise only after
load profiles 1–3. The 300 is the size of the brief's load profile 1 (§27),
neither measured nor an institutional figure.

**When answered.** The measured knee (P8) sets the engineering ceiling; the
institution may set a lower cap and chooses the full-session behaviour;
configuration (`AppConfig.live`) uses the lower of the two. A waitlist or an
overflow stream is a new Live feature; more
listeners than one room holds is
[Q58](#q58--more-listeners-than-one-room-can-hold).

---

## Q58 — More listeners than one room can hold

**Question.** Is there a real requirement for more simultaneous listeners
than one room can hold, for example 30,000? If so, must those listeners be
able to raise hands and count in attendance?

**Why not guessed.** The brief treats this as a future problem to be kept
separate. No institutional figure exists.

**Built instead.** Nothing — design only
([live.md §12.3](live.md#123-the-large-event-path-stays-out-of-the-domain)).
PROVISIONAL default: not built. A broadcast seam is reserved inside Live.

**When answered.** A new port in `live/infrastructure` (for example egress
to a CDN), after P8. Communities, Messaging and Attendance are unaffected.

---

## Q59 — Visibility inside a live session

**Question.** Inside a live session, who may see the roster, who raised a
hand, who is speaking, and how many are present?

**Why not guessed.** The Q22 and Q25 privacy reasoning applies, especially
for minors. LiveKit shows every participant who is not hidden to everyone.
The visible in-room roster undoes Q22's provisional hidden community roster
for anyone who joins a session.

**Built instead.** Nothing — design only
([live.md §16](live.md#16-what-travels-where);
[ADR 0019](decisions/0019-community-scoped-live-sessions.md)). PROVISIONAL
default:

- the LiveKit roster stays visible, as it is today;
- the hands queue is visible to moderators only; each requester sees their
  own hand;
- no "X joined" frames;
- `hidden` travels in every permission set, always false, as the seam.

**When answered.** Who sees hands is the moderator audience of
`LIVE_AUDIENCE` (P6), used by the realtime relay (P7). Hidden listeners set
`hidden` true in the permission set (P12).

---

## Q60 — One account on several devices in a session

**Question.** May one account take part in a live session from more than one
device at once, for example a teacher presenting from a laptop and speaking
from a phone?

**Why not guessed.** It changes capacity, grants and attendance counting. It
is a usage policy with cost consequences.

**Built instead.** Nothing — design only
([live.md §9](live.md#9-livekit-hardening)). PROVISIONAL
default: no. The LiveKit identity is the account id, and the newest device
wins (`DUPLICATE_IDENTITY`). The client does not rejoin automatically after
being displaced.

**When answered.** "No" changes nothing. "Yes" changes the LiveKit identity
scheme, how capacity counts an account, and how a snapshot counts one
([Q68](#q68--what-counts-as-present-in-a-snapshot)); it belongs in P6,
before P9.

---

## Q61 — Ending abandoned live sessions

**Question.** When is an abandoned live session ended automatically: after
it has been empty for some minutes, when the host is absent, after a maximum
duration?

**Why not guessed.** How long an empty or unattended class stays live is a
product and organisational choice.

**Built instead.** Nothing — design only
([live.md §11.2](live.md#112-room-sweep--every-30-s);
[ADR 0019](decisions/0019-community-scoped-live-sessions.md)). PROVISIONAL
default: the system ends a session (reason `idle`) after its room has been
observed empty continuously for 900 s; never because the host is absent; no
maximum duration. LiveKit's own timeouts (1,200 s) are a backstop only.

**When answered.** One constant (`IDLE_END_SECONDS`), or one more condition
in the reconciler's room sweep (P6).

---

## Q62 — Floor rules beyond first come, first served

**Question.**

- May a moderator invite someone to speak who has not raised a hand?
- May a speaker hand the floor back?
- Should a pending hand, or a grant held by someone disconnected for a long
  time, time out?

**Why not guessed.** Queue fairness and classroom flow are teaching policy
(the Q4 reasoning). An automatic expiry can silently drop a quiet student.

**Built instead.** Nothing — design only
([live.md §5.1](live.md#51-transitions)). PROVISIONAL
default: a grant comes only from a raised hand; a speaker may hand the floor
back (granted → withdrawn); no timeouts; the speaker cap stays at 4 (Q4).

**When answered.** An invitation to speak is a new transition in the speaker
state machine; a timeout is a rule in the reconciler (P6, or P12). Queue
order stays Q4's comparator.

---

## Q63 — Losing standing during a running session

**Question.** Someone is removed from the community, suspended, or loses
`live.join` or a delegated capability while a session is running.

- Must it take effect in the session immediately, and within what latency?
- What happens to a host's running session, or to an attendance snapshot in
  progress?
- Is anyone told?

**Why not guessed.** This is safeguarding, and cutting off a lesson has a
visible cost. The open-source LiveKit server keeps refreshing a connected
participant's token, so a token's lifetime does not bound access.

**Built instead.** Nothing — design only
([live.md §11.3](live.md#113-participant-sweep--every-60-s-per-live-session-staggered),
[§11.4](live.md#114-targeted-watch--every-10-s);
[ADR 0019](decisions/0019-community-scoped-live-sessions.md)). PROVISIONAL
default:

- ejection or demotion happens at once through the event path, when the
  event is delivered, and within 60 s at worst through the participant
  sweep;
- their hand, floor and presenter grant close;
- a host who loses standing loses moderation, but the session continues for
  the others;
- only the affected person's client sees `PARTICIPANT_REMOVED`;
- repeated rejoin attempts are counted and shown to moderators;
- a second violation inside the enforcement window (an identity already
  removed or demoted is observed again not eligible to stay, or holding a
  source it is not entitled to publish) resets the media room automatically
  (P6): every token the violator holds names a deleted room, and every
  participant reconnects briefly. The audit `live.session.media_reset` has a
  null actor.

**When answered.** A different latency bound is the sweep interval (P6).
Letting a session finish before ejecting someone is one condition in the
event handler and the sweep. Dropping the automatic media reset is one
condition in the targeted watch, but removal alone is then not final on
self-hosted LiveKit ([live.md §9](live.md#9-livekit-hardening)).

---

## Q64 — Removing a participant from a session

**Question.**

- May a moderator remove a participant from a session? May that person
  re-enter?
- Is a reason required, and is the person told?
- When may a moderator reset the media room, which disconnects everyone?

**Why not guessed.** Moderation and due-process policy (Q23 territory).

**Built instead.** Nothing — design only
([live.md §3.5](live.md#35-moderationaction)).
PROVISIONAL default: not built; seams only (`ModerationActionType`
`remove_participant`, `RtcParticipantControl.removeParticipant`). A media
reset (epoch bump) that a moderator chooses is designed for P12; who may
trigger it, and when, is this question. The reconciler's automatic reset at
a repeated violation ([live.md §11.4](live.md#114-targeted-watch--every-10-s),
P6) only enforces decisions already taken
([Q63](#q63--losing-standing-during-a-running-session)) and is not this
question.

**When answered.** A use case on those seams, plus a re-entry rule (P12).

---

## Q65 — Media hosting and operations

**Question.**

- Self-hosted open-source LiveKit, or LiveKit Cloud?
- Where does it run relative to the API on the VPS?
- Is TURN over TLS on port 443 needed for school and home networks?
- Are there data-residency constraints?
- May load tests ever touch the production host, and who approves a run?

**Why not guessed.** Cost, operations and data residency are the owner's
trade-off, and the choice sets the ejection guarantees and the reachable
capacity. Load-testing production is an operational risk decision.

**Built instead.** Nothing — design only
([live.md §9](live.md#9-livekit-hardening);
[communities-live-attendance.md §20.2](communities-live-attendance.md#202-the-single-vps-and-the-path-beyond-it)).
PROVISIONAL default: self-hosted open-source LiveKit with
`room.auto_create=false`, no webhooks and no recording, on a single node for
development and load tests. A TURN decision is needed before the first real
class. Load tests never use production keys or rooms; they run on a replica
with the same hardware.

**When answered.** Deployment configuration, before P8 and before the first
real class. LiveKit Cloud would sit behind the same RTC ports; its ejection
guarantees have not been verified.

---

## Q66 — Realtime without messaging.read

**Question.** May an account that lacks `messaging.read` receive realtime
updates for communities and live sessions? Should any role ever lack
`messaging.read`?

**Why not guessed.** This is a role-matrix decision (Q1). What exists today:
the realtime connection opens only for holders of `messaging.read`
(`realtime-sessions.ts:443`). Opening it without that would need a
permission check per frame family on messaging's frames.

**Built instead.** Nothing — design only
([communities-live-attendance.md §16.3](communities-live-attendance.md#163-how-protocol-v1-grows-and-why-there-is-one-socket)).
PROVISIONAL default: the connection gate stays `messaging.read`. A test pins
that every role holding `live.join` or `communities.read` also holds
`messaging.read`. Other accounts get HTTP only.

**When answered.** "No role lacks it" changes nothing. Otherwise the gate at
that line widens, and messaging's relay checks `messaging.read` per frame
(P5).

---

## Q67 — Notifications for community, live and attendance facts

**Question.** Which of the new facts deserve a notification, and how loudly:
invited or added, removed, a live session started, a hand accepted, an
attendance snapshot recorded? For snapshots, what does the owner receive:
every snapshot, a summary, or exceptions only? Must any of them be
guaranteed? Are the participants (students) told that a snapshot was taken?

**Why not guessed.** This is notification policy (Q24, Q28), and the brief
says not to implement delivery. A guarantee would bring in the outbox
(trigger T2 in [ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md)).

**Built instead.** Nothing — design only
([communities-live-attendance.md §14](communities-live-attendance.md#14-event-model)).
PROVISIONAL default: no translators and no notifications. The design
publishes the events so that translators can be added later without
changing any publisher. Viewers read over HTTP. Participants are not told
that a snapshot was taken.

**When answered.** One translator per fact in notifications, importing only
the source module's contracts (P10). A guarantee first brings the outbox
(P11).

---

## Q68 — What counts as present in a snapshot?

**Question.**

- Only accounts fully connected, or also those still joining or
  reconnecting?
- Does LiveKit's short resume window after a network drop count?
- Are the host, speakers and the recorder counted like listeners?
- Does a connected listener who is muted or idle count?

**Why not guessed.** Brief §14 forbids silently defining presence, and this
is a record about children.

**Built instead.** Nothing — design only
([attendance.md §5.2](attendance.md#52-what-counts-as-observed-provider_registry_v1);
[ADR 0020](decisions/0020-attendance-snapshots.md)). PROVISIONAL default: no
entry is labelled present. Both CONNECTED and CONNECTING are stored, with
separate counts, and every role is treated the same. The rule is versioned
(`provider_registry_v1`).

**When answered.** A new observation rule under a new id (P9 or later). Old
snapshots keep theirs; no stored snapshot changes.

---

## Q69 — Who records and who views snapshots?

**Question.**

- Who may record a snapshot, and who may view one?
- Which "owner" does the brief mean: the community's owner, the
  institution's OWNER, or both? Which "authorized management principals"?
  Is a supervisor scoped as Q31 asks?
- Does recording imply viewing? Must the recorder be the host, or connected?
- May students or parents see their own entries?
- For reviewers: is community standing acceptable as the scoping
  relationship that
  [academic-reconciliation.md §13](academic-reconciliation.md#13-minimal-recommended-changes-before-the-next-milestone)
  requires, where it names `ACADEMIC_RELATIONSHIPS`?

**Why not guessed.** These are delegation and privacy boundaries for
children's presence data, and the §13 precondition names
`ACADEMIC_RELATIONSHIPS`. Brief §9, §13 and §15 state a default: the teacher
who teaches the session triggers attendance and can view it; the owner and
explicitly authorized managers can view. It still needs institutional
confirmation.

**Built instead.** Nothing — design only
([attendance.md §11](attendance.md#11-who-records-and-who-views);
[ADR 0020](decisions/0020-attendance-snapshots.md)). PROVISIONAL default,
following the brief:

- record: the community's owner; the session's host while
  `community.live.host` holds; the session's moderators
  ([live.md §7.2](live.md#72-liveaccess-host-and-moderators)); and a
  `community.attendance.record` grantee;
- view: the owner; the host or a recorder, for the snapshots of sessions
  they hosted or recorded in, while still a member; and a
  `community.attendance.view` grantee;
- so recording implies viewing for the sessions one recorded in, and beyond
  them only with `community.attendance.view`;
- the recorder need not be the host, or connected;
- the ceilings use no `attendance.*` permission;
- no institution-wide oversight until
  [Q43](#q43--institutional-oversight-of-communities) says otherwise;
- no student or parent view.

An alternative the institution may choose instead: the owner or an explicit
grant only, with recording not implying viewing.

**When answered.** Rows in Communities' act rules for the two reserved acts,
and the bases `AttendanceAccess` asks for
([attendance.md §11.3](attendance.md#113-attendanceaccess-how-refusals-map))
(P9). An institution-wide view is an oversight row (Q43); a student view is
a new route. Reviewer acceptance is an entry condition of P9.

---

## Q70 — Is a snapshot the attendance record?

**Question.**

- Is a snapshot the institution's attendance record, or only an observation
  that may feed operations' `AttendanceRecord`?
- If it feeds one: how do several snapshots of one session combine, and
  which states result?
- What about communities that correspond to halaqat? How does it roll up by
  calendar (Q12)?
- Should it fill the app's halaqa attendance figures?

**Why not guessed.** Turning "connected at time T" into present, absent or
late is exactly the threshold policy brief §14 forbids. `AttendanceState`
and TE-04 are unconfirmed.

**Built instead.** Nothing — design only
([attendance.md §13](attendance.md#13-snapshots-and-operations-attendancerecord);
[ADR 0020](decisions/0020-attendance-snapshots.md)). PROVISIONAL default:
observation only. No `AttendanceState`, no absentees, no derivation, and
nothing fills `Halaqa.attendedSessions`.

**When answered.** A derivation in operations that reads
`attendance/contracts`: operations depends on attendance, never the reverse.
It also needs Q8 and Q12, and [Q50](#q50--communities-and-the-academic-structure)
for halaqat. The snapshot model does not change.

---

## Q71 — Correcting, retaining and erasing snapshots

**Question.**

- May a snapshot be voided or corrected after it is recorded? By whom,
  within what time, with what reason?
- How long are snapshots kept?
- May a person see, or erase, the entries about them?

**Why not guessed.** This is Q8's integrity control and Q3's retention
decision, about children's data.

**Built instead.** Nothing — design only
([attendance.md §10](attendance.md#10-immutability-and-amendment)).
PROVISIONAL default: immutable, and kept like the audit log until Q3 is
answered. Corrections belong to a future attendance record using
`AttendanceAmendment`. No per-person index and no erasure path.

**When answered.** Retention is a scheduled job (Q3). A correction is a
future attendance record, never an edit of the snapshot. A person's view or
erasure is a per-person index and a use case, both additive.

---

## Q72 — When and how often snapshots are taken

**Question.**

- How often, and when, may snapshots be taken? Several per session?
- Ever automatically: at start, at end, at intervals?
- Is there an upper bound?
- May one be taken while the community is locked?

**Why not guessed.** Automatic timing, or a cap on how many snapshots a
session may have, would define attendance policy. Engineering limits must
come from a load test.

**Built instead.** Nothing — design only
([attendance.md §5.4](attendance.md#54-bounds)).
PROVISIONAL default: only on a press, with no per-session limit.
PROVISIONAL engineering bounds: 6 presses per 60 s per recorder (an
anti-abuse burst limit, not a limit on how often attendance may be taken);
listing concurrency 4 per process; a 15 s deadline; a 10,000-entry ceiling.
Attendance applies no lock rule of its own; the `COMMUNITY_AUTHORIZATION`
answer governs ([Q46](#q46--what-does-locked-mean-and-who-may-lock)).

**When answered.** Constants (P9), recalibrated after the load test.
Automatic timing is a scheduled caller of the same record use case.

---

## How to close one

1. Record the decision as an ADR in `decisions/`.
2. Make the change — in almost every case above, a constant, a policy rule or
   one adapter.
3. Delete the entry here, with the ADR number in the commit message.

A question that is answered in a conversation and not written down is still
open.
