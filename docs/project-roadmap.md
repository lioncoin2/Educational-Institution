# Project roadmap — Educational Institution (master, reconciled)

**Purpose.** The single authoritative, evidence-grounded roadmap: what is done, partial,
unstarted, blocked, deferred, or stale, and the correct next step. It consolidates the
previously distributed roadmap (the owner-decision register's phase mapping and the phase
table in `architecture/communities-live-attendance.md §25`) into one place and links to the
detailed sources rather than copying them.

**Ownership / scope.** Architecture + program management. This file tracks *status and
sequencing*; it does not make product-policy or engineering decisions — those live in the
ADRs (immutable) and the owner-decision register.

**Last updated.** 2026-10-13 (Sprint 32 — owner membership/capability policy recorded, ADR 0035;
Q50 fully resolved; one regression test; no product feature code changed). Prior reconciliation: Sprint 31.
**Current verified HEAD.** `2140a4d` (Sprint 31) at the start of Sprint 32; this Sprint 32 update commits
on top of it. Branch `claude/quranic-education-app-prototype-gkzle8`, in sync with origin. Always re-verify
with `git rev-parse HEAD` / `git status` — this file is a reversible snapshot, not a substitute for git.

---

## 1. Source-of-truth & precedence

No single file was authoritative before this one; the roadmap was distributed. Precedence by
category (unchanged — this file defers to each for its own category):

| Category | Authoritative source |
| --- | --- |
| Engineering governance (permanent) | `docs/ENGINEERING_RULES.md` — overrides everything below |
| Engineering decisions / owner approvals | the ADRs in `docs/architecture/decisions/` (immutable; a new ADR supersedes an old one), indexed by `decisions/README.md` |
| Open questions / governance gates | `docs/architecture/open-questions.md` (Q1–Q72); the governance gate is **Q40** (answered, ADR 0016) |
| Owner-policy roadmap mapping (groups A–G) | `docs/owner-decision-register.md` |
| Phase ledger (design-time) | `docs/architecture/communities-live-attendance.md §25` — **a protected file with uncommitted user edits; read-only here** |
| Current repo state / continuity | `docs/project-checkpoint.md` ("the continuity source") |
| Phase completion evidence | `§25` + `docs/p6*/p7*/p9*` phase docs |
| Operational / load evidence | `docs/p8-load-capacity-plan.md` + `docs/p8/*`, `docs/p7-livekit-deployment-verification.md`, `docs/p7.3/p7.4` records |

**This file (`project-roadmap.md`) is now authoritative for overall status and sequencing.**
Where it and a legacy source disagree, the disagreement is recorded in §12; it is resolved from
source code, Accepted ADRs, and dated evidence — never by picking the newer-looking document.

---

## 2. Executive status

A single-institution Quran-education platform: a NestJS/Drizzle modular-monolith backend and a
Flutter/Riverpod app. **The communications and live-session platform is built and CI-verified on
web; the educational *product loop* (progress, assessment, assignments, operations) is not built
and is owner-policy-gated by design.**

- **Done & verified:** identity/sessions, communities + membership + delegation + invitations,
  messaging (+ moderation, attachments on web), community chat, live control plane + **web** media
  (real LiveKit), attendance record+view, notification translators, the policy-gated live features
  (ADRs 0026–0029), and the optional community→halaqa link (ADR 0033).
- **Implemented but validation-pending / mock:** LiveKit server deployment (configured, not
  operationally verified); real push delivery (logging provider only); web attachments (no device).
- **Resolved by owner decision (Sprint 32, ADR 0035):** Q50 enrollment-sourced membership & derived
  capabilities — decided **NO** (enrollment, membership and capabilities stay separate); nothing built,
  the existing separation is permanent policy and regression-tested. **Q50 is now fully resolved.**
- **Deferred by decision:** the P8 off-box capacity ladder (harness built, **no rung executed**);
  EXPLAIN-at-scale benchmark.
- **Not started / blocked:** native (iOS/Android) media; P11 horizontal scaling (blocked on P8
  evidence); every educational product loop (owner-policy-gated — must not be invented).

---

## 3. Status legend

`COMPLETE-VERIFIED` · `IMPLEMENTED-VALIDATION-PENDING` · `PARTIAL` · `NOT-STARTED` · `BLOCKED` ·
`DEFERRED-BY-DECISION` · `SUPERSEDED` · `NEEDS-REAUDIT`. These are **not** interchangeable:
NOT-STARTED = no implementation; BLOCKED = waiting on a named prerequisite; DEFERRED = intentionally
postponed with a rationale. Implementation ≠ operational proof (a harness is not a run; a web build
is not device validation; a mock pass is not real-provider interop; a deploy workflow is not
production proof).

---

## 4. Sprint ledger (19–30) — git- and CI-verified

Commit timestamps are the branch's git timestamps (2026-10-12/13; the history is compressed —
the *design/landing* dates quoted in the phase docs, e.g. 2026-09-23, are earlier and are not git
facts). Every SHA and every CI/Deploy run ID below was verified this sprint (`git log`,
`gh run list`). CI = `ci.yml` (jobs: Backend incl. Postgres integration with `POSTGRES_REQUIRED=1`,
Backend — real LiveKit, Flutter app). Deploy = `deploy-pages.yml` (web-only). All runs succeeded.

| Sprint | Outcome | Commit | CI run | Deploy run | Did NOT complete |
| --- | --- | --- | --- | --- | --- |
| 19 | Secure persistent sessions (`SecureTokenStore`) | `89a8879` | 38216364165 | 38216364381 | native keystore unverified |
| 20 | Real LiveKit web media activated | `76e8e48` | 38254939811 | 38254939959 | native; also Live E2E (real LiveKit) run **38254959768** ✓ (web/Chrome, fake devices) |
| 21 | Web message attachments & voice | `8b88f92` | 38259433922 | 38259433921 | native/real-device file-pick, mic, playback |
| 22 | Checkpoint reconciliation | `f67c4f6` | 38261169061 | 38261169219 | — (doc) |
| 23 | Decision-readiness matrix (read-only audit) | — (no commit) | — | — | — |
| 24 | Least-privilege people discovery (Design X) | `03fd925` | 38291615555 | 38291615360 | parent messaging/quiet-hours (Q6) |
| 25 | ADR 0032: discovery ≠ membership ≠ attendance | `af0ebb8` | 38294588272 | 38294588280 | — (doc/ADR) |
| 26 | People-directory permission description fixes | `1cf726b` | 38296964783 | 38296964729 | — (doc) |
| 27 | GROUP A / Q50 authorization audit + tests | `42507b3` | 38300022949 | 38300022992 | Q50 broad, Q22, Q31-former-students (left OPEN) |
| 28 | Q50 halaqa link (inert), Q22 member-list, Q31 roster | `54204f9` | 38314955339 | 38314955277 | Q50 existence-validation + UI deferred |
| 29 | Q50 halaqa existence validation + Flutter link/unlink UI | `c6f48e9` | 38323027472 | 38323027465 | Q50 enrollment-membership/derived-caps left OPEN |
| 30 | Q50 enrollment-membership/derived-caps investigated → deferred (ADR 0034) | `144ab15` | 38329854598 | 38329854602 | nothing implemented (by design); Q50 stays OPEN |

Caveat recorded for all of the above: **no CI/E2E run logs are committed to the repo** — the run
IDs are the verifiable evidence (GitHub Actions), not committed artifacts. Live E2E is
dispatch/scoped-PR only (not on-push), last run for `76e8e48`.

---

## 5. Phase progress matrix

| ID | Phase / milestone | Status | Verified evidence | Remaining work | Blocker / prerequisite | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- |
| P0–P5.1 | Corrections/guards, Live hardening, Communities core, Delegation, Community chat, Realtime+Flutter communities | COMPLETE-VERIFIED | §25 (landed 2026-09-23→26); CI Backend+Flutter green | — | — | met |
| P6 | Community-scoped live sessions (backend) | COMPLETE-VERIFIED | §25 (landed 2026-09-27, commits A–F); CI | — | — | met |
| P7.1 | LiveKit server config / provider readiness (`infra/`) | IMPLEMENTED-VALIDATION-PENDING | `p7-livekit-readiness.md`; pinned LiveKit 1.13.7; real-LiveKit CI job | Operate & verify TURN, Docker-at-runtime, production TLS, public NAT traversal | a reachable deployed environment | §18 items verified in a real environment |
| P7b-web | Flutter LiveKit media — **web** | COMPLETE-VERIFIED (web) | ADR 0030; `livekit_live_media_client.dart`; Live E2E run 38254959768 (real LiveKit, Chrome, **fake** devices); bound Unavailable unless `backendMode&&kIsWeb&&LIVE_MEDIA_ENABLED` | — (for web) | — | met for web; not device |
| P7b-native | Flutter media — **Android/iOS** | NOT-STARTED (BLOCKED: external) | ADR 0030 §Platform strategy "future native work"; `app/android`,`app/ios` vanilla; `integration_test/` empty; no mobile CI | MediaProjection+foreground service (Android), ReplayKit ext+entitlements (iOS); a native media client; device evidence | physical devices + a mobile build/signing CI (none exists); ADR 0030 condition 4 | real on-device capture/publish/remote-reception recorded |
| P8 | Off-box audio-only capacity ladder (100→300→1k→3k→5k→10k) | DEFERRED-BY-DECISION | harness `backend/test/load/**` + `p8.4-offbox-design.md §14`; **only a 2–3-participant on-box driver validation + a 2-participant smoke executed**; no result artifacts; `/var/lib/p84` absent | Execute each rung off-box, stop-on-failure, 3 runs/rung, file results; set capacity config from the knees | real matching hardware + "until real users" decision (checkpoint); gates G3/G4 | per §25: results filed, 3 runs each, invariants hold, Q26/Q57/Q65 updated |
| P9 | Attendance record + view | COMPLETE-VERIFIED | `backend/src/modules/attendance/**`; ADR 0023 (policy); Q40/Q69/Q35/Q36 resolved; CI Backend (incl. attendance E2E) + Flutter surface | — | — | met (record+view) |
| P9-bench | EXPLAIN-at-scale / 1M-entry read benchmark | DEFERRED-BY-DECISION | `attendance.md §21/§22`; never run | run on a large seeded dataset | a large seeded DB (external) | measured EXPLAIN + query counts filed |
| P10 | Notification translators | COMPLETE-VERIFIED | community/live/attendance/messaging translators + specs; ADR 0024/0025; Q67 resolved, Q28 part | — (for translators) | — | met (translators) |
| P10-push | Real push delivery | IMPLEMENTED-VALIDATION-PENDING (mock) / BLOCKED | `logging-push-provider.ts` logs only; no APNs/FCM SDK | integrate a real provider + device | Firebase/Apple credentials + a device (Q24/Q65, external) | real delivery to a device recorded |
| P11 | Horizontal scaling (outbox, broker, Redis RL, reconciler leases, multi-instance) | NOT-STARTED (BLOCKED) | §20.2; ADR 0024/0025 confirm the T2/outbox gate (ADR 0021) is closed; `ioredis` declared but unimported | build the outbox/broker/Redis/leases; multi-instance topology | **P8 capacity evidence** (absent) + a T2/T3/T4 trigger | §25: multi-instance tests — no duplicate reactions; relays deliver on every instance |
| P12 | Policy-governed live features | COMPLETE-VERIFIED | ADR 0026 (kick/reset), 0027 (no hidden listeners), 0028 (two presenters + delegated student share), 0029 (message moderation); migration 0017; live-e2e web | — (for the four slices) | — | met |
| P12-open | Screen **audio** share; webhook accelerators | NOT-STARTED (owner-policy) | §25 "still deferred"; ADR 0028 keeps screen audio off (Q56) | — | an explicit owner decision | an approved policy + ADR |
| Q50-link | Optional community→halaqa link | COMPLETE-VERIFIED | ADR 0033; migration 0021; existence validation via `ACADEMIC_RELATIONSHIPS`; Flutter link/unlink on `me.canManageHalaqa`; inert (regression-tested) | — | — | met |
| Q50-derive | Enrollment-sourced membership + derived capabilities | COMPLETE-VERIFIED (resolved as **NO**) | **ADR 0035** (owner decision, Sprint 32): enrollment ↔ membership/capabilities stay separate; register §20; regression-tested (enroll adds no member; *end* removes none) | — (not built, by owner decision; reopening needs a new owner decision + ADR) | — | met: the separation is enforced + regression-tested |
| PROD | Educational product loop (progress, assessment, mastery/promotion, certificates, assignments, announcements/feed, owner operations) | NOT-STARTED (BLOCKED: owner policy) | register groups C/D/G; Q37/Q9/Q38/Q70/Q71/Q72 | — (must NOT be invented) | explicit owner decisions | approved policy per group + ADRs |

---

## 6. Incomplete-work inventory (not limited to Q50)

Each item: what remains, the blocker, the prerequisite, the authoritative source, acceptance, and
whether the next action is engineering / owner-decision / external-op / testing / investigation.

1. **P7b-native media** — remaining: native clients + device evidence. Blocker/prereq: physical
   devices + a mobile CI/signing pipeline (none). Source: ADR 0030, `communities-live-attendance.md §25`.
   Next action: **external-operational** (stand up a mobile pipeline) then engineering. Not startable in CI.
2. **P8 capacity ladder** — remaining: execute rungs 100→10k off-box with stop-on-failure, file
   results, derive capacity config. Blocker: matching hardware + the "until real users" deferral.
   Source: `p8-load-capacity-plan.md`, `docs/p8/*`, checkpoint "P8 — DEFERRED". Next action:
   **external-operational/testing** (owner may lift the deferral). Targets (≈3k/room, ≈10k total) are
   **unproven hypotheses**, pre-bounded by discovered ceilings (app cap 300; TURN ~590; nginx ~6–7k).
3. **P10 real push delivery** — remaining: real APNs/FCM provider + device. Blocker: external
   credentials + device (Q24/Q65). Source: ADR 0024; checkpoint GROUP E. Next action: **external**.
4. **P11 horizontal scaling** — remaining: outbox, broker, Redis rate limiter, reconciler leases,
   multi-instance topology. Blocker: **P8 evidence** (absent) + a load trigger. Source: §20.2, ADR 0021/0024/0025.
   Next action: **blocked** (needs P8 first). The `EventPublisher`/`EventSubscriber` seam is ready; the mechanism is not.
5. **P9 EXPLAIN-at-scale benchmark** — remaining: run on a large seeded dataset. Blocker: external dataset.
   Source: `attendance.md §21/§22`. Next action: **external/testing**. Non-blocking.
6. **Q50 enrollment-membership + derived capabilities** — **RESOLVED (Sprint 32, ADR 0035):** the owner
   decided **NO** — enrollment neither creates nor removes membership, membership stays explicit, and
   membership grants no capabilities. Nothing built (by decision); the existing separation is permanent
   policy and regression-tested. Source: ADR 0035, register §20. No remaining action unless a future owner
   decision reopens it.
7. **Q50 halaqa-existence staleness note** — the committed `communities-live-attendance.md §25` and
   `attendance.md`/`academic-reconciliation.md` headers are stale (see §12); not a product gap. Next action: **doc** (this sprint).
8. **Educational product loop (GROUP C/D/G)** — remaining: owner policy for progress, assessment,
   mastery/promotion, «نظام الضخ», certificates, assignments, announcements/feed, owner operations/automation/reporting.
   Blocker: owner decisions (Q37/Q9/Q38/Q70/Q71/Q72). Source: register groups C/D/G. Next action: **owner-decision**.
   **Must not be invented.**
9. **P12 screen-audio share / webhook accelerators** — remaining: an owner policy decision. Source: §25, ADR 0028. Next: **owner-decision**.
10. **Q28 residue** — academic/future notification categories, parent-of-child visibility, collapsing specifics,
    guaranteed delivery (outbox T2). Source: ADR 0024 "deferred sub-decisions". Next: **owner-decision** + (delivery → P11).
11. **GROUP A residue** — parent messaging, quiet hours (Q6). Source: register §A. Next: **owner-decision**.
12. **Q68 attendance observation rule** — `NEEDS-REAUDIT`: the open-questions Q68 banner still reads
    "open/provisional" while attendance landed under ADR 0023; confirm whether the provisional rule is the
    accepted one or a decision is outstanding. Source: open-questions Q68, `attendance.md §23`, ADR 0023.
    Next: **investigation**.

---

## 7. Critical path (ordered dependencies)

1. **Owner decisions** (no engineering prerequisite; highest unlock): GROUP C/D/G product policy; GROUP A
   residue (Q6); Q28 residue; P12 screen-audio. These gate every new product loop. *(Q50 A–E is now
   decided — ADR 0035 — and needs no further action.)*
2. **P8 capacity evidence** (external-operational; owner lifts the "until real users" deferral): execute
   the ladder on real hardware → **unblocks P11**.
3. **P11 horizontal scaling** (engineering, *after* P8 evidence + a load trigger).
4. **External-resource tracks** (independent, whenever resources exist): P7b-native (devices + mobile CI);
   real push (Firebase/Apple + device); EXPLAIN-at-scale (large dataset).

Nothing in (2)–(5) should start before its prerequisite. No completed phase should be reopened without
new defect evidence.

---

## 8. Governance & owner-decision register (current status)

| Gate / decision | Status | Source |
| --- | --- | --- |
| Q40 — governance gate | **RESOLVED** (2026-09-23, ADR 0016) | open-questions Q40 |
| Q35 / Q36 — academic reconciliation | **RESOLVED** (2026-10-05, ADR 0015 Accepted) | open-questions Q35/Q36 |
| Q69 — attendance record/view scoping | **RESOLVED** (2026-10-05, ADR 0023) | open-questions Q69 |
| Q67 — community/live/attendance notification facts | **RESOLVED** (2026-10-06, ADR 0024) | open-questions Q67 |
| Q28 — notification policy | **PARTIAL** (P10 scope answered, ADR 0024; residue open) | open-questions Q28 |
| Q68 — what counts as present | **NEEDS-REAUDIT** (banner reads open; attendance landed under ADR 0023) | open-questions Q68 |
| Q37 / Q9 / Q38 — assessment, mastery, «ضخ», certificates | **OPEN** — must NOT be invented | register GROUP C |
| Q70 / Q71 / Q72 — attendance operations/automation/reporting | **OPEN** | register GROUP G |
| Q6 — parent messaging, quiet hours | **OPEN** | register GROUP A |
| **Q50 Policy A–E** — enrollment ↔ membership & derived capabilities | **RESOLVED (as NO)** — owner decided enrollment neither creates nor removes membership; membership stays explicit; membership ≠ admin capabilities; modules stay separate (Sprint 32) | **ADR 0035**; register §20 |

Reconciliation note: the Q50 enrollment-membership / derived-capability question (ADR 0034, deferred
pending owner decisions A–E) is now **answered** — the owner decided to keep the concepts separate
(**no** auto-membership, **no** derived capabilities): ADR 0035 supersedes ADR 0034's open status. The
governance gates ADR 0034 cited (Q40/Q36/Q35/Q69, ADR 0015/0016) were already resolved. Nothing was
built; the existing design already enforces the decision and is regression-tested. **Q50 is now fully
resolved** (link = ADR 0033; separation = ADR 0035).

---

## 9. Operational-evidence register (implementation ≠ operational proof)

| Claim | What is proven | What is NOT proven |
| --- | --- | --- |
| LiveKit media | Real LiveKit 1.13.7 server + real WebRTC in **Chrome** with **fake** devices (CI job + Live E2E run 38254959768); screen-share via Xvfb | real-device capture/publish; full transient reconnect/media/ICE recovery (recorded `fullRoomRecovery=false`) |
| LiveKit server deploy (`infra/`) | compose/config committed, pinned, config-checked | TURN, Docker-at-runtime, production TLS, public NAT traversal (CONFIGURED, NOT VERIFIED) |
| Capacity ladder (P8) | harness + fleet design; a 2–3-participant on-box driver validation; a 2-participant smoke | **no capacity rung (100/300/1k/3k/5k/10k) executed**; no result artifacts; 3k/10k targets unproven |
| Deploy-pages workflow | web static build + Pages deploy succeeds | **not** production backend/DB/auth; not production behavior |
| Push notifications | pipeline + logging provider | real APNs/FCM delivery to a device |
| Attendance read scale | functional record+view, CI | EXPLAIN-at-scale on 1M entries |
| Academic seed (ADR 0015) | verified in-memory | no seed run against a production/shared DB |

---

## 10. Acceptance criteria for remaining milestones

- **P7b-native:** real on-device (Android+iOS) capture, publish, and remote reception recorded in a
  mobile CI run; ADR 0030 condition 4 satisfied.
- **P8:** each rung executed off-box, 3 runs, invariants hold, stop-on-failure respected, results filed;
  capacity config derived from measured knees; Q26/Q57/Q65 updated.
- **P11:** outbox + broker + Redis RL + reconciler leases implemented; multi-instance tests show no
  duplicate reactions and every-instance relay delivery; built on P8 evidence.
- **P10-push:** real provider delivers to a device; preferences honored.
- **Q50-derive:** owner answers A–E; membership-`source` and grant-`source` migrations land; a
  `CommunityAcademicSync` projects idempotently; manual memberships and independent grants are preserved;
  revocation never strips an independently-justified authorization.
- **Product loop (C/D/G):** owner policy per group; ADRs; then bounded implementation.

---

## 11. Recommended next action

**The correct next step is an OWNER DECISION, not engineering.** No new product loop — and no part of
Q50-derive — is implementable without inventing policy, which is forbidden. Engineering-only items are
either external-resource-gated (native, push, P8 hardware) or blocked on P8 evidence (P11).

**Decision sheet to put to the owner (smallest set, greatest unlock):**
- **GROUP C/D/G** product policy and **GROUP A** residue (Q6) — gate the educational loop (progress,
  assessment, mastery, assignments, operations) and parent messaging. This is now the highest unlock.
- **P8 deferral** — decide whether to lift "defer until real users" and authorize a capacity run (operational, needs hardware).
- *(Q50 A–E is now decided — ADR 0035 / register §20 — and is off the list.)*

If instead an **operational** test is wanted next, the only CI-executable one is re-dispatching
`live-e2e.yml` (web, real LiveKit); the P8 ladder and native media need real hardware/devices and must not
be claimed from CI. **Definition of done for Sprint 31 (this task): the master roadmap exists, is
evidence-grounded, and the checkpoint/register are consistent with HEAD — no product code changed.**

---

## 12. Change log & reconciled discrepancies

**Sprint 32.** Recorded the owner's membership/capability policy (A–E) in
[ADR 0035](architecture/decisions/0035-community-membership-governance-separation.md) (supersedes ADR
0034's open status) and register §20; marked **Q50 fully resolved** (enrollment-sourced membership &
derived capabilities decided **NO** — not built, by owner decision). Added one regression test
(enrollment *ending* removes no explicit membership). No product feature code / schema / migration /
contract / capability changed — the existing design already enforces the policy. No governance conflict
found (ADR 0016 dec 11, 0032, 0033, 0034 all preserved this separation).

**Sprint 31.** Created this file. Synchronized `project-checkpoint.md` (stale HEAD/CI block) and
`owner-decision-register.md` (compiled line + Q50 gate reconciliation). Recorded, and where the file is
not protected, corrected, these discrepancies found between planning docs:

- **Checkpoint header was stale:** `HEAD 8b88f92` (Sprint 21) / "reconciled Sprint 22" while actual HEAD is
  `144ab15` (Sprint 30); its CI-evidence block cited `8b88f92`/`76e8e48` only; its body had been patched
  through Sprint 30 (ADR 0033/0034). **Fixed** the header + CI block this sprint.
- **Flutter test-count conflict:** register "1238", checkpoint "1394"; actual verified = **1405** (Sprint 29)
  Flutter / **3807** backend jest (Sprint 30). Reconciled in the checkpoint.
- **owner-decision-register** compiled at `143147a` (pre-Sprint-30). **Updated** the compiled line + ADR 0034 note.
- **`communities-live-attendance.md §25` (PROTECTED):** its *committed* text still says Attendance P9 is
  "held"; the authoritative checkpoint says **landed** (ADR 0023). The file's own uncommitted user edits align
  it to "landed". **Not edited** (protected); the authoritative status is here + the checkpoint.
- **`attendance.md` / `academic-reconciliation.md`:** stale "HELD / Nothing here exists" / "open, waiting on
  the owner" banners superseded by ADR 0023 / ADR 0015. **Status banners corrected** (design content preserved).
- **ADR 0023 says "HELD / No code"** (its policy-record state) while attendance was **subsequently built** — the
  code + §25 + checkpoint are the current truth; ADR 0023 remains the immutable *policy* record (not re-edited).
- **No committed CI/load run artifacts** exist; run IDs (verified via `gh`) are the evidence. The P8 ladder is
  **unexecuted** despite the harness existing.
