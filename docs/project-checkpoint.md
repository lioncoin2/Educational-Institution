# Project checkpoint — Educational Institution

**This file is the continuity source.** A fresh Claude Code conversation should read this first (then
the authoritative docs it links) and continue without reconstructing history from chat logs.

- **Branch:** `claude/quranic-education-app-prototype-gkzle8`
- **HEAD:** the attendance module boundary-guards commit on this branch (see `git log`),
  `test(attendance): add module boundary guards`. The P9 Attendance **backend** is built through the
  RecordSnapshot write and view paths and is now architecture-boundary-hardened; earlier lineage:
  Academic Reconciliation (ADR 0015, Option A) and the prior code commit `9d2925e`.
- **Date:** 2026-10-06 (updated: P9 Attendance backend — write, view and boundary guards — LANDED)
- **Current focus:** **P9 Attendance** — backend write + view + architecture boundary hardening are
  complete; Flutter Attendance and the EXPLAIN-at-scale check remain deferred.
- **Every decision below is CURRENT and REVERSIBLE** — a current institutional decision, not a
  permanent architectural lock. Future requirements may change it.

## Engineering principles (standing)

**Mandatory: every implementation task MUST read and obey
[`docs/ENGINEERING_RULES.md`](ENGINEERING_RULES.md) before writing any code.**
That document is the permanent, project-wide engineering governance (clean/modular
architecture, responsibility ownership, SRP, dependency direction, module
boundaries, contract-first and vertical-slice development, test strategy and
non-vacuous architecture tests, authorization ownership, error taxonomy,
database/migration discipline, security, observability, performance, ADR
discipline, and the Definition of Done). It is authoritative; this checkpoint's
reversible decisions never override it.

Every task follows the required workflow:
**INSPECT → UNDERSTAND ARCHITECTURE → IDENTIFY RESPONSIBILITY OWNER → IDENTIFY
DEPENDENCY BOUNDARIES → PLAN FILES → DEFINE CONTRACTS → DEFINE TESTS → IMPLEMENT →
VERIFY → REVIEW DIFF → UPDATE DOCS/ADR IF REQUIRED → COMMIT.** No step is skipped;
real conflicts are surfaced and resolved explicitly, never guessed or silently
patched.

The digest (full rules in `ENGINEERING_RULES.md`): clean modular architecture;
strict domain/application/infrastructure boundaries; no spaghetti, no hacks sold
as final. File size: 100–300 preferred, 300–500 ok, 500–700 review, >700
decompose, >1000 prohibited unless justified; split by cohesion, not artificially.
Tests mandatory; architecture/dependency checks mandatory. Security and
historical-data integrity matter. Document decisions. Never silently invent
institutional rules — record unknowns as deferred. Build toward the final
architecture directly, not throwaway versions.

## Authoritative documents (read these)

- **Engineering governance (read first, obey always): [`docs/ENGINEERING_RULES.md`](ENGINEERING_RULES.md)** — the permanent rules and the required implementation workflow for every task.
- Phase roadmap: `docs/architecture/communities-live-attendance.md` §25 (status + plan tables).
- Open questions (answers recorded inline): `docs/architecture/open-questions.md`.
- Academic reconciliation: `docs/architecture/academic-reconciliation.md` (§13), `docs/owner-information.md`.
- ADRs: `docs/architecture/decisions/` — esp. **0015** (academic structure reconciliation),
  **0016** (Q40 ruling), **0020** (attendance snapshots, HELD).
- P9 owner decision sheet: `docs/p9-attendance-decisions.md`.
- Attendance entry gate: `docs/architecture/attendance.md` §23.

---

## Phase ledger

| Phase                                                                                                                                                                                            | State                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 Corrections & guards · P1 Live hardening · P2 Communities · P3 Delegation · P4 Community chat · P5 Community realtime+Flutter · P5.1 Community management · P6 Community-scoped live sessions | **DONE**                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P7.1 LiveKit server/provider readiness · P7.2 real media integration · P7.3 staging deploy · P7.4 external client test                                                                           | **DONE** (staging live)                                                                                                                                                                                                                                                                                                                                                                                                      |
| P7b Flutter media binding (`livekit_client`)                                                                                                                                                     | **DEFERRED** (needs devices/CI + ADR)                                                                                                                                                                                                                                                                                                                                                                                        |
| P8 Load/capacity harness (P8.0–P8.4 built, committed `9d2925e`)                                                                                                                                  | **DONE (infra)**; off-box ladder S1→R6 **DEFERRED** until real users                                                                                                                                                                                                                                                                                                                                                         |
| **Academic reconciliation (§13 / ADR 0015)**                                                                                                                                                     | **LANDED** on the operational seed + tests (Option A, 2026-10-05); printed profile untouched; verified in-memory only                                                                                                                                                                                                                                                                                                        |
| **P9 Attendance**                                                                                                                                                                                | **BACKEND LANDED** — RecordSnapshot write + VIEW (community list / one snapshot / participants), `AttendanceAccess`, `LIVE_PRESENCE`, Postgres + in-memory repositories, DI/boot wiring, the API, full error-coverage E2E, and the `attendance-boundaries` architecture guards. **DEFERRED:** Flutter Attendance (§17), the EXPLAIN-at-scale check (§21/§22), P10 notifications (Q67), the ADR 0023 Option-B formal write-up |
| P10 Notifications translators · P11 Horizontal scale · P12 Policy-gated Live features                                                                                                            | future (P11 needs P8 evidence)                                                                                                                                                                                                                                                                                                                                                                                               |

---

## Academic structure — CURRENT DECISIONS (reversible)

**Hierarchy: `Section → Program → Halaqa`.** Program is a first-class entity and is **kept** (not
removed, not renamed).

**Level: RETIRED / SUPERSEDED.** A `Section → Program → Level → Halaqa` model was considered in a
read-only design pass and then **rejected by the owner** (complexity without sufficient value). All
prior Level sub-decisions (first-class entity, `academic_levels`, Program→Level→Halaqa, moving a halaqa
between levels, level delete/disable rules, level ordering/owner-management) are **REVOKED**. See
"Level status" below for the (nil) code impact.

**Seven official core sections** (names are the official names; printed «قسم …» names not preserved;
order 1–7 is **display only**, not a study sequence):

| #   | Official name               | Code                      | Note                                    |
| --- | --------------------------- | ------------------------- | --------------------------------------- |
| 1   | محو الأمية                  | `dep-literacy`            | count 5 → **10**                        |
| 2   | تلقين الحروف                | `dep-letters`             |                                         |
| 3   | المبتدئ                     | `dep-tajweed-1`           | same section as the old قسم تجويد مبتدئ |
| 4   | **تجويد الحروف**            | **`dep-tajweed-letters`** | **NEW**; owner-approved code            |
| 5   | التجويد المتوسط             | `dep-tajweed-2`           |                                         |
| 6   | التجويد المتقدم             | `dep-tajweed-3`           |                                         |
| 7   | دورة التهجي وإعداد المعلمات | `dep-tahajji` (proposed)  | uniform model; see Tahajji              |

Other owner rulings: every core section has **≥ 10 halaqat** (10 = initial minimum, not a limit, not a
"basic" class); **no Basic/Additional classification** (all halaqat equal); **"need" not used**;
sections and halaqat are **dynamic, owner-managed** (add/edit/delete/rename/reorder); **halaqa codes /
historical identity preserved**; deletion must be historically safe. Academic progression
(assessment → placement → halaqa → mastery → higher progression) and the broader development path
(education→mastery→specialization→training→teacher-preparation→teacher→supervision→leadership) and
«نظام الضخ بين الأقسام» are **institutional concepts only** — **do not** invent promotion criteria,
mastery thresholds, assessment formulas or mandatory sequences.

### Tahajji / City of Tahajji — RESOLVED (uniform model)

- دورة التهجي / مدينة التهجي use the **same academic model `Section → Program → Halaqa`** — no special
  entity, no hard-coded count, no fixed 40. A Tahajji "group" is an **academic halaqa** under this model
  (not a chat / LiveKit / Community construct).
- دورة التهجي وإعداد المعلمات = core section **#7** (proposed code `dep-tahajji`, reversible); its
  programs/halaqat are **dynamic, owner-managed**; **nothing seeded now** beyond the reconciliation.
- The existing `sec-spelling` (قسم التهجي) is left as **dynamic owner data** (not asserted to be the
  same section as #7). The separate voice/LiveKit-mapping question stays deferred; the Live architecture
  stays separate.

### Non-core sections — RESOLVED (dynamic owner data)

`sec-kids` (البراعم), `sec-languages` (اللغات), `accompanying` (البرامج المرافقة, incl. مدينة الحفاظ) are
**dynamic, owner-managed data — not architectural decisions** (owner, 2026-10-05). They are **kept**; no
"core" flag; the owner manages them at runtime. Not a question to re-open.

---

## Level status: NOT IMPLEMENTED

No `academic_levels` table, no `level_id`, no Level domain/contract/repository/API/Flutter code, no
migration. **No migration or code removal is required.** The only textual trace is the word "levels"
inside two `academic.*` permission _descriptions_ in the committed migration
`drizzle/0002_seed_access_catalog.sql:29-30` ("View/Change programs, levels and halaqat") — **cosmetic,
non-structural**; an optional later description fix (a new migration or description update), not done
here and not blocking.

## P9 Attendance status: BACKEND LANDED (write + view + boundary hardening)

Owner policy answers are **recorded** (in `open-questions.md`; enforced by the landed P9 backend):

- **Q8** — owner controls who may amend student attendance + the window; every amendment records
  `reason` + `amendedBy` (already required by `AttendanceAmendment` in `operations/contracts`).
- **Q12** — attendance recorded for every live broadcast session and every exam; actual date/time;
  academic calendar/term **not** a prerequisite.
- **Q69a** — authority considers **BOTH** academic relationship **AND** community standing/membership
  (complementary).
- **Q69b** — owner controls record/view grants; teachers record when granted; a "Collect Attendance"
  action during a broadcast creates the snapshot and notifies teacher/owner/granted; **no student or
  parent self-view**.

Attendance policy is now **recorded in [ADR 0023](architecture/decisions/0023-attendance-authorization-and-policy.md)**
(2026-10-05): **Q69a** → authorization uses **both `ACADEMIC_RELATIONSHIPS` and community standing**
(supersedes ADR 0020 decision 8); **Q69b** → the "Collect Attendance" **notifications are deferred to
P10 / Q67** (ADR 0020 decision 9 "no notification" stands for P9); **Q8** → amendment applies to the
future attendance record, not the immutable snapshot; **Q12** → every live session + every exam, actual
date/time, no calendar prerequisite.

**Gate (attendance.md §23): all governance decisions MADE.** Q40 answered (ADR 0016); Q8/Q12/Q69
answered & recorded (ADR 0023); Q35/Q36 + Tahajji + non-core + uniform model all decided (ADR 0015).

1. ✅ **§13 academic-structure reconciliation applied to the seed + tests** (ADR 0015, Option A,
   2026-10-05) — DONE and verified in-memory; the §13 "before any new module" step is complete.
2. ✅ **Owner lifted the attendance hold and started P9** (2026-10-05), choosing **Option B** for the
   Q69a composition: the academic relationship is an _additional_ layer, **conditional on an
   established academic↔community link**; while no such link exists (Q50 OPEN, untouched) community
   standing governs and its absence never fails authorization. (The formal ADR 0023 Option-B write-up
   is a deferred, not-yet-done step.)

### P9 implementation — backend landed

**Prerequisite (2026-10-05):** the two Communities attendance acts
`community.attendance.record` / `community.attendance.view` are **active** — in
`COMMUNITY_CAPABILITIES`, with act-rules/ceilings (`communities.moderate`, **no `attendance.*`**,
gate `always`, no oversight) and the CHECK migration `drizzle/0014_community_attendance_acts.sql`.

**Built and committed (the attendance module, backend):**

- `AttendanceAccess` (attendance.md §11.3 — community standing via `COMMUNITY_AUTHORIZATION`; Option B
  keeps any academic layer conditional on a community↔halaqa link, of which there is none, so community
  standing governs; Q50 untouched).
- The pure snapshot domain (`takeSnapshot`, immutable, append-only) and `LIVE_PRESENCE` observation.
- RecordSnapshot **write** path: application use case (idempotency, rate limit, audit-then-event),
  Postgres + in-memory repositories (migration `drizzle/0015`), DI/boot wiring, the
  `POST /attendance/live-sessions/:id/snapshots` route, and full error-coverage E2E (201/200/400/401/
  403/404/412/422/429/503).
- RecordSnapshot **view** path: the three GET routes (community list, one snapshot, participants),
  keyset pagination with `attendance.cursor_invalid` → 422, the read-only `recordedOrHostedInSession`
  fallback read, and name resolution via `ACCOUNT_DIRECTORY`.
- **Architecture boundary guards:** `test/architecture/attendance-boundaries.spec.ts` (§22) — layers,
  domain purity, vendor/LiveKit confinement, contracts-only cross-module access, the `LIVE_PRESENCE`
  allow-list, no `COMMUNITY_MEMBERSHIP`/`COMMUNITY_CAPABILITY_HOLDERS` injection, no reserved
  `attendance.read`/`.manage`, own-schema-only — each guard non-vacuous. Attendance's schema joins the
  shared `OTHER_SCHEMAS` list. All green; **no boundary violation was found** in the shipped module.

All backend work was verified on isolated/in-memory or ephemeral-Postgres harnesses only — no
production/shared DB seeded or migrated.

**Deferred (not built, by decision):** Flutter `AttendanceRepository` (attendance.md §17); the
EXPLAIN-at-scale / 1M-entry read benchmark (§21/§22 — measure before production use); P10 notifications
translator (Q67); the formal ADR 0023 Option-B write-up (a documentation task; ADRs are immutable and
superseded, never edited).

Progress: Q35/Q36, تجويد الحروف=`dep-tajweed-letters`, Level retired, Q8/Q12/Q69 (ADR 0023), Tahajji §7
uniform (`dep-tahajji`), non-core = dynamic owner data, seed reconciliation LANDED, Communities
attendance-act enablement LANDED, **P9 Attendance backend (write + view + boundary hardening) LANDED**.

## Academic Reconciliation status: LANDED (operational seed + tests, Option A)

- **All decisions made:** Q35/Q36 (ADR 0015); تجويد الحروف=`dep-tajweed-letters`; Level retired
  (Section→Program→Halaqa); Tahajji §7 uniform (`dep-tahajji`); non-core = dynamic owner data; one
  uniform model, dynamic & owner-managed, no hard-coded counts.
- **Applied (2026-10-05) — Option A (split sources):**
  - **Printed Profile stays separate and untouched:** `institution-structure.json`/`.ts` and the Flutter
    `ProfileData` are unchanged; `app/test/academic/profile_structure_test.dart` still passes unchanged.
  - **Operational Academic Structure is now the seed's source:** new `operational-structure.json` +
    `operational-structure.ts` (11 sections / 11 programs / 70 halaqat — 10 per core program); the seed
    use case reads it, not the printed profile.
  - **Provenance profile/owner applied:** each entry marked `owner` (ADR 0015) or `profile` (page),
    threaded into audit metadata; the seed's parent/integrity check (`validateOperationalStructure`)
    and explicit per-entry halaqa codes (`<section>-h<n>`) are enforced.
  - **Tests + gates green:** academic suite 101/101, architecture 141/141, Flutter profile test 4/4;
    format/lint/typecheck clean.
  - **No seed run against production/shared DB:** verified on the in-memory harness only (H1 honored).
- Reconciliation at the seed + test layer is **complete and verified**. Deploying it to a real DB via
  the explicit seed command is a separate operational step, intentionally not done here.

## P8 capacity status: DEFERRED

Off-box ladder (S1/S2/R1…R6) deferred until real users enter the app. Targets (**not proven**):
≈3,000 listeners/room, ≈10,000 concurrent participants across rooms. Do not reopen P8.4 S1/S2 unless
explicitly requested. (`docs/p8/*`, `docs/p8-load-capacity-plan.md`.)

---

## Deferred / open questions (do not guess)

- Voice/LiveKit mapping of educational groups (separate from the academic model).
- Mastery / promotion / assessment / «نظام الضخ» operational rules.
- Reviewer acceptance of the combined attendance-scoping design (Q69a, ADR 0023).
- Attendance "Collect Attendance" notifications → P10 / Q67 (deferred, ADR 0023).
- Concrete per-section/per-halaqa seed content beyond the firmly-decided renames/new sections — these
  are **dynamic owner data** managed at runtime, not architectural questions (do not re-open).

## NEXT (exact step)

The **P9 Attendance backend** is complete and architecture-boundary-hardened: the RecordSnapshot write
and view paths, `AttendanceAccess`, `LIVE_PRESENCE`, the Postgres + in-memory repositories, the API with
full error-coverage E2E, and the `attendance-boundaries` guards — all committed, all gates green, and
**no boundary violation found** in the shipped module.

The remaining P9 item is the **Flutter `AttendanceRepository`** (attendance.md §17): HTTP + mock
implementations, bound only in `app_providers.dart`, with no media/LiveKit (the `LiveMediaClient`
seam stays Unavailable, per P7b). It is **deferred** and not to be started without an explicit request
(the standing Flutter exclusion stands). Also deferred: the EXPLAIN-at-scale read benchmark
(§21/§22, measure before production use), P10 notifications (Q67), and the ADR 0023 Option-B
write-up. **No new implementation beyond an explicitly requested focused slice.**

> Reminder: everything in this checkpoint is a current, reversible decision.
