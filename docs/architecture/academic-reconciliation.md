# Academic Core — owner information reconciliation

**Status: open, waiting on the owner.** Date: 2026-09-23. Baseline: Academic
Core V1 at commit `dffb156` ([academic.md](academic.md),
[ADR 0014](decisions/0014-academic-core-v1.md)).

**Scope.** This is an audit, not feature work. After Academic Core V1 was
finished, the owner described the institution's academic organisation in
terms that differ from the printed profile the implementation was built from.
The owner's statements are recorded, dated and unmapped, in
[owner-information.md](../owner-information.md). This document compares
them with what is built and decides what may change now.

**What changed in this pass.** Documentation and code comments only. No
schema, migration, seed data, domain rule, endpoint, screen or test changed;
the seeded structure is still the printed profile's. ADR 0014's decisions are
unedited (an ADR is superseded, never rewritten).

**Hold.** Assignments, Attendance, Progress and Promotion do not start until
this reconciliation has been reviewed. [§13](#13-minimal-recommended-changes-before-the-next-milestone)
lists what each of them needs answered first.

---

## 0. Verdict

1. **The implementation is sound and needs no rewrite.** Nothing in the
   owner's information shows a defect in the Section → Program → Halaqa
   model, the relationships, the invariants or the authorization boundary.
2. **The database can hold the owner's structure as data, with no
   migration.** That covers seven sections, ten halaqat per section plus
   more, levels as programs, and forty Tahajji groups as halaqat, all within
   the current constraints and technical caps. `0007` and `0008` stay as
   they are.
3. **The owner's *progression* cannot be recorded honestly yet.** Every gap
   is closed by an additive migration and none needs a destructive one, but
   each is blocked on an owner answer:
   - a move or ضخ ending;
   - a link between successive enrollments;
   - an assessment or placement record;
   - an awaiting-placement state;
   - section-scoped supervision.
4. **The seeded data now conflicts with the owner in several places.** These
   are the section list, the literacy halaqa count, التهجي's kind and
   halaqat, and the undefined basic/additional distinction. The seed stays
   unchanged: every answer that would change it is ambiguous, and a wrong
   seeded code or kind is costly to undo.
5. **Two things must change now, both in wording, not code:**
   - The documents presented the printed profile as the only source, and its
     5-graded-section, 45-halaqa structure as the institution's current
     one. They now call it the printed profile's structure, provisional.
   - Several places already carry an unconfirmed rule: the demo's locked
     ladder, "levels" wording, mock certificates, prototype-spec screens and
     a test fixture. They are now labelled as such.
6. **Of the nine audited decisions, none must be reversed in code now.**
   - Three are safe as they are: staff-only enrollment, blocking deactivation
     while students are enrolled, and no supervisor rosters.
   - Keeping the 40 groups out of the structure is correct and stays.
   - Four are provisional and must not be relied on: 9 sections, 9 programs,
     45 halaqat, and one program per section.
   - One must be confirmed before real data piles up: unlimited simultaneous
     enrollment.

---

## 1. Sources, and how they are kept apart

| Source | Where | May feed the seed? |
| --- | --- | --- |
| **Printed profile** (14 pages) | `docs/institution-profile.pdf` → [pdf-content-extract.md](../pdf-content-extract.md) | Yes: it is what `institution-structure.json` holds today, pinned by `seed.spec.ts` |
| **Owner statements** (2026-09-23) | [owner-information.md](../owner-information.md) | Not yet. It gets there only through an ADR that records the owner's answers to Q35–Q39, with each code→name decision dated |
| **Engineering provisional** | [open-questions.md](open-questions.md) | Only as labelled placeholders (for example, the one program per section) |

Two rules protect the separation:

- **No owner wording in `pdf-content-extract.md`.**
  `seed.spec.ts:13-21,135-141` checks that each seeded name appears
  *anywhere* in that file. One owner name in a note there would silently
  pass the provenance check for an owner-sourced entry.
- **The app's `DataOrigin` has three values: `profile`, `records` and
  `mock`.** Owner statements have no label, so they must not be shown in the
  app until they exist as server records.

---

## 2. Current implemented facts

Everything below is in code at `dffb156`. The "Source" column says where each
fact came from, which is not always the profile.

### 2.1 Structure

| Fact | Evidence | Source |
| --- | --- | --- |
| **9 sections:** 5 `PROGRESSIVE` (محو الأمية، تلقين الحروف، تجويد مبتدئ/متوسط/متقدم), 3 `SPECIAL` (التهجي، البراعم، اللغات), 1 `ACCOMPANYING` | `institution-structure.json` | 8 from the profile (p6–9). The ACCOMPANYING row is an **engineering container**: programs need a section (`programs.section_id NOT NULL`), and the profile's contents list «البرامج المرفقة» separately from «الاقسام التعليمية» |
| **9 programs:** one per PROGRESSIVE section, named after it; the 4 page-10 programs under the container; none under SPECIAL | same file | 4 from the profile (p10). The **5 per-section programs are engineering placeholders** (Q33) |
| **45 halaqat:** literacy 5, the other four graded sections 10 each; named «الحلقة n», coded `<section>-h<n>`; none elsewhere | same file; `institution-structure.ts:38-40` | Counts from the profile (p6); names and codes are engineering |
| Section `kind` ∈ {PROGRESSIVE, SPECIAL, ACCOMPANYING}; **cannot be changed through the API** | `vocabulary.ts`; `0007` `academic_sections_kind_valid`; the DTO has no kind on PATCH | Engineering classification of the profile's pages |
| A halaqa's program **cannot be changed** (`programId` is fixed at creation) | `domain/structure.ts:50,151` | Engineering: history is placed by join |
| Codes are unique per table and never change; names are not keys | `0007` `UNIQUE(code)` per table | Engineering |
| `order` is a display position, not a prerequisite | Q29 | Engineering |
| Technical caps: 50 sections, 50 programs per section, 200 halaqat per program. The halaqa cap **counts INACTIVE rows** | `academic-policy.ts:17-19`; `drizzle-academic-repository.ts` count without a status filter | Engineering bound, not policy |
| **The 40 Tahajji groups are not structure.** The app shows the profile's line «استيعاب 40 مجموعة» as descriptive text attached to `sec-spelling` by code | `academic.md` §11; `profile_data.dart` (`capacityNote`) | Profile p7 as text only |

### 2.2 Relationships and lifecycle

| Fact | Evidence |
| --- | --- |
| **Enrollment is staff-only** (`academic.manage`: OWNER, ADMIN); the app writes nothing to `/academic` | `enrollment.use-cases.ts`; `app/test/academic/academic_boundaries_test.dart` |
| Enrollable = an ACTIVE account holding `academic.study` (STUDENT; OWNER and ADMIN by the no-escalation rule) | `0008`; `provisional-policy.ts:111-118` |
| **No limit on simultaneous halaqat.** Only one ACTIVE enrollment per (student, halaqa) | partial unique index `academic_enrollments_active_unique` |
| An enrollment ends as `COMPLETED` or `WITHDRAWN` only. **An ended outcome cannot be changed** (409) | `vocabulary.ts`; `domain/enrollment.ts:68-81`; `0007` `academic_enrollments_status_valid` |
| A "transfer" is an end followed by a new enrollment: two acts, no link between them | Q30 |
| Assignments are many-to-many, role TEACHER or ASSISTANT_TEACHER, ended as `ENDED` | `teaching.use-cases.ts` |
| Deactivating a section or program has no precondition and closes it to new enrollment only | `structure.use-cases.ts` |
| **A halaqa cannot be deactivated while it has ACTIVE enrollments** (412); assignments are left untouched | `structure.use-cases.ts:575-581` |
| Nothing is deleted through the application; foreign keys inside the module are `RESTRICT` | `0007` |

### 2.3 Access

| Fact | Evidence |
| --- | --- |
| A roster is readable with `academic.manage`, or with `academic.teach` plus an ACTIVE assignment to that halaqa | `academic-access.ts:27-38,68-80` |
| **Supervisors see no roster** | same; `backend/test/api/academic.api.spec.ts` pins the 403s |
| An assigned teacher can read the halaqa's **ended** enrollments (status filter), including students who left before the assignment started | `ListHalaqaStudentsUseCase` (`enrollment.use-cases.ts:247`) with `status` |
| `isTeaching` / `isEnrolled` read ACTIVE relationships and **ignore the structure's status**: a closed halaqa's teacher still "teaches" it | `contracts/relationships.ts`; `academic-relationships.service.ts` |
| Identity's provisional matrix gives SUPERVISOR **unscoped** `attendance.read`, `assignments.read` and `reports.read`, and TEACHER unscoped `attendance.manage` and `assignments.manage` | `provisional-policy.ts:47-83` |

### 2.4 Seed

| Fact | Evidence |
| --- | --- |
| Runs as an explicit CLI (`academic:seed-structure`) against Postgres, and at boot for the in-memory store; never in a migration | `academic.module.ts`; ADR 0014 Decision 6 |
| Idempotent by code, never overwrites: a rename, deactivation or new halaqa survives a re-run | `seed-structure.use-case.ts` |
| **When a seed-style halaqa code already exists, it is adopted without checking its parent** | `seed-structure.use-case.ts:107-116,215-222` |
| Seeded rows are audited with `source: 'institution-profile'`; the creation audit records code and kind or parent, **not the name** | `seed-structure.use-case.ts:157,200,244` |
| The seed is also the **test fixture** for the academic specs, which refer to seeded codes (`dep-letters-h2…h5`, `dep-literacy-h1/h2`, `prog-mutun`) | `backend/test/support/academic-harness.ts:207-209`; `structure.spec.ts`, `teaching.spec.ts`, `relationships-contract.spec.ts` |

### 2.5 The app

| Fact | Evidence |
| --- | --- |
| مساري's ladder is the PROGRESSIVE sections; the home stats count PROGRESSIVE; the home featured card is `sec-spelling`, taken from the SPECIAL list | `academic_learning_repository.dart`; `home_screen.dart:31-38,142-190` |
| A section's halaqat are shown as one list, flattened across its programs; route ids resolve across section and program codes | `academic_learning_repository.dart:75-107,157-172`; `academic_catalog_repository.dart` |
| Against the server: no progress, no locks, no "pending" state | [academic.md §14](academic.md#14-the-flutter-app) |
| The **demo** (and the public GitHub Pages build) shows a locked ladder («يفتح بعد إتمام ما قبله»), «4 من 10» halaqa completion and sample certificates «إتمام قسم …». All of it is marked as demo data | `mock_data.dart:103-163,299-325`; `path_stepper.dart:266` |
| Certificates are mock in **both** modes | `app_providers.dart:92-94` |
| Routes and titles call a section's halaqat "levels" (`/programs/:id/levels/:halaqaId`, «المسار والمستويات») | `routes.dart:19-25`; `program_levels_screen.dart` |
| The profile data pins literacy 5, total 45, the 40-group note | `profile_data.dart`; `app/test/academic/profile_structure_test.dart` |

### 2.6 Not modelled at all

Assessment, placement, mastery, promotion, strengthening/support, نظام الضخ,
intakes/terms, capacity, the development path, trainees as a category,
section-scoped supervision, basic vs additional halaqat. **This is by design**:
the profile states none of them as rules.

---

## 3. Owner-confirmed new facts

These are recorded verbatim in [owner-information.md](../owner-information.md).
Each one is a *statement*; what it leaves unsaid is not filled in.

| # | The owner stated | The owner did **not** state |
| --- | --- | --- |
| S1 | Seven core academic sections: محو الأمية، تلقين الحروف، المبتدئ، تجويد الحروف، التجويد المتوسط، التجويد المتقدم، دورة التهجي وإعداد المعلمات | whether these are all the sections; which profile section each one is; whether the numbering is a sequence |
| S2 | Each section has 10 basic halaqat, and more can be opened by level and need | whether 10 exist today; whether it applies to literacy (profile: 5); what makes a halaqa "additional"; who opens and closes halaqat; any limit |
| S3 | Progression involves assessment, placement, mastery, progression to higher levels, strengthening/support, and later specialization, training and teacher preparation | any criterion, score, form or duration; who decides; what is recorded |
| S4 | A development path: educational level → mastery → specialization → training → teacher preparation → leadership/management | whether these stages are enrollable programs or staff roles; how they relate to profile p12 and p5 |
| S5 | «نظام الضخ بين الأقسام» exists | what it moves, in which direction, who decides, and how the move is recorded |
| S6 | «مدينة التهجي» has 40 specialized groups and teacher preparation | whether it is (A) the same as S1's item 7 or (B) separate; whether a group is a halaqa; whether 40 is a count or a capacity |

---

## 4. Conflicts

The honest comparison is **8 profile academic sections** (5 graded + 3
special; the ACCOMPANYING row is a container) against **7 owner core
sections**.

| # | Profile / implementation | Owner | Nature |
| --- | --- | --- | --- |
| C1 | «قسم تجويد مبتدئ» (`dep-tajweed-1`) | «المبتدئ» **and** «تجويد الحروف» | **Unmapped.** There are three readings: (a) المبتدئ = `dep-tajweed-1` and تجويد الحروف is new; (b) تجويد الحروف = `dep-tajweed-1` and المبتدئ is new; (c) both are new, and the profile's section was split or renamed. Neither owner name appears as a section name in the profile. |
| C2 | Names «قسم تجويد متوسط / متقدم», «قسم تلقين الحروف», «قسم محو الأمية» | «التجويد المتوسط / المتقدم», «تلقين الحروف», «محو الأمية» | Wording only; likely the same sections, but not confirmed. |
| C3 | Literacy: **5 halaqat** (p6) | 10 basic per section | **Count conflict**, unless literacy is an exception or page 6 is out of date. |
| C4 | «قسم التهجي» (`sec-spelling`): `SPECIAL`, **no program, no halaqa**; described as teaching reading basics, with no teacher preparation | «دورة التهجي وإعداد المعلمات», one of the core seven, with 10 basic halaqat | Kind, content and naming. Whether they are the same section is itself a question (Q36). |
| C5 | «استيعاب 40 مجموعة» under قسم التهجي (p7); not structure | «مدينة التهجي», 40 specialized groups and teacher preparation, A or B | Name and possibly entity. Capacity or count is unknown. |
| C6 | Halaqat come from fixed counts in the seed; nothing marks one as additional | "10 basic + additional by level and need" | The seed cannot express "additional"; the API can open them, but nothing records the distinction. |
| C7 | Endings are `COMPLETED` or `WITHDRAWN`; a move is end + enroll with no link; no assessment or placement record | Assessment, placement, strengthening, progression, نظام الضخ | **The model cannot record these moves honestly.** Forcing a move into COMPLETED or WITHDRAWN mislabels the student permanently (the outcome is immutable). |
| C8 | Only STUDENT (plus OWNER and ADMIN) may be enrolled; a staff member who studies needs the STUDENT role too | Teacher preparation is part of a core section | Trainees may be serving staff; the eligibility model was written for an exception. |
| C9 | No path entity; profile p12 lists four cadre tracks as training | Development path up to leadership/management | Relationship to p12 and p5 unknown. |
| C10 | البراعم، اللغات and the four accompanying programs are seeded as ACTIVE | Not mentioned among the seven core sections | **Silence, not removal.** «Core» may separate academic from non-academic departments (p11, p13) or from these; unknown. |
| C11 | README, `prototype-spec.md` and the structure file call the PDF «المصدر الوحيد» / "THE single source" | A second, later source exists | Documentation framing: **changed in this pass**. |

---

## 5. Audit of the nine named decisions

Verdicts: **Safe**: keep, the owner information does not bear against it.
**Provisional, keep**: keep, but it must not be read as confirmed.
**Must change**: its framing or scope must change. **Blocked**: a
change is expected but depends on an answer.

| # | Decision | Owner information bearing on it | Verdict | Now | Blocked on |
| --- | --- | --- | --- | --- | --- |
| 1 | **9 seeded sections** | S1 names 7 core sections that do not map one-to-one (C1, C2, C4, C10) | **Provisional, keep.** The framing *must change*: it is the printed profile's structure, not the institution's current one | Wording qualified (structure file, READMEs, academic.md). **Do not run the seed CLI against a production or shared database.** Do not add, rename or re-kind sections | Q35, Q36, Q39 |
| 2 | **9 seeded programs** | S2's "according to level" may mean levels inside a section; S6 may add a program | **Provisional, keep.** The 5 per-section programs are placeholders; the 4 accompanying programs are profile facts | Do not create a second halaqa-bearing program in a PROGRESSIVE or SPECIAL section: the app flattens them and the seed derives halaqa codes per section | Q35 (levels), Q36, Q33 |
| 3 | **45 seeded halaqat** | S2: 10 basic per section; literacy has 5; `sec-spelling` has 0 | **Provisional, keep; conflicts with the owner (C3, C4, C6).** Do not edit the JSON: its tests pin page 6 by design | Additional halaqat can already be opened through the API, but do not do it in real data with seed-style codes (`<section>-h<n>`) until basic vs additional is answered. A later count increase would adopt them as "basic" | Q35 |
| 4 | **One program per graded section** | S2 "according to level" | **Provisional, keep, and safe only while no real enrollments exist.** A halaqa's program is immutable, and moving halaqat between programs would rewrite past placements (history is placed by join, and the audit keeps only the halaqa id) | Settle any levels or tracks inside a section **before** real enrollments; afterwards only new halaqat can be created | Q35 (levels), Q33 |
| 5 | **Staff-only enrollment** | S3's "assessment → appropriate placement" describes an act by the institution; nothing mentions self-enrollment | **Safe.** Conservative and reversible (adding a route later is additive) | None | Q30 (unchanged) |
| 6 | **Unlimited simultaneous halaqa enrollment** | S3 "strengthening/support" may be a concurrent halaqa or a move; S4 specialization may run alongside | **Provisional, keep.** No limit is invented; a limit would be a rule the owner has not stated | Confirm before real enrollments accumulate. A later limit would find existing students already over it | Q30, Q37 |
| 7 | **Cannot deactivate a halaqa with enrolled students** | S2 makes opening and closing halaqat "by need" routine | **Safe.** Ending students automatically would invent their outcome. Routine closure makes the missing neutral ending (C7) more urgent, not the rule wrong | Keep. Do not close additional halaqat in real data by ending students as COMPLETED or WITHDRAWN | Q32, Q37 |
| 8 | **Supervisors see no roster** | S4 leadership/management; p12 «تأهيل مشرفات»; the owner says nothing about supervisors' scope | **Safe** (least privilege; widening later is a decision, narrowing after exposure is not). **But** identity's matrix gives SUPERVISOR unscoped `attendance.read`, `assignments.read` and `reports.read`: those modules must scope them through academic relationships | Recorded as a precondition for Attendance and Assignments ([§13](#13-minimal-recommended-changes-before-the-next-milestone)) | Q31, Q1 |
| 9 | **40 Tahajji groups excluded from the structure** | S6 confirms the groups matter but leaves A/B, group = halaqa, and count vs capacity open | **Safe and correct.** Creating 40 halaqat now would guess all three answers, under a section whose kind may itself change | Keep excluded. The app's «استيعاب 40 مجموعة» stays as profile text | Q36 |

---

## 6. Existing provisional assumptions

These were already labelled as provisional before this pass. The owner
information does not confirm any of them.

| Assumption | Where | Question |
| --- | --- | --- |
| One program per graded section, named after it | seed, ADR 0014 D2 | Q33, Q35 |
| Halaqat named «الحلقة n», coded `<section>-h<n>` | seed | Q33, Q35 |
| Section kinds PROGRESSIVE / SPECIAL / ACCOMPANYING | vocabulary, CHECK | Q35, Q36, Q39 |
| `order` = display position | Q29 | Q29, Q35 |
| Staff-only enrollment; OWNER and ADMIN are enrollable | 0008, policy | Q30 |
| No simultaneous-enrollment limit | schema | Q30, Q37 |
| Endings `COMPLETED` / `WITHDRAWN` chosen by staff | vocabulary, CHECK | Q30, Q37 |
| Transfer = end + enroll | Q30 | Q37 |
| Many-to-many teaching; teachers see their halaqat's rosters, including ended enrollments | access | Q31 |
| Supervisors see no roster | access | Q31 |
| Section and program deactivation has no precondition; halaqa deactivation needs no active students; assignments untouched | use cases | Q32 |
| Accompanying programs under one container section | seed | Q33, Q39 |
| Technical caps 50 / 50 / 200 | policy | Q12 (intakes) |

---

## 7. Assumptions that must NOT be treated as confirmed

These look like facts somewhere in the repo and are not. Each is now
labelled where it lives.

1. **"The seeded 9 sections / 45 halaqat are the institution's structure."**
   They are the printed profile's. See C1–C4 and C10.
2. **"The PROGRESSIVE sections are a ladder taken in order."** The profile
   lists them; the owner lists seven; neither states a sequence. Q29's
   question text wrote them with arrows (removed in this pass).
3. **"The owner's list order 1–7 is a progression."** It is a list.
   دورة التهجي being seventh is not evidence that it is a final stage.
4. **"A section's halaqat are levels."** The routes (`/levels/`), the screen
   title «المسار والمستويات» and the demo ladder say so. The wording is
   inherited prototype wording, not a model; Q29 asks exactly this.
5. **The demo's lock rule** («يفتح بعد إتمام ما قبله»), «متاح» next rung,
   «4 من 10» completion, and "a section is complete when its halaqat are".
   These are placeholders, and the next modules must not use them as a
   specification.
6. **Mock certificates «إتمام قسم …»**, shown in both modes. They imply
   section completion and a sequential story (Q9). Profile p13 speaks of
   programs and courses and states no criteria.
7. **"Promotion is recorded as COMPLETED."** The test fixture
   `access.spec.ts:162-184` ends a tajweed-2 enrollment as COMPLETED before
   enrolling in tajweed-3. That is test data exercising access, not a rule.
8. **"COMPLETED and WITHDRAWN cover every way an enrollment ends."** They do
   not cover placement corrections, support moves, ضخ, or merges (C7).
9. **"`sec-spelling` is a SPECIAL section with no halaqat."** The owner
   calls it (or something like it) a core section with halaqat (C4).
10. **"40 is the capacity."** The profile says «استيعاب»; the owner says 40
    specialized groups. The `prototype-spec` phrase «من أصل 40» (TE and AD
    dashboards) assumes a ceiling.
11. **"A staff member who studies is an exception."** The owner makes
    teacher preparation part of a core section (C8).
12. **"Leadership/management is only an identity role."** Page 12 describes
    *training* for managing halaqat and sections, which may be run as
    enrollments (Q38).
13. **`prototype-spec.md` screens for the held modules:**
    - TE-04 (attendance states);
    - TE-08 (evaluation form الإتقان / التجويد / الطلاقة, مقبول / إعادة, not
      tagged MOCK);
    - TE-09 and TE-10 (assignments, progress);
    - TE-11 and AD-08 (page-12 tracks as existing teachers' training);
    - the SH-04 onboarding (self-placement by age, reading ability and goal,
      plus self-enrollment «سجّلي في هذا القسم»);
    - AD's «طلبات تسجيل معلّقة»;
    - the evaluation flow.

    None of these is implemented. All are now marked **UNCONFIRMED**, not
    "superseded".
14. **"The printed profile is the sole source."** It is the first source; the
    owner's statements are a second (§1).

The invented-rule check also caught the audit itself leaning toward rules.
None of these was adopted:

- an upward ضخ "might be COMPLETED";
- "one graded level at a time";
- "preparation required before teaching";
- "40 existing groups";
- "Tahajji is the final stage".

---

## 8. Can the current database model safely support the owner model?

**Short answer: yes for structure, as data; not yet for progression, which
needs additive migrations blocked on answers; never through a destructive
change.**

| Owner element | Today | What it needs | Class | Blocked on |
| --- | --- | --- | --- | --- |
| 7 core sections (rename, reorder, add 1–2) | Sections are rows; names are not keys | `PATCH` names and order; `POST` new sections. Existing codes are kept | **data-only** | Q35 mapping |
| Literacy 10 basic halaqat | 5 rows | 5 more halaqat (API, or the JSON count once provenance allows) | **data-only** | Q35 |
| Additional halaqat by need | `POST /academic/halaqat` works; 200-per-program cap | Nothing to open them. A basic/additional **marker** only if the owner gives it a meaning | data-only; marker **schema-additive** (nullable column) | Q35 |
| دورة التهجي as a core section with halaqat | `sec-spelling` SPECIAL, 0 programs | Programs and halaqat via the API. **Kind cannot change through the API**: use either a new section code or an explicit, audited change-kind operation | data-only, or **code** | Q36 |
| مدينة التهجي's 40 groups | nothing | If a group is a halaqa: 40 halaqat under one program (within cap). If it is a sub-unit: a new table | data-only, or **schema-additive** | Q36 |
| Levels inside a section | one program per section | Levels as programs (ordered, named); **only new halaqat** can join them | data-only (before real enrollments) | Q35 |
| A new section category (core, training, leadership) | 3 kinds | Widen `academic_sections_kind_valid` in a **new** migration (superset list; no row rewritten); vocabulary, DTO, Flutter `SectionKind` | **schema-additive** + code | Q35, Q38 |
| Strengthening as a concurrent halaqa | unlimited concurrency | nothing | none | Q37 |
| A move / ضخ ending | COMPLETED / WITHDRAWN only | Widen `academic_enrollments_status_valid` (new migration, DROP + ADD with a superset; lossless), or a nullable transition-type column; vocabulary; events; Q28 | **schema-additive** + code | Q37 |
| Linking successive enrollments | none | Nullable self-FK (`RESTRICT`) plus index, or a moves table; an atomic move operation | **schema-additive** + code | Q37 |
| Assessment / placement record | none | A new table (or module) with **no score, criteria or capacity columns** until defined | **schema-additive** | Q37 |
| Awaiting assessment or placement | none | A **separate intake table**. *Not* an enrollment status: that would relax `academic_enrollments_ended_consistent`, escape the ACTIVE partial unique index and pass the halaqa-deactivation check | **schema-additive** | Q37 |
| Trainees who are serving staff | multi-role accounts share one user id | An extra STUDENT role (a `user_roles` row, **data**); or granting `academic.study` to a staff role (the policy constant **and** a new `role_permissions` migration, which a test pins together) | data-only, or code + data | Q38 |
| Section-scoped supervision | supervisors see nothing | A supervisor ↔ section/halaqa relationship table plus a rule in `AcademicAccess`, or a grant | **schema-additive**, or code | Q31, Q38 |
| Intakes (دفعات) | no dates on halaqat or programs; cap counts INACTIVE | Dates or terms (additive), and a cap that ignores retired rows (code) | **schema-additive** + code | Q36, Q12 |
| ARCHIVED state | ACTIVE / INACTIVE | Vocabulary value plus widened status CHECKs | **schema-additive** | Q32 |
| Development path as a recorded entity | enrollment and assignment history plus roles | A new design only if the owner wants recorded stages | later, additive | Q38 |

**Frictions that are not in the database:**

1. **Kind is immutable through the API.** Do *not* reclassify with a data
   migration: it contradicts ADR 0014 Decision 6, is a no-op on fresh
   databases (migrations run before the seed), and bypasses audit and events.
2. **A halaqa's parent is immutable**, by design. **Never reparent**
   halaqat that have enrollments: every past enrollment would silently move
   to the new program and section, and the audit cannot reconstruct where it
   was.
3. **The seed derives halaqa codes from the section.** It cannot express two
   halaqa-bearing programs in one section, and it adopts a seed-style code
   under *any* program without checking its parent. The future fix keeps
   `<section>-h<n>` for existing entries (changing the scheme would
   re-create 45 halaqat on seeded databases), adds explicit per-entry codes
   for new programs, and adds the parent check.
4. **The app flattens a section's programs into one list** and resolves route
   ids across section and program codes, although codes are unique only per
   table.
5. **Codes and kinds are hard to undo.** Nothing is deleted through the
   application and codes are never reused; this is policy, not a database
   guarantee. A wrongly seeded code stays. Names and descriptions can be
   patched freely.

---

## 9. Schema and domain changes actually necessary now

**None.** No owner statement is precise enough to implement without
inventing its meaning, and nothing in the current model blocks a later
answer. Every future change is a *new* migration, a new table or a code
change. `0007` and `0008` stay as they are. This pass is documentation and
comments only:

| Change | File |
| --- | --- |
| Owner statements recorded as the third source, with an Arabic questionnaire | `docs/owner-information.md` (new) |
| This report | `docs/architecture/academic-reconciliation.md` (new) |
| Q35–Q39 added; Q29–Q33 amended; Q9 and Q12 cross-referenced | `docs/architecture/open-questions.md` |
| Status box, qualified §1 / §5 / §11 / §13 / §15, operating rules | `docs/architecture/academic.md` |
| "Single source" wording qualified; pointer to the owner document | `README.md`, `app/README.md`, `backend/README.md` |
| UNCONFIRMED banner for the listed screens | `docs/prototype-spec.md` |
| Comment-only: the structure file is the printed profile's, provisional | `institution-structure.json` (`$comment`), `institution-structure.ts` |
| Comment-only: outcomes known to be insufficient for moves | `contracts/vocabulary.ts`, `application/enrollment.use-cases.ts` (`EndEnrollmentUseCase`), `application/structure.use-cases.ts` (`ChangeHalaqaStatusUseCase`) |
| Comment-only: relationships ignore structure status | `contracts/relationships.ts` |
| Comment-only: the trainee model is open | `identity/domain/provisional-policy.ts` |
| enrollment_ended's outcome list marked provisional; "seeded from the profile" statements qualified | `docs/architecture/events.md`, `overview.md`, `module-boundaries.md`, `persistence.md` (where they state it) |

No test's expectations changed. The `access.spec.ts` fixture that ends a
tajweed-2 enrollment as COMPLETED is described in [§7](#7-assumptions-that-must-not-be-treated-as-confirmed)
and left as it is.

One unrelated test fix went in with this pass. The Postgres suite's
cap-under-contention test assumed that `contended-0` won one of three
places that eight programs race for. When it lost, the gate failed. The test
now takes a program that exists (`test/integration/academic-postgres.spec.ts`).

---

## 10. Changes deferred until the owner answers

| Change | Class | Blocked on | Notes |
| --- | --- | --- | --- |
| Rename graded sections to the owner's wording; add the missing section(s) | data (API, then JSON) | Q35 | Record every code→name decision with date and source first (§14, H9) |
| Literacy halaqat 6–10 | data | Q35 | Tests pinned to 45 follow in the same change |
| Seed provenance split (profile vs owner entries), parent check, explicit per-entry halaqa codes | code | Q35, Q36 | Needed before any section gets a second halaqa-bearing program |
| `sec-spelling` → core / graded | code (audited change-kind op) **or** new code | Q36 | A new code detaches page-7 text and the capacity note (keyed by code) and removes the home featured card (picked from SPECIAL) |
| مدينة التهجي structure; 40 groups | data or schema-additive | Q36 | Pick a code distinct from `prog-hifz-city` and unique across sections *and* programs |
| Basic / additional marker | schema-additive | Q35 | Only if the owner gives it a meaning |
| Move / ضخ ending; enrollment linkage; atomic move | schema-additive + code | Q37 | Plus events (`events.md`), Q28 |
| Assessment / placement record; intake / awaiting-placement table | schema-additive | Q37 | No invented columns |
| Closing a halaqa with a neutral ending; ending assignments on closure | code | Q32, Q37 | Inside the existing deactivation transaction |
| Simultaneous-enrollment limit | code | Q30, Q37 | Only if the owner states one |
| Trainee eligibility | data, or code + data | Q38 | |
| Section-scoped supervision | schema-additive or code | Q31, Q38 | |
| New section kind | schema-additive + code (app too: unknown kinds are hidden) | Q35, Q38 | |
| Study field ↔ program links | schema-additive (a fields vocabulary *and* a join) | Q38 | Fields exist only in the app's `ProfileData` today |
| Intakes, dates, a cap that ignores retired halaqat | schema-additive + code | Q36, Q12 | |
| App: group halaqat by program; «المستويات» copy; certificates wiring | code | Q29, Q35, Q9 | Keep `/levels` as a redirect alias if the path ever changes |
| ADR 0015 superseding the parts of ADR 0014 the answers change | doc | all | |

**Rejected approaches.** Do not take these even after answers:

- a data migration that `UPDATE`s a section's kind;
- reparenting halaqat that have enrollments;
- `PENDING` as an enrollment status;
- re-deriving existing halaqa codes from program codes;
- owner wording in `pdf-content-extract.md`;
- editing ADR 0014's decisions.

---

## 11. Exact files and entities affected

### Entities

| Entity (table) | Affected by | How |
| --- | --- | --- |
| Section (`academic_sections`) | Q35, Q36, Q39 | rows renamed or added; kind is the friction; possibly a widened kind CHECK |
| Program (`academic_programs`) | Q35, Q36, Q33 | rows added (levels, مدينة التهجي) |
| Halaqa (`academic_halaqat`) | Q35, Q36 | rows added; possibly a marker, dates, or a sub-group table |
| Enrollment (`academic_enrollments`) | Q37, Q30 | widened status CHECK; nullable link column |
| TeacherAssignment (`academic_teacher_assignments`) | Q32, Q38 | code only (ending on closure) |
| *(new)* assessment / placement, intake, supervision scope | Q37, Q31 | new tables, additive |
| Identity roles and grants (`role_permissions`, `user_roles`) | Q38, Q31, Q1 | data rows and constants |

### Files, by what would change them

| When | Files |
| --- | --- |
| **Changed in this pass** (comments/docs) | listed in [§9](#9-schema-and-domain-changes-actually-necessary-now) |
| **Structure answers (Q35, Q36, Q39)** | `backend/src/modules/academic/application/institution-structure.json`, `institution-structure.ts`, `seed-structure.use-case.ts`, `seed.spec.ts`; `backend/test/integration/academic-postgres.spec.ts` (seed counts); `backend/test/support/academic-harness.ts` and the specs using seeded codes (`structure.spec.ts`, `teaching.spec.ts`, `relationships-contract.spec.ts`); `app/lib/data/sources/profile_data.dart`, `app/lib/data/sources/mock_data.dart`, `app/test/academic/profile_structure_test.dart`, `app/lib/data/repositories/academic/mock_academic_repository.dart`, `academic_learning_repository.dart`, `academic_catalog_repository.dart`, `app/lib/features/home/home_screen.dart`, `app/lib/features/home/widgets/home_featured_card.dart`, `app/lib/features/programs/programs_screen.dart`, `program_detail_screen.dart` |
| **Kind change** | `contracts/vocabulary.ts`, `api/academic.dto.ts`, a new migration (only for a *new* kind value), `app/lib/data/models/academic.dart` (`SectionKind`) |
| **Progression answers (Q37, Q30, Q32)** | `contracts/vocabulary.ts`, `domain/enrollment.ts`, `application/enrollment.use-cases.ts`, `application/structure.use-cases.ts`, `infrastructure/schema.ts` plus a **new** migration, `contracts/events.ts`, `docs/architecture/events.md`, the app's status parsing |
| **Access answers (Q31, Q38)** | `application/academic-access.ts`, `identity/domain/provisional-policy.ts` plus a new `role_permissions` migration; `backend/test/api/academic.api.spec.ts` (pins supervisor 403s) |
| **App wording (Q29, Q9)** | `app/lib/app/routes.dart`, `router.dart`, `features/learning_path/program_levels_screen.dart`, `core/widgets/patterns/path_stepper.dart`, `mock_data.dart`, `providers/app_providers.dart` (certificates); `app/test/navigation_test.dart`, `app/test/academic/academic_screens_test.dart` |
| **Never** | `backend/drizzle/0007_academic_core.sql`, `backend/drizzle/0008_seed_academic_permissions.sql`, `docs/pdf-content-extract.md`, ADR 0014's decisions |

---

## 12. Questions for the owner

They are tracked as [Q35–Q39](open-questions.md#q35--the-seven-core-sections-against-the-printed-profile),
with the related Q9, Q12 and Q29–Q33. The Arabic questionnaire, ready to
send, is in [owner-information.md](../owner-information.md#أسئلة-للمالكة--للإجابة-قبل-أي-تعديل-على-الهيكل).
The essential ones:

1. **Mapping.** Which printed section is المبتدئ, and which is تجويد
   الحروف (three readings)? Are the seven all the sections? Is the list order
   display-only?
2. **Literacy 5 or 10?** Does "10 basic" mean existing or standard? Is
   "additional" recorded? Who opens and closes halaqat? What does "need"
   mean?
3. **Tahajji.** Is دورة التهجي = قسم التهجي? Is مدينة التهجي the same
   (A) or separate (B)? Is a group a halaqa? Is 40 a count or a capacity?
   What is the relation to the 10 basic halaqat? Intakes?
4. **Moves.** Is assessment recorded, and is there a standard form? Is there
   an awaiting-placement period? Who places? What is نظام الضخ? What is
   the ending of a moved enrollment called? Should a path be linked? Is
   strengthening a separate halaqa? Merges and closures?
5. **Path.** Are the path stages enrollable or roles? Are they p12's tracks?
   Is specialization p5's fields? Who are the trainees? Is there a practicum?
   Is preparation a prerequisite to teach? What is the supervisor's scope?
6. **Outside the seven.** البراعم، اللغات and the accompanying programs:
   still offered, and where? The p4 audiences? What does "core" mean?
7. **Names and the public demo.** Keep the printed names anywhere? What
   should the public Pages demo show meanwhile?

---

## 13. Minimal recommended changes before the next milestone

**Before any new module:**

1. ✅ *This pass*: the owner information is recorded, the profile is labelled
   as the printed profile, unconfirmed rules are labelled, and the questions
   are written down.
2. Send the questionnaire. Get written answers to at least **Q35 (mapping,
   literacy count) and Q36 (Tahajji)**.
3. Then, in one reviewed change with **ADR 0015**:
   - record each code→name decision;
   - split the seed's provenance (profile vs owner entries);
   - add the seed's parent check and explicit per-entry halaqa codes;
   - apply the structure through the seed and the API;
   - update the pinned tests.
4. Until step 3: **do not run the seed CLI against a production or shared
   database**, and follow the operating rules in [§14](#14-hazards-and-operating-rules-while-the-reconciliation-is-open).

**What each held module needs first:**

| Module | Must be answered or done first | Why |
| --- | --- | --- |
| **Assignments** | Scope TEACHER `assignments.manage` and SUPERVISOR `assignments.read` through `ACADEMIC_RELATIONSHIPS` (or leave them unexercised); decide Q32 (does a closed halaqa's teacher keep acting?), or have the module check structure status itself; do **not** take criteria from prototype-spec TE-09 | Otherwise it bypasses the roster boundary academic enforces, and silently answers Q32 |
| **Attendance** | Same scoping for `attendance.*`; Q8 (amendment); Q12 (calendar); do **not** take the states from TE-04 | Same, plus unconfirmed vocabulary |
| **Progress** | Q29, Q37 (what a move and mastery are, whether assessment is recorded), Q38 (mastery as a stage?); do **not** take TE-08 / TE-10 criteria | Every progress figure would otherwise be an invented rule |
| **Promotion** | Q29 and Q37, fully; the move ending, linkage and assessment record designed in ADR 0015 or later | Promotion *is* the unanswered rule |

Assignments and Attendance hang off the halaqa id and
`ACADEMIC_RELATIONSHIPS`, which no structure answer changes. **Once their
preconditions above are met, they are not blocked by Q35/Q36.** Progress
and Promotion are blocked until Q37 is answered.

---

## 14. Hazards and operating rules while the reconciliation is open

| # | Rule | Why |
| --- | --- | --- |
| H1 | Do not run `npm run academic:seed-structure` against a production or shared database | Codes and kinds become permanent; later JSON edits do not update existing rows. (CI runs the seed use case only against a scratch Postgres) |
| H2 | Do not record placement corrections, support moves, ضخ moves, merges or closures as `COMPLETED`/`WITHDRAWN` in real data | The outcome is immutable (409 on rewrite); it would mislabel the student permanently |
| H3 | Do not open real halaqat through the API with seed-style codes (`<section>-h<n>`) until basic/additional is answered | The seed adopts them as "basic" without a parent check |
| H4 | Do not create a second halaqa-bearing program inside a PROGRESSIVE or SPECIAL section | The app flattens a section's programs, and the seed derives halaqa codes per section |
| H5 | Keep every new code unique across **both** sections and programs | The app resolves route ids across both tables; the database checks uniqueness per table only |
| H6 | Do not reparent halaqat; settle levels inside sections **before** real enrollments | Past placements would silently move |
| H7 | Do not reclassify a section by data migration | §8, friction 1 |
| H8 | Consumers of `ACADEMIC_RELATIONSHIPS` must not read `isTeaching` as "this halaqa is running" | It ignores the halaqa's, program's and section's status (Q32) |
| H9 | Before any rename or retirement through the API, record the code→name mapping (date, source) in the ADR | The audit keeps field *names*, not values; renames cannot be reconstructed from history (Q11) |
| H10 | An assigned teacher can read a halaqa's ended enrollments, including students from before their assignment | Q31 now asks whether that is intended |
| H11 | The halaqa cap (200 per program) counts INACTIVE halaqat | If Tahajji runs 40 groups per intake, 5 intakes fill it (Q12, Q36) |
| H12 | **The public GitHub Pages demo** is rebuilt from this branch on every push (`.github/workflows/deploy-pages.yml:15`), in demo mode. It shows the printed 5/45 structure, the demo lock rule, "levels" and sample certificates | Feedback on the demo is not confirmation of those rules. Any app-copy change goes public on push. Whether it stays up unchanged is asked (questionnaire item 47) |
| H13 | Notifications and deep links use ids, not codes or names | Renames are safe for them |
| H14 | Changing a role's permissions is never "no change": it needs the provisional-policy constant **and** a new `role_permissions` migration (a test pins both) | Trainee eligibility (Q38) |

---

## Appendix — how this was audited

- **Six independent audits**, each over the whole repository from one angle:
  1. structure and seed;
  2. enrollment and progression;
  3. lifecycle and access;
  4. Tahajji and the special sections;
  5. the Flutter app and documents;
  6. schema capability.

  Each returned current facts with file and line evidence, the relevant owner
  facts, conflicts, safe and unconfirmed assumptions, necessary changes,
  deferred changes, owner questions and a schema verdict.
- **Adversarial verification** of 59 claims against the code:
  - 37 confirmed;
  - 19 partially correct, and corrected here;
  - 3 refuted and not adopted: reclassifying a kind by data migration,
    reparenting halaqat, and reading the owner's list order as a sequence.

  The verifier also listed contradictions between the audits and
  invented-rule leanings, and both were resolved as recorded above.
- **A completeness critic** added:
  - the public Pages demo;
  - the "levels" wording;
  - the app's flattening of programs;
  - mock certificates;
  - the prototype-spec screens for the held modules;
  - rename traceability;
  - the pre-committed "When answered" texts;
  - tests that pin the audited decisions;
  - intakes;
  - the container nature of the accompanying section;
  - the page-4 audiences;
  - notifications.
- Nothing from the audits was adopted as a rule. Where they disagreed, the
  more conservative reading that invents nothing was taken.
