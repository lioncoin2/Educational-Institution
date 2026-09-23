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

**Built instead.** Nothing that presumes an answer. Messaging is contract-only,
and the contracts express *shape* (conversations, participants, messages), never
*who may start one*. The check will be an authorization question with the
conversation as context — the mechanism from Q1.

**When answered.** Policy rules plus permissions. No contract changes.

---

## Q7 — How are new messages pushed to connected clients?

**Question.** A WebSocket gateway in this process; the LiveKit data channel;
or a dedicated push channel (SSE or a separate service)?

**Why not guessed.** The load profile decides it, and the load profile is not
known. A channel with 2500 members behaves nothing like direct messages between
two people, and option 2 would couple messaging to the RTC provider —
contradicting the separation the rest of this design maintains.

**Built instead.** Nothing. What *is* decided: the choice must not leak past
`messaging/infrastructure/`. Use cases raise `messaging.message.sent` and are
indifferent to how it reaches a phone.

**When answered.** An adapter in `messaging/infrastructure/`.

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
for mobile. The `AuthRepository` contract states the storage rule.

**When answered.** A cookie mode on `/auth/login` and `/auth/refresh`, and a CORS
allowlist in configuration. Must be done before the web app is connected.

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

## How to close one

1. Record the decision as an ADR in `decisions/`.
2. Make the change — in almost every case above, a constant, a policy rule or
   one adapter.
3. Delete the entry here, with the ADR number in the commit message.

A question that is answered in a conversation and not written down is still
open.
