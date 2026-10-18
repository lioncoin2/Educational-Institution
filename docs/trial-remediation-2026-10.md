# Trial remediation — 2026-10 (design, decisions, acceptance)

**Status:** engineering remediation of the deployed web Trial (`https://trial.adlink4.com`,
release `a8500a9`), prepared 2026-10-18. Implemented as an **uncommitted patch** on top of
`a8500a9` + the owner's working-tree changes; nothing here is committed, pushed or deployed.
This file is the single record of the remediation: what was found, why, what changed, what
needs the owner, how to deploy it and when the Trial counts as accepted. It opens **no**
product decision; every unresolved policy point is a decision record in §5.

Authoritative rules applied: `ENGINEERING_RULES.md` (§7 authorization, §11 security, §15 DoD,
§16 ADR discipline). The previous acceptance audit (2026-10-17) was treated as input and
re-verified against the code; its findings are confirmed except where noted.

---

## 1. Baseline

| Item | State |
| --- | --- |
| Repository / branch | `lioncoin2/Educational-Institution`, `claude/trial-integration-sprints-52-61`, HEAD = origin = `a8500a9f9dede6d8aa319ab7840ec2acc536fb44` |
| CI on HEAD | run 39047171460 success (backend + Postgres 271 suites, real-LiveKit 12 suites, Flutter) |
| Owner changes (protected) | 18 status entries = 20 paths: 10 modified (`app/.gitignore`, `app/pubspec.lock`, `app/pubspec.yaml`, `backend/src/platform/health/health.controller.ts`, `docs/architecture/{communities-live-attendance,observability,open-questions}.md`, `docs/{owner-decision-register,project-checkpoint,project-roadmap}.md`) and 10 untracked (`app/config/trial.env.example`, `app/integration_test/*` ×2, `app/test/integration/live_backend_flows_test.dart`, `app/test_driver/integration_test.dart`, `backend/src/platform/health/health.controller.spec.ts`, `backend/test/integration/community-chat-moderation-realtime-postgres.spec.ts`, `infra/compose.trial.yaml`, `scripts/trial/{README.md,local-backend.sh}`); sha256 of each recorded before work and re-verified after |
| Work method | an isolated `git clone --shared` at HEAD with the 20 owner files copied in unchanged (baseline tree `1425916…`); all edits and tests there; the owner's tree and index never touched |
| Baseline tests (HEAD + owner changes) | backend non-PG: 3,891 passed, 1 failed (`scrypt-password-hasher` timing assertion — passes alone, flakes under parallel load: environmental), 399 skipped (PG); Postgres integration: 26/26 suites, 398/398; Flutter: analyze clean, 1,557 passed, 1 skipped (owner's live-backend test without fixture) |

## 2. Findings and root causes

| ID | Finding | Root cause (evidence) | Impact |
| --- | --- | --- | --- |
| F1 | Trial API ran `NODE_ENV=development` on the internet | fake media was only reachable through the development secret (`live.module.ts` `rtcProviderFor`); `development` disables every secret/DB check (`app-config.ts` `isDeployed`) | a missing secret would silently become a published default (session forgery); the values happened to be strong (non-revealing check 2026-10-17: both 54 bytes, distinct) |
| F2 | Every Trial client had the same IP | `TRUST_PROXY` unset behind nginx (`compose.trial.yaml`); `readTrustProxy` read garbage as `false` | per-IP limits (sign-in 30/5 min, password 20/15 min) were one limit shared by all users: one person could lock everyone out of signing in |
| F3 | **Process crash on a dropped connection (new)** | a pooled client checked out (e.g. a transaction) has no `error` listener; pg emits `error` when its socket dies → uncaught exception (found by the new readiness suite; reproduced with the message-retention sweeper's transaction; negative control fails without the fix) | any Postgres restart or network drop during a transaction ended the whole API process |
| F4 | Readiness pinged a pool in db-less boots | owner's DB check (uncommitted) keyed on the pool object, which `AppModule` always provides | a db-less development boot answered 503; harmless in deployed envs (DB required) |
| F5 | Readiness probes could hold many pool slots | each public probe checked out its own client for up to 2 s | a probe burst during a slow DB takes connections from real traffic |
| F6 | Supervisors received every account's email | `users.read` (SUPERVISOR, provisional) returned `identifiers` unconditionally (`identity/api/responses.ts`) | conflicts with ENGINEERING_RULES §11 and the intent of Design X; no owner decision approved it |
| F7 | Web tokens persisted in `localStorage`, key beside them | Sprint 19 bound `SecureTokenStore` on web; `flutter_secure_storage_web` 2.1.1 defaults; no CSP | any injected script can read the 30-day refresh token; contradicts committed Q17 text — **owner decision D-2** |
| F8 | No HSTS/CSP/XFO/nosniff/Referrer-Policy; versions disclosed; no Cache-Control | Trial nginx server block has none (`/etc/nginx/sites-enabled/trial.http.conf`) | clickjacking/sniffing/XSS hardening absent; stale mixed builds possible |
| F9 | CORS refused PATCH | `configure-app.ts` method list omitted it; 5 routes use PATCH | any cross-origin web deployment breaks preference toggles and academic edits (Trial is same-origin) |
| F10 | **Cross-account state on a shared browser (new, broader than reported)** | `conversationListProvider`, `conversationMutesProvider` (kept alive, no session watch); `institutionRepositoryProvider`/`learningRepositoryProvider` ignore the session, so the kept-alive `studentProvider`, `pathProvider`, `currentHalaqaProvider`… on always-mounted tabs (`StatefulShellRoute.indexedStack`) survive sign-out | after A signs out and B signs in on one tab, B sees **A's name** on «حسابي», A's path/enrolments, A's conversation list and mute set (proven by failing tests before the fix) |
| F11 | Expired-session dead ends | feature error views showed «انتهت الجلسة. سجّل الدخول من جديد.» with only a retry that cannot succeed; signed-out «حسابي» showed «تعذّر عرض المحتوى» | user stuck after expiry or a deep link |
| F12 | Teacher directory showed page 1 only | `teacherSearchProvider` never passed a cursor | teachers beyond the first 50 matches unreachable |
| F13 | Not-found test mis-targeted | `navigation_test.dart` asserted the episode screen's empty state | router's `_RouteNotFound` untested |
| F14 | Test gaps | no HTTP tests for `POST /auth/password`, `DELETE /auth/sessions/:id`, access expiry; no migration-0021 test; role-entry visibility untested; message moderation over HTTP/PG existed only in the owner's uncommitted spec | regressions undetectable |
| F15 | Rejected Quiet Hours still live in the API | Sprint 35 code (ADR 0036) remains: `PATCH /notifications/settings`, `GET/PUT /notifications/institution-settings`, push suppression consults it | the rejection is settled and is **not** reopened; this remediation changes nothing about Quiet Hours — the documentation conflict is recorded in §6 |
| F16 | DM button for ineligible teachers | client cannot know eligibility; server deliberately reports unknown and ineligible alike (anti-probing) | UX only (server refuses) — design decision **D-6** |
| F17 | "Prototype — interfaces only" copy | `app_config.dart` `stageLabel`, `web/index.html` description | misleading on a real-backend Trial — **owner decision D-5** |

## 3. Design and implementation (authorized work)

Each item: required behaviour → change → compatibility → tests → rollback. All changes are in
the remediation patch; none changes a role grant, a permission, a migration or product policy.

### A. Configuration and secrets (F1, F2) — ADR 0037 (Proposed)
- **Required:** a deployed Trial refuses to boot with a missing, whitespace, placeholder, short
  (<32 bytes, counted in bytes) or reused secret, a missing `DATABASE_URL`/`REDIS_URL`/`TRUST_PROXY`;
  the fake media provider is chosen explicitly and never in production; error text names the
  setting, never its value.
- **Change:** `NodeEnv` gains `trial` (deployed); `LIVE_MEDIA_PROVIDER=fake` (refused in production;
  no LiveKit settings demanded when declared); `TRUST_PROXY` required in deployed envs, malformed
  values refused everywhere; `rtcProviderFor` binds the declared fake first.
- **Deployment file:** `infra/compose.trial.environment.yaml` layers the three settings onto the
  owner's `infra/compose.trial.yaml` (left untouched); the merged environment was validated with
  `docker compose config` and booted by the new configuration (dummy secrets, no container).
- `LIVE_MEDIA_PROVIDER=fake` is accepted in staging (only production refuses it), as ADR 0037
  states; the owner may tighten that.
- **Compatibility:** staging/production already set `TRUST_PROXY` and `LIVE_MEDIA_PROVIDER=livekit`
  (verified on the running staging container: variable names and these two non-secret values only).
  The Trial's environment must change with the image (§8).
- **Tests:** `app-config.spec.ts` (new trial block + proxy cases), `livekit-config.spec.ts` (trial
  among deployed envs), `live.module.spec.ts` (fake for a declared trial; refused in production).
- **Rollback:** previous image + previous environment (both kept).

### B. Readiness and database resilience (F3, F4, F5) — builds on the owner's change
- **Required:** liveness dependency-free; readiness = bounded DB ping, 503 standard envelope naming
  only the dependency; no ping when no DB is configured; bounded pool use under probe bursts; the
  process survives a connection lost mid-transaction.
- **Change:** owner's `health.controller.ts` kept; added `APP_CONFIG` (optional) to skip the ping
  when `database.configured` is false, and single-flight probes. `database.ts`: a per-client
  `error` listener on pool `connect`. Redis: not checked — no Redis client exists in this build
  (verified), so there is no dependency to report; `REDIS_URL` stays required when deployed.
- **Tests:** owner's unit spec + 4 new cases; `database.spec.ts` (checked-out client error);
  `test/integration/readiness-postgres.spec.ts` (real pool via a TCP relay: healthy, gone, hung
  with 20 concurrent probes, recovery, crash regression — negative control verified).
- **Rollback:** code-only.

### C. CORS (F9)
- `CORS_METHODS` (adds PATCH) used by `configure-app.ts`; an architecture test pins it to the
  methods the routes serve (no unused method); `cors.api.spec.ts` preflights PATCH, still refuses
  foreign origins. No origin added.

### D. Account identifiers (F6)
- **Required:** no reader without `users.manage` receives login identifiers; enforced server-side;
  no permission or grant changed.
- **Change:** `identity/application/admin/account-views.ts` (`AccountViews`) is the one place that
  decides; every account-administration use case builds its view through it; `identifiers: null`
  means withheld (not "none"). Flutter: `AdminAccount.identifiersWithheld` + «معرّف الدخول متاح
  لمن يدير الحسابات فقط».
- **Compatibility:** the deployed web client already parses `identifiers: null` as an empty list.
- **Tests:** `provisioning.spec.ts` (supervisor vs admin), `identity.api.spec.ts` (supervisor list
  and detail without any email in the body; owner sees them; supervisor can administer nothing),
  `admin_accounts_screen_test.dart`.

### E. Browser hardening (F8) — proposed, tested, not applied
- `infra/nginx/trial.security-headers.conf`: HSTS (ramped: 1 day, then 1 year), nosniff,
  `X-Frame-Options DENY`, Referrer-Policy, COOP, Permissions-Policy, and a CSP with
  `script-src 'self' 'wasm-unsafe-eval'` (no inline/eval script), `style-src 'self' 'unsafe-inline'`
  (required: the Flutter engine injects a `<style>` element), `connect-src 'self' wss://trial.adlink4.com`,
  `frame-ancestors 'none'`, and `https://fonts.gstatic.com` in `font-src`/`connect-src` (the
  engine's font-fallback source for glyphs the bundled fonts lack — emoji, other scripts; found by
  the adversarial review; self-hosting via `fontFallbackBaseUrl` would remove that third-party
  origin and is an app change not made here); plus `server_tokens off`, `proxy_hide_header X-Powered-By`,
  `Cache-Control: no-cache` for the (non-hashed) web files.
- **Evidence:** the deployed build (`main.dart.js` 8487849a…) served locally by nginx 1.24 with
  these headers, headless Chrome 155: 12 signed-out routes booted, same-origin API and realtime
  WebSocket succeeded, a fetch from the font-fallback origin was allowed, **0 violations**. Not
  exercised: an emoji actually rendered in a signed-in chat (no signed-in UI drive). Negative controls: without `'wasm-unsafe-eval'` the app
  does not boot (26 violations); without style `'unsafe-inline'`, engine `<style>` refused.
- Applying it is the gated deployment step N in §8.

### F. Product correctness (F10–F14)
- **Account switch:** the four providers above, and `sessionsProvider`, watch
  `sessionUserProvider.select(id)` (the established pattern). The adversarial review then showed
  two deeper leaks, both fixed: (1) a request **in flight** when the account changed (a quiet
  resync, a next page) still landed in the new account's list, because the notifier and its `ref`
  outlive a rebuild — every build now moves an epoch and each answer is applied only if its build
  is current (conversation list, mute set, teacher search, unread count); (2) Riverpod keeps the
  previous account's value inside a rebuild's loading/error state, and updates were computed from
  it (a read receipt or a mute toggle could resurrect A's inbox or mute set for B) — updates and
  the conversation/path screens now read only settled data (`asData`), and a mute toggle is refused
  until the account's set is loaded. Tests: `account_switch_test.dart`,
  `learner_account_switch_test.dart`, `sessions_account_switch_test.dart` (negative controls
  verified).
- **Sign-in recovery:** `SignInPrompt.needsSignIn/forError` recognise
  `identity.authentication_required` from every feature exception and are wired into the
  teacher, student, academic-admin, admin, notification-settings and sessions screens; the «حسابي»
  header shows nothing (not a failure) when signed out. A real failure keeps its retry.
  Tests: `sign_in_recovery_test.dart` (negative control verified).
- **Teacher directory:** `TeacherSearchController` (keyset pages, dedupe, failure keeps items,
  retry); load-more row in the picker. Tests: `teacher_directory_paging_test.dart`.
- **Tests added:** corrected not-found test (+ the episode case kept, renamed); role-entry
  visibility (`profile_entries_test.dart`); `session-lifecycle.api.spec.ts` and
  `session-expiry.api.spec.ts`; migration 0021 upgrade test.
- **Not changed, by instruction or decision:** no Home «حلقاتي» shortcut (owner declined); the
  prototype copy (D-5); DM eligibility pre-check (D-6).

## 4. Requirements → code → tests

| Requirement | Code | Tests | Verified |
| --- | --- | --- | --- |
| Deployed Trial fails closed on secrets/DB/Redis/proxy | `platform/config/app-config.ts` | `app-config.spec.ts`, `livekit-config.spec.ts` | unit |
| Fake media only by declaration, never in production | `app-config.ts` `readMediaProvider`; `live/live.module.ts` | `live.module.spec.ts` | unit |
| Liveness independent of dependencies | `platform/health/health.controller.ts` | `health.controller.spec.ts`; `readiness-postgres.spec.ts` | unit + PG |
| Readiness bounded, safe 503, no leakage, bounded pool use | same | same | unit + PG |
| Process survives a lost in-use connection | `platform/database/database.ts` | `database.spec.ts`; `readiness-postgres.spec.ts` | unit + PG (neg. control) |
| CORS serves every used method, no more | `platform/http/configure-app.ts` | `cors.api.spec.ts`; `architecture/authorization.spec.ts` | API + arch |
| Identifiers only to `users.manage` holders | `identity/application/admin/account-views.ts` | `provisioning.spec.ts`; `identity.api.spec.ts` | unit + API |
| Password change ends other sessions; current kept; throttled; nothing echoed | (existing) `change-password.use-case.ts` | `session-lifecycle.api.spec.ts` | API |
| Session revoke self-scoped, immediate, indistinguishable 404 | (existing) `session-management.use-cases.ts` | `session-lifecycle.api.spec.ts` | API |
| Access expiry, refresh rotation, replay ends session | (existing) identity | `session-expiry.api.spec.ts`; `identity.api.spec.ts` | API |
| No cross-account client state | `app_providers.dart`; messaging controllers | `account_switch_test.dart`; `learner_account_switch_test.dart` | Flutter |
| Sign-in offered when the session is gone | `features/auth/sign_in_prompt.dart` + screens | `sign_in_recovery_test.dart` | Flutter (neg. control) |
| Role entries shown exactly per permission | `features/profile/profile_screen.dart` (unchanged) | `profile_entries_test.dart`; `teacher_workspace_test.dart` | Flutter |
| Teacher directory pages | `messaging/state/teacher_search_provider.dart`, sheet | `teacher_directory_paging_test.dart` | Flutter |
| Unknown URL → router not-found page | `app/router.dart` (unchanged) | `navigation_test.dart` | Flutter |
| Migration 0021 additive, no FK/default/index | `drizzle/0021_*.sql` (unchanged) | `communities-migrations.spec.ts` | PG |
| CSP compatible with the build | `infra/nginx/trial.security-headers.conf` | local nginx + Chrome harness (§3E) | browser, local |
| Authenticated journeys on the Trial | — | **not run** (needs D-1) | **NOT VERIFIED** |

## 5. Owner decisions required (decision records)

Each open record below is the owner's to decide (D-7 is withdrawn — settled, see §6); nothing has been decided or
implemented beyond what §3 states.

### D-1 — Authorize the authenticated Trial smoke test
Exact actions needing approval: sign in with the synthetic Trial accounts (student, teacher,
owner) on desktop Chrome and iPhone Safari; open «حلقاتي»/record/teaching/roster; start one
student→teacher DM and send one message; toggle mute on that conversation and back; change and
restore nothing else. These write to the Trial database (a conversation, a message, a mute row,
sessions). **Without D-1 no runtime journey is verified and the Trial cannot be accepted.**

### D-2 — Web token storage (Q17)
Current: persistent `localStorage` with the key beside the ciphertext (F7). Options:
(a) keep persistence, accept the residual XSS risk behind the strict script CSP (§3E) — no code;
(b) `sessionStorage` (`WebOptions(useSessionStorage: true)`): survives reload, not a new tab or a
closed browser; still script-readable during the session — small code change, sign-in more often;
(c) memory-only (Q17's original stance): reload signs out — UX regression of Sprint 19;
(d) httpOnly `Secure; SameSite=Strict; Path=/api/auth` refresh cookie on `/auth/login|refresh` for
web, access token in memory, CSRF defence (SameSite + Origin check + custom header), body
tokens unchanged for native — the documented eventual answer (authentication.md §9), a new
backend+client contract and ADR. Recommendation: (a) now with the CSP, (d) as the designed target.
Existing sessions: (a) none; (b)/(c) one re-sign-in; (d) one re-sign-in after the switch.

### D-3 — Supervisor access to the account directory (Q1)
Implemented narrowing (§3D) is safe either way. Open: should SUPERVISOR keep `users.read` at all
(list names/status/roles), and should ENGINEERING_RULES §11 be amended to state the one exception
(account administration, `users.manage` only)? A rule change is a dedicated owner-approved change.

### D-4 — Trial acceptance criteria and release format
The only written criterion (roadmap §5 row TRIAL) demands an installable APK/iOS build. Decide
whether a **web** Trial is acceptable on the criteria proposed in §7, and whether APK/iOS is a
separate later gate.

### D-5 — Trial product description
Replace «نموذج أولي — واجهات فقط» (`app_config.dart` `stageLabel`; `web/index.html` description;
the profile "interfaces only" card) with wording the owner confirms.

### D-6 — DM eligibility before offering the button
The server reports unknown and ineligible counterparts alike on purpose (anti-probing). A
pre-check needs either a messaging eligibility query (a new endpoint that could be used to probe —
must be relationship-scoped) or academic carrying a messaging fact (a new cross-module edge →
ADR). Both are architecture decisions; until then the server's refusal is shown as a message.

### D-7 — withdrawn: Quiet Hours is not a decision
Quiet Hours was **rejected by the owner** (roadmap §8). That decision is settled and is not
reopened — not by this remediation and not as an option for later. No owner decision is requested
about it; the number D-7 stays only so that earlier references remain stable. This patch neither
removes Quiet Hours nor changes its behaviour. What remains is a conflict between the documents
and the code, recorded in §6.

### D-8 — Nginx headers and Trial redeploy
Approve applying §3E and deploying the patch per §8.

## 6. Quiet Hours — settled rejection and the conflict it leaves (no change made)

**Settled:** the owner rejected Quiet Hours (roadmap §8, Q6 row). It is not pursued, not reopened,
and not changed by this remediation. Per-conversation **mute** is a separate, accepted feature and
is untouched.

**The conflict (recorded, not resolved here):**

| Record | What it says today |
| --- | --- |
| `docs/project-roadmap.md` §8 (owner's working copy) | Q6 quiet hours **REJECTED / OUT OF SCOPE**; code remains, not surfaced, not built upon |
| `docs/project-roadmap.md` at the committed HEAD | no mention of the rejection |
| `docs/owner-decision-register.md` §21 | "owner decisions, implemented (Sprint 35)" — no rejection recorded |
| `decisions/0036-quiet-hours-and-conversation-mute.md` | Status `Accepted`; no superseding ADR |
| Code | `GET/PATCH /notifications/settings`, `GET/PUT /notifications/institution-settings` reachable (signed-in / `settings.manage`); `push-suppression.ts` consults the quiet-hours evaluator (push is a stub, so nothing is delivered either way) |
| Register §24 (scheduling, confirmed) | reuses the `isValidTimezone()` IANA rule and `institution_notification_settings` as the home of the institution timezone |

So the settled decision is written down in one uncommitted place only, while the accepted ADR, the
register and the code still describe a live feature. Bringing the **records** into line with the
decision already taken — a register entry and a status line on ADR 0036 pointing to a superseding
record — is documentation of the owner's decision, for the owner to sign. Any change to the
**code** residue is outside this remediation's authorization and would be its own, separately
scoped change, which must also respect the §24 dependency above.

## 7. Proposed Trial acceptance criteria (for D-4)

The web Trial is **accepted** only when all hold, each with recorded evidence:
1. Release identity: deployed web and API built from one committed SHA; CI green on it.
2. Configuration: API boots as `NODE_ENV=trial`, `LIVE_MEDIA_PROVIDER=fake`, `TRUST_PROXY=1`;
   boot line shows the declared fake; a non-revealing secret check passes.
3. Health: `/api/health/live` 200; `/api/health/ready` 200 with `checks.database: ok`.
4. Headers: §3E headers present on `/` and `/api/`; 0 CSP violations across the signed-out routes.
5. Authenticated journeys (D-1) pass on desktop Chrome and iPhone Safari: sign-in/out; student
   «حلقاتي» + record; teacher workspace + roster + history; student→teacher DM with a message
   delivered in realtime; mute toggled and restored; password change and session list/revoke on a
   dedicated test account; sign-out then a second account sees nothing of the first.
6. Authorization spot checks: student cannot reach admin/academic-management APIs (403); no
   response seen in the journeys carries another person's email.
7. Isolation: staging containers and data unchanged; Trial DB migrations = the release journal.
8. Rollback rehearsed or documented with the exact backups in place.
APK/iOS installability, real media, push delivery and capacity are **out of** this web gate.

## 8. Deployment plan (requires D-8; nothing here has been executed)

**Preflight:** owner applies the patch and commits it (one focused commit or grouped commits);
CI green; build web + API from a `git archive` of that SHA (never the dirty tree); new image tag
`institution-api:trial-<sha>` (never rebuild `institution-api:latest`, staging uses it);
backups: `pg_dump -Fc` of trial-db, the current web dir, the current image id; no migration is
part of this release (none added). The Trial environment comes from
`infra/compose.trial.environment.yaml` (`NODE_ENV=trial`, `LIVE_MEDIA_PROVIDER=fake`,
`TRUST_PROXY=1`), layered with `-f` after `infra/compose.trial.yaml` and before the image override;
the secret file is not edited. Preflight check: `docker compose … config` shows the three values,
and a non-revealing secret check (lengths/flags only) passes.
**Rollout:** (1) recreate only `trial-api` with the new image and environment
(`up -d --no-deps trial-api`); (2) confirm the boot line `media provider: fake
(LIVE_MEDIA_PROVIDER=fake)`, no `ConfigurationError`, and `/health/ready` 200; (3) swap the web dir by two renames; (4) add the header snippet to the Trial
server block, `nginx -t`, graceful reload.
**Post-deploy verification:** criteria 2–4 and 7 of §7 (GET/HEAD/OPTIONS only), then D-1.
**Rollback:** API — `compose up --no-deps trial-api` with the previous image override and
**without** `compose.trial.environment.yaml` (the previous image does not know `trial`); web — swap dirs back; nginx — remove the include, `nginx -t`, reload (HSTS
already sent remains in browsers for its max-age — hence the 1-day ramp).

## 9. Independent adversarial review (2026-10-18)

Two reviewers, each on a private copy, neither the implementer: backend and Flutter.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| FE-1 | High | In-flight conversation resync/next page landed in the next account's inbox | fixed (build epoch); regression tests |
| FE-2 | Medium | Updates computed from Riverpod's retained previous value (list, mutes, path screen) | fixed (`asData`; mute toggle refused until loaded); tests |
| FE-3 | Low | `sessionsProvider` did not follow the account | fixed; test |
| FE-4 | Low | Teacher-search next page: non-refusal error left the spinner; stale page after rebuild | fixed (`on Object`, epoch); tests |
| FE-5 | Info | Mute provider retried a refusal with backoff | `retry: null` |
| FE-6 | Info | Same in-flight pattern in the unread-count loop | fixed (epoch, own-slot clearing) |
| FE-7 | Low | Test gaps (per-account data, `onReturn`, withheld detail) | tests added |
| BE-1 | Medium | Architecture index stale (CI red) | regenerated |
| BE-2 | Medium | Trial compose still `development`; changing NODE_ENV alone would not boot | `infra/compose.trial.environment.yaml` |
| BE-3 | Low | Expiry spec flaky (1 s token lives 0–1 s) | 3 s tokens, 4.2 s wait |
| BE-4 | Low | Idle connection failure logged twice | client listener defers to the pool while idle; test |
| BE-5 | Low | CSP would block font fallback | `fonts.gstatic.com` allowed; re-tested |
| BE-6 | Info | Stale comment (`livekit-config.ts`), docs gaps | fixed |

Reviewers found **no** authorization bypass, secret fallback, identifier leak or grant change; their
negative controls (identifiers always shown, single-flight removed, client listener removed, the
four session watches reverted) each failed the corresponding tests.

### Strict review and fixes (2026-10-18, second pass)

| # | Finding | Resolution | Proof |
| --- | --- | --- | --- |
| C1 | D-7 presented the rejected Quiet Hours as an open decision | D-7 withdrawn; §6 records the settled rejection and the conflict only; register §25 and roadmap index updated; no code touched | doc review |
| C2/C3 | patch entangled with the owner's uncommitted work; one 79-file change | split into eleven groups (§10); G01–G09 independent of the owner's work | §11: G01–G09 on pure HEAD green; G01–G11 on HEAD + owner reproduce the tree |
| C4 | ADR 0037 accuracy and status | kept `Proposed` (the README defines Proposed as "nothing implemented" and acceptance as the user's); production claim corrected; staging-fake and unused LiveKit defaults stated; README note on the unmerged implementation | doc review against code and `infra/env/*.example` |
| C5 | path test did not guard the screen fix | `test/learning_path/learning_path_account_switch_test.dart` (screen-level); the provider-level path test removed | negative control: fails without the fix, passes with it |
| C6 | sign-in wiring untested on five screens | `test/auth/sign_in_recovery_screens_test.dart` (teacher workspace, account directory, academic structure, notification settings, device sessions) | negative control: 5/5 fail with the screens reverted, 5/5 pass |
| C7 | owner's roadmap line rewritten | restored verbatim; note added beside it; `observability.md` edits also made additive | owner docs: 0 removed lines |
| R1 | log de-duplication relied on pg-pool internals, tested only with a stand-in | real-pool test `test/integration/database-connection-loss-postgres.spec.ts`; it found a lost in-use connection logged **twice** (pg emits 57P01 then "terminated unexpectedly") — now once per connection | negative control: 2 lines without the guard, 1 with it |
| R2 | teacher-directory next page swallowed defects (`on Object`) | refusals → retry state; anything else → retry state **and rethrown** | `teacher_directory_paging_test.dart` |
| R4 | timing-sensitive tests | no change: no failure observed in any run since the teardown fix (readiness suite: 3 runs alone, 4 full parallel Postgres runs) | — |

## 10. Separating the patch from the owner's uncommitted work (plan; nothing staged or committed)

The patch was built on HEAD `a8500a9` **plus** the owner's 20 uncommitted paths. It is split into
eleven groups, one concern each; applied in order (G01→G11) on HEAD + the owner's changes they
reproduce the patched tree file for file, and G01–G09 also apply to **pure HEAD**.

| Group | Concern | Depends on the owner's uncommitted work? |
| --- | --- | --- |
| G01 | database connection loss (crash fix + real-pool tests) | no |
| G02 | Trial environment (`trial`, declared fake, `TRUST_PROXY`) + ADR 0037 + `compose.trial.environment.yaml` | code: no. The compose file layers on the owner's **untracked** `infra/compose.trial.yaml`; ADR 0037 must be accepted first |
| G03 | CORS PATCH | no |
| G04 | login identifiers only for `users.manage` (backend + Flutter; the identifier hunks of the two admin screens) | no |
| G05 | account isolation in Flutter | no |
| G06 | sign-in recovery (incl. the sign-in hunks of the two admin screens) | no |
| G07 | teacher directory paging | no |
| G08 | test-only gaps (HTTP session lifecycle/expiry, migration 0021, not-found) | no |
| G09 | proposed browser headers (`infra/nginx`) | no |
| G10 | readiness additions | **yes** — builds on the owner's uncommitted `health.controller.ts` and `health.controller.spec.ts` |
| G11 | documentation | **yes** — edits five owner-modified docs and cites register §23–§24 and roadmap §8, which exist only in the owner's working copy |

Safe order: G01–G09 may be committed on HEAD in that order, each as its own commit with the
architecture index regenerated in the commit that changes its inputs and the gates of §15 green
for that state. G10 and G11 wait until the owner has committed their own readiness work and
documentation (their decision and their commit); they are then applied on top. If the owner does
not commit that work, G10 is rebuilt on HEAD's dependency-free readiness and G11 is rewritten
against the committed docs — nothing of the owner's is copied into a remediation commit.

## 11. Verification record

Last run (2026-10-18, second pass) — frozen copies, disposable local Postgres 16; Flutter on the
snapshot taken after the last Flutter change:

| Gate | Patched tree (HEAD + owner + patch) | Pure HEAD + G01–G09 (separability) |
| --- | --- | --- |
| `npm run verify` (format, lint, typecheck, depcruise, jest) | exit 0 — 249 suites passed, 28 skipped (Postgres, below); 3,948 passed, 407 skipped; 443 modules, 0 violations | exit 0 — 248 passed, 26 skipped; 3,935 passed, 400 skipped |
| `npm run arch:index:check` / regenerate | exit 0 | regenerated index identical to the patch's |
| Postgres integration (`--maxWorkers=3`, `POSTGRES_REQUIRED=1`) | 28/28 suites, 406/406 tests | 26/26 suites, 399/399 tests |
| `flutter analyze --no-pub` | no issues | no issues |
| `flutter test --no-pub` | 1,595 passed, 1 skipped (owner's live-backend test without its fixture) | 1,595 passed |
| Negative controls | C5, C6 (×5), R1 fail without their fixes | — |

Earlier in the first pass the readiness suite's teardown could exceed its hook timeout under
parallel load; fixed then (the relay drops hung connections, and closes first). The pre-existing
`scrypt-password-hasher.spec.ts` timing assertion failed once under load in the baseline and has
passed since; it is not part of this patch. Not run: the real-LiveKit suites and `live-e2e` (no
media code changed), load runs, the browser CSP harness in this pass (it ran in the first pass),
and anything against the real Trial (needs D-1/D-8).
