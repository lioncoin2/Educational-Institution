# Communities, Live and Attendance

**State: PROPOSED — design only. Nothing here is implemented; no table, endpoint, event publisher or screen exists.**

This is the hub of the design package for the brief's eight features:
communities (the brief's "groups"), membership and invitation links, the
community chat, live voice sessions, screen sharing, raise hand and speakers,
attendance snapshots, and delegated community permissions. It answers the
brief's question in [§0](#0-verdict) and carries the cross-cutting outputs.
The detail lives in the documents below; this file links to them rather than
repeating them.

| Document | Covers | Phases |
| --- | --- | --- |
| this file | verdict, ownership, dependency graph, contracts, events, API, realtime matrix, Flutter, failures, threats, scaling, load tests, testing, phases | all |
| [communities.md](communities.md) | the Community aggregate, membership stints, invitation links and their races, the lifecycle table, act rules, delegation | P2, P3 |
| [community-chat.md](community-chat.md) | messaging's community chat: the named projection, access, recipients, capacity gates | P4 |
| [live.md](live.md) | live sessions, the speaker and presenter state machines, RTC ports, the reconciler, capacity | P1, P6, P7 |
| [attendance.md](attendance.md) | the snapshot model, observation rule and idempotency — **HELD** | P9 |
| [ADR 0016](decisions/0016-communities-module.md) – [ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md) | the decisions, status Proposed | — |
| [open-questions.md](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules), Q40–Q72 | the policy this design does not invent | — |

**The name.** In code and in these documents the brief's "Group" is the
**Community** aggregate: module `communities`, id `communityId`, routes
`/communities`, tokens `COMMUNITY_*`, events `communities.community.*`.
"Group" is avoided because it already means two things here: messaging's
`GROUP` conversation type (`messaging/contracts/vocabulary.ts:11`), and
Tahajji's «مجموعة» in
[Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups),
which is unanswered. Using it would collide with the first and pre-answer the
second. "Group" stays the brief's product word only.

**How to read this package.**

- **What exists today** means the repository at commit `9670c47`. Every such
  statement says so and cites `file:line` (house style: the file name, or a
  short path when the name is ambiguous). Line numbers cited in other
  documents of `docs/architecture/` are at that commit too, before this
  package's notes shifted them ([§25.3](#253-what-this-pass-did-not-do)).
- **Everything else is a proposal.** Every default that is institutional
  policy is labelled PROVISIONAL and names its open question. Engineering
  bounds that must be measured are labelled PROVISIONAL too.
- **LiveKit facts** come from the server and SDK source, not from LiveKit's
  documentation site, which could not be read from this environment.
- **Nothing here lifts the academic hold**
  ([academic-reconciliation.md §13](academic-reconciliation.md#13-minimal-recommended-changes-before-the-next-milestone)).

---

## 0. Verdict

> **Can we build Groups + Live + Attendance now without creating spaghetti
> architecture later?**
>
> **Yes for the architecture. Not yet for all of the code.**

This package forms one acyclic modular monolith.
`A ◀── B` means "B depends on A", the brief's notation:

```
  identity ◀── communities ◀──┬── messaging
                              └── live ◀── attendance (HELD)
  realtime and notifications are sinks: they read contracts, and nothing but
  app.module imports realtime.
  Simplified to the brief's chain: messaging, live and attendance also import
  identity, and attendance also reads communities. Every edge is in §3.
```

- **Every concept has exactly one owner** ([§2.2](#22-data-ownership)).
- **Every capability has one contract name**: `COMMUNITY_AUTHORIZATION`,
  `COMMUNITY_MEMBERSHIP`, `COMMUNITY_DIRECTORY` and
  `COMMUNITY_CAPABILITY_HOLDERS` for Communities; `LIVE_AUDIENCE`,
  `LIVE_SESSIONS` and `LIVE_PRESENCE` for Live.
- **No existing contract breaks.** `MessagingModule` still exports exactly
  `[MESSAGE_RECIPIENTS, MESSAGE_DELIVERY]` (`messaging.module.ts:108`), and
  `MESSAGE_RECIPIENTS` keeps its signature. Identity gains four catalogue
  leaves and loses one provisional rule. Realtime protocol v1 grows additively.

### 0.1 Part by part

| Part | Build now? | Why | Smallest correction first |
| --- | --- | --- | --- |
| **Communities core** (aggregate, membership, invitation links, OPEN/LOCKED) | Yes, after corrections | The module imports `IdentityModule` only, like `academic.module.ts:76`, and exports only contract tokens, so it cannot close a cycle. The database enforces every invariant: partial unique indexes (one ACTIVE stint per pair, one OWNER), an owner-is-active CHECK, conditional UPDATEs under one lock order, versions allocated under the community row lock. Every pattern is reused from academic and messaging. | Phase 0 guards (vendor-SDK regex, LiveKit rule, rules-match spec, derived module lists) and `migrateTo(scratch.db, 9)`; then the §13 step or the user's ruling on [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules). |
| **Delegated community permissions** | Yes, after corrections | identity ceiling AND Communities standing AND the lifecycle gate: the existing ceiling-plus-relationship pattern (`academic-access.ts:68-84`, `conversation-access.ts:58-72`). No identity ACL (ADR 0005 stands), no foreign `PolicyRule` (`POLICY_RULES` is internal, `identity.module.ts:150`). Acts are a closed `community.*` vocabulary that identity never catalogues. `community.view` and `community.lock` have two segments and would pass identity's CHECK `^[a-z]+[.][a-z_]+$` (`identity/infrastructure/schema.ts:36`), so disjointness rests on three tested guards ([§7.3](#73-communities)), not on segment count. **Blocker:** `host-only-moderation` (`provisional-policy.ts:139-141`) deny-overrides every delegated moderator, OWNER included (`policy.ts:50`, `:85`). | After Q40 (P2, P3): four catalogue leaves with data migration 0009 (P2, the 0008 pattern); role.spec invariants; `PROVISIONAL_POLICY_RULES = []` in the **same change** that ships Live's `LiveAccess` (P6); ADR 0017. |
| **Community chat** (in messaging) | Yes, after corrections | Messaging pulls decisions from Communities and never exports a write port. A community chat is an ordinary `CHANNEL` conversation plus an additive `community_id`, so `ConversationType`, the DB CHECK (`schema.ts:53`), payloads, notification copy and the Flutter enum are untouched. Access asks Communities on every request, so removal takes effect when it commits. **Capacity is the constraint:** fan-out walks 30 recipient pages per message per instance at 30,000 (`messaging-relay.ts:207-219`), and each post writes one notification row per reader ([Q28](open-questions.md#q28--what-deserves-a-notification-and-how-loudly)). | Build after P2, so after Q40. Keep community chats disabled above the load-tested size until gates G1–G4 hold: the capacity switch refuses a send above it with 412 `messaging.community_chat_over_capacity` ([§20.3](#203-capacity-gates-g1g4)). |
| **Live voice, raise hand, speakers** | Yes, after corrections | Hardening the existing module needs nothing from Communities. Community-scoped sessions are blocked by what exists today: `LiveRoom` is bound to a halaqa (`live-room.ts:10-18`); join checks only `live.join` (`join-live-session.use-case.ts:61`); repositories are in memory (`live.module.ts:51-57`); the client supplies `displayName` (`join-session.dto.ts:3-8`); `ensureRoom` swallows errors (`livekit-rtc-provider.ts:34-45`); LiveKit's `auto_create` defaults to true, so a still-valid token can re-create an ended room. | P1 hardening first, once this design is accepted and its visible behaviour changes (listener data off, raise 202/409 → 201/200, TTL 600 → 120 s) are approved; Q40 does not gate P1. P6 after P2/P3, so after Q40: `LiveSession.communityId`, `COMMUNITY_AUTHORIZATION` for every act, retire the identity rule in the same change, `room.auto_create=false`, the adapter contract suite, the reconciler. |
| **Screen sharing** | Yes, after corrections | Impossible today by construction: sources are MICROPHONE only (`livekit-rtc-provider.ts:61`, `:81`) and `RtcCapabilities` has no screen flag (`rtc-provider.ts:11-17`). The port is widened additively (ADR 0003's stated path). Screen share is one `PresenterGrant` per session; the stream is never in Postgres. The app has no `livekit_client`. | Total `RtcCapabilities` and an explicit source list on every token and update (P1); after Q40, the presenter slot in P6; `LiveMediaClient` bound to Unavailable until P7b. |
| **Attendance snapshots** | **No** | Three independent blockers. (1) The user's hold: "Attendance … do not start until this reconciliation has been reviewed" (`academic-reconciliation.md:19-21`), and the §13 gate applies to any new module. (2) Nothing can be observed before community-scoped, persisted sessions exist (P6); `RtcProvider` has no participant listing (`rtc-provider.ts:56-79`). (3) Viewer scoping must not exercise the unscoped `attendance.*` grants ([Q31](open-questions.md#q31--teaching-scope-and-what-staff-may-see)). The design itself is ready and creates no spaghetti. | The §13 step (Q35/Q36 and ADR 0015) and the reconciliation review, or the user's ruling on [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules); §13's Attendance row ([Q8](open-questions.md#q8--who-may-amend-attendance-and-is-a-reason-mandatory), [Q12](open-questions.md#q12--timezone-and-academic-calendar), not TE-04) met, or ruled by the user not to apply to snapshots; reviewer acceptance of community standing as the scoping relationship ([Q69](open-questions.md#q69--who-records-and-who-views-snapshots)); then P9. |
| **Realtime application events** | Yes, after corrections | One socket. The app ignores unknown frame types (`realtime_frames.dart:70`) and drops frames whose version is not 1 (`:56`), so new server frames are additive and the version is never bumped. `OnlineAudience` needs no contract change: `MESSAGE_RECIPIENTS` already has `onlyUserIds` (`message-recipients.ts:40-44`). The connection gate stays `messaging.read` (`realtime-sessions.ts:443`). | The gate-coupling test (P0). After Q40 (P5, P7): `ConnectionManager.onlineUserIds()` and `OnlineAudience`; one relay per source module; golden frame fixtures. |
| **Flutter client** | Yes, after corrections | The repository-and-seam pattern exists: abstract repositories bound only in `app_providers.dart`, media seams with Unavailable defaults (`media_seams.dart`). Capability booleans come from the server (the `Conversation.canPost` precedent). Real live audio and screen capture cannot be built or verified here: `livekit_client` pulls in the native `flutter_webrtc`, and a dependency is never added blind (`media_seams.dart:5-13`). | A Flutter guard against LiveKit and WebRTC (P0). After Q40 (P5, P7): repositories with HTTP and mock implementations; frame families; `LiveMediaClient` Unavailable until P7b. |
| **Scale to 30,000+ members** | Yes, after corrections | Every membership access is a point lookup, a keyset page, a maintained counter or an ordered changefeed. No code path loads a whole community, and nothing sizes a live room from membership. One instance holds 10,000 connections (`realtime-policy.ts:42`) and the event bus is in-process (`event-bus.ts:43-56`), so 30,000 members online at once is **not** promised. | After Q40: 30k and 100k Postgres fixtures with EXPLAIN and query counts (P2); load profiles 1–5 (P8) before any capacity figure is configured or promised; broker, outbox and Redis only in P11, on evidence. |

### 0.2 The three gating conditions

**1. Phase 0 corrections.** The guards this design relies on are not real
today:

- `application-has-no-vendor-sdks` can never fire. Its `to.path` is anchored
  at the package name, but resolved paths start with `node_modules/`
  (`.dependency-cruiser.cjs:79-90`).
- No rule confines `livekit-server-sdk` to `live/infrastructure`. "One file
  imports LiveKit" (`realtime.md:573`, `overview.md:146-148`) is enforced only
  in `domain/` (`domain-is-dependency-free`, `.dependency-cruiser.cjs:26-36`)
  and by three module-specific specs: messaging's for the whole module, and
  notifications' and academic's for their domain and application layers
  (`messaging-boundaries.spec.ts:43-50`,
  `notifications-boundaries.spec.ts:109-114`,
  `academic-boundaries.spec.ts:120-123`). Any other `application/`, `api/`,
  `infrastructure/` or `platform/` file could import it undetected.
- Live's events are declared in `live/domain/events.ts:9-32`, which no other
  module may import (`.dependency-cruiser.cjs:141-161`), so relays and
  attendance could not type them.
- No `FailureKind` maps to 503 (`result.ts:21-28`, `http-failure.ts:12-20`),
  so "the provider is unavailable" cannot be represented.
- The academic upgrade test migrates to the **latest** migration and asserts
  an exact grant delta (`academic-postgres.spec.ts:580`), so any identity
  grant migration breaks it.

The full list, with files, is [§25.1](#251-phase-0-corrections).

**2. Governance.** `academic-reconciliation.md:483-493` says: "Before any new
module", get Q35/Q36 answered and land ADR 0015. The Attendance hold stands
(`:19-21`). Communities and attendance are new modules, so implementing them
waits for that step or for the user's explicit ruling
([Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules)).
Phase 0 and Live hardening (P1) change only existing modules, so Q40 does not
gate them; they still wait for acceptance of this design and, for P1,
approval of its visible behaviour changes ([§25](#25-implementation-phases)).
ADR 0015 is reserved by that document (`:410`, `:490`, `:506`), so the new
ADRs are 0016–0021.

**3. Capacity evidence.** 30,000+ is a **membership** scale; the design
supports it with no ceiling. It is not a live-room scale and not a
realtime-connection scale ([§1.3](#13-30000-members-is-not-30000-live-participants)).
Nothing has been measured. Two things stay disabled until the load profiles
have run: community chats larger than the load-tested size, and live sessions
above the measured cap.

With those three conditions met, Groups + Live + Attendance can be built
without spaghetti. Communities imports only Identity. Messaging and Live pull
decisions from Communities through contracts. Live is the only LiveKit
importer. Attendance is a leaf that reads Live and Communities through
contracts.

### 0.3 What would have been spaghetti, and what prevents it

A guard with a `file:line` exists today; one marked *proposed* is part of the
phase named and does not exist yet.

| Forbidden by the brief | How this design avoids it | Enforced by |
| --- | --- | --- |
| Cross-module database or repository access | Each table is written and read only by its owner's infrastructure; ids cross modules as plain text; no cross-module foreign key | `no-cross-module-internals` (`.dependency-cruiser.cjs:141-161`); schema-import and `pg_constraint` tests per new module (*proposed*, P2, P4, P6, P9; the pattern of `messaging-persistence.spec.ts:129`) |
| Importing another module's infrastructure | Modules meet only at `contracts/` and `*.module.ts`; exports are contract tokens | the same rule; the exports-are-contracts test (*proposed*, P0) |
| Business logic in controllers | One use case per act; controllers map DTOs and results | the existing API-layer rules (`.dependency-cruiser.cjs:119-137`) |
| Business logic in Flutter screens | Screens render server capability booleans; controllers and repositories own flow | Flutter boundary tests (*proposed*, P0, P5, P7; the pattern of `academic_boundaries_test.dart:51-94`) |
| LiveKit SDK in domain code | Narrow RTC ports in `live/domain`; one adapter file | `domain-is-dependency-free` (`.dependency-cruiser.cjs:26-36`); the fixed vendor-SDK rule, `livekit-sdk-only-in-the-live-adapter` and the rules-match spec (*proposed*, P0) |
| Messaging owning membership rules | Messaging asks `COMMUNITY_AUTHORIZATION` on every access; its participant rows for community chats are a named projection with no write port | `messaging-boundaries.spec.ts:27-41` (domain purity); 412 refusals on messaging's membership routes (*proposed*, P4) |
| Academic owning generic group infrastructure | The module is `communities`; no halaqa link in v1 ([Q50](open-questions.md#q50--communities-and-the-academic-structure)) | `communities-boundaries.spec` (*proposed*, P2) |
| Attendance reading LiveKit | Only `LIVE_PRESENCE`, allow-listed to attendance | `attendance-boundaries.spec` (*proposed*, P9) |
| A giant `GroupService`, `LiveService` or god service | One use case per act; `CommunityAuthorizationService` is one pure evaluator, not a façade | review; the exports-are-contracts test (*proposed*, P0) |
| Circular dependencies | A DAG with a topological order; three candidate back-edges rejected ([§3.4](#34-back-edges-and-the-rule-that-forbids-each)) | `no-circular` (`.dependency-cruiser.cjs:17-23`); the no-`forwardRef` test (*proposed*, P0); per-module boundary specs (four exist, e.g. `realtime-boundaries.spec.ts:118-123`; one per new module *proposed*) |

---

## 1. Architecture overview

### 1.1 Concepts

| Concept | What it is | Owner | Lifetime |
| --- | --- | --- | --- |
| Community | A persistent space people belong to: the brief's Group | communities | Months or years; never deleted (PROVISIONAL, [Q47](open-questions.md#q47--retiring-a-community)) |
| Membership stint | One stay of one account in one community: ACTIVE, then LEFT or REMOVED. A rejoin is a new stint | communities | Kept as history |
| Invitation link | A bearer token that admits signed-in, eligible accounts. Only its SHA-256 is stored | communities | Until expired, exhausted or revoked |
| Capability grant | A delegated act, such as `community.live.moderate`, given by the owner (PROVISIONAL, [Q44](open-questions.md#q44--who-may-hold-delegated-capabilities)) to one stint | communities (P3) | Until revoked, the stint ends, or the grantee becomes owner; no expiry (PROVISIONAL, [Q45](open-questions.md#q45--capability-grants-duration-handover-and-visibility)) |
| Community chat | An ordinary messaging conversation linked to a community | messaging | As long as the community |
| LiveSession | One live voice session of one community: `live`, then `ended` | live | Minutes to hours |
| Media room | The LiveKit room that carries a session's audio and screen track | live/infrastructure | Ephemeral; never an identity |
| SpeakerRequest | A raised hand and what became of it | live | One session |
| PresenterGrant | The single screen-share slot of a session | live | One session |
| AttendanceSnapshot | One server-taken observation of whom the media provider held connected at a press | attendance (HELD) | Immutable (PROVISIONAL, [Q71](open-questions.md#q71--correcting-retaining-and-erasing-snapshots)) |

### 1.2 A Community is not a LiveKit room

- A community exists in Postgres whether or not any session runs. Communities
  depends on neither Live nor LiveKit, so a LiveKit outage touches no
  community, membership or chat.
- A LiveSession belongs to exactly one community. Its `communityId` is read
  from the stored session, never from the client. At most one live session
  runs per community (PROVISIONAL,
  [Q55](open-questions.md#q55--parallel-live-sessions-in-one-community)).
- The media room is infrastructure. Its name is derived from a prefix, the
  session id and an epoch; it is never a domain identity. Postgres is the
  truth and LiveKit converges to it (the provisional answer to
  [Q5](open-questions.md#q5--what-happens-when-the-media-provider-and-our-record-disagree):
  the record wins). With `room.auto_create=false` a token can never re-create
  a room.
- **What exists today:** a `LiveRoom` bound to a halaqa (`live-room.ts:10-18`),
  held in memory, with the session id as the room name.

### 1.3 30,000 members is not 30,000 live participants

**This distinction is the foundation of the design.** 30,000 is a count of
membership rows. It says nothing about how many people are online, reading
the chat, or in a live session, and each of those has its own bound:

| Scale | Unit | Bounded by | Measured today |
| --- | --- | --- | --- |
| A. Membership | one stint row | Nothing as policy. `member_count` has no upper CHECK; 30,000 and 100,000 are fixture sizes | Nothing (not built) |
| B. Messaging | one message, fanned out to online readers | Realtime: today ⌈N/1000⌉ queries per message per instance, whatever is online (`messaging-relay.ts:207-219`); with `OnlineAudience` (P5, gate G1) at most `1 + ⌈A/1000⌉`, where A is the accounts connected to that instance (A ≤ 10,000, `realtime-policy.ts:42`). Notifications: one row per reader (Q28) | Fan-out tested at 250 members (`messaging-persistence.spec.ts:522-551`) |
| C. Live | one participant in one room on one node | The per-session cap, to be set from measurement (PROVISIONAL 300 plus a reserve of 10 until then, [Q57](open-questions.md#q57--live-session-size-and-concurrency)) | Nothing |
| D. Attendance | one entry per observed participant per press | The room's size, never the membership | Nothing |

- A live session holds at most its configured cap. `COMMUNITY_MEMBERSHIP`
  deliberately exposes no count and no "load all", so nothing can size a room
  from membership.
- **LiveKit rooms are single-node.** In self-hosted LiveKit a room is pinned to
  one node and must fit on it; new joins are refused when that node is full
  (verified in the server's room-allocation source). More nodes means more
  rooms, not bigger rooms.
- **The ~3,000 participants per room figure is published by LiveKit but must
  be benchmarked.** It is known only second-hand here: LiveKit's documentation
  site could not be read from this environment. Load profile 5 measures the
  knee on our hardware ([§21](#21-load-testing-plan)).
- One API instance accepts 10,000 WebSocket connections, so 30,000 members
  **online at once** is not promised either.
- A need for more listeners than one room holds is a separate large-event
  problem inside Live
  ([Q58](open-questions.md#q58--more-listeners-than-one-room-can-hold)). It
  changes neither Communities, Messaging nor Attendance.

### 1.4 The picture

```
 Flutter app ────────────────────────────────────────────────────────────────────────────
   screens: render server capability booleans; import no transport, SDK or repository impl
     │
     ├─▶ controllers ─▶ Community / Live / Messaging / Attendance(P9) repositories ── HTTP ─┐
     ├─▶ RealtimeClient ◀──── one WebSocket /realtime: ids-only hints, protocol v1 ──┐     │
     └─▶ LiveMediaClient ◀─── LiveMediaGrant, only from POST /live/sessions/:id/join │     │
            ║ audio, screen track, in-room roster, own permission changes            │     │
 ═══════════║════════════════════════════════════════════════════════════════════════│═════│═══
            ║           API: one NestJS process (exactly one instance until P11)     │     ▼
            ║                                                                        │  use cases
            ║    identity ◀── communities ◀──┬── messaging ──events──┐               │  (HTTP truth)
            ║   (ceilings)   (standing,      │                       ▼               │
            ║                 lifecycle)     └── live ─────events──▶ realtime ───────┘
            ║                     ▲               ▲ │                relays (sinks)
            ║                     └─ attendance ──┘ │ RTC ports
            ║                        (HELD, P9)     ▼
            ║                            live/infrastructure/livekit-rtc-provider.ts
            ║                                       │ server API: rooms, permissions, listing
 ═══════════║═══════════════════════════════════════│════════════════════════════════════════
            ╚═══════════════════════════▶  LiveKit SFU (a room lives on one node)

 PostgreSQL: communities, messaging, live and attendance tables, each touched only by its owner.
 In-memory adapters implement the same ports when no database is configured (mock mode).
```

---

## 2. Module ownership

### 2.1 Modules

| Module | Status | Owns | Exports | Must not know |
| --- | --- | --- | --- | --- |
| **identity** (existing, extended) | Implemented. Gains 4 catalogue leaves (`communities.read`, `.create`, `.moderate`, `.manage`) with data migration 0009 (P2). `PROVISIONAL_POLICY_RULES` becomes `[]` (P6) | Accounts, roles, the permission catalogue, the provisional role matrix, `AuthorizationService` (synchronous, deny-overrides), `AccountDirectory` (`describe`, `withPermission`, ≤ 1,000 ids). Role-wide ceilings only | Unchanged: `AUTHORIZATION_SERVICE`, `ACCOUNT_DIRECTORY`, `ACCESS_TOKEN_AUTHENTICATOR` (`identity.module.ts:181`) | Communities, stints, grants, invitations; live sessions, hosts, attendance. After P6 it receives no `ownerUserId` for community or live decisions. No other module contributes a `PolicyRule`. No three-segment permission |
| **communities** (NEW) | Proposed. P2 core, P3 delegation. Implementation gated by Q40 | The Community aggregate; membership stints; invitation links; capability grants (P3); the act-rules and lifecycle tables; one evaluator (`decideCommunityAct`); one use case per act; `CommunitiesJournal`; `CommunityPeople` | `COMMUNITY_AUTHORIZATION`, `COMMUNITY_MEMBERSHIP`, `COMMUNITY_DIRECTORY`, `COMMUNITY_CAPABILITY_HOLDERS` (P3). Type-only: `capabilities.ts`, `vocabulary.ts`, `events.ts` | Messaging and chat data (no last message, no unread count); live sessions ("live now" is composed by the client); LiveKit, attendance, realtime, notifications; academic and halaqat (Q50); any other module's tables. Imports `IdentityModule` only; its contracts import `shared` and `identity/contracts/permissions.ts`, never the identity barrel |
| **messaging** (existing, extended in P4) | Implemented; gains an additive community-chat branch | Conversations, messages, attachment references, ordering, idempotent sends, watermarks, history windows. NEW: the link `conversations.community_id`; the named, non-authoritative projection of a community's ACTIVE members; `CommunityChatSync`, `CommunityChatSweeper`, `CommunityChatReconciler`, `GetCommunityChatUseCase`. `ConversationAccess` stays the single checkpoint | Unchanged: `MESSAGE_RECIPIENTS`, `MESSAGE_DELIVERY` (`messaging.module.ts:108`) | Community rules (who may join, invite, lock or post: it asks); invitations; lifecycle status values; live, LiveKit, notifications, realtime. `messaging/domain` never imports communities; messaging never reaches live, even transitively |
| **live** (existing, evolved in place) | Implemented today in memory and halaqa-bound. P1 hardening, P6 community scope, P9 observation | `LiveSession` (replaces `LiveRoom`), `SpeakerRequest`, `PresenterGrant`, moderation actions; `capabilitiesFor`; the media room name; the RTC ports and the only LiveKit adapter; `LiveAccess`, `LiveReconciler`, `ProtectLiveSessions`, `LiveAudienceService`; the observation rule `provider_registry_v1` (applied by `LivePresenceService` behind `LIVE_PRESENCE`, P9); one use case per act | Today nothing (`live.module.ts:36-62`). Then `LIVE_AUDIENCE` (P6), `LIVE_SESSIONS` (P6), `LIVE_PRESENCE` (P9, attendance only) | Membership storage and community rules (it asks); the raw lifecycle status (it reads effects flags and refusals); attendance semantics (it reports raw connection states); messaging, realtime, notifications, academic, operations |
| **attendance** (NEW, **HELD**) | Designed only. Blocked by Q40, Q69 and P6 | `AttendanceSnapshot` (header and entries); the recorded `observation_rule` id; the idempotency key; four use cases; `AttendanceAccess`; `AttendanceJournal` | Nothing in v1; type-only `contracts/events.ts`. A reader contract waits for its first consumer | LiveKit and live internals; operations' `AttendanceState`; academic and halaqa ids; `attendance.read` and `attendance.manage` (never consulted; a grep test enforces it); notifications, realtime. Only `app.module` imports it |
| **realtime** (existing, extended in P5, P7) | Implemented; additive only | Connections (plus `onlineUserIds()`); protocol v1 frames; `MessagingRealtimeRelay`, `NotificationRealtimeRelay`, NEW `CommunitiesRealtimeRelay`, NEW `LiveRealtimeRelay`; the internal `OnlineAudience`; transient coalescing buffers | Nothing; imported only by `app.module` (`realtime-boundaries.spec.ts:118-123`) | Any module's tables; membership rules (audiences are asked of source contracts at delivery time); LiveKit. It stores nothing and opens no second socket |
| **notifications** (existing) | Implemented; unchanged until P10 | Notification rows, preferences, devices, push. Later: translators for the new facts, importing only contracts | Unchanged: `NOTIFICATION_READER` | Community rules, live state, LiveKit. It never becomes an authorization bypass: opening a notification runs the owner's checkpoint |
| **operations** (contract only) | Contract only; `AttendanceRecord` stays on hold | `AttendanceState`, `SessionRef`, `AttendanceAmendment` (`operations/contracts/index.ts:7-19`), types unchanged; its doc comment is corrected | None | How a session is delivered. It imports `attendance/contracts` only if Q70 says snapshots feed its record, never the reverse |
| **files**, **academic** (existing) | Unchanged | As today | `FILE_ASSETS`; `ACADEMIC_RELATIONSHIPS` | Communities (no halaqa link in v1, Q50) |
| **shared kernel, platform** | Extended in P0 and P6 | `FailureKind` gains `'unavailable'` → 503. `AppConfig.live` (P6). `AUDIT_LOG`, `EVENT_PUBLISHER`, `RATE_LIMITER`, `CLOCK`, `ID_GENERATOR` reused; `EventPublisher`/`EventSubscriber` unchanged until P11 | Unchanged ports | Any business module |
| **app** (Flutter data layer) | Extended in P5 and P7; attendance in P9 | `CommunityRepository`, `LiveRepository` (HTTP and mock, bound only in `app_providers.dart`); `CommunityEvent` and `LiveEvent` frame families; the `LiveMediaClient` seam; server-parsed capability models; the `/invite` route | n/a | Screens never import `livekit_client`, `flutter_webrtc`, `web_socket`, `http`, `api_client` or repository implementations; never derive rights from roles; never label anyone "present" |

### 2.2 Data ownership

The brief's §20 table. No concept has two authoritative owners.

| Concept | Owner | Stored where | Public contract |
| --- | --- | --- | --- |
| Community (identity, title, lifecycle status) | communities | `communities` | `COMMUNITY_DIRECTORY.describe` (title, display only); `COMMUNITY_MEMBERSHIP.heads` (versions and `LifecycleEffects`, never the raw status); `/communities`; `communities.community.*` |
| Membership (active/left/removed, joinedAt, endedAt, source, per-community version) | communities | `community_members`, one row per stint | `COMMUNITY_MEMBERSHIP`; the participation acts of `COMMUNITY_AUTHORIZATION`; `communities.member.added` / `.removed` |
| Ownership (exactly one owner) | communities | `standing = 'OWNER'` on the owner's ACTIVE stint | `CommunityPermit.basis 'owner'`; `communities.ownership.transferred`; the `me` block |
| Delegated capability grant | communities | `communities_capability_grants` (P3) | `CommunityPermit.basis 'grant'`; `COMMUNITY_CAPABILITY_HOLDERS`; `communities.capability.*` |
| Act rules and what LOCKED means | communities (PROVISIONAL constants; Q43, Q44, Q46) | code | Only through permits, `communities.community_locked` refusals and `CommunityHead.effects` |
| Invitation link | communities | `community_invitations` (token hash only; the raw token is never stored, logged, audited or published) | No cross-module contract; `/communities/:id/invitations`, `POST /communities/join` |
| Permission (role-wide ceiling) | identity | `permissions`, `role_permissions` | `AUTHORIZATION_SERVICE`; `ACCOUNT_DIRECTORY.withPermission` |
| User, account, display name | identity | `users` | `ACCOUNT_DIRECTORY.describe` (never an email) |
| Message | messaging | `messages` | `MESSAGE_DELIVERY`; `messaging.message.sent` |
| Attachment | messaging (reference), files (bytes) | `message_attachments`; file storage | `FILE_ASSETS`; the attachment link route |
| Community → chat link | messaging | `conversations.community_id` (partial UNIQUE, plain text) | `GET /messaging/communities/:communityId/conversation`; `ConversationResponse.communityId` |
| Community chat audience | messaging (derived; only the projection applier writes it) | projected `conversation_participants` rows with `source_version`, `source_membership_id` (the stint id; decides rejoins) and `source_joined_at`, under a shape CHECK over the three; `conversations.projected_membership_version`; `conversations.member_count`, the projection's count, which the capacity switch compares with `communityChatMaxServedMembers` | `MESSAGE_RECIPIENTS` (signature unchanged; lag-filtered through the authority; every page narrowed by `COMMUNITY_CHAT_READ_CEILING`, two `withPermission` calls per non-empty page) |
| Read watermark, history window | messaging | `conversation_participants` | `ConversationResponse.unreadCount`; `MESSAGE_DELIVERY` |
| LiveSession | live | `live_sessions` | `LIVE_SESSIONS.describe`; `live.session.*` events and frames; `/live/…` |
| Media room | live/infrastructure | LiveKit only, ephemeral | none |
| Live participant state (who is connected now) | LiveKit is the source; live is its only reader | not stored by us | `LIVE_PRESENCE.observe` (attendance only); the reconciler internally |
| Speaker state, raise-hand request | live | `live_speaker_requests` | `live.speaker.*`; hand, hands and request routes; `live.session.changed` |
| Screen-share capability (presenter grant) | live | `live_presenter_grants` (never the stream) | `live.screen_share.*`; `LiveSessionView.presenterUserId` |
| Participant capability set | live domain (`capabilitiesFor`, total) | derived, not stored | the join response's `media`; `LiveSessionView.me` |
| Attendance snapshot | attendance (HELD) | `attendance_snapshots`, `attendance_snapshot_entries` | `/attendance/…`; `attendance.snapshot.recorded` |
| What counts as "present" | **nobody yet**: institutional policy ([Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot)) | not stored; entries are only CONNECTED or CONNECTING under a versioned rule | none |
| Institutional attendance record | operations (contract only, on hold) | nothing yet | `operations/contracts`, unchanged |
| Online app connections | realtime | process memory | none |
| Audit trail | platform table, written by each module's journal | `audit_log` | `AUDIT_LOG` |
| Notification rows | notifications | notifications tables | `NOTIFICATION_READER` |

---

## 3. Dependency graph

### 3.1 The graph as a matrix

Rows import columns, and rows and columns follow the same order. Every mark
sits left of the diagonal, so every edge points to an earlier module and no
cycle is possible.

```
 importer ↓ / imported →   identity  files  academic  communities  messaging  live  attendance  notifications  realtime
 identity                     ·
 files                        ●         ·
 academic                     ●                ·
 communities *                ◆                          ·
 messaging                    ●         ●                ◆              ·
 live                         ●                          ◆                         ·
 attendance *  (HELD, P9)     ◆                          ◆                         ◆       ·
 notifications                ●                          ◇              ●          ◇       ◇            ·
 realtime                     ●                          ◆              ●          ◆                    ●              ·
 operations (future, Q70)                                                                  ◇

 ● exists today   ◆ new edge (P2–P9)   ◇ future, contracts only (notifications P10 after Q67/Q28; operations only if Q70)
 platform and database are @Global and import no business module; app.module imports every module.
```

### 3.2 Edges

| From | To | Via | New? |
| --- | --- | --- | --- |
| academic | identity | `AcademicModule` imports `IdentityModule` (`academic.module.ts:76`) | existing |
| files | identity | `files.module.ts:32` | existing |
| messaging | identity, files | `messaging.module.ts:62` | existing |
| notifications | identity, messaging | `notifications.module.ts:64`; `MESSAGE_RECIPIENTS`, `MessagingEvents` | existing |
| realtime | identity, messaging, notifications | `realtime.module.ts:34` | existing |
| live | identity | `live.module.ts:37`; `AUTHORIZATION_SERVICE`; from P1 also `ACCOUNT_DIRECTORY` (display names, batched `withPermission`) | existing |
| `live/infrastructure/livekit-rtc-provider.ts` | `livekit-server-sdk` | the only SDK importer; enforced from P0 by `livekit-sdk-only-in-the-live-adapter` | existing |
| communities | identity | `CommunitiesModule` imports `IdentityModule` only. Code imports `identity/contracts/{authorization,account-directory,permissions}.ts`, never the barrel. Ceilings with context `{resourceType 'communities.community', resourceId, attributes {act}}`; eligibility and holder filtering through `ACCOUNT_DIRECTORY` | **new** |
| communities | shared, platform | `AUDIT_LOG`, `EVENT_PUBLISHER`, `RATE_LIMITER`, `CLOCK`, `ID_GENERATOR`, `Result`, `Principal`; `DATABASE`, `APP_CONFIG` in wiring | **new** |
| messaging (application only) | communities | `COMMUNITY_AUTHORIZATION` (`community.chat.read`, `community.chat.post`); `COMMUNITY_MEMBERSHIP` (`heads`, `listHeads`, `statesOf`, `changesSince`, `members`); `COMMUNITY_DIRECTORY`; the constant `COMMUNITY_CHAT_READ_CEILING` (P4); subscribes to `communities.member.added` / `.removed` as wake-ups. Never from `messaging/domain` | **new** |
| live (application) | communities | `COMMUNITY_AUTHORIZATION` (`community.live.start`, `.host`, `.moderate`, `.join`, `.raise_hand` per request; `permittedAmong` for `.join`, `.remain`, `.moderate` and `.host` in batches of 1,000 for the reconciler and `LIVE_AUDIENCE`); `COMMUNITY_MEMBERSHIP` (`heads` for session-wide effects); `COMMUNITY_CAPABILITY_HOLDERS` (moderators); subscribes to `communities.member.removed`, `communities.capability.revoked`, `communities.community.locked`/`unlocked` as accelerators | **new** |
| realtime | communities | `CommunitiesRealtimeRelay`: `COMMUNITY_MEMBERSHIP.members` (`OnlineAudience`), `CommunityEvents` | **new** |
| realtime | live | `LiveRealtimeRelay`: `LIVE_AUDIENCE`, `LiveEvents` | **new** |
| attendance (P9) | live | `LIVE_SESSIONS.describe`, `LIVE_PRESENCE.observe` | **new** |
| attendance (P9) | communities | `COMMUNITY_AUTHORIZATION` (`community.attendance.record`, `.view`, added in P9; then, in the fallback order of [attendance.md §11.3](attendance.md#113-attendanceaccess-how-refusals-map), `community.live.moderate`, `community.live.host` and `community.view`) | **new** |
| attendance (P9) | identity | `ACCOUNT_DIRECTORY.describe`; route-access decorators | **new** |
| `app.module.ts` | communities, attendance | registration (P2, P9) | **new** |
| notifications (P10) | communities, live, attendance contracts | translators import only `contracts/`; recipients from `COMMUNITY_MEMBERSHIP` or `COMMUNITY_CAPABILITY_HOLDERS` | future |
| operations (only if Q70) | attendance | `attendance/contracts`; attendance never depends on operations | future |
| Flutter `lib/features/*` | abstract repositories, `realtime_client.dart` + `realtime_frames.dart`, the `LiveMediaClient` interface | Riverpod providers; implementations bound only in `app_providers.dart` | **new** |

### 3.3 Topological order and the cycle proof

**Nest-module level.** Today, read from every `*.module.ts`: Identity →
[JwtModule]; Files → [Identity]; Academic → [Identity]; Live → [Identity];
Messaging → [Identity, Files]; Notifications → [Identity, Messaging];
Realtime → [Identity, Messaging, Notifications]; People, Operations,
Assignments, Automation and Reporting are empty `@Module({})`. After all
phases:

- Communities → [Identity]
- Messaging → [Identity, Files, Communities]
- Live → [Identity, Communities]
- Attendance → [Identity, Communities, Live]
- Realtime → [Identity, Messaging, Notifications, Communities, Live]
- Notifications: unchanged. P10 adds contract-level subscriptions; if a
  recipient token is needed, the new edge is Notifications → Communities,
  still acyclic.

Topological order: **Platform, Database → Identity → Files, Academic,
Communities → Messaging, Live → Notifications, Attendance → Realtime →
AppModule.** Every module imports only modules earlier in the order, so the
graph is a DAG. Notifications and Attendance do not depend on each other; the
matrix above lists Attendance first because P10's translators will read
attendance contracts. No `forwardRef` exists today; a proposed P0 test would
forbid it. No token is provided outside the module that declares it.

**File level** (the contracts layer is the only cross-module surface besides
`*.module.ts`):

- `identity/contracts` → `shared`.
- `communities/contracts` → `shared` (`Result`, `Principal`) and
  `identity/contracts/permissions.ts` only.
- `live/contracts` → `shared`. Payloads carry `communityId` as a plain string,
  with no import.
- `attendance/contracts` → `shared`. `messaging/contracts`: unchanged.
- No contract imports the contract of a module that depends on it.
- Application layers: messaging → communities contracts; live → communities
  and identity contracts; attendance → live, communities and identity
  contracts; realtime → messaging, notifications, identity, communities and
  live contracts.

`no-circular` (`.dependency-cruiser.cjs:17-23`) also catches Nest cycles,
because every Nest import is a file import between `*.module.ts` files.

### 3.4 Back-edges, and the rule that forbids each

| Back-edge that would close a cycle | Forbidden by |
| --- | --- |
| communities → messaging, live, attendance, realtime, notifications, academic | new `communities-boundaries.spec`. `communities.module.ts` is checked with `edgesFrom`, because `reachableFrom` skips `*.module.ts` (`test/support/dependency-graph.ts:81`) |
| live → messaging, realtime, notifications, attendance, academic, operations | new `live-boundaries.spec`, plus `notifications-boundaries.spec` |
| messaging → live, even transitively | `messaging-boundaries.spec.ts:43-50` stays green, because `communities/contracts` never reach live |
| anything → realtime except `app.module` | `realtime-boundaries.spec.ts:118-123` |
| anything → attendance except `app.module` | new `attendance-boundaries.spec` |
| identity → communities | identity stays ignorant of communities (the same spec family) |

**Candidate edges from an earlier draft of this design that would have
closed a cycle, all rejected:**

- `GET /groups/:id` carrying `activeLiveSessionId` needs Communities → Live;
  with Live → Communities that is a cycle. The client composes
  `GET /live/communities/:id/sessions/current` instead.
- Communities pushing members into a Messaging provisioning port needs
  Communities → Messaging; with Messaging → Communities (posting and
  readability questions) that is a cycle. Messaging pulls instead.
- Communities contributing `PolicyRule`s to Identity needs Identity →
  Communities providers; with Communities → Identity that is a cycle.

**Evidence required in P0 and P2:** depcruise reports 0 errors; a Nest wiring
smoke test (AppModule compiles; `MessagingModule` and `LiveModule` resolve
`COMMUNITY_AUTHORIZATION`; `CommunitiesModule.imports` equals
`[IdentityModule]`); the no-`forwardRef` test is green.

---

## 4. Domain model

```
 communities                                         messaging
 ───────────                                         ─────────
 Community 1──n MembershipStint 1──n CapabilityGrant   Conversation (CHANNEL, community_id)
   │  status OPEN|LOCKED   │ status ACTIVE|LEFT|REMOVED     │ member_count: the capacity switch
   │  lifecycle_version    │ standing OWNER|MEMBER          1──n projected participant rows
   │  membership_version   │ source ADDED|INVITATION             (source_version, source_membership_id,
   │  member_count         │ version (unique per community)       source_joined_at; shape CHECK)
   └─1──n InvitationLink ──admits──▶ stint (source INVITATION)
          token_hash, expires_at, max_uses, uses, revoked_*; state derived

 live                                                attendance (HELD)
 ────                                                ────────────────
 LiveSession ── communityId (plain id) ──────────▶ community
   │ state live|ended, state_version, hostUserId,    AttendanceSnapshot ── liveSessionId, communityId
   │ participantCap, moderatorReserve, mediaRoomEpoch  │ observation_rule, observedAt, counts
   ├─1──n SpeakerRequest  pending|granted|revoked|      └─1──n Entry (userId, CONNECTED|CONNECTING)
   │                      withdrawn|declined|expired
   ├─1──0..1 open PresenterGrant
   └─1──n ModerationAction
 Cross-module references are plain ids. No aggregate holds another module's object.
```

| Module | Aggregates and entities | State machines | Detail |
| --- | --- | --- | --- |
| communities | `Community` (small; never holds its members); `MembershipStint` (entity; consistency boundary is the (community, user) pair); `Invitation` (aggregate; state derived: REVOKED, else EXPIRED, else EXHAUSTED, else ACTIVE); `CapabilityGrant` (separate small aggregate keyed to a stint, so a grant never locks the community row); `CommunityPermit` (a value, never stored) | Community OPEN ⇄ LOCKED (a repeat is "unchanged"). Stint ∅ → ACTIVE → LEFT or REMOVED (terminal; a rejoin is a new stint). Grant ACTIVE → ENDED (`revoked`, `membership_ended`, `ownership_changed`). Standing MEMBER ⇄ OWNER only by transfer | [communities.md](communities.md) |
| messaging | Unchanged aggregates. NEW: the link and the projection rows, applied as a last-writer-wins register keyed by the authority's version, with tombstones; `source_membership_id` decides rejoins; `member_count` feeds the capacity switch | none new | [community-chat.md](community-chat.md) |
| live | `LiveSession` (replaces `LiveRoom`; `scheduled` is dropped); `SpeakerRequest`; `PresenterGrant`; `ModerationAction`; `capabilitiesFor` (total) | Session live → ended. Request pending → granted / declined / withdrawn / expired; granted → revoked / withdrawn / expired. Presenter open → closed (`stopped`, `revoked`, `session_ended`, `ineligible`) | [live.md](live.md) |
| attendance | `AttendanceSnapshot` (header plus entries; immutable) | none: created once, never changed | [attendance.md](attendance.md) |

---

## 5. Aggregate and consistency boundaries

### 5.1 Which transaction owns which invariant

| Boundary | Invariant | Enforced by | Transaction |
| --- | --- | --- | --- |
| Community row | A status change moves `lifecycle_version` by exactly 1 | `UPDATE … WHERE status = $from` | lock/unlock |
| Community row | `member_count` = count(ACTIVE stints); membership versions unique and in commit order | moved in the same transaction as every stint change; versions allocated under the community row lock, held to commit | every membership change |
| Stint pair (community, user) | At most one ACTIVE stint | partial unique index + per-pair advisory transaction lock | add, redeem, remove, leave |
| Stint | One OWNER per community; the owner is ACTIVE | partial unique index; CHECK; transfer demotes then promotes in one transaction | create, transfer |
| Invitation row | `uses ≤ max_uses`; revoked, expired or locked admits no one | one conditional UPDATE, re-evaluated by Postgres after a concurrent writer; CHECK backstop | redeem, revoke |
| Grant (P3) | One ACTIVE grant per (stint, capability); its community and user equal its stint's; no self-grant; ended with its stint | partial unique index; composite FK; CHECK; stamped in the removal transaction | grant, revoke, remove, leave, transfer |
| Conversation (messaging) | At most one chat per community | partial UNIQUE on `community_id`; `INSERT … ON CONFLICT DO NOTHING` | materialization |
| Projection rows | Never go backwards; `projected_membership_version` monotonic and contiguous | per-row version guard in the DB; `greatest()` advance; batches ≤ 1,000 under the conversation row lock | projection apply |
| LiveSession row | At most one live session per community; `state_version` +1 per change; end closes every hand, floor and presenter grant | partial unique index; session row `FOR UPDATE`; set-based UPDATEs | start, end, grant, presenter |
| SpeakerRequest | One open request per (session, user); at most 4 speakers ([Q4](open-questions.md#q4--how-many-concurrent-speakers-and-in-what-order)) | partial unique index; session row `FOR UPDATE`, then count | raise, grant |
| PresenterGrant | At most one open per session | partial unique index; session row `FOR UPDATE` | claim |
| AttendanceSnapshot | Idempotent per (session, recorder, client key); header and entries atomic; one entry per account; immutable | UNIQUE; one transaction; PK (snapshot, user); no update path | record |

### 5.2 The global lock order (communities)

1. per-pair advisory locks, sorted by the computed lock key and deduplicated
   (not by user id: two pairs whose 32-bit hashes collide would otherwise be
   taken in opposite orders by two batch adds, and deadlock;
   [communities.md §4](communities.md#the-global-lock-order));
2. the invitation row;
3. existing stint rows, in ascending id;
4. grant rows;
5. the community row — the last existing row locked; its UPDATE allocates
   versions and moves `member_count`;
6. new rows: stint, invitation or grant inserts.

Grant, revoke and transfer never touch the community row. Every
capability-authorized mutation re-verifies its basis under lock (the actor's
stint and grant `FOR SHARE`), so two delegates can never remove each other in
one interleaving. The concurrency suite proves deadlock freedom under a
`statement_timeout` rather than assuming it. Sequence:
[Appendix A1](#a1-join-through-an-invitation-link-then-open-the-chat).

### 5.3 Across modules

**No transaction spans two modules or a provider call.** Each cross-module
flow has one serialization point:

- **Removal:** the commit in Communities. Every later request in Messaging or
  Live is refused because each asks `COMMUNITY_AUTHORIZATION`. One request
  whose permit was read before the commit may still complete (one send, one
  token); it is audited with the permit it ran under. This is documented, not
  hidden ([Appendix A5](#a5-a-removed-member-loses-chat-and-live-access)).
- **Live and LiveKit:** own state first, provider second; the reconciler
  converges the provider to the record (Q5).
- **Attendance:** observation first, then one short transaction; nothing is
  written before the observation succeeds.
- **Messaging never calls Communities while holding its conversation row
  lock,** and the community row and the conversation row are never held in one
  transaction.

---

## 6. Persistence proposal

**PROPOSAL.** No migration, table or seed exists. Every table is private to
its module and touched only by that module's infrastructure. There is **no
foreign key across modules**: user, community and session ids cross as plain
text, pinned per module by a `pg_constraint` test. Ids are text, timestamps
`timestamptz` from the injected clock, isolation READ COMMITTED (the project
default). Nothing is deleted; retention is
[Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history).
In-memory adapters implement the same ports for mock mode. No Redis.

| Module | Table (PROPOSAL) | Key constraints | Phase |
| --- | --- | --- | --- |
| identity | no structural change | data migration **0009**: 4 permissions and their PROVISIONAL grants (Q41, Q43, Q44), in the 0008 pattern | P2 |
| communities | `communities` | status CHECK (`OPEN`, `LOCKED`); `lifecycle_version ≥ 1`; `membership_version ≥ 0`; `member_count ≥ 0` with **no upper bound**; no owner column; `(created_at, id)` index | P2 |
| communities | `community_members` (one row per stint) | status, standing (`OWNER`, `MEMBER`), source (`ADDED`, `INVITATION`), `version`; UNIQUE (community_id, version); partial unique ACTIVE per pair; partial unique OWNER per community; owner-is-active CHECK; ended/joined consistency CHECKs; roster, "mine", history and invitation indexes | P2 |
| communities | `community_invitations` | `token_hash` UNIQUE with a 64-hex shape CHECK; `expires_at > created_at`; `0 ≤ uses ≤ max_uses`; no status column (state derived) | P2 |
| communities | `communities_capability_grants` | closed-vocabulary CHECK; no-self-grant CHECK; terminal-consistency CHECKs; composite FK (stint id, community, user) to the stint; partial unique ACTIVE per (stint, capability) | P3 |
| messaging | `conversations` + `community_id`, `projected_membership_version` | partial UNIQUE on `community_id`; shape CHECK (both null or both set; never DIRECT); the title CHECK changes (a community chat stores no title); **the type CHECK is unchanged** | P4 |
| messaging | `conversation_participants` + `source_version`, `source_membership_id` (the stint id; decides rejoins), `source_joined_at` (provenance only) | shape CHECK `conversation_participants_source_shape` over the three `source_*` columns (all NULL or all set; `source_version > 0`; such rows are MEMBER with `added_by` NULL); new partial index on current participants (**G2**) | P4 |
| live | `live_sessions` | `community_id`, `host_user_id`, state (`live`, `ended`), `state_version`, end reason (`moderator`, `idle`, `community_closed`), `participant_cap`, `moderator_reserve`, `media_room_epoch`, reconciler bookkeeping; partial unique one live session per community | P6 |
| live | `live_speaker_requests` | six-state CHECK; partial unique one open request per (session, user); FCFS queue, speaker and floor-closed indexes | P6 |
| live | `live_presenter_grants` | partial unique one open grant per session; end-reason CHECK | P6 |
| live | `live_moderation_actions` | type CHECK; reason is a code, never free text | P6 |
| live | `live_worker_leases` | only with a second API instance | P11 |
| attendance | `attendance_snapshots` | UNIQUE (live_session_id, recorded_by, client_request_id); key-shape CHECK; rule CHECK (`provider_registry_v1`); counts ≥ 0; time-order CHECK; community and session keyset indexes | P9 |
| attendance | `attendance_snapshot_entries` | PK (snapshot_id, user_id); connection CHECK (`CONNECTED`, `CONNECTING`); in-module FK to the header | P9 |

Migration numbers other than 0009 are the next free numbers when each phase
lands. Details: [communities.md](communities.md),
[community-chat.md](community-chat.md), [live.md](live.md),
[attendance.md](attendance.md).

---

## 7. Public contracts

### 7.1 Catalogue

| Contract | Module | Kind | Phase | Consumers |
| --- | --- | --- | --- | --- |
| Permission catalogue + `PROVISIONAL_ROLE_PERMISSIONS` + migration 0009 | identity | extend | P2 | communities (ceilings, eligibility); `@RequirePermission` on routes |
| `PROVISIONAL_POLICY_RULES` → `[]` | identity (internal) | modify | P6 | identity only; Live stops passing `ownerUserId` |
| `capabilities.ts` (acts, guards) | communities | new | P2 | messaging, live, attendance, realtime (types), Flutter (wire strings) |
| `COMMUNITY_CHAT_READ_CEILING` (in `capabilities.ts`): the one Communities contract addition P4 needs | communities | extend | P4 | messaging (`MESSAGE_RECIPIENTS`, two `withPermission` calls per non-empty community-chat page); Communities' own act table |
| `COMMUNITY_AUTHORIZATION` | communities | new | P2 (grant basis P3; `permittedAmong` P6) | messaging, live, attendance, communities' own use cases |
| `COMMUNITY_MEMBERSHIP` | communities | new | P2 | messaging, live, realtime, notifications (P10) |
| `COMMUNITY_DIRECTORY` | communities | new | P2 | messaging |
| `COMMUNITY_CAPABILITY_HOLDERS` | communities | new | P3 | live; notifications later |
| `CommunityEvents`, `vocabulary.ts` | communities | new | P2 | messaging, live, realtime |
| `MessagingModule` wiring | messaging | extend | P4 | Nest composition |
| `MESSAGE_RECIPIENTS` (comment only) | messaging | modify | P4 | realtime, notifications (unchanged) |
| `ConversationResponse.communityId` + new route | messaging | extend | P4 | Flutter |
| Failure vocabulary for community chats (412 `messaging.membership_managed_by_community`; 412 `messaging.community_chat_over_capacity` from the capacity switch, the deployment setting `communityChatMaxServedMembers`) | messaging | modify | P4 | clients |
| `LiveEvents` (moved to contracts, then extended) | live | modify | P0, P6 | realtime, attendance, notifications later |
| `LiveParticipantRole` | live | modify | P1 | live views, Flutter |
| `LIVE_AUDIENCE` | live | new | P6 | realtime |
| `LIVE_SESSIONS` | live | new | P6 | attendance |
| `LIVE_PRESENCE` | live | new | P9 | **attendance only** (allow-list test) |
| RTC ports (`RtcCapabilities` and four narrow ports) | live (internal) | modify | P1, P6, P9 | live application only |
| `AppConfig.live` + pinned LiveKit config | platform | extend | P6 | live |
| `AttendanceEvents` | attendance | new | P9 | none built |
| `FailureKind 'unavailable'` → 503 | shared, platform | extend | P0 | live, communities consumers, attendance |
| Protocol v1 server frames | realtime | extend | P5, P7 | Flutter |
| `ConnectionManager.onlineUserIds()`, `OnlineAudience` | realtime (internal) | new | P5 | all relays |
| `.dependency-cruiser.cjs` rules | architecture | modify | P0 | CI |
| Repositories, frame families, `LiveMediaClient` | app | new | P5, P7, P9 | Flutter screens and controllers |
| `operations/contracts/index.ts` doc comment | operations | modify | P0 | readers |

### 7.2 Identity

```ts
// identity/contracts/permissions.ts — ALL_PERMISSIONS goes from 30 to 34; every name matches ^[a-z]+[.][a-z_]+$
communities: {
  read: 'communities.read';
  create: 'communities.create';
  moderate: 'communities.moderate';
  manage: 'communities.manage';
}
// identity/domain/provisional-policy.ts (internal), in P6, in the SAME change that ships LiveAccess:
export const PROVISIONAL_POLICY_RULES: readonly PolicyRule[] = Object.freeze([]);
// restrictToResourceOwner and ownerOfResourceRule stay in policy.ts with their specs.
// role.spec invariants: create ⇒ moderate ⇒ read; manage ⇒ read.
// attendance.oversee is NOT added; no new module exercises attendance.*.
```

PROVISIONAL grants ([Q41](open-questions.md#q41--what-is-a-community-and-who-may-create-one),
[Q43](open-questions.md#q43--institutional-oversight-of-communities),
[Q44](open-questions.md#q44--who-may-hold-delegated-capabilities)):

| Role | `communities.read` | `.create` | `.moderate` | `.manage` |
| --- | --- | --- | --- | --- |
| OWNER, ADMIN (derived from `ALL_PERMISSIONS`, `provisional-policy.ts:35`, `:42-45`) | ✓ | ✓ | ✓ | ✓ |
| TEACHER | ✓ | — | ✓ | — |
| SUPERVISOR, ASSISTANT_TEACHER, STUDENT | ✓ | — | — | — |
| PARENT and the other inactive roles | — | — | — | — |

### 7.3 Communities

```ts
// communities/contracts/capabilities.ts
export const COMMUNITY_RESOURCE = 'communities.community';
export const COMMUNITY_CAPABILITIES = [
  'community.members.view', 'community.members.invite', 'community.members.remove',
  'community.lock', 'community.chat.post', 'community.live.start', 'community.live.moderate',
] as const;
// Reserved, added in P9 with a CHECK migration: 'community.attendance.record', 'community.attendance.view'.
// Reserved until Q51/Q23: 'community.messages.moderate'.
export type CommunityCapability = (typeof COMMUNITY_CAPABILITIES)[number];
export const COMMUNITY_PARTICIPATION = [
  'community.view', 'community.chat.read', 'community.live.join', 'community.live.raise_hand',
] as const;
/** community.live.host: backed by community.live.start, the session host's moderation of their own session.
 *  community.live.remain (P6): staying in a running session; the ceiling and basis of community.live.join,
 *  allowed while runningLiveContinues instead of liveJoinOpen. */
export const COMMUNITY_DERIVED_ACTS = ['community.live.host', 'community.live.remain'] as const;
export type CommunityAct =
  | CommunityCapability
  | (typeof COMMUNITY_PARTICIPATION)[number]
  | (typeof COMMUNITY_DERIVED_ACTS)[number];
export function isCommunityCapability(v: string): v is CommunityCapability;
export function isCommunityAct(v: string): v is CommunityAct;
/** P4. The identity permissions of the community.chat.read ceiling (PROVISIONAL, §8.2). The act rules use it,
 *  and Messaging narrows every community-chat page of MESSAGE_RECIPIENTS with it, one
 *  ACCOUNT_DIRECTORY.withPermission call per permission, so the two paths cannot drift. The one Communities
 *  contract addition P4 needs. */
export const COMMUNITY_CHAT_READ_CEILING: readonly Permission[] = ['communities.read', 'messaging.read'];
// Disjoint from identity: isPermission(act) is false for every act, no identity namespace is `community`,
// and CommunityAct and Permission share no member (each tested). Segment count is not the guard:
// community.view and community.lock have two segments and would match identity's CHECK.

// communities/contracts/authorization.ts
export const COMMUNITY_AUTHORIZATION = Symbol('COMMUNITY_AUTHORIZATION');
export const MAX_AUTHORIZE_BATCH = 1000;
export type CommunityAuthorityBasis = 'membership' | 'owner' | 'grant' | 'oversight';
export interface CommunityPermit {
  readonly principalUserId: string;
  readonly communityId: string;
  readonly scope: typeof COMMUNITY_RESOURCE;
  readonly act: CommunityAct;
  readonly basis: CommunityAuthorityBasis;
  readonly membership: { readonly membershipId: string; readonly joinedAt: Date; readonly version: number } | null; // null iff basis === 'oversight'
  readonly grantId: string | null; // non-null iff basis === 'grant'
  readonly ceiling: readonly Permission[]; // identity permissions required and held on the path taken
}
export interface CommunityAuthorization {
  authorize(principal: Principal, communityId: string, act: CommunityAct): Promise<Result<CommunityPermit>>;
  /** At most MAX_AUTHORIZE_BATCH ids (RangeError above); O(1) statements; unknown ids → not_found. */
  authorizeEach(principal: Principal, communityIds: readonly string[], act: CommunityAct):
    Promise<ReadonlyMap<string, Result<CommunityPermit>>>;
  /** P6. Trusted and principal-less, for Live's reconciler and LIVE_AUDIENCE: of userIds (≤ MAX_AUTHORIZE_BATCH),
   *  those the act's ceiling (ACCOUNT_DIRECTORY.withPermission), owner, grant or membership basis (never
   *  oversight) and statePermits accept. Consumers keep no copy of the act rules. */
  permittedAmong(communityId: string, userIds: readonly string[], act: CommunityAct): Promise<readonly string[]>;
}

// communities/contracts/membership.ts — trusted in-process, no principal (the MESSAGE_RECIPIENTS stance)
export const COMMUNITY_MEMBERSHIP = Symbol('COMMUNITY_MEMBERSHIP');
export const MAX_MEMBER_PAGE = 1000;
/** PROVISIONAL table owned by communities (Q46). Consumers never see the raw status. */
export interface LifecycleEffects {
  readonly acceptsMembers: boolean; readonly chatReadable: boolean; readonly chatPostingOpen: boolean;
  readonly liveStartOpen: boolean; readonly liveJoinOpen: boolean; readonly runningLiveContinues: boolean;
}
export interface CommunityHead {
  readonly communityId: string; readonly membershipVersion: number;
  readonly lifecycleVersion: number; readonly effects: LifecycleEffects;
}
export interface MemberState {
  readonly communityId: string; readonly userId: string; readonly membershipId: string;
  readonly active: boolean;
  readonly joinedAt: Date;   // this stint's start; a rejoin is a new stint
  readonly version: number;  // > 0, unique per community, commit order
}
export interface MembershipChanges {
  readonly states: readonly MemberState[]; // ascending version, latest per user
  readonly head: CommunityHead;            // same snapshot
  readonly throughVersion: number;
  readonly hasMore: boolean;
}
export interface CommunityMembership {
  heads(communityIds: readonly string[]): Promise<readonly CommunityHead[]>; // ≤ 1000; unknown ids absent
  listHeads(page: { readonly afterCommunityId?: string; readonly limit: number }):
    Promise<{ readonly items: readonly CommunityHead[]; readonly next: string | null }>;
  statesOf(communityId: string, userIds: readonly string[]): Promise<readonly MemberState[]>; // ≤ 1000; latest stint per user
  changesSince(communityId: string, afterVersion: number, limit: number): Promise<MembershipChanges | null>; // ONE statement; null = unknown
  members(communityId: string, page: {
    readonly onlyUserIds?: readonly string[]; readonly excludeUserId?: string;
    readonly cursor?: string | null; readonly limit: number;
  }): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>; // ACTIVE, user-id order
}
// No member count and no "load all": membership never sizes a live room.

// communities/contracts/directory.ts — display only, never an access answer
export const COMMUNITY_DIRECTORY = Symbol('COMMUNITY_DIRECTORY');
export interface CommunitySummary { readonly communityId: string; readonly title: string }
export interface CommunityDirectory { describe(communityIds: readonly string[] /* ≤ 1000 */): Promise<readonly CommunitySummary[]> }

// communities/contracts/capability-holders.ts (P3) — owner (implicit) + ACTIVE grants on ACTIVE stints,
// filtered by the act's ceiling through ACCOUNT_DIRECTORY.withPermission; never institution overseers
export const COMMUNITY_CAPABILITY_HOLDERS = Symbol('COMMUNITY_CAPABILITY_HOLDERS');
export const MAX_HOLDER_PAGE = 1000;
export interface CommunityCapabilityHolders {
  list(communityId: string, capability: CommunityCapability, page: { readonly cursor?: string | null; readonly limit: number }):
    Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}

// communities/contracts/events.ts and vocabulary.ts
export const CommunityEvents = {
  communityCreated: 'communities.community.created', communityLocked: 'communities.community.locked',
  communityUnlocked: 'communities.community.unlocked', memberAdded: 'communities.member.added',
  memberRemoved: 'communities.member.removed', invitationCreated: 'communities.invitation.created',
  invitationRevoked: 'communities.invitation.revoked', capabilityGranted: 'communities.capability.granted',
  capabilityRevoked: 'communities.capability.revoked', ownershipTransferred: 'communities.ownership.transferred',
} as const;
// COMMUNITY_STATUSES ['OPEN','LOCKED']; MEMBERSHIP_STATUSES ['ACTIVE','LEFT','REMOVED'];
// MEMBERSHIP_STANDINGS ['OWNER','MEMBER']; MEMBERSHIP_SOURCES ['ADDED','INVITATION'];
// INVITATION_STATES ['ACTIVE','EXPIRED','EXHAUSTED','REVOKED'] (derived); type guards.
```

The PROVISIONAL `LifecycleEffects` table
([Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock)):

| Status | acceptsMembers | chatReadable | chatPostingOpen | liveStartOpen | liveJoinOpen | runningLiveContinues |
| --- | --- | --- | --- | --- | --- | --- |
| OPEN | T | T | T | T | T | T |
| LOCKED | F | T | F | F | T | T |
| unmapped | F | F | F | F | F | T (never eject on ignorance) |

### 7.4 Messaging

```ts
// messaging.module.ts
imports: [IdentityModule, FilesModule, CommunitiesModule]
providers += CommunityChatSync, CommunityChatSweeper, CommunityChatReconciler, GetCommunityChatUseCase
controllers += CommunityChatController
exports: [MESSAGE_RECIPIENTS, MESSAGE_DELIVERY]   // UNCHANGED. No forwardRef, no write or provisioning port.

// MESSAGE_RECIPIENTS: signature unchanged; its comment (message-recipients.ts:13-20) is amended:
// for a community chat, "current members" means messaging's named projection of Communities' ACTIVE members.
// - projected_membership_version ≠ heads().membershipVersion → each page is narrowed to the members
//   statesOf reports ACTIVE, and a sync is scheduled (the lag filter);
// - every page, whatever readersOnly says, is then narrowed to the accounts holding every permission of
//   COMMUNITY_CHAT_READ_CEILING: two ACCOUNT_DIRECTORY.withPermission calls per non-empty page;
// - unknown community, or effects.chatReadable false → { userIds: [], nextCursor: null }.

// ConversationResponse += { communityId: string | null }   (additive)
// For a community chat: type 'CHANNEL' (PROVISIONAL, Q51); title from COMMUNITY_DIRECTORY;
// canPost = the community.chat.post permit is granted and member_count is within communityChatMaxServedMembers
//   (the capacity switch); canManageMembers = false; myRole 'MEMBER';
// memberCount = the projection count (display, and the capacity switch; never an access answer).
```

For community chats, messaging's own membership routes refuse with
`precondition_failed 'messaging.membership_managed_by_community'` (HTTP 412,
evaluated after the membership check, so non-members still get 404); the
participant list returns the existing `403 messaging.members_hidden`; a send
without the `community.chat.post` permit returns the existing
`403 messaging.posting_not_allowed`; and a send to a community chat whose
`member_count` is above `communityChatMaxServedMembers` (the capacity switch,
PROVISIONAL default 250, [Q26](open-questions.md#q26--realtime-limits))
returns `412 messaging.community_chat_over_capacity`, after the post permit.
Reading, marking read and the projection are unaffected
([community-chat.md §11.2](community-chat.md#112-gates-g1g4)).
`messaging.conversation.created` and `messaging.participant.*` are raised
only for conversations messaging manages.
`ConversationType` stays closed (`'DIRECT' | 'GROUP' | 'CHANNEL'`).

### 7.5 Live

```ts
// live/contracts/events.ts — P0 moves today's names and payloads here byte-identically; P6 extends them.
export const LiveEvents = {
  sessionStarted: 'live.session.started', sessionEnded: 'live.session.ended',
  speakerRequested: 'live.speaker.requested', speakerWithdrawn: 'live.speaker.withdrawn',
  speakerDeclined: 'live.speaker.declined', speakerGranted: 'live.speaker.granted',
  speakerRevoked: 'live.speaker.revoked', speakerExpired: 'live.speaker.expired',
  screenShareStarted: 'live.screen_share.started', screenShareStopped: 'live.screen_share.stopped',
} as const;   // payloads in §14; aggregateId = sessionId

// live/contracts/participant-role.ts (P1) — replaces today's ParticipantRole = 'host' | 'speaker' | 'listener'
// (participant-role.ts:7), with no alias; only app.module imports live
export type LiveParticipantRole = 'moderator' | 'speaker' | 'listener'; // the host is a moderator; me.isHost says so

// live/contracts/live-audience.ts (P6)
export const LIVE_AUDIENCE = Symbol('LIVE_AUDIENCE');
export const MAX_AUDIENCE_PROBE = 1000;
export interface LiveAudience {
  /** Of userIds (≤ 1000): who may take part in this session now, ignoring session state. Unknown session → []. */
  participantsAmong(sessionId: string, userIds: readonly string[]): Promise<readonly string[]>;
  /** Keyset-paged, limit ≤ 1000; [] for an ended session. */
  moderators(sessionId: string, page: { readonly cursor?: string | null; readonly limit: number }):
    Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}
// participantsAmong = COMMUNITY_AUTHORIZATION.permittedAmong(C, ids, 'community.live.join') (its ceiling communities.read
//   + live.join, its basis and the lifecycle gate), or a moderator. Live keeps no copy of the rule.
// moderators = holders of community.live.moderate (COMMUNITY_CAPABILITY_HOLDERS, which applies the act's ceiling),
//   plus the host while permittedAmong(C, [hostUserId], 'community.live.host') accepts them.

// live/contracts/live-sessions.ts (P6) — Live's own record only; never calls the provider; no principal
export const LIVE_SESSIONS = Symbol('LIVE_SESSIONS');
export interface LiveSessionScope {
  readonly liveSessionId: string; readonly communityId: string; readonly hostUserId: string; readonly active: boolean;
}
export interface LiveSessions { describe(liveSessionId: string): Promise<LiveSessionScope | null> }

// live/contracts/presence.ts (P9) — importable only by attendance
export const LIVE_PRESENCE = Symbol('LIVE_PRESENCE');
export type ObservedConnection = 'connected' | 'connecting';
export type PresenceObservation =
  | { kind: 'observed'; liveSessionId: string; communityId: string; observationStartedAt: Date; observedAt: Date;
      participants: readonly { userId: string; connection: ObservedConnection }[] /* one per account, ascending userId */ }
  | { kind: 'not_found' } | { kind: 'not_active' } | { kind: 'unavailable' };
export interface LivePresence { observe(liveSessionId: string): Promise<PresenceObservation> } // exactly one provider read
// Rule 'provider_registry_v1': STANDARD participants mapping to an account; DISCONNECTED dropped; hidden kept;
// egress, ingress, SIP, agent and unmappable identities dropped and metered; ACTIVE → connected,
// JOINING/JOINED → connecting, connected wins; not_active if the record is not active before OR after the read;
// unavailable on provider error, the PROVISIONAL 15 s deadline, or above the PROVISIONAL 10,000-entry ceiling (Q72);
// PROVISIONAL concurrency 4 per process (Q72).

// live/domain/rtc-provider.ts (internal; not cross-module)
export interface RtcCapabilities {   // total; applied as LiveKit's FULL permission set every time
  readonly canPublishAudio: boolean; readonly canPublishScreen: boolean; readonly canPublishScreenAudio: boolean;
  readonly canSubscribe: boolean; readonly canPublishData: boolean /* always false */; readonly hidden: boolean /* false until Q59 */;
}
// RtcRoomProvider { ensureRoom(spec); endRoom(name) /* absent = success */; listRooms(names?) }
// RtcTokenIssuer { issueAccessToken(grant) }                       // TTL 600 s → 120 s
// RtcParticipantControl { updateCapabilities(room, identity, caps): Promise<'applied' | 'not_connected'>;
//                         removeParticipant(room, identity, opts?); muteParticipant (seam) }
// RtcParticipantObserver { listParticipants(room) /* DISCONNECTED dropped */; getParticipant(room, identity) }
// RtcProvider extends all four; RtcUnavailableError is a domain class.
// DI: RTC_PROVIDER, plus RTC_ROOMS, RTC_TOKENS, RTC_PARTICIPANTS, RTC_OBSERVER bound with useExisting.
// The adapter always sends an explicit source list plus canPublishData and hidden (an empty list means ALL
// sources in LiveKit, and a partial update resets hidden). It never sets roomAdmin, roomCreate or roomList.

// platform AppConfig.live (P6)
live: { maxParticipantsPerSession /* PROVISIONAL 300, Q57 */; moderatorReserve /* PROVISIONAL 10, Q57 */;
        roomNamePrefix /* required with the real adapter and unique per deployment, because the orphan sweep
                          deletes every prefixed room it does not know; boot refuses a missing value;
                          'live-' with the fake */ }
// LiveKit config kept in the repo: room.auto_create=false, enable_remote_unmute=false, empty and departure
// timeouts as backstop only, prometheus_port, no webhooks, a TURN placeholder (Q65).
```

### 7.6 Attendance, shared kernel, realtime, rules, operations

```ts
// attendance/contracts/events.ts (P9, HELD)
export const AttendanceEvents = { snapshotRecorded: 'attendance.snapshot.recorded' } as const;
export const SNAPSHOT_CONNECTIONS = ['CONNECTED', 'CONNECTING'] as const;
// The ATTENDANCE_SNAPSHOTS reader is deferred until its first consumer.

// shared/result.ts (P0)
export type FailureKind = /* the seven of result.ts:21-28 */ | 'unavailable';
// http-failure.ts STATUS_BY_KIND.unavailable = 503 (the exhaustive Record makes it compile-checked);
// all-exceptions.filter.ts KIND_BY_STATUS[503] = 'unavailable', CODE_BY_STATUS[503] = 'unavailable'.

// realtime (internal, P5)
onlineUserIds(): readonly string[];   // ConnectionManager: the keys of byUser
// OnlineAudience(page, connections): nobody connected → stop. Read page 1 (limit 1000). nextCursor null →
// return its online members. Otherwise the union of page({ onlyUserIds: chunk }) over chunks of 1000 online
// accounts. Cost: at most 1 + ⌈A/1000⌉ calls. MessagingRealtimeRelay.onlineMembers moves onto it.
```

- **Protocol v1 server frames** are listed in [§16.2](#162-frames-added-to-protocol-v1).
- **`.dependency-cruiser.cjs`** (P0): the corrected
  `application-has-no-vendor-sdks` path is
  `^node_modules/(@types/)?(livekit-server-sdk|@livekit/[^/]+|drizzle-orm|pg|ioredis|express|@nestjs/platform-express|nestjs-pino|pino|ws|socket[.]io|@nestjs/websockets|@nestjs/platform-ws|@nestjs/platform-socket[.]io|firebase|firebase-admin|@firebase/[^/]+|apn|@parse/node-apn|node-apn|web-push|node-pushnotifications)/`;
  the new `livekit-sdk-only-in-the-live-adapter` rule forbids
  `^node_modules/(@types/)?(livekit-server-sdk|@livekit/[^/]+)/` from
  `^src/` except `^src/modules/live/infrastructure/`. Both report 0 violations
  on today's graph.
- **`operations/contracts/index.ts:1-6`**: the comment stops claiming that
  operations records attendance from `live.session.*`. Types unchanged.
- **Flutter contracts**: [§17](#17-flutter-architecture).

---

## 8. Authorization model

The detail, truth table and race rules are in [communities.md](communities.md)
and [ADR 0017](decisions/0017-community-scoped-authorization.md).

### 8.1 The rule

```
  effective(P, C, act) = identity ceiling(act)              role-wide; AuthorizationService, in memory
                     AND Communities standing(P, C, act)    membership | owner | grant | oversight
                     AND lifecycle gate(status, act)        statePermits; never blocks community.lock
```

This is the existing ceiling-plus-relationship pattern
(`academic-access.ts:68-84`, `conversation-access.ts:58-72`). Grants only
narrow: nothing Communities says can confer a power identity never granted.
ADR 0005's rejection of per-resource ACLs in identity stands.

**Four bases**, first match wins:

| Basis | Satisfies | Source |
| --- | --- | --- |
| `membership` | participation acts (`view`, `chat.read`, `live.join`, `live.raise_hand`) | the caller's ACTIVE stint |
| `owner` | every capability within the owner's ceilings | `standing = 'OWNER'` on the ACTIVE stint |
| `grant` | the granted capability | an ACTIVE grant keyed to the ACTIVE stint (a rejoin never revives it) |
| `oversight` | a fixed, read-mostly set, never entry | `communities.manage` ([Q43](open-questions.md#q43--institutional-oversight-of-communities)) |

**Evaluation** (the pure `decideCommunityAct` plus one statement on the
primary):

1. Identity ceilings for the standing path and the oversight path, checked in
   memory with context `{resourceType, resourceId, attributes: {act}}`.
   Neither held → `forbidden 'identity.permission_denied'`, and nothing is
   read.
2. One statement: the community status, the caller's ACTIVE stint, and the
   ACTIVE grant for the act.
3. The basis, first match wins.
4. No basis → `not_found 'communities.community_not_found'` when there is no
   ACTIVE stint (identical to a missing community); otherwise
   `forbidden 'communities.capability_required'`.
5. `statePermits(status, act)` → `precondition_failed
   'communities.community_locked'`.

System principals never have a stint. A store failure rejects the promise;
callers fail closed with 503 `unavailable` and never fall back to a role-only
answer. There is no cache across requests.

### 8.2 The act vocabulary (PROVISIONAL act rules)

The ceilings, the owner-implicit set, the oversight reach and the LOCKED
column are PROVISIONAL under Q41–Q46 and
[Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session).

| Act | Standing ceiling | Owner-implicit | Oversight | Allowed while LOCKED |
| --- | --- | --- | --- | --- |
| `community.view` | `communities.read` | participation | `communities.manage` | yes |
| `community.members.view` | `communities.moderate` | yes | `communities.manage` | yes |
| `community.members.invite` | `communities.moderate` | yes | none | no |
| `community.members.remove` | `communities.moderate` | yes | `communities.manage` | yes |
| `community.lock` (lock and unlock) | `communities.moderate` | yes | `communities.manage` | never blocked |
| `community.chat.read` | `communities.read` + `messaging.read` (`COMMUNITY_CHAT_READ_CEILING`) | participation | none | yes |
| `community.chat.post` | `communities.moderate` + `messaging.send` | yes | none | no |
| `community.live.start` | `communities.moderate` + `live.moderate` | yes | none | no |
| `community.live.host` (derived) | as `live.start` | as `live.start` | none | while `runningLiveContinues` |
| `community.live.moderate` | `communities.moderate` + `live.moderate` | yes | none | yes |
| `community.live.join` | `communities.read` + `live.join` | participation | none | yes |
| `community.live.remain` (derived, P6) | as `live.join` | participation | none | while `runningLiveContinues` |
| `community.live.raise_hand` | `communities.read` + `live.raise_hand` | participation | none | yes |
| `community.attendance.record`, `.view` | reserved; ceilings decided in P9 **without** `attendance.*` ([Q69](open-questions.md#q69--who-records-and-who-views-snapshots)) | — | none until Q43 says otherwise | Communities' answer governs |

Listing and revoking links carry an operation-level override: they are
admitted on the oversight basis and allowed while LOCKED, although
`community.members.invite` itself has no oversight path and is refused while
LOCKED ([communities.md §6.6](communities.md#66-which-act-each-communities-operation-asks)).
No new act name is introduced.

Delegation (P3, PROVISIONAL,
[Q44](open-questions.md#q44--who-may-hold-delegated-capabilities),
[Q45](open-questions.md#q45--capability-grants-duration-handover-and-visibility)):
only the owner grants and revokes; no sub-delegation; a grant needs the
grantee's ceilings and is dormant (not deleted) while they are missing; a
non-owner removes a member only if that member's ACTIVE grants are a subset of
the remover's effective capabilities, and never the owner. Ownership:
exactly one owner, transferable by the owner or by a `communities.manage`
holder to an eligible member other than themself
([Q42](open-questions.md#q42--community-ownership)).

**Oversight reach** (`communities.manage`, PROVISIONAL, Q43): view, list
members, lock and unlock, list and revoke links, remove members, recover
ownership (not to oneself). It never adds members, creates links, reads the
chat, acts in a live session or views attendance. Every oversight-basis read
is audited.

### 8.3 The fate of the host-only rule

- **What exists today:** `host-only-moderation`
  (`provisional-policy.ts:139-141`) denies `live.moderate` to everyone but a
  room's host whenever the caller passes `ownerUserId` with it
  (`restrictToResourceOwner`, `policy.ts:82-83`), as
  `moderate-speaker.use-case.ts:163-167` does.
  `join-live-session.use-case.ts:85-91` passes `ownerUserId` only for
  `live.speak`, which the rule does not cover, so it never fires there.
  Deny overrides (`policy.ts:50`), so it would refuse every delegated
  moderator, OWNER included.
- **The change (P6):** `PROVISIONAL_POLICY_RULES = []`, in the **same change**
  that ships Live's `LiveAccess` and stops passing `ownerUserId`. Moderation
  becomes: holders of `community.live.moderate` moderate any session of the
  community; the host (the starter) moderates their own session while
  `community.live.host` holds; delegated moderators act only on participants
  who are not the host
  ([Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session)).
  No identity role, OWNER included, moderates without community standing; the
  all-permission refusal test (`authorization.service.spec.ts:52-71`) moves to
  Live.
- **Why the same change:** an inert rule that stays registered is a trap —
  any future caller that passes `ownerUserId` would re-activate the OWNER
  veto. Shipping `LiveAccess` without retiring it would refuse every delegate.
- If accepted, ADR 0017 would revise Q1's provisional answer when P6 lands
  ([Q1](open-questions.md#q1--what-may-each-role-actually-do)).

### 8.4 Rules for every consumer

- The `communityId` is always read from a stored record (session, conversation,
  snapshot header), never from the client. A path id is only the scope being
  authorized; a mismatch with the stored record is `not_found`.
- The permit is copied into the acting module's audit metadata (`basis`,
  `grantId`, `membershipId`).
- A speaker or presenter grant is Live session state; it never confers a
  community act (a test asserts it).
- The realtime connection gate stays `messaging.read`
  (`realtime-sessions.ts:443`); a test pins that every role holding `live.join`
  or `communities.read` also holds `messaging.read`
  ([Q66](open-questions.md#q66--realtime-without-messagingread)).

---

## 9. Invitation design

Invitation links are first-class Communities objects: a 32-byte random token,
base64url, shown once; only its SHA-256 is stored and state is derived.
Redemption is `POST /communities/join {token}`: one READ COMMITTED
transaction of conditional UPDATEs under the per-pair advisory lock —
idempotent for existing members, linearizable against `max_uses`, revocation
and lock, never creating an account, and re-checking that the link's creator
still holds `community.members.invite`
([Q48](open-questions.md#q48--invitation-links)): from P2, the creator's
identity ceiling (`withPermission`) and that the creator's stint is the
ACTIVE OWNER; P3 adds only the grant lookup, for a creator who holds the act
by delegation. From P2, a demoted creator's link fails as 404
`communities.invitation_invalid`. Terms, races and refusals:
[communities.md](communities.md). Sequence:
[Appendix A1](#a1-join-through-an-invitation-link-then-open-the-chat).

## 10. Community lifecycle

OPEN ⇄ LOCKED; ARCHIVED is deferred and a community is never deleted
(PROVISIONAL, [Q47](open-questions.md#q47--retiring-a-community)). What LOCKED means is one PROVISIONAL table owned by Communities
(`statePermits` plus `LifecycleEffects`, [§7.3](#73-communities),
[Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock)); no
consumer sees the raw status. Detail: [communities.md](communities.md).

## 11. Live session lifecycle

`live` → `ended` (reasons `moderator`, `idle`, `community_closed`). Start is
idempotent and provider-first; end is idempotent, closes every hand, floor
and presenter grant in one transaction and publishes exactly one
`live.session.ended`; the reconciler converges LiveKit to the record. Detail:
[live.md](live.md). Sequence:
[Appendix A2](#a2-start-a-live-session-and-join-it).

## 12. Speaker and raise-hand state machine

A request is scoped to one session; a duplicate raise returns the open
request; a grant comes only from a raised hand (PROVISIONAL,
[Q62](open-questions.md#q62--floor-rules-beyond-first-come-first-served));
the session's end expires
every open request; revoking the floor never touches membership. Screen share
is one presenter slot per session. Detail: [live.md](live.md). Sequence:
[Appendix A3](#a3-raise-hand-grant-publish-revoke).

## 13. Attendance snapshot model

**HELD.** One provider read through `LIVE_PRESENCE` when someone who may
record presses Record: the community's owner, the session's host, a
moderator of the session or a `community.attendance.record` grantee, asked in
the fallback order of
[attendance.md §11.3](attendance.md#113-attendanceaccess-how-refusals-map)
(PROVISIONAL,
[Q69](open-questions.md#q69--who-records-and-who-views-snapshots)); entries CONNECTED or CONNECTING under `provider_registry_v1`;
no "present" label, no absentees, no durations; idempotent by a UNIQUE key;
immutable. Detail: [attendance.md](attendance.md). Sequence:
[Appendix A4](#a4-record-an-attendance-snapshot-held).

---

## 14. Event model

### 14.1 Rules

- Every event's name and payload type live in the publisher's
  `contracts/events.ts` (the P0 events-in-contracts test; identity's existing
  events are allow-listed).
- Payloads carry **ids, codes, counts and versions only** — never names,
  titles, message text, invitation tokens or hashes, LiveKit tokens or URLs,
  or participant lists.
- Every mutating use case emits through its module's journal: **audit, then
  event, after commit, and nothing on a no-op** (the `academic-journal.ts`
  pattern).
- No decision is ever taken from an event alone: every consumer re-asks the
  owner's contract. Events are wake-ups and hints.
- **Durability classes** (ADR 0021): **R** — loss tolerable, the fact is in
  the owner's table; **S** — a security reaction with a reconciler backstop;
  **G** — guaranteed delivery. `communities.member.removed` is the only S
  event; there is no G event in v1.
- **The outbox becomes mandatory** on any of four triggers: **T1** a
  projection used for authorization that has no reconciler; **T2** guaranteed
  delivery; **T3** a second API instance; **T4** an external side effect that
  cannot be re-derived. None holds in v1: messaging's projection has a
  sweeper, a reconciler and repair on access (so T1 does not fire).

### 14.2 The brief's names and this design's names

| Brief | This design | Note |
| --- | --- | --- |
| `group.created` | `communities.community.created` | Community, not Group |
| `group.locked`, `group.unlocked` | `communities.community.locked`, `.unlocked` | |
| `member.added`, `member.removed` | `communities.member.added`, `.removed` | carry `membershipId` and `membershipVersion` |
| `invitation.created`, `invitation.revoked` | `communities.invitation.created`, `.revoked` | never on any wire |
| `live.session.started`, `live.session.ended` | unchanged | `roomId` replaced by `communityId` (never published today) |
| `live.hand.raised` | `live.speaker.requested` | the name already declared in `live/domain/events.ts` |
| `live.hand.accepted` **and** `live.speaker.granted` | `live.speaker.granted` | one fact, one event |
| `live.hand.rejected` | `live.speaker.declined` | |
| `live.speaker.revoked` | unchanged | |
| `live.screen_share.started`, `.stopped` | unchanged | defined as the presenter grant opening and closing, not pixels |
| `attendance.snapshot.recorded` | unchanged | HELD |
| — (added) | `communities.capability.granted`, `.revoked`; `communities.ownership.transferred` | delegated permission changes (P3) |
| — (added) | `live.speaker.withdrawn`, `live.speaker.expired` | the requester's own act; ineligibility |

### 14.3 Catalogue

| Event | Owner | Payload (ids only) | aggregateId | Class | Consumers | Channel |
| --- | --- | --- | --- | --- | --- | --- |
| `communities.community.created` | communities | `{communityId, createdBy}` — no title | communityId | R | none in v1; always followed by `member.added` for the owner | in-process only; no frame |
| `communities.community.locked` / `.unlocked` | communities | `{communityId, lockedBy \| unlockedBy, lifecycleVersion}` | communityId | R | realtime relay; live `ProtectLiveSessions` (accelerator) | frame `community.locked` / `.unlocked` to ACTIVE members online |
| `communities.member.added` | communities | `{communityId, userId, membershipId, source, addedBy, invitationId, membershipVersion}` | communityId | R | messaging `CommunityChatSync` (wake-up); realtime relay | frame to that user only |
| `communities.member.removed` | communities | `{communityId, userId, membershipId, reason: 'LEFT' \| 'REMOVED', removedBy, membershipVersion}`; implies the stint's grants ended in the same transaction | communityId | **S** | live `ProtectLiveSessions` (expire hand, close presenter grant, `removeParticipant`); messaging sync; realtime relay | frame to that user only; on LiveKit, `PARTICIPANT_REMOVED` to that participant |
| `communities.invitation.created` / `.revoked` | communities | `{communityId, invitationId, createdBy \| revokedBy}` — never the token, hash, expiry or maxUses | communityId | R | none | in-process only; never on any wire |
| `communities.capability.granted` / `.revoked` (P3) | communities | `{communityId, grantId, membershipId, userId, capability, grantedBy \| revokedBy}`; revoked only for owner revocations | communityId | R | realtime relay; live `ProtectLiveSessions` (re-evaluates a holder in a session) | frame `community.access.changed` to that user only |
| `communities.ownership.transferred` (P3) | communities | `{communityId, fromUserId, toUserId, transferredBy, basis, endedGrantIds (at most one per delegable capability: 7 in P3, 9 after P9)}` | communityId | R | realtime relay | `community.access.changed` to both users |
| `live.session.started` | live | `{sessionId, communityId, hostUserId}` | sessionId | R | realtime relay; notifications later (Q67) | frame to online members `LIVE_AUDIENCE.participantsAmong` accepts ([§16.1](#161-where-every-event-and-state-change-travels)) |
| `live.session.ended` | live | `{sessionId, communityId, endedBy, reason: 'moderator' \| 'idle' \| 'community_closed', durationSeconds}`; one per end; implies every hand, floor and presenter grant closed | sessionId | R | realtime relay; attendance (optional); reporting later | same audience as started; LiveKit `ROOM_DELETED` in the room |
| `live.speaker.requested` | live | `{sessionId, communityId, requestId, userId, stateVersion}`; only when a row is created | sessionId | R | realtime relay | `live.session.changed` to moderators and the requester |
| `live.speaker.withdrawn` / `.declined` / `.granted` / `.revoked` / `.expired` | live | `{sessionId, communityId, requestId, userId, stateVersion}` + `declinedBy \| grantedBy \| revokedBy`; withdrawn and expired add `from`; expired adds `cause: 'ineligible'` and is never published for session end | sessionId | R | realtime relay; notifications later | `live.session.changed`; grant and revoke also act on LiveKit (full permission set) |
| `live.screen_share.started` / `.stopped` | live | started `{sessionId, communityId, userId, grantedBy, stateVersion}`; stopped `{…, stoppedBy, reason: 'stopped' \| 'revoked' \| 'ineligible', stateVersion}`; never for session end | sessionId | R | realtime relay | `live.session.changed`; the track travels on LiveKit only |
| `attendance.snapshot.recorded` (HELD) | attendance | `{snapshotId, communityId, liveSessionId, recordedBy, observedAt, connectedCount, connectingCount}` — never participant ids or names | liveSessionId | R | none built (future: notifications Q67, reporting, operations Q70) | in-process only; no frame |
| `messaging.message.sent` (existing) | messaging | unchanged; `conversationType` is `'CHANNEL'` for community chats | conversationId | R | realtime, notifications through `MESSAGE_RECIPIENTS` (projection + lag filter + `COMMUNITY_CHAT_READ_CEILING`) | existing `message.sent`, OnlineAudience-bounded; none above the capacity switch, which refuses the post |
| `messaging.conversation.created`, `messaging.participant.added` / `.removed` (existing) | messaging | unchanged | conversationId | unchanged | unchanged for conversations messaging owns | **never raised for community chats**: a 30,000-member import produces 0 messaging events, 0 frames, 0 `ADDED_TO_CONVERSATION` notifications |

**Not events, by design:** token issuance; LiveKit joins, leaves and track
publications; sweep corrections; occupancy samples; authorization
evaluations and denials; failed redemptions. They go to logs and metrics
only. Tokens never appear in events, frames or logs.

### 14.4 Audit

Audited (brief §26): community creation, lock and unlock; invitation creation and
revocation; member added (by a manager), joined (by a link), removed and left;
capability granted and revoked; ownership transferred; live session started
and ended; speaker declined, granted and revoked; screen share started, and
stopped when a moderator revoked it; the automatic media-room reset
(`live.session.media_reset`, null actor; PROVISIONAL,
[Q63](open-questions.md#q63--losing-standing-during-a-running-session));
attendance snapshot recorded;
oversight-basis reads (PROVISIONAL, Q43). Not audited: a raised hand, a
withdrawal (the requester's own act), an expiry (its cause is audited by the
module that owns it), and transport noise. Crash-after-commit can lose an
audit row today (`drizzle-audit-log.ts:13-16`); the unit of work that closes
this gap lands with the outbox (P11).

---

## 15. API proposal

### 15.1 Conventions

- **Every route is prefixed by the module that owns it** and declares exactly
  one access level (`authorization.spec.ts`). The public-route set is
  unchanged; no route here is public.
- **Why not `/groups/:id/live/…`:** a route belongs to the module whose
  controller serves it. Nesting live routes under the community path would put
  a Live concern in Communities' URL space and invite a Communities controller
  or response to know about Live — the same Communities → Live edge that
  closes a cycle ([§3.4](#34-back-edges-and-the-rule-that-forbids-each)).
  Live routes carry the community id as a scope (`/live/communities/:id/…`),
  and the client composes "live now" by calling Live.
- **Creation is 201; an idempotent repeat is 200** with the same body and no
  audit, event or provider call.
- **Non-members get 404**, identical to a missing resource. Ids are uuid v4.
- The route decorator is the coarse gate; the use case asks
  `COMMUNITY_AUTHORIZATION` with the id taken from a stored record.
- Engineering rate limits are PROVISIONAL and development-safe
  ([Q48](open-questions.md#q48--invitation-links) for joins and links,
  [Q26](open-questions.md#q26--realtime-limits) otherwise).
- **What exists today:** four live routes — `POST /live/sessions/:id/join`,
  `POST /live/sessions/:id/hand`, `POST /live/requests/:id/grant` and
  `/revoke` (`live.controller.ts`). No community, start, end or attendance
  route exists.

### 15.2 Communities (P2; grants and ownership P3)

The use-case authorization and refusal columns restate the PROVISIONAL act
rules of [§8.2](#82-the-act-vocabulary-provisional-act-rules) (Q41–Q49, Q54);
answering a question changes a row, not the route.

| Route | Declared | Use-case authorization | Success | Refusals |
| --- | --- | --- | --- | --- |
| `GET /communities?scope=mine\|all&cursor&limit` | `communities.read` | `all` needs `communities.manage` | 200 page (default 30, max 100) | 403 `identity.permission_denied`; 422 `communities.cursor_invalid` |
| `POST /communities {title}` | `communities.create` | re-authorized in the use case | 201; the creator becomes owner and first member (Q41). Not idempotent | 422 `communities.title_invalid`; 429 `communities.too_many_communities` |
| `GET /communities/:communityId` | `communities.read` | `community.view` | 200 `CommunityResponse` with the `me` block | 404 `communities.community_not_found` |
| `POST /communities/:communityId/lock` | `communities.read` | `community.lock` | 200; a repeat is 200 with no audit or event | 404; 403 `communities.capability_required` |
| `POST /communities/:communityId/unlock` | `communities.read` | `community.lock` (never blocked by the gate) | 200, idempotent | 404; 403 |
| `GET /communities/:communityId/members?cursor&limit` | `communities.read` | `community.members.view` | 200 page `{userId, displayName, active, joinedAt}` (max 200; one directory call per page; never emails) | 404; 403 |
| `POST /communities/:communityId/members {userIds[1..200]}` | `communities.read` | `community.members.invite` (oversight never adds) | 201 `{added, unchanged}`; 200 when all were members | 412 `communities.community_locked`; 422 `communities.members_not_eligible`; 429 |
| `DELETE /communities/:communityId/members/:userId` | `communities.read` | `community.members.remove` (allowed while LOCKED; P3 subset rule) | 204 | 404 `communities.member_not_found`; 412 `communities.owner_not_removable`; 403 |
| `POST /communities/:communityId/leave` | `communities.read` | the caller's own ACTIVE stint, not the owner (Q42) | 204 | 404; 412 `communities.owner_cannot_leave` |
| `POST /communities/:communityId/invitations {expiresInSeconds?, maxUses?}` | `communities.read` | `community.members.invite` | 201 `{invitation, token}` — the token appears in this response only | 412 `communities.community_locked`; 422 `communities.invitation_terms_invalid`; 429 |
| `GET /communities/:communityId/invitations?cursor&limit` | `communities.read` | `community.members.invite` or oversight | 200 page; state derived; never the token or hash | 404; 403 |
| `POST /communities/:communityId/invitations/:invitationId/revoke` | `communities.read` | `community.members.invite` or oversight; the community is authorized before the invitation is loaded | 200; a repeat is 200 with no audit or event | 404 `communities.invitation_not_found` |
| `POST /communities/join {token}` | `communities.read` + per-IP `@RateLimit` | per-user limit; the token only in the body (redacted by the logger); community id never taken from the client | 201 joined; 200 already a member (no use consumed) | 404 `communities.invitation_invalid`; 412 `communities.invitation_revoked`, `invitation_expired`, `invitation_exhausted`, `community_locked`; 403 `communities.rejoin_requires_manager` (Q49); 429 `communities.too_many_attempts`; a link whose creator lost `community.members.invite` fails closed as 404 `communities.invitation_invalid` (from P2: the creator's ceiling and ACTIVE OWNER stint; P3 adds the grant lookup; Q48) |
| `GET /communities/:communityId/grants?userId&capability&cursor&limit` (P3) | `communities.read` | the owner sees all ACTIVE grants (dormant marked); others only their own | 200 page | 404 |
| `POST /communities/:communityId/grants {userId, capabilities[1..7]}` (P3) | `communities.moderate` | owner only (Q44); the owner's and grantee's ceilings | 201 `{created, unchanged}`; atomic batch | 404; 403 `communities.not_community_owner`; 403 `identity.permission_denied` (a missing ceiling); 422 `communities.grantee_ineligible` |
| `DELETE /communities/:communityId/grants/:grantId` (P3) | `communities.moderate` | owner only (Q44) | 204, idempotent | 404 `communities.grant_not_found` |
| `PUT /communities/:communityId/owner {userId}` (P3) | `communities.read` | the owner, or oversight naming someone other than themself (Q42) | 200; a repeat to the current owner is 200 | 409 `communities.owner_conflict`; 422 `communities.owner_ineligible`; 403 `communities.owner_self_assignment` |

`CommunityResponse` is `{id, title, status, lifecycleVersion, memberCount,
createdAt, me: {standing, joinedAt, capabilities, participation}}`. The `me`
block is a UI courtesy computed on the server, never a control. Any
communities route may also answer 409 `communities.conflict` (a deadlock
victim after one retry) and 503 `unavailable` (a store or directory failure).
Full DTO rules: [communities.md](communities.md).

### 15.3 Messaging (P4)

| Route | Declared | Use-case authorization | Success | Refusals |
| --- | --- | --- | --- | --- |
| `GET /messaging/communities/:communityId/conversation` (new) | `messaging.read` | `community.chat.read`; per-user limit | 200 `ConversationResponse`; the conversation is materialized idempotently on the first positive permit | 404 `messaging.conversation_not_found`, identical for an unknown community, a non-member and an unreadable community |
| `GET /messaging/conversations` (existing) | unchanged | community rows filtered through three calls per page, none when there are none: `authorizeEach` for `community.chat.read`, `authorizeEach` for `community.chat.post` (for `canPost`) and `COMMUNITY_DIRECTORY.describe` ([community-chat.md §7.4](community-chat.md#74-list-views)) | a page may be short; the keyset continues | — |
| Reads, mark-read, attachment link, `subscribe` (existing) | unchanged | `ConversationAccess` gains the community branch | unchanged | 404 as soon as the removal commits |
| `POST …/messages/{text\|voice\|image\|file}` (existing) | `messaging.send` | + `community.chat.post`; then the capacity switch (`member_count` against `communityChatMaxServedMembers`) | unchanged | 403 `messaging.posting_not_allowed`; 412 `messaging.community_chat_over_capacity` |
| `GET …/participants` (existing) | unchanged | — | — | 403 `messaging.members_hidden` for a community chat |
| add, remove, leave on a community chat (existing) | unchanged | after the membership check | — | 412 `messaging.membership_managed_by_community` |

### 15.4 Live (P6; hardening of existing routes in P1)

The refusals column names the main codes only. The complete list for every
row, including 412 `live.community_not_open`, 403 `live.not_a_moderator` and
`live.target_is_host` on the moderation routes, 403
`live.presenter_not_permitted`, the named 429s and 503 `unavailable`, is
[live.md §15.2](live.md#152-refusal-codes).

| Route | Declared | Use-case authorization | Success | Refusals |
| --- | --- | --- | --- | --- |
| `POST /live/communities/:communityId/sessions` (no body) | `live.moderate` (no `ownerUserId`) | `community.live.start`; the starter becomes host | 201 `LiveSessionView`; 200 with the running session (Q55) or the winner of a concurrent start | 404 (not a member); 403 (no `community.live.start`); 412 (the lifecycle gate: `liveStartOpen` is false); 429; **503 `live.media_unavailable`, nothing stored** |
| `GET /live/communities/:communityId/sessions/current` | `live.join` | `community.live.join`, or a moderator | 200 `{session: LiveSessionView \| null}` | 404 |
| `GET /live/sessions/:sessionId` | `live.join` | permit on the stored `communityId` | 200 `LiveSessionView` (`stateVersion`, server-computed `me` flags; queue and enforcement fields for moderators only) | 404 `live.session_not_found` |
| `POST /live/sessions/:sessionId/join` (no body; the `displayName` DTO is removed) | `live.join` | `community.live.join`; capabilities from `capabilitiesFor` | 200 `{token, url, expiresInSeconds: 120, role, media}`; each call re-checks and mints a fresh token. **The only channel that carries a LiveKit credential** | 404 `live.session_not_found`; 412 `live.session_not_live`; 412 `live.session_full` (listeners over the soft cap); 429 |
| `POST /live/sessions/:sessionId/end` | `live.moderate` | `LiveAccess`: `community.live.moderate`, or host + `community.live.host` | 200; a second call is 200 with no audit, event or provider call | 404; 403 `live.not_a_moderator` |
| `POST /live/sessions/:sessionId/hand` (no body) | `live.raise_hand` | `community.live.raise_hand` | 201 new request; 200 the existing open request (today 202 for a new request, `live.controller.ts:40`, and 409 `live.speaker_request_exists` for an open one, `request-speaker.use-case.ts:71-75`) | 404; 412 `live.session_not_live`; 429 |
| `DELETE /live/sessions/:sessionId/hand` | authenticated | only the caller's own open request | 200 `{request \| null}`; pending or granted → withdrawn (yield); idempotent | 404 |
| `GET /live/sessions/:sessionId/hands?state&cursor&limit≤100` | `live.moderate` | `LiveAccess` | 200 FCFS keyset page; names from the directory | 404; 403 |
| `POST /live/requests/:requestId/grant` | `live.moderate` (coarse, before load) | `LiveAccess`; the target is still eligible | 200 `{request, media: 'applied' \| 'not_connected' \| 'pending'}`; already granted is 200 with no side effects | 404 `live.request_not_found`; 412 `live.target_not_eligible`, `live.speaker_slots_full`, `live.session_not_live`; 409 `live.invalid_transition` |
| `POST /live/requests/:requestId/revoke` | `live.moderate` | as grant | 200 `{request, media}`; repeat 200 | as grant |
| `POST /live/requests/:requestId/decline` | `live.moderate` | as grant | 200; repeat 200 | 409 from any other state |
| `POST /live/sessions/:sessionId/screen-share` (no body) | `live.moderate` | session moderator holding `live.speak`; for themself only ([Q56](open-questions.md#q56--screen-sharing)) | 201 `LiveSessionView`; 200 when already held | 409 `live.presenter_slot_taken`; 412 `live.session_not_live` |
| `DELETE /live/sessions/:sessionId/screen-share` | authenticated | the presenter (`stopped`) or a session moderator (`revoked`) | 200, idempotent | 404; 403 |

Not added: a moderator-initiated media-room reset (P12), a moderator "remove participant" route
([Q64](open-questions.md#q64--removing-a-participant-from-a-session)), any
LiveKit webhook route, any load-test or debug route.

### 15.5 Attendance (P9, HELD)

| Route | Declared | Use-case authorization | Success | Refusals |
| --- | --- | --- | --- | --- |
| `POST /attendance/live-sessions/:liveSessionId/snapshots {clientRequestId}` | authenticated | `LIVE_SESSIONS.describe` → the record bases on its `communityId`, in the fallback order of [attendance.md §11.3](attendance.md#113-attendanceaccess-how-refusals-map) (`community.attendance.record`, then `community.live.moderate`, then `community.live.host` for the session's host); `recordedBy` = the principal; the whitelist rejects any other body field | 201 `SnapshotView` (counts only); 200 the stored snapshot for a replayed key | 400; 422 `attendance.client_request_id_invalid`; 404 `attendance.session_not_found`; 403 `attendance.not_allowed`; 412 `attendance.session_not_live`, `attendance.community_not_open`; 429 `attendance.too_many_snapshots`; **503 `attendance.observation_unavailable`, nothing stored**; 503 `unavailable` (the Communities store) |
| `GET /attendance/communities/:communityId/snapshots?liveSessionId&cursor&limit` | authenticated | `community.attendance.view` on the path's community; without it, only a `liveSessionId` the caller hosted or recorded in (attendance.md §11.3) | 200 headers, newest first (max 200); never calls Live | 404 `attendance.community_not_found`; 403 `attendance.not_allowed`; 412 `attendance.community_not_open`; 422 `attendance.cursor_invalid`; 503 `unavailable` |
| `GET /attendance/snapshots/:snapshotId` | authenticated | load the header, then the view bases of attendance.md §11.3 on its community (`community.attendance.view`; then, for the session's host or a recorder of it, `community.view` with the membership basis) | 200 `SnapshotView` | 404 `attendance.snapshot_not_found` for unknown, invisible and forbidden alike; 412 `attendance.community_not_open`; 503 `unavailable` |
| `GET /attendance/snapshots/:snapshotId/participants?connection&cursor&limit` | authenticated | as above | 200 `{items: [{userId, displayName, connection}], nextCursor}`; no "present" field | as above; 422 `attendance.cursor_invalid` |

A caller with no standing, or with no ceiling on any path, gets the same 404 as
an unknown session or community. A member gets 403 `attendance.not_allowed`
only when no basis in the fallback order permits, and on one snapshot even
then 404
([attendance.md §11.3](attendance.md#113-attendanceaccess-how-refusals-map)).
Who holds each basis is PROVISIONAL
([Q69](open-questions.md#q69--who-records-and-who-views-snapshots)).
Record: the owner, the session's host and moderators, and a
`community.attendance.record` grantee. View: the owner, a
`community.attendance.view` grantee, and the host or a recorder for the
sessions they hosted or recorded in.

### 15.6 Realtime

`WS /realtime` is unchanged: first-frame authentication, the `messaging.read`
connection gate, `subscribe` stays conversation-only, **no client frame is
added**. Only server frames are added ([§16.2](#162-frames-added-to-protocol-v1)).

---

## 16. Realtime transport matrix

### 16.1 Where every event and state change travels

`A` = distinct accounts connected to one API instance (A ≤ 10,000,
`realtime-policy.ts:42`). Costs are derived per event per instance, not
measured.

| Fact | App WebSocket frame | Audience, and how it is resolved | Cost at 30,000 members | LiveKit | Notifications | Nothing |
| --- | --- | --- | --- | --- | --- | --- |
| community created | — | — | — | — | — | the creator has the HTTP response |
| community locked / unlocked | `community.locked` / `.unlocked` `{communityId, lifecycleVersion}` | ACTIVE members online here: `OnlineAudience` over `COMMUNITY_MEMBERSHIP.members` | 0 if nobody is connected; 1 query if ≤ 1,000 members; else ≤ 1 + ⌈A/1000⌉ (≤ 11), whatever the size | Live's reaction applies the effects (a running session continues, PROVISIONAL, Q46) | later (Q67) | |
| member added | `community.member.added` `{communityId, userId}` | that user only (Q22 precedent) | 0 queries | — | later | |
| member removed | `community.member.removed` `{communityId, userId, reason}` | that user only | 0 queries | `PARTICIPANT_REMOVED` to that participant | later | |
| invitation created / revoked | — | — | — | — | — | managers reload over HTTP |
| capability granted / revoked, ownership transferred | `community.access.changed` `{communityId}` | the affected user(s); the client refetches `GET /communities/:id` | 0 queries | re-evaluation of a holder in a session | later | |
| live session started | `live.session.started` `{communityId, sessionId}` | two steps: the community's ACTIVE members online here (`OnlineAudience` over `COMMUNITY_MEMBERSHIP.members`), then those of them `LIVE_AUDIENCE.participantsAmong` accepts, probed in chunks of 1,000. The frame grants nothing | the first step as for a lock (1 query if ≤ 1,000 members, else ≤ 1 + ⌈A/1000⌉), plus ⌈M/1000⌉ contract calls for the M members found online | the room exists | later (Q67) | |
| live session ended | `live.session.ended` `{communityId, sessionId, reason}` | same as started; terminal for that id | same | `ROOM_DELETED` to everyone in the room | later | |
| hand raised, withdrawn, declined; speaker granted, revoked, expired; screen share started, stopped | `live.session.changed` `{communityId, sessionId, stateVersion}` | `LIVE_AUDIENCE.moderators` (coalesced to ≤ 1 per 250 ms per session) ∪ the affected user (immediate). **Zero frames per listener** | 1 contract call over a small set | grant or revoke: the participant's permission update (`ParticipantPermissionsUpdated`); disallowed tracks unpublished at once | later | |
| audio, screen track, speaking indicators, joins, leaves, mute | — | — | — | **LiveKit only** (transport noise) | — | |
| in-room roster | — | — | — | LiveKit; visible to all participants until [Q59](open-questions.md#q59--visibility-inside-a-live-session) | — | |
| join credential | — | — | — | — | — | HTTP `POST …/join` response only |
| attendance snapshot recorded | — | — | — | — | later (Q67) | v1: no frame |
| community chat message | existing `message.sent` | existing: `MESSAGE_RECIPIENTS` (projection + lag filter + `COMMUNITY_CHAT_READ_CEILING`) through `OnlineAudience` with `visibleSequence` | today 30 queries per message per instance at 30,000 (`messaging-relay.ts:207-219`); ≤ 11 with `OnlineAudience` | — | existing: one row per reader (Q28; gate G4) | |
| data channel | — | — | — | **unused**; `canPublishData = false` for everyone | — | |

Relays chain per aggregate id, do nothing when this instance has no
connections, serialize each frame once, and are detached from the publisher
(the `messaging-relay.ts` pattern). HTTP is the truth; frames are hints.

### 16.2 Frames added to protocol v1

Every frame is `{type, version: 1, eventId, occurredAt, …}`, built field by
field, with an `eventId` derived from the fact:

| Frame | Fields | eventId |
| --- | --- | --- |
| `community.member.added` | `communityId, userId` | derived from community, user and time |
| `community.member.removed` | `communityId, userId, reason: 'left' \| 'removed'` | same |
| `community.locked`, `community.unlocked` | `communityId, lifecycleVersion` | `community.locked:<id>:<lifecycleVersion>` |
| `community.access.changed` | `communityId` | derived from community, user and time |
| `live.session.started` | `communityId, sessionId` | `live.session.started:<sessionId>` |
| `live.session.ended` | `communityId, sessionId, reason` | `live.session.ended:<sessionId>` |
| `live.session.changed` | `communityId, sessionId, stateVersion` | `live.session.changed:<sessionId>:<stateVersion>` |

No frame carries a name, text, a token, an invitation code, a URL, queue
contents or a roster. Golden JSON fixtures are shared by the backend builders
and the Flutter parser.

### 16.3 How protocol v1 grows, and why there is one socket

- **Server frames:** new types and new optional fields only. A field's meaning
  never changes and none is removed. The version is **never bumped** for an
  additive change, because the app drops every frame whose version is not 1
  (`realtime_frames.dart:56`) and ignores unknown types (`:70`). Old apps stay
  correct over HTTP; a new app on an old server works from HTTP alone.
- **Client frames:** none added; the parser stays strict. If one is ever
  needed, `ready` gains an optional `features: string[]` and the client sends
  the frame only when advertised.
- **One socket.** The app WebSocket carries application state; LiveKit carries
  media and media-plane state; nothing rides the LiveKit data channel. No
  second WebSocket system is created (brief §24).
- **Connection gate:** `messaging.read`
  (`realtime-sessions.ts:443`). A role without it would be refused with 4403,
  and the app stops retrying for good after 4403
  (`websocket_realtime_client.dart:348-350`); hence the gate-coupling test
  (Q66).
- **Reconnect:** on `reconnected` the client refetches the open community and
  session views over HTTP. A `live.session.changed` at or below the held
  version is ignored; a newer one triggers one single-flight refetch.

---

## 17. Flutter architecture

**What exists today:** abstract repositories in
`lib/data/repositories/repositories.dart` with HTTP and mock implementations
bound only in `lib/providers/app_providers.dart`; `RealtimeClient` and
`realtime_frames.dart` (messaging and notification frames); media seams with
Unavailable defaults (`lib/data/media/media_seams.dart`); `DataOrigin.mock` on
mock data; no `livekit_client` or `flutter_webrtc` in `pubspec.yaml`.

| Piece | Proposal | Phase |
| --- | --- | --- |
| `CommunityRepository` | `communities({scope, cursor})`, `community(id)`, `members(id, cursor)`; `addMembers`, `removeMember`, `leave`; `createInvitation(id, terms)` → `{invitation, token}` (token shown once); `invitations`, `revokeInvitation`; `join(token)` (POST body); `lock`, `unlock`; `grants`, `grant`, `revokeGrant`, `transferOwnership` (P3). HTTP + mock | P5 |
| `LiveRepository` | `currentSession(communityId)`, `session(sessionId)`, `start(communityId)`; `join(sessionId)` → `LiveMediaGrant` (redacted `toString`); `raiseHand`, `lowerHand`, `hands`; `grant`, `decline`, `revoke`, `end`; `claimScreenShare`, `stopScreenShare`. HTTP + mock | P7 |
| `AttendanceRepository` | only when the hold lifts | P9 |
| `MessagingRepository` | `+ conversationForCommunity(id)`; `Conversation.communityId: String?` | P5 |
| Capability and state models | `CommunityView {id, title, state (+unknown), lifecycleVersion, memberCount, me: {standing, capabilities: Set<CommunityCapability (+unknown)>, participation}}`; `LiveSessionView` with `stateVersion` and server-computed `me` flags. Unknown enum values map to `unknown` and are ignored; missing booleans are false | P5, P7 |
| `LiveMediaClient` seam | `{isAvailable, state, states, connect(grant), setMicrophoneEnabled, setScreenShareEnabled, disconnect}`, bound to `UnavailableLiveMediaClient`. The UI says plainly that live audio is unavailable in this build. `LiveKitLiveMediaClient` becomes the only file importing `livekit_client` in P7b (an ADR plus device evidence) | P7, P7b |
| Frame families | `CommunityEvent` and `LiveEvent` `RealtimeEvent` families as part files of `realtime_frames.dart`, parsed from the shared golden fixtures | P5, P7 |
| Controllers | `CommunityController`: on `community.locked`/`unlocked` with a newer `lifecycleVersion`, records the version and makes one single-flight refetch of `GET /communities/:id`, because `me.capabilities` includes the lifecycle gate and is never recomputed on the client; `member.removed` puts the community away; `access.changed` refetches. `LiveSessionController`: version-gated refetch; reconnect catch-up; `ROOM_DELETED` → refetch the session; `DUPLICATE_IDENTITY` → no automatic rejoin ([Q60](open-questions.md#q60--one-account-on-several-devices-in-a-session)) | P5, P7 |
| Deep links | `/invite#<token>`: the token travels only in the URL fragment, which browsers never send in requests or `Referer` headers (the web app uses the path URL strategy, `url_strategy_web.dart:9`, so a path or query would reach the static host). The app reads it from the fragment, holds it in memory, requires sign-in, POSTs it once in the body, replaces the history entry, never logs or prints it. Other links carry ids only and are resolved over HTTP | P5 |
| Mock parity | `MockCommunityRepository` and `MockLiveRepository` reproduce the server rules (idempotent join, max-uses refusal, locked refusals per the PROVISIONAL table (Q46), one open hand, the speaker cap, idempotent end) and carry `DataOrigin.mock`. Mock mode never produces a usable media grant | P5, P7 |
| Guards | No `livekit_client`, `flutter_webrtc` or `dart_webrtc` in `pubspec.yaml` or `lib/` (P0; after P7b, one adapter file only). Screens and `core/widgets` never import `package:http`, `web_socket`, `api_client.dart`, repository implementations or `websocket_realtime_client.dart`. Community and live features never read `CurrentUser.permissions` or roles. Nothing labels anyone "present" or turns a snapshot into a ratio | P0, P5, P7, P9 |

---

## 18. Failure-mode matrix

"Record" means Postgres. Backstop timings are PROVISIONAL engineering values,
measured in P8: room sweep 30 s, participant sweep 60 s and targeted watch
10 s ([Q63](open-questions.md#q63--losing-standing-during-a-running-session));
the messaging sweeper every 60 s
([Q26](open-questions.md#q26--realtime-limits), profile 4).

### 18.1 The brief's cases (§19)

| Case | Semantics |
| --- | --- |
| **LiveKit unavailable** | *Start:* `ensureRoom` fails → 503 `live.media_unavailable`; no row, audit or event. *Join:* the token is signed locally and still issued; room and soft-cap checks are skipped (fail open to the SFU hard cap); the client's connect fails and it retries `/join` with backoff. *Grant, revoke, decline, withdraw, presenter:* the record commits, is audited and published; the response says `media: 'pending'` and the participant sweep converges it (Q5: the record wins). *End:* commits; `endRoom` is retried by the room sweep. *Attendance:* 503 `attendance.observation_unavailable`, nothing stored. Communities, Messaging and realtime are unaffected: none depends on Live. |
| **Token generation failure** | Local HS256 signing fails only on misconfiguration → 500 fault and an alert log without the token or secret; no state change. Production placeholders are refused at boot. `/join` is idempotent, so the client may retry. |
| **Participant disconnected** | Nothing changes in the record. Speaker and presenter grants survive; `/join` returns the same capabilities; a pending hand stays pending. No application event (transport noise). The moderator view shows `not_connected`. A snapshot sees only what the provider holds at its instant. |
| **Community locked while a session is active** | PROVISIONAL (Q46): no new session (412, the lifecycle gate); the running session continues; join, rejoin, raise hand and moderation continue in it; the host keeps `community.live.host` while it runs. The chat stops accepting posts; reading continues. Every decision pulls `statePermits` or effects at the moment it is made; the event is only an accelerator. |
| **Teacher loses connection** | The session stays live: the record is the truth, not the room. Moderation continues over HTTP from any device; other moderators may act or end the session; the teacher rejoins through `/join`; the moderator reserve keeps room for them. Host absence never ends a session ([Q61](open-questions.md#q61--ending-abandoned-live-sessions)). |
| **Teacher device crashes** | The teacher rejoins from any device; LiveKit evicts the stale connection (`DUPLICATE_IDENTITY`). A presenter grant held by the host stays until the host stops it after rejoining, the host loses standing (`ineligible`), or the session ends; other moderators cannot revoke the host's grant (403 `live.target_is_host`, PROVISIONAL, Q54). A non-host presenter's grant may be revoked by another moderator (audited). If everyone leaves, the session ends as `idle` after 900 s observed empty (PROVISIONAL, Q61); LiveKit's own timeouts are a backstop only. |
| **Attendance request races a participant leaving** | The linearization point is the provider's registry read, inside `[observationStartedAt, observedAt]`: closed before it → no entry; after it → included; inside LiveKit's resume window after a transport failure → stored as CONNECTED, the provider's state recorded as is, and whether that counts as present is [Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot); mid-rejoin → CONNECTING. No retry, merge or grace. |
| **Duplicate attendance button** | Same `clientRequestId` → 200 with the stored snapshot; no second observation, audit or event. Concurrent same key → the UNIQUE constraint decides; both responses carry one id. Different keys → two true snapshots, bounded by the per-recorder limit (PROVISIONAL 6 per 60 s, [Q72](open-questions.md#q72--when-and-how-often-snapshots-are-taken)). The app disables the button in flight and reuses the key on retry; correctness does not depend on it. |
| **Duplicate invitation join** | The second request waits on the per-pair lock, finds the ACTIVE stint and answers 200: no use consumed, no audit, no event. The partial unique index is a second guard. |
| **Invitation revoked while being used** | Both serialize on the invitation row. Revoke first → the redeem's UPDATE re-evaluates `revoked_at IS NULL`, rolls back and answers 412 `communities.invitation_revoked`, nothing consumed. Redeem first → the member stays; revocation stops future use, and removal is a separate audited act. |
| **Concurrent community lock** | `UPDATE … WHERE status = 'OPEN'` lets exactly one change happen: one audit row, one event, `lifecycle_version` +1. The other caller gets 200 unchanged. Lock racing unlock: the last commit wins; each real change is versioned, and clients keep the highest version. Lock racing a redeem: joins committed before stand; later ones roll back with 412 and consume no use. |
| **Session ended twice** | The session row `FOR UPDATE` serializes them. The second sees `ended` and returns 200 with the same view: no audit, event or provider call. `endRoom` treats NotFound as success. |
| **Speaker revoked while publishing** | The compare-and-set commits `revoked`; `updateCapabilities` sends the full set without the microphone, and LiveKit unpublishes it at once. If the call fails, the sweep converges within 60 s. If the client rejoins with an earlier refreshed speaker token, the targeted watch demotes it within 10 s; a second violation inside the window resets the media room (P6; PROVISIONAL, Q63; [live.md §11.4](live.md#114-targeted-watch--every-10-s)). |
| **Backend restart** | All truth is in Postgres (in-memory adapters only without a database). Invitation state is derived, so no timers resume. LiveKit media and token refresh carry on. In-flight frames and events are lost (no outbox); clients reconnect with jitter and refetch over HTTP. The reconciler resumes; the in-memory watch set and rate-limit counters reset. A restart is never relied on to eject anyone. |

### 18.2 Further cases

| Case | Semantics |
| --- | --- |
| Crash between commit and audit or event | The change persists. The audit row may be missing (the existing gap, `drizzle-audit-log.ts:13-16`). Frames converge on the next versioned frame or on reconnect; a lost Live ejection is repaired by the participant sweep; a lost messaging wake-up by the sweeper. A future guaranteed notification would be trigger T2. |
| A subscriber throws, or is slow | Isolated and logged (`event-bus.ts:49-53`). Every new subscriber schedules its work and returns; tests assert `publish()` resolves first. |
| Communities store unavailable | `authorize` rejects; Messaging, Live and Attendance fail closed with 503 and never fall back to a role-only answer. Sweeps skip the tick and never eject on unknown state. Media already flowing continues. |
| Removal racing a send or a join | Only a request whose permit was read before the removal committed can land (one message ordered before the removal, or one token). Every later request is refused. The event path, or at worst the 60 s sweep, ejects from the room. |
| Removed participant rejoins the room in a loop with refreshed tokens | Each rejoin earns a fresh token of at least 10 minutes, so removal alone never ends the loop. The first return is removed within 10–60 s; a second violation inside the enforcement window resets the media room automatically (P6; PROVISIONAL, Q63; [live.md §11.4](live.md#114-targeted-watch--every-10-s)): every token the violator holds names a deleted room. Residual: the first removal plus at most one 10 s watch tick of listening; everyone else reconnects briefly. |
| Join racing end | A token minted before the end is useless after `endRoom`, because `auto_create=false`. A join that re-created a missing room re-reads `ended` and deletes it (ensure-then-recheck) → 412. |
| Concurrent starts | The partial unique index keeps one row; the loser ends its own room and returns the winner (200). An orphan room from a crashed start is deleted by the room sweep after a 60 s grace. |
| Grants beyond the speaker cap | Serialized on the session row, counted, then compare-and-set: exactly 4 (Q4). The loser gets 412 `live.speaker_slots_full`. |
| Two moderators claim the presenter slot | One open grant; the other gets 409 `live.presenter_slot_taken`. |
| Duplicate raise hand, hand storm | The existing open request is returned (200); only created rows publish; moderator frames are coalesced; the queue is a keyset page. |
| Media room vanished while live | The room sweep ensures it again within 30 s; `/join` does so at once. Hands, floors and the presenter grant survive in the record. |
| Room full | The hard cap is LiveKit `maxParticipants` = cap + reserve. Listeners over the soft cap get 412 `live.session_full`; moderators and speakers skip it. Residual: a storm inside one sample can take reserve slots. |
| Same account on a second device | The newest connection evicts the older (`DUPLICATE_IDENTITY`); the app does not rejoin automatically (Q60); a snapshot has one entry per account. |
| Host loses standing mid-session | Their next moderation command is refused; the session continues for the others; `community.live.moderate` holders, the owner included, still moderate (Q63). |
| Session ends during an observation | Live saves `ended` before calling `endRoom`; the re-check after the read returns `not_active` → 412, nothing stored. If the end comes after the re-check, the snapshot is stored. |
| Concurrent redeems exceed `max_uses` | The conditional UPDATE admits exactly the remaining uses; the rest get 412 `communities.invitation_exhausted`; `uses ≤ max_uses` is also a CHECK. |
| Remove racing redeem for the same user | The pair lock serializes them. Removal first → 403 `communities.rejoin_requires_manager` ([Q49](open-questions.md#q49--leaving-removal-and-rejoining)). Redeem first → joined, then removed. |
| Owner tries to leave, or to be removed | 412 `communities.owner_cannot_leave` / `owner_not_removable` (Q42). |
| A delegate's removal races revocation of their own grant | The basis is re-verified under lock: either the act commits first, authorized at that instant, or it re-reads its basis as ended and is refused. Two delegates cannot remove each other. |
| Messaging projection lags, or a wake-up is lost | Access stays correct (the authority is asked on every request; repair on access fixes the caller's row); fan-out stays correct (lag filter); the sweeper converges at boot and every 60 s through `listHeads`. Metric: age of the oldest lag. |
| Projection ahead of the authority (a restore from backup) | Detected (projected > head); the reconciler rebuilds; the lag filter stays on until they match. |
| Realtime instance at its connection cap | New handshakes are refused with 503 (`websocket-transport.ts:138`); HTTP keeps working. |
| A classroom behind one NAT reconnects | 300 handshakes per minute per address (`realtime-policy.ts:52-56`) → `RATE_LIMITED` with `retryAfter`; the app backs off with jitter. Values are Q26's. |
| App and server versions differ | Old apps ignore new frame types (`realtime_frames.dart:70`); new apps on old servers work from HTTP. |
| A second API instance starts before P11 | Frames reach only the publishing instance's connections: under-delivery, not a leak. Rate limits effectively double. Deployment discipline holds it to one instance (ADR 0021). |
| A load test aimed at production | Forbidden (PROVISIONAL, [Q65](open-questions.md#q65--media-hosting-and-operations)): a separate key pair and host. |
| A forged `communityId` | Session-scoped acts read it from the stored session; a path/record mismatch is `not_found`. |

---

## 19. Security threat model

Never trusted from the client: role, community id, participant state,
attendance list, display name, capability booleans.

### 19.1 The brief's threats (§25)

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| **Leaked invitation link** | 256-bit bearer secret; mandatory expiry (PROVISIONAL default 7 days, maximum 30, Q48); optional `maxUses`; revocation immediate and linearized with redemption; only signed-in accounts holding `communities.read`; REMOVED members cannot rejoin by link; locking suspends every link; an index lists who joined through a link, and each redemption is audited with its invitation id; the link dies with its creator's authority (from P2; the grant lookup from P3) | Any eligible account that obtains the link before revocation can join, bounded by expiry and `maxUses`. Under the PROVISIONAL full-history rule ([Q52](open-questions.md#q52--community-chat-history-for-newcomers-and-returners)) it sees the chat archive until removed |
| **Invitation brute force** | A 2^256 space; per-user limit and a per-IP limit sized for a school NAT; shape check before hashing; an unknown token costs one indexed lookup | Rate limits are per process until a Redis limiter exists; guessing is infeasible anyway |
| **Unauthorized community access** | Every route authorizes server-side: ceiling, then the stored stint, grant or oversight, then the gate. `me.capabilities` is display only. The principal is rebuilt from storage on every request | None known for the acts designed |
| **Unauthorized LiveKit token** | Tokens only from `/join`, after the ceiling, the `community.live.join` permit (community id from the stored session) and the gate. A token holds `roomJoin` for one room only — never `roomCreate`, `roomAdmin` or `roomList`. `auto_create=false` | Depends on the correctness of Communities' membership |
| **Token reuse** | TTL 120 s; the reconciler's 60 s sweep and 10 s targeted watch; violations shown to moderators; the automatic media-room reset at the second violation (P6; PROVISIONAL, Q63) invalidates every old token; `revokeTokensIssuedBefore` passed for providers that honour it; tokens never logged or put in events or frames | Media until the second violation: the first removal (10–60 s) plus at most one 10 s watch tick; the reset reconnects everyone else briefly |
| **Teacher privilege escalation** | No authority from a role or from teaching a halaqa: acts need ownership, a grant or `communities.manage`, re-checked on every request and sweep. `communities.manage` never grants entry. The host rule is replaced, not bypassed ([§8.3](#83-the-fate-of-the-host-only-rule)) | Who may delegate is Q44's |
| **Speaker privilege escalation** | The total capability set always lists explicit sources; `canPublishData` and metadata updates are false for everyone; CAMERA is never granted; screen share needs a presenter grant; the speaker cap is enforced by the database; a speaker gains no community act; adapter contract tests assert every mapping | The convergence window after a rejoin with an old token |
| **Attendance spoofing** | The body carries only `clientRequestId`; entries come only from the server-side provider read through Live; only STANDARD participants with account-shaped identities; no route writes entries; nothing is updated after creation | "Connected" is not "listening": the system records connections, not engagement (Q68) |
| **Forged participant identity** | The identity is the user id inside a token signed with our secret; non-standard kinds and unmappable identities are dropped and counted | A leaked LiveKit API secret would allow any identity (rotate it) |
| **Community id enumeration** | uuid v4 ids; non-members get 404 identical to a missing community on every module's routes; invitation routes are authorized on the community before the invitation is loaded; `join` takes no community id | Timing differences are not addressed, as in existing modules |
| **Membership race conditions** | Conditional UPDATEs, CHECKs, partial unique indexes and one lock order; basis re-verified under lock; the Postgres concurrency suite covers every race in §18 | None known |

### 19.2 LiveKit-specific threats (verified in the server and SDK source)

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| **Token refresh.** The server sends a connected participant a refreshed token every 5 minutes, valid for at least 10 minutes. The 120 s TTL bounds only the first connection. *realtime.md claims a leaked token is worth "ten minutes" (`:505-510`); this package added a correction note there.* | The reconciler is the enforcement, not the TTL: every connected identity is re-checked against the record and Communities each sweep | A removed participant's client holds a valid token for about 10 minutes after its last connection, and each rejoin earns another; the automatic reset ends that loop (token reuse, above) |
| **`revoke_token_ts` is ignored** by the open-source server, so `removeParticipant` does not stop a rejoin | Targeted watch after every ejection, the participant sweep, violation counting; the automatic epoch reset at the second violation (P6; PROVISIONAL, Q63) ends the loop because old tokens name a deleted room | As token reuse, above ([Q63](open-questions.md#q63--losing-standing-during-a-running-session)) |
| **`auto_create` defaults to true**, so any valid token can re-create an ended or deleted room | `room.auto_create=false` in a LiveKit config kept in the repository and verified by an adapter contract test; ensure-then-recheck; the orphan sweep; no `roomCreate` grant ever issued | A deployment misconfiguration a server self-check cannot see; covered by a staging contract test and a runbook item |
| **`DUPLICATE_IDENTITY`**: a second connection with the same identity evicts the first | Identity = account id; the newest device wins; the app does not auto-rejoin on that reason (Q60); attendance keeps one entry per account | A stolen valid token lets its holder take the owner's seat. Refresh keeps it valid while connected, and the reconciler sees an eligible identity, so each side's rejoin evicts the other until a moderator-initiated media reset (P12, [Q64](open-questions.md#q64--removing-a-participant-from-a-session)) |
| **Data channel.** *Today `LISTENER.canPublishData` is true (`rtc-provider.ts:19-23`).* | `canPublishData = false` for everyone (P1; a visible behaviour change that needs approval); no feature uses the data channel | None once P1 lands |
| **Spoofed display names.** *Today the client supplies `displayName` (`join-session.dto.ts:3-8`).* | From P1 the name comes from `ACCOUNT_DIRECTORY`; the DTO field is removed; participants cannot update their own metadata; the UI takes roles from the session view, never from LiveKit names | None identified |

### 19.3 Other threats

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Delegation escalation (self-grant, chains, a delegate removing the owner) | Only the owner grants; grants bounded by both parties' ceilings, re-checked at every evaluation; no-self-grant CHECK; the owner can never be removed; the subset rule; every change audited | Peers with equal capability sets may remove each other sequentially (Q44) |
| Institutional overreach into minors' rosters and presence | `communities.manage` reach limited (Q43); no attendance oversight; every oversight-basis read audited | The audit records access, it does not prevent it |
| Roster scraping in large communities of minors | Rosters need `community.members.view` ([Q22](open-questions.md#q22--who-may-see-who-is-in-a-conversation)); pages ≤ 200; display names only, never emails; messaging refuses to list a community chat's participants | Owners and overseers can page every name (policy, Q22) |
| Secrets or private data on the wire | Ids-only payloads and frames, asserted by golden fixtures and key-set tests; the invitation token only in one response; the join token only in the `/join` response; tests search logs, audit and events for tokens and hashes | A careless new field is caught only if fixtures and tests are updated in review |
| Another module surveilling presence through `LIVE_PRESENCE` | Allow-list test: only attendance (and `app.module` for wiring) imports it | Code review of the allow-list |
| Realtime or notifications becoming an authorization bypass | Frames grant nothing; every command re-authorizes; audiences are resolved from Postgres per event; opening a notification runs the owner's checkpoint | A frame already serialized when a removal commits can still arrive |
| LiveKit API secret exposure | Read only by platform config and the adapter; the placeholder is refused in production; the SDK is confined by the new rule; adapter errors scrubbed; a test asserts no JWT pattern in logs | None identified |
| Load-test tooling holding the secret | A separate key pair and host; never production rooms (Q65) | Operator error |
| The invitation token in deep links or logs | In the link, only in the URL fragment (`/invite#<token>`), which is never sent to a server; to the API, only in the POST body; the history entry is replaced; never logged or printed; the logger redacts the `token` body key | None beyond a leaked link (above) |
| Self-registration through a link | `join` is authenticated; no public route added; no account-creation path ([Q2](open-questions.md#q2--who-is-the-first-owner-and-how-are-accounts-created-after-that)) | None |
| CSRF on join, lock or remove | Bearer `Authorization` header, not cookies | None for these routes |
| A forged LiveKit webhook (only if P12 adds one) | Signature checked over the raw body in `live/infrastructure`; a reviewed public-route entry; webhooks only trigger a reconcile | None for authorization |

---

## 20. Scaling model

**Measured: nothing for these workloads.** The repository has no load test of
realtime fan-out or of LiveKit; messaging fan-out is tested at 250 members
only. Everything below is configured or derived.

### 20.1 The four scales

**A. Membership (Communities).** The unit is one stint row; no constant, CHECK
or policy caps members per community. Every access is a point lookup
(`authorize`, `statesOf`), a keyset page (`members`, the roster), a counter
(`member_count`, moved in the same transaction) or an ordered changefeed
(`changesSince` on UNIQUE (community_id, version)). Nothing selects all
members and filters. A join is O(1). A batch add is at most 200 ids; HTTP
pages at most 200; contract pages at most 1,000. Operational ceilings (join
rate through one link) come from profile 4
([Q20](open-questions.md#q20--messaging-limits), Q26).

**B. Messaging.** A send is O(1) in storage whatever the member count.
Realtime fan-out per message per instance drops from ⌈N/1000⌉ queries (30 at
30,000) to at most 1 + ⌈A/1000⌉ (at most 11) with `OnlineAudience`, with no
contract change. **Notifications cost N rows per message** (30,000 per post)
under today's provisional defaults — governed by Q27 and Q28, not by this
design. Messaging's own caps (GROUP 500, CHANNEL 10,000,
`messaging-policy.ts:20-24`) apply only to conversations messaging owns.

**C. Live.** Bounded by one room on one node, never by membership. A join is
about five indexed reads, one cached room listing and a local signature. A
raise is one short lock and one insert; a grant one short transaction and one
provider call; an end one set-based transaction and one `endRoom`. Egress is
bounded by at most 4 speakers, every session moderator publishing by right
(not bounded by this design; Q54), 1 presenter, and listeners publishing
nothing.
The reconciler costs, per live session per 60 s, one `listParticipants`
(unpaginated, proportional to P participants) plus ⌈P/1000⌉ `permittedAmong`
and directory probes. Session capacity is a deployment value copied onto each
session from the measured knee (Q57), enforced by LiveKit `maxParticipants`.

**D. Attendance (HELD).** One snapshot is one `listParticipants`, a filter and
one transaction inserting a header and P entries (multi-row statements of at
most 1,000). A rough 0.6 MB per 3,000-entry snapshot, to be measured. Growth
is presses × room size, never membership size.

### 20.2 The single VPS, and the path beyond it

On the single VPS the brief describes, the API, Postgres and LiveKit share one
host, so the SFU's CPU and bandwidth compete with the API. **Nothing here is
production-ready for 30,000-member communities or heavy concurrent realtime
load.** Each step below changes configuration or an adapter, never domain
logic:

1. **A dedicated LiveKit node:** change the LiveKit URL and keys in
   configuration. The API and domain are untouched.
2. **Several LiveKit nodes:** LiveKit's own Redis routing maps each room to a
   node. A room still has to fit on one node. The adapter is untouched.
3. **TURN** (LiveKit's embedded TURN over TLS on 443, or a dedicated server):
   LiveKit configuration only; decided before the first real class (Q65).
4. **More API instances (P11):** a transactional outbox written by each
   module's journal; a broker behind `EventSubscriber` with two delivery modes
   (every instance for relays, one instance for reactions and translators); a
   Redis `RateLimiter`; the reconciler single-flight under
   `pg_try_advisory_lock`. Until then, exactly one API instance runs.
5. **Regions:** `RtcAccessToken.url` already comes from configuration
   (`rtc-provider.ts:49-54`); a placement hint can be added to the room spec
   additively.
6. **Large events** — more listeners than one room holds: a broadcast
   capability inside Live, behind a new Live port implemented in
   `live/infrastructure` (for example egress to a CDN stream). Its listeners
   are not room participants. **Communities, Messaging and Attendance are
   untouched; the Community domain never learns of it**
   ([Q58](open-questions.md#q58--more-listeners-than-one-room-can-hold)).

### 20.3 Capacity gates G1–G4

Community chats stay **disabled above the load-tested size** until all four
hold. The capacity switch is messaging's deployment setting
`communityChatMaxServedMembers` (PROVISIONAL default 250,
[Q26](open-questions.md#q26--realtime-limits)), compared with the
projection's `member_count`: above it a send is refused with 412
`messaging.community_chat_over_capacity` and `canPost` is false, while
reading, marking read and the projection are unaffected
([community-chat.md §11.2](community-chat.md#112-gates-g1g4)). It is raised
only when the gates hold for the new size:

| Gate | What | Phase |
| --- | --- | --- |
| G1 | `OnlineAudience` in realtime (fan-out bounded by online accounts, not members) | P5 |
| G2 | the partial index on current participants in messaging | P4 |
| G3 | load profile 4 run, and its results filed | P8 |
| G4 | [Q27](open-questions.md#q27--how-long-are-notifications-kept) and Q28 answered, or the per-reader notification cost explicitly accepted | policy |

Live sessions above the measured cap are likewise never enabled.

---

## 21. Load-testing plan

**No invented targets.** A run collects measurements; the institution sets
targets from the curves (Q26, Q57, Q65). Load tests never use production keys,
rooms or hosts; they run on a replica of the target hardware (Q65).

### 21.1 Tools

- **SFU:** `lk load-test` (livekit-cli). Simulated publishers and subscribers
  join with tokens the tool mints itself from the API key and secret, so it
  measures the SFU, not our API. It reports tracks received against expected,
  bitrate, packet loss and errors. Joins are paced per process, so a join
  storm needs parallel processes on several VMs. Run it from separate cloud
  VMs, never on the host under test. It does not report SFU CPU, memory, NIC
  throughput or join latency: collect those from LiveKit's Prometheus endpoint
  and host metrics. (Tool behaviour is taken from the livekit-cli source; the
  documentation site could not be read here.) Its identities are generated
  (`<prefix>_<n>`), not account ids, so the participant sweep and a presence
  observation drop them before any Communities or identity probe. A run that
  measures either seeds a community with test accounts and drives SFU clients
  with tokens from the API's `POST /live/sessions/:id/join` (a bot client, or
  a load tool that accepts external tokens).
- **API:** a Node harness built on `backend/test/support/realtime-client.ts`:
  signs in test accounts, holds WebSocket connections, drives HTTP commands
  (join, hands, grants, lock, invitations), and records per-request latency
  and per-frame delivery latency (server send time against client receive).
- **Postgres:** `pg_stat_statements` and `pg_locks`.

### 21.2 Profiles

| # | Profile | How | Measurements |
| --- | --- | --- | --- |
| 1 | 300 members in one session, audio only | `lk load-test` 1 audio publisher + 299 subscribers, ramped and as a storm (several processes); API: 300 accounts, 300 sockets, 300 joins inside the storm window, 50 hands in 10 s, 10 grant/revoke cycles | SFU CPU, memory, egress, packet loss, tracks received vs expected, connection errors; API p50/p95/p99 for join, hand and grant; token-mint time; event-loop lag; CPU and RSS; time from grant to `updateCapabilities`; moderator frame latency; statements per command; the raise-hand row-lock cost; database pool wait time and acquire timeouts (10 connections, 5 s, `database.ts:28-30`) and the p95 of an unrelated request mix (messaging reads, `/join`) during the join and hand storms; with real accounts, the participant sweep's statements and latency per tick |
| 2 | 1 teacher + 300 listeners + screen share | 1 audio + 1 video publisher at high resolution + 300 subscribers, with and without simulcast. **Screen share is approximated by one video publisher**, labelled as such | Profile 1's, plus egress split between audio and video and video packet loss. Decoding and battery on a low-end Android device are observed by hand (not possible here) |
| 3 | Many simultaneous communities | K parallel rooms, each 1 audio publisher + M subscribers, K stepped up until loss or CPU saturation; API: K concurrent starts, K active moderators, relay throughput | Node CPU and egress against total subscribed tracks; API p95 while the SFU is loaded on the same host |
| 4 | Large membership, no media | 30,000 and 100,000-member communities plus many small ones; a join storm through one link; community-chat fan-out; a lock with 10,000 sockets on one instance, 1 to 10,000 of them members | Keyset page latency (first, middle, last page); count; a 1,000-id probe; EXPLAIN plans; 1,000 concurrent joins against `maxUses` k; relay query counts and commit-to-last-send time; relay chain depth in a burst; the projection apply's lock hold time; realtime and notification cost per message; pool wait time, acquire timeouts and the p95 of an unrelated request mix during the join storm |
| 5 | Future large event | One room, 1 audio publisher, subscribers stepped 500 → 1,000 → 2,000 → 3,000 and on to the knee; at each step time `listParticipants` and record its size | The knee on the target node class — the evidence for Q57 and Q58. **No 30,000-listener single-room test and no promise of one** |

### 21.3 Correctness invariants under load

A run is complete when it finishes, every measurement for its profile is
recorded, it is repeated three times, and the environment (hardware, LiveKit
version and config, API commit) is written down. Under load: no listener track
is ever published; no 5xx that was not injected; every grant, revoke, start
and end has its audit row; `stateVersion` strictly increases and nothing is
missing after the final refetch; relay query counts stay within the derived
bound; no invitation exceeds `maxUses`; `member_count` equals count(ACTIVE).
Capacity verdicts are not pass/fail.

### 21.4 Where results go

`docs/architecture/load-tests/` (created in P8): one file per run and profile
— environment, measurements, invariants, knees. Q26, Q57 and Q65 are updated
with the evidence. The measured knees set the engineering ceiling; any lower
institutional cap is Q57's.

---

## 22. Testing strategy

| Layer | What | Phase |
| --- | --- | --- |
| Domain truth tables | `decideCommunityAct` over every act × basis × status (including an unmapped status); `statePermits` never blocks `community.lock`; `isPermission(act)` is false for every act; a speaker gains no community act; `capabilitiesFor` over every role; `projectMember`; `provider_registry_v1` normalization | P2, P3, P4, P6, P9 |
| Use cases | Specs use the real `PolicyAuthorizationService` with `principalWith()` (`test/support/principals.ts`). A TEACHER without standing is refused everything; an all-permission principal without standing cannot moderate; no live use case passes `ownerUserId`; no route issues a token without the `community.live.join` permit | P2, P6 |
| Postgres concurrency (`describeWithPostgres`, under `statement_timeout`) | 20 same-user redeems → 1 stint, uses 1; 50 users against `max_uses` 10 → exactly 10; revoke vs redeem and lock vs redeem consume no use when refused; redeem, revoke-link and removal of the link's creator run together without deadlock (P3); 10 concurrent locks → `lifecycle_version` +1 and 1 audit entry; `member_count` = count(ACTIVE); `changesSince` never skips a version while writers commit; grant races (a delegate's remove vs revocation of their grant; two delegates removing each other; transfer vs removal; two transfers; 50 identical grants → 1 row, 1 audit, 1 event); 20 concurrent chat materializations → 1 conversation; concurrent starts → 1 live session; double end → 1 transition and 1 event; concurrent raises → 1 open request; grants never exceed the cap; `state_version` +1 per change; 20 same-key attendance presses → 1 snapshot | P2–P9 |
| Scale fixtures | 30,000 and 100,000-member fixtures seeded with one `INSERT … SELECT … generate_series`; a query counter on the Drizzle logger; EXPLAIN shows index scans for probe, page and membership check, and no Seq Scan on the membership table; no `count(*)` in any request path; a member page = 1 statement + 1 directory call; latencies recorded, not asserted, until a baseline exists | P2, P4 |
| Architecture guards | rules-match (every forbidden rule matches a representative resolved path); the LiveKit rule proven non-vacuous; events live in contracts; module exports are contract tokens; no `forwardRef`; derived module lists; gate coupling; a boundary spec per new module (layers exist, domain purity, contracts-only reach, schema private, no cross-module FK via `pg_constraint`, LiveKit only in `live/infrastructure`, `LIVE_PRESENCE` allow-list, no `attendance.*` strings in attendance); the controller list (`authorization.spec.ts:79-94`) updated per phase | P0, then each phase |
| LiveKit adapter contract suite | Against a pinned LiveKit server in CI with `room.auto_create=false`, skipped without credentials: `ensureRoom` idempotent and surfacing errors; decoded tokens carry exactly the expected grants (listener: no sources, no data; speaker: MICROPHONE; presenter: SCREEN_SHARE; identity = user id; name from the directory; TTL); an absent identity maps to `not_connected`; `removeParticipant` and `endRoom` work; `listParticipants` is mapped and filtered; the provider's behaviour for a missing room is pinned. Behavioural checks (a listener's publish refused; a stale token cannot re-create a room) need a real client SDK in CI, chosen in P6 | P1, P6, P9 |
| Reconciler | With a fake provider seeded with participants: a member removed while connected is ejected within one tick even when no event was published; a divergent grant is re-applied; a revoked speaker still publishing loses the right; corrective acts audited with a null actor; a consistent session produces nothing; the regression where a speaker demoted 12 minutes earlier rejoins with a refreshed token; a repeated violation → exactly one media reset | P6 |
| Events and journals | Payload keys equal the contract type's keys, values are flat scalars; audit before event; a no-op writes neither; a failed audit publishes nothing; `publish()` resolves before relay or reaction work | each phase |
| Realtime | `OnlineAudience` property test (members 0–30,000, online 0–10,000): result = members ∩ online within 1 + ⌈A/1000⌉ calls, and messaging results equal the existing walk; relay audiences match the matrix; frames equal the golden fixtures; over a real WebSocket, a removed member receives `community.member.removed` and nothing about the community after it; existing messaging relay specs unchanged | P5, P7 |
| Messaging projection | Permutation, duplication and loss converge; the `greatest()` regression; a missed leave then a rejoin is detected by `source_membership_id`; a removed member is refused as soon as the removal commits; a member whose role loses `communities.read` gets no frame and no notification (`COMMUNITY_CHAT_READ_CEILING`); above `communityChatMaxServedMembers` a send gets 412 `messaging.community_chat_over_capacity` and `canPost` is false; existing `security.spec` and `membership.spec` pass unmodified | P4 |
| Flutter | Repository parsing against `MockClient` (unknown enums → unknown, missing booleans → false); capability-driven UI (every action shown iff its server boolean is true; no role reads); frame parsing from the golden fixtures, version ≠ 1 dropped; `LiveSessionController` state machine with fakes; `CommunityController` version handling; the `/invite` flow never logs the token; mock parity; architecture tests; the layout table at every viewport; attendance screens never compute a ratio | P0, P5, P7, P9 |

**Brief §27 coverage:** community authorization, membership isolation,
teacher scope and delegated scope → domain truth tables and use cases;
invitation security, concurrent joins, max-use and lock races → Postgres
concurrency; live lifecycle, speaker transitions, raise-hand idempotency →
Postgres concurrency and the reconciler; snapshot correctness, duplicate
requests, participant leaving during a snapshot → Postgres concurrency and
the participant-churn tests (the stored entries equal exactly the provider
list); adapter contract tests and boundary tests → their rows above; no N+1
and 30,000-member paging and counts → scale fixtures; Flutter items → the
Flutter row; load testing → [§21](#21-load-testing-plan).

---

## 23. ADR index

All status **Proposed**. ADR 0015 stays reserved for the academic structure
change (`academic-reconciliation.md:410`, `:490`, `:506`). Existing ADRs are
never edited.

| ADR | Decision | Amends or supersedes |
| --- | --- | --- |
| [0016](decisions/0016-communities-module.md) | A new `communities` module owns the Community aggregate, membership stints, invitation links and the OPEN/LOCKED lifecycle; imports Identity only; exports only contract tokens | Amends module-boundaries.md. Implementation gated by §13 (Q40) |
| [0017](decisions/0017-community-scoped-authorization.md) | identity ceiling AND Communities standing AND the lifecycle gate; a closed `community.*` act vocabulary disjoint from identity's catalogue; four bases; host-only moderation retired | Amends ADR 0005; would revise Q1's provisional answer (P6); supersedes the host-only paragraph of authorization.md |
| [0018](decisions/0018-community-chat-projection.md) | A community chat is a CHANNEL conversation plus `community_id`; messaging keeps a named, versioned, non-authoritative projection and asks Communities on every access; no write port; gates G1–G4 | Supersedes ADR 0011 §4–5 in part; amends messaging.md and the `MESSAGE_RECIPIENTS` comment |
| [0019](decisions/0019-community-scoped-live-sessions.md) | Community-scoped live sessions: Postgres truth, level-triggered LiveKit convergence, the presenter slot, narrow RTC ports, `auto_create=false`, capacity from measurement | Amends ADR 0003; supersedes the LiveRoom/halaqa design, "no screen share by construction" and the Redis queue plan (`realtime.md:542-553`) |
| [0020](decisions/0020-attendance-snapshots.md) | Attendance snapshots are immutable observations owned by a new leaf `attendance` module; implementation HELD | Supersedes in part ADR 0006's attendance example and module-boundaries.md's "operations derives attendance" |
| [0021](decisions/0021-cross-cutting-rules-for-new-modules.md) | Events in contracts; journals; durability classes and outbox triggers; the realtime transport matrix; protocol v1 growth; `FailureKind 'unavailable'`; executable guards; one API instance until P11 | Amends ADR 0006, ADR 0009 and ADR 0012 |

---

## 24. Open questions

Each question is written in full in [open-questions.md](open-questions.md).
The defaults below are PROVISIONAL: built so the design can proceed, not
decided.

| Q | Question | PROVISIONAL default (short) |
| --- | --- | --- |
| [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules) | Governance: which gates apply to the new modules? | Both the §13 step and the Attendance hold apply; only P0 and P1 may proceed, after acceptance of this design (and, for P1, approval of its visible changes) |
| [Q41](open-questions.md#q41--what-is-a-community-and-who-may-create-one) | What is a community, and who may create one? | `communities.create`: OWNER, ADMIN; `communities.read`: all six active roles; no parents |
| [Q42](open-questions.md#q42--community-ownership) | Community ownership | One owner on an ACTIVE stint; cannot leave or be removed; transferable |
| [Q43](open-questions.md#q43--institutional-oversight-of-communities) | Institutional oversight of communities | `communities.manage` views, locks, revokes, removes, recovers; never adds, reads chat, acts in live or sees attendance; reads audited |
| [Q44](open-questions.md#q44--who-may-hold-delegated-capabilities) | Who may hold delegated capabilities? | `communities.moderate` (TEACHER + OWNER, ADMIN); owner-only grants; subset rule for removals |
| [Q45](open-questions.md#q45--capability-grants-duration-handover-and-visibility) | Capability grants: duration, handover and visibility | No expiry; survive transfer; dormant on ceiling loss; owner sees all, holder sees own |
| [Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock) | What does LOCKED mean, and who may lock? | The `LifecycleEffects` table in §7.3; lock by owner, delegate or overseer |
| [Q47](open-questions.md#q47--retiring-a-community) | Retiring a community | No ARCHIVED; never deleted |
| [Q48](open-questions.md#q48--invitation-links) | Invitation links | Invite holders create; expiry 7 d default, 30 d max, 5 min min; optional `maxUses`; immediate join; dies with the creator's authority |
| [Q49](open-questions.md#q49--leaving-removal-and-rejoining) | Leaving, removal and rejoining | Non-owners may leave; REMOVED cannot rejoin by link; no reason field; only the removed person is told |
| [Q50](open-questions.md#q50--communities-and-the-academic-structure) | Communities and the academic structure | No halaqa link, no enrollment-sourced membership in v1 |
| [Q51](open-questions.md#q51--the-community-chat-who-may-post) | The community chat: who may post? | One CHANNEL chat; posting by owner or grant; refused while LOCKED; no message moderation in v1 |
| [Q52](open-questions.md#q52--community-chat-history-for-newcomers-and-returners) | Community chat history for newcomers and returners | Full history; a rejoin starts a new window |
| [Q53](open-questions.md#q53--system-notices-in-a-community-chat) | System notices in a community chat | None; the chat is written by people only |
| [Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session) | Who starts, ends and moderates a live session? | Start: `live.moderate` + `community.live.start`; moderate: `community.live.moderate` or the host; no institution-wide override |
| [Q55](open-questions.md#q55--parallel-live-sessions-in-one-community) | Parallel live sessions in one community | At most one; a second start returns the running one |
| [Q56](open-questions.md#q56--screen-sharing) | Screen sharing | One presenter; a moderator holding `live.speak`, for themself; no screen audio, no recording |
| [Q57](open-questions.md#q57--live-session-size-and-concurrency) | Live session size and concurrency | Cap 300 + reserve 10; 412 when full; raised only after profiles 1–3 |
| [Q58](open-questions.md#q58--more-listeners-than-one-room-can-hold) | More listeners than one room can hold | Not built; a broadcast seam reserved inside Live |
| [Q59](open-questions.md#q59--visibility-inside-a-live-session) | Visibility inside a live session | Roster visible; hands queue to moderators; `hidden` always false |
| [Q60](open-questions.md#q60--one-account-on-several-devices-in-a-session) | One account on several devices in a session | No; newest device wins; no auto-rejoin |
| [Q61](open-questions.md#q61--ending-abandoned-live-sessions) | Ending abandoned live sessions | `idle` after 900 s observed empty; never for host absence; no maximum |
| [Q62](open-questions.md#q62--floor-rules-beyond-first-come-first-served) | Floor rules beyond first come, first served | Grants only from a raised hand; a speaker may yield; no timeouts; cap 4 |
| [Q63](open-questions.md#q63--losing-standing-during-a-running-session) | Losing standing during a running session | Immediate on the event, ≤ 60 s by the sweep; hand, floor, presenter close; a second violation inside the enforcement window resets the media room automatically, and every participant reconnects briefly (P6) |
| [Q64](open-questions.md#q64--removing-a-participant-from-a-session) | Removing a participant from a session | Not built; seams only; a moderator-initiated media reset planned for P12 (the automatic reset on a repeated violation is Q63's, P6) |
| [Q65](open-questions.md#q65--media-hosting-and-operations) | Media hosting and operations | Self-hosted LiveKit, `auto_create=false`, no webhooks, no recording; TURN before the first class; never load-test production |
| [Q66](open-questions.md#q66--realtime-without-messagingread) | Realtime without messaging.read | The gate stays `messaging.read`; a test pins the coupling |
| [Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts) | Notifications for community, live and attendance facts | None; events are published for later translators |
| [Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot) | What counts as present in a snapshot? | Nothing labelled present; CONNECTED and CONNECTING stored separately under a versioned rule |
| [Q69](open-questions.md#q69--who-records-and-who-views-snapshots) | Who records and who views snapshots? | Record: the owner, the session's host and moderators, a `community.attendance.record` grantee; view: the owner, a `community.attendance.view` grantee, and the host or a recorder for their own sessions; asked in the fallback order of [attendance.md §11.3](attendance.md#113-attendanceaccess-how-refusals-map); no `attendance.*`. Named alternative, not the default: owner or grant only; recording does not imply viewing |
| [Q70](open-questions.md#q70--is-a-snapshot-the-attendance-record) | Is a snapshot the attendance record? | Observation only; nothing derived; operations may depend on attendance later, never the reverse |
| [Q71](open-questions.md#q71--correcting-retaining-and-erasing-snapshots) | Correcting, retaining and erasing snapshots | Immutable; kept like the audit log until Q3 |
| [Q72](open-questions.md#q72--when-and-how-often-snapshots-are-taken) | When and how often snapshots are taken | Only on a press; 6 per 60 s per recorder; concurrency 4; 15 s; 10,000 entries |

**Existing questions this package cites:**
[Q1](open-questions.md#q1--what-may-each-role-actually-do) (host-only answer
to be revised by ADR 0017 in P6),
[Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history)
(nothing new is deleted),
[Q8](open-questions.md#q8--who-may-amend-attendance-and-is-a-reason-mandatory)
and [Q12](open-questions.md#q12--timezone-and-academic-calendar) (§13's
Attendance row: met before P9, or ruled by the user not to apply to
snapshots, which use no amendment and no calendar),
[Q4](open-questions.md#q4--how-many-concurrent-speakers-and-in-what-order)
(4 speakers, FCFS, unchanged),
[Q5](open-questions.md#q5--what-happens-when-the-media-provider-and-our-record-disagree)
(the record wins; the reconciler converges),
[Q20](open-questions.md#q20--messaging-limits) (no community size limit as
policy; messaging caps do not apply to community chats),
[Q21](open-questions.md#q21--does-someone-joining-a-group-see-what-was-said-before),
[Q22](open-questions.md#q22--who-may-see-who-is-in-a-conversation) (rosters
need `community.members.view`),
[Q23](open-questions.md#q23--moderation-deletion-and-review),
[Q26](open-questions.md#q26--realtime-limits),
[Q27](open-questions.md#q27--how-long-are-notifications-kept) and
[Q28](open-questions.md#q28--what-deserves-a-notification-and-how-loudly)
(gate G4), [Q31](open-questions.md#q31--teaching-scope-and-what-staff-may-see)
(`attendance.*` stays unexercised),
[Q35](open-questions.md#q35--the-seven-core-sections-against-the-printed-profile)
and [Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups)
(the §13 gate).

---

## 25. Implementation phases

Every phase exits with `npm run verify` and `flutter test` green. No phase
leaves a caller without its callee, a frame without its HTTP reconciliation
read, or a join without its membership check.

| Phase | Scope | Entry | Exit | Blocked on |
| --- | --- | --- | --- | --- |
| **P0** Corrections and guards (no feature code) | All of [§25.1](#251-phase-0-corrections) | This design accepted | depcruise 0 errors; every forbidden rule proven non-vacuous; the only production diffs are the byte-identical Live event move and the additive `FailureKind` | nothing |
| **P1** Live hardening (no Communities) | `LiveParticipantRole` rename; total `RtcCapabilities`, listeners `canPublishData=false`; narrow RTC ports; adapter hardening (explicit sources, full permission set, `createRoom` errors surfaced, NotFound → outcome, network → `RtcUnavailableError`); names from `ACCOUNT_DIRECTORY`, DTO field removed; an explicit audit action per moderation act (fixes `moderate-speaker.use-case.ts:193`); views; idempotent raise, withdraw, yield, decline; indexed repository methods. Still in memory and halaqa-bound | P0 | Live suites green with approved behaviour changes; no port returns all of a session's requests; no secret or JWT in logs | approval of visible changes: listener data off, raise 202 → 201 for a new hand and 409 → 200 for an open one, TTL 600 → 120 s |
| **P2** Communities core | The module (domain, Postgres and in-memory adapters, `/communities`, journal, events); stints, invitations (redemption re-checks the creator's ceiling and ACTIVE OWNER stint), lock/unlock; `COMMUNITY_AUTHORIZATION` (membership, owner, oversight bases), `COMMUNITY_MEMBERSHIP`, `COMMUNITY_DIRECTORY`; catalogue + migration 0009; boundary spec; 30k/100k fixtures | P0; the §13 step complete (Q35/Q36 answered, ADR 0015 landed), or the user's ruling on Q40; Q41–Q49 defaults recorded; Q42 (one owner or several) put to the institution, and its answer or an explicit acceptance of the one-owner default recorded, because P2 builds the one-owner index | The Postgres concurrency suite; EXPLAIN index scans at 30k and 100k; one audit and one event per effective change; the TEACHER-without-standing refusal matrix; mock parity | **Q40** (the §13 step, or the user's ruling) |
| **P3** Delegation | Grants table; grant, revoke, transfer; the grant basis; `COMMUNITY_CAPABILITY_HOLDERS`; capability and ownership events; basis re-verified under lock; redemption's creator re-check gains the grant lookup | P2 | The truth table; the grant races; dormancy on ceiling loss; holders keyset under churn | P2 |
| **P4** Community chat | Additive columns and CHECKs (`source_version`, `source_membership_id`, `source_joined_at` under the shape CHECK); projection, applier, materialization, sync, sweeper, reconciler (both adapters); the `ConversationAccess` branch; posting via permit; the capacity switch; 412 and 403 refusals; lag filter; the `COMMUNITY_CHAT_READ_CEILING` narrowing (the constant added to Communities' `capabilities.ts`); `authorizeEach` list views; the new route; the G2 index | P2 (P3 only for delegated posting) | A removed member refused at commit; projection property tests; 20 materializations → 1; existing security and membership specs unmodified; exports unchanged; chats disabled above the tested size until G1, G3, G4 | P2 |
| **P5** Community realtime and Flutter communities | `onlineUserIds`, `OnlineAudience` (messaging relay swaps onto it: G1); `CommunitiesRealtimeRelay`; `community.*` frames; golden fixtures; Flutter `CommunityRepository`, frame families, capability-driven screens, `/invite`, `conversationForCommunity` | P2 (P3 for `access.changed`) | `OnlineAudience` property test; relay and WebSocket API tests; existing relay specs; Flutter parsing, golden, parity, boundary and layout tests | P2 |
| **P6** Community-scoped live sessions (backend) | `LiveSession` replaces `LiveRoom`; Postgres adapters with the start/end routes; `LiveAccess`; stop passing `ownerUserId` and retire `host-only-moderation` in the same change; join and raise through `COMMUNITY_AUTHORIZATION`; idempotent start and end; ensure-then-recheck; presenter slot; reconciler, with `RtcParticipantObserver.listParticipants` and the automatic media reset on a repeated violation; `COMMUNITY_AUTHORIZATION.permittedAmong` and `community.live.remain` in Communities; `ProtectLiveSessions`; soft and hard caps; `LIVE_AUDIENCE`, `LIVE_SESSIONS`; `AppConfig.live`; pinned LiveKit config and the adapter contract suite in CI | P1, P2, P3; LiveKit in CI | Contract suite green against a real server; lifecycle, cap and presenter concurrency; reconciler tests including the refreshed-token regression; no token without the permit; an all-permission principal without standing cannot moderate; no `ownerUserId` passed | P2, P3, LiveKit in CI |
| **P7** Live realtime and Flutter live | `LiveRealtimeRelay` with coalescing; `LiveRepository`; `LiveEvent` families; `LiveSessionController`; `LiveMediaClient` bound to Unavailable; screens that say live audio is unavailable | P5, P6 | State-machine tests with fakes; mock mode never yields a usable media grant | P5, P6 |
| **P7b** Media binding | `LiveKitLiveMediaClient` as the only `livekit_client` importer; Android foreground service and iOS broadcast extension | An ADR; devices or CI for Android, iOS and web | Device evidence recorded | a device-capable environment |
| **P8** Load tests | Profiles 1–5 ([§21](#21-load-testing-plan)) on the target topology with non-production keys | SFU profiles: a LiveKit server on the target topology; API profiles: P7; profile 4: P2, P4 and P5 | Results filed; three runs each; invariants hold; Q26, Q57, Q65 updated; capacity config from the knees; nothing above them enabled | matching hardware |
| **P9** Attendance (**HELD**) | The module; `LIVE_PRESENCE` (`LivePresenceService` over the `listParticipants` port that P6's reconciler already uses); the attendance acts added by CHECK migration with ceilings using no `attendance.*`; `attendance-boundaries.spec`; Flutter `AttendanceRepository` | The §13 step (Q35/Q36 and ADR 0015) and the reconciliation review, or the user's ruling on Q40; §13's Attendance row met (Q8, Q12, not TE-04), or ruled by the user not to apply to snapshots; reviewer acceptance of Q69; P6 | 20 same-key presses → 1 snapshot; churn tests equal the provider list; mid-read end → 412, nothing stored; attendance never imports LiveKit | **Q40, Q69**, §13's Attendance row (Q8, Q12), P6 |
| **P10** Notification translators | Translators importing only contracts; recipients at delivery time; Q28's collapse seam | Q67 and Q28 answered; the outbox first if T2 | Translator tests; a notification never grants access | Q67, Q28 |
| **P11** Horizontal scale | Outbox via the journals' unit of work; broker with every-instance and one-instance delivery; Redis `RateLimiter`; reconciler lease | Evidence that one instance is not enough (T3), or T2/T4 | Multi-instance tests: no duplicate reactions; relays deliver on every instance | P8 evidence |
| **P12** Policy-gated Live features | A moderator-initiated media-room reset; kick and re-entry; delegated or audio screen share; hidden listeners; webhook accelerators; `community.messages.moderate` | Q64, Q56, Q59, Q51/Q23 as each needs | Per feature | policy answers |

### 25.1 Phase 0 corrections

| # | Correction | Why | Files |
| --- | --- | --- | --- |
| 1 | Fix `application-has-no-vendor-sdks`: `to.path` must match resolved `node_modules/…` paths ([§7.6](#76-attendance-shared-kernel-realtime-rules-operations)) | Anchored at the package name, it never fires; the new modules' application layers would go unchecked. Reports 0 violations on today's graph | `backend/.dependency-cruiser.cjs:79-90`; `docs/architecture/dependency-rules.md` |
| 2 | Add `livekit-sdk-only-in-the-live-adapter` (modelled on the ws and push rules), and a live-boundaries spec asserting the adapter's edge exists | "LiveKit in exactly one file" is claimed but enforced only in `domain/` and by the messaging, notifications and academic specs; the `application/`, `api/` and `infrastructure/` layers of every other module (communities included), and `platform/`, could import it undetected | `backend/.dependency-cruiser.cjs` (after `:117`); `backend/test/architecture/live-boundaries.spec.ts` (new) |
| 3 | Add `rules-match.spec`: every forbidden rule with a `to.path` matches a representative resolved path | A rule that matches nothing always passes; this catches the whole class | `backend/test/architecture/rules-match.spec.ts` (new) |
| 4 | Extend boundaries: (a) no `DomainEvent<'literal'>` outside `*/contracts/` except an allow-list of identity's current events; (b) every `*.module.ts` export is imported from `./contracts/`; (c) no `forwardRef(` under `src/` | Makes "modules talk only through contract tokens or events" and "no Nest cycle papered over" executable. (b) already holds for academic:135, files:55, identity:181, messaging:108, notifications:108 | `backend/test/architecture/boundaries.spec.ts`; `backend/test/architecture/events.spec.ts` (new) |
| 5 | Derive module lists instead of hard-coding them; update the controller list in each phase that adds a controller | The lists name existing modules only, so communities, live's new contracts and attendance would be unchecked | `notifications-boundaries.spec.ts:49-64`; `realtime-boundaries.spec.ts:106-116`; `authorization.spec.ts:79-94` |
| 6 | Gate-coupling test: every role holding `live.join` or `communities.read` also holds `messaging.read` | The connection gate is `messaging.read`; a role outside it would silently get no frames, and the app stops retrying after 4403 (Q66) | `backend/src/modules/identity/domain/role.spec.ts` (or `realtime-boundaries.spec.ts`) |
| 7 | Move Live's event names and payloads into `live/contracts/events.ts` as `LiveEvents`, byte-identical; factories import from `../contracts/events` (the missing `live.speaker.requested` row is already in the events.md catalogue, [§25.3](#253-what-this-pass-did-not-do)) | Subscribers cannot import `live/domain` (type-only imports count); follows `messaging/domain/events.ts:1-9` | `backend/src/modules/live/domain/events.ts:9-77`; `backend/src/modules/live/contracts/index.ts:7` |
| 8 | Add `FailureKind 'unavailable'` → 503; update `KIND_BY_STATUS` and `CODE_BY_STATUS`; check the Flutter error parsing tolerates it | The designed 503s cannot be represented today | `backend/src/shared/result.ts:21-28`; `backend/src/platform/http/http-failure.ts:12-20`; `backend/src/platform/http/all-exceptions.filter.ts:33-56` |
| 9 | Pin the academic upgrade test: `migrateTo(scratch.db)` → `migrateTo(scratch.db, 9)`; 0009 gets its own upgrade test asserting its exact grant delta | The test migrates to the latest and asserts the seven academic grants exactly, so 0009 would break it. `upTo` counts journal entries (9: 0000–0008), so 9 is correct | `backend/test/integration/academic-postgres.spec.ts:580` |
| 10 | Flutter live guard: no `livekit_client`, `flutter_webrtc` or `dart_webrtc` in pubspec or `lib/`; extend the screen import bans to the new feature directories | "A dependency is never added blind" (`media_seams.dart:5-13`) must be executable before any live UI | `app/test/live/live_boundaries_test.dart` (new); `app/test/academic/academic_boundaries_test.dart:51-94` |
| 11 | Correct the code comments stating the retired or false design. The documents stating it (`module-boundaries.md:57-60`, `:146-149`, `:241-243`; `realtime.md:573`; `overview.md:146-148`) already carry this package's labelled correction notes or proposed-change pointers; their rewrites are §25.2's P0 rows | Otherwise two modules appear to own attendance, and a new module could be misled about how permissions are added | `backend/src/modules/operations/contracts/index.ts:1-6`; `backend/src/modules/live/domain/events.ts:3-7` |
| 12 | Reserve numbering: Q40–Q72 in open-questions.md; ADRs 0016–0021 with status Proposed; ADR 0015 stays reserved | Earlier drafts of this design numbered their questions from Q40 independently; 0015 is reserved at `academic-reconciliation.md:410`, `:490`, `:506` | `docs/architecture/open-questions.md`; `docs/architecture/decisions/0016`–`0021` (new); `docs/architecture/decisions/README.md` |
| 13 | Governance: before P2, the §13 step (Q35/Q36 and ADR 0015) or the user's ruling on Q40; before P9, also the reconciliation review (with §13's Attendance row) or that ruling | A design must not lift a user constraint on its own | `docs/architecture/academic-reconciliation.md:19-21`, `:483-493` (read, not edited) |

### 25.2 Documents this package asks to change later

This package added only labelled notes and pointers to these documents
([§25.3](#253-what-this-pass-did-not-do)); the rewrites below land with the
phase named. Line numbers are at `9670c47`.

| File | Change | Phase |
| --- | --- | --- |
| `module-boundaries.md` | Sections for communities and attendance (held); messaging depends on communities contracts and owns the link and projection; live is community-scoped with three new contracts; realtime depends on communities and live contracts; drop "operations derives attendance" (`:146-149`); rewrite `:57-60`, which carries a correction note | P0, P2, P6 |
| `open-questions.md` | Q1's provisional line revised when ADR 0017 lands (a pointer is already there) | P6 |
| `events.md` | Add the communities, new live and attendance events; remove "operations (attendance)" from `live.session.ended`; durability classes and T1–T4 | P0, P2, P6 |
| `realtime.md` | Replace "no screen share by construction" (`:420-428`); rewrite the leaked-token claim (`:505-510`), which carries a correction note; mark the Redis queue and presence plan (`:542-553`) superseded; `:573` cites the new rule; add the matrix, frames, `OnlineAudience` and limits | P0, P5, P6 |
| `authorization.md` | Ceiling AND module-owned standing; retire the host-only text (`:161-190`, `:219-243`) when P6 lands; delegation as Communities-owned grants (`:317-326`) | P2, P3, P6 |
| `messaging.md` | Community chats, 412 refusals, `members_hidden`, no messaging cap, the lag filter, G1–G4, the new route | P4 |
| `dependency-rules.md` | The corrected regex; the LiveKit rule; rules-match, no-`forwardRef`, exports-are-contracts; contracts import specific identity files, never the barrel | P0 |
| `overview.md` | Cite the enforcing rule at `:146-148`; add communities and attendance to the module map; state that 30,000 members is not 30,000 live participants | P0, P2 |
| `persistence.md` | The per-aggregate commit-ordered version technique; the communities lock order | P2 |
| code comments | `operations/contracts/index.ts:1-6` and `live/domain/events.ts:3-7` (P0); `message-recipients.ts:13-20` and the `messaging.module.ts` header (P4); `rtc-provider.ts` "2500-room" wording (P1) | as named |

### 25.3 What this pass did not do

- **It implemented nothing.** No production code, test, migration, schema,
  seed, configuration, pubspec change, endpoint, event publisher, realtime
  frame, repository or screen. Existing behaviour is unchanged.
- **It did not carry out Phase 0's code, test or configuration items**
  (1–10, and the code comments of 11); item 13 is the user's. Of item 12,
  only the numbering is taken: Q40–Q72 and ADRs 0016–0021 (Proposed) are
  written as documents of this package.
- **In existing documents it added only labelled notes:** "Correction
  (2026-09-23)" notes where a statement is false about today's code, and
  "Proposed change" or "Proposed design (Q40–Q72)" pointers to this package,
  in module-boundaries.md, realtime.md, authorization.md, messaging.md,
  events.md (including the missing `live.speaker.requested` catalogue row),
  dependency-rules.md, overview.md, persistence.md and open-questions.md
  (including the notes under Q20, Q22 and Q36), plus new rows in
  decisions/README.md and README.md. The substantive rewrites in §25.2 land
  with their phases.
- **It measured nothing.** No load test, LiveKit benchmark or EXPLAIN on real
  data was run. Every capacity figure here is configured or derived.
- **It did not read LiveKit's documentation site,** which is unreachable from
  this environment. LiveKit behaviour is taken from the server and SDK source;
  the ~3,000-per-room figure is second-hand and unverified.
- **It decided no institutional policy.** Q40–Q72 carry PROVISIONAL defaults
  only.
- **It did not lift or reinterpret the academic hold or the §13 gate** (Q40).
- **It did not start P1 or any later phase,** and verified no Flutter media
  dependency on any device.

---

## Appendix A. Cross-module sequences

Participants are columns; messages are numbered. Refusals are listed under
each diagram.

### A1. Join through an invitation link, then open the chat

```
 App              Communities              Postgres (communities)     Bus              Messaging            Realtime
  │                    │                           │                   │                   │                   │
  │ 1 POST /communities/join {token}               │                   │                   │                   │
  │───────────────────▶│                           │                   │                   │                   │
  │                    │ 2 ceiling communities.read; per-IP and per-user limits; token shape; h = SHA-256(token);
  │                    │   lookup by h → {L, C, creator K}; creator ceiling withPermission([K]) (before BEGIN)
  │                    │ 3 BEGIN; pair advisory lock (C,U); latest stint of (C,U)
  │                    │──────────────────────────▶│                   │                   │                   │
  │                    │ 4 UPDATE invitation SET uses+1 WHERE not revoked, not expired, uses < max_uses
  │                    │──────────────────────────▶│                   │                   │                   │
  │                    │ 5 (P2 owner stint; P3 + grant) the creator still holds community.members.invite:
  │                    │   K's ACTIVE stint FOR SHARE (P2: must be OWNER); P3: or K's grant FOR SHARE (Q48)
  │                    │ 6 UPDATE community SET member_count+1, membership_version+1 → v WHERE status accepts
  │                    │──────────────────────────▶│                   │                   │                   │
  │                    │ 7 INSERT stint (ACTIVE, INVITATION, version v); COMMIT
  │                    │──────────────────────────▶│                   │                   │                   │
  │                    │ 8 audit communities.member.joined; publish communities.member.added {C,U,membershipId,v}
  │                    │──────────────────────────────────────────────▶│                   │                   │
  │ 9 201 CommunityResponse                        │                   │                   │                   │
  │◀───────────────────│                           │                   │ 10 wake-up        │                   │
  │                    │                           │                   │──────────────────▶│ 11 changesSince → apply
  │                    │                           │                   │ 12 relay          │    projection row  │
  │                    │                           │                   │──────────────────────────────────────▶│
  │ 13 frame community.member.added {communityId, userId} (to U only)  │                   │                   │
  │◀───────────────────────────────────────────────────────────────────────────────────────────────────────────│
  │ 14 GET /messaging/communities/C/conversation   │                   │                   │                   │
  │───────────────────────────────────────────────────────────────────────────────────────▶│                   │
  │                    │ 15 authorize(U, C, community.chat.read)       │                   │                   │
  │                    │◀──────────────────────────────────────────────────────────────────│                   │
  │                    │ 16 permit {basis membership, membershipId, version v}             │                   │
  │                    │──────────────────────────────────────────────────────────────────▶│ 17 materialize if missing
  │                    │                           │                   │                   │    (ON CONFLICT); repair own
  │                    │                           │                   │                   │    row if the projection lags
  │ 18 200 ConversationResponse (CHANNEL, communityId, canPost: community.chat.post permit + capacity switch)  │
  │◀───────────────────────────────────────────────────────────────────────────────────────│                   │
```

Refusals consume no use. Step 2 refusals happen before any transaction;
refusals at 3–7 roll back everything. 404 `communities.invitation_invalid`:
an unknown or malformed token or a creator without the ceiling (step 2), or a
creator who lost the right to invite (step 5: from P2 no longer the ACTIVE
OWNER, from P3 also a delegate whose grant ended), as in
[communities.md S3](communities.md#s3--redeem-a-link-p2);
200 when already a member (step 3, no use consumed, no audit, no event); 403
`communities.rejoin_requires_manager`; 412 `communities.invitation_revoked`,
`invitation_expired`, `invitation_exhausted` (step 4) or `community_locked`
(step 6). Steps 3–7 follow the global lock order of
[§5.2](#52-the-global-lock-order-communities): pair, invitation, stints and
grants, community, insert.

### A2. Start a live session and join it

```
 Teacher app        Live                 Communities         Postgres (live)       LiveKit            Realtime          Member app
  │ 1 POST /live/communities/C/sessions  │                      │                     │                  │                   │
  │───────────────────▶│                 │                      │                     │                  │                   │
  │                    │ 2 ceiling live.moderate (no ownerUserId)                     │                  │                   │
  │                    │ 3 authorize(T, C, community.live.start)│                     │                  │                   │
  │                    │────────────────▶│                      │                     │                  │                   │
  │                    │ 4 permit (or 404 / 403 / 412 lifecycle gate)                 │                  │                   │
  │                    │◀────────────────│                      │                     │                  │                   │
  │                    │ 5 live session of C? found → 200 same view, no provider call  │                  │                   │
  │                    │───────────────────────────────────────▶│                     │                  │                   │
  │                    │ 6 ensureRoom(prefix+id+epoch, maxParticipants = cap+reserve)  │                  │                   │
  │                    │─────────────────────────────────────────────────────────────▶│ (auto_create=false)                  │
  │                    │ 7 INSERT live_sessions ON CONFLICT (community_id) WHERE live DO NOTHING; moderation row
  │                    │───────────────────────────────────────▶│  lost race → endRoom(own room), 200 winner             │
  │                    │ 8 audit + publish live.session.started {sessionId, communityId, hostUserId}               │
  │                    │────────────────────────────────────────────────────────────────────────────────▶│                   │
  │ 9 201 LiveSessionView                │                      │                     │                  │ 10 online members,
  │◀───────────────────│                 │                      │                     │                  │    then participantsAmong
  │                    │                 │                      │                     │                  │──────────────────▶│
  │                    │                 │                      │     11 frame live.session.started {communityId, sessionId}   │
  │                    │ 12 POST /live/sessions/S/join (no body)│                     │                  │                   │
  │                    │◀──────────────────────────────────────────────────────────────────────────────────────────────────────│
  │                    │ 13 ceiling live.join; load S; authorize(M, S.communityId, community.live.join)                        │
  │                    │────────────────▶│  non-member → 404 live.session_not_found   │                  │                   │
  │                    │ 14 S live? (else 412); rate limit; room check (cached) — missing → ensureRoom, re-read S:            │
  │                    │    ended → endRoom, 412; listener over the soft cap → 412 live.session_full                           │
  │                    │ 15 capabilitiesFor(standing); name from ACCOUNT_DIRECTORY; token (identity = userId, TTL 120 s)       │
  │                    │ 16 200 {token, url, expiresInSeconds: 120, role, media}                                              │
  │                    │──────────────────────────────────────────────────────────────────────────────────────────────────────▶│
  │                    │                 │                      │                     │ 17 LiveMediaClient.connect(grant)     │
  │                    │                 │                      │                     │◀══════════════════════════════════════│
  │                    │                 │                      │                     │ hard cap = cap + reserve; same identity
  │                    │                 │                      │                     │ evicts the older device             │
```

If LiveKit is down at step 6: 503 `live.media_unavailable`, nothing stored,
no audit, no event. If it is down at step 14, the token is still issued and
the room and cap checks fail open to the SFU's hard cap.

### A3. Raise hand, grant, publish, revoke

```
 Student app          Live                    Postgres (live)          LiveKit              Realtime            Moderator app
  │ 1 POST /live/sessions/S/hand                 │                        │                    │                    │
  │───────────────────▶│                         │                        │                    │                    │
  │                    │ 2 ceiling live.raise_hand; permit community.live.raise_hand (stored communityId)             │
  │                    │ 3 S FOR UPDATE (live); INSERT request ON CONFLICT (S,user) WHERE open DO NOTHING RETURNING;  │
  │                    │   if inserted: state_version+1 → v; COMMIT (fast path: an unlocked read of an open request)  │
  │                    │────────────────────────▶│                        │                    │                    │
  │ 4 201 own request (200 with the existing open request: no event)       │                    │                    │
  │◀───────────────────│                         │                        │                    │                    │
  │                    │ 5 publish live.speaker.requested {…, stateVersion v}                  │                    │
  │                    │──────────────────────────────────────────────────────────────────────▶│ 6 live.session.changed
  │                    │                         │                        │                    │   {C,S,v} to moderators
  │                    │                         │                        │                    │   (coalesced) + student
  │                    │                         │                        │                    │───────────────────▶│
  │                    │ 7 GET /live/sessions/S (v newer than held) → view with the hands queue │                    │
  │                    │◀───────────────────────────────────────────────────────────────────────────────────────────│
  │                    │ 8 POST /live/requests/R/grant                    │                    │                    │
  │                    │◀───────────────────────────────────────────────────────────────────────────────────────────│
  │                    │ 9 ceiling live.moderate before load; LiveAccess: community.live.moderate, or host +          │
  │                    │   community.live.host; the student still eligible (else 412 live.target_not_eligible)        │
  │                    │ 10 S FOR UPDATE; count(granted) < 4 (else 412 live.speaker_slots_full); R pending → granted; │
  │                    │    state_version+1; moderation row; COMMIT       │                    │                    │
  │                    │────────────────────────▶│                        │                    │                    │
  │                    │ 11 updateCapabilities(room, student, FULL set: audio on) → applied | not_connected | pending │
  │                    │─────────────────────────────────────────────────▶│                    │                    │
  │                    │ 12 audit live.speaker.granted; publish → live.session.changed to moderators + student         │
  │                    │ 13 200 {request, media}                          │                    │                    │
  │                    │───────────────────────────────────────────────────────────────────────────────────────────▶│
  │ 14 permission update: MICROPHONE allowed (ParticipantPermissionsUpdated)                    │                    │
  │◀══════════════════════════════════════════════════════════════════════│                    │                    │
  │ 15 setMicrophoneEnabled(true) → publish audio; the room hears it      │                    │                    │
  │══════════════════════════════════════════════════════════════════════▶│                    │                    │
  │                    │ 16 POST /live/requests/R/revoke                  │                    │                    │
  │                    │◀───────────────────────────────────────────────────────────────────────────────────────────│
  │                    │ 17 CAS granted → revoked; state_version+1; moderation row; COMMIT                            │
  │                    │────────────────────────▶│                        │                    │                    │
  │                    │ 18 updateCapabilities(FULL set: audio off) — LiveKit unpublishes the microphone at once       │
  │                    │─────────────────────────────────────────────────▶│                    │                    │
  │ 19 microphone track removed; back to listener                         │                    │                    │
  │◀══════════════════════════════════════════════════════════════════════│                    │                    │
  │                    │ 20 audit + publish live.speaker.revoked → live.session.changed        │                    │
  │                    │ 21 reconciler: targeted watch (10 s) and participant sweep (60 s) — a client that rejoins    │
  │                    │    with an earlier refreshed speaker token is demoted again, and a violation is counted;     │
  │                    │    a second violation inside the window resets the media room (P6)                           │
```

### A4. Record an attendance snapshot (HELD)

```
 Teacher app        Attendance            Live (contracts)          Communities         LiveKit            Postgres (attendance)
  │ 1 POST /attendance/live-sessions/S/snapshots {clientRequestId K}     │                   │                      │
  │───────────────────▶│                        │                        │                   │                      │
  │                    │ 2 validate K (else 422)│                        │                   │                      │
  │                    │ 3 LIVE_SESSIONS.describe(S) → {S, C, hostUserId, active}                                   │
  │                    │   (null → 404 attendance.session_not_found)                                                │
  │                    │───────────────────────▶│                        │                   │                      │
  │                    │ 4 AttendanceAccess, in the fallback order of attendance.md §11.3: authorize(T, C,          │
  │                    │   community.attendance.record); on forbidden, community.live.moderate; on forbidden, if    │
  │                    │   T = hostUserId, community.live.host. The first permit wins (into the audit metadata).    │
  │                    │   None: not_found or identity.permission_denied → 404 attendance.session_not_found;        │
  │                    │   capability_required → 403 attendance.not_allowed; community_locked → 412                 │
  │                    │   attendance.community_not_open                                                            │
  │                    │────────────────────────────────────────────────▶│                   │                      │
  │                    │ 5 replay lookup (S, T, K) → found: 200 stored snapshot; nothing else happens              │
  │                    │─────────────────────────────────────────────────────────────────────────────────────────▶│
  │                    │ 6 not active → 412 attendance.session_not_live; rate limit → 429 (no provider call)       │
  │                    │ 7 LIVE_PRESENCE.observe(S)                      │                   │                      │
  │                    │───────────────────────▶│ 8 record active? concurrency slot; observationStartedAt           │
  │                    │                        │ 9 listParticipants(room): ONE read, 15 s deadline                  │
  │                    │                        │─────────────────────────────────────────────▶│                    │
  │                    │                        │ 10 registry: JOINING / JOINED / ACTIVE, kinds, identities           │
  │                    │                        │◀─────────────────────────────────────────────│                    │
  │                    │                        │ 11 provider_registry_v1: STANDARD + account-shaped; DISCONNECTED   │
  │                    │                        │    dropped; ACTIVE → connected, JOINING/JOINED → connecting;       │
  │                    │                        │    one per account; observedAt; record still active?               │
  │                    │ 12 observed {C, observationStartedAt, observedAt, participants}                           │
  │                    │◀───────────────────────│   (not_active → 412; unavailable → 503; nothing stored)            │
  │                    │ 13 assert observation.communityId == C          │                   │                      │
  │                    │ 14 BEGIN; INSERT header ON CONFLICT (idempotency) DO NOTHING RETURNING; entries in        │
  │                    │    statements of ≤ 1,000 rows; COMMIT (conflict → ROLLBACK, return the stored one: 200)    │
  │                    │─────────────────────────────────────────────────────────────────────────────────────────▶│
  │                    │ 15 audit attendance.snapshot.recorded; publish {snapshotId, C, S, recordedBy, observedAt, counts}
  │ 16 201 SnapshotView (counts only; entries are viewed separately)    │                   │                      │
  │◀───────────────────│                        │                        │                   │                      │
```

### A5. A removed member loses chat and live access

```
 Manager app     Communities        Postgres        Bus         Live (ProtectLiveSessions)   LiveKit        Messaging        Realtime     Removed app
  │ 1 DELETE /communities/C/members/U  │            │                   │                     │               │               │               │
  │──────────────▶│                    │            │                   │                     │               │               │               │
  │               │ 2 authorize community.members.remove (allowed while LOCKED); U is not the owner; P3 subset rule   │               │
  │               │ 3 BEGIN; pair lock; stint FOR UPDATE; grants; community row: member_count−1, membership_version+1 → v;
  │               │   stint → REMOVED (version v); grants ended 'membership_ended'; COMMIT  ◀── the serialization point   │
  │               │───────────────────▶│            │                   │                     │               │               │               │
  │               │ 4 audit communities.member.removed; publish communities.member.removed {C,U,membershipId,REMOVED,v} (S)
  │               │────────────────────────────────▶│                   │                     │               │               │               │
  │ 5 204         │                    │            │ 6 relay           │                     │               │               │               │
  │◀──────────────│                    │            │────────────────────────────────────────────────────────────────────────▶│ 7 community.member.removed
  │               │                    │            │                   │                     │               │               │──────────────▶│
  │               │                    │            │ 8 reaction        │                     │               │               │ (puts the community away)
  │               │                    │            │──────────────────▶│ 9 live session of C? expire U's hand or floor
  │               │                    │            │                   │   ('ineligible'); close a presenter grant; removeParticipant(room, U)
  │               │                    │            │                   │────────────────────▶│ 10 PARTICIPANT_REMOVED (to U only)            │
  │               │                    │            │                   │                     │═══════════════════════════════════════════════▶│
  │               │                    │            │ 11 wake-up        │                     │               │               │               │
  │               │                    │            │────────────────────────────────────────────────────────▶│ 12 changesSince → U's row tombstoned
  │               │                    │            │                   │                     │               │ 13 GET …/messages or POST send│
  │               │                    │            │                   │                     │               │◀──────────────────────────────│
  │               │ 14 authorize(U, C, community.chat.read | chat.post) → not_found              │               │               │               │
  │               │◀─────────────────────────────────────────────────────────────────────────────────────────────│               │               │
  │               │                    │            │                   │                     │               │ 15 404 messaging.conversation_not_found
  │               │                    │            │                   │                     │               │──────────────────────────────▶│
  │               │                    │            │ 16 POST /live/sessions/S/join → community.live.join refused → 404 live.session_not_found   │
  │               │                    │            │                   │◀────────────────────────────────────────────────────────────────────│
  │               │                    │            │                   │ 17 U rejoins the room with a refreshed LiveKit token (revoke_token_ts  │
  │               │                    │            │                   │    is ignored) → targeted watch / participant sweep removes U within   │
  │               │                    │            │                   │    10–60 s and counts a violation; a second one resets the media room  │
```

- Steps 13–16 hold **whether or not** steps 6–12 ran: every access asks the
  authority, and fan-out of later messages is lag-filtered, so U gets no frame
  and no notification.
- If the process crashes after step 3, steps 4–12 never run. The participant
  sweep ejects U within 60 s, and the messaging sweeper converges the
  projection within 60 s (PROVISIONAL: the participant sweep Q63, the
  messaging sweeper Q26).
- One request whose permit was read before step 3 committed may still land
  (one message ordered before the removal, or one token);
  [§5.3](#53-across-modules).
