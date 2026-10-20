# Owner-features roadmap — Educational Institution

**Purpose.** One central, evidence-grounded map of the **owner's feature domains** against the
**actual implementation** — a feature-domain lens that complements, and does not duplicate, the two
existing authorities:

| Lens | Document | What it answers |
| --- | --- | --- |
| Phase / milestone status | [`project-roadmap.md`](project-roadmap.md) | P0–P12, TRIAL, SCHED: what is done/partial/blocked |
| Owner decisions (approved / rejected / deferred) | [`owner-decision-register.md`](owner-decision-register.md) | the A–G decision groups + §20–§25 |
| Open governance questions | [`architecture/open-questions.md`](architecture/open-questions.md) | Q1–Q72 |
| **Owner feature domains (this file)** | **this file** | each owner-named domain → status, backend/UI/tests evidence, dependencies, acceptance |

**This file states status only; it makes no product-policy decision.** Where a domain is gated, the
gate is an owner decision recorded in the register / open-questions, and the roadmap's §3 legend applies
(`COMPLETE-VERIFIED` · `PARTIAL` · `NOT-STARTED` · `BLOCKED` · `DEFERRED-BY-DECISION` · `EXCLUDED`).

**Last updated.** 2026-10-19, from a source audit at HEAD `9b4a6de` (branch
`claude/trial-integration-sprints-52-61`; working tree clean at audit start). Every status below was
verified against the actual backend routes (`backend/src/modules/*/api/*.controller.ts`), the Flutter
repositories/features, and the test suites — **not** from memory. A UI alone was never taken as proof;
backend + permission + data flow + tests were each checked.

> **Governance reminder (do not re-derive).** The five modules `people`, `operations`, `assignments`,
> `reporting`, `automation` are deliberate **boundary seams** (`@Module({})` + a `contracts/` file only,
> zero routes) — verified in source this audit. Each awaits an **owner policy decision** (register
> groups C/D/G); their vocabularies must **not** be invented. `«نظام الضخ»` is **EXCLUDED** from scope
> by the owner (register §22, Sprint 38). Quiet hours is **REJECTED** by the owner (roadmap §8); no
> quiet-hours UI exists or may be added.

---

## 1. Feature-domain status at a glance

| # | Owner domain | Status | Gate (if any) |
| --- | --- | --- | --- |
| 1 | Owner Command Center | **PARTIAL (foundation + actions/accounts shipped 2026-10-19, ADR 0040/0041)** | registry + 3 real widgets (communities, academic structure, **accounts**) + a server-gated **actions** registry (publish/create-community/academic/accounts); more widgets gated per owner decision (present/absent = Q70; live needs a module read) |
| 2 | School-day & emergency management | **PARTIAL (lesson scheduling shipped 2026-10-20, ADR 0042)** | one-off dated-lesson scheduling DONE (`operations.schedule_manage`, owner/admin); derived attendance still Q70; conflict/recurrence/"emergency" still owner-gated |
| 3 | Mass publishing & communication | **PARTIAL (mass publish shipped 2026-10-19, ADR 0041)** | messaging/chat DONE; **mass publish to many communities DONE** (owner-directed, per-community authz + partial-failure + idempotent retry); a persistent announcement *feed* still mock (not requested); `«نظام الضخ»` **EXCLUDED** |
| 4 | Absences, vacant halaqat, substitute suggestion | **NOT-STARTED (BLOCKED)** | `operations`/`automation` seams; GROUP G (Q70/Q71); substitute suggestion = automation |
| 5 | Assignments / submission / grading / reminders | **NOT-STARTED (BLOCKED)** | `assignments` seam; GROUP D (no policy, no ADR) |
| 6 | Section → Program → Halaqa | **COMPLETE-VERIFIED** | — |
| 7 | People / delegation / permissions | **COMPLETE-VERIFIED** (approved scope) | educational-core progression excluded (GROUP C, DEFERRED) |
| 8 | Communities & live streaming | **COMPLETE-VERIFIED** (web/control-plane) | real audio/video needs `LIVE_MEDIA_PROVIDER=livekit` + a LiveKit server (GROUP F); native BLOCKED (external) |
| 9 | Attendance & reports | **PARTIAL** | attendance record+view DONE; reports + derived present/absent record BLOCKED (GROUP G, Q70) |
| 10 | Automation & task tracking | **NOT-STARTED (BLOCKED)** | `automation` seam; GROUP G (Q71/Q3) |

**Net: 3 domains complete (6, 7, 8), 4 partial (1, 2, 3, 9), 3 blocked on owner decisions / external
resources (4, 5, 10).** The Owner Command Center (1) now has a real foundation — a server-resolved
widget registry with three factual widgets and a permission-gated actions registry (ADR 0040/0041, §3b/§3c)
— and grows by one provider or action per future owner-approved fact, never a rewrite. Mass publishing (3)
now ships: one file/image/voice recording published to several communities at once, authorized per
community, with partial-failure handling and idempotent retry (ADR 0041, §3c). The blocked domains are
*not* missing engineering — they are missing an owner policy the brief forbids inventing (register §3, §9;
[`owner-decision-brief-product-loop.md`](owner-decision-brief-product-loop.md)).

---

## 2. Per-domain detail

Fields: **Requirement source · Backend · Flutter · Tests · Dependencies · Acceptance · Status.**

### 1. Owner Command Center — PARTIAL (foundation shipped 2026-10-19, ADR 0040)
- **Source.** register GROUP G; `reporting/contracts/index.ts` (the `WIDGET_PROVIDERS` registry); ADR 0040.
- **Backend (DONE).** `reporting` is now implemented: `GET /reporting/command-center` (edge `reports.read`),
  a `GetCommandCenterUseCase` that re-authorizes and hides any widget whose `requiredPermission` the viewer
  lacks, and two `WidgetProvider`s bound inside `ReportingModule` reading other modules only through their
  `contracts/`. v1 widgets are **facts only**: communities (total + accepting, via `COMMUNITY_MEMBERSHIP.listHeads`)
  and academic structure (ACTIVE sections/programs/halaqat, via a new read-only `ACADEMIC_STRUCTURE_SUMMARY`
  reusing `catalogue()` — no migration). No new permission, no invented metric.
- **Flutter (DONE).** `features/command_center` — screen (grouped by category, loading/empty/error/retry,
  "no data" per metric-less widget), `ReportingRepository` (http + mock), controller, model; entry in the
  profile screen gated on `reports.read` (a courtesy; the server enforces).
- **Tests.** backend: use-case authz/hiding/empty, both widget providers, academic service, and a real
  HTTP end-to-end spec (owner sees widgets; academic count > 0 from the seeded structure; 403/401; no
  permission leak). Flutter: model, http + mock repos, controller, screen states.
- **Actions + accounts added (2026-10-19, ADR 0041 follow-on, §3c).** The command center now also carries a
  server-resolved **actions** registry — quick actions to real operations, each gated by its own permission
  and hidden otherwise (`publish.communities`→`messaging.send`, `communities.create`→`communities.create`,
  `academic.structure`→`academic.manage`, `accounts.admin`→`users.manage`); the client maps an action id to
  a screen and the operation re-authorizes on use. And an **accounts** widget (`users.manage`): total /
  active / pending / suspended / disabled, via a new read-only identity contract `ACCOUNT_DIRECTORY_SUMMARY`
  (a grouped count — no listing, no new permission, no migration).
- **Remaining (gated, additive — one provider each).** live ("anyone live now" not enumerable), attendance
  present/absent (Q70, owner-gated). Each becomes a widget when its module exposes a read and (attendance)
  the owner states the rule — never a rewrite.
- **Acceptance (met for v1).** a server-resolved registry with ≥1 real widget and the actions the viewer may
  perform, each carrying its `requiredPermission`, resolved server-side, no invented figure, absent data
  shown as absent.

### 2. School-day & emergency management — PARTIAL (lesson scheduling shipped 2026-10-20, ADR 0042)
- **Source.** register GROUP G + §24 + §27 (scheduling); `operations/*`; ADR 0042.
- **Backend (DONE).** `operations` now has its first behaviour: `/operations/lessons` CRUD for
  **individual dated lessons**, one per halaqa, behind the new `operations.schedule_manage` capability
  (OWNER/ADMIN; reads gated too). Each lesson stores its wall clock + the IANA zone captured at creation +
  the resolved instant; a pure DST resolver rejects spring-forward gaps and resolves fall-back folds to the
  earlier instant; new/rescheduled lessons must be strictly future; cancellation is an auditable state
  transition. Migrations 0026 (table) + 0027 (permission). No recurrence, no attendance derivation, no
  notification, no conflict policy.
- **Flutter (DONE).** `features/scheduling` — a permission-gated list, a create/edit sheet (program→halaqa
  cascade, date/time pickers, IANA-zone dropdown, duplicate-submit guard, Arabic errors), a detail with
  cancel confirmation; profile entry gated `operations.schedule_manage`.
- **Still gated (separate owner decisions).** A scheduling **horizon**, **conflict** detection (needs an
  owner definition of "conflict"), **teacher authorship** (Q31), scheduling **notifications** (Q28), and
  "**emergency management**" (undefined in any source). Derived present/absent stays Q70.
- **Acceptance (met for v1).** a holder of `operations.schedule_manage` schedules/reschedules/cancels a
  dated lesson for a real halaqa, DST-correct and future-only, server-authorized; attendance stays separate
  from live connectivity (ADR 0020 dec 3 / 0023).

### 3. Mass publishing & communication — PARTIAL
- **Source.** register GROUP A (messaging) + §22 (`«نظام الضخ»`); `messaging`/`communities` modules.
- **Backend / Flutter (DONE).** messaging is full: direct conversations, community chat, **two-way
  student↔teacher / student↔student DM** (migrations 0018/0019), message moderation (delete/review),
  attachments (web), per-conversation mute, and **community chat modes** (group-open / group-restricted /
  channel, ADR 0039 — shipped `9b4a6de`). Community profiles + avatars shipped `9b4a6de`.
- **Mass publish (DONE, 2026-10-19, ADR 0041).** Owner-directed: `POST /messaging/communities/publish`
  posts one notice / file / image / voice recording to several communities at once, each authorized on its
  own `community.chat.post` through the existing `MessageSender` path — per-community outcome (posted /
  already_posted / forbidden / not_found / locked / over_capacity / rate_limited / unavailable), partial
  failure is normal, and a deterministic per-community `clientMessageId` from `clientBatchId` makes retry
  idempotent (no duplicates). No new permission, no migration, no notification change. Flutter:
  `features/publish` (compose text/image/voice/document, pick targets, publish, per-community results,
  retry the transient), surfaced from the command center (`publish.communities`) and a profile entry gated
  `communities.moderate`. Proven by an HTTP end-to-end spec (fan-out, a real upload reused across
  communities, forbidden/not_found/locked, idempotent retry, ownership rejection).
- **Still NOT built (not requested).** A persistent one-to-many **announcement feed** (`features/announcements`
  is still a mock screen; no backend). **`«نظام الضخ بين الأقسام»` is EXCLUDED** from scope (owner,
  Sprint 38; academic student-progression move, register §22) — a different concept, not this. Standalone
  messaging **group/channel creation + participant admin** is built on the backend but **owner-deferred**
  on the surface (register §23).
- **Acceptance (met for mass publish).** one post reaches every community the viewer may post in, each
  authorized server-side, with an honest per-community result and a safe retry; no new notification policy.
- **Next action.** none for mass publish; a persistent announcement feed would be a separate owner decision;
  nothing for `«نظام الضخ»` (excluded).

### 4. Absences, vacant halaqat, substitute suggestion — NOT-STARTED (BLOCKED)
- **Source.** register GROUP G (Q70/Q71/Q72/Q68); `operations`/`automation` seams; `attendance` module.
- **Backend.** attendance **snapshots** are built and observation-only (record + view; ADR 0020/0023) —
  a snapshot records "connected at T" and **nothing** derives present/absent/late (Q70 forbids inventing
  the threshold). No "vacant halaqa" or "substitute" concept exists; substitute **suggestion** would be an
  `automation` rule (empty seam).
- **Flutter.** attendance record/view surfaced; nothing for absences/vacancy/substitutes.
- **Dependencies.** Q70 (present/absent/late rule + calendar), Q71/Q3 (retention), an owner definition of
  "vacant halaqa" and the substitute workflow.
- **Acceptance.** an owner-stated derivation rule; additive `operations` tables; an `automation` rule.
- **Next action.** owner-decision. **Must not be invented** (assertions about real children).

### 5. Assignments / submission / grading / reminders — NOT-STARTED (BLOCKED)
- **Source.** register GROUP D; `assignments/contracts/index.ts` (types only: `SubmissionState`,
  `AssignmentRef`, `SubmissionRef`).
- **Backend.** empty seam, no routes, no tables. Permissions `assignments.read/submit/manage` are seeded
  (migration 0002) but back no feature; notification types `ASSIGNMENT_CREATED/UPDATED` are **inactive**.
- **Flutter.** `features/assignments` is empty.
- **Dependencies.** a product definition (who sets/submits/grades, states, visibility); overlaps GROUP C
  grading vocabulary, so it should sequence **after** GROUP C.
- **Acceptance.** an owner-approved workflow + ADR, then an additive module + Flutter + notifications,
  scoped by the Q31 per-halaqa teacher rule.
- **Next action.** owner-decision.

### 6. Section → Program → Halaqa — COMPLETE-VERIFIED
- **Source.** ADR 0014/0015; `academic` module.
- **Backend.** full read + **structure management**: sections/programs/halaqat CRUD + activate/deactivate
  (`academic.manage`), enrollment & teacher-assignment administration + read-only history, `/academic/me`
  self-views. All routes verified in `structure.controller.ts` / `relationships.controller.ts` /
  `my-academic.controller.ts`.
- **Flutter.** `features/academic_admin` (structure, enroll/assign), `features/teacher` + `features/student`
  workspaces/records. Shipped Sprints 45–58.
- **Tests.** backend academic suites + the `academic-journey-postgres` integration spec (CI-enforced);
  Flutter academic/teacher/student suites.
- **Note.** this is **structure only** — the learning loop (progress/assessment/mastery) is GROUP C
  (DEFERRED). Structure management does **not** imply the educational core.

### 7. People / delegation / permissions — COMPLETE-VERIFIED (approved scope)
- **Source.** register GROUP A (§12–§16, §20), ADR 0032/0035; `identity`/`communities`/`people` modules.
- **Backend.** account provisioning + lifecycle admin (roles / status / password reset / session revoke over
  `/admin/users`); community membership + **delegation grants** + **invitation links** (create/list/revoke);
  people search (owner/admin `people.read`), teacher directory (`/people/teachers`), person avatars.
- **Flutter.** `features/admin`, community members/grants/invitations screens, people picker + avatars.
- **Tests.** identity/communities/people suites + the people/communities PG integration specs.
- **Gated adjacent.** the PARENT role (inactive, Q10) and the educational-core progression (GROUP C) are
  owner-gated and out of this domain's approved scope.

### 8. Communities & live streaming — COMPLETE-VERIFIED (web / control-plane)
- **Source.** ADRs 0016–0019, 0026–0030, 0037, 0039; `communities`/`live` modules.
- **Backend.** communities (create/lock/members/owner-transfer/halaqa-link/profile/chat-mode); live control
  plane — start / end / current / join-ticket / **kick** / **reset** / presenter (claim/stop/grant/revoke) /
  **the speaking (floor) lifecycle** (raise / lower / grant / decline / revoke). All verified in
  `live.controller.ts`.
- **Flutter.** community screens + chat; live session screen with the media panel, moderator roster
  (kick, presenter grant/revoke), and — **new this audit (2026-10-19)** — the **hand/floor surface**
  (see §3). Web LiveKit media is real (ADR 0030; Live E2E CI).
- **Tests.** live + communities suites (Flutter 431 live/attendance green with the new surface); backend
  live suites + real-LiveKit CI job; the community-chat-posting PG spec.
- **Not proven / fake.** On the **Trial** `LIVE_MEDIA_PROVIDER=fake` — **real audio/video does not flow**;
  native (iOS/Android) media is NOT-STARTED (external: devices + mobile CI, ADR 0030). The floor/control
  plane is authoritative regardless of media; granting the floor never claims audio works.

### 9. Attendance & reports — PARTIAL
- **Source.** ADR 0020/0023 (attendance); register GROUP G (reports).
- **DONE.** attendance **record + view** (snapshots, observation-only) — backend `attendance` module +
  Flutter `features/attendance`; ADR 0023 authorization; CI.
- **BLOCKED.** a derived present/absent/late **record** (Q70) and any **reporting** surface (GROUP G,
  the `reporting` seam). See domains 1 and 4.
- **Acceptance (open part).** an owner-stated derivation rule + a reporting widget.

### 10. Automation & task tracking — NOT-STARTED (BLOCKED)
- **Source.** register GROUP G; `automation/contracts/index.ts` (the `AutomationRule` interface only).
- **Backend.** empty seam; its first intended job is the Q71 retention job, which waits on the Q3/Q71
  retention policy.
- **Dependencies.** Q71/Q3 (retention/erasure); any automation rule couples to an upstream event + an
  owner-approved action.
- **Next action.** owner-decision.

---

## 3. Feature delivered this pass (2026-10-19) — live speaking (hand/floor) in the app

**Scope chosen by the audit rule:** the only legitimate *implementable* work is "activate the built
platform" (register §23) — surface an **already server-authorized** capability not yet in the app, with
**no new policy**. The single largest such gap (Flutter audit) was the **live speaking / hand-raise
(floor) lifecycle**: five backend routes under the already-decided ADR 0026/0028 policy (P12
COMPLETE-VERIFIED), permissions `live.raiseHand` + `live.moderate` already seeded, the hands roster
already rendered — but no app surface to raise a hand or decide one. **It invents no policy and makes no
claim that audio flows** (Trial media stays fake).

**What shipped (Flutter only; no backend/permission/schema/migration change):**
- `LiveRepository` gained `raiseHand` / `lowerHand` / `grantFloor` / `declineHand` / `revokeFloor`
  (interface + HTTP `http_live_repository.dart` against the exact routes + demo `mock_live_repository.dart`,
  stateful for the viewer's own hand so the demo is coherent). `LiveModerationController` forwards each.
- UI: a new participant **hand control** (`widgets/live_hand_control.dart`, keys `live-raise-hand` /
  `live-lower-hand`) gated on the server's `me.canRaiseHand` / `me.hand`; and moderator **floor commands**
  on each roster row (`live-grant-floor-<id>` / `live-decline-hand-<id>` / `live-revoke-floor-<id>`),
  keyed by the request id, re-reading the queue after each. Every command re-authorizes server-side; the
  app is never the boundary and never fabricates state (reconciliation is authoritative).
- Copy: a `LiveCopy` "floor" section (Arabic), stating plainly that the floor permits speaking while the
  audio itself is unavailable in this build.
- Tests: `http_live_repository_test` (route/parse/refusal per method), `mock_live_repository_test`
  (own-hand reflected in `me`; grant/decline/revoke echo), `live_moderation_controller_test` (forwarding),
  `live_session_screen_test` (raise/lower/yield gating + taps + refusal + no optimistic mutation; roster
  grant/decline/revoke by request id; host never a target). The 8 `LiveRepository` test doubles were
  updated (stubs, or real for the two command-exercising doubles).

**Verification:** `flutter analyze` clean (lib + changed tests); the live + attendance suites **431
passed / 0 failed**; the full Flutter suite result is recorded in the delivery report. No backend
contract, permission, migration, or product policy changed. No commit / push / deploy performed.

**Acceptance for this feature:** a participant the server permits can ask for and withdraw the floor; a
moderator can grant / pass over / take back a hand, by request id, server-authorized, with the queue and
`me` re-read (never fabricated); gated entirely by the server's `me.*`; initials/empty states preserved;
no claim that live audio flows.

---

## 3b. Owner Command Center v1 delivered (2026-10-19, ADR 0040)

**Scope:** the owner directed building the real command center on *existing, already-authorized* data,
forbidding invented KPIs/attendance rules/emergency states and requiring absent data be shown as absent.
Built exactly that — the `reporting` registry its contract already described, with two factual widgets.

- **Server-resolved registry.** `GET /reporting/command-center` (edge `reports.read`); the use case
  re-checks `reports.read` and hides any widget whose `requiredPermission` the viewer lacks (the UI is
  never the boundary); zero widgets → an empty set, never an error; reporting writes nothing and stores no
  table. Providers bound **inside** `ReportingModule` (no `multi:true`, no foreign-token export), reading
  other modules only through `contracts/` — boundary-clean, acyclic, arch-index regenerated.
- **Two factual widgets.** `communities.summary` (`communities.read`): total communities + those accepting
  members, by keyset-paging `listHeads`. `academic.structure` (`academic.read`): ACTIVE sections/programs/
  halaqat, via the new read-only `ACADEMIC_STRUCTURE_SUMMARY` contract reusing `catalogue()` — **no new
  permission, no migration, no invented metric.**
- **Flutter.** `features/command_center` screen (grouped by category; loading/empty/error/retry; "no data"
  for a metric-less widget), `ReportingRepository` (http + mock), controller, model; a profile entry gated
  on `reports.read`.
- **Verification:** backend `npm test` green (4003 passed / 407 PG-skipped / 0 failed), lint + format +
  boundaries + arch-index green; the reporting HTTP spec proves real data flow (owner sees widgets, academic
  count > 0 from the seeded structure, communities 0 truthful, 403/401, no permission leak). Flutter analyze
  clean; the command-center suite (20 tests) green. No commit/push/deploy.
- **Extensible, not hollow.** Live and attendance widgets are deliberately deferred to one provider each,
  pending a module read or (attendance) an owner rule (Q70) — never a screen rewrite.

## 3c. Mass publishing + command-center actions/accounts delivered (2026-10-19, ADR 0041)

**Scope:** the owner directed building mass publishing of files/images/voice recordings to several
communities, with per-community authorization, partial-failure handling and retry — and completing the
command center with actions and summaries tied to real operations/data and approved permissions. Built
exactly that, inventing no policy.

- **Mass publish (backend, `messaging`).** `POST /messaging/communities/publish` (edge `messaging.send`):
  `PublishToCommunitiesUseCase` authorizes the batch once via Communities' `authorizeEach(community.chat.post)`
  (no chat materialized for a community the viewer may not post in), then posts to each authorized one
  through the existing `MessageSender` path (the per-community permit, capacity switch, attachment checks
  and delivery all apply unchanged). Per-community outcome; partial failure is an `ok` report, never a
  thrown batch; `retryable` true only for transient refusals. A media attachment is verified once (a bad
  one fails the whole request). A deterministic per-community `clientMessageId` (digest of `clientBatchId`
  + community id) makes retry idempotent. **No new permission, no migration, no notification change.** The
  route is listed under `messaging.send` in the authorization route-declaration guard.
- **Command-center actions + accounts (backend, `reporting`/`identity`).** A `COMMAND_ACTIONS` registry
  (static descriptors, filtered by `AuthorizationService.can`) returns the quick actions the viewer may
  perform; an `AccountsSummaryWidget` (`users.manage`) reads a new read-only identity contract
  `ACCOUNT_DIRECTORY_SUMMARY` (a grouped count of the users table — total/active/pending/suspended/disabled;
  no listing, no new permission, no migration). Both drop `requiredPermission` from the wire.
- **Flutter.** `features/publish` (compose text/image/voice/document via the existing attachment/recorder
  seams, pick target communities, publish, per-community results, retry the transient); the command-center
  screen renders the server's actions (mapping each id to a screen) and the accounts widget (generic
  rendering); a profile entry gated `communities.moderate`. New repository methods `FilesRepository.upload`
  and `MessagingRepository.publishToCommunities` (http + demo mock), model `publication.dart`.
- **Verification.** backend `npm test` green (**4019 passed / 407 PG-skipped / 0 failed**); typecheck,
  lint, format, dependency-cruiser (464 modules, no violations) and arch-index all green; a real HTTP
  end-to-end spec proves the publish data flow (fan-out, a real image upload reused across communities,
  forbidden/not_found/locked outcomes, idempotent retry, ownership rejection) and the command-center
  accounts widget + actions (owner sees them with real counts; a supervisor is correctly denied the
  accounts widget and the `accounts.admin`/`communities.create` actions). Flutter analyze clean; full suite
  **1691 passed / 1 skipped / 0 failed**. No commit / push / deploy / migration performed.
- **Distinct from «نظام الضخ».** This is content broadcasting (roadmap domain 3), not the academic
  student-progression move that is EXCLUDED (register §22). The two share a word, not a feature.

## 3d. School-day management & task tracking — re-audited 2026-10-19, no approved buildable slice

> **Update (2026-10-20).** The owner then approved the scheduling decision this section flagged as the
> "smallest decision that unblocks the largest real school-day slice", and **one-off dated-lesson
> scheduling is now built** (domain 2, ADR 0042, register §27). The rest of this section still holds: task
> tracking (domain 10) and derived attendance remain owner-gated.

The owner re-directed building the **approved administrative operations that can be executed now** in
**school-day management** (domain 2) and **task tracking** (domain 10). This pass ran an exhaustive,
route-level source audit (every `*.controller.ts` route × its Flutter consumer) to find any
already-authorized operation to activate **without inventing attendance/absence/alternate/scheduling/
assignment policy**. The honest result: **there is none that is not already shipped.**

- **The seams are genuinely unbuilt (nothing to activate).** `operations`, `automation` and `assignments`
  each mount **zero routes** (verified: no `@Controller`/`@Get`/`@Post` in those module dirs; docblocks
  "No behaviour is implemented yet"). No route anywhere requires an `operations.*` / `automation.*` /
  `assignments.*` / task / schedule / lesson permission. There is **no "today's lessons", scheduled-session
  or school-day read** in `academic` or elsewhere — that concept is owned by the unbuilt `operations` module.
- **The approved school-day operations are already implemented** — academic structure management, enrollment
  & teacher-assignment administration, attendance **record + view** (observation-only snapshots), and live
  **session start + moderation** (incl. the hand/floor surface). Attendance (4/4 routes), live (17/17) and
  academic (27/27) are **fully surfaced**; re-building them would repeat completed work.
- **Each still-unbuilt operation is blocked by a specific, still-open owner decision** (cited, not
  re-derived): one-off **lesson scheduling** — only three facts are confirmed (one-off dated lessons, a
  persisted IANA institution timezone, no recurrence); the **create/edit/cancel permissions and the
  storage/DST design are NOT approved and must NOT be implemented** (register §24). A derived
  **present/absent/late** record — **Q70** (the threshold is forbidden to invent). **Task/automation**
  tracking — **Q71/Q3** (retention/erasure policy undefined). **Assignments** — **GROUP D** (no policy,
  no ADR).
- **The one policy-free *unsurfaced* backend operation is encumbered.** The institution **IANA timezone**
  (register §24 confirmed; ADR 0036 backend; `settings.manage`, owner-only) has no Flutter surface — but it
  is **inseparable from the institution quiet-hours policy resource**: `GET/PUT /notifications/institution-settings`
  returns and *requires* the quiet-hours window (`UpdateInstitutionNotificationSettingsUseCase` rejects a
  missing/invalid window via `isValidWindow`). **Quiet hours is owner-REJECTED** (§4/§8; register §25) — "no
  UI exists or may be added" — so surfacing the timezone would mean surfacing or inventing quiet-hours data.
  **Not built, by that rejection.** (The person's own timezone, `GET/PATCH /notifications/settings`, is the
  same resource and the same encumbrance.)
- **Smallest decision that unblocks the largest real school-day slice:** approve the scheduling
  **create/edit/cancel-lesson permissions** and the storage/DST design left pending in register §24. With
  those, **one-off dated-lesson scheduling** becomes a buildable vertical slice (additive backend module +
  migration + Flutter + tests) that invents **no** attendance policy — the confirmed institution timezone
  already anchors it.

**No source, permission, schema or migration changed this pass; all prior local work (mass publish, command
center, live hand/floor) is preserved and the static gates re-ran green.**

## 4. What is NOT and must NOT be built without an owner decision

Carried verbatim in intent from the register (§3, §9, §22) and the decision brief — listed here so this
domain map cannot be mistaken for authorization:

- The **educational core** (progress, assessment, mastery, placement, certificates) — GROUP C,
  **DEFERRED by owner** (Sprint 39). `«نظام الضخ»` **EXCLUDED** (Sprint 38).
- **Assignments** (GROUP D), **operations/derived attendance record** (GROUP G, Q70), **reporting / Owner
  Command Center** (GROUP G), **automation** (GROUP G, Q71/Q3) — each needs an owner policy first.
- **Quiet hours** — **REJECTED** by the owner; no UI exists or may be added (the Sprint-35 backend code is
  inert). Per-conversation **mute** is the separate, accepted feature (DONE, Sprint 61).
- **Parent messaging / the PARENT role** (Q6/Q10) — safeguarding; needs a parent↔child model first.
- **Real push delivery** (Q24/Q65), **native live media** (ADR 0030), **P8 capacity / P11 scale** —
  external-resource / capacity gated, not owner policy.

Closing any of the above follows the standard process: an ADR records the decision, the register entry is
closed with that ADR number, this file and the roadmap are updated, and only then a scoped build.
