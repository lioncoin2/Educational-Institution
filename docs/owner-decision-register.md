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

- **Status:** PROVISIONAL defaults shipped; the institutional definition and the archive/delete policy
  are open.
- **Classification:** PRODUCT_POLICY + INSTITUTIONAL_POLICY.
- **Evidence:** Q41 ("No institutional source mentions communities… creating spaces of up to 30,000,
  many minors, is a safeguarding decision"; provisional: `communities.create` = OWNER/ADMIN, creator
  becomes owner, no `kind`); Q47 (no ARCHIVED, LOCKED only; never deleted, FKs RESTRICT; a P6 ruling:
  a missing community fails closed); Q48 (link lifetimes 7d/30d, immediate join, no preview/approval).
- **Today:** communities exist, are created by OWNER/ADMIN (backend `POST /communities`, tested), locked
  /unlocked, never archived or deleted; the app has **no create screen** (membership+management only).
- **Blocked:** an app-side create-community flow; an ARCHIVED state; any delete/retention path.
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
- **Safe interim:** current provisional defaults (no app create, no archive, links as configured).

### GROUP C — Academic progression, assessment, mastery, certificates  (must NOT be invented)

**IDs: Q37 (assessment/placement/mastery/«نظام الضخ»), Q9 (certificates), Q38 (development path).**

- **Status:** unresolved; **nothing built** (by rule — the brief forbids inventing placement/promotion/
  completion rules).
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

> This register is advisory and reversible. Closing a question means: record an ADR in `decisions/`,
> make the (usually small) change, and delete the entry from `open-questions.md` with the ADR number —
> per that file's "How to close one."
