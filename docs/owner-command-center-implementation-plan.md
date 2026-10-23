# Owner Command Center — Implementation Plan

**Type.** Planning & documentation only. **No implementation is authorized by this document.** It plans how to grow the *existing* Owner Command Center; it is not a new project or a rebuild.
**Based on.** `docs/owner-features-current-state-gap-analysis.md` (the 2026-10-22 audit), `docs/owner-features-roadmap.md` (the owner requirement spine), `docs/owner-decision-register.md`, `docs/architecture/architecture-index.md`, the open-questions, and **first-hand re-reads of the reporting module source** (cited below).
**Repo state (re-verified 2026-10-23, not assumed).** HEAD `c908916`, branch `claude/trial-integration-sprints-52-61`, **0 staged**, **119** working-tree entries. The uncommitted **A+D** work (community↔halaqa m:n + program cover: `backend/drizzle/0030_*.sql`, `0031_*.sql` untracked, + communities/academic edits) is **present and preserved** — this plan neither depends on moving it nor touches it.
**Non-negotiables.** Academic model stays **Section → Program → Halaqa** (no `Level`). No feature is "done" until its functional path is complete and its permissions + core states are tested. No invented numbers, no automatic actions without an owner policy + permission.

---

## 1. Goal Summary

The Owner Command Center is the owner's single home for running the institution's day: a **server-resolved registry of factual widgets + quick actions**, each hidden unless the viewer holds its permission, that **grows one widget/action at a time** and **links out** to the real screens that already do the work — never a monolithic screen, never a parallel system.

**The foundation already exists and is real** (`GET /reporting/command-center`, 3 factual widgets, 4 quick actions, per-viewer hiding, Flutter `features/command_center`). This plan does **two** things:

1. **Complete the hub with what is genuinely buildable now** — make the existing facts navigable (drill-through), add a *today's lessons* tile over the built scheduling table, and add a *leadership audit-trail* read over the already-written audit log. All reuse existing data; none invents policy.
2. **Sequence the policy-gated centers** (tasks/التمام, absence/coverage, assignments/grading, main-halaqa/prep, derived attendance) so each becomes **one additive vertical + one command-center tile** the moment the owner states the one policy it needs — and **stays stopped** until then.

The design principle is the command center's own, quoted from its contract (`reporting/contracts/index.ts`): *"Adding 'pending decisions' later means registering one more widget, never editing a dashboard component — the requirement that the command centre must grow without being rewritten."*

---

## 2. Current-State Map (the reuse spine)

**Backend `reporting` module** (read-only, owns no table):
- `api/reporting.controller.ts` — `GET /reporting/command-center`, `@RequirePermission(reports.read)`, `DatabaseUnavailableInterceptor` (503 when store down). The **only** reporting route.
- `application/get-command-center.use-case.ts` — re-authorizes `reports.read`; iterates `WIDGET_PROVIDERS`, **skips any widget whose `requiredPermission` the viewer lacks (its `resolve()` is never called → no data leak)**; filters `COMMAND_ACTIONS` the same way; empty registry → `ok({widgets:[],actions:[]})`, never an error.
- `api/responses.ts` — strips `requiredPermission` off the wire.
- `contracts/index.ts` — `WidgetProvider { descriptor{id,category,title,requiredPermission}, resolve(viewerUserId)→WidgetData{widgetId,payload} }`; `WidgetCategory = today | attention | pending_decisions | quick_actions | activity | kpi`; `CommandActionDescriptor{id,title,requiredPermission}`; tokens `WIDGET_PROVIDERS`, `COMMAND_ACTIONS`.
- `application/widgets/` — **3 providers**: `communities-summary.widget.ts` (`communities.read`, reads `COMMUNITY_MEMBERSHIP.listHeads` — "a count, never a load"), `academic-structure.widget.ts` (`academic.read`, reads `ACADEMIC_STRUCTURE_SUMMARY.structureSummary()` → `catalogue()`), `accounts-summary.widget.ts` (`users.manage`, reads `ACCOUNT_DIRECTORY_SUMMARY.summarize()` → `countByStatus()`).
- `application/command-actions.ts` — **4 actions**: `publish.communities`→`messaging.send`, `communities.create`→`communities.create`, `academic.structure`→`academic.manage`, `accounts.admin`→`users.manage`. Docstring rule: *"No action here grants anything or names an unbuilt feature."*
- `reporting.module.ts` — binds the 3 widgets into `WIDGET_PROVIDERS` via `useFactory`, `COMMAND_ACTIONS` via `useValue`; imports `IdentityModule, CommunitiesModule, AcademicModule`. **Extension point:** a new widget = import its module + one provider + one line in the factory.

**Flutter `features/command_center`:**
- `command_center_screen.dart` — groups widgets by category; loading/empty/error+retry; "no data" for a metric-less widget; mock banner in demo. `routeForCommandAction(id)` maps the 4 action ids → routes (`publish`/`communities`/`academicStructure`/`adminAccounts`); unknown id → "not available".
- `state/command_center_controller.dart` — `commandCenterProvider` (AsyncNotifier, re-reads on session change).
- `data/models/command_center.dart` — generic `CommandCenter/CommandWidget/CommandMetric/CommandAction` (+ `ReportingException`); defensive parse (unknown shape → no metrics, non-numeric → 0). **Already generic** → a new widget renders with no model change.
- `data/repositories/{http,mock}_reporting_repository.dart`; profile entry gated `reports.read`; route `/command-center`.

**Domains the hub links to (built, reusable, verified in the audit):** academic structure/enroll/assign admin (`features/academic_admin`), account lifecycle (`features/admin`), mass publish (`features/publish`), messaging, communities, live control plane, attendance record/view (observation-only), scheduling (`operations_lessons`), notifications V1 (in-app + realtime), the append-only audit log (`platform/audit`).

**Verification baseline (2026-10-22 run).** Backend `jest` (PG suites safely skipped): **4122 passed / 428 skipped / 1 failed** — the one failure is the **architecture-index freshness guard**, a consequence of the uncommitted A+D work (not functional, not command-center). Flutter `test/scheduling test/command_center`: **48 passed / 0 failed**.

---

## 3. Requirements Matrix (area → sub-requirement → status → evidence → gap/gate)

Legend: `COMPLETE` · `PARTIAL` · `MISSING` · `PRINCIPLE` (a design rule, not a build item). Gate: `owner-policy` / `product-definition` / `dependency` / `external` / `deploy-config`.

### A. Daily dashboard
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| A1 | Institution/sections status summary | **PARTIAL** | `academic-structure.widget.ts` + `communities-summary` + `accounts-summary` (3 factual tiles) | richer "status" tiles = per-domain widgets (below) |
| A2 | Urgent events/problems needing the owner | **MISSING** | `WidgetCategory` has `attention` but no provider bound (`reporting.module.ts`) | dependency (needs a domain signal) |
| A3 | Late / awaiting-decision / awaiting-review items | **MISSING** | `pending_decisions` category unused | dependency (tasks B / assignments F) |
| A4 | Halaqat / absence / assignments / completion follow-up | **MISSING** | — | owner-policy (attendance Q70) + dependency (E, F) |
| A5 | Drill-through from a metric to the record/action that resolves it | **PARTIAL** | actions→routes via `routeForCommandAction`; widgets not yet tappable | additive wiring (buildable now) |
| A6 | Never show unsupported numbers/states | **COMPLETE** | use-case hides unauthorized widgets; Flutter shows "no data" not a fabricated 0 | — |

### B. Tasks & completion (التمام)
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| B1 | Organize recurring + urgent daily tasks | **MISSING** | `automation` = empty `@Module({})`; no task/due-date model anywhere | owner-policy + product-definition |
| B2 | Assign tasks to people/roles | **MISSING** | — | owner-policy |
| B3 | Track status / due / completion / lateness | **MISSING** | — | owner-policy |
| B4 | Receive teacher/supervisor/section-head reports | **MISSING** | — | owner-policy (note: no "section-head" role exists — PPL-9) |
| B5 | Reminders & escalation | **MISSING** | no scheduler; push is no-op `LoggingPushProvider` | external (GROUP E) + owner-policy |
| B6 | Distinguish "message about completion" vs "proof of completion" | **PRINCIPLE** | — | owner-policy (the anti-invention rule — must be owner-defined) |

### C. Mass publish & communication
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| C1 | Compose text / file / image / voice | **COMPLETE** | `features/publish` + `publish-to-communities.use-case.ts` | — |
| C2 | Pick publish targets | **COMPLETE** | per-community target picker | — |
| C3 | Review content before publishing when needed | **MISSING** | no pre-publish approval step | owner-policy (decision #9) |
| C4 | Per-destination success/failure, independently | **COMPLETE** | 9 outcome values | — |
| C5 | Retry failed-not-successful, no duplicate sends | **COMPLETE** | sha256 `batchKey(clientBatchId+communityId)` idempotency | — |
| C6 | Verify real integrations; don't assume Telegram | **COMPLETE** | in-app communities only; **no Telegram/Zoom** (one comment ref) | — |

### D. Academic (Section → Program → Halaqa)
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| D1 | Section→Program→Halaqa model, no Level | **COMPLETE** | migration 0007; `academic/*`; audit confirmed no Level entity | — |
| D2 | Show sections/programs/halaqat per permission | **COMPLETE** | `features/academic_admin` + `academic.structure` widget/action | — |
| D3 | Link owner tasks/reports/assignments to the right entities | **PARTIAL** | `ACADEMIC_RELATIONSHIPS.halaqaExists` reusable | dependency (tasks B, assignments F not built) |
| D4 | Reuse existing academic admin, no parallel system | **PRINCIPLE** | — | satisfied by reuse |

### E. Absence & halaqa coverage
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| E1 | Record apologies/absences on a reliable model | **MISSING** | no absence model; attendance = connectivity snapshots only | owner-policy |
| E2 | Identify halaqat needing coverage | **MISSING** | no "vacant" concept (grep-confirmed) | product-definition ("vacant") |
| E3 | Suggest substitutes by specialty/availability/schedule-conflict | **MISSING** | — | owner-policy + dependency (attendance Q70, scheduling-conflict SCH-7) |
| E4 | Substitute approval + schedule change under human approval | **PRINCIPLE** | — | owner-policy (bake human-in-loop) |
| E5 | Identify missing decisions/policies first | **DONE here** | §7 | — |

### F. Assignments & grading
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| F1 | Prepare / review / approve / publish an assignment | **MISSING** | `assignments` = empty seam (types + seeded perms only) | owner-policy (GROUP D) |
| F2 | Track real submissions | **MISSING** | — | owner-policy (GROUP D) |
| F3 | Record grading / feedback / completion | **MISSING** | — | owner-policy (GROUP D) |
| F4 | Completion lists / reports | **MISSING** | — | dependency (F1–F3) |
| F5 | Prevent duplicate records/assignments on retry | **PRINCIPLE** | reuse `clientRequestId` idempotency pattern | — |
| F6 | Don't assume Telegram / external publish | **COMPLETE** | confirmed absent | — |

### G. Main halaqa & preparation
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| G1 | Organize main-session segments & prep | **MISSING** | no "main lesson"/segment/prep concept | product-definition (pedagogy) |
| G2 | Track prep-list completion | **MISSING** | — | product-definition |
| G3 | Link the lesson to assignments/reports | **MISSING** | scheduling has dated lessons (`operations_lessons`), not segments/prep | dependency (F) |
| G4 | Track supervisors & their tasks | **MISSING** | — | dependency (B) |
| G5 | Keep sensitive pedagogical decisions human | **PRINCIPLE** | — | owner-policy |

### H. Reports & notifications
| ID | Sub-requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| H1 | Accurate operational reports for the owner | **PARTIAL** | 3 factual widgets; no analytical reports | per-report owner-policy |
| H2 | Clear source for every number/state | **COMPLETE** | each widget reads exactly one module contract; no invented metric | — |
| H3 | Notifications with specific recipients + reasons | **COMPLETE** | `notifications/*` V1, 11 active types, inbox/preferences/mutes/devices | — |
| H4 | Audit log of important operations | **PARTIAL** | written by 6 modules (`platform/audit`); **no read surface** (`audit.read` seeded, 0 routes) | read surface additive (Phase 1) |
| H5 | No automatic actions without permission + policy | **COMPLETE** | every op re-authorizes server-side; no automation engine | — |

---

## 4. Command-Center UX Design

**One hub, many links — not one giant screen.** The command center stays the current single screen that renders the server's `widgets` (grouped by `WidgetCategory`) and `actions`. Each widget and action is a **doorway** to an existing feature screen; the heavy work stays in those screens (`academic_admin`, `admin`, `publish`, `attendance`, `scheduling`, a future `audit`/`tasks`/`assignments`). This satisfies A5 ("navigate from each indicator to the record/action that resolves it") without re-implementing anything.

- **Category layout (Arabic RTL):** `today` (ملخص اليوم) → `attention` (يحتاج تدخلك) → `pending_decisions` (بانتظار قرار/مراجعة) → `activity` / `kpi` → `quick_actions` (إجراءات سريعة). The categories already exist in the contract; today only `today` + actions are populated.
- **Every tile shows its source and never a fabricated figure.** A metric-less or unauthorized widget shows "لا توجد بيانات"/is hidden (A6) — already the behaviour.
- **Drill-through (A5, buildable now):** add an optional `target` (a stable route key, mirroring `CommandActionDescriptor.id`) to widgets so a tap deep-links to the source screen (communities → list, academic → academic_admin, accounts → admin/users, today's-lessons → scheduling filtered to today, audit → the audit view). The server states *which* doorway exists and who sees it; the client maps key→route (exactly as `routeForCommandAction` already does).
- **Performance (mandatory):** widgets are **counts / keyset-paged reads**, never full loads ("a count, never a load" — the communities widget's own rule). The dashboard must not fetch all institution data; each tile resolves independently and may be skipped by permission before any query runs.
- **No new top-level screens unless a center needs its own workspace** (tasks, assignments, coverage, prep each warrant a dedicated `features/*` screen the hub links to — modular, not monolithic).

---

## 5. Modules, Contracts & Data-Flow Design

**Boundary rule (enforced by `dependency-cruiser` + arch-index + Flutter layering):** reporting aggregates and **owns no table**; it reads other modules **only through their `contracts/`**. Each new *center* is its **own module** that owns its data and exposes a read contract; reporting gets **one widget** per approved fact. UI (Flutter Riverpod controllers + repo interfaces + Http/Mock) ⇄ backend use-cases ⇄ domain ⇄ Drizzle; **the server re-authorizes every operation** (the hub is a convenience, never the boundary).

**The additive extension recipe (per `reporting.module.ts` docstring — "one provider + one line"):**
1. The owning module adds a read to its `contracts/` (a summary/count/keyset list — never a bulk dump).
2. A new `WidgetProvider` (descriptor with `category` + `requiredPermission`, `resolve(viewerUserId)` reading that contract) is created and **bound in `reporting.module.ts`** (provider + one factory line); import the owning module.
3. Flutter renders it with the **existing generic model** (no model change); optionally add a `target` route key for drill-through.
4. An optional `CommandActionDescriptor` is added to `COMMAND_ACTION_CATALOG` **only if** the operation is already built (the catalogue forbids naming unbuilt features).

**Per-center design (what it owns, what it reuses, its contract):**

| Center | New module / owner of truth | Reuses (contracts) | Reporting surface | New permission? |
| --- | --- | --- | --- | --- |
| Today's lessons (Phase 1) | **none** — reuse `operations_lessons` | `operations/contracts` (+ `ACADEMIC_RELATIONSHIPS`), `time-resolution.ts` | a `today`-category widget + drill-through to `scheduling` | no (reuses `operations.schedule_manage` read) |
| Audit trail (Phase 1) | `platform/audit` (read-side port) + a read route (home = identity `/admin/audit`, or a reporting `attention`/`activity` widget) | the audit `schema`; identity `AuthorizationService` | an `activity`-category widget **and/or** a dedicated `features/audit` screen | no (reuses seeded `audit.read`) |
| Derived attendance (Phase 2A) | `operations` (reads `attendance/contracts`; **operations→attendance, never reverse**) + new additive table | attendance snapshots, academic relationships | an attendance widget (A4) | a new record/read perm |
| Assignments (Phase 2B) | `assignments` (fill the seam) + new tables | `ACADEMIC_RELATIONSHIPS` (Q31 scope), `FILE_ASSETS`, notifications | a completion widget (A4/F4) + a quick action | reuses seeded `assignments.*` |
| Tasks & automation (Phase 2C) | `automation`/`operations` + task store | notifications dispatcher + events | `attention`/`pending_decisions` widgets (A2/A3) | new `tasks.*`/`automation.*` |
| Coverage (Phase 2D) | `operations`/`automation` | 2A attendance signal + scheduling conflict (SCH-7) | a coverage widget (E) | new perm |
| Prep/main-halaqa (Phase 2E) | new or `operations` | scheduling, academic | a prep widget (G) | new perm |

**Data-flow exemplar (today's lessons, Phase 1):** Flutter `commandCenterProvider` → `GET /reporting/command-center` → use-case (skip if viewer lacks `operations.schedule_manage` read) → `TodaysLessonsWidget.resolve` → `operations/contracts` day read → `LessonRepository.list({ from, to, limit })` where `from/to` are the **instants of midnight today/tomorrow in the institution IANA tz** (computed by the existing pure `time-resolution.ts`), using the existing `(scheduled_at, id)` index — **same table, same source of truth, bounded read, no migration**. (Filtering by the `local_date` string would be wrong: each lesson's `local_date` is in its own captured zone.)

**Partial-failure / retry / idempotency:** any new fan-out or retried write (task assignment, reminders, assignment publish) **reuses the proven patterns** — the publish `batchKey` (deterministic per-target id) and the scheduling/attendance `clientRequestId` partial-unique index — never a bespoke scheme.

---

## 6. Permissions & Sources of Truth

**Authorization = two layers (reuse, don't reinvent).** (1) identity `Permissions` at the edge (`@RequirePermission`, `reports.read` for the hub); (2) each widget/action carries its own `requiredPermission`, **re-checked server-side** and hidden otherwise; community-scoped operations re-decide against community **acts**. A genuinely new operation (a task, a derived-attendance record) gets **one new permission**, added via `identity/contracts/permissions.ts` + a seed migration (one-dot CHECK) — never a role name in a route.

**Sources of truth (reporting is never one):**

| Data | Source of truth | Read for the hub |
| --- | --- | --- |
| Sections/programs/halaqat | `academic_*` tables | `ACADEMIC_STRUCTURE_SUMMARY` |
| Communities/membership/grants | `communities` + `community_*` | `COMMUNITY_MEMBERSHIP.listHeads` |
| Accounts | `users` | `ACCOUNT_DIRECTORY_SUMMARY.countByStatus` |
| Scheduled lessons | `operations_lessons` | new bounded day read (Phase 1) |
| Attendance | `attendance_snapshots` (observation-only) | derived record is Phase 2A (Q70) |
| Audit | `audit_log` (append-only) | new read-side port (Phase 1) |
| Tasks / assignments / coverage / prep | **new tables in their own modules** (Phase 2) | one widget each |

**Audit specifics (H4 / Phase 1):** `audit.read` is seeded to **OWNER + ADMIN** (migration 0002) and used by **zero routes**. The write port `AuditLog` exposes only `record()`; a **read** needs a new read-side port/method (additive) — **not** added to the write port. `metadata` is writer-supplied free-form stored raw ("never secrets" is a convention, not DB-enforced), so a viewer-facing read must rely on that convention per-writer or expose a projected subset. Indexes cover **actor-scoped** and **resource-scoped** reads; a **global newest-first feed is unindexed** (needs `(occurred_at, id)` = a migration) → Phase 1 ships the **scoped** read; a global feed is a later, migration-bearing decision.

---

## 7. Decisions Awaiting the Owner (engineering recommends; does not decide operational policy)

| # | Decision | Options (impact) | Engineering recommendation |
| --- | --- | --- | --- |
| 1 | **Daily "التمام" / completion definition** (B, A4): what counts as done; is a *message about* completion the same as *proof* of completion? | (a) message = record [simple, but asserts completion without proof] · (b) completion is an explicit recorded act separate from any message [honest, more work] | **(b)** — never conflate a notification with a fact (the Q70 anti-invention principle). |
| 2 | **Attendance present/absent/late rule + calendar** (A4, E1, Q70/Q68/Q72) | (a) stay observation-only [current] · (b) owner-stated threshold → derived record | Owner must state the rule; engineering will not invent a threshold about children. |
| 3 | **"Vacant halaqa" definition + substitute criteria + approval** (E2/E3/E4) | define by (specialty, availability, schedule-conflict); suggestion only, human approves | Keep substitute approval + schedule change **human-in-loop**; suggestion is advisory. |
| 4 | **Assignments policy** (F, GROUP D): who sets/reviews/approves/publishes/submits/grades; states; visibility; retention | needs a full workflow + ADR; scoped by Q31 (teacher per halaqa, resolved) | Defer build until the workflow is stated; reuse files + idempotency when built. |
| 5 | **Push / notifications / escalation policy** (B5, H, GROUP E) | provider (FCM/APNs) + credentials; lock-screen preview (content-free vs text); reminder/escalation rules | Keep **content-free** previews (minors); real sends need owner-provided credentials; quiet-hours stays **REJECTED** (do not surface). |
| 6 | **Task model + retention/erasure + automation scope** (B, Q3/Q71) | what a task is; how long tasks/records are kept; which events trigger automation | Define the task entity + retention before the task center + any automation rule. |
| 7 | **Audit-read surface** (H4, Phase 1): who reads, scope, metadata | (a) **scoped** (by actor/resource) [no migration, index-covered] · (b) **global feed** [needs `(occurred_at,id)` index = migration] · metadata: full vs projected | **(a) scoped first**, OWNER/ADMIN only (already hold `audit.read`), projected metadata; global feed later if wanted. |
| 8 | **`INSTITUTION_TIMEZONE`** (today's-lessons day window): it is **null when unset**, declared in `infra/compose.yaml` as a passthrough, **not set in `compose.trial.yaml`** | (a) set it per environment [deploy-config] · (b) view requires/accepts a tz param | **(a)** set the institution IANA zone in each environment (a deployment config change, not code). |
| 9 | **Review-before-publish** (C3) | (a) none [current — direct publish] · (b) a pre-publish approval step | Owner decides if an approval gate is required; current direct publish is already authorized per community. |
| 10 | **Prep-list / main-halaqa definition** (G) | what a prep list contains; main-session segments | Pedagogy — owner defines; keep sensitive decisions human (G5). |

Items also open in `owner-decision-register.md` (GROUP C deferred, «نظام الضخ» excluded; GROUP D/E/F/G) are carried, not re-derived.

---

## 8. Implementation Phases & Dependencies

> Ordered by dependency, impact, and risk — **not** by ease. None starts before owner approval of scope.

### Phase 1 — Complete the hub as a facts + navigation + oversight center (reuse-only; no new policy about children; no migration)
- **Goal / scope:** A1, A5, A6, D2, H2, H4-read. Make the 3 existing widgets **tappable** (drill-through); add a **today's-lessons** widget over `operations_lessons`; add a **scoped leadership audit-read** surface over `audit_log`.
- **Reuse:** the reporting registry (`WIDGET_PROVIDERS`/`COMMAND_ACTIONS`), `operations_lessons` + `time-resolution.ts`, `audit_log` schema + identity authz, Flutter `features/command_center` (generic model).
- **Gaps addressed:** widget tap-through wiring; a `TodaysLessonsWidget` (+ an `operations/contracts` day read); a scoped audit read-model + route + a `features/audit` list.
- **Likely files:** `reporting.module.ts` (+2 providers), `reporting/application/widgets/*` (+1–2), `operations/contracts/*` + `operations/.../lesson-repository*` (add a bounded day read), a read-side audit port under `platform/audit/*` + a read route (identity `admin-users` neighbourhood or a thin surface), Flutter `command_center_screen.dart` (tap targets) + a new `features/audit`.
- **Contract/data changes:** additive read methods only; **no migration if the audit read is scoped** (decision #7a); **no new source of truth**.
- **Decisions required first:** #7 (audit scope + metadata), #8 (`INSTITUTION_TIMEZONE` set).
- **Depends on:** nothing in the product; sequence any commit **after** the A+D commit (arch-index coupling, §10).

### Phase 2 — Policy verticals (each independent; each = one owner decision → one module + one tile)
- **2A Derived attendance record** (needs #2/Q70) → attendance widget (A4) + the absence signal for 2D + "التمام" input (B). Reuse snapshots; `operations` reads `attendance/contracts`.
- **2B Assignments** (needs #4/GROUP D) → fill the `assignments` seam + a completion widget (F4) + a quick action. Reuse academic scope (Q31), files, reserved `assignments.*` perms + notif types.
- **2C Tasks & automation** (needs #1/#6) → the task center (B) + `attention`/`pending_decisions` dashboard tiles (A2/A3); reminders/escalation **delivery depends on 3A**.
- **2D Absence & coverage** (needs #3; **depends on 2A** + scheduling-conflict SCH-7) → the coverage center (E), human-approved.
- **2E Prep & main-halaqa** (needs #10) → the prep center (G).

### Phase 3 — External enablers
- **3A Real push** (needs #5/GROUP E provider + credentials) → activates notification delivery + makes 2C reminders/escalation actually send.
- **3B Live media enable** (GROUP F) — not core to the command center; listed for completeness.

### Phase 4 — Deferred by owner
- **Educational core** (progress/assessment/mastery/progression/certificates — GROUP C). «نظام الضخ» **excluded**.

**Dependency summary:** 2A → (2D, B-التمام); 2B → F4; 2C → (A2/A3; needs 3A to deliver); 2D → (needs 2A + SCH-7); 3A → (2C delivery, B5). Everything in Phase 2+ is **owner-policy-gated** per the register.

---

## 9. Tests & Acceptance Criteria

**Patterns to reuse (already in the repo):** backend use-case specs (authz / per-widget hiding / empty-set), per-widget provider specs, an HTTP e2e with a **permission matrix** (owner sees facts; a supervisor is correctly denied a widget/action; 401/403; no `requiredPermission` on the wire; no leak), Postgres integration where a table is touched, `*-boundaries.spec.ts` (contracts-only), arch-index freshness; Flutter model/controller/screen/repo + boundary tests.

| Phase | Tests | Acceptance (functional + authz + core states) |
| --- | --- | --- |
| 1 — drill-through | Flutter: each widget's tap routes to the right screen; unknown target → inert | owner taps a tile and lands on the source screen; no tile invents a number |
| 1 — today's lessons | backend: day-window at tz boundaries (DST), empty day, authz hide; Flutter: widget render + tap | holder of the schedule read sees exactly today's lessons (institution tz), empty-day empty, server-authorized; **requires #8** |
| 1 — audit read (scoped) | backend: authz (OWNER/ADMIN only; supervisor/teacher 403; 401), keyset pagination, scope-required (actor/resource), metadata projection, masking; Flutter: list/empty/error/loadMore | an `audit.read` holder reads a **scoped** audit trail newest-first, keyset-paged, read-only, projected metadata; others 403; no global unindexed scan |
| 2A | derived-record spec against the **owner's stated rule** (never invented); widget authz | a snapshot set yields present/absent/late **only** by the owner rule; immutable; old snapshots unchanged |
| 2B | assignment lifecycle states; Q31 teacher scope; idempotent create; completion widget authz | the defined roles set/submit/grade through the defined states, scoped per halaqa, files via existing pipeline, no duplicate on retry |
| 2C | task states/due/completion; idempotency; reminder rule (fires only when 3A present) | tasks assigned/tracked by the owner model; "proof" ≠ "message" (#1); reminders fire per the owner schedule |
| 2D | coverage detection by the owner definition; substitute suggestion advisory; human-approval required | vacant halaqat flagged by the owner rule; a substitute is **suggested**, never auto-assigned |
| General | boundary-clean (contracts only); arch-index regenerated **in the same commit**; full suite green | no change to Section→Program→Halaqa; no `Level`; no invented metric; no automatic action without permission |

**Definition of done (every item):** functional path complete end-to-end **and** permissions + core states (loading/empty/error/authorized/denied) tested. A screen that renders but isn't permission-tested and state-tested is **not** done.

---

## 10. Risks & Rollback

| Risk | Detail | Mitigation / Rollback |
| --- | --- | --- |
| **R1 — inventing policy about children** | التمام, attendance thresholds, grading, substitute rules | Build only after the owner states the rule + an ADR; §7 keeps these stopped. |
| **R2 — audit global feed unindexed** | newest-first global scan on a growing table | Ship **scoped** (index-covered, #7a); a global feed is a separate migration-bearing decision. |
| **R3 — audit metadata exposure** | `metadata` stored raw; "no secrets" is convention | Project a reviewed subset; OWNER/ADMIN-only; per-writer review before exposing. |
| **R4 — `INSTITUTION_TIMEZONE` unset** | null in Trial; day window undefined | Resolve #8 (set per env) before shipping today's-lessons; otherwise the widget must require a tz. |
| **R5 — arch-index freshness coupling** | the uncommitted A+D already fails the arch-index guard; any new module/contract edge changes the index | Regenerate the index **in the same commit** as the change; sequence after the A+D commit. |
| **R6 — audit read-port ripple** | adding a read method touches `platform/audit` + both adapters + any test doubles | Add a **separate read-side port** (don't touch the write `AuditLog` port); stub doubles. |
| **R7 — monolith / parallel system drift** | piling centers into one screen or duplicating academic/scheduling | Enforce the registry + deep-link pattern; new centers are their own modules; dependency-cruiser guards it. |
| **R8 — performance** | a dashboard that loads everything | Widgets are counts/keyset reads; each resolves independently; skip-by-permission before any query. |

**Rollback per phase:** Phase 1 is additive and reversible by removing the providers/route (no data change; scoped audit read adds no table). Phase 2+ verticals are additive migrations (new tables; existing tables untouched) — reversible by dropping the new module's surface; recorded present/absent/grade data is an institutional assertion (low reversibility) and only exists after the owner's rule, by design.

---

## 11. What Can Start After Approval — and What Must Stay Stopped

**Can start after your approval (Phase 1 only; reuse-only, additive, no policy about children):**
1. **Drill-through wiring** for the 3 existing widgets (A5) — pure Flutter + an optional `target` key; no backend data change.
2. **Today's-lessons widget** (A1/SCH-12) over `operations_lessons` — **conditional on #8** (`INSTITUTION_TIMEZONE` set in the target environment); no migration, no new source of truth.
3. **Scoped leadership audit-read surface** (H4/CC-2) over `audit_log` — **conditional on #7** (scoped, OWNER/ADMIN, projected metadata); no migration.

**Must stay stopped until the specific owner decision is made (§7):**
- **B — Tasks & التمام** (#1, #6, and #5 for delivery).
- **E — Absence & coverage** (#2/#3; depends on 2A + SCH-7).
- **F — Assignments & grading** (#4 / GROUP D).
- **G — Main halaqa & prep** (#10).
- **A2/A3/A4 richer dashboard tiles** (depend on B/E/F + attendance Q70).
- **Real push, reminders, escalation** (#5 / GROUP E — external).
- **Audit global feed** (needs an index/migration — #7b).
- **Educational core** (GROUP C, deferred) and **«نظام الضخ»** (excluded).

---

**End of plan. No code, test, contract, migration, or environment was changed to produce it (documentation only). Awaiting your explicit approval of the plan and the Phase-1 scope before any implementation — nothing starts automatically.**
