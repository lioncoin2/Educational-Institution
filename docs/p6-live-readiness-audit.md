# P6 — Live readiness audit

**Community-scoped live sessions: the read-only audit that gates P6.**

- **Repository:** `1f000de` (the post-P5.1 repair). The tree was clean, and no source file changed during
  the audit.
- **Written:** 2026-09-27. Revised the same day after an adversarial challenge (see "Method").
- **Plan (written because this audit passes):** [`p6-live-implementation-plan.md`](p6-live-implementation-plan.md).

**Verdict: P6 READINESS: PASS.**

- **No stop condition is unresolved for what P6 builds.** P6 needs no new policy, no new identity
  permission or Communities capability, no change to an existing Communities rule, and no vendor type
  above the adapter.
- **Three conditions apply:**
  - the scope reconciliation in §2;
  - the engineering decisions in §16, including the fail-closed binding of real media (D19);
  - the items listed in §17, which the user may overrule at review. Each is shown in §17 not to need a
    decision for P6.

## How to read it

**Paths.** Paths are repo-relative, with `backend/src/modules/` shortened to `live/`, `communities/`,
`identity/`, `realtime/` and so on. Line numbers are at `1f000de`.

**FACT and ASSESSMENT.** A **FACT** is what code or an approved document says, with a citation. An
**ASSESSMENT** is this audit's judgement.

**Short names for the sources.**

| Short name | File |
| --- | --- |
| "the design" | [`docs/architecture/live.md`](architecture/live.md), APPROVED 2026-09-23 |
| "the hub" | [`communities-live-attendance.md`](architecture/communities-live-attendance.md) |
| ADR 0017 | [ADR 0017](architecture/decisions/0017-community-scoped-authorization.md), Accepted |
| ADR 0019 | [ADR 0019](architecture/decisions/0019-community-scoped-live-sessions.md), Accepted |
| ADR 0021 | [ADR 0021](architecture/decisions/0021-cross-cutting-rules-for-new-modules.md), Accepted |
| OQ | [`open-questions.md`](architecture/open-questions.md) |
| "the brief" | the user's P6 brief of 2026-09-26 (quoted verbatim where quoted) |

**Method.** Seven independent read-only readers covered:

- the Live code, traced end to end;
- the design and its ADRs;
- the hub and the open questions;
- the Communities contracts;
- the platform conventions;
- the provider boundary and the Flutter seams;
- the tests and the scale.

The draft was then challenged by three skeptics, each trying to refute PASS from one angle: compliance
with the brief, the stop conditions, and security. None found a blocker. A fact-checker verified 132 of
the draft's claims. This revision:

- corrects every error the fact-checker found;
- adopts the skeptics' corrections: D19–D24, the refined D9, and 660 s for D10.

Every finding this decision rests on is restated here with its evidence.

---

## 0. Verdict in one page

**P6 READINESS: PASS.**

### 1. No policy is invented

Every rule P6 enforces is written down, either as a decision or as a PROVISIONAL default in an approved
or accepted document, tied to its open question (§6).

The brief itself sets the test for such defaults. On LOCKED it says to stop only "if Q46 or another
unresolved policy controls this and **the current backend does not establish a safe answer**". Q46's
answer is enforced in code today (`communities/domain/lifecycle.ts:15-79`).

The other defaults are the recorded answers the design was "built so … can proceed" on (hub §24; OQ
preamble). The counter-text is acknowledged: building a default "answered nothing" (OQ). Each question
stays open, and P6 keeps each answer in one place, so an institutional answer is one edit.

One default is expensive to reverse after P9: a "yes" to Q60 (OQ:2043-2046). It needs nothing in P6, and
it is listed in §17.

### 2. Nothing new is needed in identity or Communities policy

- No identity permission and no Communities capability is added.
- Communities gains two additions that **ADR 0017 accepted for P6** (decisions 3 and 6):
  - `COMMUNITY_AUTHORIZATION.permittedAmong`, which runs the same evaluator in batch;
  - the derived act `community.live.remain`, with `community.live.join`'s ceiling and basis, gated by
    the existing `runningLiveContinues` effect.
- Neither changes an existing act row, lifecycle row, grant, migration or response (§7, row 14).
- Identity loses the provisional rule `host-only-moderation` (ADR 0017 decision 10). The brief requires
  it: "A delegated capability must work through the same server-side evaluator", and the rule vetoes every
  delegate.

### 3. The provider port is complete, and real media stays off

- The port already has the design's full shape (`live/domain/rtc-provider.ts:135-189`), with a
  deterministic fake and one LiveKit adapter.
- P6 adds no port method, installs nothing and does not edit the adapter. No LiveKit type can leak.
- P6 changes how the provider is **bound** (D19). Real media is used only when explicitly enabled
  (`LIVE_MEDIA_PROVIDER=livekit`), which the LiveKit-integration phase will turn on together with its
  hardening. Without it:
  - a deployment with real credentials binds a disabled provider;
  - Start answers 503 `live.media_unavailable` with nothing stored;
  - the reconciler's ticks are skipped.

  This implements the brief's "Prefer a fake provider in P6", "Do not integrate real LiveKit" and "failure
  is explicit". Development and tests keep the fake.

### 4. The brief and the design conflict on scope and phasing, never on policy

The brief is the later instruction and settles each conflict (§2):

- the real-LiveKit hardening moves to the LiveKit-integration phase, recorded as a dated amendment note on
  ADR 0019;
- the backend realtime hints move into P6 (the brief's P6.7);
- the design's routes, event names and state machine stand, because the brief says not to follow its own
  candidate lists blindly.

### 5. Nothing in §17 blocks P6

§17 lists what the user may overrule at review. Each item is shown there not to need a decision for P6:

- the pending Q56 confirmation (student screen sharing, which P6 does not build);
- the reading of Q54 for End;
- the fixture location;
- the capacity default;
- the Communities and identity changes;
- the known accepted windows.

---

## 1. Why P6 exists: the gap at `1f000de`

**FACT: the Live module is P1's hardened, halaqa-bound, in-memory module** (`live/domain/live-room.ts:10-29`;
`live/live.module.ts:73-78`). Its state today:

**Nothing can start or end a session.**
- No production code calls `LiveRoomRepository.save` or `LiveSessionRepository.save`.
- `ensureRoom` and `endRoom` have no caller.
- A caller who passes a route's access declaration gets 404 from every route. Anonymous callers get 401,
  and callers without the route's permission get 403 (`test/api/live.api.spec.ts:72-87, 133`).
- The feature runs only in tests that seed its stores (`test/api/live.api.spec.ts:13-18`).

**Authorization is role-wide plus identity's host-only veto.**
- Any holder of `live.join`, which is every role, gets a media token for any session id that exists
  (`live/application/join-live-session.use-case.ts:69-70`).
- Moderation is refused to everyone but the host, including an all-permission OWNER
  (`identity/domain/provisional-policy.ts:149-151`; `live/application/moderate-speaker.use-case.ts:236-240`).

**There is no Community anywhere in Live**, and no call to any Communities contract
(`live/live.module.ts:50` imports only `IdentityModule`).

**Production binds the real adapter, which is dormant only because nothing can start a session.** The
fake is chosen only for the development secret (`live/live.module.ts:35, 58-66`), and production refuses
that secret (`platform/config/app-config.ts:84-92, 149-155`).

**What already holds, and is kept:**
- the security shape of the join token: no request body, a server-chosen identity and a name from the
  directory, one room, explicit sources, no data channel, no metadata, a 120 s time to live
  (`live/infrastructure/livekit-rtc-provider.ts:128-150`);
- the narrow RTC ports;
- the idempotent hand state machine;
- the journal order: audit, then event, never on a repeat.

---

## 2. The brief and the approved design, reconciled

Each "Approved design" cell cites the design's phase table (`live.md` §2) or the hub's P6 row (hub §25).

| Item | Approved design | Brief (verbatim where quoted) | **P6 decision** | Why |
| --- | --- | --- | --- | --- |
| `LiveSession` replaces `LiveRoom`; Postgres; start and end; `LiveAccess`; the host-only rule retired; presenter slot; soft and hard caps; `AppConfig.live` | P6 | the P6 goal | **P6** | Both agree |
| `COMMUNITY_AUTHORIZATION.permittedAmong`, `community.live.remain` | P6 (ADR 0017 decisions 3 and 6) | "If a new permission/capability is genuinely required, STOP and document why"; stop condition 14 | **P6** | Accepted beforehand, and needed (§7, row 14). The grant's target check needs `permittedAmong` whether or not a reconciler exists |
| Reconciler: room sweep, participant sweep, targeted watch, automatic media reset; `ProtectLiveSessions` | P6 | "Define server behavior when: moderator ends the session / Community is locked / moderator loses capability / moderator leaves the Community / moderator is removed / server restarts / provider fails. Do NOT invent automatic behavior where policy is undefined. For infrastructure failures, fail safely and expose explicit state." | **P6, against the RTC port** | Its automatic acts are recorded defaults: Q61 (idle end), Q63 (ineligible expiry, ejection, the media reset), Q5 (the record wins). ADR 0021 decision 4 makes the participant sweep the **required backstop** for `communities.member.removed`, the one security-class event. It fails safe: it never ejects on unknown state (design §11.3; D23) |
| `LIVE_AUDIENCE`, `LIVE_SESSIONS` contracts | P6 | "leave a clean contract seam so a later Attendance module can observe live participant state"; realtime hints | **P6** | `LIVE_AUDIENCE` feeds the relay (next row); `LIVE_SESSIONS` is Attendance's seam |
| Backend realtime: `LiveRealtimeRelay`, `live.*` frames, coalescing | P7 | slice "P6.7 Realtime integration"; a "realtime hints" test | **P6, backend only** | Pulled forward as the brief suggests. The HTTP reads every frame points to ship in P6, satisfying hub §25's rule for every phase: no phase leaves "a frame without its HTTP reconciliation read". Fixtures: D16 |
| Pinned LiveKit server configuration (`room.auto_create=false`, `enable_remote_unmute=false`, timeouts, no webhooks); the adapter contract suite against a real server in CI | P6 (`live.md:199`; hub:1905; ADR 0019 decision 7 and its consequence at :225-226) | "P6 is NOT the LiveKit integration phase"; "Real LiveKit integration belongs to P7"; "Do not integrate real LiveKit" | **Deferred to the LiveKit-integration phase** | The brief is explicit. A dated note on ADR 0019 records the amendment (plan, commit G). attendance.md's P9 prerequisite on that suite moves with it |
| The `/rtc/validate` self-check (design §9) | P6 (`live.md:813`) | as above | **Deferred** | It probes a real server. Until it exists, D19 keeps Start from reaching a real server at all |
| **Binding real media in a deployment** | the real adapter for any non-development secret (P1's selection) | "Prefer a fake provider in P6"; "P7 will replace/use the real adapter"; "failure is explicit" | **P6: fail closed unless explicitly enabled** (D19) | P6 would otherwise give the production-selected adapter its first callers, without the hardening the design's media-plane finality rests on |
| LiveKit secret hygiene (`LIVEKIT_API_KEY=devkey` accepted; no secret length check) | not in any phase (this audit's finding S7) | — | **P6, enforced only when real media is enabled** (D19) | A configuration check with no server needed |
| `LIVE_PRESENCE` | P9, HELD by Q40 and Q69 | "DO NOT IMPLEMENT ATTENDANCE IN P6" | **Not built** | The seam is `LIVE_SESSIONS`, the `RtcParticipantObserver` port, and End saving `ended` before calling the provider (§12.4) |
| Flutter `LiveRepository`, frame parsing, controller, media | P7 and P7b | "DO NOT build Live Flutter screens in P6 … Only define API contracts needed by future clients" | **Not built** | No Flutter change in P6 |

**Phase names.**

- The brief's "P7/P7b" covers live UI, the LiveKit Flutter SDK and media UI (brief, "Flutter"), as the
  design's P7/P7b do.
- The brief's P7 **also** takes the server-side real-LiveKit integration, which the design put in P6.
- P6's documents therefore say "the LiveKit-integration phase" for the server-side real-LiveKit work, and
  "the Flutter live phase" for the design's P7.

---

## 3. Existing Live architecture (traced)

### 3.1 Inventory and wiring

The module has 29 files and 3,521 lines, with 65 unit cases in 6 suites.

- **Also outside `backend/src/modules/live`:** `test/support/live-harness.ts`,
  `test/api/live.api.spec.ts` (8 cases) and `test/architecture/live-boundaries.spec.ts` (6 cases).
- **No Postgres suite, migration or schema exists** for Live (`backend/drizzle/0000`–`0012`).
- **Only `app.module.ts` imports `LiveModule`.**
- **`LiveModule` imports `IdentityModule` and exports nothing** (`live/live.module.ts:49-87`).
- **The four narrow ports** each `useExisting` the one provider (`:69-72`). `RTC_ROOMS` and
  `RTC_OBSERVER` are bound but never injected.

### 3.2 Routes today (`live/api/live.controller.ts`)

| Route | Access declaration | Decision in the use case |
| --- | --- | --- |
| `POST /live/sessions/:sessionId/join` | `live.join` | role-wide only |
| `POST /live/sessions/:sessionId/hand` | `live.raise_hand` | role-wide only; 201 for a new hand, 200 for an open one |
| `DELETE /live/sessions/:sessionId/hand` | authenticated | the caller's own open request |
| `POST /live/requests/:requestId/grant`, `/decline`, `/revoke` | `live.moderate` | a coarse check, then the host-only check with `ownerUserId` |

No route takes a body. None has a rate limit, `@RequestMetadata()` or `DatabaseUnavailableInterceptor`;
that interceptor is opt-in per controller (`platform/http/configure-app.ts:23`).

### 3.3 The traces the brief asks for

| Trace | FACT at `1f000de` |
| --- | --- |
| Room creation | None. `ensureRoom` exists (`livekit-rtc-provider.ts:97-108`, create-or-update, errors surfaced) with no caller |
| Room joining | Role check → session → room → standing → directory name → token (`join-live-session.use-case.ts:68-109`). No participation check |
| Token creation | HS256 JWT signed by the SDK. `sub` = user id; `name` = directory name; one `roomJoin` grant for the session id; `canPublish` = the explicit sources are non-empty; microphone only for host and speakers; `canPublishData` false; `canUpdateOwnMetadata` false; `hidden` false; no admin grants, metadata or attributes; TTL 120 s (`livekit-rtc-provider.ts:128-150`; spec `:84-122`). The SDK turns a falsy TTL into 6 hours (`node_modules/livekit-server-sdk/dist/AccessToken.js`), so only the pinned constant stands between a configuration slip and a 6-hour token (D24) |
| Speaker promotion | Only from a raised hand: `grantWithinCap`, cap 4, compare-and-set, one moderation record. The provider push goes through `CapabilityConvergence`, reporting `applied`, `not_connected` or `pending`. Repeats → 200 `unchanged`. The target's eligibility is **not** checked (`moderate-speaker.use-case.ts:84-130`) |
| Speaker revocation | `granted → revoked` by compare-and-set, pushed; repeats 200; anything else 409 (`:132-164`) |
| Raise hand | Idempotent: a new hand → 201 and one `live.speaker.requested`; an open hand → 200 and nothing. No provider call; not audited (`raise-hand.use-case.ts:56-87`) |
| Moderation | Grant, decline, revoke. `mute_participant`, `remove_participant` and `end_session` are declared but unused (`live/domain/moderation.ts:13-19`) |
| Display names | Only from `ACCOUNT_DIRECTORY.describe`; `''` if absent (`join-live-session.use-case.ts:92-97`); a sent `displayName` is ignored (`live.api.spec.ts:89-103`) |
| Room persistence | In memory, lost at restart, one copy per process (`in-memory-live-repositories.ts`) |
| Provider abstraction | Vendor-free ports (`rtc-provider.ts`); the rule `livekit-sdk-only-in-the-live-adapter` (`.dependency-cruiser.cjs:121-134`), proven non-vacuous (`live-boundaries.spec.ts:34-44`) |
| Events | `live.speaker.requested/granted/declined/revoked/withdrawn` are published. `live.session.started/ended` exist and are never published. No module subscribes to any `live.*` event (`live/contracts/events.ts`) |
| Authorization | Identity ceilings only, plus the host-only veto (§1) |
| Membership checks | None |
| Token expiry | 120 s. LiveKit refreshes a connected client's token (valid ≥ 10 min) and ignores `revoke_token_ts`, so the TTL bounds only the first connection (ADR 0019 L3–L4) |
| Reconnect | `/join` decides afresh every time and is safe to repeat; a grant survives a reconnect (`join-live-session.spec.ts`) |
| Session state | `scheduled \| live \| ended`, with no transition implemented (`live-room.ts:20`) |
| Room lifecycle | Nothing ends a room; there is no `expired` hand state |
| Failure handling | A provider outage surfaces as `RtcUnavailableError`; moderation reports `pending`. `CapabilityConvergence` re-applies for 12 minutes after each grant, revoke or yield; each change restarts that window, but an observed violation does not extend it, and it never removes anyone. Join reads the account directory, which is database-backed when a database is configured, and no interceptor maps a store failure: a directory failure on join is a 500 today |

---

## 4. Existing defects, and what P6 does with each

Severity: **B** = would block P6 if left; **F** = fixed in P6; **N** = noted, handled elsewhere.

| ID | Sev. | Finding (evidence) | P6 disposition |
| --- | --- | --- | --- |
| D1 | F | Nothing creates or ends a session; every gated route 404s at runtime (`live.module.ts:73-78`) | Start and End, persisted (plan, commits B–C) |
| D2 | F | No lifecycle transitions; session events never published (`live-room.ts:20`; `domain/events.ts:27-48`) | `live → ended`; both events published |
| D3 | F | No `expired` state: hands would outlive their session (`speaker-request.ts:20`) | `expired`; End expires every open hand in one statement |
| D4 | F | Lowering a hand while a grant races leaves the person speaking and answers 409 (`lower-hand.use-case.ts:55-67`) | Lower is a compare-and-set from **either** open state: withdraw, or yield (design §5.1) |
| D5 | F | `role: 'moderator'` means "host holding `live.speak`" (`live-standing.ts:54-60`) | `LiveAccess` decides moderator standing; publishing by right is moderator AND `live.speak` (design §3.6) |
| D6 | F | Moderators cannot list hands (no GET route) | `GET /live/sessions/:id/hands` (keyset, FCFS) |
| D7 | N | The cap counts a host's own granted hand | Design §3.8: moderators publishing by right use no slot. Only granted requests count |
| D8 | F | A grant never re-checks the target's eligibility | 412 `live.target_not_eligible` through `permittedAmong(…, community.live.remain)` |
| D9 | F | Audit in Postgres refers to state held in memory | All state in Postgres (with a database configured) |
| D10 | F | No correlation id; no permit basis in the audit | `@RequestMetadata()`; `{act, basis, membershipId, grantId}` in every moderation audit (design §7.2) |
| D11 | N | An audit failure after a stored change leaves it unaudited | Unchanged platform property: no outbox until P11 (ADR 0021). The journal order is kept |
| D12 | F | Session event payloads carry `roomId` | P6 payloads (design §14); no subscriber breaks |
| S1 | F | Any `live.join` holder gets a token for any session | `community.live.join` permit on the stored `communityId`, or `LiveAccess` |
| S2 | F | Any `live.raise_hand` holder may raise in any session | `community.live.raise_hand` permit |
| S3 | F | Existence oracles: 404 against 200/403/412 | One 404 (`live.session_not_found`, `live.request_not_found`, `live.community_not_found`) for unknown or not visible, on every route (design §15.2, §20; D9) |
| S4 | F | The convergence window restarts on every change but is not extended by an observed violation, and never removes anyone | The reconciler's targeted watch, extended on every violation, plus the media reset (design §11.4; D22) |
| S5 | F | A host who loses `live.speak` keeps publishing until they next join | The participant sweep recomputes capabilities (≤ 60 s) |
| S6 | F | No `ensureRoom` caller, so a real server would auto-create rooms with its defaults | Start is provider-first with `maxParticipants = cap + reserve`. Real media is not bound before its hardening (D19) |
| S7 | F | Provider selected by a duplicated secret literal; `devkey` accepted in production; no secret length check (`app-config.ts:84-92, 210-211`) | D19: explicit opt-in; with it, a placeholder key, a secret under 32 bytes or a missing room prefix refuses boot |
| S8 | N | Empty display name when the directory has none | Kept; no policy says otherwise |
| S9 | N | Every participant sees every participant (`hidden` false) | Q59 PROVISIONAL; unchanged |
| S10 | F | No rate limits on join or raise | The design's limits (`live.md:366`), keyed per user or per (session, user), never per IP |
| C1 | F | The liveness check sits outside the atomic write | Every transition locks the session row first and requires `live` (S4) |
| C2 | F | Atomicity and truth are per process | Postgres invariants (partial unique indexes, CHECKs, compare-and-set) |
| C3–C5 | N | Convergence pushes can land out of order; ticks are sequential; there is a check-then-act window | The level-triggered reconciler corrects the order. The window is accepted as in Messaging (§14) |
| A1 | F | Store failures would become 500 | `DatabaseUnavailableInterceptor`; Communities failures → 503 `unavailable` |
| A2 | F | The fake keeps an append-only room list and a global outage flag: no room lifecycle (ensure is not idempotent, End does not remove, `createdAt` is `new Date(0)`), and no per-operation failures | Fake extended (plan, commit B) |
| A3 | F | The admission mutex is Communities-private | Moved to `platform/concurrency/` as a pure utility (D12) |
| A4–A6, R1–R7 | N | Dead seams, the untested provider selection, unbounded fake buffers, documentation drift | Dead code is removed with `LiveRoom`. Provider selection gets a spec (D19). The fake gets bounded buffers. Documents are corrected in commit G |
| E-D2 | F | The room name is conflated with the session id | `mediaRoomName(prefix, id, epoch)`, used everywhere |

---

## 5. Dependency map

**Today.**

```
app.module ──▶ live ──▶ identity (contracts)
                 └────▶ shared, platform/{config,http}
live/infrastructure/livekit-rtc-provider.ts ──▶ livekit-server-sdk   (the only importer)
```

**After P6.** `A ──▶ B` means A imports B's contracts or module.

```
                    ┌─────────────────────── realtime ──────────────────────┐
                    │ (LiveRealtimeRelay: live/contracts events + LIVE_AUDIENCE)
                    ▼                                                        ▼
app.module ──▶ live ──▶ communities (contracts: COMMUNITY_AUTHORIZATION incl. permittedAmong,
                 │                   COMMUNITY_MEMBERSHIP.heads, COMMUNITY_CAPABILITY_HOLDERS; events)
                 ├────▶ identity (contracts: AUTHORIZATION_SERVICE, ACCOUNT_DIRECTORY, Permissions)
                 └────▶ shared, platform/{config,http,database,concurrency}
communities ──▶ identity                       (unchanged; communities never reaches live)
live/infrastructure/livekit-rtc-provider.ts ──▶ livekit-server-sdk   (still the only importer)
```

**Rules asserted by tests.**
- Live reaches Communities only through `communities/contracts/*` or `communities.module.ts`.
- Communities never reaches Live.
- Live never reaches messaging, realtime, notifications, academic, operations or attendance.
- Realtime reaches Live only through `live/contracts/*` or `live.module.ts`.
- Nothing but the adapter reaches LiveKit.
- Live's `contracts/` reach only `shared/`.
- Module exports are contract tokens.
- No `forwardRef`.

Templates: `test/architecture/messaging-boundaries.spec.ts:101-157`;
`communities-boundaries.spec.ts:74-100`; `live-boundaries.spec.ts`.

**No cross-module database access.** `community_id` and the user ids are plain text columns, with no
foreign key outside Live's own tables (`docs/architecture/persistence.md:26-28`).

---

## 6. Policy assumptions (every one recorded; none introduced by P6)

"Enforced in P6 by" names the code that will carry each rule.

| Policy | Recorded answer | Question | Defined in | Enforced in P6 by |
| --- | --- | --- | --- | --- |
| Who starts | identity `live.moderate` + `community.live.start` (owner implicitly, or a grant); the starter is host | Q54 (first bullet), Q44 | design §7.1; `communities/domain/act-rules.ts:87` | route gate + `authorize` |
| Who moderates (grant, decline, revoke, hands, presenter revoke) | `community.live.moderate`, or the host while `community.live.host` holds; a delegate never acts on the host's own request or presenter grant (403 `live.target_is_host`); no institution-wide override | Q54 (second to fifth bullets); Q1 revised by ADR 0017 decisions 10–11 | design §7.2; ADR 0017 | `LiveAccess` |
| Ending a session | **any session moderator.** Q54's second bullet reads "end and moderate: `community.live.moderate`, or the host while `community.live.host` holds". The hub's End route lists no `target_is_host` refusal (hub:1312), and "other moderators act or end the session" (hub:1499; `live.md:1623`). `live.md:606` groups End with `target_is_host` in one table cell, and that is the only ambiguity | Q54 | OQ Q54; hub §15.4 | `LiveAccess` (D2; listed in §17) |
| Who speaks by right | a session moderator holding identity `live.speak`; uses no speaker slot | Q54 | design §3.6, §3.8 | `capabilitiesFor` |
| Speaker cap and order | 4 granted; FCFS by (`requestedAt`, `id`); no time-based expiry | Q4, Q62 | design §3.7–§3.8 | the session row lock + a count; the keyset index |
| Promotion source | only from a raised hand; no invitation to speak | Q62 | design §5.4 | the state machine |
| Screen share | one presenter slot; a session moderator holding `live.speak`, for themself; no screen audio; no delegation | Q56; **ADR 0019 decision 9 (Accepted)** | design §6 | `LiveAccess` + the slot |
| Sessions per community | at most one live | Q55 | design §4.3 | partial unique index |
| LOCKED | no new start (412); join, rejoin, raise hand and moderation continue; the running session continues (Q46). Presenter changes and End continue **by derivation**: they are moderator acts, and `community.live.moderate`'s gate is `always` and `community.live.host`'s is `runningLiveContinues` (`lifecycle.ts:77-78`) | Q46 | `communities/domain/lifecycle.ts:15-79`; design §7.3 | Communities' permit answers only |
| An unmapped status | no new join; nobody ejected (`runningLiveContinues`) | Q46 | `lifecycle.ts:44-50` | `community.live.remain` |
| Losing standing mid-session | the next command refused at once; hand, floor and presenter grant expire or close as `ineligible`; eviction through the event path and at worst the 60 s sweep; a second violation resets the media room; the host loses moderation and the session continues | Q63 | design §11.3–§11.4 | `ProtectLiveSessions` + reconciler (D21, D22) |
| Abandoned sessions | the system ends one after 900 s observed empty; never for host absence; no maximum duration | Q61 | design §11.2 | the room sweep |
| Provider against the record | the record wins; the reconciler converges | Q5 | design §11.1 | reconciler |
| Capacity | cap 300 + reserve 10 per session, from configuration; 412 `live.session_full` for listeners over the soft cap; no waitlist | Q57; ADR 0019 decision 12 | design §12.2 | the join soft cap + `maxParticipants` |
| Rate limits | start 10/min per user; join 10/min and raise 6/min per (session, user) | the topic is Q26's; the values are the design's (`live.md:366`) | design §3.8 | use-case limiter (D13) |
| Several devices | the newest connection wins; no auto-rejoin | Q60 | design §9 | identity = user id (unchanged) |
| Visibility | roster visible to participants; hands to moderators only; `hidden` false | Q59 | design §3.6 | capabilities + the hands route |
| Retention | Live deletes nothing | Q3 | design §10 | no DELETE path |
| Notifications | none for live facts | Q67 | design §23 | events only |
| Kick, moderator media reset | not built; seams only | Q64 | design §24 | — |

**Prerequisites.**

- **Q40, the governance gate.** The user answered it on 2026-09-23: "Live-session architecture and
  hardening may proceed" (OQ:1381-1400).
- **The hub's other entries for P6.** P2 and P3 have landed. "LiveKit in CI" is removed by the brief's
  re-phasing (§2).

---

## 7. Stop-condition matrix

| # | Condition | Verdict | Evidence | How P6 handles it |
| --- | --- | --- | --- | --- |
| 1 | Community↔Live ownership boundary | **RESOLVED** | Design §3.1: `communityId` is "An opaque Communities id. Always read from this row, never from the client"; the room name is derived from the session, never the reverse. Communities must not know sessions (`communities.md:1638-1642`, §10; `communities-boundaries.spec.ts:74-86`) | `live_sessions.community_id` as plain text; routes under `/live`; `/live/communities/:communityId/sessions` for start and current |
| 2 | Session lifecycle | **RESOLVED** (the system ends: Q61) | `live → ended`; provider-first idempotent start; one-transaction idempotent end; no `scheduled` or `cancelled` state (design §3.2, §4; ADR 0019 decisions 1–4). Idle end: Q61. `community_closed` is reserved (Q47) | Built as designed. CREATED was evaluated and rejected (§8.2) |
| 3 | Who can start | **RESOLVED** (Q54) | §6 | Route `live.moderate` + `community.live.start` |
| 4 | Who can moderate | **RESOLVED** (Q54; ADR 0017 decisions 10–11) | §6 | `LiveAccess`; `PROVISIONAL_POLICY_RULES = []` in the same change (design §7.4) |
| 5 | Who can promote or revoke speakers | **RESOLVED** (Q54, Q4, Q62) | §6. The brief's "Selected students" are selected from the raised hands. Its "…/participants/:userId/promote" is a candidate it says not to copy blindly ("DO NOT blindly implement this exact list"), and it would add an invitation transition Q62 leaves open | `POST /live/requests/:requestId/{grant,decline,revoke}` |
| 6 | Screen-share authorization | **RESOLVED for what P6 builds** | **ADR 0019 decision 9 (Accepted)** settles P6's slot: a session moderator holding `live.speak`, for themself, one at a time, no screen audio, no delegation. The brief requires the teacher and moderator path and calls the participant grant "optionally … depending on the existing policy". P6 builds only the settled part. Q56 records that the design's deferral of a student path, from an earlier design brief's §11, "needs the user's confirmation" (OQ:1922-1926). That confirmation concerns a path P6 does not build | The presenter slot. `PresenterGrant.grantedBy` is kept distinct from `userId` as the seam. Q56 is listed in §17 |
| 7 | One vs several active sessions | **RESOLVED** (Q55) | Partial unique index; a second start returns the running session (design §4.3) | Built |
| 8 | Behaviour while LOCKED | **RESOLVED — the backend already enforces the answer** (Q46) | `lifecycle.ts:15-79`: LOCKED → `liveStartOpen` false, `liveJoinOpen` true, `runningLiveContinues` true; `community.live.moderate` gate `always`; `community.live.host` gate `runningLiveContinues`. This is the brief's own test: stop only if "the current backend does not establish a safe answer" | Live never reads a status; it maps permit refusals (design §7.3). Start racing a lock is an accepted outcome, narrowed by D20 (§14) |
| 9 | A moderator losing membership or capability mid-session | **RESOLVED** (Q63) | Per-request `LiveAccess` (never cached); `ProtectLiveSessions` on `member.removed`, `capability.revoked` and `ownership.transferred`; the participant sweep as backstop (ADR 0021 decision 4) | Built against the port, with the sweep also covering disconnected floor and presenter holders (D21) |
| 10 | Provider contract | **RESOLVED** (the shape by ADR 0019 decision 10; the verification by the brief's re-phasing) | The port equals design §8.1 field for field (`rtc-provider.ts:15-189`); a fake and an adapter implement all four narrow ports. The design required a real-server contract suite in P6 (ADR 0019:225-226); the brief moves real-LiveKit work out of P6 | No port change. Fake fidelity extended. Real media not bound in P6 (D19). ADR 0019 gets a dated amendment note |
| 11 | Persistence model | **RESOLVED** | Design §10: four tables, CHECKs, partial unique indexes, in-module foreign keys only; READ COMMITTED; the session row lock first | Migration `0013_live_sessions.sql`: additive, touching no existing table (§10) |
| 12 | Cross-module dependency boundary | **RESOLVED** | §5; the rules and specs exist; Live → Communities adds no cycle (`communities.module.ts` imports identity only) | Boundary specs extended (plan, commit G) |
| 13 | A policy not already defined by the architecture | **RESOLVED — none needed** | Every rule P6 enforces is in §6. The §16 decisions are engineering choices, or readings of recorded defaults that §16 labels as such (D2, D10, D18) | Written into the plan and the design notes |
| 14 | Anything requiring a change to Communities policy | **RESOLVED — no existing policy changes** | **Accepted beforehand:** ADR 0017 decision 3 (`community.live.remain`) and decision 6 (`permittedAmong`); `communities.md` act table rows "`live.remain` (P6)" (:847, :886); announced in code (`communities/contracts/capabilities.ts:79-84`). **Needed:** under a status this build does not know, `liveJoinOpen` is false while `runningLiveContinues` is true ("Never eject on ignorance", `lifecycle.ts:18, 42-50`); only `remain` keeps the reconciler from ejecting everyone then, and `permittedAmong` is the only principal-less evaluator. **Changes nothing that exists:** no existing act row, lifecycle row, grant, migration or `me` field changes. `remain` adds one row to Communities' PROVISIONAL tables with join's ceiling and basis; it is not a capability and not grantable | The two additions, with tests that pin `remain`'s row and that `permittedAmong` agrees with `authorize` for every act (D3, D4) |
| 15 | Any reason LiveKit SDK types must leak into domain or application | **RESOLVED — none** | The port has no imports; exactly one file imports the SDK; the rule and the spec are proven non-vacuous (`rules-match.spec.ts`) | Unchanged |

---

## 8. Proposed domain model

This is design §3 as built. The one refinement is D22's definition of a violation.

### 8.1 Entities

```
LiveSession   (aggregate root; its row is the lock for everything below)
  id (uuid), communityId (opaque), hostUserId (the starter), state live|ended, stateVersion ≥ 1,
  startedAt, endedAt?, endedBy? (null = system), endReason? moderator|idle|community_closed,
  participantCap, moderatorReserve, mediaRoomEpoch ≥ 0
  ├─1..n SpeakerRequest     pending → granted | declined | withdrawn | expired
  │                          granted → revoked | withdrawn | expired
  ├─0..1 open PresenterGrant (the screen-share slot; closed: stopped | revoked | session_ended | ineligible)
  └─1..n ModerationAction   (written in the same transaction as the change it records)

Derived, never stored: standing → capabilitiesFor(standing) → RtcCapabilities (total)
Infrastructure, never an identity: mediaRoomName(prefix, id, epoch)
```

### 8.2 States considered

- **`CREATED` is not needed.** Start is provider-first: the room is ensured, then the row is inserted as
  `live`, so no pre-live row ever exists. Scheduling is not Live's (Q12). Adding a state later costs one
  CHECK value (design §3.2).
- **The brief's PENDING / APPROVED / DECLINED / CANCELLED become `pending`, `granted`, `declined` and
  `withdrawn`.** Design §5 adds:
  - `revoked`, a moderator taking the floor back, which is distinct from the requester cancelling;
  - `expired`, the system acting (session end, or ineligibility), so the state always says who acted.
- **`LiveParticipant` / `ParticipantGrant` is not an entity.** A participant is observed on the media
  plane, never stored. The only grants are the speaker request itself and the presenter grant. This
  matches the brief's "Do not store transient LiveKit participant state as permanent relational truth
  unless there is a clear domain reason."

### 8.3 Invariants

Design §3.7: S1–S6, R1–R5 and P1–P2. The most important:

- one live session per community (a partial unique index);
- `ended` is terminal (every update is `WHERE state = 'live'`);
- after End commits, no hand, floor or presenter change takes effect (the session row `FOR UPDATE`,
  then `live` is required);
- one open request per (session, user) (a partial unique index);
- at most 4 granted, counted under the session lock;
- at most one open presenter grant (a partial unique index, as a backstop).

### 8.4 Standing and capabilities

Design §3.6, total on every field:

| Field | True when |
| --- | --- |
| `canPublishAudio` | a speaker grant, or a moderator holding `live.speak` |
| `canPublishScreen` | the presenter |
| `canPublishScreenAudio` | never |
| `canSubscribe` | always |
| `canPublishData` | never |
| `hidden` | never |

The camera is never granted. The role shown is `moderator` > `speaker` > `listener`.

### 8.5 Limits

All are PROVISIONAL and live in `live/domain/live-limits.ts` (design §3.8).

| Constant | Value |
| --- | --- |
| Speakers | 4 |
| Presenters | 1 |
| Join TTL | 120 s |
| Sweeps: rooms / participants / watch | 30 s / 60 s / 10 s |
| Enforcement watch | **660 s**, extended on every violation |
| Orphan grace | 60 s |
| Idle end | 900 s |
| Provider room timeouts | 1,200 s |
| Occupancy sample | cached ≤ 2 s |

**From `AppConfig.live`:** `maxParticipantsPerSession` 300, `moderatorReserve` 10 and `roomNamePrefix`.
The two numbers are set by environment variables.

---

## 9. Proposed provider port

**No change.** The port `live/domain/rtc-provider.ts` already has everything P6 calls:

| Port | Methods | P6 callers |
| --- | --- | --- |
| `RtcRoomProvider` | `ensureRoom(spec)` (create or update), `endRoom(name)` (absent means success), `listRooms(names?)` | Start; join's ensure-then-recheck; End; the room sweep; the media reset |
| `RtcTokenIssuer` | `issueAccessToken(grant)` (local signing) | Join |
| `RtcParticipantControl` | `updateCapabilities(room, identity, fullSet)` → `applied \| not_connected`; `removeParticipant(room, identity, {revokeTokensIssuedBefore})`; `muteParticipant` (seam) | Grant, revoke, yield, presenter changes; the reconciler |
| `RtcParticipantObserver` | `listParticipants(room)`, `getParticipant(room, identity)` | The participant sweep and the targeted watch |

**The brief's candidate operations, mapped:**

| Brief's candidate | Port call |
| --- | --- |
| "create session representation" | `ensureRoom` |
| "issue participant token" | `issueAccessToken` |
| "grant/revoke publisher", "grant/revoke presenter" | one `updateCapabilities` with the **full** set. Separate grant and revoke calls would be wrong for LiveKit, where a partial update resets every omitted field (ADR 0019 L6) |
| "end provider session" | `endRoom` |

**The fake** (`live/infrastructure/fake-rtc-provider.ts`) is extended in P6, still deterministic:

- a room registry: idempotent ensure; an end that removes the room; listings of current rooms only;
  `createdAt` from an injected clock;
- per-operation outcomes: ok, unavailable, or a misconfiguration fault;
- a gate to hold a call, for deterministic interleavings;
- a log of every call, reads included;
- removal options recorded;
- capability changes and removals applied to what it later observes;
- bounded buffers for development.

**The disabled provider** (D19) is a new infrastructure class. Every call throws
`RtcUnavailableError`, so Start answers 503 `live.media_unavailable` and the reconciler skips its ticks.

**The LiveKit adapter is not edited.** P6 binds it only when `LIVE_MEDIA_PROVIDER=livekit` is set, which
the LiveKit-integration phase enables together with:
- the pinned server configuration;
- the contract suite against a real server;
- the `/rtc/validate` self-check.

---

## 10. Proposed persistence model

**Migration `0013_live_sessions.sql`.** It creates four tables owned by `live` and **touches no existing
table**: it is additive. It is forward-only per `persistence.md:92-93`. The brief's "reversible where
practical" holds in the sense that dropping the four new tables undoes it.

| Table | Key columns | Constraints and indexes |
| --- | --- | --- |
| `live_sessions` | `id` PK; `community_id`, `host_user_id`; `state` (`live`, `ended`); `state_version`; `started_at`, `ended_at`, `ended_by`, `end_reason`; `participant_cap`, `moderator_reserve`, `media_room_epoch`; reconciler bookkeeping `empty_since`, `enforcement_violations`, `last_violation_at` | CHECKs linking state, `ended_at` and `end_reason`; `end_reason = 'moderator' ⇒ ended_by`. **UNIQUE `(community_id) WHERE state = 'live'`**. `(community_id, started_at DESC, id DESC)`; `(started_at, id) WHERE state = 'live'` |
| `live_speaker_requests` | `id` PK; `session_id` → `live_sessions` (RESTRICT); `user_id`; `state` (six values); `requested_at`, `granted_at`, `decided_at`, `decided_by` | CHECKs: `decided_at` null ⇔ `pending`; `decided_by` null ⇔ `pending` or `expired`; `granted ⇒ granted_at`. **UNIQUE `(session_id, user_id) WHERE state IN ('pending','granted')`**. The FCFS keyset `(session_id, requested_at, id) WHERE pending`; `(session_id) WHERE granted`; the watch index on `decided_at` |
| `live_presenter_grants` | `id` PK; `session_id` →; `user_id`, `granted_by`, `granted_at`, `ended_at`, `ended_by`, `end_reason` | CHECK: `ended_at` null ⇔ `end_reason` null. **UNIQUE `(session_id) WHERE ended_at IS NULL`**; `(session_id, ended_at)` |
| `live_moderation_actions` | `id` PK; `session_id` →; `actor_user_id` (null = system), `target_user_id`, `type` (ten values), `at`, `reason_code` | `(session_id, at, id)` |

**Rules the model keeps:**
- No participant, presence or token table.
- No foreign key into Communities or identity.
- Nothing deleted (Q3).
- Mock mode keeps in-memory twins behind the same ports, chosen by `config.database.configured`, as
  Communities and Messaging do (`communities/communities.module.ts:77-95`).

**Transactions and locks** follow design §10.2:
- provider calls happen only **after** commit;
- every transition locks the session row, then child rows;
- an in-process admission mutex per session is taken before a pool connection;
- the unlocked fast path for a repeated raise stays outside the lock.

**Identity's seeded descriptions are not changed in P6.** `live.speak` and `live.moderate` read "… in
live sessions one hosts" (`backend/drizzle/0002_seed_access_catalog.sql:41-42`). That is catalogue text,
not behaviour. Updating it is not additive, so it is proposed for the user's approval as a separate
identity-data migration (§17).

---

## 11. Proposed API

The routes are design §15, and all live under `/live`.

**Why not `/communities/:id/live`.** A Live route in Communities' URL space would invite the
Communities → Live edge that closes a cycle (ADR 0019, rejected alternatives; hub §15.1). The P1 routes
already follow this shape. A client builds "live now" from `GET …/sessions/current`.

| Route | Gate (identity ceiling) | Use-case question | Success |
| --- | --- | --- | --- |
| `POST /live/communities/:communityId/sessions` (no body) | `live.moderate` | `community.live.start`, re-asked after `ensureRoom` (D20) | 201 `LiveSessionView`; 200 the running session |
| `GET /live/communities/:communityId/sessions/current` | `live.join` | `community.live.join`, else `LiveAccess` | 200 `{session: LiveSessionView \| null}` |
| `GET /live/sessions/:sessionId` | `live.join` | as current; a lifecycle refusal still returns the view, with `me.canJoin` false | 200 `LiveSessionView` |
| `POST /live/sessions/:sessionId/join` (no body) | `live.join` | `community.live.join`, else `LiveAccess`; soft cap; ensure-then-recheck | 200 `JoinTicket`, the **only** response carrying a credential |
| `POST /live/sessions/:sessionId/end` | `live.moderate` | `LiveAccess` | 200 `LiveSessionView` (ended); repeat 200 |
| `POST /live/sessions/:sessionId/hand` (no body) | `live.raise_hand` | `community.live.raise_hand` | 201 new; 200 the open one |
| `DELETE /live/sessions/:sessionId/hand` | authenticated | the caller's own open request, else visibility (D9) | 200 `{request \| null}`; 404 for unknown or not visible |
| `GET /live/sessions/:sessionId/hands?state&cursor&limit≤100` | `live.moderate` | `LiveAccess` | 200 FCFS keyset page, with directory names |
| `POST /live/requests/:requestId/grant` | `live.moderate` | `LiveAccess`; target eligible; not the host's own request | 200 `{request, media}` |
| `POST /live/requests/:requestId/decline` | `live.moderate` | `LiveAccess`; not the host's own request | 200 `{request}` |
| `POST /live/requests/:requestId/revoke` | `live.moderate` | `LiveAccess`; not the host's own request | 200 `{request, media}` |
| `POST /live/sessions/:sessionId/screen-share` (no body) | `live.moderate` | `LiveAccess` + identity `live.speak`; for themself | 201 view; 200 already held |
| `DELETE /live/sessions/:sessionId/screen-share` | authenticated | the presenter stops, or `LiveAccess` revokes (not the host's grant) | 200 view; idempotent |

**Refusals, in the existing vocabulary** (design §15.2; `FailureKind` → HTTP by
`platform/http/http-failure.ts`):

| Brief's error | Answer |
| --- | --- |
| "community not found", "not a member" | one identical 404: `live.community_not_found` or `live.session_not_found`, never distinguished (`communities/contracts/authorization.ts:54-55`) |
| "insufficient capability" | 403 `live.start_not_permitted`, `live.not_a_moderator`, `live.target_is_host`, `live.presenter_not_permitted` |
| "session not active" | 412 `live.session_not_live` |
| a locked community | 412 `live.community_not_open` |
| a full session | 412 `live.session_full` |
| "session already active", "already speaker", "raise-hand already exists" | **200 with the existing resource**: idempotent, as approved in P1 (the Q40 ruling) and design §5.3 |
| "not speaker" | 409 `live.invalid_transition` |
| the presenter slot is taken | 409 `live.presenter_slot_taken` |
| the target is no longer eligible | 412 `live.target_not_eligible` |
| "provider unavailable" | 503 `live.media_unavailable` at start (nothing stored), and while real media is not enabled (D19); elsewhere the change commits and `media: 'pending'` is reported |
| Communities, the directory or the database unavailable | 503 `unavailable` |
| too many requests | 429 `live.too_many_starts`, `live.too_many_joins`, `live.too_many_hands` |
| "stale membership/authorization" | every request re-asks Communities. A change committing between that read and Live's write may still let one act complete: an accepted window, repaired by convergence, with the permit the act ran on recorded in its audit (§14) |

**Views.** No view is a domain object:

- **`LiveSessionView`** carries:
  - the session: `id`, `communityId`, `state`, `stateVersion`, `hostUserId`, `startedAt`, `endedAt`,
    `endReason`, `participantCap`, `speakerCount`, `presenterUserId`;
  - `me`, the caller's own flags, computed on the server as display hints:
    `{role, isHost, canJoin, canRaiseHand, canModerate, canEnd, canPresent, presenting, hand}`;
  - `moderation: {pendingHands (at most 100 read), violations, lastViolationAt} | null`, for
    moderators only.
- **`SpeakerRequestView`**. Names appear only on the hands page, from the directory, never an email.
- **`JoinTicket`**: `{token, url, expiresInSeconds: 120, role, media}`. It is never logged, published,
  framed or audited.

---

## 12. Proposed event vocabulary and realtime hints

### 12.1 Events

Design §14. All events live in `live/contracts/events.ts`, with `aggregateId = sessionId`, and are
published through `LiveJournal` after commit, never on a no-op.

| Event | When | Payload (ids, codes, versions only) |
| --- | --- | --- |
| `live.session.started` | a start creates a row | `{sessionId, communityId, hostUserId}` |
| `live.session.ended` | an end changes state (never on a repeat) | `{sessionId, communityId, endedBy \| null, reason, durationSeconds}`; implies every expiry and the presenter close |
| `live.speaker.requested` | a raise creates a row | `{sessionId, communityId, requestId, userId, stateVersion}` |
| `live.speaker.granted`, `.declined`, `.revoked` | a moderator acts | the above + `grantedBy` / `declinedBy` / `revokedBy` |
| `live.speaker.withdrawn` | withdraw or yield | + `from: 'pending' \| 'granted'` |
| `live.speaker.expired` | ineligibility only (never for End) | + `from`, `cause: 'ineligible'` |
| `live.screen_share.started` / `.stopped` | the slot opens or closes (never for End) | `{sessionId, communityId, userId, grantedBy \| stoppedBy, [reason], stateVersion}` |

**The brief's candidates, mapped:**
- `created` would mean a CREATED state, which does not exist.
- `speaker.promoted` is `speaker.granted`.
- `raise_hand.created` is `speaker.requested`.
- "resolved" is split by who acted.
- `participant.joined` and `participant.left` are **not events**. They are provider transport, never
  stored or published (ADR 0021; design §14). A `participant.*` frame would also collide with
  Messaging's frames in the app (`realtime_frames.dart:65-66`).

**Consumers in P6.** The realtime relay consumes every event above. Every moderation event is also an
audit entry.

**Not events:**
- token issuance, joins and leaves;
- the reconciler's provider-only corrections;
- its media reset, which is audited only;
- occupancy samples.

### 12.2 Realtime hints (backend)

The frames follow hub §16.2, additive to protocol v1:

| Frame | Audience | `eventId` |
| --- | --- | --- |
| `live.session.started {communityId, sessionId}` | the community's ACTIVE members online on this instance whom `LIVE_AUDIENCE.participantsAmong` accepts | `live.session.started:<sessionId>` |
| `live.session.ended {communityId, sessionId, reason}` | as started | `live.session.ended:<sessionId>` |
| `live.session.changed {communityId, sessionId, stateVersion}` | the affected user at once, plus online moderators coalesced to ≤ 1 per 250 ms per session; **no frame to listeners** | `live.session.changed:<sessionId>:<stateVersion>` |

Frames grant nothing, and the client refetches over HTTP. The relay lives in `realtime`: Live never
imports the transport. Delivery is detached and chained per session. Nothing happens when nobody is
connected. The app already drops frame types it does not know (`app/lib/data/realtime/realtime_frames.dart:79`).

### 12.3 Notifications

**None.** No notification contract references a `live.*` event, and Q67's default is none. The reserved
target kind `live_room` is left alone.

### 12.4 The Attendance seam

- `LIVE_SESSIONS.describe(id) → {liveSessionId, communityId, hostUserId, active} | null` reads only
  Live's own record.
- The `RtcParticipantObserver` port exists for P9's `LIVE_PRESENCE`, which stays HELD.
- End saves `ended` before calling `endRoom`, so a presence read racing the end answers `not_active`
  (design §4.2).
- Live stores no presence, attendance or "present" threshold.

---

## 13. Security analysis

| Threat | P6 mitigation | Residual |
| --- | --- | --- |
| A non-member obtains a media token | Tokens only from `/join`, after the identity ceiling, the `community.live.join` permit on the **stored** `communityId` (or `LiveAccess`), and the session's `live` state. A non-member gets the same 404 as an unknown session | Rests on Communities' membership being correct |
| Token scope | `roomJoin` for the one media room of this session; `identity` = the user id; `name` from the directory; an explicit source list; no `roomCreate`, `roomAdmin`, `roomList` or `roomRecord`; no metadata. TTL 120 s, pinned and checked at the call site (D24) | TTL bounds only the first connection; LiveKit refreshes connected clients (ADR 0019 L3). Enforcement is the reconciler's |
| Client-chosen identity, name, room or role | No route takes a body. Identity, name, room, capabilities and TTL are all the server's | A leaked API secret allows any identity. D19 requires a secret of at least 32 bytes when real media is enabled |
| Delegate escalation (another community's session; OWNER stepping in) | Moderation needs identity `live.moderate` AND a permit for **that** session's community, re-asked on every request and every sweep; no institution-wide override; the host rule is replaced, not bypassed | The permit window (§14) |
| The identity veto becoming a hole | `LiveAccess` and `PROVISIONAL_POLICY_RULES = []` land in one commit. A test asserts that an all-permission principal without standing cannot moderate, end or present, and that nothing changes | None once they ship together |
| Speaker or presenter escalation | The total capability set; the database-enforced cap and slot; a grant confers no community act (R5); ineligible holders expire at the sweep, connected or not (D21) | The convergence window after a rejoin with an old token |
| Listener publish or data storm | No sources and no data for listeners; raise is rate-limited HTTP, one open hand per user | Per-process limiter until P11 |
| Session id enumeration | uuid v4; one 404 for unknown or not visible on **every** route, the community-scoped ones included; the coarse ceiling before any read; `DELETE …/hand` answers 404 unless the caller holds an open hand or may see the session (D9) | Timing differences, as in other modules. A presenter removed from the community can still stop their own grant and receives the view in the answer |
| Tokens and secrets in logs, events, frames or audit | `JoinTicket` is never logged or published; the redaction keys `token`, `apiSecret` and `secret` (`platform/logging/logger-options.ts:10-29`); errors are logged by class only | P6 adds a key-independent scan for JWT-shaped strings and the fake's token pattern across captured logs, events, frames and audit entries |
| Communities outage | Every Communities call is wrapped. A rejection → 503 `unavailable`, never a role-only answer. Sweeps skip the tick and **never eject on unknown state** (D23) | By design, during an outage nobody can end the session, revoke a speaker or stop someone else's presentation, because each goes through `LiveAccess`; media already flowing continues (`live.md:1638`). This is the intended fail-closed trade-off |
| Real LiveKit before its hardening | **D19:** a real server is bound only with `LIVE_MEDIA_PROVIDER=livekit`. Otherwise a deployment binds a provider that refuses everything: Start 503 with nothing stored, and sweeps skipped. Enabling it requires a room prefix, a non-placeholder key and a secret of at least 32 bytes, or boot is refused | See below |

**Why D19 is needed.** The design's media-plane finality — an ended room cannot come back, and the media
reset keeps a violator's old room deleted — depends on `room.auto_create=false`. That comes with the
LiveKit-integration phase.

- **On a server with LiveKit's defaults**, every reconnection earns a fresh token valid for about 10
  minutes. So former participants could re-create an ended room, again and again, until the orphan sweep
  deletes it.
  - There is no moderation in such a room, and speakers keep their microphone.
  - Outsiders gain nothing: tokens come only from `/join`.
- **This is a finality and safeguarding residual, not an access hole.** With D19 it cannot arise in P6
  unless someone explicitly enables real media before that phase.
- **The app's lack of `livekit_client` is not a control**: any LiveKit client can use a token `/join`
  hands out.

---

## 14. Concurrency analysis

**Rule.** Live and Communities share no database lock, and no module may lock another's rows.

- A Communities permit is read, then Live's transaction runs.
- A Communities change committing in between may still let one Live act complete.
- The hub accepts this window for Live explicitly: "One request whose permit was read before the commit
  may still complete (one send, one token); it is audited with the permit it ran under" (hub:519-526).
- Messaging lives with the same window (`communities.md` §8.4, :1362-1365;
  `community-chat-postgres.spec.ts:384-510`).
- Convergence then repairs it: `ProtectLiveSessions` at once, or the sweep within 60 s, which also covers
  disconnected floor and presenter holders (D21).
- Start re-asks its permit after `ensureRoom` (D20), so its window is milliseconds, not a provider round
  trip.

Every race the brief lists, with its accepted outcome (tested in commit F):

| Race | Accepted outcome | Mechanism |
| --- | --- | --- |
| Two moderators start at once | One live row. Every caller gets the same session (one 201, the rest 200). Each loser's provider room is ended | partial unique index + `ON CONFLICT DO NOTHING`; `endRoom` on a lost race |
| Two users join at once | Both get tokens; nothing is written | a join writes nothing and takes no lock |
| Promotion + removal | Either the grant is refused (permit read after the commit: 412 `live.target_not_eligible`), or it commits and the request expires `ineligible` (`ProtectLiveSessions`, or the sweep) | permit window + convergence |
| Promotion + session end | Serialized on the session row: either the grant commits first and End expires it, or End commits first and the grant gets 412. Nothing stays open in an ended session | the session row `FOR UPDATE`, then `live` required |
| Raise + removal | Either refused (a permit after the commit), or created then expired `ineligible` | permit window + convergence |
| Session end + join | A join whose read follows End's commit gets 412. A join that re-created a missing room re-reads, ends that room and gets 412 (ensure-then-recheck). A token minted just before End names a room End then deletes | the session row + ensure-then-recheck |
| Lock + start | Either start is refused (412 `live.community_not_open`), or its re-asked permit preceded the lock and the session runs, as Q46 lets every running session continue. **Recorded as an accepted outcome**; the hub states the window only for removal | permit window, narrowed by D20; Q46's `runningLiveContinues` |
| Membership removal + join | Either refused (404), or one token is minted, after which the sweep or `ProtectLiveSessions` removes the participant | permit window + convergence |
| Ownership or capability change + a live operation | Either refused, or one act completes on the earlier permit, and the audit records that permit (`{basis, grantId}`) | permit window; the permit in the audit |
| Concurrent grants past the cap | Exactly 4 granted; the rest 412 `live.speaker_slots_full` | count under the session lock + compare-and-set |
| Two presenter claims | Exactly one; the other 409 `live.presenter_slot_taken` | the open grant read under the session lock; a partial unique index as backstop |
| 20 raises by one user | One row, one event | partial unique index + `ON CONFLICT` |
| Lower + grant | The lower yields, since it takes either open state; or the grant finds a withdrawn request (409) | compare-and-set |
| Revoke + yield | One wins. The other gets 200 if it finds its own target state, else 409 | compare-and-set |

**Several processes.** The Postgres invariants hold across instances. Two reconcilers only duplicate
idempotent calls; a lease is P11. The soft-cap counter is per instance, and the hard cap bounds it. No
distributed lock is introduced.

**Restart.** Everything durable is in Postgres, and nothing is replayed.
- An ended session stays ended: every update requires `state = 'live'`, and only live sessions have rooms
  ensured.
- The Postgres part of the watch is rebuilt from the timestamps. The in-memory part is lost: identities
  the sweep corrected, and pushes that did not apply. The 60 s sweep backstops it (design §11.5).

---

## 15. Scale considerations

The brief's target is about 10,000 concurrent live users, and about 3,000 listeners, 1 teacher and 1–2
speakers in a room. It is a **target, not a claim**. Nothing is measured, and P6 claims no capacity
(hub §20: "Measured: nothing for these workloads").

**What P6's design costs.** These figures are derived by counting code paths, not measured:

| Path | Cost |
| --- | --- |
| A listener's `/join` | ≈ 11 SQL statements: authentication 4, session 1, permit 1, own request 1, presenter 1, directory name 3. It **writes nothing, takes no row lock**, and signs once locally. A moderator's: 12–13 |
| Rows per join | 0. Only a raised hand writes a row |
| Hand storms | Serialized per session on one row, but queued in memory behind the per-session mutex, holding at most one pool connection per session |
| Frames | Each moderator receives ≤ 4 `live.session.changed` per second per session, whatever the hand rate. Listeners receive **zero** application frames for hand, speaker or presenter changes. Start and end frames cost 1 + ⌈A/1000⌉ member pages and ⌈M/1000⌉ contract calls |
| Participant sweep | ≈ 17 statements per 1,000 connected identities per 60 s; ≈ 61 for a 3,000-listener session, plus one unpaginated `listParticipants` |

**The design's cap against the target.** The default cap is **300 + 10**. It is ten times below the
target room.

- It rests on ADR 0019 decision 12 (Accepted) and Q57. Q57 says "The values rise only after load
  profiles 1–3", and that "The measured knee (P8) sets the engineering ceiling". Hub §21's profile 5
  steps subscribers from 500 to 3,000.
- The cap is a **configuration value**: `LIVE_MAX_PARTICIPANTS_PER_SESSION`, copied onto each session at
  start. Nothing in code hard-codes 300 or sizes a room from membership.
- Raising it is one environment variable.

**Load-testability that P6 leaves in place:**
- HTTP routes a harness can drive: start, join, raise, grant, revoke, end;
- the fake selectable without credentials;
- statement budgets pinned by a query spy: join, raise, grant, end and the hands page are constant
  whatever the hand count; `/join` writes nothing;
- `EXPLAIN` over a churned fixture for every hot statement, including End's set-based expiry of 3,000
  hands;
- joins not rate-limited per IP, because a school NAT would share one address.

**Beyond Live, not changed by P6:**
- One API instance holds at most 10,000 app sockets (`realtime/domain/realtime-policy.ts:42`).
- Realtime revalidation costs about 667 statements/s at 10,000 online.
- LiveKit rooms are single-node.

These are P8 and P11 concerns.

---

## 16. Decisions this audit makes

**None is new policy.** Most are engineering choices. D2, D10 and D18 are **readings of recorded
defaults** (Q54, Q63), labelled as such and listed in §17 where the user might read the default
differently.

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Start while LOCKED with a session running → 200 with that session** | Design §4.1 step 2, `live.md:1629` and `live.md:1701` ("start, lock, retry → 200"). No new session starts while LOCKED either way (Q46). The hub's A2 sequence is a summary that does not show this remap |
| D2 | **End has no target: any session moderator may end** (a reading of Q54). `live.target_is_host` applies to the host's own request or presenter grant | Q54's second bullet; hub:1312, :1499; `live.md:1623`. Listed in §17 |
| D3 | **`community.live.remain` is a membership-basis act** (the kind `participation` in the evaluator), with join's ceiling and gate `runningLiveContinues`, listed in `COMMUNITY_DERIVED_ACTS`. It is not a capability, so `backingCapability` is null and no grant applies. It never appears in `me` | Its row is `communities.md`'s. Left the default kind, it would be owner-only and the sweep would eject every listener |
| D4 | **`permittedAmong` rejects when the store or directory fails, and answers `[]` for an unknown community.** At most 1,000 ids (a RangeError above). Never oversight | "The sweep never ejects on unknown state" (design §11.3) |
| D5 | **The grant's target check asks `community.live.remain`** (eligible to stay), or accepts a moderator target | Design §3.6. It is identical to `join` under OPEN and LOCKED |
| D6 | **Repeats answer 200 even after End.** A transition after End → 412 | Design §5.3 |
| D7 | **Hands page media status** comes from the reconciler's last in-memory observation (`connected`, `not_connected` or `unknown`) | Design §15.1 "last observed". A display hint, never truth |
| D8 | **`pendingHands` reads at most 100 rows**; 100 means "100 or more" | The unread-count precedent (Q27) |
| D9 | **`DELETE …/hand`: the caller's open request first.** If they hold one, withdraw it (no permit is needed; it only reduces privilege). If not: 404 for an unknown session or one the caller may not see, else 200 `{request: null}`. A terminal state other than `withdrawn` found at the write → 409 | Matches hub:1314 and `live.md:1666` ("404 for non-members on every route") as well as `live.md:522, 605` |
| D10 | **Enforcement watch 660 s**, extended on every violation | The design's value (`live.md:358, 1030`) |
| D11 | **`CapabilityConvergence` is retired.** The reconciler's targeted watch takes over (design §11.4). An in-memory set also holds identities whose last push did not report `applied` | One enforcement path |
| D12 | **`KeyedMutex` moves to `platform/concurrency/keyed-mutex.ts`**; Communities imports it from there | A pure utility. One copy rather than a second |
| D13 | **Rate limits are applied in the use cases through `RATE_LIMITER`**, per user or per (session, user) | Design §3.8; the platform decorator is per IP |
| D14 | **Communities calls are wrapped** in Live's own `askCommunities` equivalent, never imported from Messaging | Live must not depend on Messaging |
| D15 | **Metrics are structured log lines with stable event names** (`live.session.start`, `live.provider.error`, …) | No metrics system exists (`docs/architecture/observability.md:177-195`), and the brief forbids inventing one |
| D16 | **The live golden frame fixtures live in `backend/test/fixtures/realtime-frames/live/`** | The app's fixture test reads only the top directory and requires each file to parse, and P6 changes no Flutter file. The app ignores unknown frames at runtime. The Flutter live phase moves them beside the others when it adds the parser. A deliberate, documented deviation from hub §16.2's "shared by the backend builders and the Flutter parser", listed in §17 |
| D17 | **`ProtectLiveSessions` subscribes to** `member.removed`, `capability.revoked`, `ownership.transferred`, `community.locked` and `community.unlocked` | Design §11.6. The hub's shorter lists predate it; corrected in commit G |
| D18 | **`hostUserId` stays the starter.** Losing `community.live.host` removes their moderation; the session continues (a reading of Q63's "the session continues for the others") | Q63 |
| D19 | **Real media only on explicit opt-in.** | See below |
| D20 | **Start re-asks `community.live.start` after `ensureRoom`**, before the insert. A refusal ends the room it ensured (best effort) and returns the refusal | Narrows the lock and removal window from a provider round trip to milliseconds. Strictly safer; no policy |
| D21 | **Every participant sweep also checks the eligibility of the ≤ 4 granted and ≤ 1 presenter holders, connected or not** | Q63: "their hand, floor and presenter grant close". Without this, a disconnected holder who lost standing through an event that was lost, or that never exists (suspension, ceiling loss), keeps a stored floor that a later `/join` would honour |
| D22 | **A violation counts only after a correction that reported `applied`.** A push that failed or found nobody is not a violation, and a capability below its desired set never is | Resolves the tension between design §11.3.4 and §11.4 in favour of §11.4 and §19, so a provider blip never resets a room |
| D23 | **Reconciler fail-safe.** A failure while paging live sessions aborts the whole room sweep, deleting no orphans. A failure of the `live.speak` directory lookup skips that session's tick, demoting nobody | Design §11.3.5: "never ejects on unknown state", applied to every input |
| D24 | **The join TTL is checked at the call site**, an integer 1..600, besides the pinned constant | The SDK turns a falsy TTL into 6 hours |

**D19 in full.** The provider factory binds:

| Configuration | Binds |
| --- | --- |
| `LIVEKIT_API_SECRET` is the development secret | the fake (as today) |
| `LIVE_MEDIA_PROVIDER=livekit` | the LiveKit adapter; boot is refused without `LIVE_ROOM_NAME_PREFIX`, with a placeholder API key, or with a secret under 32 bytes |
| anything else | a **disabled provider**: every call throws `RtcUnavailableError`, so Start answers 503 `live.media_unavailable` with nothing stored and the reconciler skips its ticks, logging the state once per change |

Why: the brief says "Prefer a fake provider in P6", "Do not integrate real LiveKit" and "failure is
explicit". The design's own guard, the self-check refusing Start, is deferred. The adapter file is not
edited.

---

## 17. For the user's review (none blocks P6)

Each item states why P6 needs no decision on it, and what P6 does meanwhile.

1. **Q56, student screen sharing.**
   - OQ:1922-1926 records that the design deferred an earlier design brief's "students only with an
     explicit capability" path to P12, and that this deferral "needs the user's confirmation".
   - P6 builds only the moderator slot, which ADR 0019 decision 9 (Accepted) settles.
   - A "yes, students may present" later is additive, through the `grantedBy` seam. It would need its
     own capability, which is a decision for that later phase.
2. **The two Communities additions**, `permittedAmong` and `community.live.remain` (§7, row 14). They
   were accepted in ADR 0017 for P6, and they are code in Communities.
3. **Retiring `host-only-moderation`**, which changes identity's provisional rule list (ADR 0017
   decision 10).
4. **The capacity default of 300 + 10** (ADR 0019 decision 12, Q57) against the 3,000 target (§15). It
   is one environment variable.
5. **D19, fail-closed real media**, and the re-phasing it rests on. A dated note on ADR 0019 records that
   the pinned configuration, the contract suite and the self-check move to the LiveKit-integration phase.
6. **D2, the reading of Q54 for End**: any session moderator may end the host's session. Q54's question
   lists "end the session" among the acts on the host. Its recorded default, the hub and the design's
   sequences allow it.
7. **D16, the fixture location**: a deliberate, documented deviation from hub §16.2 until the Flutter
   live phase adds the parser.
8. **A safeguarding consequence of five recorded defaults (Q63, Q61, Q62, Q54, Q43).** A session whose
   host lost standing keeps running:
   - speakers already granted keep the floor;
   - there is no maximum duration, and oversight has no override;
   - it ends only when observed empty, or when the owner or another `community.live.moderate` holder
     ends it.
9. **Q60.** A "yes" to several devices per account "belongs in P6, before P9" (OQ:2043-2046). P6 keeps
   the recorded "no": one identity per account, and the newest device wins.
10. **An accepted deviation from Q63's "their … floor … close".** The case: someone is removed and
    re-added to the community before a lost removal event is swept. They keep a floor granted under
    their old stint, because they are eligible again and hands are keyed by (session, user), not by
    stint. Closing it would need stint-aware answers from Communities, beyond ADR 0017.
11. **Lock racing start**, recorded as an accepted outcome (§14), narrowed by D20.
12. **Identity's seeded descriptions** of `live.speak` and `live.moderate` still say "… one hosts". A
    one-statement identity-data migration is proposed, for approval.

---

## 18. Implementation slices

The plan groups the brief's slices into commits that each leave the tree green. The brief allows this:
"DO NOT blindly follow this ordering if the audit finds a better dependency order". Full detail is in the
plan.

| Plan commit | Brief slices | Content |
| --- | --- | --- |
| **A** | P6.1 (Communities part) | `permittedAmong` (both stores, the contract suite, `EXPLAIN`); `community.live.remain`; `KeyedMutex` moved to platform |
| **B** | P6.1 (identity part), P6.2 (domain), P6.4, P6.5, P6.6 | Live's domain, contracts and limits; `AppConfig.live` and D19; the extended fake and the disabled provider; in-memory repositories; `LiveAccess` and every use case; the API; `PROVISIONAL_POLICY_RULES = []` **in the same commit** as `LiveAccess` |
| **C** | P6.2 (persistence) | schema, migration 0013, Drizzle repositories, the database switch, a mock-parity contract suite |
| **D** | P6.4 (convergence), P6.3 (contracts) | `LiveReconciler` (D21–D23), `ProtectLiveSessions`, `LiveAudienceService`, `LiveSessionsReader`, exports |
| **E** | P6.7 | `LiveRealtimeRelay`, frames, coalescing, fixtures |
| **F** | P6.8 | the Postgres races of §14, restart, Communities outage, provider failure, token scope and expiry, oracles, no-N+1, `EXPLAIN`, recorded mutation checks |
| **G** | P6.9 | boundary specs; the ADR 0019 amendment note; design and hub notes; README counts; the final gate |

---

## 19. Residual risks, and what P6 does not claim

**No media claim.** P6 proves its behaviour against the deterministic fake and Postgres only. It claims
nothing about LiveKit's behaviour, and it binds no real server unless explicitly enabled (D19).

**Deferred to the LiveKit-integration phase:**
- the pinned server configuration (`room.auto_create=false`, `enable_remote_unmute=false`, timeouts, no
  webhooks, a TURN placeholder);
- the adapter contract suite against a real, pinned server in CI, with a real client SDK;
- the `/rtc/validate` self-check;
- turning `LIVE_MEDIA_PROVIDER=livekit` on.

**No capacity claim.** The 300 + 10 default stands until P8 measures.

**Accepted windows**, each listed in §17 where the user may care:
- the permit window between Communities and Live (§14);
- a floor kept across a removal and re-add inside a lost event (§17.10);
- media for a violator until the second violation;
- an unmoderated running session after its host lost standing (§17.8);
- no end, revoke or presenter stop while Communities is unreachable (§13).

**No outbox.** A crash between commit and publish loses a hint, never the fact (ADR 0021). The
reconciler backstops `member.removed`, now for connected identities and for disconnected floor and
presenter holders alike (D21).

---

**P6 READINESS: PASS**
