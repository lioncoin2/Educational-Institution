# 0023 — Attendance authorization uses academic relationship AND community standing; attendance policy answers (Q8, Q12, Q69)

**State: ACCEPTED (2026-10-05) — records the owner's P9 attendance-policy answers and **supersedes in
part** [0020](0020-attendance-snapshots.md) **decision 8** (authorization scope). ADR 0020 otherwise
stands. Every decision here is CURRENT and REVERSIBLE. No code, schema, migration or seed exists or
changes; **P9 implementation remains HELD** on the academic reconciliation (ADR 0015).**

**Status:** Accepted
**Accepted:** 2026-10-05, by the owner (P9 governance pass).
**Date:** 2026-10-05
**Supersedes in part:** [0020](0020-attendance-snapshots.md) decision 8. ADR 0020's decisions 1–7 and
9–11 are unchanged (notifications stay deferred — see decision 2 below).

## Context

ADR 0020 designed attendance snapshots with authorization **"through community standing, never through
`attendance.*`"** and **instead of** `ACADEMIC_RELATIONSHIPS` (decision 8), and delivered **no
notification** (decision 9), leaving Q8, Q12 and Q69 to the institution. The owner has now answered
them (also recorded in `open-questions.md`). Two answers bear on ADR 0020; this ADR records all four.

## Decision (owner, 2026-10-05; reversible)

1. **Q69a — authorization uses BOTH (supersedes ADR 0020 decision 8).** Attendance record/view
   authorization considers **both** the **academic relationship** (`ACADEMIC_RELATIONSHIPS`) **and**
   community standing/membership — complementary, neither replacing the other. This replaces ADR 0020
   decision 8's "community standing *instead of* `ACADEMIC_RELATIONSHIPS`". The §13 Attendance-row
   requirement that attendance scope go through `ACADEMIC_RELATIONSHIPS` is thereby honoured, and the
   Q31 precondition is met by scoping through `ACADEMIC_RELATIONSHIPS` rather than exercising role-wide
   `attendance.*` grants. **The exact combined check (how the academic and community bases compose, and
   the refusal order) is a P9 design task — not designed here.** No code.

2. **Q69b — record/view authority; notifications DEFERRED to P10/Q67.** The owner controls record/view
   grants; teachers record when granted; the owner may grant others. During a live broadcast an
   authorized person's **"Collect Attendance"** action creates the snapshot. **Notifications** to the
   teacher, owner and granted people are a requirement but are **deferred to P10 / Q67**: ADR 0020
   decision 9 ("no notification is delivered; no subscriber is built") **stands for P9**. **No student
   or parent self-view** is authorised.

3. **Q8 — amendment applies to the attendance record, not the snapshot.** A snapshot is immutable (ADR
   0020 decision 7). Who may amend student attendance and the allowed window are owner-controlled; every
   amendment records `reason` and `amendedBy` (already required by `AttendanceAmendment` in
   `operations/contracts`). This is a future attendance-record concern and does not change the immutable
   snapshot.

4. **Q12 — timing.** Student attendance is recorded for **every live broadcast session and every exam**,
   stamped with the **actual date/time** (ADR 0020's `observedAt`/`recordedAt`). The academic
   calendar/term is **not** a prerequisite for recording; no recurrence/term model is introduced here.

## Consequences

- ADR 0020 decision 8 is replaced by decision 1 above; ADR 0020 gains a "superseded in part by 0023"
  status line and a pointer at its decision 8. Everything else in ADR 0020 stands.
- P9's attendance authorization must scope through **`ACADEMIC_RELATIONSHIPS` and
  `COMMUNITY_AUTHORIZATION`** — designed in P9, without exercising unscoped `attendance.*` grants.
- Attendance notifications become a **P10 / Q67** deliverable; P9 builds no subscriber.
- **P9 remains HELD.** This records policy only. The §13 / ADR 0015 structure reconciliation (Tahajji
  §7, the non-core sections, and applying the structure to the seed) is still not landed.

## Alternatives considered

- **Keep ADR 0020 decision 8 (community standing only; academic relationship a separate future
  concept).** Presented to the owner; the owner chose BOTH.
- **Build attendance notifications in P9.** Presented to the owner; the owner deferred them to P10/Q67.
