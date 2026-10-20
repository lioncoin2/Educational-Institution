# Scheduling decision brief — one-off dated academic lessons

> **Resolved & implemented (2026-10-20).** The owner approved D1–D5 below, and scheduling of individual
> dated lessons is now built end-to-end — see [ADR 0042](architecture/decisions/0042-operations-scheduled-lessons.md)
> and register §27. This brief is kept as the decision record; the recommendations it labelled "pending"
> are the ones the owner accepted. Still **not** built (separate future decisions): a scheduling horizon,
> conflict detection, teacher authorship, notifications on scheduling.

**Purpose.** Prepare the owner's scheduling decisions for resolution *before* any build. This brief
separates what the owner has **already settled** from what is **still open**, and for each open point
gives clear options, their security/architecture implications, and an **engineering recommendation**
(labelled — **not** adopted as an owner decision). It invents no policy, writes no scheduling code, and
changes no contract, schema or migration.

**Compiled** 2026-10-19 from source at HEAD `9b4a6de` (branch `claude/trial-integration-sprints-52-61`),
read-only. Authorities: register [§24](owner-decision-register.md) (scheduling), [§21](owner-decision-register.md)
+ [ADR 0036](architecture/decisions/0036-quiet-hours-and-conversation-mute.md) (institution timezone /
quiet-hours mechanism), open-questions [Q12](architecture/open-questions.md) (timezone & calendar),
[Q70–Q72](architecture/open-questions.md) (attendance record — kept separate), and the scheduling/timezone
code already in the tree. This brief **does not reopen any already-settled decision.**

---

## A. Already settled (do NOT re-decide)

| # | Settled decision | Reference |
| --- | --- | --- |
| S1 | **One-off (individual) dated lessons only. NO recurring scheduling.** | register §24; roadmap domain 2 / §3d; Q12 ("no recurrence model exists yet") |
| S2 | **The institution timezone is an explicit, persisted IANA zone id.** Fixed offsets (`+03:00`, `Z`) are rejected. Reuses the existing `isValidTimezone()` and the `institution_notification_settings` IANA rule. | register §24; ADR 0036; `backend/src/modules/notifications/domain/quiet-hours.ts` |
| S3 | **Scheduling is independent of attendance and of live connectivity.** It derives no present/absent/late record and does not fill `Halaqa.attendedSessions`; Q70/Q71/Q72 stay untouched. | register §24; ADR 0020 dec 3 / ADR 0023 |
| S4 | **Platform time invariants (reusable, not new decisions):** all timestamps are `timestamptz`; `Clock` is injected everywhere (never `new Date()`); IANA/DST are resolved wall-clock-correct via the built-in `Intl` at evaluation time (`minutesOfDayInZone` pattern). | Q12 ("Built instead"); `quiet-hours.ts` (`minutesOfDayInZone`, `isValidTimezone`) |
| S5 | **No quiet-hours UI or behaviour** — rejected. Scheduling must **not** ride the `notifications/institution-settings` (quiet-hours) resource to read/write the timezone. | roadmap §4/§8; register §25 (D-7 withdrawn) |

**Also fixed by the existing architecture (constraints any build must honour):** the system is
**single-institution** (no tenant/`institutionId` column — register §14); modules talk only through
`contracts/` (dependency-cruiser `no-cross-module-internals`); the `operations` module is the designated
home for "scheduled sessions and scheduling" (its own contract docblock) and currently mounts **zero
routes**; the permissions catalogue has **no** scheduling permission today, and its header notes
"`attendance.*` will be enforced by Operations" (a future intent, nothing built).

---

## B. Open decisions — options, implications, engineering recommendation

> Each recommendation is an **engineering** proposal for the owner to accept, change, or reject. None is
> adopted. "Reversibility" notes how costly a later change is (widening a permission or adding a field is
> cheap; relabelling an institutional assertion, or narrowing after data exists, is not).

### D1 — Who may create / edit / cancel a lesson? (§24: "permissions NOT approved")

| Option | What it means | Implications |
| --- | --- | --- |
| **(a)** reuse `academic.manage` (OWNER/ADMIN) | Lessons are academic-structure administration | No new permission, no grant migration; consistent with sections/programs/halaqat admin (ADR 0014/0032). Couples scheduling authority to academic admin; teachers cannot author lessons. |
| **(b)** new `operations.schedule.manage` (OWNER/ADMIN) | A dedicated scheduling permission in the module that owns scheduling | Matches the module boundary and the permissions header intent; delegable later. Cost: one **data-only** seed migration + role-matrix grant + the matrix↔seed drift-test update (standard recipe). |
| **(c)** split authorship (admin create/cancel; teacher edits own-halaqa lessons) | Teachers schedule within their own halaqat | **Re-opens Q31** (which halaqat, current vs former students/assignments) — a GROUP A policy area; larger surface, higher risk. |

**Engineering recommendation:** **(b)** — a new coarse `operations.schedule.manage` granted to OWNER/ADMIN
only. It respects the module boundary (operations owns scheduling), avoids overloading `academic.manage`,
and is cheaply widened to teachers later (reversible). Teacher authorship (c) is deferred so Q31 stays
untouched. *Owner question:* who may create/edit/cancel a lesson — admins only, or also a halaqa's teacher?

### D2 — How is a one-off dated lesson stored? (§24: "how the instant is stored, per-lesson snapshots, local fields")

| Option | What it means | Implications |
| --- | --- | --- |
| **(a)** local wall-clock + IANA zone | Store `starts_at_local` + `zone`; derive the instant via `Intl` at read | DST-safe ("5pm stays 5pm"); matches Q12's reasoning and the quiet-hours pattern. Range queries/ordering need derivation each read. |
| **(b)** UTC `timestamptz` instant only | Store one instant | Simplest; correct for a single fixed instant. If a zone's DST rules change between scheduling and the date, the wall-clock drifts — Q12 explicitly warns against this for wall-clock policies. |
| **(c)** both: local wall-clock + per-lesson zone snapshot **and** a derived `timestamptz` instant | Authoritative local+zone, plus a stored instant for ordering/queries | Most faithful to S4; the derived instant makes range queries cheap; the zone snapshot (below) makes existing lessons stable under an institution-zone change. Slightly more to keep consistent. |

**Engineering recommendation:** **(c)** — store the chosen local wall-clock, a **per-lesson IANA zone
snapshotted at creation** (defaulting to the institution zone), and a derived UTC `timestamptz` instant.
Snapshotting the zone per lesson means a later change to the institution timezone leaves already-scheduled
lessons exactly where the owner put them. *Owner sub-question:* when the institution timezone changes
later, should existing lessons keep the zone they were created with (**recommended**) or move to the new
institution zone?

### D3 — IANA timezone & DST handling (§24: "any other timezone decisions … DST handling")

The *mechanism* is already settled (S2/S4: IANA-only via `isValidTimezone`; DST-correct via `Intl`). Two
sub-decisions remain and are genuinely new:

- **(i) A lesson's zone source.** The institution zone (snapshotted — see D2), or may a lesson carry its
  own zone? **Recommendation:** institution zone, snapshotted per lesson (single-institution system);
  allow a per-lesson override only if the owner runs lessons in more than one zone.
- **(ii) DST-invalid / ambiguous local times.** A one-off lesson at, say, 02:30 on a spring-forward night
  **does not exist**; on a fall-back night a local time **exists twice**. A rule is required.
  **Recommendation:** **reject** a non-existent local time at validation (an explicit `validation`
  failure — consistent with the project's "no silent default"); for an ambiguous (doubled) time, resolve
  to the **earlier** occurrence by a documented rule. This is a small but real new decision.

**Security/architecture:** none beyond correctness; no new dependency.

### D4 — Time validation & conflict rules (§24: "validation rules for the time and conflicts")

| Option | What it means | Implications |
| --- | --- | --- |
| **(a)** shape validation only | Valid IANA zone, well-formed datetime, DST-existent, (optionally) not past-dated. No conflict policy — lessons may overlap. | Invents **no** institutional policy; additive; v1-safe. |
| **(b)** hard conflict rule | No two lessons overlap for the same scope (halaqa? teacher? room?) | **Requires the owner to define "conflict"** (the scope key) — that is an institutional policy and **must not be invented**. "Room" doesn't exist in the model. Couples to roster/assignment scope. |
| **(c)** soft conflict warning | Surface overlaps, allow override | Still needs the "conflict" definition for the scope key; UI-only mitigation of (b). |

**Engineering recommendation:** ship **(a) shape validation only** in v1 — it invents nothing. Treat
**conflict detection as a separate, later owner decision** (the owner must first define what a conflict
is and over which scope). *Owner sub-question (small):* may a lesson be scheduled for a **past** date
(backfill) or only today/future? **Recommendation:** reject past-dated by default (easily relaxed later).

### D5 — Scope & side-effects of a lesson (shape questions that gate the build)

Not called out in §24 by name, but a build cannot start without them, and each must avoid inventing policy:

- **What a lesson references.** Recommendation: a **halaqa** (academic), optionally a **community**, by
  **opaque id**, with existence validated through the public `academic`/`communities` contracts (the same
  boundary-legal pattern as the Q50 halaqa link, ADR 0033) — never a foreign key into another module.
- **Notifications.** Recommendation: **no notification in v1** — a "lesson scheduled" notice would touch
  the still-open Q28 large-channel/notification policy. Add it only under a separate decision.
- **Attendance / live-session coupling.** Recommendation: **none** — scheduling neither starts a live
  session nor creates an attendance record (S3; ADR 0020 dec 3). A lesson is a plan, not an event.

---

## C. What this brief does NOT do

- It writes **no scheduling code**, adds **no** permission/table/migration, and changes **no** contract or
  policy. Everything above is a proposal pending the owner's decisions D1–D5.
- It does **not** touch quiet hours (rejected, S5), attendance derivation (Q70), assignments (GROUP D),
  or automation (Q71/Q3).
- It does **not** re-open S1–S5 or any settled decision.

**When the owner answers D1–D5**, the build is a single additive vertical slice: an `operations`
scheduling table + one migration, the chosen permission, HTTP routes, a Flutter surface, and tests —
anchored on the already-confirmed institution IANA timezone, inventing no attendance policy.
