# 0014 — Academic Core V1: academic owns the structure and who is in it

**Status:** Accepted
**Date:** 2026-09-23

Implements the `academic` module, until now a boundary with placeholder
contracts. **Supersedes the part of the Foundation's module boundaries** that
put enrolment in `operations` and referred to a halaqa's teacher through a
`people` person id (the placeholder `ProgramRef` / `LevelRef` / `HalaqaRef`
contracts are removed). Builds on [0005](0005-authorization-architecture.md)
(permissions + policy), [0006](0006-event-architecture.md) (events) and
[0008](0008-drizzle-over-prisma.md) (Drizzle, migrations). The design in full
is [academic.md](../academic.md).

## Context

Every later capability — assignments, attendance, progress, certificates, a
teacher's workspace, an owner's dashboard, reports — needs the same few facts:
what the institution's sections, programs and halaqat are, which students are
in a halaqa, and who teaches it. If those facts are modelled loosely now
(names as keys, a teacher column on the halaqa, an "enrolled" flag on a
student), each later module rewrites them.

The brief fixed the properties: a section → program → halaqa hierarchy;
enrollment and teacher assignment as dated relationships with history; no
deletion of anything history refers to; invariants enforced by the database;
resource-level authorization (a global TEACHER role is not access to every
halaqa); privacy (no student sees another's record, no emails); cursor
pagination and batched identity lookups; events and audit without personal
data; one source for the profile-derived structure; the Flutter screens fed
through a repository, with mock mode intact — and no invented curriculum,
schedule, requirement, grading, promotion or completion rule.

The institution profile gives the structure only partly: five graded sections
with halaqat counts (page 6), three special sections (pages 7–9), four
accompanying programs (page 10). It names no program inside a section.

## Decision

1. **Academic owns the structure and both relationships.** Sections, programs
   and halaqat; `Enrollment` (student ↔ halaqa) and `TeacherAssignment`
   (teacher ↔ halaqa, in a role). Both relationships reference identity's
   **user ids** — the accounts that sign in — with no foreign key across
   modules and no copied name, email, role or account state. Operations keeps
   what happens on a date (sessions, attendance) and will consume academic's
   contract; people keeps the human record. A halaqa has no teacher column:
   teaching is an assignment, so a halaqa may have several teachers and a
   teacher several halaqat.

2. **The hierarchy, mapped to the profile without invention.** Section
   `kind` is `PROGRESSIVE` (page 6), `SPECIAL` (pages 7–9) or `ACCOMPANYING`
   (page 10). Each progressive section gets **one provisional program named
   after itself** (the profile names none; open question Q33); special
   sections get no programs; the four accompanying programs sit under one
   section named by the page's heading. `order` is a display position, never
   a prerequisite (Q29). Codes (`dep-literacy`, `dep-literacy-h3`) are the
   stable identifiers — shared with the app's routes and its profile data;
   names are never keys.

3. **Explicit transitions; nothing deleted.** Structure is `ACTIVE` or
   `INACTIVE`, changed only by `activate` / `deactivate`. An enrollment is
   `ACTIVE` until staff end it as `COMPLETED` or `WITHDRAWN`; an assignment
   is `ACTIVE` until `ENDED`. Ending is idempotent for the same outcome and
   refused for another. Re-enrolling creates a new row; history is kept, and
   foreign keys inside the module are `RESTRICT`. Deactivating a section or
   program closes new enrollment; a halaqa cannot be deactivated while
   students are actively enrolled in it — ending them automatically would
   invent their outcome.

4. **The database enforces what concurrency could break.** Partial unique
   indexes for one ACTIVE enrollment per (student, halaqa) and one ACTIVE
   assignment per (halaqa, teacher), written with `INSERT … ON CONFLICT DO
   NOTHING`; the halaqa, program and section rows locked `FOR SHARE` while an
   enrollment is written and `FOR UPDATE` while a halaqa is deactivated;
   transaction-scoped advisory locks for the structural caps; check
   constraints for every status, kind, role, code shape, length and date
   ordering.

5. **Eligibility is a permission; access is a relationship.** Two new
   permissions, `academic.teach` and `academic.study`, grant nothing by
   themselves: they say which ACTIVE accounts may be assigned or enrolled,
   answered by identity's `AccountDirectory.withPermission`, so academic never
   branches on a role name. `academic.read` covers the catalogue and one's own
   record; `academic.manage` covers changes and other people's histories. A
   halaqa's roster is readable by `academic.manage`, or by `academic.teach`
   **with an ACTIVE assignment to that halaqa**. Grants are provisional (Q1,
   Q30, Q31); OWNER and ADMIN hold the two new ones because the no-escalation
   rule requires it.

6. **One source for the profile-derived structure; seeding is a step, not a
   migration.** `institution-structure.json` holds exactly what the profile
   states. An idempotent seed creates what is missing **by code** and never
   overwrites what exists; it runs as an explicit command against Postgres
   and at boot for the in-memory store. The app's `ProfileData` is held to
   the same file by a test. Migrations carry the schema and the permission
   reference data only.

7. **Reads are bounded and batched.** Keyset cursors (never `OFFSET`) for
   rosters and histories; bounded single queries for the catalogue; one
   directory call per page for display names; `/academic/me` bounded, with a
   `truncated` flag.

8. **Facts without personal data.** Sixteen `academic.*` events and the same
   sixteen audit actions, carrying ids, codes, statuses and field names only.
   Enrollment and teaching events use the halaqa as their aggregate, so a
   roster's changes stay ordered. No subscriber yet (Q28).

9. **One contract out: `ACADEMIC_RELATIONSHIPS`.** `isEnrolled`,
   `isTeaching`, `activeStudentIds` (paged) — for the modules that will act
   per halaqa. Nobody reads academic's tables.

10. **The app reads through `AcademicRepository`, under unchanged screens.**
    HTTP and mock implementations; adapters fill the screens' existing models.
    Against the server, what is not recorded is not drawn — no progress, no
    percentage, no schedule — and nothing real is marked as demo; the demo
    keeps its marked placeholder data. The app writes nothing: enrollment and
    assignment are staff acts, and no self-enrollment is invented.

## Consequences

- Attendance, assignments and a teacher's workspace can be built on
  `ACADEMIC_RELATIONSHIPS` and the halaqa id without touching this model.
- A rename, a new halaqa or a deactivation by an administrator survives every
  re-run of the seed.
- The provisional program per progressive section is visible in the data
  (its name repeats the section's). If the institution organises sections
  differently, programs are renamed or added — no schema change (Q33).
- Owners and admins are technically enrollable and assignable; whether they
  should be is part of Q30.
- Deactivating a halaqa takes an explicit decision per student first.

## Alternatives considered

- **Enrolment in `operations`, as the Foundation planned.** Rejected: who is
  in a halaqa is the academic fact every module needs; what happens on a
  date is operations'. Operations will read this contract.
- **Halaqat directly under sections (no program level).** Closer to the
  profile, but the brief requires programs, and later offerings need one. The
  gap is a provisional program per section, recorded as Q33.
- **A teacher column on the halaqa.** Rejected: one teacher per halaqa is not
  stated, and it loses history.
- **One ACTIVE enrollment per student overall.** Rejected: the profile states
  no such limit (Q30).
- **Checking role names** (`roles.includes('STUDENT')`). Rejected: roles are
  data and change; permissions are the policy seam identity already has.
- **Seeding in a migration.** Rejected: the structure is institutional data
  administrators change; a migration cannot "create if missing, never
  overwrite" by code, and re-running it must not undo their work.
- **Ending enrollments automatically when a halaqa closes.** Rejected: it
  would invent an outcome (completed? withdrawn?) for every student.
- **A generic "set status" endpoint.** Rejected: explicit operations, each
  with its own rule, audit action and event.
- **404 for a halaqa a teacher is not assigned to.** Rejected: halaqat are
  public in the catalogue; hiding one's existence would be pretence. Its
  roster is what is private, so the answer is 403.
