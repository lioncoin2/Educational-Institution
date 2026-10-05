# 0015 — Academic structure reconciliation: the owner's section/halaqa answers (Q35/Q36)

**State: ACCEPTED (2026-10-05) — records the owner's answers to Q35 and Q36, and the later clarifications
of the same day. It supersedes in part [0014](0014-academic-core-v1.md): the specific section *names*
and the literacy halaqa *count* the owner's answers change. The hierarchy stays **Section → Program →
Halaqa** (the `Level` concept that was briefly considered is RETIRED — see Decided items). Application
of the reviewed structure to the seed is DEFERRED — two items remain underspecified (below), the owner
wants nothing seeded yet, and a partial structure would assert facts the owner did not state.
`institution-structure.json`, the seed code and the pinned tests are therefore UNCHANGED by this ADR.
Every decision here is a CURRENT, REVERSIBLE institutional decision, not a permanent architectural
lock.**

**Status:** Accepted
**Accepted:** 2026-10-05, by the owner (the Q35/Q36 answers and same-day clarifications of the P9 governance pass).
**Date:** 2026-10-05
**Reserved for this by:** `academic-reconciliation.md:410,490,506`; `communities-live-attendance.md:134,1782`.

## Context

`academic-reconciliation.md §13` requires, before any new module, written answers to **Q35** (the seven
core sections vs the printed profile) and **Q36** (Tahajji), then one reviewed change recorded as this
ADR: each code→name decision, seed provenance, a seed parent check, explicit per-entry halaqa codes,
applied through the seed/API, with the pinned tests updated. The seed today is the printed profile
(`institution-structure.json`: 9 sections, provenance `docs/institution-profile.pdf`). The owner's
statements are in `owner-information.md` (S1, S2); the matching questions in `open-questions.md`
(Q35, Q36). Codes and parents are immutable in the domain (`domain/structure.ts:59`); a rename changes
only `name` (`applyChange`). There is no `Level` field and no "core" flag in the domain.

## Decision

### Q35 — section mapping and names (owner, 2026-10-05)

The owner's seven **core** section names are authoritative, and are the **official** names (the printed
"قسم …" wording is not preserved as an official name). Mapping of the five that correspond to existing
seeded sections (**codes preserved — historical identity is never reused or deleted**):

| # | Official name (owner) | Existing code (kept) | Printed name (superseded) |
|---|---|---|---|
| 1 | محو الأمية | `dep-literacy` | قسم محو الأمية |
| 2 | تلقين الحروف | `dep-letters` | قسم تلقين الحروف |
| 3 | المبتدئ | `dep-tajweed-1` | قسم تجويد مبتدئ (owner S-decision item 2: same section) |
| 5 | التجويد المتوسط | `dep-tajweed-2` | قسم تجويد متوسط |
| 6 | التجويد المتقدم | `dep-tajweed-3` | قسم تجويد متقدم |

Further owner rulings: every core section has **≥ 10 halaqat, 10 being the initial minimum, not a
"basic" class** (so محو الأمية moves from the printed 5 to 10); there is **no Basic/Additional
classification** (all halaqat equal); **"need" is not defined and not used**; **section order 1–7 is
display data only**, not a mandatory study sequence; sections and halaqat are **dynamic data** the
owner manages (add/edit/delete/rename/reorder), and a halaqa deletion must be safe where historical
records exist.

### Q36 — Tahajji (owner, 2026-10-05)

The operational structure of دورة التهجي وإعداد المعلمات / مدينة التهجي / its groups is **dynamic and
owner-managed**; it is **not** to be hard-coded, and no additional institutional semantics beyond the
owner's words are to be invented. Historical identifiers are preserved, never destroyed or reused.
Later same-day clarifications: the **"40 groups" figure is historical/source information only** — not a
system limit, not a required seeded count, not necessarily the current active count; the **owner**
determines the actual number; groups are **not seeded now** (creation deferred); the owner
adds/edits/deletes/renames/manages groups. The relationship between دورة التهجي وإعداد المعلمات and
مدينة التهجي (operational structure inside section #7, an independent branch, or another relationship)
is **intentionally DEFERRED** — not modelled here. What a "group" means relative to chat / LiveKit /
educational grouping is also **DEFERRED**; these Tahajji groups are **not** equated with the existing
Community/Messaging/Live concepts unless the owner later decides so.

### Decided since (owner, 2026-10-05, later messages) — reversible

- **New section «تجويد الحروف» (position 4): code = `dep-tajweed-letters`** (owner-approved). Rationale:
  consistent with the `dep-*` family, descriptive, avoids a misleading numeric suffix (`dep-tajweed-4`),
  and does not tie the identifier to display order. Count: ≥ 10 halaqat (10 initial minimum). Not yet
  seeded (seed application deferred, below).
- **«Level» is RETIRED.** A `Section → Program → Level → Halaqa` model was briefly considered; the owner
  rejected it as adding complexity without sufficient value. The hierarchy is **Section → Program →
  Halaqa**. **Program is kept** (first-class, not removed, not renamed to Level). No `academic_levels`
  table, `level_id`, Level domain/contract/repository code, Level ordering, or Level
  movement/deletion rules exist or are to be built. (The only textual trace is the word "levels" inside
  two `academic.*` permission *descriptions* in the committed migration `drizzle/0002_seed_access_catalog.sql:29-30`
  — cosmetic, non-structural; an optional later description fix, not a migration this ADR makes.)

### Still deferred — blocks applying the structure to the seed

1. **دورة التهجي وإعداد المعلمات as core section #7 (Q35) vs dynamic/deferred (Q36):** the existing
   `sec-spelling` is `SPECIAL` (kind immutable); section #7's seed representation and its مدينة التهجي
   relationship are intentionally deferred (above). Not reconciled into a fixed seed.
2. **The non-core sections** (`sec-kids` البراعم, `sec-languages` اللغات, `accompanying`): the owner
   addressed only the seven core sections; there is no "core" flag in the domain, and removing or
   reclassifying these would assert a fact the owner did not state.

Because section #7 is deferred and the owner wants nothing seeded yet, §13 step 3's remaining mechanics
— applying the renames/count/new section through the seed/API, explicit per-entry halaqa codes, the
seed parent check, provenance marking, and updating the pinned tests (`seed.spec.ts`,
`structure.spec.ts`, `app/test/academic/profile_structure_test.dart`) — are **not performed** here.

## Consequences

- The owner's Q35/Q36 answers are now on record (this ADR; `open-questions.md`), satisfying §13's
  "written answers to Q35 and Q36" sub-step.
- **§13 is NOT complete:** ADR 0015 records the decisions but does **not** land the applied structure,
  so the "before any new module" step is not finished and the Attendance hold (`:19-21`) is not lifted.
- No code, schema, migration, seed data, Flutter screen or test changed. `institution-structure.json`
  still carries the printed profile and its "do not edit until answered" notice stands for the
  deferred parts.
- `AttendanceAmendment` (`operations/contracts`) already requires `reason`+`amendedBy` (Q8's technical
  position); unchanged.

## Alternatives considered

- **Apply the five renames + the literacy count + the new section now, leaving #7/non-core for later.**
  Rejected: `institution-structure.json` is one coherent institutional record and its pinned tests
  assert the whole; a half-applied structure would still encode that دورة التهجي is not core and would
  force decisions on the non-core sections — and the owner wants nothing seeded yet. Recording the
  decisions without a partial application is the honest state.
- **Introduce a Level entity (`Section → Program → Level → Halaqa`).** Considered in a read-only design
  pass, then **rejected by the owner** (complexity without sufficient value); the hierarchy stays
  `Section → Program → Halaqa`. Kept here as the record of what was weighed.
- **Choose the Tahajji treatment / section #7 representation ourselves.** Rejected: the no-guessing rule
  and Q36's explicit "do not invent" forbid it; it stays deferred.
