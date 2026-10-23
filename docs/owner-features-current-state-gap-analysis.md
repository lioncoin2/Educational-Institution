# Owner Features — Current State & Gap Analysis

**Type.** Read-only engineering audit (no implementation authorized by it).
**Audited at.** 2026-10-22. Repo `/opt/Educational-Institution`, branch `claude/trial-integration-sprints-52-61`, HEAD **`c908916`**, working tree **dirty** (118 uncommitted entries preserved; see §2.4).
**Method.** Every status below was verified against **current working-tree source** — controllers, use-cases, domain, Drizzle migrations/schema, Flutter features, and test files — plus the primary governance sources (`architecture/open-questions.md`, `owner-decision-register.md`). **The existing `owner-features-roadmap.md` was used only as the requirement list (the spine), never as evidence**; where it had drifted from source, this audit corrects it (§2.5). A UI or a model alone was never taken as proof. **Test files were read, not executed** — assertions are reported, pass/fail is **not** claimed (§11).

**Status legend (as requested).** `COMPLETE-VERIFIED` · `PARTIAL` · `MISSING` · `UNRESOLVED`. A **Gate** qualifier explains *why* a MISSING/PARTIAL item is not built: `owner-policy` (owner decision required), `excluded` (owner removed from scope), `deferred` (owner postponed), `external` (needs external resource/credentials), `dependency` (waits on another feature), or `product-definition` (needs the owner to define the concept).

---

## 1. Executive Summary

The platform is a **NestJS/Drizzle backend + Flutter/Riverpod app** with a clean, enforced module architecture (hexagonal modules talking only through `contracts/` seams; dependency-cruiser + arch-index + Flutter layering tests enforce it). The owner's feature domains divide cleanly into **built-and-real**, **built-but-gated**, and **not-built-because-an-owner-decision-is-missing** — the last category is *not* missing engineering; it is missing a policy the project rules forbid inventing (thresholds about real children, retention/erasure, assignment/grading workflow, push-provider agreements).

**Net state (10 owner domains):**

| Band | Domains | One-line |
| --- | --- | --- |
| **COMPLETE-VERIFIED** | 6 (Section→Program→Halaqa), 7 (People/permissions), 3-core (messaging + mass publish) | Full backend + Flutter + tests; real authorization per operation. |
| **PARTIAL** | 1 (Owner Command Center), 2 (Scheduling), 8 (Communities & live), 9 (Attendance) | A real, extensible foundation is built; named extensions are each gated on one owner decision or an external resource. |
| **MISSING / BLOCKED** | 4 (Absences/vacant/substitute), 5 (Assignments), 10 (Automation/task-tracking) | Genuine empty seams (`@Module({})` + a `contracts/` file, zero routes); each awaits a specific owner policy. |

**The six highest-signal findings:**

1. **The "Owner Command Center" is real but factual-only.** `GET /reporting/command-center` resolves a server-side widget registry (3 widgets: communities, academic structure, accounts) + a 4-action registry, each hidden unless the viewer holds its permission. It invents no KPI. There is **no live and no attendance widget**, and the `attention / pending_decisions / activity / kpi` dashboard categories exist in the taxonomy but are **unused** — so "institution status / daily summary" today means three count-tiles, nothing more.
2. **"التمام / daily completion", derived attendance (present/absent/late), vacant-halaqa detection, substitute suggestion, assignments, and task-tracking are all NOT built** — each blocked on a specific open owner decision (Q70 threshold, GROUP D assignments policy, an owner definition of "vacant", Q71/Q3 retention). The engineering seams exist and are boundary-clean; the policy does not.
3. **There is no leadership *audit-trail view*.** A real append-only audit log is written by six modules, and `audit.read` is a seeded owner/admin permission — but it is wired to **zero routes**. This is the single most policy-free gap in the whole map: an oversight *read* of already-recorded data.
4. **No Telegram and no Zoom integration exist** (one code comment references the institution's real-world WhatsApp/Telegram usage; live uses self-hosted **LiveKit**). The institution's "31 groups / 4 supervisors" figures are **not** hardcoded in production logic.
5. **Live audio is real code but off on Trial.** A web-first LiveKit client is now wired (behind `LIVE_MEDIA_ENABLED` + `kIsWeb` + backend mode); on Trial the provider is `fake` and the flag is off, so **no audio flows**. Native (iOS/Android) media is not started. The control plane (start/floor/presenter/kick/attendance) is authoritative regardless of media.
6. **Real push notifications do not send.** The full pipeline (device registry, dispatcher, retry/backoff) is built, but the bound provider is a no-op `LoggingPushProvider` (no FCM/APNs/web-push SDK). In-app + realtime delivery is real; **reminders and escalation do not exist** (no scheduler).

**Recommended sequencing (detail in §14), smallest-decision-first:** a short **Phase 0** of genuinely policy-free, additive slices that reuse what exists (leadership **audit-read** surface; a **"today's lessons"** day-view over the built scheduling table; surfacing the neutral institution timezone) — each needing only a one-line owner confirmation, not a new policy — then the policy-gated verticals one owner decision at a time.

---

## 2. Repository & Architecture Map

### 2.1 Top level
- `backend/` — NestJS (TypeScript), Drizzle ORM over Postgres; modules under `backend/src/modules/*`; migrations in `backend/drizzle/*.sql` (0000–0031, journal `backend/drizzle/meta/_journal.json` = 32 entries).
- `app/` — Flutter (Dart), Riverpod; features under `app/lib/features/*`, repositories under `app/lib/data/repositories/{http,mock}`, models under `app/lib/data/models`.
- `docs/` — governance: `owner-decision-register.md`, `architecture/open-questions.md` (Q1–Q72), ADRs under `architecture/decisions/`, `project-roadmap.md`, and the requirement spine `owner-features-roadmap.md`.
- `infra/` — compose files, nginx; `scripts/trial/` — Trial build/deploy.

### 2.2 Backend modules and whether they mount routes (verified)

| Module | Controllers | Route decorators | Real routes? |
| --- | :-: | :-: | --- |
| `academic` | 3 | 30 | **Yes** — structure/relationships/my-academic |
| `communities` | 3 | 23 | **Yes** — communities/grants/invitations |
| `messaging` | 2 | 23 | **Yes** — conversations/community-chat (incl. mass publish) |
| `live` | 1 | 17 | **Yes** — full control plane |
| `identity` | 2 | 15 | **Yes** — admin-users/auth |
| `notifications` | 2 | 15 | **Yes** — notifications/institution-settings |
| `files` | 3 | 7 | **Yes** — upload/complete/link |
| `operations` | 1 | 5 | **Yes** — `/operations/lessons` (scheduling) |
| `attendance` | 1 | 4 | **Yes** — snapshots record/view |
| `people` | 1 | 3 | **Yes** — search/teachers/avatar |
| `reporting` | 1 | 1 | **Yes** — `GET /reporting/command-center` |
| `realtime` | 0 | 0 | gateway only (websocket) |
| `assignments` | 0 | 0 | **No — empty seam** (`@Module({})` + contracts) |
| `automation` | 0 | 0 | **No — empty seam** (`@Module({})` + contracts) |

### 2.3 Flutter features (`app/lib/features/`)
`academic_admin, admin, announcements, attendance, auth, certificates, command_center, communities, episode, home, learning_path, lesson, live, messaging, notifications, profile, programs, progress, publish, scheduling, splash, student, teacher`. **No `assignments`, `operations`, `automation`, or `people` feature dir** (people = `admin` + pickers; scheduling = operations' surface). `announcements`, `progress`, `certificates` are **demo/mock-only** screens (no backend behind them).

### 2.4 Working-tree state (committed vs uncommitted — material to the audit)
- **One commit since the roadmap's baseline** (`9b4a6de..c908916`): *"web-first Trial release — Owner Command Center, Mass Publishing, Pinned Messages, Trial runtime (ADR 0037/0040/0041/0043)"*. So Command Center, Mass Publish, Pinned Messages and **operations scheduling (migrations 0026/0027, tracked)** are **committed** in HEAD and deployed to `trial-api` (`institution-api:trial-c908916-ad`).
- **Uncommitted in the working tree (preserved):** the **community↔halaqa many-to-many** work (`backend/drizzle/0030_community_halaqa_links.sql`, `0031_program_cover_image.sql` — both **untracked**; + 15 communities + 13 academic backend files), the **program-cover** feature, the Task-10 Trial backend-mode fix, the Task-12 episode "linked communities" section, and reply-workflow/live-binding edits. `docs/architecture-index.md` and `docs/owner-decision-register.md` are modified-in-tree.
- **Consequence:** the audited *working tree* shows community↔halaqa as **m:n**; the *committed/deployed* `c908916` still carries the earlier **scalar** single-halaqa link (migration 0021). Any statement below tagged **(uncommitted)** is present in source but not yet committed or deployed.

### 2.5 Corrections to `owner-features-roadmap.md` (drifted since its 9b4a6de audit)
- Roadmap says `operations` mounts "zero routes" — **stale**; `operations` now mounts 5 (scheduling, ADR 0042).
- Roadmap/memory: "shipped binding intentionally `UnavailableLiveMediaClient`" — **stale**; a real web-first LiveKit client **is wired** (gated; §8/§COM-7). Several in-code comments ("not yet bound", "no live audio in this build") are stale vs. current code.
- Community↔halaqa: roadmap/ADR describe the m:n; it is real **but uncommitted** (above).
- Minor: there is **no `live.start` identity permission** — START is gated by `live.moderate`.

### 2.6 Architecture spine (how modules talk)
Each module is **hexagonal**: `api/` (controllers/DTOs) → `application/` (use-cases) → `domain/` (pure) → `infrastructure/` (Drizzle adapters) → `contracts/` (its **only** public cross-module surface). Cross-module calls go **through `contracts/` tokens** (e.g. `COMMUNITY_AUTHORIZATION`, `ACADEMIC_RELATIONSHIPS`, `COMMUNITY_MEMBERSHIP`, `ACCOUNT_DIRECTORY_SUMMARY`). Enforced by `backend/.dependency-cruiser.cjs`, `backend/test/architecture/architecture-index.spec.ts`, per-module `*-boundaries.spec.ts`, and Flutter `app/test/architecture/layering_test.dart`. This is the pattern any new work must follow (§13).

---

## 3. Feature Traceability Matrix

Every roadmap requirement (incl. the §4 operational list: daily summary, daily tasks/التمام, mass publish, academic+linked communities, absences/vacant/substitute, assignment lifecycle, main-halaqa planning/tracking, prep lists/supervisory follow-up, leadership reports/audit trail, notifications/reminders/escalation, operational groups). Evidence paths are representative; see §4–§11 for full detail.

### Domain 1 — Owner Command Center

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| OCC-1 | Server-resolved widget registry, re-authorizes & hides per-viewer | **COMPLETE-VERIFIED** | `reporting/api/reporting.controller.ts` (`GET /reporting/command-center`, `reports.read`); `application/get-command-center.use-case.ts` (re-authz; hidden widget's `resolve()` never called); `api/responses.ts` strips `requiredPermission` | — |
| OCC-2 | Communities summary widget | **COMPLETE-VERIFIED** | `application/widgets/communities-summary.widget.ts` (`communities.read`, `COMMUNITY_MEMBERSHIP.listHeads`) | — |
| OCC-3 | Academic structure widget | **COMPLETE-VERIFIED** | `academic-structure.widget.ts` + `academic/application/academic-structure-summary.service.ts` (reuses `catalogue()`, no migration) | — |
| OCC-4 | Accounts summary widget | **COMPLETE-VERIFIED** | `accounts-summary.widget.ts` + `identity/application/account-directory-summary.service.ts` (`users.manage`, `countByStatus`) | — |
| OCC-5 | Quick-actions registry (publish/create-community/academic/accounts) | **COMPLETE-VERIFIED** | `application/command-actions.ts` (4 actions, each `requiredPermission`-filtered) | — |
| OCC-6 | "Who is live now" widget | **MISSING** | only 3 providers bound (`reporting.module.ts`) | Gate: dependency (needs a live-module read) |
| OCC-7 | Attendance (present/absent) widget | **MISSING** | — | Gate: owner-policy (Q70) |
| OCC-8 | Daily summary / institution status beyond 3 count-tiles (attention, pending-decisions, activity, KPI, prep) | **MISSING** | `WidgetCategory` enum has the categories; none but `today` is registered | Gate: product-definition + per-category dependency |

### Domain 2 — School-day & lesson scheduling

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| SCH-1 | One-off dated-lesson CRUD, owner/admin | **COMPLETE-VERIFIED** | `operations/api/operations.controller.ts` (5 routes, all `operations.schedule_manage`; cancel = POST transition, not delete); `operations-access.ts` re-authorizes in use-case | — |
| SCH-2 | DST-correct storage (wall clock + IANA + instant) | **COMPLETE-VERIFIED** | `domain/time-resolution.ts` (gap→`nonexistent` 422; fold→earlier instant); migration `0026` (3 cols + `scheduled_at`) | — |
| SCH-3 | Strict-future + auditable cancel | **COMPLETE-VERIFIED** | `domain/scheduling-policy.ts` (`<= now` rejected); `domain/lesson.ts` (SCHEDULED→CANCELLED terminal, row kept, DB CHECK) | — |
| SCH-4 | Idempotent create | **COMPLETE-VERIFIED** | partial unique index `(created_by, client_request_id)`; 201/200 replay | — |
| SCH-5 | Flutter scheduling surface | **COMPLETE-VERIFIED** | `features/scheduling/*` (list/form/detail; program→halaqa cascade, IANA dropdown, duplicate-submit guard); profile entry gated | — |
| SCH-6 | Recurrence | **MISSING** | grep-confirmed absent | Gate: owner (no recurrence confirmed, §24) |
| SCH-7 | Conflict / overlap detection | **MISSING** | `scheduling-policy.ts` comment: a later decision | Gate: product-definition ("conflict") |
| SCH-8 | Scheduling horizon (upper bound) | **MISSING** | only lower-bound future check | Gate: owner-policy |
| SCH-9 | Teacher authorship of lessons | **MISSING** | `createdBy` = owner/admin only | Gate: owner-policy (Q31) |
| SCH-10 | Scheduling notifications | **MISSING** | no notif in operations | Gate: owner-policy (Q28) |
| SCH-11 | "Emergency management" | **MISSING** | zero `emergency` refs anywhere | Gate: product-definition (undefined in any source) |
| SCH-12 | "Today's lessons" / day-view read | **MISSING** | only keyset list by `(scheduledAt,id)`; no date-window query | Gate: none — additive query (**Phase-0 candidate**, §14) |
| SCH-13 | "الحلقة الرئيسية" main-lesson plan + execution tracking | **PARTIAL** | plan = SCH-1; execution = observation-only attendance (ATT) | Gate: no "main lesson" concept; execution-tracking blocked by Q70 |

### Domain 3 — Mass publishing & communication

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| MSG-1 | Direct + two-way DM (student↔teacher, student↔student) | **COMPLETE-VERIFIED** | `messaging/api/conversations.controller.ts` (`POST /messaging/conversations/direct`); `create-conversation.use-cases.ts`; migrations 0018/0019 | — |
| MSG-2 | Community chat + modes (open/restricted/channel) | **COMPLETE-VERIFIED** | enforcement in `communities/application/community-authorization.service.ts` (`POSTING_MEMBER_RULE` for GROUP_OPEN vs `community.chat.post`); migration 0025 | — |
| MSG-3 | Message moderation (delete/review) | **COMPLETE-VERIFIED** | `moderate-message.use-cases.ts` (`community.messages.moderate`; 7-day review window) | — |
| MSG-4 | Attachments (web) + signed links | **COMPLETE-VERIFIED** | send media routes (`messaging.send`) → `FILE_ASSETS.verifyAttachable`; `attachment-link.use-case.ts` | — |
| MSG-5 | Per-conversation mute | **COMPLETE-VERIFIED** | `notifications/application/conversation-mute.use-cases.ts`; migration 0022 | — |
| MSG-6 | Pinned messages + reply | **COMPLETE-VERIFIED** | `pin-message.use-cases.ts` (`community.messages.moderate`); migrations 0028/0029; reply = `replyToMessageId` on send DTO | — |
| MSG-7 | **Mass publish to many communities + per-destination result** (§4 item 3) | **COMPLETE-VERIFIED** | `publish-to-communities.use-case.ts` (`POST /messaging/communities/publish`, `messaging.send`; `authorizeEach(community.chat.post)`; MessageSender reuse; 9 outcomes; partial-failure ok; transient-only retry; **sha256 `batchKey(clientBatchId+communityId)`** idempotency; single media verify; 50-target cap); `features/publish/*` | — |
| MSG-8 | Persistent announcement feed | **MISSING** | `features/announcements` is mock; no backend; `ANNOUNCEMENT_CREATED` notif inactive | Gate: owner-policy (not requested) |
| MSG-9 | Standalone messaging group/channel creation + participant admin | **PARTIAL** | perms `messaging.create_group/create_channel` seeded; community-based chat built; no standalone messaging-group participant-admin surface | Gate: owner-deferred (§23) |
| MSG-10 | «نظام الضخ بين الأقسام» (cross-section progression move) | **MISSING** | — | Gate: **excluded** by owner (§22, Sprint 38) — distinct from MSG-7 |

### Domain 4 — Absences, vacant halaqat, substitute suggestion

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| ABS-1 | Staffing-absence recording (a teacher is absent) | **MISSING** | no concept; attendance = student connectivity only | Gate: owner-policy |
| ABS-2 | Vacant / uncovered halaqa detection | **MISSING** | grep-confirmed absent (no route/table/perm) | Gate: product-definition ("vacant halaqa") |
| ABS-3 | Substitute (بديل) suggestion | **MISSING** | — | Gate: owner-policy + dependency (automation rule) |

### Domain 5 — Assignments / submission / grading / reminders

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| ASG-1 | Assignment lifecycle: create→approve→publish→submit→grade→complete | **MISSING** | `assignments/assignments.module.ts` = `@Module({})`; `contracts/index.ts` = types only (`SubmissionState`, `AssignmentRef`, `SubmissionRef`); zero routes/tables; perms `assignments.read/submit/manage` seeded (0002) back nothing; `ASSIGNMENT_CREATED/UPDATED` notif inactive; no Flutter dir | Gate: owner-policy (GROUP D — no policy, no ADR) + dependency (Q31 teacher scope) |

### Domain 6 — Section → Program → Halaqa

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| ACA-1 | Sections/programs/halaqat CRUD + activate/deactivate | **COMPLETE-VERIFIED** | `academic/api/structure.controller.ts` (`academic.manage`); migration 0007 | — |
| ACA-2 | Enrollment admin + read-only history | **COMPLETE-VERIFIED** | `relationships.controller.ts` (enroll/end + `/students/:id/enrollments`) | — |
| ACA-3 | Teacher-assignment admin + read-only history | **COMPLETE-VERIFIED** | `relationships.controller.ts` (assign/end + `/teachers/:id/assignments`) | — |
| ACA-4 | `/academic/me` self-views | **COMPLETE-VERIFIED** | `my-academic.controller.ts` (never takes a person id) | — |
| ACA-5 | Program cover image (ADR 0038) | **COMPLETE-VERIFIED (uncommitted)** | `PUT/DELETE/GET /academic/programs/:id/cover`; migration 0031 (academic→files ref) | Not committed/deployed |
| ACA-6 | Model = Section→Program→Halaqa, **no Level** | **COMPLETE-VERIFIED** | schema has `academic_sections/programs/halaqat` only; "level" only in prose + demo `programs`/`learning_path` UI label (= halaqat) + stale seed-description strings | — |
| ACA-7 | Educational core (progress/assessment/mastery/progression/certificates) | **MISSING** | `UnrecordedProgressRepository`→null; certificates mock in both modes | Gate: **deferred** by owner (GROUP C, §22) |

### Domain 7 — People / delegation / permissions

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| PPL-1 | Account provisioning + lifecycle admin (roles/status/password/sessions) | **COMPLETE-VERIFIED** | `identity/api/admin-users.controller.ts` (`users.manage`, `roles.assign`, `sessions.manage`; no-escalation/not-self guards) | — |
| PPL-2 | Self-service auth (login/refresh/logout/me/sessions/password) | **COMPLETE-VERIFIED** | `identity/api/auth.controller.ts` | — |
| PPL-3 | People search (owner/admin only) | **COMPLETE-VERIFIED** | `people/api/people.controller.ts` `GET /people` (`people.read`; migration 0020 removed it from SUPERVISOR/TEACHER) | — |
| PPL-4 | Teacher directory | **COMPLETE-VERIFIED** | `GET /people/teachers` (`messaging.start_direct_teacher`) | — |
| PPL-5 | Person avatars | **COMPLETE-VERIFIED** | `GET /people/:id/avatar` | — |
| PPL-6 | Per-community delegation grants + invitation links | **COMPLETE-VERIFIED** | `communities/api/community-grants.controller.ts` + `community-invitations.controller.ts`; migration 0011 | — |
| PPL-7 | One-permission-per-operation model; 6 roles | **COMPLETE-VERIFIED** | `identity/contracts/permissions.ts` + `application/provisional-policy.ts`; roles table is runtime authority | — |
| PPL-8 | PARENT role | **MISSING** | `role.ts`: deliberately inactive | Gate: owner-policy (Q10, safeguarding) |
| PPL-9 | "Section-head" role | **MISSING** | no such role (only `SectionHeader` UI widget); SUPERVISOR is the oversight role | Gate: owner-policy (if a distinct role is wanted) |

### Domain 8 — Communities & live streaming

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| COM-1 | Community lifecycle (create/lock/members/owner-transfer/leave) | **COMPLETE-VERIFIED** | `communities/api/communities.controller.ts` (17 routes; acts re-decided in use-cases) | — |
| COM-2 | Community↔halaqa link, **m:n** | **COMPLETE-VERIFIED (uncommitted)** | `community_halaqa_links` (migration 0030; scalar 0021 dropped); `halaqaIds[]` on wire + Flutter model | Not committed/deployed (deployed `c908916` still scalar) |
| COM-3 | Community profile + avatar | **COMPLETE-VERIFIED** | `PUT /communities/:id/profile` (`community.profile.edit`); migration 0024 | — |
| COM-4 | Chat-mode management | **COMPLETE-VERIFIED** | `PUT /communities/:id/chat-mode` (`community.chat.manage`; CHANNEL immutable); no `kind` column (display-derived) | — |
| COM-5 | Member-candidate discovery | **COMPLETE-VERIFIED** | `GET /communities/:id/member-candidates` (act `community.members.invite`) | — |
| COM-6 | Live control plane (start/end/current/join-ticket/kick/reset/presenter/floor) | **COMPLETE-VERIFIED** | `live/api/live.controller.ts` (17 routes; `live.join/raise_hand/speak/moderate`; **no `live.start`** — START uses `live.moderate`) | — |
| COM-7 | Real live audio/video | **PARTIAL** | LiveKit web client real & wired (`livekit_room_port.dart`, bound in `app_providers.dart` behind `LIVE_MEDIA_ENABLED`+`kIsWeb`+backend; backend `LiveKitRtcProvider` when `LIVE_MEDIA_PROVIDER=livekit`) — **but Trial = `fake`, flag off ⇒ no audio** | Gate: owner-policy (enable binding) + external (GROUP F) |
| COM-8 | Native (iOS/Android) media | **MISSING** | `kIsWeb` gate ⇒ `UnavailableLiveMediaClient` off web | Gate: external (devices/signing, ADR 0030) |

### Domain 9 — Attendance & reports

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| ATT-1 | Attendance **record** (snapshots, observation-only) | **COMPLETE-VERIFIED** | `attendance/api/attendance.controller.ts` (4 routes, `@Authenticated()` + community-standing acts `community.attendance.record/view`); migration 0015; counts only (`CONNECTED/CONNECTING`) | — |
| ATT-2 | Attendance **view** (list/detail/participants) | **COMPLETE-VERIFIED** | same controller; `features/attendance/*` (UI shows "متصل/قيد الاتصال", no ratio/verdict) | — |
| ATT-3 | Derived present/absent/late **record** | **MISSING** | the only such type (`operations/contracts` `AttendanceState`) is **dormant/unused** | Gate: owner-policy (Q70 — forbidden to invent) |
| ATT-4 | Reporting/analytics over attendance | **MISSING** | no attendance widget, no aggregation; attendance is a leaf | Gate: owner-policy + dependency (GROUP G) |
| ATT-5 | "التمام" (daily completion roll-call) | **MISSING** | connectivity ≠ completion | Gate: owner-policy (Q70) |

### Domain 10 — Automation & task tracking

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| AUT-1 | Daily tasks / work-item tracking (assign, status, due, completion follow-up) (§4 item 2) | **MISSING** | no task/todo/due-date record model anywhere; `assignments.*` = academic homework, not staff tasks | Gate: owner-policy + product-definition |
| AUT-2 | Automation rule engine | **MISSING** | `automation.module.ts` = `@Module({})`; `contracts/index.ts` = `AutomationRule` interface only; no tables | Gate: owner-policy (GROUP G) |
| AUT-3 | Retention / erasure job | **MISSING** | `StorageProvider.delete()` exists; nothing schedules it | Gate: owner-policy (Q3/Q71) |

### Cross-cutting (§4 items 9–11)

| ID | Requirement | Status | Evidence | Gap / Gate |
| --- | --- | --- | --- | --- |
| CC-1 | Leadership reports (تقارير القيادة) | **PARTIAL** | command-center = 3 factual tiles; no analytical reports | Gate: per-report owner-policy |
| CC-2 | Audit trail **view** (سجل التدقيق) | **PARTIAL** | write path real (`platform/audit/*`, 6 modules write); **`audit.read` seeded but wired to zero routes — no read surface** | Gate: none to read existing data — **Phase-0 candidate** (§14), pending "who may read" |
| CC-3 | Notifications (in-app + realtime) | **COMPLETE-VERIFIED** | `notifications/*` (11 active types); inbox/preferences/mutes/devices | — |
| CC-4 | Reminders | **MISSING** | no cron/scheduler | Gate: owner-policy + dependency (automation) |
| CC-5 | Escalation | **MISSING** | — | Gate: owner-policy |
| CC-6 | Real push delivery | **MISSING** | `LoggingPushProvider` no-op; no SDK | Gate: external (GROUP E — owner provides FCM/Apple) |
| CC-7 | Operational "groups" (admin / section-head / assignment / grading) (§4 item 11) | **PARTIAL** | realized as **communities** (groups/channels, create + per-community delegation); not pre-modeled as named institutional groups, and no hardcoded "31" | Gate: product-definition (if named/seeded groups are wanted) |
| CC-8 | Prep lists & supervisory follow-up (قوائم التحضير والمتابعة) | **MISSING** | no prep-list feature; supervisor = read-only oversight perms + command-center facts | Gate: product-definition |
| CC-9 | Daily summary / institution status (ملخص اليوم) | **PARTIAL** | = 3 command-center "today" widgets; no digest/day-view | Gate: product-definition (see OCC-8) |

---

## 4. Existing Capabilities (reusable — do not rebuild)

These are built, real, server-authorized, and tested, and are the **reuse surface** for any new work:

- **Authorization kernel.** Identity `Permissions` (coarse edge `@RequirePermission`) **+** community **acts** (fine, re-decided per community in use-cases via `COMMUNITY_AUTHORIZATION`). Every operation re-authorizes server-side; the HTTP edge is only a ceiling. One-permission-per-operation, 6 roles, no-escalation/OWNER≠ADMIN invariants. → reuse for every new route.
- **Module contracts/ seams.** `ACADEMIC_RELATIONSHIPS` (`halaqaExists`, roster scope), `ACADEMIC_STRUCTURE_SUMMARY` (`catalogue()`), `COMMUNITY_AUTHORIZATION` / `COMMUNITY_MEMBERSHIP` (`authorizeEach`, `listHeads`), `ACCOUNT_DIRECTORY_SUMMARY` (`countByStatus`), `FILE_ASSETS` (`verifyAttachable`, signed links), `MessageSender`, the notifications **dispatcher + event bus**, the **audit log** port. → new modules consume these, never reach into another module's tables.
- **Reporting registry.** `WIDGET_PROVIDERS` + `COMMAND_ACTIONS` grow by **one provider / one line** per approved fact — the right home for a live widget, an attendance widget (once Q70), or leadership reports.
- **Scheduling.** `operations_lessons` + the pure `time-resolution.ts` DST resolver + `scheduling-policy.ts` future/horizon seam + idempotency — reuse for a day-view (SCH-12) and any future horizon/conflict rule.
- **Attendance snapshots.** Immutable observation records + `attendance/contracts` events — the input a future derived `AttendanceRecord` reads (operations→attendance direction, never the reverse).
- **Messaging + mass publish.** `MessageSender`, community-chat materialization, the publish fan-out with idempotent `batchKey` and 9-value per-destination outcomes — reuse for any "broadcast to targets with per-target results".
- **Files pipeline.** declare→signed-PUT→complete→`verifyAttachable`→short-lived link — reuse for assignment submissions, announcement media, program covers.
- **Flutter dual-mode.** `backendModeProvider`/`BackendConfig`, repository interfaces with `Http*`/`Mock*`, Riverpod controllers with loading/empty/error/retry + honest "no data" + mock ribbons — reuse for every new feature screen.

---

## 5. Partial Implementations (need completion — the gap is scoped)

| Domain | What works | What's missing (the scoped gap) |
| --- | --- | --- |
| **1 Command Center** | registry + 3 factual widgets + 4 actions, per-viewer hiding | live widget (needs a live read), attendance widget (Q70), the non-`today` dashboard categories, any analytical/leadership report |
| **2 Scheduling** | one-off dated-lesson CRUD, DST, future-only, auditable cancel, Flutter | day-view/"today's lessons" (SCH-12, **additive**), horizon, conflict, teacher authorship, notifications, "emergency" |
| **8 Communities & live** | full community lifecycle + control plane + web LiveKit code | audio OFF on Trial (fake/flag), native media not started |
| **9 Attendance** | record + view (observation-only) | derived present/absent/late (Q70), any report/analytics (GROUP G), "التمام" |
| **CC leadership/audit/notifications** | audit **written**; notifications in-app+realtime | audit **read** surface (CC-2), leadership reports (CC-1), reminders/escalation (CC-4/5), real push (CC-6), prep lists (CC-8), daily digest (CC-9) |

---

## 6. Missing Capabilities (verified absent)

- **Derived attendance / "التمام"** (ATT-3/5) — no present/absent/late logic anywhere; the only such type is dormant.
- **Absences / vacant-halaqa / substitute** (ABS-1/2/3) — no concept, route, table, or permission.
- **Assignments** (ASG-1) — empty seam (types + seeded perms only).
- **Automation & task-tracking** (AUT-1/2/3) — empty seam; no task/due-date model; no scheduler; no retention job.
- **Leadership audit-trail view** (CC-2) — `audit.read` seeded, zero routes.
- **Reminders & escalation** (CC-4/5), **real push** (CC-6) — no scheduler; no push SDK.
- **Prep lists / supervisory follow-up** (CC-8), **daily digest / rich institution status** (CC-9, OCC-8).
- **Persistent announcement feed** (MSG-8). **PARENT role** (PPL-8). **Native live media** (COM-8).
- **Telegram / Zoom integration** — absent (§10).

---

## 7. Unresolved Items (evidence insufficient / needs owner input to classify)

| ID | Why unresolved | What would resolve it |
| --- | --- | --- |
| U-1 | **Test pass/fail not asserted.** Test files were read (coverage is broad — §11), **not executed** this audit. Existence ≠ green. | Run `backend npm test` + `flutter test` (read-only) and record actual results. |
| U-2 | **"Institution status / daily summary / prep lists" (OCC-8, CC-8/9)** — whether the 3 command-center tiles "satisfy" these is a product judgment, not a code fact. | Owner defines what a daily summary / prep list must contain (then each becomes a scoped widget/report). |
| U-3 | **Operational "groups" (CC-7)** — whether the owner wants the real-world 31 groups / 4 supervisors **modeled as named institutional entities** or kept as ad-hoc communities. | Owner states whether named/seeded groups + a section-head role (PPL-9) are required. |
| U-4 | **Committed vs working-tree provenance** of the LiveKit binding line and some A+D edits — present in the working tree; exact commit state not material to feature status but noted. | A commit (owner-authorized) would settle it. |

Nothing else was left unverified: every other row was confirmed by direct source read + repo-wide greps.

---

## 8. Architecture & Data Flow

**Backend.** Hexagonal modules (§2.6). Request path: HTTP → `AccessGuard` (`@RequirePermission` edge) → controller → **use-case re-authorizes** (identity `AuthorizationService.authorize/can` and/or `COMMUNITY_AUTHORIZATION` act) → domain (pure) → infrastructure (Drizzle) → **audit** (`AuditLog.record`) then **domain event** (notifications dispatcher subscribes). The re-authorization inside the use-case is the true boundary; a guessed id is authorized *before* lookup (verified in operations/attendance), so enumeration leaks nothing.

**Authorization (two layers).** (1) institution-wide **permissions** (roles→permissions matrix, runtime `roles`/`role_permissions` tables are authority; code catalogue `permissions.ts` is the closed vocabulary). (2) per-community **acts/capabilities** (`community.*`, delegable grants, ceilings) re-checked against the specific community. Attendance deliberately names **no `attendance.*` identity permission** — it scopes by community standing.

**Sources of truth.** Academic structure = `academic_*` tables (FK chain all RESTRICT). Community membership/grants = `communities` + `community_*` tables. Messages = messaging conversation/message tables (community chat is a CHANNEL conversation linked by `communityId`). Attendance = `attendance_snapshots` (+ entries), append-only/immutable. Scheduling = `operations_lessons`. Accounts = `users`. **Reporting and automation own no tables** (reporting reads others' contracts; automation would subscribe to events).

**Command-center data flow (exemplar of the additive pattern).** Flutter `commandCenterProvider` → `GET /reporting/command-center` → `GetCommandCenterUseCase` re-checks `reports.read`, then for each bound `WidgetProvider`: if the viewer holds its `requiredPermission`, call `provider.resolve(userId)` which reads **another module's `contracts/`** (never its tables) and returns **facts only**; the response strips `requiredPermission`. Adding a widget = a new `contracts/` read in the owning module + one line in `reporting.module.ts`.

**Partial-failure / idempotency (already solved, reusable).** Mass publish: `authorizeEach` → per-target `MessageSender` with deterministic `clientMessageId = sha256(clientBatchId∥communityId)` ⇒ safe retry, per-target outcome, transient-only `retryable`. Scheduling + attendance: `clientRequestId` partial-unique indexes ⇒ idempotent create/record. These are the templates for any new fan-out or retried write.

**Flutter.** Riverpod; `backendModeProvider` selects `Http*` vs `Mock*` repos; controllers re-read authoritative server state (no optimistic lies); `layering_test.dart` forbids `data/core`→`features` and UI→concrete-repo imports.

---

## 9. Permissions & Audit Review

**Permission catalogue** (`identity/contracts/permissions.ts`; seeded 0001/0002/0005/0008/0009, mutated 0020/0027): `users.read/manage`, `roles.assign`, `sessions.manage`, `audit.read`, `settings.manage`, `people.read/manage`, `academic.read/manage/teach/study`, `attendance.read/manage`, `assignments.read/submit/manage`, `messaging.read/send/start_direct[/_peer/_teacher]/create_group/create_channel/manage`, `live.join/raise_hand/speak/moderate`, `communities.read/create/moderate/manage`, `files.read/upload`, `reports.read`, `operations.schedule_manage`.

**Default role matrix** (`provisional-policy.ts`): **OWNER** all; **ADMIN** all except `settings.manage` + `messaging.manage`; **SUPERVISOR** read-only oversight (`users.read, academic.read, attendance.read, assignments.read, reports.read, messaging.*basic, communities.read`; **no `people.read`** after 0020); **TEACHER** (academic.teach/read, attendance.manage, assignments.manage, messaging, live.speak/moderate, communities.moderate…); **ASSISTANT_TEACHER**; **STUDENT** (academic.study, assignments.submit, messaging.start_direct_peer/_teacher, live.raise_hand…). `operations.schedule_manage` = OWNER+ADMIN only (0027). **No PARENT, no section-head role.**

**Reserved-but-unwired (important):** `audit.read`, `attendance.read`, `attendance.manage`, `people.manage`, and `messaging.create_channel`/`messaging.manage` (partly) exist in the catalogue but are **not enforced by any feature today** — placeholders for deferred work. Flagging so they are not mistaken for live capability.

**Audit log.** `backend/src/platform/audit/{drizzle-audit-log,logging-audit-log,schema}.ts`, port `shared/audit.ts` exposing **only `record()`**. Table `audit_log` (actor, action, resourceType, resourceId, metadata jsonb, correlationId, occurredAt) + two read indexes. **Writers:** messaging (moderate/membership/create/pin), communities, attendance, live, academic, identity (password + admin actions). **Read surface: NONE** — `audit.read` is seeded to OWNER/ADMIN but no controller handles an audit path (grep-confirmed). ⇒ **a leadership audit view is unbuilt** and is the most policy-free additive slice (reads existing data; invents nothing). Retention of audit entries is Q3 (open) — but *reading* current entries needs no retention decision.

---

## 10. Integration Review (Telegram / Zoom / external)

- **Telegram — ABSENT.** One reference, a comment in `app/lib/data/models/learning.dart:85` noting the institution's real-world teaching runs through WhatsApp/Telegram groups (from the printed profile). No SDK, client, config, route, or env. The halaqa "فتح المجموعة" button is an explicit out-of-scope toast ("خارج نطاق النموذج الأولي"). **Do not assume any Telegram integration.**
- **Zoom — ABSENT.** Zero product references (only "zoomable image" UI). Live uses **self-hosted LiveKit** (`platform/config/livekit-config.ts`; providers `LiveKitRtcProvider`/`FakeRtcProvider`/`DisabledRtcProvider`), not Zoom.
- **Push providers — NOT integrated.** `PUSH_PROVIDER_NAMES=['APNS','FCM']` named, but bound provider is `LoggingPushProvider` (no-op); **no FCM/APNs/web-push SDK in `backend/package.json`**. Device-token registration exists (`POST /notifications/devices`).
- **LiveKit — real, self-hosted, gated** (§COM-7). TURN configured-not-verified (per governance).
- **Hardcoded institution figures — NONE.** "31 groups"/"4 supervisors" are **not** in production logic; a seed bootstrap uses an owner **minimum of 10 halaqat/program** ("never a cap"), and printed-profile figures (e.g. `levelsCount`) live only in display-only demo models.

---

## 11. Testing & Quality Gaps

**Coverage exists and is broad** (file-level evidence; assertions read, not executed — U-1):
- **Backend:** per-module `domain/*.spec.ts` + `application/*.spec.ts`; HTTP `backend/test/api/*.api.spec.ts`; **Postgres integration** `backend/test/integration/*-postgres.spec.ts` (incl. CI-enforced `academic-journey-postgres`, `community-chat-posting-postgres`, `operations-postgres`, `attendance-postgres`); **architecture** `backend/test/architecture/*-boundaries.spec.ts` + `authorization.spec.ts` (route→permission map) + arch-index; LiveKit `backend/test/livekit/*` + `e2e/provision-live-session.spec.ts`.
- **Flutter:** per-feature screen/controller/model/repo tests; boundary guards (`layering_test`, `community_boundaries_test`, `live_boundaries_test`, `attendance_boundaries_test`); LiveKit e2e (`app/test/e2e/livekit_*_e2e_test.dart`).

**Gaps / risks in the test surface:**
- **No tests exist for unbuilt features** (assignments, automation/task-tracking, derived attendance, vacant/substitute, audit-read, reminders) — expected, but means these have **zero regression protection** when built.
- **Real push + real LiveKit audio** are not exercisable in unit/CI without external resources (device, media server); LiveKit has a dedicated dispatch-only CI (`live-e2e.yml`), not the default suite.
- **Pass/fail not confirmed this audit** (U-1). The working tree is mid-change (A+D m:n uncommitted); a full suite run is the recommended first verification step before any build.
- **Stale in-code comments** (LiveKit "not yet bound", "no live audio in this build", "no LiveKit dependency") contradict current code — a documentation-quality risk, not a functional one.

---

## 12. Dependencies & Risks

**Dependency graph (owner-decision gated, from `owner-decision-register.md` §5 + open-questions):**
- `Q70` (present/absent/late rule) → **derived attendance record** (operations reads `attendance/contracts`) → **attendance reports / command-center widget / "التمام"** (ATT-3/4/5, OCC-7) → part of **main-halaqa execution tracking** (SCH-13).
- `Q71`+`Q3` (retention/erasure) → **automation retention job** (AUT-3) → prerequisite for automation rules (AUT-2) and reminders (CC-4).
- **GROUP D policy** (+ `Q31` teacher scope, resolved) → **assignments** (ASG-1) → reminders (ASG notif types already reserved).
- **GROUP E** (owner provides FCM/Apple + preview/retention policy) → **real push** (CC-6) → reminders/escalation delivery (CC-4/5).
- **GROUP F** (enable binding + devices/load) → **live audio** (COM-7) + **native** (COM-8).
- **Owner definition** of "vacant halaqa" + substitute workflow → **ABS-2/3** (then an automation rule).
- **≥1 approved fact** per module → **reporting widget** (OCC-6/7, CC-1).

**Risks:**
- **R1 — Inventing policy about children** (attendance thresholds, progression, assignment grading) is explicitly forbidden and low-reversibility (an institutional assertion about real students). *Mitigation:* build only after an owner rule + ADR.
- **R2 — Uncommitted A+D m:n drift.** The community↔halaqa m:n is in the working tree only; the deployed `trial-api` (`c908916`) is scalar, so `halaqaIds[]` may be empty on Trial. *Mitigation:* commit + migrate A+D before relying on m:n in any new feature; verify migration 0030 on an isolated DB (already done per governance).
- **R3 — Retried/partial-failure correctness** for any new fan-out. *Mitigation:* reuse the proven `batchKey`/`clientRequestId` idempotency pattern (§8).
- **R4 — Boundary erosion.** A new module reaching into another's tables breaks dependency-cruiser/arch-index. *Mitigation:* go through `contracts/` only.
- **R5 — Over-centralization.** Putting all owner features in one screen/file. *Mitigation:* the modular design in §13.
- **R6 — Reserved-but-unwired permissions** (`audit.read`, `attendance.*`) can be mistaken for live capability. *Mitigation:* treat catalogue presence ≠ enforcement.

---

## 13. Proposed Modular Design (for review — not authorized to build)

Preserve **Section → Program → Halaqa** (no Level). Every new unit follows the existing `contracts/` seam; nothing reaches another module's tables; reporting grows one provider at a time. **No policy is invented here** — each unit lists the owner decision it needs first.

| Unit (module) | Responsibility & boundary | Contracts it consumes / exposes | Source of truth | Permissions | Owner decision required first |
| --- | --- | --- | --- | --- | --- |
| **`operations` (extend)** | (a) **day-view read** "today's lessons" over `operations_lessons`; (b) future **derived `AttendanceRecord`** from snapshots; (c) **vacant-halaqa** detection | consumes `attendance/contracts`, `ACADEMIC_RELATIONSHIPS`; exposes a reporting contract for a schedule/attendance widget | `operations_lessons` (+ a new derived-record table, additive) | `operations.schedule_manage` (read); a new record perm | (a) none; (b) **Q70**; (c) "vacant" definition |
| **`assignments` (fill seam)** | assignment/submission/grading lifecycle; emits `ASSIGNMENT_*` | consumes `ACADEMIC_RELATIONSHIPS` (halaqa/teacher scope, Q31), `FILE_ASSETS` (submissions), notifications | new `assignment_*` tables (additive) | `assignments.read/submit/manage` (seeded) | **GROUP D** workflow policy + ADR |
| **`automation` (fill seam)** | event-driven rules: **retention/erasure** job; **substitute-suggestion** rule; reminder scheduling | subscribes to domain events; calls `StorageProvider.delete`, notifications | own rule store (additive) | new `automation.*` | **Q3/Q71** (retention); substitute workflow |
| **`reporting` (extend)** | one widget per approved fact: **live-now**, **attendance**, **leadership reports**; a read for the audit view | consumes `live`, `attendance`, `audit` contracts | none (reads others) | `reports.read` (+ `audit.read` for the audit widget) | per-widget fact approval; Q70 for attendance |
| **`audit-read` (new read surface, likely in `identity` or a thin `oversight` module)** | **leadership audit-trail view** over the existing append-only log | consumes the audit `schema`; exposes a read use-case | `audit_log` (read-only) | `audit.read` (seeded) | only "who may read + any redaction" (no retention decision needed to read) |
| **`notifications` (extend)** | real push adapter; reminder/escalation delivery | binds a real `PushProvider`; a `PushDelivery` quiet-hours/mute filter (already partly built) | existing | existing | **GROUP E** (provider/credentials + preview policy) |
| **Flutter** | one feature dir per unit (`features/assignments`, extend `features/scheduling`/`command_center`, a `features/audit`), reusing dual-mode repos + Riverpod controller pattern | — | — | gate each entry on the server permission (courtesy; server enforces) | — |

**Keep it modular:** each owner capability is its own module + feature dir with its own contract, not a monolithic "owner screen". The command center **links out** to these (it already maps actions→routes), rather than absorbing them.

---

## 14. Prioritized Implementation Roadmap (for review — do not start)

Ordered by dependency, impact, and risk — **smallest owner decision first**. None is authorized by this audit.

**Phase 0 — policy-free, additive, high-trust (needs only a one-line owner confirmation, invents nothing).**
- **P0-A · Leadership audit-trail read (CC-2).** New `GET /audit` (or `/oversight/audit`) behind the already-seeded `audit.read`, keyset-paged over `audit_log`, read-only. *Reuse:* audit schema, access guard, keyset pattern. *Gap:* a read use-case + a Flutter `features/audit` list. *Data:* none new. *Tests:* authz (owner/admin only; supervisor/teacher 403), paging, masking, 401. *Acceptance:* §15. *Risk:* low (reads existing data). *Decision:* only "who may read + whether any field is redacted". *Rollback:* remove the route (no data change).
- **P0-B · "Today's lessons" day-view (SCH-12 / SCH-13 plan half).** Add a date-window query to `operations` over `operations_lessons`; a command-center schedule widget / a scheduling "today" filter. *Reuse:* scheduling table + DST resolver + reporting registry. *Gap:* a bounded query + a widget/filter. *Tests:* day boundaries in the institution tz, empty day, authz. *Decision:* confirm a day-view is wanted (no new policy). *Rollback:* remove query/widget.
- **P0-C · Surface the neutral institution timezone (read-only).** Show `INSTITUTION_TIMEZONE` where scheduling is managed. *Reuse:* `AppConfig.institution.timezone`. *Risk:* must **not** surface quiet-hours (rejected). *Decision:* none.

**Phase 1 — one owner policy each (vertical slices; additive module + migration + Flutter + tests).**
- **P1-A · Derived attendance record + attendance report/widget + "التمام" (ATT-3/4/5, OCC-7, SCH-13 exec half).** *Prereq:* **Q70** (present/absent/late rule + calendar). *Reuse:* snapshots, operations→attendance contract, reporting registry. *Risk:* R1 (children). 
- **P1-B · Assignments (ASG-1) + its reminders.** *Prereq:* **GROUP D** workflow + ADR. *Reuse:* academic scope (Q31 done), files pipeline, reserved notif types.
- **P1-C · Vacant-halaqa + substitute suggestion (ABS-1/2/3).** *Prereq:* owner "vacant" definition + substitute workflow. *Depends on:* P1-A (absence signal) + automation.

**Phase 2 — external resources / infrastructure.**
- **P2-A · Real push + reminders + escalation (CC-4/5/6).** *Prereq:* **GROUP E** (owner provides FCM/Apple, preview + retention policy). *Reuse:* the whole built pipeline (one adapter line) + automation scheduler.
- **P2-B · Live audio enable (web) + native (COM-7/8).** *Prereq:* **GROUP F** (enable binding; devices/signing/load). *Reuse:* wired LiveKit web client.
- **P2-C · Automation retention/erasure job (AUT-3) + rules engine (AUT-2).** *Prereq:* **Q3/Q71**.

**Phase 3 — large institutional policy (deferred).**
- **P3 · Educational core** (progress/assessment/mastery/progression/certificates, ACA-7) — **GROUP C, owner-deferred**; «نظام الضخ» excluded.

---

## 15. Acceptance Criteria (per phase)

- **P0-A (audit read):** an `audit.read` holder lists audit entries newest-first, keyset-paged, read-only; a supervisor/teacher gets 403; anonymous 401; no entry is mutable; response excludes any owner-designated redacted field; a boundary test proves the read surface touches only `audit_log`.
- **P0-B (today's lessons):** a holder of `operations.schedule_manage` sees exactly the lessons whose local date is "today" in the institution timezone (DST-correct at day edges), empty-day shown as empty, server-authorized; no write path added.
- **P0-C (timezone surface):** the configured IANA zone is shown read-only wherever lessons are managed; no quiet-hours data is read or shown.
- **P1-A (derived attendance):** given the owner's Q70 rule, a snapshot (or set) yields a present/absent/late record by that exact rule and calendar, recorded immutably, authorized as attendance view/record is today; a reporting widget shows only owner-defined figures; no threshold is invented; old snapshots unchanged.
- **P1-B (assignments):** the owner-defined roles set/submit/grade an assignment through the defined states, scoped by the Q31 per-halaqa teacher rule, with files via the existing pipeline and the reserved notification types activated; per-operation server authorization.
- **P1-C (vacant/substitute):** "vacant halaqa" is detected by the owner's definition; a substitute suggestion is produced by an owner-approved automation rule (never an automatic assignment) and surfaced for a human decision.
- **P2-A (push/reminders):** with owner-provided credentials, a real push is delivered to a registered device honoring content-free/preview policy and quiet-hours/mute; a reminder/escalation fires on the owner-defined schedule via an automation rule.
- **P2-B (live audio):** with the binding enabled and a LiveKit server, web participants exchange real audio/screen; the control plane is unchanged; native is a separate slice.
- **General (all):** boundary-clean (contracts only), arch-index regenerated, idempotent writes where applicable, full test suite green, no change to Section→Program→Halaqa, no Level.

---

## 16. Explicit Non-Changes

This audit changed nothing except creating this one report file:

- **No code, test, or existing-doc modification.** Only `docs/owner-features-current-state-gap-analysis.md` (this file) was created; no existing `.md`, `.ts`, or `.dart` file was edited.
- **No migrations, no schema change, no database touched.** No migration was run; no DB was read or written beyond read-only source inspection.
- **No commit, no push, no merge, no deploy, no release build.** HEAD remains `c908916`; 0 staged; the 118 uncommitted working-tree entries are **preserved untouched**.
- **No Production, Staging, or Trial change.** No container, image, config, or deployment was altered.
- **No destructive Git** (`reset`/`clean`/`stash`/`checkout --`/`add -A`) was used.
- **No integration assumed** without evidence (Telegram/Zoom confirmed absent from source).
- **No test result fabricated** — pass/fail is explicitly *not* claimed (U-1); only what tests assert is reported.
- **Unverifiable items are recorded as UNRESOLVED** (§7), not guessed.

**End of audit. No implementation is authorized by this document; awaiting owner approval of scope and the Phase-0/Phase-1 plan before any build.**
