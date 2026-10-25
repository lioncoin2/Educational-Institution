# Owner Decision Register

**Purpose.** A consolidated, owner-facing synthesis of every unresolved decision that materially
blocks or changes implementation, architecture, security, institutional policy, or product behaviour —
so related decisions can be resolved together in one pass rather than one-per-sprint.

**This document does not replace [`docs/architecture/open-questions.md`](architecture/open-questions.md)**,
which stays the source-of-truth question list (Q1–Q72, with "built instead / when answered" notes), nor
the ADRs (immutable). It groups the still-open questions, adds a recommendation and the smallest precise
owner question per group, maps each to the roadmap, and lists the engineering work that needs **no**
owner decision. Evidence is cited by file + Q/ADR; line numbers are omitted deliberately (they drift).

**Compiled:** 2026-10-11, from source; **reconciled 2026-10-13 (Sprint 31)** at HEAD `144ab15` (adds §17–§19
for Sprints 28–30 and ADR 0033/0034). Verified against `open-questions.md`, `decisions/README.md`, the module
contracts, and the project checkpoint; the consolidated status map is [`docs/project-roadmap.md`](project-roadmap.md).
A question is treated as *resolved* only when an ADR or an owner ruling records it — never because code happens
to run one provisional default.

---

## 1. Executive summary

The product's core is built and verified: Identity, Communities (membership, delegation, lifecycle,
invitation links), Community chat + moderation (delete/review), Messaging (incl. the `message.deleted`
realtime hint), Live sessions + policy-gated moderation (kick, presenters, no-hidden-listeners),
Attendance snapshots (record + view + the Flutter surface), the Academic read surfaces, and
Notifications (inbox/list/read/badge/preferences/device-registration). As of HEAD `144ab15` (Sprint 30):
backend `jest` **3807 passed**, Flutter **1405 passed** (Sprint 29), all static + architecture gates green;
CI run `38329854598` success (supersedes the earlier 3743/1238 figures). See §9 and
[`project-roadmap.md §4/§9`](project-roadmap.md).

**Almost everything that remains is gated by an owner policy decision, an external provider/resource, or
a capacity dependency — not by missing engineering.** The five backend modules `people`, `operations`,
`assignments`, `reporting`, `automation` are deliberately empty boundary seams (`@Module({})`, zero
routes) awaiting the decisions below.

**The single decision group that unlocks the most is GROUP A — the people-directory & membership-sourcing
policy (Q6 + Q22 + Q31 + Q50).** It is the common blocker for the `people` module, community
direct-add-member, re-adding a removed member, and announcing removals. One coherent safeguarding/privacy
ruling unblocks a whole vertical slice that is otherwise fully specified and ready to build.

**Two items on the previously-circulated "still open" list are in fact already resolved** and are removed
here: **Q36** (Tahajji/groups → ADR 0015, dynamic & owner-managed) and **Q67** (community/live/attendance
notification facts → ADR 0024). Also note this repository's **Q11 is "localization/text direction," not
"operations recurrence"** — a label error in an earlier report; operations is gated by Q70 (and Q68/Q69),
not Q11.

---

## 2. Project & roadmap context

| Phase | State (source-verified) |
| --- | --- |
| P0–P6, P7.1 LiveKit server, P8 harness, Academic reconciliation, P9 Attendance, P10 translators, P12 policy-gated live | **DONE** (checkpoint phase ledger; §25 status table) |
| P7b web media adapter | landed; **shipped binding intentionally `UnavailableLiveMediaClient`** (product decision — GROUP F) |
| P7b native media | **not started** — EXTERNAL_RESOURCE (devices + mobile CI/signing) |
| P8 off-box load ladder, EXPLAIN-at-scale | **deferred** — EXTERNAL_RESOURCE / capacity |
| P11 horizontal scale, outbox/T2 | **blocked on P8 evidence** |
| `people`/`operations`/`assignments`/`reporting`/`automation` | **boundary seams only**, no approved implementation phase |

---

## 3. Decision groups (the register)

Each group keeps the original Q/ADR IDs. Fields: **Status · Classification · Evidence · Today (current
behaviour) · Blocked (missing behaviour) · Affected · Reversibility · Recommendation · Owner question ·
Safe interim**.

### GROUP A — People directory & membership sourcing  ★ highest impact

**IDs: Q6, Q22, Q31, Q50** (with Q49 re-add, Q10 parent). All four cross-reference each other in
`open-questions.md` as "the people-lookup policy."

- **Status:** unresolved (each shipped a PROVISIONAL default; the policy itself is open).
- **Classification:** INSTITUTIONAL_POLICY + AUTHORIZATION_SECURITY (safeguarding/privacy for minors).
- **Evidence:** `open-questions.md` Q6 ("safeguarding decision… the app's direct add waits on a
  people-lookup policy — this question with Q22, Q31 and Q50"), Q22 (who may see conversation members —
  "a privacy decision, especially for minors"), Q31 ("privacy boundaries for children's records…
  narrowing them after data has been seen cannot be undone"), Q50 (communities↔academic link); the
  empty `people/contracts/index.ts` ("who is this person in the institution"); community
  `repositories.dart` has no `addMembers`/`createCommunity` by design.
- **Today:** people join communities **only through invitation links**; messaging recipients follow the
  provisional Messaging-V1 grants (staff start DMs/groups; students start nothing; anyone ACTIVE with
  `messaging.read` may be addressed); teachers read a halaqa roster **only through an ACTIVE academic
  assignment**; supervisors see no roster; nobody is discoverable by directory search.
- **Blocked:** the `people` module (profiles/guardians/role-occupancy, a people-lookup contract);
  community **direct add-member** (`POST /communities/:id/members` exists + is tested on the backend, no
  app surface); **re-adding a removed member** (only a direct add can; link re-join is refused by
  design); **announcing removals** (deferred until Q22+Q49); "a teacher reaches only *their own*
  students"; students↔students / parents messaging.
- **Affected:** backend `people`, `communities` (add-member route already exists), `messaging` recipient
  rules, `academic` relationship scoping; Flutter community member-add UI + a people-search UI;
  authorization (a people-lookup resource rule); privacy.
- **Reversibility:** **widening is easy; narrowing after exposure is not** (Q31's own warning). Treat as
  low-reversibility for privacy — start narrow.
- **Recommendation (engineering shape I can commit to; policy is the owner's):** implement discovery as a
  **server-authoritative people-lookup contract scoped by an explicit relationship** — a manager may add
  only accounts they already have a relationship to (their own community's invitees, or — if the owner
  allows — their own halaqa's roster via `ACADEMIC_RELATIONSHIPS`), never a global user search; minors
  are never enumerable to peers; the UI is never the boundary. This matches the existing invitation-only,
  relationship-scoped posture and needs no new global-search index.
- **Owner question (smallest):** *When a community owner/manager adds a member directly (not by link),
  which people may they find — (a) nobody (links only; keep today's behaviour), (b) only accounts already
  in a community they manage, (c) also their own halaqa's students/teachers via the academic
  relationship, or (d) a broader directory? And separately: may a removed member be re-added, and may
  students message each other / a teacher of choice / parents?*
- **Safe interim:** keep invitation-links-only; no directory search; removed members re-join only via a
  fresh link issued to them; no removal announcements. (This is the current, safe state.)

### GROUP B — Community definition & lifecycle

**IDs: Q41 (define/create), Q47 (archive/delete), Q48 (invitation terms).**

- **Status:** app-side community creation **RESOLVED — YES, shipped** (Sprint 42, `b45b272`; see §23). The
  institutional definition (Q41), the archive/delete policy (Q47) and the invitation-term ratification (Q48)
  remain open; the other PROVISIONAL defaults still stand.
- **Classification:** PRODUCT_POLICY + INSTITUTIONAL_POLICY.
- **Evidence:** Q41 ("No institutional source mentions communities… creating spaces of up to 30,000,
  many minors, is a safeguarding decision"; provisional: `communities.create` = OWNER/ADMIN, creator
  becomes owner, no `kind`); Q47 (no ARCHIVED, LOCKED only; never deleted, FKs RESTRICT; a P6 ruling:
  a missing community fails closed); Q48 (link lifetimes 7d/30d, immediate join, no preview/approval).
- **Today:** communities exist, are created by OWNER/ADMIN (backend `POST /communities`, tested), locked
  /unlocked, never archived or deleted; the app has **no create screen** (membership+management only).
- **Blocked:** an ARCHIVED state; any delete/retention path. *(The app-side create-community flow is no
  longer blocked — shipped Sprint 42, `b45b272`; see the Status line and §23.)*
- **Affected:** backend `communities` (create route exists), Flutter (a create screen if wanted);
  a `COMMUNITY_STATUSES` vocabulary + CHECK migration for ARCHIVED.
- **Reversibility:** adding ARCHIVED later is additive (a vocabulary value + CHECK migration + one
  effects row); adding an app create screen is additive. High reversibility.
- **Recommendation:** keep "never deleted" (retention-safe; Q3). Defer ARCHIVED unless the owner needs it.
  An app create screen for OWNER/ADMIN is a reasonable additive product choice, but only if the owner
  wants communities created from the app rather than provisioned administratively.
- **Owner question:** *Should OWNER/ADMIN be able to create a community from the app? Do you need an
  "archived/retired" community state distinct from "locked"? Ratify link defaults (7-day default /
  30-day max, immediate join, no preview) or change them?*
- **Safe interim:** app-side create is now shipped (Sprint 42; §23); the rest keep their provisional defaults
  (no archive, links as configured).

> **Decision-ready brief (Sprint 33):** GROUP C, D, G, the GROUP A/Q6 residue and Q28 are consolidated
> for the owner in [`owner-decision-brief-product-loop.md`](owner-decision-brief-product-loop.md) —
> current behaviour, the decision in plain language, a recommended default (labelled pending approval),
> alternatives, implications, prerequisites, reversibility, and a decision order. It marks nothing
> resolved; the group entries below stay the authoritative mapping.

### GROUP C — Academic progression, assessment, mastery, certificates  (must NOT be invented)

**IDs: Q37 (assessment/placement/mastery/«نظام الضخ»), Q9 (certificates), Q38 (development path).**

- **Status:** **DEFERRED by owner decision (Sprint 39)** — the owner chose to skip the educational core for
  now and resume it later; **no implementation is authorized at this time**. DEFERRED, **not cancelled**: the
  features and questions below are **preserved and remain unresolved/OPEN** so the work can resume without
  losing context. Still **nothing built** (by rule — the brief forbids inventing placement/promotion/
  completion rules). **«نظام الضخ» is excluded from scope — not a required feature** (owner, Sprint 38). See **§22**.
- **Classification:** INSTITUTIONAL_POLICY.
- **Evidence:** Q37 ("Each answer is a placement, promotion or completion rule, which the brief forbids
  inventing… a move today is two acts: end, then enroll… no assessment/placement/mastery/awaiting state
  exists"); Q9 ("A certificate is an institutional assertion… its issuance rule is the institution's to
  state"; certificates are **mock in both app modes**); the Flutter `UnrecordedProgressRepository`
  returns null by design.
- **Today:** academic **structure** (sections/programs/halaqat) is real and read-only in the app;
  progress/mastery screens show mock/null; certificates are mock; a "move" is end+enroll with no link.
- **Blocked:** any assessment record, placement/awaiting state, mastery recording, «نظام الضخ» move,
  certificate issuance/revocation, and the `progress` feature's real data.
- **Affected:** `academic` (new tables/migrations, additive), a possible `certificates` module, Flutter
  progress/certificates features; notifications (Q28 for move/certificate facts).
- **Reversibility:** each is an **additive** migration (new tables/columns; `0007`/`0008` untouched) —
  but the *vocabulary* (what a move is called, what mastery records) is a permanent institutional
  assertion about real children, so getting the labels wrong is costly.
- **Recommendation:** **Do not implement until the institution states the rules.** I will not propose a
  default (forbidden). I can present the *shape* each answer takes (a status-vocabulary widening, a moves
  table, an assessment table with only owner-defined columns) once the owner defines the concepts.
- **Owner question:** *Does the institution want assessment, placement, mastery, and «نظام الضخ» moves
  recorded — and if so, who performs/decides each, what does an assessment record, and what is each kind
  of move called? Are certificates issued automatically on completion or awarded by a named person, on
  what evidence, and can they be revoked?*
- **Safe interim:** record no progression semantics; keep progress/certificates as clearly-labelled
  prototype/mock screens; a move stays end+enroll.

### GROUP D — Assignments & submissions

**ID: (no Q; `assignments` module is a contracts-only seam with no ADR).**

- **Status:** MISSING — no approved phase, no policy, no ADR.
- **Classification:** PRODUCT_POLICY + INSTITUTIONAL_POLICY.
- **Evidence:** `assignments/contracts/index.ts` (types `SubmissionState`, `AssignmentRef` only, no
  behaviour); notification types `ASSIGNMENT_CREATED/UPDATED` exist but `active: false`
  (`notifications/domain/catalog.ts`).
- **Today:** nothing; the module mounts no routes.
- **Blocked:** the entire assignments/submissions/grading workflow and its notifications.
- **Affected:** a new `assignments` implementation; `academic` (halaqa/teacher scoping via Q31);
  notifications; Flutter.
- **Reversibility:** greenfield; high.
- **Recommendation:** **Defer** — this needs a product definition (what an assignment is, who sets/grades,
  the submission lifecycle, visibility) before any build. Depends on GROUP A/Q31 for teacher scoping.
- **Owner question:** *Is an assignments/homework feature in scope, and if so what is its workflow
  (who sets, who submits, who grades, who sees what)?*
- **Safe interim:** leave the seam unimplemented.

### GROUP E — Notifications: delivery policy & push provider

**IDs: Q24 (push provider / lock-screen previews / quiet hours / mute), Q27 (notification retention),
Q28-remainder (per-role push defaults, collapsing). Push-provider selection also appears in Q65.**

- **Status:** Notifications V1 built except the provider; preview/quiet-hours/retention policy open;
  real sends are external-resource-blocked.
- **Classification:** EXTERNAL_PROVIDER (provider choice) + EXTERNAL_RESOURCE (Firebase/Apple/device) +
  PRODUCT_POLICY (previews, quiet hours, mute, retention).
- **Evidence:** Q24 ("a provider is an account and a data-processing agreement… lock-screen previews of
  children's messages are a safeguarding decision… none can be built or verified without a Firebase
  project, an Apple team and a device"); `notifications.module.ts` binds `LoggingPushProvider` ("the one
  line a real push provider changes"); Q27/Q3 retention open; Q28 "still open: per-role push defaults,
  collapsing."
- **Today:** full inbox/list/read/badge/preferences/device-registration on both tiers; `PushDelivery`
  behind the `PushProvider` port with retry/dead-token handling, but the only adapter **logs and sends
  nothing**; provisional lock-screen policy = content-free ("رسالة جديدة"), no quiet hours, no mute.
- **Blocked:** actual push sends; lock-screen previews; quiet hours; per-conversation mute; a notification
  retention horizon.
- **Affected:** `notifications/infrastructure` (one adapter + one module line), app `PushTokenSource` +
  platform project files; a `PushDelivery` filter for quiet-hours/mute; a retention job.
- **Reversibility:** the port/adapter seam makes provider choice reversible; a lock-screen preview policy
  is a body-key change (reversible); retention is a scheduled job.
- **Recommendation:** keep the **content-free** lock-screen default (safest for minors) unless the owner
  opts in to previews. Provider: FCM for Android + web, APNs for iOS is the conventional choice, **but it
  requires accounts/credentials the owner must provide** — this is not something engineering can decide
  unilaterally (data-processing agreement).
- **Owner question:** *Which push provider/accounts will you provide (Firebase project, Apple developer
  team)? May a push show sender/message text on a lock screen, or stay content-free? Do you want quiet
  hours (institution-wide or per-person) and per-conversation mute? How long are notifications retained?*
- **Safe interim:** in-app notifications only (already complete); `LoggingPushProvider` (no real sends);
  content-free previews; no quiet hours/mute.

### GROUP F — Live media binding & capacity

**IDs: Q65 (media hosting/ops — partly decided A–H; the binding-enable + TURN-verify + data-residency +
load-on-prod parts remain), Q57 (session size/concurrency), P7b native, P8 load, P11 scale.**

- **Status:** infra decisions A–H made (P7.1); shipped client binding **disabled**; capacity unproven.
- **Classification:** PRODUCT_POLICY (enable the binding) + EXTERNAL_RESOURCE (devices, load hardware,
  signing) + INFRASTRUCTURE_CAPACITY.
- **Evidence:** Q65 (self-hosted LiveKit decided; "two parts stay open: data residency, and whether a
  load test may touch the production host and who approves"); `live_media_seams.dart`
  `UnavailableLiveMediaClient` bound in `app_providers.dart`; `LiveKitLiveMediaClient` exists but
  unbound ("until platform activation"); §20/§21 capacity "measured: nothing."
- **Today:** live control-plane (start/end/kick/presenter/roster) works; **no live audio ships** (seam
  Unavailable); TURN configured-not-verified; no load evidence.
- **Blocked:** real live audio; native platforms; any capacity claim; P11.
- **Affected:** app media seam binding + platform project files (Android foreground service, iOS
  broadcast extension); infra verification; load harness runs.
- **Reversibility:** enabling the binding is one provider line (reversible); native platform work and
  load runs are not cheaply reversible once committed.
- **Recommendation:** **do not enable the shipped binding without explicit product authorization**
  (safeguarding + capacity unproven). Native + load need hardware/credentials engineering cannot
  self-provision.
- **Owner question:** *Do you authorize shipping live audio (enabling the LiveKit binding) — and on which
  platforms? Who approves a load test and on what hardware (never production keys/rooms)? Any
  data-residency constraint?*
- **Safe interim:** keep `UnavailableLiveMediaClient`; control-plane only; no capacity claims.

### GROUP G — Attendance→record, operations, automation, reporting

**IDs: Q70 (snapshot as attendance record), Q71 (correct/retain/erase snapshots), Q72 (timing), Q68
(present-labelling); operations scheduling; `automation`; `reporting`.**

- **Status:** snapshots built (immutable, observation-only, provisional bounds); the *record derivation*,
  retention/erasure, and the operations/automation/reporting modules are open.
- **Classification:** INSTITUTIONAL_POLICY (present/absent/late thresholds forbidden to invent) +
  DEPENDENCY_BLOCKED (operations depends on Q70; reporting depends on other modules' widget providers;
  automation on Q71/Q3).
- **Evidence:** Q70 ("turning 'connected at T' into present/absent/late is the threshold policy the brief
  forbids… observation only… nothing fills `Halaqa.attendedSessions`"); Q71 (retention = Q3; "no erasure
  path"); Q72 (on-press only, provisional bounds); Q68 (nothing labelled present — the safe default);
  `operations/contracts` ("on hold with academic attendance… Q70"); `reporting/contracts` (a
  `WidgetProvider` registry with **nothing registered**); `automation/contracts` (rules on events —
  future home for the Q71 retention job).
- **Today:** snapshots are observation-only; operations/automation/reporting mount no routes.
- **Blocked:** an operations `AttendanceRecord` derived from snapshots; snapshot retention/erasure jobs;
  automation rules; the Owner Command Center (reporting).
- **Affected:** `operations` (reads `attendance/contracts`), `automation`, `reporting`, `academic`.
- **Reversibility:** derivations are additive; but a present/absent labelling is an institutional
  assertion about children — low reversibility once recorded.
- **Recommendation:** keep snapshots **observation-only** (safe; Q68/Q70 defaults). Reporting's
  infrastructure (the registry) could be built once ≥1 module has an approved widget to register —
  until then it is genuinely dependency-blocked. Automation's retention job waits on Q3/Q71.
- **Owner question:** *Should a snapshot feed a derived attendance record (present/absent/late), and if so
  by what rule and calendar? What is the retention/erasure policy for snapshots and other data (Q3)?*
- **Safe interim:** snapshots stay observation-only; no derived record; retention = kept like the audit
  log until Q3.

---

## 4. Classification summary

| Group | PRODUCT | INSTITUTIONAL | AUTHZ/SECURITY | ARCHITECTURE | EXTERNAL_PROVIDER | EXTERNAL_RESOURCE | INFRA/CAPACITY | DEPENDENCY |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| A people-lookup | | ● | ● | | | | | |
| B community lifecycle | ● | ● | | | | | | |
| C academic/certs | | ● | | | | | | |
| D assignments | ● | ● | | | | | | |
| E notifications/push | ● | | ● | | ● | ● | | |
| F live media/capacity | ● | | | | ● | ● | ● | ● (P11→P8) |
| G attendance-record/ops/reporting | | ● | | ● | | | | ● |

---

## 5. Decision dependency graph

```
GROUP A (Q6+Q22+Q31+Q50) ──unlocks──► people module, community direct-add,
   │                                   remove+re-add, removal announcements,
   │                                   teacher-scoped directory
   └─ Q50 needed before any academic↔community membership sourcing

GROUP C (Q37 assessment/mastery) ──needed before──► Q9 certificates,
   │                                                  progress feature,
   └─ Q31 (teacher scope, in A) ──needed before──► D assignments grading scope

GROUP E push:  owner provider/credentials ──unlock──► real push sends
               Q3 retention ──unlock──► notification + snapshot retention jobs

GROUP F:  product "enable binding" ──unlock──► live audio (web)
          P8 load evidence ──unlock──► P11 scale, capacity claims, EXPLAIN-at-scale
          devices/signing ──unlock──► P7b native

GROUP G:  Q70 ──unlock──► operations AttendanceRecord
          Q71+Q3 ──unlock──► automation retention job
          (any module's approved widget) ──unlock──► reporting Owner Command Center
```

**First-movers (no prerequisite among owner decisions):** A, B, C, E-policy, F-product, Q3.
**Downstream (need a prerequisite):** D (needs Q31∈A + a product definition), G-operations (needs Q70),
reporting (needs ≥1 widget-owning module), P11 (needs P8).

---

## 6. Ranked decision groups (smallest set, greatest unlock)

1. **GROUP A — people-lookup (Q6+Q22+Q31+Q50).** One safeguarding/privacy ruling unblocks a fully-
   specified, backend-ready vertical slice (community direct-add + re-add + people module). Highest
   user-visible impact per decision; low architectural risk; **narrowing is irreversible, so decide
   deliberately.**
2. **GROUP F — enable live audio (product) + authorize a load run.** Highest *product* impact (voice is a
   headline feature) but gated by external resources for native/capacity; the web-binding enable is a
   single product decision.
3. **GROUP E — push provider + preview/retention policy.** Completes notifications end-to-end; needs owner
   credentials (external) + a safeguarding preview choice.
4. **GROUP C — academic progression & certificates.** Large surface, but strictly institutional; cannot
   start without the owner's rules. Blocks the progress/certificates features.
5. **GROUP B — community lifecycle.** Mostly ratification of safe defaults; low urgency.
6. **GROUP G — attendance record / operations / reporting / automation.** Policy + dependency gated;
   lower near-term user impact; keep observation-only.
7. **GROUP D — assignments.** Greenfield; needs a product definition first.

---

## 7. Minimum owner input (exact questions, by group)

- **A:** which people may a manager add directly (nobody / own-community / own-halaqa / broader); may a
  removed member be re-added; may students DM each other or a chosen teacher; may parents message.
- **B:** app-side community creation yes/no; need an ARCHIVED state; ratify or change link defaults.
- **C:** define (or decline) assessment/placement/mastery/«نظام الضخ» recording and the certificate
  issuance rule — the institution's wording.
- **D:** is an assignments feature in scope, and its workflow.
- **E:** push provider + credentials; lock-screen preview content-free vs text; quiet hours/mute;
  retention horizon (Q3).
- **F:** authorize shipping live audio + platforms; who approves a load test + on what hardware;
  data-residency.
- **G:** does a snapshot feed a present/absent record and by what rule; snapshot/data retention (Q3).

---

## 8. Implementation packages unlocked (per group, after approval)

- **A →** backend: a `people` lookup contract + a scoped resource rule; wire the existing community
  `POST /members` behind it; a re-add/leave rule tweak. Flutter: a member-add + people-search UI (new
  provider/controller/repository methods), gated by server authority. Migrations: role-matrix grants.
  Tests: authz allowed/forbidden (incl. minor-exposure), add idempotency/pagination, UI states. ADR +
  close Q6/Q22/Q31/Q50. Vertical slice; no God files — people-search lives in a `people` feature, not
  bolted onto communities.
- **B →** backend: optional `communities.create` already exists → add a create screen (Flutter) and/or an
  ARCHIVED vocabulary value + CHECK migration + one effects-table row. Tests: create authz, lifecycle.
- **C →** backend: additive `academic` migrations (status-vocabulary widening / moves table / assessment
  table with owner-defined columns) or a `certificates` module; events + Q28 notification decision.
  Flutter: progress/certificates become real. Strictly after the owner states the rules.
- **D →** a new `assignments` implementation (domain/application/api/infra) + Flutter + notifications;
  scoped by Q31.
- **E →** backend: one `PushProvider` adapter + one module line + config; `PushDelivery` quiet-hours/mute
  filter; a retention job. Flutter: `PushTokenSource` + platform files. Requires owner credentials +
  a device to verify (external).
- **F →** app: bind `LiveKitLiveMediaClient`; Android foreground service + iOS broadcast extension (native,
  external); infra TURN verification; P8 load runs (hardware). Capacity claims only with evidence.
- **G →** backend: an `operations` derivation reading `attendance/contracts` (one-way dependency); an
  `automation` retention rule; a `reporting` widget once a module registers one.

Each package is a coherent vertical slice; none duplicates business logic or crosses a module boundary
the ADRs forbid (operations depends on attendance, never the reverse; reporting is a registry, not a
screen; moderation authority stays server-side).

---

## 9. Engineering work that needs NO owner decision

Resolve these through normal engineering judgement (not owner escalation):

- **DONE this conversation:** architecture-index regeneration (ADR 0031 — fixed a stale-index regression);
  the `message.deleted` realtime hint; the live moderation roster; community message-moderation Flutter.
- **Available, low-risk, if/when prioritised (ENGINEERING_CHOICE / DOCUMENTATION_GAP):**
  - The **ADR 0023 Option-B write-up** — a new ADR recording the already-shipped Q69a composition
    (documentation traceability; the decision exists). Author it from ADR 0023 + the checkpoint; do not
    restate it as a new decision. *(Deliberately not done here to avoid misstating a shipped authorization
    composition without the owner's framing; flagged, not blocking.)*
  - The cosmetic `academic.*` permission-description wording ("levels") in
    `drizzle/0002_seed_access_catalog.sql` — fix via a **new** migration/description update, never by
    editing an applied migration. Trivial, non-blocking.
  - A `messaging` feature boundary test would be a reasonable additive guard now that messaging has an
    intended `→communities` edge — only if a real recurring violation justifies it (none observed).
- **Explicitly NOT unblocked work:** building any of `people/operations/assignments/reporting/automation`
  behaviour (all gated above); progress/certificates real data (GROUP C); push sends (GROUP E, external).

---

## 10. External-resource blockers (NOT owner policy)

- **Push delivery:** a Firebase project + an Apple developer team + a physical device (Q24/Q65).
- **P7b native media:** physical devices + a mobile CI/signing pipeline (none exists).
- **P8 load / capacity claims / EXPLAIN-at-scale:** replica hardware matching the target, a large seeded
  dataset, and (Q65) authorization for who may run it and where (never production keys/rooms).
- **P11 horizontal scale, outbox/T2:** gated on P8 evidence (dependency, not policy).

---

## 11. Decision → roadmap milestone mapping

| Decision group / ID | Blocks milestone / feature |
| --- | --- |
| A (Q6/Q22/Q31/Q50) | `people` module; community direct-add + re-add; removal announcements; teacher-scoped directory |
| B (Q41/Q47/Q48) | app community-create; ARCHIVED lifecycle |
| C (Q37/Q9/Q38) | academic progression/assessment/mastery; certificates; `progress` feature |
| D (assignments) | `assignments` module + feature |
| E (Q24/Q27/Q28/Q65-push) | real push delivery; quiet-hours/mute; notification retention |
| F (Q65-binding/Q57/P7b/P8/P11) | live audio (web + native); capacity; horizontal scale |
| G (Q70/Q71/Q72/Q68; ops/automation/reporting) | operations AttendanceRecord; snapshot retention; Owner Command Center; automation |
| **Resolved (no longer blocking):** Q36 (ADR 0015), Q67 (ADR 0024), Q69/Q8/Q12/Q35/Q40/Q28-part/Q51-moderation/Q56/Q64/Q59/Q23-community | — |

---

## 12. GROUP A — owner decisions received & reconciled (2026-10-11)

The owner gave four initial GROUP A decisions. Reconciled against source (ADRs, `open-questions.md`,
the identity role matrix, the community membership model) and implemented where unblocked. No ADR was
edited; no new permission or role-matrix grant was created.

| ID | Owner decision | Authoritative reconciliation (evidence) | Status |
| --- | --- | --- | --- |
| **A1** people discovery is relationship/scope-limited, not global | A1 says the exact scope "must follow established … authorization rules." The established permission is **`people.read`** (`identity/contracts/permissions.ts`), held by teacher/supervisor/admin/owner, not students. Scope resolved from it (owner delegated that resolution in A4). | **RECONCILED → IMPLEMENTED** |
| **A2** only the owner or an authorized admin may re-add a removed member | The existing `POST /communities/:id/members` is gated on **`community.members.invite`** (`AddMembersUseCase`), which the owner holds implicitly and may delegate — exactly "owner or authorized administrator." Re-adding a removed member is already tested (`membership.spec.ts` "lets a manager re-add someone they removed"). **No new permission.** | **RECONCILED → IMPLEMENTED (Flutter wired)** |
| **A3** direct messaging between any two students is allowed | A3 concerns DM **permission**, not discovery — so it does **not** conflict with Q22/Q31/Q50 (which govern visibility). It **reverses the provisional Q6 default** ("students start nothing") — a safeguarding default the owner may set (Q6 is an open question, **not** an immutable ADR, so no ADR conflict). BUT: students lack `messaging.startDirect` in the provisional role matrix (`provisional-policy.ts`), so enabling it is an **identity role-matrix change**; AND students lack `people.read`, so they have **no entry point** to find another student to message. The feature cannot be delivered or verified end-to-end for students without a separate student-facing entry-point decision. | **RESOLVED → IMPLEMENTED (2026-10-11)** — see §13 |
| **A4** teachers may search across the institution, subject to existing permissions, minimal fields | Teachers hold `people.read`; A4 explicitly delegates "resolve the effective scope from existing authorization rules." Implemented as a `people.read`-gated, institution-scoped, **minimal `{userId, displayName}`** search — never an email/role/status. | **RECONCILED → IMPLEMENTED** |

**Conflict found (A3) — RESOLVED by the owner (2026-10-11).** The two decisions this register flagged
were both answered by the owner's follow-up GROUP A sprint and are now implemented (§13):
(1) **the DM capability** — a student may start a direct conversation with another student; applied by a
narrow new permission `messaging.start_direct_peer` (not a broad `messaging.start_direct`, which would
have resolved the still-open student↔staff question by a side effect); and (2) **the entry point** — the
owner's preferred community-roster entry point conflicts with `community.members.view` (a delegable
capability a student does not hold) and Q22 (do not publish the roll of children to peers), so it is
**not** used for students; instead discovery is the **community/group chat**, where a student already
sees a co-member's name and id legitimately — no directory, no new visibility. The still-open
student↔staff and parent questions in Q6 stay open and untouched.

**Implemented this sprint (A1/A2/A4) — a server-authoritative, privacy-safe people-discovery → add-member
vertical slice:**
- **Backend (`people` module, first behaviour):** `GET /people?q=&cursor=&limit=` → `SearchPeopleUseCase`,
  gated at the edge by `@RequirePermission(Permissions.people.read)` and **re-checked in the use case**;
  reads a new narrow identity contract `ACCOUNT_SEARCH` (`UserRepository.searchActiveByDisplayName`,
  ACTIVE-only, LIKE-escaped prefix, keyset-paged, both Drizzle + in-memory). Minimal projection
  `{userId, displayName}` — the admin view's email/identifiers are never reused. Additive: no permission,
  no role-matrix, no migration. Security tests pin: 401 unauth, 403 for a non-`people.read` role, 200 for
  a teacher with only `{userId, displayName}`, no email on the wire, ACTIVE-only, pagination, clamp,
  query validation (`backend/test/api/people.api.spec.ts`), plus a use-case spec (refuses before any
  read). The controller is registered in `authorization.spec` (the route-declaration guard).
- **Flutter:** `PeopleRepository.search` (HTTP + demo mock) + `PersonSearchResult`/`PeopleSearchPage`;
  `peopleSearchProvider`; `CommunityRepository.addMembers` (HTTP + mock, the existing `POST /members`);
  `CommunityMembersController.addMembers` (reconciles roster + count); an **"Add member" action on the
  members screen shown only when `me.has(community.members.invite)`**, opening a search picker that adds
  (or re-adds) a found person. The server re-authorises every search and every add — the UI is not the
  boundary. The community boundary guard was updated from "adds nobody by id" (the lifted deferral) to
  "adds by id through one server-gated route carrying only account ids; joining stays by link."

---

## 13. GROUP A — A3 student-to-student direct messaging, resolved & implemented (2026-10-11)

The owner's follow-up ruling authorised **direct messaging between any two students** as a product
capability, and designated a shared-context entry point ("a student visible in a roster the current user
is authorised to access") to avoid a global student directory. Reconciled against source and implemented
end-to-end; the still-open Q6 questions (student↔staff, parents, quiet hours) stay open.

**Policy evidence.** Q6 ("may students message each other?" — provisional default: students start
nothing) is an **open question, not an ADR**, so the owner may set it; its own "When answered" note says
the mechanism is *"grants in the provisional matrix (a migration)"*. The DM machinery already existed:
`StartDirectConversationUseCase` is idempotent and race-safe (one canonical DIRECT per pair, decided by
the database). The only gap was authorisation.

**Why a new permission (not a raw `start_direct` grant).** Granting students the existing broad
`messaging.start_direct` would let them address any `messaging.read` holder — including teachers and
admins — silently resolving the *still-open* student↔staff question (Q6). Code checks permissions, never
roles (`identity/domain/role.ts`), so the smallest faithful mechanism is a **narrow new permission
`messaging.start_direct_peer`**, granted to STUDENT (owner/admin hold it via their all-permissions
status). The DM use case routes by permission: a holder of `start_direct` starts broadly (staff, any
addressable account — unchanged); a peer starter reaches only a **peer** — an ACTIVE account that holds
`start_direct_peer` and is **not** a broad starter — which is exactly another student. An unknown id and
a non-peer are refused alike (`messaging.participant_not_eligible`), so a student cannot probe for who is
staff. Migration `drizzle/0018_seed_messaging_peer_dm.sql` seeds the permission and the OWNER/ADMIN/
STUDENT grants (the matrix↔seed drift test enforces agreement).

**Why the chat, not the roster, is the student's entry point.** The owner preferred a roster entry point,
but listing a community roster requires the delegable capability `community.members.view` (owner/delegate/
oversight — `ListMembersUseCase`), which a plain student does **not** hold; using it would mean widening
roster visibility to peers, which Q22 explicitly warns against for minors. Per the sprint's own rule
("if the preferred entry point conflicts with policy, use an already-approved alternative"), discovery is
the **community/group chat**, where a student already sees a co-member's name and id through
`community.chat.read` — no directory, no new visibility.

**Backend.** Edge of `POST /messaging/conversations/direct` changed from `@RequirePermission(start_direct)`
to `@Authenticated()` (two permissions open it; the use case decides and still refuses a caller holding
neither with 403). `ConversationFactory.eligiblePeer` + `canStartBroadly` added. Security tests:
`create-conversation.spec.ts` (student→student succeeds and is canonical from either side; student→
teacher/supervisor/admin/owner and an unknown id all refused as `participant_not_eligible`; an assistant
is refused outright with `permission_denied`); `messaging.api.spec.ts` HTTP (student→student 201 then
idempotent 200; student→teacher 422; staff→student 201; unauthenticated 401).

**Flutter.** `MessagingRepository.startDirect(userId)` (HTTP `POST /messaging/conversations/direct`; demo
mock mirroring the peer semantics — a student viewer reaches the demo's student ids, refusing staff and
unknown alike, canonical per pair). A `DirectMessageStarter` (sealed `OpenConversation`/`CannotStartDm`,
mirroring `CommunityChatOpener`). In the chat timeline, a co-member's name is tappable **only when the
viewer's account may start a DM** (`messaging.start_direct_peer` or `start_direct`) and opens a "message
{name}" sheet → start → navigate, refreshing the conversation list; the server re-authorises every start,
so a refusal (e.g. a student tapping a teacher) is said in words and nothing opens. Tests in
`app/test/messaging/direct_message_test.dart` cover the repo contract, the mock semantics, the starter,
and the chat entry point (success, refusal, and no-affordance-without-permission).

**PostgreSQL verification (2026-10-11, second pass).** The drift and migration suites — previously
skipped locally without a database — were run against an **isolated ephemeral `postgres:16` container**
(throwaway; a scratch DB per suite; never production): `identity-persistence` confirms the seeded
`permissions`/`role_permissions` equal the code catalogue + matrix *including* `messaging.start_direct_peer`
(OWNER/ADMIN/STUDENT); `migration-upgrade` confirms the journal/snapshot chain through `0018` applies on
upgrade; `messaging-persistence` confirms the one-DIRECT-per-pair canonical invariant under concurrent
creation (DB constraint `conversations_direct_pair_unique`). A pre-existing committed test in
`messaging-persistence.spec.ts` (a tombstone UPDATE that set `deleted_at` without `deleted_by`, violating
the `messages_deleted_by_consistent` CHECK from migration `0017`) was repaired to set both, as every real
delete path does — unrelated to A3, and the only change this file needed.

**Still owner-blocked after A3.** Parent messaging and quiet hours (Q6). (Student↔teacher is now
resolved — see §14.)

---

## 14. GROUP A — Q6 student-to-teacher direct messaging, resolved & implemented (2026-10-11)

The owner expanded the Q6 ruling: **a student may initiate a direct conversation with any eligible teacher
in the same institution** — not with an administrator, a parent, an inactive account, or (were there one)
a teacher of another institution. Student↔student (§13) is unchanged. The parent-messaging and
quiet-hours parts of Q6 stay open.

**"Same institution" needs no check — the system is single-institution.** Verified against source: the
`users` table has no institution/tenant column, and "institution" everywhere means the one deployment
(a single `institution-structure.json`; "accounts in an institution are created by admins"; `people` =
"who is this person in *the* institution"). There is no multi-institution model and no `institutionId`,
so "same institution" holds for every account pair and there is no cross-institution path to reject. No
speculative institution field was added (Workstream B rule).

**Permission design (least privilege, by permission never role).** A broad `messaging.start_direct` grant
would let a student address any account, so students get a second narrow permission,
**`messaging.start_direct_teacher`** (migration `0019_seed_messaging_teacher_dm.sql`, granted to STUDENT;
OWNER/ADMIN by their all-permissions status). An "eligible teacher" is defined once, in the shared
`ELIGIBLE_TEACHER` constant (identity `contracts/account-search.ts`), used by both the DM eligibility
check and the teacher directory so they cannot drift: **holds `academic.teach`** (the catalogue's "is a
teacher's account" marker — teachers and assistant teachers) **and does NOT hold `users.manage`** (which
only the owner and admins hold). So a student reaches teachers and assistant teachers, never an
administrator, a supervisor (no `academic.teach`), a student, or the owner. The DM use case routes by the
grants the caller holds (`start_direct` → broad; `start_direct_peer` → a peer; `start_direct_teacher` →
an eligible teacher), reusing the existing idempotent, race-safe `StartDirectConversationUseCase`.

**Teacher discovery without a general directory.** Students lack `people.read`, so a new route
`GET /people/teachers` (`SearchTeachersUseCase`, gated on `messaging.start_direct_teacher`, re-checked in
the use case) returns ONLY eligible teachers (identity's `searchActiveTeachersByDisplayName`, a correlated
`EXISTS`/`NOT EXISTS` over the role matrix), same minimal `{userId, displayName}` projection. It is a
teacher directory, never a general people search — a student cannot enumerate students, admins or the
owner. The A3 chat entry point also now works for a teacher who posts in a shared chat (no new code — the
authorisation simply allows it).

**Flutter.** `PeopleRepository.searchTeachers` (HTTP `GET /people/teachers` + demo mock returning only the
teacher); `teacherSearchProvider`; a "message a teacher" action on the conversations screen (shown only
when the viewer holds `start_direct_teacher`) opening a picker that starts/reuses the DM via the existing
`DirectMessageStarter` and navigates. Tapping a teacher's name in a shared chat works too.

**Verification.** Backend `jest` (non-PG) **3777 passed / 0 / 371 skipped**; **real PostgreSQL** (ephemeral
`postgres:16`): `identity-persistence` drift now covers `messaging.start_direct_teacher` and a focused
`searchActiveTeachersByDisplayName` test (returns teacher + assistant, excludes student, admin, inactive);
`migration-upgrade` applies the chain through `0019`; `messaging-persistence` still green. Security tests:
student→student and student→eligible-teacher succeed; student→supervisor/admin/owner/unknown/inactive-
teacher refused as `participant_not_eligible`; an assistant (no start grant) refused `permission_denied`;
third parties cannot read a student↔teacher DM; `/people/teachers` is 401/403/teacher-only/minimal-fields.
Flutter `flutter test` **1263 passed**. arch:graph **432 modules, no violations**; arch:index regenerated.

**Integration assurance (2026-10-11, follow-up).** The teacher directory was previously proven at the
repository/SQL layer and the controller against the in-memory twin; now it is proven **through the real
HTTP boundary against real PostgreSQL**. `test/integration/people-http-postgres.spec.ts` boots the actual
application with `DATABASE_URL` set (so identity composes its Drizzle adapters) against a scratch DB and,
over HTTP, confirms `GET /people/teachers` returns only ACTIVE eligible teachers (teacher + assistant;
never student, admin, owner or inactive), the `{userId, displayName}` projection, 401/403, query
validation and keyset pagination over SQL, and that `GET /people` keeps its `people.read` restriction.
Database-unavailability is covered by `people.api.spec` (the controller's `DatabaseUnavailableInterceptor`
answers **503 `unavailable`** when the store rejects with a connection error, a non-outage stays 500, and
the route recovers), and Flutter maps that 503 to a recoverable "briefly unavailable" message — never an
empty "no teachers" list — and never navigates on failure. The DM authorization and participant-isolation
guarantees (§13/§14) were re-run green, including `messaging-persistence` canonical concurrency on
PostgreSQL.

These four suites are **enforced automatically by CI**: the GitHub Actions `backend` job runs a
`postgres:16-alpine` service and `npm run verify` with `TEST_DATABASE_URL` set, so they run against real
Postgres on every push/PR rather than skipping (each still uses its own scratch database). A silent-skip
guard was added — `describeWithPostgres` fails rather than skips when `TEST_DATABASE_URL` is missing while
`POSTGRES_REQUIRED=1` (which CI sets) — so the gate can never pass green on zero integration coverage; the
local `jest` workflow is unchanged. This is engineering hardening (register §9), not an owner decision.

The **architecture index** (ADR 0031) is likewise enforced in CI, but through jest rather than a `verify`
script step: `npm test` runs `test/architecture/architecture-index.spec.ts`, which regenerates the index
from source and asserts the committed bytes match (with negative controls), so an index drift fails the
`backend` job. Verified by a controlled stale-index rejection (both the `arch:index:check` script and the
jest case fail on drift, exit 1; the committed file restored byte-for-byte). Adding `arch:index:check` to
`verify` would duplicate that check, so it was not added. Also engineering hardening, not an owner decision.

**CI red-suite remediation (2026-10-11).** CI was failing on five suites; each was reproduced locally and
found to be a **stale test after an intentional, ADR-/migration-backed schema change**, never a schema or
application defect, so every fix was **test-only** (no production, migration, or policy change): the
communities capability test (migration `0017` made `community.messages.moderate` a valid capability); the
live presenter index/uniqueness/state-version and race tests and the real-LiveKit presenter tests (**ADR
0028** + migration `0016`: two presenters per session, one open per user, `stop` self vs
`revoke(targetUserId)` by a moderator, `openWithinCap`); and the messaging tombstone test (the `0017`
deleted-by CHECK). All pass locally (PG suites 240; real LiveKit 65). This is engineering maintenance of
pinning specs after confirmed schema changes, not an owner decision; it is **local-only until pushed**.

**Still owner-blocked.** Parent messaging and quiet hours (Q6); the people directory beyond add-member and
the teacher directory (GROUP A remainder).

---

## 15. Q31/Q50 (search scope) — least-privilege people discovery, resolved & implemented (Sprint 24, Design X)

The owner ruled on the people-search scope sub-part of the people-lookup policy, and it was implemented as
one server-authoritative change. This resolves only the **search-scope** sub-part; the broader Q50
(enrollment-sourced membership, halaqa link, derived capabilities) and **Q22** (conversation-member
visibility) stay **OPEN**, and ADR 0023 (attendance authorization) is unchanged.

- **Institution-wide directory is owner/admin only.** `GET /people` (gated on `people.read`) is a
  membership-management surface for owner/admin. Supervisors and teachers **lose `people.read`
  (`provisional-policy.ts`; data-only migration `0020_restrict_people_directory`)** — no role gets an
  institution-wide directory merely by holding `people.read`. Students and parents gain nothing.
- **Community member discovery is community-scoped.** New `GET /communities/:id/member-candidates?q=`
  (`SearchMemberCandidatesUseCase`), authorized per community on **`community.members.invite`** (the one
  community authorizer, never `communities.manage` — oversight never adds). A teacher who owns or is
  delegated invitation authority in a community still finds candidates **there**; anyone without it,
  including an oversight-only admin, is refused exactly as the add mutation refuses. Search reuses
  identity's `ACCOUNT_SEARCH` (relationship-blind, ACTIVE-only) and the minimal **`{userId, displayName}`**
  projection.
- **Search is not a mutation.** Discovery grants no membership, messaging permission or attendance
  entitlement; `AddMembersUseCase` still re-authorizes `community.members.invite` on the add.
- **Academic discovery unchanged.** No cross-halaqa student search was built; teachers read their own
  halaqa roster via the existing ACTIVE-assignment path (Q31). No academic/enrollment data enters
  community discovery.
- **Flutter:** the add-member picker now calls the community-scoped endpoint with the open community's id
  (never `GET /people`).
- **Still open (unchanged):** Q50 membership-sourcing/halaqa-link/derived-capabilities; Q22; the
  people directory beyond add-member and the teacher directory; parent messaging and quiet hours (Q6).

The separation this implies (search ≠ membership ≠ attendance; owner/admin directory; community-scoped
candidate search; the add re-authorizes; academic relationships and attendance stay independent) is
formalized in [ADR 0032](architecture/decisions/0032-discovery-membership-attendance-separation.md).
Q50 and Q22 remain OPEN — that ADR resolves neither.

---

## 16. GROUP A / Q50 — discovery policy, consolidated & verified (Sprint 27)

The owner's selected discovery policies (P1–P6) are recorded here against where each is **enforced in
source** and **negative-tested** — a verification pass, not a new decision. Nothing here resolves a
broader open question.

| Policy | Where enforced (source) | Negative tests | Status |
| --- | --- | --- | --- |
| P1 — discovery contexts are distinct (community candidate vs academic halaqa); never one global directory | `SearchMemberCandidatesUseCase` (community) + `AcademicAccess.halaqaMembers` (academic); `GET /people` owner/admin only | `communities.api.spec`, `academic.api.spec`, `access.spec` | **Implemented+verified** |
| P2 — teacher academic discovery = **current** students of **ACTIVE-assigned** halaqat, via the existing roster (no separate/cross-halaqa endpoint built) | `AcademicAccess.halaqaMembers` → `academic.teach` AND `isTeaching(ACTIVE)`; `ListHalaqaStudentsUseCase` | `access.spec` (unassigned, cross-halaqa, **ended assignment**, demoted role); `academic.api.spec` (outsider/cross-halaqa → 403) | **Implemented+verified** |
| P3 — supervisor gets **no** academic scope by role | `AcademicAccess` (no `academic.teach`, no assignment → denied) | `access.spec` + `academic.api.spec` (supervisor → 403) | **Implemented+verified** |
| P4 — academic relationships scope academic discovery only; grant no community membership/permission/attendance/role | module boundaries; no academic import in `communities`/`people`; ADR 0032 | `academic-boundaries.spec`, `communities-boundaries.spec` | **Implemented+verified** |
| P5 — minor/identity exposure is minimal and relationship-scoped, enforced server-side | every search projects `{userId, displayName}` at the use case/response, not the client | `people.api.spec` (no email on the wire), `academic.api.spec` (`/me` hides classmates), `communities.api.spec` | **Implemented+verified** |
| P6 — Sprint 24 contract (owner/admin `GET /people`; per-community `community.members.invite`; add re-authorizes; discovery confers nothing; ADR 0023 attendance unchanged) | ADR 0032; `people.read` owner/admin (migration 0020); `AddMembersUseCase` recheck | `people.api.spec`, `communities.api.spec` (incl. the Sprint 27 **revoke → re-denied** lifecycle test) | **Implemented+verified** |

**Remains OPEN (not resolved by any of the above):** Q50's broad halaqa-link / enrollment-sourced
membership / derived-capability questions; Q22 conversation-member visibility; whether a teacher may ever
see **former** or pre-assignment students (Q31 sub-question — the roster's status filter still allows ENDED
enrollments, a deliberate shipped behavior left undecided); **parent** messaging and **non-teacher-staff**
communication; the people directory beyond add-member and the teacher directory.

---

## 17. Q50 halaqa link, Q22 member-list visibility, Q31 current-student roster — resolved & implemented (Sprint 28)

Three owner-approved decisions, implemented as the actual architecture safely supports. ADR 0033 records
the Q50 design; ADR 0023 (attendance) is unchanged; no role grant, `people.read`, messaging capability or
attendance rule was touched.

### Q50 — optional community↔halaqa association (APPROVED)

A community MAY be associated with one academic halaqa. The link is **inert metadata**: it creates/removes
no membership, grants/revokes no capability, and derives no messaging, attendance, academic or role
authority. No SYNC source, derived-capability source, background job or implicit invitation was built.

- **Schema:** nullable `communities.halaqa_id` (migration **0021**, additive `ADD COLUMN`, data-safe).
  **Not** a foreign key — academic owns `academic_halaqat` and no module constrains another's tables (§17);
  **no** uniqueness, so a halaqa may back any number of communities (**smallest cardinality model — no
  institutional rule imposed**): community → 0..1 halaqa, halaqa → 0..n communities.
- **Who manages (A3):** `SetCommunityHalaqaUseCase`, gated on the **existing** identity permission
  `communities.manage` (institutional oversight — held by owner + admin, who also hold `academic.manage`).
  No new capability/role invented; not a community *act/operation*, so the `me` block and capability
  counts are untouched. Routes `PUT /communities/:id/halaqa` (set) and `DELETE …/halaqa` (clear), edge
  `communities.read`, use case enforces `communities.manage` — the established "coarse edge, use-case
  decides" pattern. Audited (`communities.halaqa.linked` / `.unlinked`); no domain event (nothing may
  react, by the inert rule).
- **ISOLATED ARCHITECTURAL DECISION (validation vs. boundary):** ADR 0016 dec 11 anticipated validating the
  referenced halaqa "through `ACADEMIC_RELATIONSHIPS`." That is now **prohibited** by the CI-enforced
  communities↔academic isolation (communities.md §17; `communities-boundaries.spec.ts`: Communities imports
  *only* identity contracts). Because the link derives nothing, a stale reference is inert, so the link is
  **shape-validated only** (non-empty id); cross-module existence validation is **deferred** pending an
  owner/architect choice — see ADR 0033 for the options. This is a genuine boundary trade-off, surfaced,
  not silently guessed.
- **Flutter:** `Community.halaqaId` added (inspect round-trips). The link/unlink **UI control is a
  documented deferred entry point**: oversight authority (`communities.manage`) is deliberately not
  surfaced in the community `me` block, so there is no server-authorized client signal to gate a control
  without either reintroducing a community operation (the ripple this design avoided) or modelling
  institution-admin standing in the app. Server remains the single enforcement point.
- **Tests:** `communities.api.spec` (link/unlink by oversight only; member & non-member-reader denied
  `identity.permission_denied`; inspect; no membership/capability/lifecycle change; cardinality — one
  halaqa backs two communities; malformed body → 400; unknown community → 404); `communities-boundaries.spec`
  green (confirms **no** new communities→academic edge).

### Q22 — conversation member list is owner/admin only (APPROVED)

Only the institution **owner and top-level administration** may read a conversation's participant list.
The boundary **is** cleanly expressible in the existing model — `users.manage` is held by OWNER + ADMIN
only (no teacher, supervisor, assistant-teacher, student, parent) and is already the repo's canonical
"is an administrator" test — so the slice proceeded (no STOP). Reusing it invents no role/permission.

- **Enforcement (server-side, single point):** `ListParticipantsUseCase` now requires
  `users.manage` after the membership/community checks, uniformly across DIRECT/GROUP/CHANNEL. The former
  channel-only rule is subsumed. Taking part, owning the conversation, channel-publishing, teaching or
  managing a community grant **no** roster access. The membership precondition is kept (narrowing only —
  no new non-member snooping added). Reading messages, sending, and managing participants are unchanged.
  The one roster route (`GET /messaging/conversations/:id/participants`) is the only member-list surface;
  community-chat rosters remain refused here (Communities' `community.members.view`).
- **Flutter:** no consumer fetches the roster; the generic `messaging.members_hidden` copy already exists —
  no app change needed.
- **Tests:** `reading.spec` (owner/admin lists; conversation-owner & plain member denied; channel subscriber
  denied; paging by the admin); `messaging.api.spec` (server-side 403 for teacher/student, 200 for owner).

### Q31 — teacher roster is current students only (CORRECTION)

A teacher's roster is the halaqa's **current** (ACTIVE) students; **former** enrollments (COMPLETED,
WITHDRAWN) are an academic administrator's view (`academic.manage`), never reached through a teaching
assignment. There are **no "future" enrollments** in the data model (an enrollment is ACTIVE from the
moment it is made), so none to exclude. Historical records are preserved and the admin workflow is intact.

- **Enforcement:** `ListHalaqaStudentsUseCase` refuses a non-ACTIVE `status` filter
  (`academic.historical_roster_denied`, 403) unless the caller holds `academic.manage`. The default
  (ACTIVE) roster — the teacher's normal call — is unchanged, so no teacher workflow breaks.
- **Tests:** `access.spec` (teacher denied COMPLETED/WITHDRAWN, current roster intact, admin keeps history);
  `academic.api.spec` (HTTP 403 for a teacher's `?status=COMPLETED|WITHDRAWN`, 200 for the admin).

**Now closed:** Q22; the Q31 former-/future-student sub-question; Q50's optional halaqa-link (as inert
metadata). **Remains OPEN:** Q50's enrollment-sourced membership and derived-capability questions (still
not built, by design); cross-module halaqa-existence validation (deferred, ADR 0033); parent/non-teacher-
staff communication.

---

## 18. Q50 halaqa link — validation and management UI completed (Sprint 29)

Sprint 28 (§17) shipped the optional link as inert metadata but **deferred** two
things: cross-module existence validation and the Flutter management control.
Sprint 29 completed both; everything else in §17 stands (still inert — no
membership, capability, messaging or attendance is derived; ADR 0023 untouched).

- **Existence validation — now real (ADR 0033 update).** A link's target is
  validated server-side before it is stored, through a new read-only
  `halaqaExists(halaqaId)` on academic's **public** `ACADEMIC_RELATIONSHIPS`
  contract (existence only — no enrollment, teaching, name or roster).
  `SetCommunityHalaqaUseCase` refuses a dangling reference with
  `communities.halaqa_not_found` (404) before persisting; unlinking needs no
  check. This is **architecture-legal** (the cross-module rule has always made a
  module's `contracts/` public; communities touches academic through that
  contract alone, never its internals or tables) and **acyclic**. The
  module-specific `communities-boundaries.spec` — stricter than the rule, and
  premised on the now-reversed "no halaqa link" — was amended **surgically** to
  allow exactly that one edge; every other isolation assertion still holds. The
  §17 "deferred / shape-validated only" note is superseded.
- **Management UI — now built.** The server surfaces the authority as
  `me.canManageHalaqa` (from `communities.manage`; owner/admin only) — a UI
  courtesy, never the authorization. The community management surface shows the
  current association (resolved to the halaqa's name via the academic catalogue)
  and offers, to that viewer only, a link/change control (a halaqa picker reusing
  the catalogue — structure only) and an unlink control (after confirming). The
  §17 "deferred UI entry point" note is superseded. `canManageHalaqa` is additive
  to `me`; it is not a community operation, so the operation/capability counts are
  unchanged.
- **Tests:** backend `relationships-contract.spec` (halaqaExists true/false, no
  data revealed), `communities.api.spec` (real halaqa linked; nonexistent → 404;
  oversight-only; no membership/lifecycle change; cardinality; `me.canManageHalaqa`
  admin-yes/member-no), `communities-boundaries`/`academic-boundaries`/`arch:index`
  green with the one new edge; Flutter `community_halaqa_link_test` (presentation
  gated, link via picker, unlink, refusal) + `community_models` (parse).
- **Still OPEN (unchanged):** Q50's enrollment-sourced membership and derived
  capabilities — still not built, by design.

---

## 19. Q50 enrollment-sourced membership & derived capabilities — investigated, stays OPEN (Sprint 30)

Sprint 30 investigated whether enrollment-sourced membership and derived
capabilities can be built **safely within the existing architecture**. The
answer is **not yet** — the policy is not owner-approved and the data model is
not ready. Full evidence table, the exact owner decisions, and the ready design
are in [ADR 0034](architecture/decisions/0034-q50-enrollment-sourced-membership-and-derived-capabilities.md).
Nothing was implemented; the current **inert** behaviour was locked with a
cross-module regression test.

**Why it stays OPEN (each reason sufficient):**

1. **Policy not approved (RESOLVED-as-NO by the provisional default, not by owner
   "yes").** open-questions Q50's default is "no enrollment-sourced membership and
   no derived capabilities in v1"; ADR 0032 rejects deriving membership as "exactly
   Q50, which is OPEN… this ADR is forbidden to invent." The capability↔relationship
   mapping is undefined — inventing it is forbidden. **Reconciled (Sprint 31):** the
   governance prerequisites ADR 0034 cited — Q36/Q35 (ADR 0015), ADR 0015 itself, and
   the Q40 governance gate (ADR 0016) — are now all **RESOLVED**, so the *operative*
   blocker for Q50-derive is the owner policy A–E (+ the two model migrations), not
   those gates. ADR 0034's decision (defer) is unchanged.
2. **Model gaps (verified in source).** Membership `source` is `['ADDED','INVITATION']`
   — no derived value, and one ACTIVE stint per person — so a derived membership
   can't be told apart from, or removed independently of, a manual one. Capability
   grants are owner-delegated with **one active grant per stint+capability and no
   `source`** — a derived and an independent manual grant of the same capability
   can't coexist, so derived revocation would be unsafe. Both need additive
   migrations *before* any implementation.
3. **Infra is ready (so this is not the blocker).** No outbox/broker/scheduler is
   needed: the `CommunityChatSync` pattern (wake-on-event → pull-from-contract →
   idempotent apply → boot+interval sweeper) already gives self-healing propagation
   over the non-durable in-memory bus. Academic already emits enrollment events
   (zero consumers today).

**Exact owner decisions required** (narrowed; see ADR 0034 §"decisions required"):
A eligibility (which states confer membership; what completion/withdrawal does);
B target & cardinality (a halaqa backs ≥0 communities — all? none-until-one? no-op
when none?); C derived membership is a distinct, coexisting source; D the exact
capability↔relationship mapping (if any) + independent-source survival; E async
projection is acceptable.

**Classification:** **OPEN** (essential policy + two model migrations outstanding).
Independently verified & complete this sprint: the source investigation, the
evidence table, and the regression test proving the link + enrollment are inert.
**Keep the Sprint 29 halaqa-link decision intact** — the association alone causes
no membership or capability side effect.

---

## 20. Community membership governance — owner decision, Q50 fully resolved (Sprint 32)

The owner approved the membership/capability policy direction (Policy A–E). This
**answers** the Q50 question ADR 0034 §19 left open — in the direction the existing
design already assumes — and is recorded in
[ADR 0035](architecture/decisions/0035-community-membership-governance-separation.md)
(Accepted; supersedes ADR 0034's open/deferred *status*). **No product code, schema,
migration, contract, role or capability changed** — the implementation already enforces
it; one regression test was added (enrollment *ending* removes no explicit membership).

| Policy | Decision | Already enforced by |
| --- | --- | --- |
| **A** enrollment ↔ membership | Enrollment neither **creates** nor **removes** community membership; linking a halaqa adds/removes no member | `academic` imports no `communities`; `communities.api.spec` (enroll adds no member; *end* removes none) |
| **B** who may add members | Unchanged — explicit `community.members.invite` / invitation / `communities.manage`; **not broadened** | `AddMembers`/`Redeem`/member-candidates re-authorize (ADR 0032); no new route |
| **C** membership source | Stays explicit `{ADDED, INVITATION}`; **no** academic/`SYSTEM`/derived source; never merged | `MEMBERSHIP_SOURCES`; `community_members_source_valid` CHECK |
| **D** membership ≠ admin capabilities | Ordinary membership grants nothing; removal ends only that stint's grants (`membership_ended`), per-community; another community's membership/grants untouched; **no independent grant revoked** | `memberStint` (MEMBER, no grants); grant composite-FK per stint+community; `delegation.spec` ("gives nothing in another community"); `communities.api.spec:174` (MEMBER `capabilities: []`) |
| **E** module separation | enrollment / membership / invitations / grants / attendance / messaging stay separate; no new coupling, abstraction, flag or job | CI module-boundary specs; the one approved edge (communities→`academic/contracts/relationships`, read-only, ADR 0033) |

**Policy D data-model check (ADR 0034 §Policy-D caveat resolved):** every grant is bound
to exactly one stint in one community; there is **no independent-of-membership grant**
concept, so ending a membership can only end that stint's own grants — the model *can*
distinguish, so **no new revocation rule was invented** and none is needed.

**Q50 status: RESOLVED** (link = ADR 0033; membership/capability separation = ADR 0035).
No conflict with any immutable ADR (0016 dec 11, 0032, 0033, 0034 all preserved the
separation this makes permanent). **Still owner-gated elsewhere (unchanged):** the
educational product loop (groups C/D/G), parent messaging/quiet-hours (Q6), Q28 residue.

---

## 21. Q6 quiet hours & conversation mute — owner decisions, implemented (Sprint 35)

The owner approved building the quiet-hours and per-conversation-mute parts of Q6/Q24 and
answered the two policy points existing governance did not settle. Recorded in
[ADR 0036](architecture/decisions/0036-quiet-hours-and-conversation-mute.md) (Accepted) and
built additively (migration 0022). Academic enrollment, community membership and every
authorization policy are **unchanged**; no new permission was minted.

| Point | Owner decision | How built |
| --- | --- | --- |
| **Override direction** (was unsettled) | **Full override** — a user's own setting replaces the institution window for them: inherit, disable, or set a custom window | `UserQuietHoursPreference` INHERIT/DISABLED/CUSTOM; `quietHoursSuppressesPush` resolves the user's window over the institution's (`domain/quiet-hours.ts`) |
| **Missing/invalid user timezone** (was unsettled; Q12 only covers attendance) | **Fall back to the institution timezone**; a guessed/hard-coded zone is never used; no institution zone → quiet hours do not apply | `evaluationZone` = valid user tz → valid institution tz → none; validated IANA-only (offsets rejected) |
| Suppression scope | **Push only** — the in-app record is always stored, realtime untouched | decided in the dispatcher, recorded in `channels.push`; `store` unconditional, `realtime` unchanged |
| Urgent / always-deliver | **None** — no bypass until a separate explicit policy | suppression never branches on the notification; pinned by test |
| Mute identity/scope | Keyed on a notification's stable `conversation` target; one conversation, one person; never touches membership, capabilities, access, categories, other conversations, or in-app storage | `conversation-mute.ts`; `conversation_mutes` table (opaque id, no FK out) |
| Authorization | Institution policy = `settings.manage` (owner-only); user settings & mutes self-scoped; **no admin reach widened, no new permission** | `InstitutionNotificationSettingsController` (`@RequirePermission`); user routes `@Authenticated()` on `NotificationsController` |

**Push stays a stub** (ADR 0013 / Q24 unchanged): `LoggingPushProvider` sends nothing; a real
provider will read the same `channels.push` decision. **Still open (not resolved by this):** the
push *provider* and lock-screen *preview* (Q24), the messaging-permission and parent parts of Q6,
and any urgent-notification policy. The institution's actual schedule was **not** invented — the
institution configures its own window.

---

## 22. Educational core — DEFERRED by owner decision (Sprint 39)

The owner decided to **skip the educational core for now and return to it later**. This is a scheduling
decision recorded as **DEFERRED, not cancelled**; it resolves none of the underlying institutional-policy
questions and authorizes no implementation.

**Deferred (preserved, resumable) — GROUP C / Q37, Q9, Q38:**

- Quran memorization progress and records.
- Student assessment and assessment history.
- Mastery tracking.
- Student progression and movement between halaqat.
- Real certificate issuance, verification, and revocation.

Notes:

- **No implementation authorized** at this time; the existing honest "nothing recorded / mock" behaviour
  stands (`UnrecordedProgressRepository` → null; certificates mock in both app modes; `CERTIFICATE_ISSUED`
  notification inactive). Nothing is cancelled or deleted.
- **Questions preserved and still OPEN:** Q37, Q9, Q38 in `open-questions.md` are left exactly as they are
  (not marked resolved), together with the Sprint 37 discovery brief and the Sprint 38 decision set (D1–D8)
  and implementation-phase plan — so the work resumes with full context.
- **«نظام الضخ» is excluded from scope and is NOT a required feature** (owner, Sprint 38). It is *excluded*,
  not merely deferred, and is **not reopened or expanded** here.
- **No target date, deadline, or release commitment** is set — deferral is open-ended until the owner resumes it.
- **Unrelated workstreams are unchanged:** GROUP D (assignments), GROUP G (operations/automation/reporting;
  Q70/Q71/Q72), notifications, live media, and the P8/P11 tracks keep their existing statuses. This entry
  touches only the GROUP C educational core.
- **GROUP C Status (§3) now reads DEFERRED**; the ranked list (§6) and milestone map (§11) are left unchanged —
  they rank GROUP C by *unlock potential*, which this *scheduling* deferral does not contradict.

---

## 23. Activate the built platform — in-app administration + teacher layer; build toward a trial release (Sprints 42–50)

The owner directed activating the already-built, server-authoritative capabilities with Flutter surfaces, and
(2026-10-14) **to pause practical device testing and keep building until there is a coherent, usable trial
release.** **No institutional policy was invented and no permission or product scope was expanded**; every
surface re-authorizes server-side.

| Sprint / commit | Shipped | Authority | Note |
| --- | --- | --- | --- |
| 42 `b45b272` | In-app community creation | `communities.create` (OWNER/ADMIN) | resolves GROUP B's "app-side create" question — **YES** |
| 43 `2649057` | Start a live session from the community screen | existing live control plane | control plane only — no media-binding change |
| 44 `d52ae21` / 47 `af96bb4` | Account provisioning + lifecycle admin (roles, status, password reset, session revocation) | over `/admin/users`; self / outrank / role-rank guards | no new permission minted |
| 45 `bf05e38` | Academic **structure** management (sections/programs/halaqat CRUD) | `academic.manage` | **structure only — NOT the educational core (GROUP C stays DEFERRED)** |
| 46 `fd7ed39` / 48 `bde2c9f` | Enrollment & teacher-assignment administration + read-only history | `academic.manage`, OWNER/ADMIN | discovery/relationships OWNER/ADMIN-only; no self-enrollment; no supervisor roster; Q22 unchanged |
| 49 `0d01a12` / 50 `d754284` | Teacher workspace — own halaqat + read-only students & co-teachers | `academic.teach` | read-only; no management controls |

**Verified state (HEAD `d754284` runtime audit, 2026-10-14, local — not device/CI-ID):** backend typecheck
pass; backend `npm test` 3,892 passed / 382 skipped / 0 failed; Flutter analyze clean; latest full Flutter
suite 1,524 passed. **Gaps:** the deployed Pages build is demo/mock-only; real-backend end-to-end integration
is unproven; chat + LiveKit need complete product integration/readiness; **LLM token streaming and
STT/LLM/TTS voice-AI are not implemented**.

**Trial-release path (ordered — none is done until actually executed):** (1) prove the app E2E against a real
backend (Postgres/Redis + an `API_BASE_URL` build); (2) produce the installable artifact + resolve the
**UNRESOLVED** release format (Android→APK; iPhone→iOS signing/testing, owner-provided Apple team); (3)
complete chat + LiveKit readiness; (4) a shared real-backend env for testers. Integrated testing and an APK /
iOS build are **not** counted as achieved before they are executed.

**Still owner-gated / unchanged:** GROUP C educational core **DEFERRED** with **«نظام الضخ» excluded** (§22);
GROUP D/G; messaging-group admin; student self-enrollment; supervisor academic visibility; parent messaging &
quiet-hours residue (Q6). This section records delivery and direction; it opens no new decision.

## 24. Scheduling domain — one-off dated academic lessons (confirmed decisions only; not approved for build)

The owner **confirmed** three scheduling decisions, recorded here as settled policy:

- **One-off (individual) dated lessons only.**
- **An explicit, persisted institution timezone in IANA form** (IANA zone id; reusing the existing
  `isValidTimezone()` / `institution_notification_settings` IANA rule — offsets rejected).
- **No recurring scheduling.**

**NOT approved — do NOT treat as settled, and do NOT begin implementation:** the detailed engineering design;
the permissions for **creating / editing / cancelling** lessons; and any **other timezone decisions** (how
the instant is stored, per-lesson snapshots, server-formatted local fields, DST handling, etc.). A read-only
design gate explored these, but they are **pending** and must be resolved before any build.

**Status:** NOT-STARTED. Only the three decisions above are confirmed; everything else is open. This invents
no present/absent policy and resolves no GROUP G attendance-record question (Q70/Q71/Q72). **Attendance stays
separate from live connectivity** (ADR 0020 dec 3 / 0023; Q68 OPEN) — a standing prior decision, unchanged.

## 25. Trial remediation (2026-10-18) — decisions requested, none taken

The engineering remediation of the deployed web Trial is recorded in
[`trial-remediation-2026-10.md`](trial-remediation-2026-10.md) (findings, design, tests, deployment
plan, proposed acceptance criteria). It changes **no** role grant, permission, migration or product
policy. It asks the owner for: **D-1** authorize the authenticated Trial smoke test (exact writes
listed); **D-2** web token storage (Q17 — options a–d); **D-3** supervisor access to the account
directory and an explicit §11 exception (implemented meanwhile: login identifiers only for
`users.manage`); **D-4** web-Trial acceptance criteria and release format; **D-5** the Trial product
description replacing «واجهات فقط»; **D-6** DM eligibility before offering the button; **D-8** nginx
headers and the redeploy. Each record is in that file's §5; this entry only indexes them. **D-7 is
withdrawn:** Quiet Hours is rejected (roadmap §8) and settled — not a decision and not reopened; the
remediation changes nothing about it and records, in that file's §6, that this register (§21) and
ADR 0036 do not yet reflect the rejection.

---

## 26. Mass publishing to communities — owner decision, built (2026-10-19, ADR 0041)

The owner directed building **mass publishing of files, images and voice recordings to several communities
at once**, with per-community authorization, correct partial-failure handling and retry. This answers
roadmap domain 3's open "broadcast/announcement" item (whose Next action was an owner decision) and is
recorded in [ADR 0041](architecture/decisions/0041-mass-publish-to-communities.md) (Proposed). **No role
grant, permission, migration or notification policy changed.**

- **Distinct from «نظام الضخ».** The EXCLUDED «نظام الضخ بين الأقسام» (register §22, Sprint 38;
  owner-information §S5, Q25/Q26) is the **academic student-progression move** between halaqat/sections —
  part of the deferred educational core (GROUP C). This decision is **content broadcasting** to community
  chats. They share a word, not a feature; §22 is untouched and «نظام الضخ» stays excluded.
- **What was built.** `POST /messaging/communities/publish` (edge `messaging.send`) posts one message —
  text, or one image/voice/document — to a chosen set of communities, each authorized on its own
  `community.chat.post` through the existing `MessageSender` path. Partial failure is a per-community
  outcome (posted / already_posted / forbidden / not_found / locked / over_capacity / rate_limited /
  unavailable), never a thrown batch; a deterministic per-community idempotency key makes retry safe
  (no duplicates). A media attachment is uploaded once and the one reference published to every target.
- **No new policy.** `messaging.send` + the existing per-community `community.chat.post`; no migration; and
  **no notification change** — each post behaves exactly like a human posting the same message in each
  community, so the Q28 large-channel / priority / always-deliver questions stay OPEN and untouched. Every
  message still has a real member-sender allowed to post (ADR 0011 dec 6 / Q53) — no senderless broadcast.
- **Command center completed alongside (ADR 0040 follow-on).** A server-gated **actions** registry
  (quick actions to real operations, each hidden unless the viewer holds its permission — including
  `publish.communities`) and an **accounts** summary widget (`users.manage`), via a new read-only identity
  contract `ACCOUNT_DIRECTORY_SUMMARY` (a grouped count; no new permission, no migration).
- **Still owner-gated / unchanged:** a persistent announcement *feed* (not requested); GROUP C (DEFERRED,
  «نظام الضخ» EXCLUDED); GROUP D/G; scheduling build (§24, NOT approved); parent messaging & quiet-hours
  residue (Q6). This section records a delivery and opens no new decision.

---

## 27. Scheduling of individual dated lessons — owner decisions D1–D5, built (2026-10-20, ADR 0042)

The owner approved the open scheduling decisions prepared in
[`scheduling-decision-brief.md`](scheduling-decision-brief.md) (D1–D5), which supersedes §24's "NOT
approved for build" for exactly this scope. Recorded in
[ADR 0042](architecture/decisions/0042-operations-scheduled-lessons.md) (Accepted).

| Point | Owner decision | How built |
| --- | --- | --- |
| Scope | Individual, explicitly dated lessons; one halaqa each; **no recurrence** | `operations_lessons` (migration 0026); halaqa existence via `ACADEMIC_RELATIONSHIPS.halaqaExists` |
| Who schedules | A dedicated capability, owner/admin only | `operations.schedule_manage` (migration 0027; OWNER + ADMIN, no other role); reads gated too |
| Storage | Local date/time + the IANA zone **captured at creation** + the resolved `timestamptz` instant | three columns + `scheduled_at`; a later institution-zone change never moves a lesson |
| DST | Reject nonexistent (gap) times; ambiguous (fold) → the **earlier** instant | pure resolver `domain/time-resolution.ts` (`Intl` tz data, no `Date` string parsing) |
| Past | Reject new/rescheduled lessons at or before now (injected `Clock`, strict) | `domain/scheduling-policy.ts` — the seam for a future horizon/conflict rule |
| Conflicts | **None** in this release; kept separate from validation | not built — "conflict" needs an owner definition |
| Lifecycle | Cancellation is an auditable transition, not a delete | `SCHEDULED → CANCELLED` (terminal) with `cancelled_at/by`; DB CHECK keeps them consistent |

**Conflicts found and resolved (reported, not silently worked around):**

1. **Institution-timezone source.** The only institution timezone lived in the owner-**rejected** quiet-hours
   resource (§25, roadmap §8), whose update even requires a quiet-hours window. Scheduling therefore reads a
   new, neutral deployment setting `INSTITUTION_TIMEZONE` (`AppConfig.institution.timezone`, IANA-validated,
   wired into `infra/compose.yaml`); when unset, a create must name a zone (`operations.timezone_required`).
   Unifying it with the quiet-hours timezone is a future owner decision.
2. **Permission code shape.** The owner named the capability `operations.schedule.manage`; the immutable
   `permissions_code_shape` CHECK (migration 0001) allows a single dot, so the stored code is
   `operations.schedule_manage` — same meaning.

**Still owner-gated (unchanged):** scheduling horizon; conflict detection; teacher authorship (Q31);
scheduling notifications (Q28); derived attendance (Q70/Q71/Q72); assignments (GROUP D); automation /
task tracking (Q71/Q3); "emergency management". Attendance stays separate from scheduling and from live
connectivity (ADR 0020 dec 3 / 0023).

---

## 28. Groups & channels posting — new groups open by default (owner-approved 2026-10-19, ADR 0039)

The owner approved the Groups & Channels product behaviour in the Phase 5 brief (2026-10-19, "Final
Owner-Approved Product Requirements"). It was built in `9b4a6de` and recorded in
[ADR 0039](architecture/decisions/0039-groups-and-channels-chat-mode.md), which the owner **Accepted**
on 2026-10-20 (see below). It answers the **posting half of Q51** and Q41's "kind" column. This section
records those approvals.

| Point | Owner decision (brief, verbatim intent) | How built / enforced |
| --- | --- | --- |
| New group | "New groups must be open for member participation by default"; "every active, authorized group member can send messages without receiving an individual publishing grant" | `chatModeForKind('GROUP') → GROUP_OPEN` (a create without a kind is a GROUP); `POSTING_MEMBER_RULE`: membership basis, ceiling `communities.read` + `messaging.send` |
| Restricted group | Admins can restrict ordinary members and restore them; a restricted group stays a group; read access and membership are kept | `PUT /communities/:id/chat-mode` (`community.chat.manage`); `GROUP_RESTRICTED` → publisher rule (owner or a `community.chat.post` grantee, ceiling `communities.moderate` + `messaging.send`) |
| Channel | Only the owner and authorized publishers/admins publish; members read | `CHANNEL` → the same publisher rule; the product kind is immutable |
| Existing communities | No conversion; current effective permissions preserved | migration 0025 column default `GROUP_RESTRICTED` (= the pre-0039 Q51 rule) |
| Enforcement | "The backend is authoritative"; hiding the composer is not enough | `SendMessage` re-asks `community.chat.post` on every send (`CommunityChats.mayPost` → 403 `messaging.posting_not_allowed`); `canPost` is a derived hint from the same evaluator; LOCKED blocks everyone |

**Effective result for an ordinary ACTIVE `STUDENT` member** (role grants include `communities.read` and
`messaging.send`, but not `communities.moderate`):

- **New group (`GROUP_OPEN`):** may post. `canPost=true`.
- **`GROUP_RESTRICTED`:** may not post. `canPost=false`, and a send is refused with 403. A `STUDENT` cannot
  even be granted `community.chat.post`, because that grant's ceiling requires `communities.moderate`.
- **`CHANNEL`:** same as `GROUP_RESTRICTED`.

All three modes are proven on real Postgres by `test/integration/community-chat-posting-postgres.spec.ts`
and in-memory by `test/api/community-chat-mode.api.spec.ts`.

**Test reconciliation (2026-10-20).** `community-chat-posting-postgres.spec.ts` was written before ADR 0039
(`c6d5ee0`). It still expected `canPost=false` for a plain member of a community created without a kind,
which is now an open group. That was a stale test, not a permission defect. It now restricts its guarded
community first, so the Q51 publisher guard is unchanged, and adds the open-group and channel cases. No
production code changed.

**Governance gap closed (2026-10-20).** On 2026-10-20 the gap was that the owner had approved the
*product behaviour* but not ADR 0039's schema/authorization design. The owner then accepted ADR 0039 **as
written**, including:

- the chat-mode design (the `chat_mode` column and the delegable `community.chat.manage`);
- the authorization behaviour;
- the compatibility rules (existing rows `GROUP_RESTRICTED`, nothing converted).

0039 is now `Accepted`. Following `decisions/README.md`'s partial-supersession process:

- ADR 0016 is marked "superseded in part by 0039" (its "no `kind`", decisions 1 and 3, and the rejected
  `kind` alternative);
- ADR 0017 carries "Extended by 0039" notes (the new capability, and the open-group `chat.post` rule).

Q51 stays open only for its PROVISIONAL "one chat" and size defaults.

---

## 29. First web-first Trial release — owner includes Command Center, Mass Publishing, Pinned Messages (2026-10-20)

**Owner decision (2026-10-20, explicit).** The first web-first Trial release **includes** all three features:

- **Owner Command Center** — [ADR 0040](architecture/decisions/0040-owner-command-center-reporting-registry.md);
- **Mass Publishing to multiple communities** — [ADR 0041](architecture/decisions/0041-mass-publish-to-communities.md);
- **Pinned Messages** — [ADR 0043](architecture/decisions/0043-pinned-messages.md).

Accordingly these three ADRs move **`Proposed` → `Accepted`** (dated 2026-10-20, by the owner), per
`decisions/README.md` ("becomes Accepted when the user accepts it, dated in the ADR"). Each was already
implemented in the working tree (uncommitted); this records the authorization, not a code change. Their
contracts/migrations are additive: 0040/0041 add **no** migration; 0043 carries migrations **0028/0029**
(additive, backward-compatible), which run with the release migrate step against the **Trial DB only**.

**Trial runtime contract — [ADR 0037](architecture/decisions/0037-trial-environment-and-explicit-fake-media.md)
accepted.** The owner authorizes the Trial to run **`NODE_ENV=trial`** with **`LIVE_MEDIA_PROVIDER=fake`**
(and **`TRUST_PROXY=1`** behind nginx). ADR 0037 moves `Proposed` → `Accepted` for the Trial environment.
Real audio/video does not flow on the Trial by this choice (ADR 0037); it is refused in production.

**Still requiring an explicit owner decision (NOT taken here)** — these gate release *acceptance/rollout*, not
feature inclusion, and are carried from [`trial-remediation-2026-10.md`](trial-remediation-2026-10.md) §5:

- **D-4** — whether a **web-first** Trial is an accepted release format (the only written criterion,
  roadmap §5 row TRIAL, demands an installable APK/iOS build). Undecided.
- **D-1** — authorization for the **authenticated smoke test** (writes a conversation/message/mute/session to
  the Trial DB). Undecided — without it no runtime journey is verified and the Trial cannot be accepted.
- **D-8** — authorization to **apply the nginx security-header snippet** and perform the redeploy.
  ~~Undecided.~~ **Resolved 2026-10-20 — approved conditionally** (nginx headers only after compatibility
  validation + a verified rollback plan; `docs/project-checkpoint.md`), and **applied on Trial 2026-10-18**:
  the snippet is live, `include`d in both `location /` and `location /api/` of the Trial server block, with
  HSTS held at `max-age=86400` (the 1-day ramp; a raise to one year is not yet due). Trial only — no
  production or Staging deployment and no broader authorization implied.

No code, schema, permission or product policy changed by this entry. Committing, building the image,
migrating the Trial DB, and deploying are state-changing steps **pending separate explicit approval**.

---

## 30. Approved policy revision A–G and Trial backend delivery (2026-10-25)

**Owner decision (2026-10-25, explicit).** Implementation, testing, backup, migration, backend rebuild and
trial-api restart are authorized **for the Trial only**.

| | Decision | Record |
| --- | --- | --- |
| A | Owner, teachers, administration and supervisors start broadcasts through the community's own permission; no general role bypasses a missing community permission | [ADR 0044](architecture/decisions/0044-community-role-policy-revision.md) |
| B | Authorized teachers, admins and supervisors add members only where they are permitted to manage | ADR 0044 |
| C | The creator is the initial owner; change only by explicit transfer; oversight recovers only when the owner cannot act | ADR 0044 |
| D | Authors edit and delete their own messages everywhere; moderators delete within scope, never edit | [ADR 0045](architecture/decisions/0045-author-message-edit-and-delete.md) |
| E | Notifications show sender, conversation and content to authorized recipients (in-app; the lock screen stays private) | [ADR 0046](architecture/decisions/0046-notification-content-for-authorized-recipients.md) |
| F | A separate live-session chat with a server-enforced moderator lock | [ADR 0047](architecture/decisions/0047-live-session-chat.md) |
| G | New backend image, migrations 0032/0033, trial-api restart — after the gates pass | this entry; deployment record in the final report |

**Not decided here (left open, reported):** a lock-screen preview setting; an edit time window or revision
history; deleting a single live-chat message; recovering ownership from an owner who is merely absent; the
rest of the Q1 role matrix. Staging and production are untouched.

---

> This register is advisory and reversible. Closing a question means: record an ADR in `decisions/`,
> make the (usually small) change, and delete the entry from `open-questions.md` with the ADR number —
> per that file's "How to close one."
