# Project checkpoint — Educational Institution

**This file is the continuity source.** A fresh Claude Code conversation should read this first (then the
authoritative docs it links) and continue without reconstructing history from chat logs.

> **Before continuing, verify reality.** `git -C /opt/Educational-Institution rev-parse HEAD`,
> `git status --porcelain`, and the latest CI for that SHA. This checkpoint is accurate as of the SHA
> below; treat anything it says as needing re-confirmation against current source, tests and
> `docs/owner-decision-register.md` (the roadmap authority). **Every decision here is CURRENT and
> REVERSIBLE** — a current institutional decision, not a permanent architectural lock.

## Project identity

A single-institution platform for the Global Institution for Teaching the Noble Quran: a NestJS
modular-monolith backend (Postgres/Drizzle, LiveKit) and a Flutter/Riverpod app (web-first; `android/`
and `ios/` exist but are never built by CI). The app runs in two modes from one composition root
(`app/lib/providers/app_providers.dart`): **backend mode** when `API_BASE_URL` is set (real HTTP + realtime
+ secure storage), and **demo/mock mode** otherwise (the GitHub Pages build and widget tests, entirely
in-memory). Product scope is the owner's; engineering never invents institutional policy.

## Repository state (verify before trusting)

- **Branch:** `claude/quranic-education-app-prototype-gkzle8`
- **HEAD:** `144ab15` — `Sprint 30: Q50 enrollment-sourced membership & derived capabilities — investigated,
  stays OPEN`. **In sync with `origin`** (0 ahead / 0 behind at the time of writing).
- **Latest work, newest first:** Sprint 30 Q50 enrollment-membership/derived-caps investigated → deferred,
  ADR 0034 (`144ab15`); Sprint 29 Q50 halaqa existence validation + Flutter link/unlink UI (`c6f48e9`);
  Sprint 28 Q50 link / Q22 member-list / Q31 roster (`54204f9`); Sprints 24–27 people discovery + ADR 0032
  (`42507b3`…`03fd925`); Sprint 22 checkpoint (`f67c4f6`); Sprint 21 attachments/voice (`8b88f92`); Sprint 20
  LiveKit web activation (`76e8e48`); Sprint 19 secure sessions (`89a8879`); before that the live-media
  programme. Full verified ledger (SHAs + CI run IDs): [`docs/project-roadmap.md §4`](project-roadmap.md).
  Use `git log --oneline` for the authoritative history, not this file.
- **Date reconciled:** 2026-10-13 (Sprint 31 — documentation-only roadmap reconciliation; no product code changed).
- **Preserved local working-tree changes (do NOT overwrite):** four owner-maintained files remain modified
  and intentionally uncommitted — `backend/src/platform/health/health.controller.ts` (+ its new
  `health.controller.spec.ts`, a DB-readiness probe, observability.md §3), `docs/architecture/observability.md`,
  and `docs/architecture/communities-live-attendance.md`. A future engineer must not `git checkout`,
  `reset`, `clean` or `stash` them away. (This checkpoint file is itself committed by Sprint 22.)

## Engineering principles (standing)

**Mandatory: every implementation task MUST read and obey [`docs/ENGINEERING_RULES.md`](ENGINEERING_RULES.md)
before writing any code.** It is the permanent, project-wide governance (clean/modular architecture,
domain/application/infrastructure boundaries, SRP, dependency direction, contract-first vertical slices,
non-vacuous architecture tests, authorization ownership, error taxonomy, migration discipline, security,
observability, ADR discipline, Definition of Done). It is authoritative; this checkpoint's reversible
decisions never override it. The required workflow (no step skipped): **INSPECT → UNDERSTAND ARCHITECTURE
→ IDENTIFY RESPONSIBILITY OWNER → IDENTIFY DEPENDENCY BOUNDARIES → PLAN FILES → DEFINE CONTRACTS → DEFINE
TESTS → IMPLEMENT → VERIFY → REVIEW DIFF → UPDATE DOCS/ADR IF REQUIRED → COMMIT.** File-size guide:
100–300 preferred, 300–500 ok, 500–700 review, >700 decompose, >1000 prohibited unless justified. Never
silently invent institutional rules — record unknowns as deferred.

## Authoritative documents (read these)

- **Engineering governance (read first, obey always):** [`docs/ENGINEERING_RULES.md`](ENGINEERING_RULES.md).
- **Master roadmap & status (Sprint 31):** [`docs/project-roadmap.md`](project-roadmap.md) — the
  authoritative, evidence-grounded phase/status matrix, sprint ledger, incomplete-work inventory, critical
  path, and next action. This checkpoint is the current-state continuity source; the roadmap is the
  consolidated status map.
- **Roadmap / owner-policy authority:** [`docs/owner-decision-register.md`](owner-decision-register.md) —
  every unresolved owner decision, grouped A–G, cross-referencing `open-questions.md` and the ADRs. This
  checkpoint links and summarizes it; it does not replace it.
- **Product spec:** [`docs/prototype-spec.md`](prototype-spec.md).
- **Navigation:** root [`CLAUDE.md`](../CLAUDE.md) + the generated
  `docs/architecture/architecture-index.md` (code-derived; regenerate `cd backend && npm run arch:index`;
  ADR 0031). Phase roadmap tables: `docs/architecture/communities-live-attendance.md` §25.
- **Open questions (answers inline):** `docs/architecture/open-questions.md`.
- **ADRs:** `docs/architecture/decisions/` — esp. **0015** (academic reconciliation), **0016** (Q40),
  **0023** (attendance authorization), **0024/0025** (P10 notifications), **0026–0029** (P12 live/moderation
  policy), **0030** (Flutter LiveKit media client), **0031** (architecture index), **0032** (discovery ≠
  membership ≠ authorization ≠ attendance — owner/admin-only `GET /people`, community-scoped member search),
  **0033** (Sprint 28: optional community–halaqa link as inert metadata; conversation member-list is
  owner/admin-only; teacher roster is current students only),
  **0034** (Sprint 30, **Deferred**: Q50 enrollment-sourced membership & derived capabilities stay
  OPEN — policy unapproved + two model gaps; design ready). Table: `.../decisions/README.md`.
- **Live-media verification log:** [`docs/p8-live-media-verification.md`](p8-live-media-verification.md).
  **Messaging/attachments + client dependencies:** [`docs/architecture/messaging.md`](architecture/messaging.md),
  [`docs/architecture/live.md`](architecture/live.md) §17.

---

## Implementation status (classified)

Classifications: **Implemented+verified** · **Implemented, partially verified** · **Implemented but
unverified on target platform** · **Mock/stub** · **Owner-decision-gated** · **External-resource-gated** ·
**Unsupported by current contract**.

| Area | Status | Notes |
| --- | --- | --- |
| Authentication & identity; persistent sessions | **Implemented+verified** (native keystore unverified) | Sprint 19 — see below |
| Communities & membership | **Implemented+verified** | lists, roster, keyset pagination, lock/unlock, join-by-link, leave, invitations, remove, grant/revoke/transfer, server-authoritative `me`; optional academic `halaqa_id` link (Sprint 28 inert metadata + Sprint 29 real cross-module existence validation via academic's `ACADEMIC_RELATIONSHIPS` contract and Flutter link/unlink UI gated on `me.canManageHalaqa`; `communities.manage` oversight; migration 0021; ADR 0033 / register §17–§18) |
| Conversation member-list visibility | **Implemented+verified** | Sprint 28 — owner/admin-only (`users.manage`), server-side in `ListParticipantsUseCase`, all conversation types (Q22; ADR 0033) |
| Teacher roster = current students | **Implemented+verified** | Sprint 28 — `ListHalaqaStudentsUseCase` refuses non-ACTIVE status without `academic.manage`; admins keep history (Q31; ADR 0033) |
| People directory & member add/re-add; student↔student & student↔teacher DMs | **Implemented+verified** | GROUP A (register §12–§16; ADR 0032); `people.read` (owner/admin only, migration 0020), community-scoped `member-candidates` on `community.members.invite`, `messaging.start_direct_peer`/`_teacher` (migrations 0018/0019) |
| Text messaging, moderation, cross-client delete | **Implemented+verified** | send/history/pagination/read-unread/catch-up; moderation delete + 7-day review (ADR 0029); the `messaging.message.deleted` realtime hint |
| Message attachments & voice notes (image/PDF/voice) | **Implemented, partially verified** (web; native/real-device unverified) | Sprint 21 — see below |
| Live-session control plane (hands, moderation roster, presenter grants, kick, reset) | **Implemented+verified** | P12; HTTP control plane, server-authoritative |
| Live media (join/mic/screen on web) | **Implemented, partially verified** | Sprint 20 — activated on web; see below |
| Attendance (record + view) | **Implemented+verified** (EXPLAIN-at-scale deferred) | backend write/view + full Flutter surface; ADR 0023 |
| Notifications & preferences | **Implemented+verified** (push delivery external-gated) | list/read/badge/preferences/device-registration; P10 translators (ADRs 0024/0025) |
| Academic **read** stack | **Implemented+verified** | catalog/profile read surfaces only — NOT the learning loop |
| Progress, assessment, mastery/promotion, certificates, assignments, announcements/feed, owner operations | **Owner-decision-gated** | NOT implemented as a product loop; policy must not be invented — register groups C/D/G |

**Backend-mode vs demo/mock.** The composition root selects HTTP/realtime/secure-storage/real-media
implementations in backend mode and in-memory mocks otherwise. The GitHub Pages demo is mock mode and does
**not** represent a connected backend: attachments are stored in-memory and render as placeholders, live
media stays Unavailable, and sessions are not persisted server-side.

---

## Sprint 19 — Secure persistent sessions (`89a8879`)

`tokenStoreProvider` = backend-mode ? `SecureTokenStore` : `InMemoryTokenStore`. `SecureTokenStore`
(`app/lib/data/api/secure_token_store.dart`, `flutter_secure_storage` 11.2 confined to that one adapter)
persists `{accessToken, refreshToken}` so a signed-in device survives a cold restart; restoration flows
through the existing lazy `sessionUserProvider → currentUser() → /auth/me` (no new state machine), with a
generation guard so a slow restoration can't overwrite a newer sign-in/out. A keystore failure raises
`TokenStorageException` (fails closed, **never a silent downgrade to insecure storage**), never logging
tokens. **Verification:** Dart logic unit-tested on the VM against a fake keystore; the full suite + web
build pass. **Not verified here:** actual iOS Keychain / Android Keystore runtime (device-only; Android
needs `minSdk ≥ 23`), and web browser storage is weaker than a native keychain.

## Sprint 20 — LiveKit media activation on web (`76e8e48`)

`liveMediaClientProvider` binds the real `LiveKitLiveMediaClient` **iff** `backendMode && kIsWeb &&
BackendConfig.liveMediaEnabled` (`--dart-define=LIVE_MEDIA_ENABLED=true`); every other case (demo, non-web,
flag absent, VM tests) falls closed to `UnavailableLiveMediaClient`. One client is constructed in that one
provider (one room owner) and disposed with it; no UI changed (the panel was already seam-driven). The
`livekit_client` adapter stays confined to `app/lib/data/media/livekit/` (ADR 0030). Server-authoritative
join tokens (`/join`) and presenter authorization are unchanged. **Verified:** a production-composition
Live E2E (`test/e2e/livekit_app_composition_e2e_test.dart`) selects the real client through the app's own
providers and drives a real join → room → mic publish/mute → live presenter grant/revoke → leave
(live-e2e.yml, green). **Do NOT describe live media as unavailable** — it is wired under its documented
activation config. **Retained limitations (accurate):** full transient reconnect/media/ICE recovery is
**NOT verified E2E** (reconnecting-*entry* was induced + verified in the diagnostic workflow, Sprint 18);
large-scale **capacity not load-tested**; **native iOS/Android live media out of the approved contract**;
interactive screen-picker and real device permission prompts are manual checks.

## Sprint 21 — Message attachments & voice notes, web-first (`8b88f92`)

The whole attachment pipeline (the `OutgoingFile` model, the 3-step signed upload declare→PUT→complete,
image/voice/file sends, optimistic retry by `clientMessageId`, conversation-history rendering, signed-link
authenticated download) **was already implemented and tested**; Sprint 21 supplied the three device-seam
implementations and bound them. `deviceMediaSupportedProvider` (`kIsWeb`) binds `FilePickerAttachmentPicker`
(`file_picker`, images jpg/png/webp + PDF), `RecordVoiceRecorder` (`record`, Opus→WebM `audio/webm`) and
`JustAudioVoicePlayer` (`just_audio`), each confining its plugin import to one adapter
(`app/lib/data/media/{pickers,voice}/`, enforced by `test/messaging/attachment_boundaries_test.dart`); off
web they fall closed to Unavailable. **Backend contract (verified, unchanged):** `POST /files/uploads`
(perm `files.upload`) → ticket → `PUT` bytes (signed, no bearer) → `POST /files/uploads/:id/complete`
(verifies size + **magic bytes vs declared content type**) → `POST /messaging/conversations/:id/messages/
{image,voice,file}` `{clientMessageId, fileAssetId, caption?}` → `GET …/attachments/:id/link` → short-lived
signed Range-capable download. **Policy:** IMAGE jpeg/png/webp 10MB; VOICE mp4/aac/ogg/webm 5MB/10min;
DOCUMENT pdf 25MB. Authorization stays server-authoritative; recorder/player release on dispose; a
generation guard protects against a stale stop. **Not CI-verified (no device in CI):** real file selection,
real microphone capture + WebM encoding, audio playback — manual/browser checks. **Native out of scope.**

---

## Academic structure — CURRENT DECISIONS (reversible)

**Hierarchy: `Section → Program → Halaqa`.** Program is first-class and **kept**. **Level: RETIRED /
SUPERSEDED** — the `Section → Program → Level → Halaqa` model was rejected by the owner; all Level
sub-decisions are REVOKED (see "Level status" — nil code impact).

**Seven official core sections** (official names; order 1–7 is display only, not a study sequence):

| # | Official name | Code | Note |
| --- | --- | --- | --- |
| 1 | محو الأمية | `dep-literacy` | count 5 → **10** |
| 2 | تلقين الحروف | `dep-letters` | |
| 3 | المبتدئ | `dep-tajweed-1` | = old قسم تجويد مبتدئ |
| 4 | **تجويد الحروف** | **`dep-tajweed-letters`** | **NEW**, owner-approved code |
| 5 | التجويد المتوسط | `dep-tajweed-2` | |
| 6 | التجويد المتقدم | `dep-tajweed-3` | |
| 7 | دورة التهجي وإعداد المعلمات | `dep-tahajji` (proposed) | uniform model; see Tahajji |

Owner rulings: every core section has **≥ 10 halaqat** (10 = initial minimum, not a limit); **no
Basic/Additional classification**; **"need" not used**; sections/halaqat are **dynamic, owner-managed**
(add/edit/delete/rename/reorder); **halaqa codes / historical identity preserved**; deletion must be
historically safe. **Academic progression (assessment→placement→mastery→higher progression), the broader
development path, and «نظام الضخ بين الأقسام» are institutional concepts only — do NOT invent promotion
criteria, mastery thresholds, assessment formulas or mandatory sequences.**

- **Tahajji / City of Tahajji — RESOLVED (uniform model):** same `Section → Program → Halaqa` model; a
  Tahajji "group" is an academic halaqa (not a chat/LiveKit/community construct); core section #7
  (`dep-tahajji`, reversible); dynamic, owner-managed; nothing seeded beyond the reconciliation. Existing
  `sec-spelling` (قسم التهجي) left as dynamic owner data. Voice/LiveKit-mapping stays deferred.
- **Non-core sections — RESOLVED (dynamic owner data):** `sec-kids` (البراعم), `sec-languages` (اللغات),
  `accompanying` (البرامج المرافقة, incl. مدينة الحفاظ) are dynamic owner-managed data, not architectural
  decisions; kept; no "core" flag. Not a question to re-open.

### Level status: NOT IMPLEMENTED
No `academic_levels` table, no `level_id`, no Level domain/contract/repository/API/Flutter code, no
migration. The only trace is the word "levels" in two `academic.*` permission *descriptions* in
`drizzle/0002_seed_access_catalog.sql` — cosmetic, non-structural; an optional later description fix (via a
new migration, never editing an applied one), not blocking.

### Academic Reconciliation: LANDED (Option A — split sources)
Printed Profile stays separate and untouched (`institution-structure.json`/`.ts`, Flutter `ProfileData`,
`profile_structure_test.dart`). The seed reads a separate **operational** source
(`operational-structure.json/.ts`, 11 sections / 11 programs / 70 halaqat, 10 per core program) with
`owner`/`profile` provenance (ADR 0015) and enforced parent/integrity + per-entry halaqa codes. Verified
in-memory only; **no seed run against a production/shared DB**. Deploying via the explicit seed command is
a separate operational step, intentionally not done.

---

## P9 Attendance — policy & status (ADR 0023)
Owner answers recorded in `open-questions.md` and enforced by the landed backend: **Q8** (owner controls
amendments + window; `reason` + `amendedBy`); **Q12** (every live session + every exam; actual date/time;
no calendar prerequisite); **Q69a** (authority uses **both** academic relationship **and** community
standing — Option B: the academic layer is additional and conditional on an established academic↔community
link, of which there is none, so community standing governs; Q50 untouched); **Q69b** (owner controls
record/view grants; "Collect Attendance" during a broadcast creates the snapshot; **no student/parent
self-view**; notifications landed in P10). Backend (RecordSnapshot write + 3 view routes, `AttendanceAccess`,
`LIVE_PRESENCE`, Postgres + in-memory, boundary guards) and the **full Flutter surface** (record + viewing,
connection-filter + session-scoped UIs) are landed and tested. **Deferred (by decision):** the
EXPLAIN-at-scale / 1M-entry read benchmark (§21/§22, measure before production use) and the formal ADR 0023
Option-B write-up (a documentation task).

## P12 Policy-gated Live features — COMPLETE (ADRs 0026–0029)
Four owner-approved slices, policy answered, backend + Flutter surfaces landed: **Q64** kick/room-reset
(ADR 0026 — authority via existing `community.live.moderate`/`.host`, no ban, re-entry allowed, optional
audit-only reason); **Q59** no hidden listeners (ADR 0027 — `hidden` enforced-`false` invariant + drift
backstop); **Q56** screen sharing up to **two** concurrent presenters (`MAX_CONCURRENT_PRESENTERS = 2`, DB
compare-and-set under the session lock; owner/moderator/teacher by right, a student only under an explicit
session-scoped delegated grant; screen audio off); **Q51/Q23** community message moderation (ADR 0029 —
`community.messages.moderate` soft-deletes a tombstone, original reviewable 7 days then purged; moderation
is not chat read; CHANNEL conversations only; migration 0017). The moderation Flutter surfaces (live roster;
message delete/review) and the cross-client `messaging.message.deleted` realtime hint are implemented.

## P8 capacity — DEFERRED
Off-box ladder (S1/S2/R1…R6) deferred until real users. Targets (**not proven**): ≈3,000 listeners/room,
≈10,000 concurrent participants across rooms. Do not reopen P8.4 S1/S2 unless explicitly requested
(`docs/p8/*`, `docs/p8-load-capacity-plan.md`).

---

## Owner-decision-gated & incomplete product areas
The authoritative, grouped list is [`docs/owner-decision-register.md`](owner-decision-register.md).
Summary (do NOT invent answers):

- **GROUP A — people directory & membership (received & reconciled, register §12–§16):** the
  institution-wide directory `GET /people` is **owner/admin only** (supervisors/teachers lost `people.read`,
  migration 0020); community member discovery is the **community-scoped** `GET /communities/:id/member-candidates`
  gated per community on `community.members.invite` (Sprint 24, Design X, register §15). Member add/re-add
  (`community.members.invite`), student↔student DM
  (`messaging.start_direct_peer`, migration 0018) and student↔teacher DM (`messaging.start_direct_teacher`,
  migration 0019, `GET /people/teachers`) are **IMPLEMENTED**. **Still owner-blocked:** parent messaging,
  quiet hours (Q6).
- **GROUP B — community lifecycle:** archive (Q47), delete (Q47 / ADR 0016 — no delete route by design,
  FKs RESTRICT), a separate channel entity / group→channel nesting (Q36 — ADR 0016 rejected a `kind`
  field), app-side create-community (`POST /communities` exists but OWNER/ADMIN-only, Q41 PROVISIONAL),
  edit/rename metadata + a description field (ADR 0016 decision 3, title-only) — all **blocked**.
  **Messaging edit** is unbuilt everywhere (only a reserved `editedAt`); out of scope until approved.
- **GROUP C — academic progression, assessment, mastery, certificates (Q37/Q9/Q38):** **must NOT be
  invented.**
- **GROUP D — assignments & submissions:** no phase, no ADR — gated.
- **GROUP E — notifications delivery & push provider (Q24/Q27/Q28/Q65):** real push delivery is
  **external-resource-gated** (Firebase/Apple/device); academic notification facts and guaranteed delivery
  (outbox/T2) are deferred policy.
- **GROUP F — live media binding & capacity (Q57/Q65/P7b/P8/P11):** web binding is **done** (Sprint 20);
  native and capacity remain gated (below).
- **GROUP G — attendance-record/operations/automation/reporting (Q70/Q71/Q72/Q68):** policy + dependency
  gated. Note the register's corrections: Q36 resolved (ADR 0015) and Q67 resolved (ADR 0024); this repo's
  **Q11 is "localization," not "operations recurrence"** (operations is gated by Q70, not Q11).

**Engineering available without an owner decision (if prioritised):** the ADR 0023 Option-B write-up; the
cosmetic `academic.*` "levels" description fix (new migration). **IMPLEMENTABLE_NOW feature work = none**
(building more would invent policy).

## External-resource gates (not owner policy)
- Real push delivery — Firebase/Apple credentials + a device (Q65).
- P7b **native** (iOS/Android) media/attachments/recording — physical devices + a mobile CI/signing
  pipeline (none exists); bound Unavailable off-web.
- P8 off-box load/capacity testing.
- EXPLAIN-at-scale read benchmark — a large seeded dataset.

## Known technical limitations & unverified behavior
- LiveKit **full transient reconnect/media/ICE recovery** NOT verified E2E (reconnecting-entry verified).
- **Native** live media / attachments / recording unimplemented on-device; bound Unavailable off-web.
- **Real browser** file picking, microphone capture + WebM encoding, and audio playback are not exercised
  by CI (no device) — manual checks.
- Web browser secure storage ≠ a native keychain; iOS Keychain / Android Keystore runtime unverified here.
- EXPLAIN-at-scale attendance read benchmark not run.
- `GET /health/ready` DB probe: its 2 s timeout releases-with-error but does not cancel the in-flight SQL
  (pg has no in-flight cancel) — documented in observability.md §3 (a preserved file).

---

## CI / E2E / deployment evidence
Per-SHA run IDs for the whole Sprint 19–30 ledger are in [`project-roadmap.md §4`](project-roadmap.md);
current HEAD and the latest two below.
- **CI** run `38329854598` @ `144ab15` (Sprint 30) → **success** — jobs Backend, Backend — real LiveKit,
  Flutter app. **Deploy Pages** run `38329854602` @ `144ab15` → **success**. (Sprint 29 @ `c6f48e9`: CI
  `38323027472` / Deploy `38323027465`, both success.)
- **Live E2E** (real LiveKit) run `38254959768` @ `76e8e48` → **success** (production-composition + the
  2-/3-client, screen-share, reset, session-end harnesses), on **web/Chrome with fake media devices** — not
  device validation. Dispatch/scoped-PR only (not on-push); last run for `76e8e48`
  (`gh workflow run live-e2e.yml --ref <branch>`).
- Flutter full VM suite = **1405 passed** (@ `c6f48e9`, Sprint 29); backend `jest` = **3807 passed** (@
  `144ab15`, no-PG local run; 22 Postgres suites skipped locally and exercised by CI). Web release build ✓;
  `arch:index:check` up to date. The CI Backend job runs the PostgreSQL integration suites with
  `POSTGRES_REQUIRED=1`, and the real-LiveKit contract job runs the pinned server. **No CI/load run logs are
  committed to the repo** — the run IDs are the evidence. (Supersedes the earlier `8b88f92`/1394 figures.)

## Deferred / open questions (do not guess)
- Voice/LiveKit mapping of educational groups (separate from the academic model).
- Mastery / promotion / assessment / «نظام الضخ» operational rules (institutional concepts only).
- Reviewer acceptance of the combined attendance-scoping design (Q69a, ADR 0023).
- Academic notification facts and guaranteed delivery (outbox/T2) — separate deferred decisions.
- Concrete per-section/per-halaqa seed content beyond the decided renames/new sections — **dynamic owner
  data** managed at runtime, not architectural questions.

## Recommended next phases (and dependencies)
1. **Owner decisions first** — the highest unlock is **GROUP A residue + GROUP B/G policy**; without them
   no new product loop is implementable without inventing policy (register §6 ranks the smallest set for
   the greatest unlock).
2. **Engineering, no owner needed:** ADR 0023 Option-B write-up; the `academic.*` "levels" description fix.
3. **When resources exist (external-gated):** push delivery (Firebase/Apple); native media/attachments
   (devices + mobile CI/signing); P8 load evidence → then P11 horizontal scale; EXPLAIN-at-scale benchmark.
4. **Before any new module:** obey `ENGINEERING_RULES.md`, consult the owner-decision-register, and verify
   actual HEAD + worktree.

> Reminder: everything in this checkpoint is a current, reversible decision. Re-verify HEAD, worktree and
> CI before continuing.
