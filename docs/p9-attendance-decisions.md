# P9 Attendance — Owner Decision Sheet

**Purpose:** present the unresolved governance questions that must be settled before P9 Attendance
can leave HELD. This is a **decision sheet, not an implementation design**. Nothing here answers a
question or invents policy; every item is extracted from the authoritative project sources.

**Base commit:** `9d2925e691bd34a88661200b1b1fad3c9cd71200`. **Sources:** `open-questions.md` (Q8, Q12,
Q35, Q36, Q68, Q69, Q43/Q67/Q70–72), `attendance.md` (§11, §23), `academic-reconciliation.md` (§13 +
Hold :19–21), ADR 0020, ADR 0016 (Q40 ruling), `communities-live-attendance.md` (§25) — all under
`docs/architecture/`.

## Current status

P9 is **HELD** (`attendance.md §23`; ADR 0020: "implementation HELD … Nothing here exists"). Per the
P9 audit, all *engineering* prerequisites are READY (Identity, Communities, Live incl.
`listParticipants`, the `ACADEMIC_RELATIONSHIPS` contract, DB infra, P6). P9 is blocked **only** on the
governance decisions below. `attendance.md §23`: *"Must be answered. Nothing else moves the module out
of HELD."*

**Note on Q40:** Q40 is **already answered** (ADR 0016, 2026-09-23) and is **not** a decision here. Its
ruling (point 3) created the Attendance hold; the items below are the gates that ruling left open.

## How to use this document

Answer each numbered decision one by one. **Do not modify implementation yet.** Each "Owner decision"
block lists only options the sources support; "Other" always requires an explicit written ruling,
recorded in the ADR named under that decision.

---

# Decision 1 — Q35 (the seven core sections vs the printed profile)

### Original question
The owner (2026-09-23, `owner-information.md` S1) listed seven core sections and "10 basic halaqat"
each; the printed profile has five graded + three special sections, and neither «المبتدئ» nor «تجويد
الحروف» appears as a section name. Which mapping is right, are the seven all the sections, does "10
basic" apply to محو الأمية (page 6 shows 5), what do "basic/additional", "level" and "need" mean, is
1–7 a display order, and are the printed names kept? (`open-questions.md` Q35)

### Why it matters
`academic-reconciliation.md §13` step 2 requires **written answers to Q35 and Q36** before the single
reviewed change (ADR 0015). The §13 "before any new module" step is one path of `attendance.md §23`
row 2 (Decision 7).

### Source
`open-questions.md` Q35; `academic-reconciliation.md §13`; `owner-information.md` S1–S2.

### Current status
**OPEN** ("Built instead. Nothing changed … provisional").

### Supported options (mapping sub-question only, as the source enumerates)
- **A.** المبتدئ is «قسم تجويد مبتدئ» (`dep-tajweed-1`); تجويد الحروف is new.
- **B.** تجويد الحروف is «قسم تجويد مبتدئ»; المبتدئ is new.
- **C.** Both are new (the printed section was split or renamed).

For the other sub-questions (completeness/Q39, literacy count, basic-vs-additional marker, level/need,
display order, keeping printed names): **source does not define explicit options; owner decision
required.**

### Consequences (from the source)
- Any mapping choice **decides which existing code gets which name and whether one or two sections are
  created** (codes/kinds are hard to undo: nothing deleted, codes never reused, kind immutable).
- Names/counts/order are **data** (API renames; no schema change). Only a "basic/additional marker
  with consequences" would be a new nullable column in a new migration.

### Owner decision
[ ] A  [ ] B  [ ] C  [ ] Other — requires explicit written ruling (record in ADR 0015)
Note: until answered, §13 forbids running the seed CLI against a production/shared DB or opening real
halaqat with seed-style codes.

---

# Decision 2 — Q36 (Tahajji: دورة التهجي وإعداد المعلمات / مدينة التهجي / the 40 groups)

### Original question
Is «دورة التهجي وإعداد المعلمات» the printed «قسم التهجي»? Is «مدينة التهجي» the same structure or a
separate one? Is a «مجموعة» a halaqa, a sub-group, or a chat group? Do 40 groups exist now or is 40 a
ceiling? How do they relate to the 10 basic halaqat (Q35)? Who studies there? Intakes (Q12)? Same path
or separate track? (`open-questions.md` Q36)

### Why it matters
Same as Q35 — §13 step 2 requires written answers to **Q35 and Q36** before ADR 0015 (Decision 7).

### Source
`open-questions.md` Q36; `academic-reconciliation.md §13`; `owner-information.md` S1/S6.

### Current status
**OPEN** ("`sec-spelling` stays `SPECIAL` … the 40 groups are not structure").

### Supported options (as the source enumerates)
- For «مدينة التهجي»: **(A)** the same structure as دورة التهجي, or **(B)** a separate one (its own
  section, a part of دورة التهجي, or an accompanying program).
- For a «مجموعة»: a halaqa / a smaller group inside a halaqa / a WhatsApp–Telegram group.
- For the 40: exist now / a ceiling.

Remaining sub-questions (who studies there, intakes, same-path vs track): **source does not define
explicit options; owner decision required.**

### Consequences (from the source)
- **(A)** renames `sec-spelling` (data: PATCH name, then POST programs/halaqat). **(B)** creates a new
  section/program (code must differ from `prog-hifz-city`).
- "a group is a halaqa" → 40 halaqat (fit the 200/program cap). "inside a halaqa" → a new table.
- Re-classifying `sec-spelling` from `SPECIAL` is an **audited change-kind** operation, never a data
  migration; it also changes the app home page's featured card.

### Owner decision
[ ] مدينة: A  [ ] مدينة: B  ·  group = [ ] halaqa [ ] sub-group [ ] chat  ·  40 = [ ] now [ ] ceiling
[ ] Other — requires explicit written ruling (record in ADR 0015)

---

# Decision 3 — Q8 (who may amend attendance, and is a reason mandatory)

### Original question
"Attendance is the record most likely to be quietly edited after the fact. Who may amend it, how long
after the session, and must they give a reason?" (`open-questions.md` Q8)

### Why it matters / link to Attendance
§13's **Attendance row** names Q8 as a precondition ("Q8 (amendment)"). `attendance.md §23` row 1
offers a path: "**Q8 and Q12 answered or ruled by the user not to apply to snapshots**."

### Already decided vs open
- **Decided (technical):** `AttendanceAmendment` in operations' contract **requires** `reason` and
  `amendedBy` — "an unexplained amendment should not be representable."
- **Open:** *who* may amend, and *for how long*.

### Explicit "does not apply" path?
**Yes** — `attendance.md §23` row 1: the owner may rule Q8 **does not apply to snapshots** (a snapshot
is an observation, not an amendable record — see Q70). Recorded in ADR 0020.

### Supported options
Source does not define explicit who/how-long options; **owner decision required** (permissions + a
policy rule with a time bound). Plus the §23 **"not applicable to snapshots"** ruling path.

### Owner decision
[ ] Define amend authority + time bound (for the attendance record) — written ruling
[ ] Rule Q8 **does not apply to live-presence snapshots** (record in ADR 0020)
[ ] Other — requires explicit written ruling

---

# Decision 4 — Q12 (timezone and academic calendar)

### Original question
"Is the institution single-timezone? Are sessions scheduled in local time or UTC? What defines a term,
and does attendance roll up by term?" (`open-questions.md` Q12)

### What it controls / why §13 references it
The recurrence model in `operations` and term roll-up of attendance. §13's **Attendance row** names
Q12 ("Q12 (calendar)"). Already technical-safe: all timestamps are `timestamptz`, `Clock` injected, no
recurrence model yet.

### Does it apply to snapshots?
A snapshot is "connected at time T" (an instant); roll-up/term questions are Q70 (snapshot → record).
`attendance.md §23` row 1 offers the explicit path: "**Q12 answered or ruled by the user not to apply
to snapshots**."

### Supported options
Source does not define explicit options for the calendar model itself; **owner decision required**.
Plus the §23 **"not applicable to snapshots"** ruling path.

### Owner decision
[ ] Define timezone/term/roll-up model — written ruling
[ ] Rule Q12 **does not apply to live-presence snapshots** (record in ADR 0020)
[ ] Other — requires explicit written ruling

---

# Decision 5 — Q69a — Attendance scoping

### Question
For reviewers: "is **community standing** acceptable as the scoping relationship that
`academic-reconciliation.md §13` requires, where it names **`ACADEMIC_RELATIONSHIPS`**?"
(`open-questions.md` Q69; `attendance.md §23` row 3a)

- **`ACADEMIC_RELATIONSHIPS`** = the academic contract (`academic/contracts/relationships.ts`,
  `ACADEMIC_RELATIONSHIPS` symbol) that §13 names as the roster/scoping boundary academic enforces.
- **community standing** = scoping through Communities' reserved acts
  `community.attendance.record` / `community.attendance.view` (membership/grant in the community),
  which is the PROVISIONAL built design.

### Option A
Scope record/view through **`ACADEMIC_RELATIONSHIPS`** (the §13-named relationship). Affects: ties
Attendance to the academic roster boundary.

### Option B
Scope through **community standing** (`community.attendance.record` / `.view`). Affects: the two
reserved Communities acts (already present, marked "P9, held" in `communities/contracts/
capabilities.ts`); P9 widens the `communities_capability_grants` CHECK; uses **no `attendance.*`**
permission.

### Owner decision
[ ] A (`ACADEMIC_RELATIONSHIPS`)  [ ] B (community standing)
[ ] Other — requires explicit written ruling (record in ADR 0020; reviewer acceptance is the §23
row-3a entry condition)

---

# Decision 6 — Q69b — Record / View authority

### Question
Confirm or replace the PROVISIONAL record/view defaults (`attendance.md §11`; ADR 0020;
`open-questions.md` Q69). **Only roles the source names are listed below; no parent/student access is
invented.**

### Supported option — PROVISIONAL default (from the brief §9/§13/§15)
- **Record:** the community's owner; the session's host while `community.live.host` holds; the
  session's moderators; and a `community.attendance.record` grantee.
- **View:** the owner; the host or a recorder (for the snapshots of sessions they hosted/recorded in,
  while still a member); and a `community.attendance.view` grantee.
- Recording **implies viewing** for sessions one recorded in; beyond them only with
  `community.attendance.view`. Recorder need not be host or connected.
- **No institution-wide oversight** until Q43 says otherwise. **No student or parent view.**

### Supported alternative (named in the source)
"The owner or an explicit grant only, with **recording not implying viewing**." (`open-questions.md`
Q69)

### Student / parent self-view
Open sub-question ("May students or parents see their own entries?"); the **default is no student or
parent view**, and "a student view is a new route." **Source does not define an explicit "yes" option**
for P9; owner ruling required to add one. (Parent visibility generally is Q10, unresolved — do not
assume a parent attendance view.)

### Owner decision
[ ] Confirm the PROVISIONAL default (record + view sets above)
[ ] Adopt the alternative (owner/grant only; recording does not imply viewing)
[ ] Other — requires explicit written ruling (record in ADR 0020; user confirmation is the §23 row-3b
entry condition)

---

# Decision 7 — §13 / ADR 0015 (reconciliation)

### What §13 requires (before any new module)
`academic-reconciliation.md §13`: (1) this pass ✅; (2) written answers to **Q35 and Q36**; (3) one
reviewed change recorded as **ADR 0015** (record each code→name decision; split seed provenance; add
the seed's parent check and explicit per-entry halaqa codes; apply through seed + API; update pinned
tests); (4) until (3), do not run the seed CLI against prod/shared DB. An overarching **Hold**
(`academic-reconciliation.md:19–21`): Attendance does not start until this reconciliation has been
reviewed.

### Why ADR 0015 / current status
ADR 0015 is the single reviewed change that would record the §13 decisions. **It does not exist** (ADRs
present: 0001–0014, 0016–0022). Q35 and Q36 are **prerequisites** to it (§13 step 2 → step 3).

### Project-supported paths (`attendance.md §23`, ADR 0020)
- **Path A — complete §13:** answer Q35 + Q36 (Decisions 1–2) and land **ADR 0015**; **and** the
  reconciliation review with §13's Attendance row met (Decisions 3, 4, 5). This is §23 rows 1–2
  satisfied by completion.
- **Path B — explicit ruling:** the owner rules that §13's "before any new module" step **does not
  apply to attendance** (§23 row 2: "or ruled not to apply to attendance") **and** that live-presence
  snapshots are **outside the Attendance hold and §13's Attendance row** (§23 row 1), recorded in
  **ADR 0020**. (ADR 0020 itself names "the reconciliation review … or the user's ruling" as the
  trigger.)

Both paths are explicitly supported; the sources do not rank them.

### Owner decision
[ ] Path A — complete §13 + ADR 0015 (needs Decisions 1–5)
[ ] Path B — explicit ruling that §13 "before any new module" does not apply to attendance/snapshots
(record in ADR 0020)
[ ] Other — requires explicit written ruling

---

# Non-blocking recorded items (NOT decisions)

`attendance.md §23` lists these under **"Must be on record, not answered"** — their PROVISIONAL defaults
are recorded in `open-questions.md`, and §23 states **"None of them blocks P9."** Do **not** answer them
here:

- **Q68** — what counts as present (PROVISIONAL `provider_registry_v1`: CONNECTED + CONNECTING stored
  separately, every role equal, none labelled "present"). **On record; does not block P9.**
- **Q43** (institutional oversight), **Q67** (notifications for attendance facts), **Q70** (is a
  snapshot the record), **Q71** (correcting/retaining/erasing), **Q72** (when/how often). All recorded
  provisional; non-blocking per §23.

---

# Final decision summary

| Decision | Current status | Owner answer |
|---|---|---|
| Q35 | OPEN | |
| Q36 | OPEN | |
| Q8 | OPEN | |
| Q12 | OPEN | |
| Q69a | OPEN | |
| Q69b | OPEN | |
| §13 / ADR 0015 | OPEN | |

---

**Source discrepancy flagged (not resolved here):** `communities-live-attendance.md:1892` (status prose)
groups **Q68** with Q69 as held "until … answered," whereas the dedicated gate `attendance.md §23` and
the §25 plan-table "Blocked on" column (`:1912` — only "Q40, Q69, §13's Attendance row (Q8, Q12), P6")
treat Q68 as **on-record, non-blocking**. This sheet follows §23 and does **not** list Q68 as a
decision. Owner/reviewer should confirm §23 governs.
