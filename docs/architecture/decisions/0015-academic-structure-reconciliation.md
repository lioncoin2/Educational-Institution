# 0015 — Academic structure reconciliation: the owner's section/halaqa answers (Q35/Q36)

**State: ACCEPTED (2026-10-05) — records the owner's answers to Q35 and Q36, and the later clarifications
of the same day. It supersedes in part [0014](0014-academic-core-v1.md): the specific section *names*
and the literacy halaqa *count* the owner's answers change. The hierarchy stays **Section → Program →
Halaqa** (the `Level` concept that was briefly considered is RETIRED — see Decided items). The
reconciliation **decisions are complete** (owner, 2026-10-05): one uniform model for all sections
(core, non-core and Tahajji), dynamic and owner-managed, no hard-coded counts. **These decisions were
subsequently APPLIED to the seed + tests on 2026-10-05 via Option A (a split operational source) — see
"Implementation status" below;** the printed profile (`institution-structure.json` and the Flutter
`ProfileData`) is UNCHANGED, and the seed is never run against a production/shared database. Every
decision here is CURRENT and REVERSIBLE, not a permanent architectural lock.**

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
The **"40 groups" figure is historical/source information only** — not a system limit, not a required
seeded count, not necessarily the current active count; the **owner** determines the actual number and
adds/edits/deletes/renames/manages them; **no groups are seeded now**. Historical identifiers are
preserved.

**Final resolution (owner, 2026-10-05):** Tahajji / دورة التهجي / مدينة التهجي use the **same academic
model, `Section → Program → Halaqa`** — no special entity, no hard-coded count, no fixed 40. A Tahajji
"group" is an **academic halaqa** under the uniform model (it is **not** a chat / LiveKit / Community
construct). دورة التهجي وإعداد المعلمات is core section **#7**, an ordinary section under this model; its
programs and halaqat are **dynamic, owner-managed** data. (The separate question of whether any
educational group ever maps to a voice/LiveKit room stays deferred — not part of this reconciliation.)

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

### Resolved (owner, 2026-10-05, final) — the structural decisions are now complete

1. **دورة التهجي وإعداد المعلمات = core section #7**, an ordinary section under the uniform
   `Section → Program → Halaqa` model (above). Proposed code **`dep-tahajji`** (recorded here as the
   §13 code→name decision; `dep-*` family; reversible, owner-overridable). The existing `sec-spelling`
   (قسم التهجي, `SPECIAL`) is **left as existing dynamic data** the owner may manage — this ADR does not
   assert that it is the same section as #7, and does not delete or reclassify it.
2. **Non-core sections** (`sec-kids` البراعم, `sec-languages` اللغات, `accompanying`) are **dynamic,
   owner-managed data, not architectural decisions** (owner ruling 2026-10-05): they are **kept**; no
   "core" flag is introduced; the owner adds/edits/deletes/renames/reorders them at runtime. Nothing is
   removed or reclassified by this ADR.

**Everything academic is one uniform model** — `Section → Program → Halaqa`, dynamic and owner-managed,
with no hard-coded counts or limits. The reconciliation **decisions are complete**.

**Applying these decisions to the seed is the remaining work, and it is the first implementation
step — NOT performed in this ADR.** It comprises: the five core renames + literacy 5→10 + the new
`dep-tajweed-letters` section + the `dep-tahajji` section, explicit per-entry halaqa codes, the seed
parent check, provenance marking of owner-sourced entries, and updating the pinned tests
(`seed.spec.ts`, `structure.spec.ts`, `app/test/academic/profile_structure_test.dart`). Per the owner,
**the seed is never run against a production or shared database**; the applied change is verified on an
isolated/in-memory test database only.

## Consequences

- The owner's Q35/Q36 answers (and the 2026-10-05 Tahajji / non-core / uniform-model rulings) are on
  record (this ADR; `open-questions.md`). The §13 **decisions** are complete.
- **§13 is now LANDED as code (2026-10-05):** the decisions are applied in the operational seed + its
  tests (see "Implementation status" below), verified on an isolated/in-memory database only. The
  "before any new module" step is therefore complete.
- The printed profile was **not** edited: `institution-structure.json` and the Flutter `ProfileData`
  still carry the printed profile unchanged (Option A split the sources). The applied structure lives
  in a new operational source, and the seed was never run against a production/shared database.
- `AttendanceAmendment` (`operations/contracts`) already requires `reason`+`amendedBy` (Q8's technical
  position); unchanged.

## Implementation status

**LANDED — 2026-10-05, Option A (split sources).** The decisions above are applied to the seed and its
tests, and nothing else; no production or shared database was seeded.

- **New operational source (the only seed source):**
  `backend/src/modules/academic/application/operational-structure.json` + `operational-structure.ts` —
  11 sections, 11 programs, 70 halaqat (10 under each of the seven core programs). The seed use case
  (`seed-structure.use-case.ts`) now reads this, not the printed profile.
- **Printed profile untouched:** `institution-structure.json`/`.ts` and the Flutter `ProfileData` are
  unchanged; `app/test/academic/profile_structure_test.dart` passes unchanged.
- **Provenance split (profile vs owner):** every entry carries `owner` (ref `adr-0015`) or `profile`
  (its page); the source is recorded in each creation's audit metadata.
- **Parent check + explicit halaqa codes:** `validateOperationalStructure` enforces globally-unique
  codes, present provenance and well-formed parents before seeding; halaqa codes are `<section>-h<n>`,
  names `الحلقة <n>`.
- **Codes preserved, never reused:** `dep-literacy`, `dep-letters`, `dep-tajweed-1/2/3`, `sec-*`,
  `accompanying`, `prog-*` kept; new `dep-tajweed-letters` (#4) and `dep-tahajji` (#7) added.
- **Verified (in-memory only):** academic suite 101/101, architecture 141/141, Flutter profile test
  4/4; format/lint/typecheck clean. Hazard H1 honored — no seed against a production/shared DB.
- **Not done (out of scope):** running the explicit seed command against a real database is a separate
  operational/deployment step.

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
