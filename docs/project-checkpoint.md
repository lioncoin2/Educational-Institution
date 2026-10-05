# Project checkpoint — Educational Institution

**This file is the continuity source.** A fresh Claude Code conversation should read this first (then
the authoritative docs it links) and continue without reconstructing history from chat logs.

- **Branch:** `claude/quranic-education-app-prototype-gkzle8`
- **HEAD:** the latest `docs:` checkpoint commit on this branch (see `git log`); last code commit is
  `9d2925e` ("P8.4 Phase 1: finalize off-box capacity harness"). All checkpoint commits are
  documentation only.
- **Date:** 2026-10-05 (updated with ADR 0023 — attendance policy recorded)
- **Current focus:** Academic Reconciliation / **P9 Attendance governance** (not implementation).
- **Every decision below is CURRENT and REVERSIBLE** — a current institutional decision, not a
  permanent architectural lock. Future requirements may change it.

## Engineering principles (standing)
Clean modular architecture; strict domain/application/infrastructure boundaries; no spaghetti, no hacks
sold as final. File size: 100–300 preferred, 300–500 ok, 500–700 review, >700 decompose, >1000
prohibited unless justified; split by cohesion, not artificially. Tests mandatory; architecture/
dependency checks mandatory. Security and historical-data integrity matter. Document decisions. Never
silently invent institutional rules — record unknowns as deferred. Build toward the final architecture
directly, not throwaway versions.

## Authoritative documents (read these)
- Phase roadmap: `docs/architecture/communities-live-attendance.md` §25 (status + plan tables).
- Open questions (answers recorded inline): `docs/architecture/open-questions.md`.
- Academic reconciliation: `docs/architecture/academic-reconciliation.md` (§13), `docs/owner-information.md`.
- ADRs: `docs/architecture/decisions/` — esp. **0015** (academic structure reconciliation),
  **0016** (Q40 ruling), **0020** (attendance snapshots, HELD).
- P9 owner decision sheet: `docs/p9-attendance-decisions.md`.
- Attendance entry gate: `docs/architecture/attendance.md` §23.

---

## Phase ledger

| Phase | State |
|---|---|
| P0 Corrections & guards · P1 Live hardening · P2 Communities · P3 Delegation · P4 Community chat · P5 Community realtime+Flutter · P5.1 Community management · P6 Community-scoped live sessions | **DONE** |
| P7.1 LiveKit server/provider readiness · P7.2 real media integration · P7.3 staging deploy · P7.4 external client test | **DONE** (staging live) |
| P7b Flutter media binding (`livekit_client`) | **DEFERRED** (needs devices/CI + ADR) |
| P8 Load/capacity harness (P8.0–P8.4 built, committed `9d2925e`) | **DONE (infra)**; off-box ladder S1→R6 **DEFERRED** until real users |
| **Academic reconciliation (§13 / ADR 0015)** | **IN PROGRESS** (this checkpoint) |
| **P9 Attendance** | **BLOCKED / HELD** (gate not cleared) |
| P10 Notifications translators · P11 Horizontal scale · P12 Policy-gated Live features | future (P11 needs P8 evidence) |

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

| # | Official name | Code | Note |
|---|---|---|---|
| 1 | محو الأمية | `dep-literacy` | count 5 → **10** |
| 2 | تلقين الحروف | `dep-letters` | |
| 3 | المبتدئ | `dep-tajweed-1` | same section as the old قسم تجويد مبتدئ |
| 4 | **تجويد الحروف** | **`dep-tajweed-letters`** | **NEW**; owner-approved code |
| 5 | التجويد المتوسط | `dep-tajweed-2` | |
| 6 | التجويد المتقدم | `dep-tajweed-3` | |
| 7 | دورة التهجي وإعداد المعلمات | — | **DEFERRED** (see Tahajji) |

Other owner rulings: every core section has **≥ 10 halaqat** (10 = initial minimum, not a limit, not a
"basic" class); **no Basic/Additional classification** (all halaqat equal); **"need" not used**;
sections and halaqat are **dynamic, owner-managed** (add/edit/delete/rename/reorder); **halaqa codes /
historical identity preserved**; deletion must be historically safe. Academic progression
(assessment → placement → halaqa → mastery → higher progression) and the broader development path
(education→mastery→specialization→training→teacher-preparation→teacher→supervision→leadership) and
«نظام الضخ بين الأقسام» are **institutional concepts only** — **do not** invent promotion criteria,
mastery thresholds, assessment formulas or mandatory sequences.

### Tahajji / City of Tahajji — DEFERRED
- دورة التهجي وإعداد المعلمات is core section #7; مدينة التهجي appears as a specialized branch/structure.
- The **"40 groups" figure is historical/source information only** — not a system limit, not a required
  seeded count, not necessarily the current active count.
- The **owner** determines the actual number of groups and manages them (add/delete/edit/rename);
  **groups are NOT seeded now** (creation deferred).
- The **relationship** between دورة التهجي وإعداد المعلمات and مدينة التهجي (operational structure inside
  §7, an independent branch, or another relationship) is **intentionally deferred** — do not hard-code.
- What a "group" means vs **chat / LiveKit room / educational grouping** is **deferred**; these groups
  are **not** equated with the existing Community / Messaging / Live concepts. (Community membership ≠ a
  temporary LiveKit session; the Live architecture stays separate.)

### Non-core sections — UNRESOLVED (documented)
`sec-kids` (البراعم), `sec-languages` (اللغات), `accompanying` (البرامج المرافقة, incl. مدينة الحفاظ):
the owner addressed only the seven core sections; there is no "core" flag in the domain, so their fate
(kept, reclassified, retired) is **open** and must not be guessed.

---

## Level status: NOT IMPLEMENTED
No `academic_levels` table, no `level_id`, no Level domain/contract/repository/API/Flutter code, no
migration. **No migration or code removal is required.** The only textual trace is the word "levels"
inside two `academic.*` permission *descriptions* in the committed migration
`drizzle/0002_seed_access_catalog.sql:29-30` ("View/Change programs, levels and halaqat") — **cosmetic,
non-structural**; an optional later description fix (a new migration or description update), not done
here and not blocking.

## P9 Attendance status: BLOCKED / HELD
Owner policy answers are **recorded** (in `open-questions.md`; enforcement is P9, not built):
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

**Gate (attendance.md §23) still not cleared.** Q40 answered (ADR 0016); Q8/Q12/Q69 answered & recorded
(ADR 0023). **Remaining blockers:**
1. **§13 / ADR 0015 not fully landed** — the reviewed academic structure is **not applied to the seed**
   (deferred: **Tahajji §7 representation**, **fate of non-core sections**; owner wants nothing seeded
   yet). So the §13 "before any new module" step is not complete and the reconciliation hold is not
   lifted. **This is the P9 blocker.**
2. **Reviewer acceptance** of the final combined attendance-scoping design (Q69a: `ACADEMIC_RELATIONSHIPS`
   + community standing) — a P9 design-review step.

Progress: Q35/Q36 answered; تجويد الحروف = `dep-tajweed-letters`; Level retired; Q8/Q12/Q69a/Q69b
answered **and recorded in ADR 0023**. **Do not implement Attendance** until blocker 1 clears. P9's
authorization must later combine `ACADEMIC_RELATIONSHIPS` + `COMMUNITY_AUTHORIZATION` without exercising
unscoped `attendance.*` grants (ADR 0023, decision 1 — design task, not done).

## Academic Reconciliation status: IN PROGRESS (NOT complete)
- **Resolved:** Q35/Q36 recorded (ADR 0015); تجويد الحروف = `dep-tajweed-letters`; Level retired
  (hierarchy stays Section→Program→Halaqa).
- **Deferred:** Tahajji §7 / City-of-Tahajji relationship; non-core sections fate; applying the reviewed
  structure to the seed + pinned tests (owner wants nothing seeded yet).
- Do **not** claim reconciliation complete until the seed is reconciled and verified.

## P8 capacity status: DEFERRED
Off-box ladder (S1/S2/R1…R6) deferred until real users enter the app. Targets (**not proven**):
≈3,000 listeners/room, ≈10,000 concurrent participants across rooms. Do not reopen P8.4 S1/S2 unless
explicitly requested. (`docs/p8/*`, `docs/p8-load-capacity-plan.md`.)

---

## Deferred / open questions (do not guess)
- Tahajji §7 ↔ مدينة التهجي relationship; actual Tahajji group count/creation.
- Fate of non-core sections (البراعم / اللغات / accompanying).
- "Group" semantics vs chat / LiveKit / educational grouping.
- Mastery / promotion / assessment / «نظام الضخ» operational rules.
- Reviewer acceptance of the combined attendance-scoping design (Q69a, ADR 0023).
- Applying the academic structure to the seed (renames, literacy 5→10, new section) + pinned tests.
- Attendance "Collect Attendance" notifications → P10 / Q67 (deferred, ADR 0023).

## NEXT (exact step)
Attendance policy is recorded (ADR 0023). The **one remaining governance blocker** for P9 is the
academic reconciliation (§13 / ADR 0015): the owner must decide the **Tahajji §7 representation** and
the **fate of the non-core sections**, so ADR 0015's structure can be applied to the seed and the §13
"before any new module" step completes. Those two are **owner-deferred**, so the next action is to put
exactly those two questions to the owner (do not guess, do not seed). Only after §13 / ADR 0015 fully
lands — plus reviewer acceptance of the Q69a combined scoping — does P9 leave HELD. No implementation,
no seed run, before then.

> Reminder: everything in this checkpoint is a current, reversible decision.
