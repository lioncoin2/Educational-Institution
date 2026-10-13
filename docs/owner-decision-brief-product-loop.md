# Owner decision brief — educational product loop & messaging governance

> **STATUS: RECOMMENDATIONS PENDING OWNER APPROVAL — nothing here is approved policy.**
> This is a decision-preparation brief (Sprint 33). It records the *actual* current behaviour
> (with code/test/ADR references), states each unresolved product decision in plain language, and
> offers a **recommended default clearly labelled as a recommendation**, with alternatives and
> implications. No product code, schema, migration, permission, contract, or UI was changed to
> produce it. Engineering will not implement any of these areas until the owner approves the policy
> and the governance rules (ADR + register) are satisfied. Where the decision is an *institutional*
> assertion about real students (what a grade/mastery/attendance-record means), **this brief does not
> propose the value** — that is the institution's to state; it presents only the safe interim and the
> additive shape the answer would take.

**Scope.** GROUP C (learning progress, assessment, mastery, certificates), GROUP D (assignments &
submissions), GROUP G (educational operations, reporting, automation), GROUP A residue / Q6 (parent
messaging, quiet hours), and Q28 (notification-policy residue).

**Source of truth.** Detail and evidence live in [`owner-decision-register.md`](owner-decision-register.md)
(groups A–G), [`architecture/open-questions.md`](architecture/open-questions.md) (Q1–Q72), the ADRs,
and [`project-roadmap.md`](project-roadmap.md). This brief consolidates those for an owner decision; it
supersedes none of them and marks nothing resolved.

**How to read a recommendation.** "Recommend" = a proposed default for the owner to accept, change, or
reject. "Safe interim" = what ships today if no decision is made (already true). "Cannot recommend" = an
institutional value engineering must not invent; the owner must supply it.

---

## Executive summary — what is and isn't built

| Area | Backend | Flutter | Decision type |
| --- | --- | --- | --- |
| Academic **structure** (sections/programs/halaqat, enrollment, teaching) | Implemented + validated (read + structure management) | Real (read) | Done |
| Progress / mastery / promotion / «نظام الضخ» | **Absent** (no code, no tables; `/academic/me` records "no progress") | Progress screen = **mock-demo**; backend returns `null` | **Institutional policy (Q37/Q38)** |
| Certificates | **Absent** | Certificates screen = **mock in both modes** (no HTTP repo) | **Institutional policy (Q9)** |
| Assignments & submissions | **Absent seam only** (empty module; contracts types only; no routes/tables) | **Absent** (feature dir empty) | **Product + institutional policy (no Q yet)** |
| Attendance snapshots | Implemented + validated (observation-only) | Real | Done (ADR 0023) |
| Derived attendance record (present/absent/late) | **Absent** (Q70 thresholds; `operations` seam on hold) | Absent | **Institutional policy (Q70/Q68/Q72)** |
| Operations / reporting / automation | **Absent seam only** (empty modules; reporting registry empty) | Absent | **Dependency-blocked + policy (Q70/Q71/Q3)** |
| Announcements / feed | **Absent** | **Mock in both modes** | Product policy (future) |
| Student↔student / student↔teacher DM | Implemented + validated (migrations 0018/0019) | Real | Done (owner GROUP A, 2026-10-11) |
| Parent messaging + parent role | **Absent / inactive** (PARENT role not activatable) | Absent | **Safeguarding + institutional policy (Q6/Q10)** |
| Quiet hours / mute | **Absent** (preferences are per-category on/off only) | Absent | **Product + safeguarding policy (Q6/Q24)** |
| Notifications (inbox/prefs/devices/translators) | Implemented + validated | Real | Done (ADR 0024/0025) |
| Real push delivery | **Logging stub** (no FCM/APNs SDK) | Unavailable | External-resource-gated (Q24/Q65) + Q28 residue |

Governance prerequisites that were blocking and are **now cleared**: Q40 (ADR 0016), Q35/Q36 (ADR 0015),
Q69 (ADR 0023), Q67 (ADR 0024), Q50 (ADR 0033/0035), Q31 teacher scoping (ADR 0032/0033). So the remaining
blockers below are **owner product/institutional policy** (and, for push/native/load, external resources)
— not engineering gates.

---

## GROUP C — learning progress, assessment, mastery, certificates  (Q37, Q9, Q38)

**Current behaviour.** The academic module records *structure and relationships* only — a student is
enrolled or not; there is no grade, score, percentage, mastery, placement, or "completed N of M." The
code says so explicitly (`academic/application/my-academic.use-cases.ts`: "Nothing here is progress…").
A "move" between halaqat is two acts (end enrollment, then enroll) with no linking record (Q37). The
Flutter **progress** screen exists and is routed, but in backend mode its repository
(`UnrecordedProgressRepository`) returns `null` and the screen shows "nothing recorded"; in demo mode it
shows invented mock data. **Certificates** exist only as a mock screen (`MockCertificateRepository` in
*both* modes — there is no server certificate). Lessons are structure-only (`getLesson()` → `null`,
"content is placeholder").

**Unresolved decision (plain language).** Does the institution want to *record* assessment, placement,
mastery, promotion, «نظام الضخ» moves, and certificates — and if so, for each: who decides/performs it,
what exactly is recorded, and what is each kind of move or award *called*? Are certificates issued
automatically on completion or awarded by a named person on stated evidence, and can they be revoked?

**Recommendation (pending approval).** **Engineering cannot recommend the institutional values** — a
placement/promotion/mastery/certificate rule is an assertion about real children that the brief forbids
inventing. The responsible recommendation is: **(1) keep the safe interim** (record no progression
semantics; progress/certificates stay clearly-labelled prototype screens; a move stays end+enroll); and
**(2) the owner defines the concepts first**, after which each answer is a small *additive* build:
a status-vocabulary widening, an owner-defined assessment table (only columns the owner names), a moves
table, and a certificates table/issuance rule. Engineering can present that shape for any concept the
owner defines — but will not pre-fill the labels or thresholds.

**Alternatives & consequences.** (a) *Define and record now* — unlocks the real learning loop (progress
and certificates become real), but mislabeling a child's mastery/placement is costly and hard to walk
back. (b) *Define a minimal subset first* (e.g. certificates only, or completion-only) — smaller blast
radius, lets the owner validate the vocabulary before the harder assessment/«ضخ» concepts. (c) *Keep
mock indefinitely* — zero risk, but the progress/certificate product stays non-functional.

**Security / privacy / authorization / data-model.** Highly sensitive (academic records about minors).
New tables are additive (migrations after `0021`; `0007/0008` untouched); reads must be scoped like the
roster (teacher sees own halaqa, admin all, student their own — the Q31/ADR 0032 pattern). Certificate
issuance/revocation needs an authority (who may award/revoke) and an audit trail. Notification facts for
"move"/"certificate" are the Q28 academic-category residue (still inactive).

**Prerequisites.** The institution's own definitions of assessment/mastery/placement/«ضخ»/certificate
(none can be inferred). GROUP A/Q31 teacher scoping — **already resolved**.

**Reversibility.** The *schema* is additive and reversible; the *vocabulary* (what a move/mastery/award
means for a real child) is a durable institutional assertion — low reversibility once records exist.

---

## GROUP D — assignments & submissions  (no Q yet; `assignments` is an empty seam)

**Current behaviour.** The `assignments` backend module is a boundary placeholder: an empty
`@Module({})` plus `contracts/index.ts` declaring only `SubmissionState` and `AssignmentRef`/`SubmissionRef`
types — no domain, application, infrastructure, api, routes, or tables. Permissions
`assignments.read/submit/manage` are seeded in the catalogue (migration 0002) but back no feature. The
notification types `ASSIGNMENT_CREATED/UPDATED` exist but are **inactive**. The Flutter
`features/assignments/` directory is **empty** — no screen, route, or repository.

**Unresolved decision.** Is an assignments/homework feature in scope at all? If so, what is its
workflow — who sets an assignment, who submits, who grades, what are the states and due dates, and who
sees whose submission?

**Recommendation (pending approval).** **Defer** until the owner provides a product definition. This is
greenfield and needs institutional workflow decisions (and overlaps GROUP C grading). Recommend **not**
building it ahead of a definition; keep the seam unimplemented. If pursued later, a thin first slice
(teacher creates an assignment for a halaqa; students submit; teacher marks returned/graded) scoped with
the existing per-halaqa authority would be the smallest coherent build.

**Alternatives & consequences.** (a) *Out of scope* — remove the ambiguity; the seam/permissions remain
harmless. (b) *In scope, full workflow* — substantial new module + storage + notifications + Flutter;
sequence it after GROUP C grading so grading is defined once. (c) *In scope, minimal* — faster value,
but risks rework if the grading vocabulary (GROUP C) changes.

**Security / privacy / authorization / data-model.** New module + tables (additive); file submissions
would reuse the existing `files` module; visibility must follow per-halaqa teacher scoping (never a
student seeing another's submission). Grading couples to GROUP C.

**Prerequisites.** A product definition; ideally GROUP C grading vocabulary first (to avoid double work).

**Reversibility.** Greenfield — high reversibility until records/submissions exist.

---

## GROUP G — derived attendance record, operations, reporting, automation  (Q70, Q71, Q72, Q68; + seams)

**Current behaviour.** Attendance **snapshots** are built and validated but **observation-only**: a
snapshot records "connected at T", and nothing turns that into present/absent/late (Q70), nothing fills
`Halaqa.attendedSessions`, and there is no erasure path (Q71). "Present" is deliberately **not** labelled
(Q68 safe default). The `operations`, `reporting`, and `automation` modules are empty seams: `operations`
contracts are "on hold with academic attendance (Q68/Q69)"; `reporting` declares a `WIDGET_PROVIDERS`
registry with **nothing registered**; `automation` declares an `AutomationRule` interface only. No
owner-operations/reporting surface exists in Flutter.

**Unresolved decision.** Should a snapshot feed a *derived attendance record* (present/absent/late), and
if so by what rule and academic calendar (Q70/Q72)? What is the retention/erasure policy for snapshots
and other data (Q71 = Q3)? Which reports/automations does the institution want (and automation's first
real job is the Q71 retention job)?

**Recommendation (pending approval).** **Keep snapshots observation-only** (safe; Q68/Q70 defaults) —
**engineering cannot recommend the present/absent/late thresholds** (an institutional assertion about
children, forbidden to invent). The derivation is an *additive* `operations` build once the owner states
the rule + calendar. `reporting` infrastructure (the registry) is genuinely **dependency-blocked**: it
has nothing to register until ≥1 module (attendance-record, progress, assignments) has an approved widget
— recommend building it *after* its first real widget exists, not before. `automation`'s retention job
waits on the Q3/Q71 retention policy.

**Alternatives & consequences.** (a) *Derive a record now* — enables attendance reporting, but a wrong
present/absent/late rule is a durable claim about a child; must come from the owner. (b) *Snapshots only
(interim)* — safe, but no attendance analytics. (c) *Build reporting shell first* — wasted effort (no
widgets to show).

**Security / privacy / authorization / data-model.** Attendance viewing already uses academic-relationship
**and** community standing (ADR 0023/Q69); no student/parent self-view. Derivation + retention touch
minors' records — additive tables, audited, with a defined erasure path (currently kept like the audit
log until Q3). Reporting widgets must each carry a `requiredPermission` (the registry already models this).

**Prerequisites.** Q70 (threshold rule + calendar), Q71/Q3 (retention/erasure), and — for reporting — at
least one upstream module's approved widget (so G partly depends on C/D outputs).

**Reversibility.** Derivations/jobs are additive and reversible; a recorded present/absent/late label is
a durable institutional assertion — low reversibility once written.

---

## GROUP A residue / Q6 — parent messaging & quiet hours

**Current behaviour.** Who-may-message-whom is largely decided and built: staff may start DMs/groups;
**students may DM each other** (`messaging.start_direct_peer`, migration 0018) **and DM an eligible
teacher** (`messaging.start_direct_teacher`, migration 0019, `GET /people/teachers`) — the owner's
2026-10-11 GROUP A ruling. **Parents:** there is no parent participation — the `PARENT` role is *named
but inactive* (`role.ts`; not in `ACTIVE_ROLES`; assigning it fails by test), granted zero permissions,
and there is no parent↔child linkage model (Q10). **Quiet hours:** genuinely absent — notification
preferences are per-category on/off toggles (`{inApp, realtime, push}`) with **no time/schedule
concept**; there is no per-conversation mute.

**Unresolved decision.** (1) May a parent message (a teacher? the institution?) — which requires
activating the PARENT role (deciding what a parent may see) and a parent↔child linkage. (2) Are there
hours during which messaging/notifications are quiet (institution-wide or per-person), and do you want
per-conversation mute? (3) Should a teacher reach only *their own* students (an academic-relationship
scope messaging does not model yet)?

**Recommendation (pending approval).** **Quiet hours / mute:** recommend a **conservative, reversible
default — none enabled by default**, and if the owner wants them, implement as a `PushDelivery` filter +
a per-person schedule preference (additive; in-app history always available, only *push* is deferred
during quiet hours). This is a safe product-policy decision, not institutional. **Parent messaging:**
**cannot be defaulted** — activating PARENT is a safeguarding decision (what a parent may see about a
child) that the owner must make, and it needs a parent↔child data model (Q10). Recommend deferring until
the owner defines the parent relationship and visibility; the smallest safe first step is "a parent may
DM their child's teacher(s)", never broad. **Teacher-own-students scope:** optional tightening; recommend
deferring unless the owner wants it (current `start_direct_teacher` already excludes administrators).

**Alternatives & consequences.** Quiet hours: (a) none (default) — simplest; (b) institution-wide window —
one policy, blunt; (c) per-person schedule — flexible, slightly more UI. Parent: (a) keep inactive —
safest; (b) narrow (parent↔own-child's-teacher) — real value, needs the linkage model + visibility rules;
(c) broad parent access — safeguarding risk, not recommended without explicit rules.

**Security / privacy / authorization / data-model.** Parent access is the highest safeguarding surface
(an adult reaching into a child's communications) — needs the PARENT role activated with an explicit,
minimal permission set and a parent↔child link table. Quiet hours is an additive preference + a delivery
filter (low risk; never blocks in-app history, only push). No existing authorization is broadened by
either unless the owner approves it.

**Prerequisites.** Parent: a parent↔child linkage model + a visibility decision (Q10). Quiet hours: none
(self-contained). Real push for quiet-hours-to-matter is external-gated (Q24 — see Q28 below).

**Reversibility.** Quiet hours/mute: fully reversible (preference + filter). Parent role: reversible in
principle, but once parents hold access and see data it is socially hard to withdraw — decide
conservatively.

---

## Q28 — notification-policy residue

**Current behaviour.** Notifications are implemented and validated (inbox, unread counts, read/mark-all,
per-category preferences, device registration, realtime relay, and the community/live/attendance/messaging
**translators**) — ADR 0024 decided *which* community/live/attendance facts notify and how (Q67 + the P10
scope of Q28). The **push provider is a logging stub** (`LoggingPushProvider` — no FCM/APNs SDK anywhere;
Flutter `UnavailablePushTokenSource`); the provisional lock-screen policy is **content-free** ("رسالة
جديدة"). The academic/assignment/announcement/certificate notification categories exist but are
**reserved-inactive** (nothing creates them).

**Unresolved decision (Q28 residue).** Per-role push defaults; collapsing/grouping of bursts;
large-channel (≈2,000-member) behaviour; a priority/always-deliver tier; whether lock-screen previews may
show sender/message text (vs content-free); parent-of-child notification visibility; guaranteed delivery
(a transactional outbox, ADR 0021 T2); and **which real push provider** the owner will supply.

**Recommendation (pending approval).** Keep the **content-free lock-screen default** (safest for minors)
unless the owner opts into previews. Activate an academic/assignment/certificate notification category
**only when its feature exists** (GROUP C/D) — not before. Collapsing/grouping and per-role defaults are
small, reversible policy choices the owner can make alongside the feature each serves. The **real push
provider is external-resource-gated** — engineering cannot choose it unilaterally (a provider is an
account + a data-processing agreement); the owner must supply a Firebase project and an Apple team.
Guaranteed delivery (outbox) is deferred to P11 and only if a guarantee is required.

**Security / privacy / authorization / data-model.** Lock-screen previews of a child's message are a
safeguarding decision — default off. A notification never grants access (opening one re-runs the owning
module's view check — ADR 0024). Push provider choice carries a data-processing-agreement/privacy
obligation (minors' data leaving the system).

**Prerequisites.** For real sends: owner-provided Firebase/Apple credentials + a device (external). For
academic/assignment/certificate notifications: the GROUP C/D features. None blocks the in-app experience
(already complete).

**Reversibility.** Preview policy = a body-key change (reversible); category activation = a flag
(reversible); provider = the port/adapter seam makes it swappable; outbox = a future additive mechanism.

---

## Recommended owner-decision order (dependency-aware; none approved)

1. **Q6 quiet hours / mute** — smallest, safest, self-contained, fully reversible. Decide first; a clear
   "none / institution-wide / per-person" choice.
2. **GROUP C — learning concepts (assessment / mastery / placement / «ضخ» / certificates)** — highest
   product value (makes the already-built-but-mock progress & certificate screens real) and the biggest
   institutional decision. The owner must *define the concepts*; engineering then builds the additive
   shape. Nothing downstream (reporting widgets, academic notifications) is real until this is decided.
3. **Q6 parent messaging + PARENT role** — safeguarding; needs a parent↔child linkage model and a
   visibility decision (Q10). Independent of C/D but high-care; decide deliberately, start narrow.
4. **GROUP D — assignments** — decide scope; if in scope, sequence *after* GROUP C grading so the grading
   vocabulary is defined once. Greenfield, deferrable.
5. **GROUP G — derived attendance record + operations/reporting/automation** — depends on the Q70
   threshold/calendar rule, Q71/Q3 retention, and (for reporting) at least one upstream widget from C/D/G.
   Decide the attendance-record rule when ready; build reporting only after its first real widget exists.
6. **Q28 residue** — decide alongside the features each notification serves + when the owner supplies a
   real push provider. The content-free default is safe to keep meanwhile.

## Where evidence is insufficient to recommend (missing information, not guessed)

- **The institutional values in GROUP C** (what a grade/mastery/placement/«ضخ»/certificate *means* and who
  decides each) and **GROUP G's present/absent/late thresholds + academic calendar** — these are the
  institution's assertions about real students; engineering must not invent them. Documented as owner
  questions above; the safe interim holds until answered.
- **The PARENT role's permission set and the parent↔child relationship** (Q10) — undefined in source; the
  owner must state what a parent may see before it can be activated.
- **Retention/erasure horizons** (Q3/Q71/Q27) — no policy exists; data is currently kept like the audit log.
- **The push provider + data-residency** (Q24/Q65) — external accounts/agreements only the owner can provide.

---

*Prepared Sprint 33 (2026-10-13). Recommendations pending owner approval. On approval, each area follows
the normal process: an ADR recording the decision, the register entry closed with that ADR number, the
roadmap updated, and only then a scoped implementation. No implementation is authorized by this brief.*
