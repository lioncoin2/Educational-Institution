# Academic

**State: implemented (Core V1).** The institution's academic structure —
sections, programs, halaqat — and who is in it: which students are enrolled
in which halaqa, and which teachers teach it. Decisions are recorded in
[ADR 0014](decisions/0014-academic-core-v1.md).

**This is a foundation, not a feature set.** Assignments, attendance,
progress, certificates, a teacher's workspace, an owner's dashboard and
reports will all hang off the halaqa and the two relationships defined here —
without changing them. Nothing in V1 grades, schedules, promotes or completes
anyone: the institution has not said how, and none of it is invented
([§15](#15-unresolved-academic-policies)).

---

## 1. Terminology

The project's approved terms, as the profile uses them. Code uses the English
column; the app shows the Arabic one.

| Arabic | Code | What it is |
| --- | --- | --- |
| قسم | `Section` | A top-level educational area of the institution (page 6–10 of the profile) |
| الأقسام المتدرجة | `PROGRESSIVE` | The five graded sections of page 6 — مساري's ladder |
| الأقسام الخاصة | `SPECIAL` | التهجي، البراعم، اللغات (pages 7–9) |
| البرامج المرافقة | `ACCOMPANYING` | The page-10 group: مدينة الحفاظ، علوم النحو، المقارئ، المتون |
| برنامج | `Program` | An educational offering inside one section |
| حلقة / حلقات | `Halaqa` / `halaqat` | The group students are enrolled in and teachers teach |
| تسجيل | `Enrollment` | A student in a halaqa, over a period of time |
| تكليف تدريس | `TeacherAssignment` | A teacher on a halaqa, in a role, over a period of time |
| معلّمة / مساعدة | `TEACHER` / `ASSISTANT_TEACHER` | The two teaching roles, as identity already names them |

"Halaqa" is never a teacher's class list or a chat group: messaging's groups
are messaging's. A halaqa is academic's, and other modules refer to it by id.

---

## 2. The model

```
 Section ──1:n──▶ Program ──1:n──▶ Halaqa ──1:n──▶ Enrollment ──▶ account id (identity)
   kind                                  └───1:n──▶ TeacherAssignment ──▶ account id
   PROGRESSIVE | SPECIAL | ACCOMPANYING                  role TEACHER | ASSISTANT_TEACHER
```

| Entity | Identity | Holds | Never holds |
| --- | --- | --- | --- |
| Section | UUID + unique `code` | name, kind, order, description, status | its programs' data |
| Program | UUID + unique `code` | its section's **id**, name, order, description, status | the section's name or kind (no duplication) |
| Halaqa | UUID + unique `code` | its program's id, name, order, status | a schedule, a teacher, a capacity |
| Enrollment | UUID | student's account id, halaqa id, status, enrolled/ended at and by | the student's name, email or account state |
| TeacherAssignment | UUID | teacher's account id, halaqa id, role, status, started/ended at and by | the teacher's name, qualifications or account state |

- **Codes** (`dep-literacy`, `prog-nahw`, `dep-letters-h4`) are stable,
  readable identifiers: lower-case ASCII slugs, 2–64 characters, never
  changed after creation. They are what routes, seeds and the app's own
  profile data share. **Names are never identifiers**: a section can be
  renamed without breaking anything that refers to it.
- **Accounts are referenced, not copied.** Enrollment and assignment hold
  identity's user id — no foreign key across modules, no name, no email, no
  role, no account status. Who someone is, and whether their account is
  usable, is identity's answer, asked through its contracts
  ([§6](#6-people-and-privacy)).
- **Nothing else is here.** No curriculum, lesson, level, schedule, capacity,
  age range, prerequisite, grade or completion rule: the profile states none
  of them as rules, so none is modelled ([§15](#15-unresolved-academic-policies)).

---

## 3. Lifecycle

Every transition is an explicit, named operation — there is no "set status".

| Entity | States | Transitions |
| --- | --- | --- |
| Section, Program, Halaqa | `ACTIVE`, `INACTIVE` | created ACTIVE; `activate` / `deactivate` (idempotent). Never deleted |
| Enrollment | `ACTIVE` → `COMPLETED` \| `WITHDRAWN` | `enroll` creates ACTIVE; `end(outcome)` ends it once. Re-enrolling later is a new record |
| TeacherAssignment | `ACTIVE` → `ENDED` | `assign` creates ACTIVE; `end` ends it once. Re-assigning later is a new record |

- **History is kept.** Ended enrollments and assignments stay, with who ended
  them and when. Foreign keys inside the module are `RESTRICT`: a halaqa,
  program or section that history refers to cannot be deleted, even by SQL.
- **Idempotent writes.** Enrolling a student who is already enrolled answers
  the existing enrollment (HTTP 200, not 201) and records nothing. Ending an
  enrollment twice with the same outcome is a no-op; with another outcome it
  is refused (`academic.enrollment_already_ended`, 409) — an outcome is never
  silently rewritten. The same holds for assignments and their roles.
- **Deactivating structure closes it to new enrollment.** An inactive
  section, program or halaqa refuses new enrollments (412,
  `academic.section_inactive` / `program_inactive` / `halaqa_inactive`).
  Current students of an inactive program or section stay enrolled, and their
  history stays readable.
- **A halaqa with ACTIVE enrollments cannot be deactivated** (412,
  `academic.halaqa_has_active_enrollments`): end the enrollments first, with
  the outcome the institution chooses. The alternative — ending them
  automatically — would invent an outcome for every student. Teacher
  assignments are left as they are (Q32).
- **Account state is not academic state.** Suspending an account does not end
  its enrollments; restoring it finds them where they were. Only an ACTIVE
  account can be newly enrolled or assigned.

---

## 4. Invariants, and who enforces them

| Invariant | Domain / application | Database |
| --- | --- | --- |
| One ACTIVE enrollment per student and halaqa | `enroll` finds the existing one | partial unique index `academic_enrollments_active_unique` (student, halaqa) `WHERE status = 'ACTIVE'`; `INSERT … ON CONFLICT DO NOTHING` |
| One ACTIVE assignment per teacher and halaqa | `assign` finds it; another role is a conflict | `academic_teacher_assignments_active_unique` |
| A student may be in several halaqat; a halaqa may have several teachers; a teacher may teach several halaqat | nothing limits them (Q30, Q31) | no constraint |
| No new enrollment where the placement is inactive | `openForEnrollment(section, program, halaqa)` | the three rows are read `FOR SHARE` inside the enrollment's transaction, so a concurrent deactivation waits (or wins first and is seen) |
| No ACTIVE enrollment in an INACTIVE halaqa | deactivation checks | the halaqa row is locked `FOR UPDATE` before counting its active enrollments |
| `ended_at` set exactly when not ACTIVE, never before the start | `ended(...)` | `*_ended_consistent`, `*_ended_after_*` checks; `greatest()` on write so a lagging clock never moves time back |
| Codes are unique and well-formed | `normalizeCode` | `UNIQUE (code)`, `*_code_shape` |
| Names, descriptions and positions are bounded; no control or bidi-override characters | `text.ts` | length and range checks |
| Status, kind and role are from the vocabulary | vocabulary guards | `CHECK (… in (…))` |
| Caps (50 sections, 50 programs per section, 200 halaqat per program) | technical bounds, not policy | `pg_advisory_xact_lock` per parent while counting |

Postgres enforces every invariant concurrency could break; the integration
suite proves each under contention (20 simultaneous enrollments → one row;
enrollment racing deactivation → never both).

---

## 5. Authorization

Permissions say **what kind of act** someone may attempt; relationships say
**which halaqa** it may touch. Neither is enough alone.

| Permission | Means | Provisional holders |
| --- | --- | --- |
| `academic.read` | read the catalogue, and one's **own** academic record | every role |
| `academic.manage` | change structure, enroll, assign, read anyone's academic history | OWNER, ADMIN |
| `academic.teach` | *eligible* to be assigned to teach — grants no access by itself | TEACHER, ASSISTANT_TEACHER (+ OWNER, ADMIN) |
| `academic.study` | *eligible* to be enrolled — grants no access by itself | STUDENT (+ OWNER, ADMIN) |

`teach` and `study` exist so academic never branches on a role name: "may
this account be enrolled?" is identity's answer (`AccountDirectory.withPermission`
— ACTIVE, and holding `academic.study`). OWNER and ADMIN hold them because
the no-escalation rule requires a granter to hold what the role they grant
holds ([authorization.md §4](authorization.md)); that this makes them
enrollable is recorded as part of Q30.

**Resource-level rules** (in `AcademicAccess`, after the route's permission):

| Read | Who |
| --- | --- |
| Catalogue, one section / program / halaqa | anyone with `academic.read` — the structure is not private |
| A halaqa's students or teachers | `academic.manage`; or `academic.teach` **and** an ACTIVE assignment to **that** halaqa. Anyone else: 403 `academic.halaqa_access_denied` |
| Someone's enrollment or teaching history | `academic.manage` only |
| `/academic/me…` | the caller's own record — no route takes a person's id |

A teacher's access ends the moment their assignment ends, and also when their
account no longer holds `academic.teach`: an assignment alone is not enough.
Supervisors see no rosters — what they may see is not decided (Q31). An
unknown halaqa is 404 to everyone; a known one the caller may not read is 403
(its existence is public — the catalogue lists it).

Every route declares its permission (`@RequirePermission`); an architecture
test maps all 27 routes to `academic.read` or `academic.manage` and fails on
an undeclared one.

---

## 6. People and privacy

- **Names come from identity, a page at a time.** A roster page asks
  identity's `AccountDirectory.describe` once for every account on it (at most
  1,000 ids per call), never once per row. An account identity no longer
  knows is shown as a gap (`displayName: null`), never as an error.
- **What a student sees:** their own enrollments, where each sits, and each
  one's teachers by display name and role. Never a classmate, never an
  account's state, never who enrolled them.
- **What a teacher sees:** the students of the halaqat they teach, by display
  name — never an email, and nothing outside those halaqat.
- **No email anywhere.** Academic reads no identifier; the API test asserts
  that no academic response in the whole suite contains an `@`.
- **Administrative metadata** (`enrolledBy`, `endedBy`, `assignedBy`) is
  stored for the audit trail and returned to no one.

---

## 7. Reads and pages

- **Catalogue reads are bounded single queries** (the caps above bound
  them): all sections, all programs, and ACTIVE halaqat counted per program in
  one grouped query.
- **Every list that grows is keyset-paginated** — no `OFFSET`. A cursor is an
  opaque `(instant, id)`: rosters and teacher lists in enrollment order
  (oldest first), histories newest first. Page sizes have defaults and
  ceilings (roster 50/200, history 20/100); a forged cursor is 422
  `academic.cursor_invalid`.
- **Order is stable:** positions, then code; instants, then id — equal
  timestamps never reorder a page.
- **`/academic/me` is bounded:** up to 200 current relationships of each
  kind, with `truncated: true` when there are more; the teachers of all the
  student's halaqat come from one query and one directory call.

Which index serves which list is in [§10](#10-database); the integration suite
asserts the important plans with `EXPLAIN`.

---

## 8. Events

Published after the database has the change, through the platform event bus.
**Payloads carry ids, codes, statuses and field names only** — never a name,
an email, a message, or anything personal. No subscriber consumes them yet:
academic notifications are not defined (Q28), and attendance and reporting
do not exist.

| Event | Payload | `aggregateId` |
| --- | --- | --- |
| `academic.section.created` | sectionId, code, kind, status | section |
| `academic.section.updated` | sectionId, changed (field names) | section |
| `academic.section.activated` / `.deactivated` | sectionId | section |
| `academic.program.created` | programId, sectionId, code, status | program |
| `academic.program.updated` | programId, sectionId, changed | program |
| `academic.program.activated` / `.deactivated` | programId, sectionId | program |
| `academic.halaqa.created` | halaqaId, programId, code, status | halaqa |
| `academic.halaqa.updated` | halaqaId, programId, changed | halaqa |
| `academic.halaqa.activated` / `.deactivated` | halaqaId, programId | halaqa |
| `academic.student.enrolled` | enrollmentId, studentUserId, halaqaId, programId, sectionId | **halaqa** |
| `academic.student.enrollment_ended` | enrollmentId, studentUserId, halaqaId, outcome | **halaqa** |
| `academic.teacher.assigned` | assignmentId, teacherUserId, halaqaId, role | **halaqa** |
| `academic.teacher.assignment_ended` | assignmentId, teacherUserId, halaqaId | **halaqa** |

A halaqa's roster is one stream, so its changes keep their order on any
future partitioned transport. A no-op (repeated enroll, repeated end,
unchanged edit) publishes nothing.

---

## 9. Audit

Every change — structure, enrollment, assignment — is one audit entry with
the same action name as its event, the actor, the resource (`academic.section`,
`.program`, `.halaqa`, `.enrollment`, `.teacher_assignment`) and metadata of
ids, codes and field names. **Reads are not audited.** A no-op records
nothing. What the seed creates is recorded with no actor and
`source: institution-profile`.

---

## 10. Database

Migration `0007_academic_core` (schema, generated from `schema.ts`) and
`0008_seed_academic_permissions` (the two permission rows and their
provisional grants — reference data, generated from the TypeScript
constants). Both are additive; neither seeds the structure.

| Table | Key constraints |
| --- | --- |
| `academic_sections` | `code` unique; kind, status, order, name, description checks |
| `academic_programs` | `code` unique; `section_id` → sections `RESTRICT` |
| `academic_halaqat` | `code` unique; `program_id` → programs `RESTRICT` |
| `academic_enrollments` | `halaqa_id` → halaqat `RESTRICT`; partial unique ACTIVE (student, halaqa); status/ended consistency |
| `academic_teacher_assignments` | `halaqa_id` → halaqat `RESTRICT`; partial unique ACTIVE (halaqa, teacher); role, status, ended consistency |

No foreign key points outside the module (the Postgres suite checks the
catalogue), and no academic code imports another module's schema (the
architecture suite checks the imports). Indexes exist for a query each:

| Index | Serves |
| --- | --- |
| `academic_enrollments_halaqa_idx (halaqa_id, status, enrolled_at, id)` | a halaqa's roster, by status, keyset |
| `academic_enrollments_student_idx (student_user_id, enrolled_at, id)` | a student's history and current enrollments |
| `academic_teacher_assignments_halaqa_idx (halaqa_id, status, started_at, id)` | a halaqa's teachers; the teachers of a student's halaqat |
| `academic_teacher_assignments_teacher_idx (teacher_user_id, started_at, id)` | a teacher's assignments |
| `academic_programs_section_idx (section_id, sort_order, code)` | a section's programs in order |
| `academic_halaqat_program_idx (program_id, sort_order, code)` | a program's halaqat in order |
| the two partial unique indexes | "is X enrolled in / teaching H now?" and idempotent writes |

Only academic's infrastructure imports academic's schema, and academic never
imports identity's, messaging's, notifications' or files' (architecture test).

---

## 11. Seeding the institution's structure

**One source.** `backend/src/modules/academic/application/institution-structure.json`
is the structure as the profile states it. The seed reads it; the app's
`ProfileData` and its demo repository are held to it by
`app/test/academic/profile_structure_test.dart`, so the two cannot drift.

**What it holds — and nothing more:**

| Section (code) | Kind | Page | Programs | Halaqat |
| --- | --- | --- | --- | --- |
| قسم محو الأمية (`dep-literacy`) | PROGRESSIVE | 6 | one, named after it (provisional, Q33) | 5 |
| قسم تلقين الحروف (`dep-letters`) | PROGRESSIVE | 6 | one | 10 |
| قسم تجويد مبتدئ (`dep-tajweed-1`) | PROGRESSIVE | 6 | one | 10 |
| قسم تجويد متوسط (`dep-tajweed-2`) | PROGRESSIVE | 6 | one | 10 |
| قسم تجويد متقدم (`dep-tajweed-3`) | PROGRESSIVE | 6 | one | 10 |
| قسم التهجي (`sec-spelling`) | SPECIAL | 7 | none | — |
| قسم البراعم (`sec-kids`) | SPECIAL | 8 | none | — |
| قسم اللغات (`sec-languages`) | SPECIAL | 9 | none | — |
| البرامج المرافقة (`accompanying`) | ACCOMPANYING | 10 | مدينة الحفاظ، علوم النحو، المقارئ، المتون | none |

45 halaqat, named by number (`الحلقة 1`…) with codes `<section>-h<n>` — the
profile gives counts, not names. **Not seeded, because the profile does not
state them as structure:** no student, teacher, enrollment, assignment,
progress or description; البراعم's three levels, النحو's five levels and
the five languages are not turned into programs or halaqat; التهجي's
"استيعاب 40 مجموعة" is not turned into 40 halaqat; the six study fields
(page 5) are not linked to any program.

**How it runs.** Seeding is an explicit, idempotent bootstrap step, not a
schema migration — the structure is institutional data that administrators
will change:

- **With Postgres:** `npm run academic:seed-structure` (after
  `npm run db:migrate`), acting as a system principal holding
  `academic.manage`. It creates what is missing, **by code**, and never
  overwrites what exists: a rename, a deactivation or a new halaqa made since
  survives every re-run. Concurrent runs create each row once.
- **Without a database** (development, API tests): the in-memory store is
  seeded at boot, so the app has the structure out of the box.

Every created row is audited (`source: institution-profile`) and announced.

---

## 12. API

All routes need a bearer token (401 otherwise). Writes answer the resource;
creating answers 201, finding what exists 200.

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /academic/sections` | read | the whole catalogue, each section with its programs and active halaqa counts |
| `GET /academic/sections/:id` · `/programs/:id` · `/halaqat/:id` | read | a program with its section and halaqat; a halaqa with where it sits |
| `POST /academic/sections` · `/programs` · `/halaqat` | manage | code, name, order (+ kind / parent); 409 `academic.code_taken`, 412 caps |
| `PATCH /academic/sections/:id` · `/programs/:id` · `/halaqat/:id` | manage | name and order (and description, for sections and programs) — code, kind and parent never change |
| `POST /academic/{sections,programs,halaqat}/:id/activate` · `/deactivate` | manage | idempotent |
| `GET /academic/halaqat/:id/students?status&cursor&limit` | read + resource rule | roster by display name |
| `POST /academic/halaqat/:id/enrollments` `{studentUserId}` | manage | 201 new / 200 existing; 412 closed; 422 not eligible |
| `POST /academic/enrollments/:id/end` `{outcome}` | manage | `COMPLETED` \| `WITHDRAWN` |
| `GET /academic/students/:userId/enrollments` | manage | history, newest first |
| `GET /academic/halaqat/:id/teachers?status&cursor&limit` | read + resource rule | |
| `POST /academic/halaqat/:id/teachers` `{teacherUserId, role}` | manage | 201 / 200; 409 other role; 422 not eligible |
| `POST /academic/teacher-assignments/:id/end` | manage | |
| `GET /academic/teachers/:userId/assignments` | manage | |
| `GET /academic/me` · `/me/enrollments` · `/me/teaching` | read | the caller's own |

Unknown fields are refused (400); a value outside the vocabulary is 400 at
the DTO; a domain rule is 422 with a precise code (`academic.code_invalid`,
`academic.name_invalid`, …).

---

## 13. For other modules: `ACADEMIC_RELATIONSHIPS`

The one thing academic exports. Attendance, assignments, a teacher's
workspace and notifications will ask it instead of reading academic's tables:

- `isEnrolled(studentUserId, halaqaId)` / `isTeaching(teacherUserId, halaqaId)`
  — from ACTIVE records only;
- `activeStudentIds(halaqaId, {cursor, limit})` — a halaqa's current students
  in enrollment order, at most 1,000 a page.

It says nothing about account state: whether an account may sign in is
identity's question, asked separately.

---

## 14. The Flutter app

```
screens → providers → CatalogRepository · LearningRepository · InstitutionRepository · ProgressRepository
                          │  (adapters: data/repositories/academic/)
                          ▼
                    AcademicRepository ──▶ HttpAcademicRepository  (API_BASE_URL set)
                                      └──▶ MockAcademicRepository  (the demo: the profile's structure)
```

- **The screens did not change their layouts.** Adapters fill the screens'
  own models from academic data; the screens render what is present.
- **The catalogue** (home, programs, program detail) is read through the
  academic repository in both modes. In the demo it is field-for-field what
  it was. Against the server, names and counts come from the records, and the
  profile's descriptive text (descriptions, items, badges, levels, capacity)
  is kept by code, with its page chip — unless the institution has written
  its own description, which then replaces it and claims no page.
- **مساري, the halaqat, a halaqa, progress and profile** use the real
  adapters against the server and keep their marked placeholder data in the
  demo. Against the server they show what is recorded — the learner's
  enrollments, where each sits, its teachers — and **no progress**: no
  percentage, no "3 of 10", no schedule, no lessons, no target group, and
  nothing marked "بيانات تجريبية". A rung the learner is not enrolled in
  claims nothing (neither done, nor open, nor locked). Nobody enrolled: said
  plainly ("لا يوجد تسجيل نشط…") — not "بانتظار التسجيل", which is not a
  recorded state.
- **Nobody signed in.** The server answers nobody, so home and programs show
  the printed profile's structure (marked with its pages, as in the demo)
  and switch to the records once someone signs in; مساري, a program's
  halaqat and a halaqa ask to sign in rather than offering a retry.
- **Read-only.** The app offers no enrollment, assignment or structure
  editing — those are staff acts, and self-enrollment is not the
  institution's stated policy.
- **Defensive parsing.** An unknown kind, status or role is kept as unknown
  and never shown as open, active or current; an unreadable item is skipped.
- **Errors surface.** Academic reads are not retried silently; the screen
  shows the error with its retry.

---

## 15. Unresolved academic policies

Provisional defaults make V1 executable; each is labelled and listed in
[open-questions.md](open-questions.md):

| | Question | Provisional default |
| --- | --- | --- |
| Q29 | Are the progressive sections strictly sequential; are the special sections parallel; what moves a student between sections or halaqat? | `order` is display position only; no prerequisite, promotion or lock anywhere |
| Q30 | Self-enrollment? Several active halaqat? What completes a halaqa? Transfers? | staff-only enrollment; no limit; staff choose COMPLETED/WITHDRAWN; a transfer is end + enroll |
| Q31 | Several halaqat per teacher, several teachers per halaqa? What may teachers and supervisors see outside their halaqat? | many-to-many; teachers see their own halaqat's rosters only; supervisors none |
| Q32 | Who may deactivate structure, and what happens to its assignments and enrollments? | OWNER and ADMIN; enrollments must be ended first; assignments untouched |
| Q33 | How is the structure really organised inside a section, and what are halaqat called? | one program per progressive section, named after it; halaqat by number |
| Q34 | Page 8's disputed word | no description seeded; the app's existing text unchanged |

---

## 16. Tested

Backend: domain rules; every use case (structure, enrollment, teaching,
access, reads, seeding, the relationships contract); the API over HTTP with
the real application (401 on all 27 routes, 403 by role, resource scope,
201/200 idempotency, 400/404/409/412/422 semantics, no email in any
response); Postgres (constraints by name, RESTRICT keys, no cross-module keys,
concurrency races, caps under contention, history paging, `EXPLAIN` plans,
seeding twice and concurrently, migrations on a database already in use);
architecture boundaries. Flutter: parsing, the HTTP repository, the adapters,
the profile pin, the screens in both modes (loading, empty, error and retry,
sign-in, unknown statuses), and source boundaries.

---

## 17. Deferred

- Anything that reads or writes progress: attendance, lessons, memorisation,
  assignments, grades, completion, certificates.
- A teacher's workspace and an owner's dashboard (the endpoints they need
  exist: rosters, histories, `/academic/me` teaching).
- Transfers as one operation; bulk enrollment; archiving beyond
  deactivation.
- Academic notifications (Q28): the events exist; no subscriber does.
- Enrollments in accompanying programs appear in the program's halaqat
  (marked current) but not on مساري's ladder, which is the page-6 ladder.
- Multilingual names (Q11): one `name` column each, Arabic as the profile
  states it.
