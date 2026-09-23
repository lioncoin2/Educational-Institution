# Live

**State: APPROVED (2026-09-23) — implemented in phases: P1 (hardening the existing module), P6 (community-scoped sessions), P7 (realtime and Flutter), P7b (media).** What a phase has not delivered does not exist yet; [the hub's §25](communities-live-attendance.md#25-implementation-phases) records which phases have landed.

§1 describes the code that exists today, and says so. Everything after §1 is
a proposal.

This is the design of the `live` module, evolved in place: hardening the
existing module (phase **P1**), community-scoped live sessions (**P6**), live
realtime and the Flutter data layer (**P7**), the media binding (**P7b**), and
Live's side of attendance observation (**P9**, HELD). It is one part of the
Communities + Live + Attendance package. The overview, dependency graph,
cross-module sequences and phase table are in the hub,
[communities-live-attendance.md](communities-live-attendance.md). The decisions
are [ADR 0019](decisions/0019-community-scoped-live-sessions.md) (sessions,
convergence, presenter slot, ports), [ADR 0017](decisions/0017-community-scoped-authorization.md)
(community-scoped authorization; host-only moderation retired) and
[ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md) (events in
contracts, `FailureKind 'unavailable'`, the transport matrix), all Accepted (2026-09-23).

**The name.** The brief's "Group" is the **Community** aggregate here: module
`communities`, id `communityId`. "Group" is avoided because it already means
messaging's `GROUP` conversation type (`messaging/contracts/vocabulary.ts:11`),
and it is used for Tahajji's «مجموعة» in
[Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups),
which is unanswered. "Group" stays the brief's product word only.

**Gates.** P1 changes an existing module and is not gated by
[Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules)
(provisional default); it waits for acceptance of this design and approval of
its visible changes (§2). P6 needs the Communities core and delegation (P2, P3),
which wait for the
[§13 step](academic-reconciliation.md#13-minimal-recommended-changes-before-the-next-milestone)
(Q35/Q36 and ADR 0015) or the user's ruling on Q40. The observation side (P9) is HELD by
Q40 and [Q69](open-questions.md#q69--who-records-and-who-views-snapshots).

**How to read it.**

- **What exists today** means the repository at commit `9670c47`. Paths are
  relative to `backend/src/modules/live/` unless another directory is named.
  Line numbers cited in other documents of `docs/architecture/` are at that
  commit too, before this package's correction notes shifted them.
- **Every default that is policy is PROVISIONAL** and names its open question.
  Engineering bounds that must be measured are PROVISIONAL too.
- **LiveKit facts come from source, not documentation.** LiveKit's
  documentation site could not be read from this environment. The facts were
  read in the installed `livekit-server-sdk` 2.19.1 (**SDK**, under
  `backend/node_modules/`), the server at commit `6b2e3ec`, v1.13.7 (**SRV**,
  `github.com/livekit/livekit`), and the protocol at `72d9ef1` (**PGO**,
  `github.com/livekit/protocol`).

---

## 1. What exists today

### 1.1 Inventory

| Piece | Today | Evidence |
| --- | --- | --- |
| Use cases | Three: `JoinLiveSessionUseCase`, `RequestSpeakerUseCase`, `ModerateSpeakerUseCase` (grant, revoke). Nothing starts or ends a session, lists hands, withdraws, declines, mutes or removes | `live.module.ts:58-60` |
| Routes | Four `POST` routes: `sessions/:id/join`, `sessions/:id/hand` (202), `requests/:id/grant`, `requests/:id/revoke`. The controller returns the domain `SpeakerRequest` as the response body | `api/live.controller.ts:27-63` |
| Persistence | Four in-memory repositories, constructed empty at boot. No table, no migration, no seed. Nothing can create a session, so in the running application every join and every raise answers 404 `live.session_not_found`; the feature runs only in unit tests that seed the repositories | `live.module.ts:51-57`; `join-live-session.use-case.ts:64-67` |
| The place | `LiveRoom {halaqaId, title, hostUserId, maxParticipants}`: bound to one halaqa, with one host. `LiveSession {roomId, state 'scheduled' \| 'live' \| 'ended'}`. `halaqaId` is never read or validated | `domain/live-room.ts:10-18, 20-29`; `live.module.ts:37` |
| Join | The only access check is the role-wide `live.join`. There is no halaqa, membership or community check, so any holder of `live.join` (every active role, provisionally) obtains a token for any session id | `join-live-session.use-case.ts:61-62`; `identity/domain/provisional-policy.ts:35, 42, 59, 79, 98, 125` |
| Display names | Come from the client: `JoinSessionDto.displayName` (1–80 characters) goes into the LiveKit token's `name` and into `SpeakerRequest`. A student can name themself after the teacher | `api/dto/join-session.dto.ts:3-8`; `live.controller.ts:35, 47`; `request-speaker.use-case.ts:82`; `infrastructure/livekit-rtc-provider.ts:50` |
| Capabilities | `RtcCapabilities {canPublishAudio, canSubscribe, canPublishData}`. **Listener tokens carry `canPublishData: true`** ("raise-hand signalling"), though nothing uses the data channel. No screen, screen-audio or `hidden` flag exists | `domain/rtc-provider.ts:11-29`; `livekit-rtc-provider.ts:59` |
| Sources | **Microphone only**: `canPublishSources` is `[MICROPHONE]` or `[]`. The empty list is harmless today only because `canPublish` is false with it; in LiveKit an empty list means **all** sources | `livekit-rtc-provider.ts:61, 81`; PGO `auth/grants.go:326-340` |
| Join token | TTL 600 s | `join-live-session.use-case.ts:29` |
| RTC port | Six methods. Application code calls only `issueAccessToken` and `updateCapabilities`. **`ensureRoom`, `endRoom`, `muteParticipant` and `removeParticipant` have no caller**, so LiveKit auto-creates each room on the first join with server defaults, and `LiveRoom.maxParticipants` is never enforced at the SFU. There is no participant listing | `domain/rtc-provider.ts:56-79`; `join-live-session.use-case.ts:96`; `moderate-speaker.use-case.ts:99, 129` |
| `ensureRoom` | Catches and debug-logs **every** error, including authentication and network failures | `livekit-rtc-provider.ts:34-45` |
| Events | Five factories. Only `live.speaker.requested`, `.granted` and `.revoked` are published. **`live.session.started` and `live.session.ended` are never published**, and no module subscribes to any `live.*` event. The types live in `live/domain/events.ts`, which subscribers may not import (type-only imports count) | `domain/events.ts:9-77`; `request-speaker.use-case.ts:90`; `moderate-speaker.use-case.ts:107-109, 137-139`; `.dependency-cruiser.cjs:140-161` |
| Moderation | Host only, through identity: the use case passes `ownerUserId: room.hostUserId`, and the rule `host-only-moderation` denies everyone else — deny overrides, so an all-permission OWNER is refused too | `moderate-speaker.use-case.ts:163-167`; `identity/domain/provisional-policy.ts:139-141`; `identity/domain/policy.ts:50, 82-85`; `identity/application/authorization.service.spec.ts:64-70` |
| Ordering | Save, then provider, then moderation log, then audit, then event, with no transaction. If `updateCapabilities` throws after a grant is saved, no log, audit or event is written, the request stays `granted`, and the next join mints a speaker token | `moderate-speaker.use-case.ts:98-109`; `join-live-session.use-case.ts:92-100` |
| Concurrency | Raise and the speaker cap are check-then-save, so concurrent requests can open two hands or pass the cap. Every join, raise and grant loads every request of the session; the in-memory `findBySession` scans every request of every session | `request-speaker.use-case.ts:70-89`; `moderate-speaker.use-case.ts:79-98`; `infrastructure/in-memory-live-repositories.ts:52-54` |
| After the end | Grant and revoke never check that the session is live | `moderate-speaker.use-case.ts:149-171` |
| Audit | Every moderation type other than `grant_speaker` is audited as `live.speaker.revoked` (latent; only grant and revoke are recorded today) | `moderate-speaker.use-case.ts:193` |
| Provider choice | The fake is chosen only when the secret equals `development-only-secret`, the default when `LIVEKIT_API_SECRET` is unset. Any other value selects the real adapter. That includes `change-me` from `backend/.env.example:48`, but only when it is exported into the process environment: nothing in the backend loads `.env` (`backend/package.json:10`, `backend/src/main.ts`), so the documented setup actually runs the fake. The log line the comment promises does not exist | `live.module.ts:40-50`; `platform/config/app-config.ts:194`; `backend/.env.example:46-48`; `backend/package.json:10` |
| Module | Imports `IdentityModule` only; exports nothing | `live.module.ts:36-62` |
| The LiveKit rule | **Vacuous.** `application-has-no-vendor-sdks` anchors its `to.path` at the package name (`^(livekit-server-sdk\|…)`), but dependency-cruiser resolves the adapter's import to `node_modules/livekit-server-sdk/dist/index.js` (checked for this document by running `depcruise` on the adapter), so the rule can never fire. No rule confines the SDK to `live/infrastructure/`; only the domain rules bite | `.dependency-cruiser.cjs:79-90` (`:88`); `:26-47` |
| Tests | 32 unit tests in 3 suites pass (`npx jest src/modules/live`, run for this document). None covers `RequestSpeakerUseCase` directly, the adapter, the provider factory or the routes. The listener test asserts `canPublishAudio` and `canSubscribe`, not `canPublishData` | `application/join-live-session.spec.ts:95-110` |
| Flutter | No live feature and no `livekit_client` dependency | `app/pubspec.yaml`; `app/lib/features/` |

### 1.2 Corrections to realtime.md Part A

[realtime.md Part A](realtime.md#part-a--live-audio-the-2500-participant-design)
is the current live design document. Where it is wrong today (line numbers at
`9670c47`, before this package's correction notes; the same holds for the
other documents cited in this section):

| realtime.md says | What is true today | Evidence |
| --- | --- | --- |
| "the coordination layer is implemented" (`:13-15`) | Implemented but unreachable: no session can exist at runtime | §1.1 Persistence |
| The requirement is "~2500 concurrent participants in one audio room" (`:354-358`) | Nothing is measured. Capacity becomes a configured cap taken from load tests (PROVISIONAL 300, [Q57](open-questions.md#q57--live-session-size-and-concurrency)); the ~3,000 per-room figure is published by LiveKit but must be benchmarked | §12 |
| `LISTENER.canPublishData: true` (`:404-415`); a listener token has "no ability to publish anything" (`:509-510`) | A listener can broadcast data messages to the whole room | `rtc-provider.ts:19-23`; `livekit-rtc-provider.ts:59` |
| "No camera, no screen share, by construction" (`:428`) | True today; replaced by the presenter slot (§6) | `livekit-rtc-provider.ts:61, 81` |
| Promotion is asked of identity "with the room in context" (`:454-460`) | True, and the same rule vetoes every delegated moderator, OWNER included; retired in P6 (§7.4) | `policy.ts:50, 82-85` |
| Own state first leaves us "*more* restrictive on record" (`:469-472`; also Q5) | For a grant it is the opposite. The record says `granted`, the SFU says listener, nothing is audited, and the next join mints a speaker token: a silent grant | `moderate-speaker.use-case.ts:98-109`; `join-live-session.use-case.ts:92-100` |
| "2500 people raising their hands is 2500 rows" (`:448-449`) | 2500 rows, but every raise, join and grant reads all of them | `join-live-session.use-case.ts:92`; `request-speaker.use-case.ts:70`; `moderate-speaker.use-case.ts:79` |
| "A user may hold only one open hand per session" (`:496`) | Only without concurrency: a check-then-save. The speaker cap likewise | `request-speaker.use-case.ts:70-89`; `moderate-speaker.use-case.ts:79-98` |
| A 600 s token; a leaked token "is worth one room, one identity, ten minutes" (`:505-510`) | LiveKit sends a connected participant a refreshed token at join and every 5 minutes, each valid for at least 10 minutes, and a rejoin earns another. `removeParticipant` does not stop a rejoin, because the open-source server ignores `revoke_token_ts`. The TTL bounds only the first connection | SRV `pkg/service/roommanager.go:61-64, 767-778, 1149-1181`; SDK `dist/RoomServiceClient.d.ts:128-136` |
| The fake serves "local dev without credentials" (`:529-531`; ADR 0003 `:39-41`) | Only the exact dev secret selects it; any secret other than the dev default selects the real adapter, `change-me` included when exported into the environment (the backend never loads `.env`) | `live.module.ts:40-50`; `.env.example:46-48`; `backend/package.json:10` |
| The persistence plan: Postgres records, a Redis queue, Redis presence (`:542-554`) | Nothing is persisted. The plan is superseded: Postgres only; presence is observed, never stored (§10.5) | `live.module.ts:51-57` |
| "Moderation is scoped to the room" (`:568-569`) | Scoped to the host. Join has no scope at all | §1.1 Join |
| "Nothing outside `livekit-rtc-provider.ts` imports LiveKit" (`:573`); ADR 0003 `:46-48` and overview.md `:146-148` say a rule checks it | True by search today; not enforced outside the domain, because the named application rule is vacuous. P0 adds `livekit-sdk-only-in-the-live-adapter` | §1.1 The LiveKit rule |
| "`live` raises the events; `automation` will consume them" (`:613-614`) | The session events are never raised | `domain/events.ts:34-50` |

module-boundaries.md `:222-223` and ADR 0003 `:12-13` also list a
`SpeakerPermission` entity (none exists) and a `Participant`
(`domain/participant.ts:5-15`, used nowhere).

### 1.3 What is kept

The existing design has the right skeleton, and none of it is thrown away:

- capabilities decided on the server and carried in a token the client cannot
  change; a listener token cannot publish (the property the room rests on,
  `join-live-session.spec.ts:94-110`);
- a raised hand is application state and never touches the provider
  (`request-speaker.use-case.ts:37-44`);
- one `ALLOWED_TRANSITIONS` table (`domain/speaker-request.ts:66-72`), with
  `withdrawn` kept distinct from `declined` for reporting (`:5-11`);
- the speaker cap of 4 and first-come-first-served order, both
  [Q4](open-questions.md#q4--how-many-concurrent-speakers-and-in-what-order);
- own state first, provider second (the gap becomes the reconciler's job, §11);
- the RTC port with one LiveKit adapter (ADR 0003), widened additively;
- the 32 tests, changed only where a behaviour change is approved.

---

## 2. Phases

| Phase | What Live gains | Needs | Blocked on |
| --- | --- | --- | --- |
| **P0** | `LiveEvents` and payload types move to `live/contracts/events.ts` byte-identically; the domain factories import them. The `livekit-sdk-only-in-the-live-adapter` rule and a `live-boundaries.spec` that proves it non-vacuous; the corrected vendor-SDK regex; `FailureKind 'unavailable'` → 503; the Flutter guard (no `livekit_client`) | — | nothing |
| **P1** | Hardening in place, still halaqa-bound and in memory: `LiveParticipantRole`; total `RtcCapabilities` (listener data off); the narrow ports; adapter hardening; names from `ACCOUNT_DIRECTORY` (DTO field removed); an explicit audit action per act; application views; idempotent raise, withdraw, yield, decline; indexed repository methods. **No start or end route** | P0 | approval of the visible changes: listener data channel off; raise 409 → 201/200 (and 202 → 201); TTL 600 → 120 s |
| **P6** | `LiveSession` replaces `LiveRoom`; Postgres adapters **in the same phase** as start and end; `LiveAccess` through `COMMUNITY_AUTHORIZATION`; `host-only-moderation` retired in the same change; presenter slot; reconciler, with the automatic media-room reset on a repeated violation (§11.4); `ProtectLiveSessions`; caps; `LIVE_AUDIENCE`, `LIVE_SESSIONS`; `AppConfig.live`; the pinned LiveKit config and the adapter contract suite in CI | P1; P2 and P3 (Communities); a LiveKit dev server in CI | Q40 (through P2) |
| **P7** | Realtime `LiveRealtimeRelay` (in realtime); Flutter `LiveRepository`, `LiveEvent` frames, `LiveSessionController`, `LiveMediaClient` bound to Unavailable | P5, P6 | — |
| **P7b** | `LiveKitLiveMediaClient`, the only file importing `livekit_client`; Android foreground service, iOS broadcast extension | an ADR; devices or CI for Android, iOS and web | a device-capable environment |
| **P8** | Load profiles 1, 2, 3 and 5 (§21) | the target topology | hardware |
| **P9** | `LIVE_PRESENCE` for attendance (HELD) | P6 | Q40, Q69 |
| **P11** | A reconciler lease | evidence that one API instance is not enough | P8 |
| **P12** | A moderator-initiated media-room reset; kick and re-entry; delegated or audio screen share; hidden listeners; webhook accelerators | policy answers | Q64, Q56, Q59 |

---

## 3. Domain model

```
 LiveSession  (aggregate root; the session row is the lock for everything below)
   id, communityId (plain id), hostUserId (the starter), state live|ended, stateVersion,
   startedAt, endedAt?, endedBy? (null = system), endReason? moderator|idle|community_closed,
   participantCap, moderatorReserve, mediaRoomEpoch
   │
   ├─1──n SpeakerRequest   pending → granted | declined | withdrawn | expired
   │                        granted → revoked | withdrawn | expired
   ├─1──0..1 open PresenterGrant   (the screen-share slot)
   └─1──n ModerationAction  (written in the same transaction as the change it records)

 Derived, never stored: ParticipantStanding → capabilitiesFor(standing) → RtcCapabilities (total)
 Infrastructure, never an identity: the media room, named mediaRoomName(prefix, id, epoch)
```

### 3.1 `LiveSession` replaces `LiveRoom`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text (uuid v4) | Our identity. The LiveKit room name is derived from it, never the reverse |
| `communityId` | text | An opaque Communities id. Always read from this row, never from the client |
| `hostUserId` | text | The starter. Moderates this session while the derived act `community.live.host` holds ([Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session)) |
| `state` | `'live' \| 'ended'` | `ended` is terminal |
| `stateVersion` | integer ≥ 1 | +1 in the same transaction as every change a moderator can observe (§4.5) |
| `startedAt`, `endedAt` | timestamptz | From the injected clock |
| `endedBy` | text \| null | null means the system |
| `endReason` | `'moderator' \| 'idle' \| 'community_closed'` \| null | null while live |
| `participantCap` | integer > 0 | An engineering bound copied from configuration at start; never the community's size (§12) |
| `moderatorReserve` | integer ≥ 0 | Seats above the cap for moderators and speakers |
| `mediaRoomEpoch` | integer ≥ 0 | Only increases; 0 until the first media reset (§11.4) |

`mediaRoomName(session) = config.live.roomNamePrefix + id`, plus `'.' + epoch`
when the epoch is above 0. One pure domain function; the name is never stored
as an identity. The prefix confines the orphan sweep to this deployment on a
LiveKit server that other environments share, so it must be unique to the
deployment: with the real adapter `LIVE_ROOM_NAME_PREFIX` has no default (for
example `live-<deployment>-`), boot is refused without it, and the startup log
names it; only the fake defaults to `live-`. The sweep touches only names of
the exact form prefix + uuid [+ `.` + epoch], so it never deletes the rooms of
a deployment whose prefix merely starts with this one.

**Why `LiveRoom` goes.** It is a second durable "place" competing with the
Community; its single host contradicts delegation; a `halaqaId` would
pre-answer [Q50](open-questions.md#q50--communities-and-the-academic-structure)
and Q36; and `maxParticipants` is a deployment bound, not an attribute of a
place. The unused `LiveParticipant` (`domain/participant.ts`) and the
`LISTENER`/`SPEAKER` constants are deleted too.

### 3.2 Why there is no `scheduled` or `cancelled` state

- **Nothing produces them.** No code constructs a session today, and no use
  case in this design needs a session that has not started.
- **Scheduling is not Live's.** A schedule needs a recurrence model stored
  with a timezone, which is
  [Q12](open-questions.md#q12--timezone-and-academic-calendar) and belongs to
  `operations`; realtime.md defers "automatic room lifecycle from the schedule"
  (`:613-614`). When a schedule exists, it calls Start at the right time; Start
  is idempotent, so no state is added to Live.
- **`cancelled` only means something for a scheduled session.**
- **Cost of being wrong is small.** Adding a state later is one CHECK value;
  the partial unique index concerns `live` only.

### 3.3 `SpeakerRequest`

`{id, sessionId, userId, state, requestedAt, grantedAt?, decidedAt?,
decidedBy?}`. `displayName` is removed: names are resolved per page through
`ACCOUNT_DIRECTORY.describe`, never stored and never taken from the client.
`decidedBy` is null exactly when the state is `pending` or `expired`. The
states and transitions are §5.

### 3.4 `PresenterGrant`

`{id, sessionId, userId, grantedBy, grantedAt, endedAt?, endedBy?, endReason?
'stopped' | 'revoked' | 'session_ended' | 'ineligible'}`. At most one is open
per session. In v1 `grantedBy = userId` (a moderator claims it for themself,
[Q56](open-questions.md#q56--screen-sharing)). §6.

### 3.5 `ModerationAction`

`{id, sessionId, actorUserId? (null = system), targetUserId?, type, at,
reasonCode?}`. The reason is a code, never free text. Types: `start_session`,
`end_session`, `grant_speaker`, `decline_speaker`, `revoke_speaker`,
`grant_presenter`, `revoke_presenter`, `reset_media` (the reconciler's reset,
§11.4, with a null actor), and the seams `mute_participant` and
`remove_participant`
([Q64](open-questions.md#q64--removing-a-participant-from-a-session)). The
standalone `MODERATION_LOG` port is folded into the transactional repository
methods, so the row and the change cannot drift apart.

### 3.6 Standing and `capabilitiesFor`

Computed per request (and per sweep) from Communities, identity and Live's own
rows; never stored, never cached across requests.

| Standing | Definition |
| --- | --- |
| `moderator` | `COMMUNITY_AUTHORIZATION` answers `community.live.moderate`; or the principal is `hostUserId` and it answers `community.live.host` (§7) |
| `publishesByRight` | `moderator` and identity `live.speak`. PROVISIONAL ([Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session)): this extends to every session moderator what today only the host has, through a host check in the use case itself (`join-live-session.use-case.ts:83-91`; not the `host-only-moderation` rule, §7.4) |
| `speakerGrant` | holds a `granted` request in this session |
| `presenter` | holds the open `PresenterGrant` |
| `eligible` (to join) | a `community.live.join` permit, or `moderator` |
| `eligible` (to stay) | `moderator`, or `COMMUNITY_AUTHORIZATION.permittedAmong(communityId, ids, 'community.live.remain')` accepts them: the ceiling (`communities.read` + `live.join`) and basis of `community.live.join`, gated by `runningLiveContinues` instead of `liveJoinOpen` (§7.3). Communities evaluates it; Live keeps no copy of the rule |

`capabilitiesFor(standing)` is **total** — every field, every time:

| Field | Value | Why |
| --- | --- | --- |
| `canPublishAudio` | `speakerGrant` or `publishesByRight` | the microphone |
| `canPublishScreen` | `presenter` | the one slot (§6) |
| `canPublishScreenAudio` | `false` | Q56 |
| `canSubscribe` | `true` | everyone listens |
| `canPublishData` | `false` | nothing uses the data channel; a listener must not broadcast |
| `hidden` | `false` | the seam for [Q59](open-questions.md#q59--visibility-inside-a-live-session) |

No standing ever maps to the camera. The role shown is `moderator` >
`speaker` > `listener` (`LiveParticipantRole`; the host is a moderator and
`me.isHost` says so).

### 3.7 Invariants

| # | Invariant | Enforced by |
| --- | --- | --- |
| S1 | At most one `live` session per community (PROVISIONAL, [Q55](open-questions.md#q55--parallel-live-sessions-in-one-community)) | partial unique index; the basis of idempotent start |
| S2 | `live` ⇔ `endedAt` and `endReason` null; `endReason = 'moderator'` ⇒ `endedBy` set | CHECKs |
| S3 | `ended` is terminal | every update is `WHERE state = 'live'` |
| S4 | After End commits, no hand, floor or presenter change takes effect | every transition locks the session row `FOR UPDATE` and requires `live` |
| S5 | End closes every open request (→ `expired`) and the presenter grant (→ `session_ended`) in its transaction; one `live.session.ended` implies them | set-based UPDATEs in the End transaction |
| S6 | The media room is derived; any other prefixed room is an orphan | `mediaRoomName`; the room sweep |
| R1 | One open (`pending` or `granted`) request per (session, user) | partial unique index; `INSERT … ON CONFLICT` |
| R2 | At most `MAX_CONCURRENT_SPEAKERS` granted ([Q4](open-questions.md#q4--how-many-concurrent-speakers-and-in-what-order)) | counted under the session row lock |
| R3 | `decidedBy` null ⇔ `pending` or `expired` | CHECK |
| R4 | FCFS by (`requestedAt`, `id`); no time-based expiry of a pending hand ([Q62](open-questions.md#q62--floor-rules-beyond-first-come-first-served)) | keyset index |
| R5 | A grant is session state; it never confers a community act | a test asserts it |
| P1 | At most one open presenter grant per session | partial unique index |
| P2 | Opened only while live, by a moderator with `live.speak`, for themself | session row `FOR UPDATE`; `LiveAccess` |

### 3.8 Limits

All engineering bounds, PROVISIONAL, one file (`live/domain/live-limits.ts`)
plus `AppConfig.live`. They are measured in P8 before anything is raised.

| Constant | Value | Question |
| --- | --- | --- |
| `MAX_CONCURRENT_SPEAKERS` | 4 (unchanged; PROVISIONAL [Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session): moderators publishing by right and the presenter do not use a slot) | Q4 |
| `MAX_CONCURRENT_PRESENTERS` | 1 | Q56 |
| `JOIN_TOKEN_TTL_SECONDS` | 120 (was 600) | [Q63](open-questions.md#q63--losing-standing-during-a-running-session) |
| `ROOM_SWEEP_SECONDS` / `PARTICIPANT_SWEEP_SECONDS` / `WATCH_TICK_SECONDS` | 30 / 60 / 10 | Q63 |
| `ENFORCEMENT_WATCH_SECONDS` | 660, extended on every violation | Q63 |
| `ORPHAN_GRACE_SECONDS` | 60 | engineering |
| `IDLE_END_SECONDS` | 900 | [Q61](open-questions.md#q61--ending-abandoned-live-sessions) |
| `ROOM_PROVIDER_TIMEOUT_SECONDS` | 1,200 (LiveKit `emptyTimeout` and `departureTimeout`; a backstop only) | Q61 |
| `OBSERVATION_CACHE_SECONDS` | 2 (the soft-cap sample) | Q57 |
| `PROVIDER_CALL_TIMEOUT_SECONDS` | 10 (the SDK's default request timeout) | engineering |
| `config.live.maxParticipantsPerSession` / `moderatorReserve` | 300 / 10 (env `LIVE_MAX_PARTICIPANTS_PER_SESSION`, `LIVE_MODERATOR_RESERVE`) | Q57 |
| `config.live.roomNamePrefix` | env `LIVE_ROOM_NAME_PREFIX`: required with the real adapter, unique per deployment, boot refused without it (§3.1); `live-` with the fake | — |
| Rate limits | start 10/min per user; join 10/min and raise 6/min per (session, user) | [Q26](open-questions.md#q26--realtime-limits) |
| Moderator frame coalescing (in realtime) | ≤ 1 per 250 ms per session | Q26 |

---

## 4. Session lifecycle and idempotency

```
                 Start (provider first)                         End (moderator) · system: idle | community_closed
   (none) ─────────────────────────────▶  live  ─────────────────────────────────────────────▶  ended  (terminal)
            a repeat, or a lost race:            a repeat: 200 with the same view; no audit, event or provider call
            200 with the running session
```

### 4.1 Start — idempotent, provider first

`StartLiveSession` ([S1](#s1-start-a-session)):

1. Route `@RequirePermission(live.moderate)`, with no `ownerUserId`; the rate
   limit (429 `live.too_many_starts`).
2. `authorize(P, C, 'community.live.start')`. Refusals are remapped:
   `not_found` → 404 `live.community_not_found`; `forbidden` → 403
   `live.start_not_permitted`; `precondition_failed` (the lifecycle gate,
   `liveStartOpen` false, reached only by a principal with a basis for the
   act) → if the community has a live session, **200 with it** (a retried
   start after a lock), otherwise 412 `live.community_not_open`.
3. The community's live session exists → **200 with it**; nothing else happens.
4. New id; `participantCap` and `moderatorReserve` from `AppConfig.live`.
5. `ensureRoom({roomName, maxParticipants: cap + reserve,
   emptyTimeoutSeconds: 1200, departureTimeoutSeconds: 1200})`.
   `RtcUnavailableError` → **503 `live.media_unavailable`, nothing stored**.
6. One transaction: `INSERT … ON CONFLICT (community_id) WHERE state = 'live'
   DO NOTHING RETURNING`, and the `start_session` moderation row.
7. No row returned (a concurrent start won): `endRoom` on this call's own
   room, best effort; read the winner; **200** with it.
8. Created: audit `live.session.started`, then the event; **201**.

Provider first, so a LiveKit outage leaves no row, audit or event. A crash
between steps 5 and 6 leaves an orphan room that the room sweep deletes after
its 60 s grace (§11.2). No transaction ever spans a provider call.

### 4.2 End — idempotent, one transaction, one event

`EndLiveSession` (moderator) and `LiveSessionLifecycle.endBySystem(id,
reason)` (the reconciler; no route) share one repository method:

1. `SELECT … FROM live_sessions WHERE id = $1 FOR UPDATE`. Already `ended` →
   return `{ended: false}` → **200** with the ended view: no audit, no event,
   no provider call.
2. Set `ended`, `endedAt`, `endedBy` (null for the system), `endReason`;
   `state_version + 1`.
3. One statement expires every open request (`pending` or `granted` →
   `expired`, `decided_by` NULL), however many hands there are.
4. One statement closes the open presenter grant (`session_ended`).
5. The `end_session` moderation row; COMMIT.
6. After commit: audit (a null actor for the system), then **one**
   `live.session.ended`, then `endRoom`. NotFound counts as success;
   `RtcUnavailableError` is left to the room sweep, which deletes any prefixed
   room that is not the current room of a live session.

**`ended` is saved before `endRoom` is called.** This is a requirement from
attendance: a presence observation taken during teardown must re-read
`ended` and answer `not_active`, never an empty or partial list
([attendance.md](attendance.md)).

System ends: `idle` after the room was observed empty continuously for 900 s
(PROVISIONAL, Q61; never because the host is absent; no maximum duration);
`community_closed` when `COMMUNITY_MEMBERSHIP.heads` no longer knows the
community or reports `runningLiveContinues: false`. Under today's PROVISIONAL
lifecycle table no status sets that flag and no community is ever deleted
([Q47](open-questions.md#q47--retiring-a-community)), so `community_closed`
is reserved for a future state such as ARCHIVED.

### 4.3 One live session per community

PROVISIONAL (Q55): a partial unique index `(community_id) WHERE state =
'live'`, and a second Start returns the running session. Allowing parallel
sessions later means dropping the index and giving Start an explicit
idempotency key, because "start again" would no longer mean "the same
session".

### 4.4 Ensure-then-recheck

Any path that re-creates a missing room — `/join` and the room sweep — calls
`ensureRoom`, then **re-reads the session**. If it has ended meanwhile, it
calls `endRoom` and refuses (412 `live.session_not_live`). Without the
re-check, a join racing End would bring a deleted room back. With
`room.auto_create=false`, only these two paths and Start can create a room.

### 4.5 `state_version`

`live_sessions.state_version` rises by exactly 1, in the same transaction, on:
start (1), a raise that creates a request, withdraw, decline, grant, revoke,
an `ineligible` expiry, a presenter opening or closing, and the end. It is
carried by every `live.speaker.*` and `live.screen_share.*` payload, by
`LiveSessionView`, and by the `live.session.changed` frame. A client applies
only a newer version; for two frames about one session, the larger version is
the later committed state. Every transition therefore takes a short lock on
the session row, raises included, serialized first by a per-session mutex in
process so that waiting never holds a pool connection (§10.2); that cost is
accepted and measured in load profile 1.

---

## 5. Speaker and raise-hand state machine

### 5.1 Transitions

One table, `ALLOWED_TRANSITIONS`, extended with `expired` and yield. The state
encodes who acted: `revoked`/`declined` a moderator, `withdrawn` the
requester, `expired` the system.

| From | To | Actor | Trigger | Guard | Event | Audit | Moderation row | Provider |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | `pending` | requester | `POST …/hand` | session live; `community.live.raise_hand` permit | `live.speaker.requested` | no | — | none |
| `pending` | `granted` | moderator | `POST …/grant` | `LiveAccess`; target still eligible; session live; granted < 4 | `live.speaker.granted` | yes | `grant_speaker` | `updateCapabilities`, full set, microphone on |
| `pending` | `declined` | moderator | `POST …/decline` | `LiveAccess`; session live | `live.speaker.declined` | yes | `decline_speaker` | none |
| `pending` | `withdrawn` | requester | `DELETE …/hand` | own open request | `live.speaker.withdrawn {from: 'pending'}` | no | — | none |
| `granted` | `revoked` | moderator | `POST …/revoke` | `LiveAccess`; session live | `live.speaker.revoked` | yes | `revoke_speaker` | full set, microphone off |
| `granted` | `withdrawn` | speaker (yield, [Q62](open-questions.md#q62--floor-rules-beyond-first-come-first-served)) | `DELETE …/hand` | own open request | `live.speaker.withdrawn {from: 'granted'}` | no | — | full set, microphone off |
| `pending`, `granted` | `expired` | system | the requester became ineligible (§11) | — | `live.speaker.expired {from, cause: 'ineligible'}` | no — its cause is audited by the module that owns it | — | `removeParticipant` or a demotion |
| `pending`, `granted` | `expired` | system | the session ended | — | none per hand: the one `live.session.ended` implies every expiry | no | — | the room is deleted |

`revoked`, `withdrawn`, `declined` and `expired` are terminal. A new raise
after a terminal state creates a new request. A delegated moderator may not
grant, decline or revoke the host's own request (403 `live.target_is_host`,
PROVISIONAL, Q54).

### 5.2 Diagram

```
        raise (requester) — an open request already held → 200 with it, no event
             │
             ▼
        ┌─────────┐ ── decline (moderator) ────────────────────────▶ declined
        │ pending │ ── withdraw (requester) ───────────────────────▶ withdrawn
        └────┬────┘ ── expire (system: session end | ineligible) ──▶ expired
             │
             │ grant (moderator; under the session row lock; granted < 4)
             ▼
        ┌─────────┐ ── revoke (moderator) ─────────────────────────▶ revoked
        │ granted │ ── withdraw = yield (speaker) ─────────────────▶ withdrawn
        └─────────┘ ── expire (system: session end | ineligible) ──▶ expired

   Terminal: declined, withdrawn, revoked, expired. A new raise creates a new request.
   Media changes only on grant, revoke, yield and ineligibility.
```

### 5.3 Repeats and races

| Case | Answer |
| --- | --- |
| Raise with an open request | 200 with it; no row, no event (today 409 `live.speaker_request_exists`, `request-speaker.use-case.ts:71-75`) |
| 20 concurrent raises by one user | one row (partial unique index); one event |
| Grant of a `granted` request | 200, no side effects |
| Revoke of a `revoked`, decline of a `declined` request | 200, no side effects |
| Withdraw with nothing open (including after the end) | 200 `{request: null}` |
| Grant, revoke or decline from any other state | 409 `live.invalid_transition` (existing code) |
| Any transition after the end | 412 `live.session_not_live`: the session row is checked first, under the lock |
| Concurrent grants past the cap | serialized on the session row, counted, then compare-and-set: exactly 4 granted; the rest 412 `live.speaker_slots_full` (existing code) |
| Revoke racing yield | the compare-and-set lets one win; the other finds a terminal state (200 if it is its own target state, else 409) |

### 5.4 What a speaker grant is not

It is session state in Live. Revoking it never touches community membership;
it confers no community act (R5); it does not survive the session (S5); a new
session starts with no speakers. A grant comes only from a raised hand;
inviting someone who has not raised a hand is not built (Q62).

---

## 6. The presenter slot (screen share)

Screen share is a **separate grant**, not a speaker right and not a token
flag. It is one `PresenterGrant` per session: an audited application fact.
The stream is a LiveKit track with source `SCREEN_SHARE`
(`TrackSource` in the installed `@livekit/protocol`,
`src/gen/livekit_models_pb.d.ts:146-171`); it is never stored in Postgres and
is not a file or a message.

```
   (none) ── claim (a session moderator holding live.speak, for themself; session FOR UPDATE) ──▶ open
     open ── stop (the presenter) ───────────────────────────────▶ closed 'stopped'        event; not audited
     open ── revoke (another moderator; not the host's grant, Q54) ▶ closed 'revoked'        event; audited
     open ── the presenter loses moderator standing ─────────────▶ closed 'ineligible'     event
     open ── the session ends ───────────────────────────────────▶ closed 'session_ended'  no event (implied)
   A claim by the holder → 200. A claim while another holds it → 409 live.presenter_slot_taken.
   A stop with nothing open → 200.
```

| Rule | PROVISIONAL default (Q56) |
| --- | --- |
| Who may present | a session moderator who holds identity `live.speak`, for themself only |
| How many at once | one — an engineering bound on egress: a screen-share video costs about one subscriber's worth of egress per listener |
| Screen audio | never (`canPublishScreenAudio: false`) |
| Delegation to a student | not built; a seam only |
| Recording | none (realtime.md `:610` defers it) |
| Audit | opening, and closing with reason `revoked` |

**Effect on the wire.** After the claim commits, `updateCapabilities` sends
the presenter's **full** set with `canPublishScreen: true`; the moderator's
microphone by right is unchanged. On close, the full set without the screen:
LiveKit unpublishes the screen track at once (SRV `pkg/rtc/participant.go:878-883`).
The presenter's client then calls `setScreenShareEnabled` through
`LiveMediaClient` (§17).

**Why a slot.** Putting `SCREEN_SHARE` into every moderator's token would
allow unbounded concurrent video publishers on a single VPS and make screen
audio a silent policy choice. A slot is bounded, auditable, and needs no
observation of media.

**The host crash case.** Under Q54's default a delegated moderator may not act
on the host, so if the host presents and their device crashes, the slot stays
with the host until the host stops it (after rejoining), loses standing
(`ineligible`), or the session ends. No track is published meanwhile; other
moderators simply cannot present. This follows from Q54 and is listed there.

**Clients.** Screen capture needs an Android media-projection foreground
service and an iOS broadcast extension, and throws on mobile web browsers
(`client-sdk-flutter` `lib/src/participant/local.dart:815-816`). That is P7b.

---

## 7. Authorization: how Live decides

The rule is ADR 0017's: **identity ceiling AND Communities standing AND the
lifecycle gate** ([communities.md §6](communities.md#6-authorization)). Live
asks; it never stores membership, never reads the raw lifecycle status, and
never caches an answer across requests.

### 7.1 Per operation

| Operation | Route gate (identity ceiling) | Use-case question (community id from the stored session, or the path for start and current) | Refusals |
| --- | --- | --- | --- |
| Start | `live.moderate` | `community.live.start` | 404 `live.community_not_found`; 403 `live.start_not_permitted`; 412 `live.community_not_open` |
| Current session | `live.join` | `community.live.join`, else `LiveAccess.moderator` | 404 `live.community_not_found` |
| Get session | `live.join` | as current; a lifecycle refusal still returns the view, with `me.canJoin` false | 404 `live.session_not_found` |
| Join | `live.join` | `community.live.join`, else `LiveAccess.moderator` | 404 `live.session_not_found`; 412 `live.community_not_open` |
| Raise hand | `live.raise_hand` | `community.live.raise_hand` | 404; 412 `live.community_not_open` |
| Withdraw, yield | authenticated | the caller's own open request only (it only reduces privilege) | — |
| Hands, grant, decline, revoke, end | `live.moderate` | `LiveAccess.moderator` | 404; 403 `live.not_a_moderator`; 403 `live.target_is_host` |
| Presenter claim | `live.moderate` | `LiveAccess.moderator` and identity `live.speak` | 404; 403 `live.not_a_moderator`; 403 `live.presenter_not_permitted` |
| Presenter stop | authenticated | the presenter, or `LiveAccess.moderator` | 404; 403 |

A Communities store failure rejects the call: Live answers **503
`unavailable`** and never falls back to a role-only answer.

### 7.2 `LiveAccess`: host and moderators

`LiveAccess` is internal to Live's application layer (like
`ConversationAccess` and `AcademicAccess`):

1. `authorize(P, S.communityId, 'community.live.moderate')` → a permit with
   basis `owner` or `grant`: a moderator of every session of the community.
2. Otherwise, if `P.userId === S.hostUserId`:
   `authorize(P, S.communityId, 'community.live.host')`. The derived act is
   backed by `community.live.start` and stays allowed while LOCKED as long as
   `runningLiveContinues` holds.
3. Otherwise refuse: no ACTIVE stint → 404, identical to a missing session;
   a member → 403 `live.not_a_moderator`.

PROVISIONAL (Q54): a moderator whose authority is not the host's own does not
act on the host (403 `live.target_is_host`); there is no institution-wide
override (`communities.manage` never acts in a session). The permit — `act`,
`basis`, `membershipId`, `grantId` — is copied into the audit metadata of
every moderation act.

### 7.3 The lifecycle, through Communities' answers only

Live never sees `OPEN` or `LOCKED`, and never evaluates an act rule itself.
For a principal it reads permit refusals. In principal-less code (the
reconciler, `LIVE_AUDIENCE`) it asks a trusted batch,
`COMMUNITY_AUTHORIZATION.permittedAmong(communityId, userIds ≤ 1,000, act) →
userIds`, which applies the act's ceiling (through
`ACCOUNT_DIRECTORY.withPermission`), the owner, grant or membership basis
(never oversight) and `statePermits`. Staying in a running session is the
derived act `community.live.remain` (in `COMMUNITY_DERIVED_ACTS`, like `community.live.host`): the ceiling and basis of
`community.live.join`, allowed while `runningLiveContinues`. Both are
additions to Communities that this design needs (P6). Only the session as a
whole reads `CommunityHead.effects` (§11.3, step 2). The table is
Communities' ([communities.md §8.3](communities.md#83-statepermits-and-communityheadeffects),
PROVISIONAL, [Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock));
its consequences for Live:

| For Live | OPEN | LOCKED | unmapped status |
| --- | --- | --- | --- |
| Start a session | yes | no — 412 `live.community_not_open` | no |
| Join, rejoin | yes | yes | no new join; connected members are not ejected |
| Raise a hand | yes | yes | no |
| Moderate; the host keeps moderation | yes | yes | yes |
| The running session | continues | continues | continues (`runningLiveContinues`: never eject on ignorance) |

### 7.4 Retiring `host-only-moderation`

**Today:** Live passes `ownerUserId` with `live.moderate`
(`moderate-speaker.use-case.ts:163-167`), and `restrictToResourceOwner` denies
every non-host (`policy.ts:82-85`) with deny overriding (`policy.ts:50`).
Delegated moderators, OWNER included, are refused.
`join-live-session.use-case.ts:85-91` passes `ownerUserId` only for
`live.speak`, which `host-only-moderation` does not cover, so the rule never
fires there.

**The change, in one P6 change set** (ADR 0017):

1. `LiveAccess` replaces the room-scoped identity call.
2. Live stops passing `ownerUserId` anywhere; `live.speak` is asked without
   context.
3. `PROVISIONAL_POLICY_RULES` becomes `Object.freeze([])`
   (`provisional-policy.ts:139-141`); `role.spec.ts:83-85` expects `[]`.
   `restrictToResourceOwner` and `ownerOfResourceRule` stay in `policy.ts`
   with their specs.
4. The all-permission refusal test (`authorization.service.spec.ts:52-71`)
   moves to Live: an all-permission principal without community standing
   cannot moderate, end or present, and nothing changes (no provider call,
   audit or event).
5. Q1's provisional answer is revised by ADR 0017
   ([Q1](open-questions.md#q1--what-may-each-role-actually-do)).

**Why together.** Retiring the rule first reopens the Foundation gap in which
any `live.moderate` holder moderates any room (authorization.md `:240-243`).
Shipping `LiveAccess` first leaves the veto refusing every delegate. Leaving
the rule registered but inert is a trap: any future caller that passes
`ownerUserId` re-activates the OWNER veto. P1 does not touch the rule; the
halaqa-bound module stays host-only until P6.

---

## 8. RTC ports

### 8.1 Shapes

`live/domain/rtc-provider.ts`, npm-free. No LiveKit type appears.

```ts
export type RtcSource = 'microphone' | 'screen_share' | 'screen_share_audio';

/** Total: every field always present; applied as the provider's FULL permission set, never a delta. */
export interface RtcCapabilities {
  readonly canPublishAudio: boolean;
  readonly canPublishScreen: boolean;
  readonly canPublishScreenAudio: boolean; // implies canPublishScreen; false until Q56
  readonly canSubscribe: boolean;
  readonly canPublishData: boolean;        // always false
  readonly hidden: boolean;                // always false until Q59
}

export interface RtcRoomSpec {
  readonly roomName: string; readonly maxParticipants: number;
  readonly emptyTimeoutSeconds: number; readonly departureTimeoutSeconds: number;
}
export interface RtcRoomObservation { readonly roomName: string; readonly participantCount: number; readonly createdAt: Date }
export interface RtcAccessGrant {        // shape unchanged
  readonly roomName: string; readonly identity: string; readonly displayName: string;
  readonly capabilities: RtcCapabilities; readonly ttlSeconds: number;
}
export interface RtcAccessToken { readonly token: string; readonly url: string; readonly expiresInSeconds: number } // unchanged
export type RtcApplyOutcome = 'applied' | 'not_connected';
export interface RtcParticipantObservation {
  readonly identity: string;
  readonly state: 'joining' | 'joined' | 'active';   // DISCONNECTED is dropped by the adapter
  readonly standard: boolean;                         // false for egress, ingress, SIP, agent
  readonly joinedAt: Date;
  readonly publishing: readonly RtcSource[];
  readonly capabilities: RtcCapabilities;             // as the provider holds them now
}
export class RtcUnavailableError extends Error {}    // a domain class: network, timeout, 5xx

/** Room provider. */
export interface RtcRoomProvider {
  ensureRoom(spec: RtcRoomSpec): Promise<void>;                                   // create-or-update
  endRoom(roomName: string): Promise<void>;                                       // absent = success
  listRooms(roomNames?: readonly string[]): Promise<readonly RtcRoomObservation[]>;
}
/** Token issuer: local signing, no network. */
export interface RtcTokenIssuer { issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken> }
/** Capability updater and participant control. */
export interface RtcParticipantControl {
  updateCapabilities(roomName: string, identity: string, capabilities: RtcCapabilities): Promise<RtcApplyOutcome>;
  removeParticipant(roomName: string, identity: string,
                    options?: { readonly revokeTokensIssuedBefore?: Date }): Promise<RtcApplyOutcome>;
  muteParticipant(roomName: string, identity: string, sources: readonly RtcSource[]): Promise<RtcApplyOutcome>; // seam
}
/** Participant observer: one unpaginated provider read. */
export interface RtcParticipantObserver {
  listParticipants(roomName: string): Promise<readonly RtcParticipantObservation[]>;
  getParticipant(roomName: string, identity: string): Promise<RtcParticipantObservation | null>;
}
export interface RtcProvider extends RtcRoomProvider, RtcTokenIssuer, RtcParticipantControl, RtcParticipantObserver {}

export const RTC_PROVIDER = Symbol('RTC_PROVIDER');   // bound to the adapter or the fake, as today
export const RTC_ROOMS = Symbol('RTC_ROOMS');         // useExisting: RTC_PROVIDER
export const RTC_TOKENS = Symbol('RTC_TOKENS');       // useExisting: RTC_PROVIDER
export const RTC_PARTICIPANTS = Symbol('RTC_PARTICIPANTS'); // useExisting: RTC_PROVIDER
export const RTC_OBSERVER = Symbol('RTC_OBSERVER');   // useExisting: RTC_PROVIDER
```

ADR 0003 stands: one adapter, the same method names, widened additively
([ADR 0019](decisions/0019-community-scoped-live-sessions.md) amends it).

### 8.2 Who depends on which port

| Consumer | Ports |
| --- | --- |
| `StartLiveSession` | `RTC_ROOMS` (`ensureRoom`; `endRoom` after a lost race) |
| `EndLiveSession`, `LiveSessionLifecycle` | `RTC_ROOMS.endRoom` |
| `JoinLiveSession` | `RTC_ROOMS` (`listRooms` cached, `ensureRoom`, `endRoom` for the recheck), `RTC_TOKENS` |
| `ModerateSpeaker`, `LowerHand` (yield), `Presenter` | `RTC_PARTICIPANTS.updateCapabilities` |
| `RaiseHand`, `GetLiveSession`, `GetCurrentLiveSession`, `ListHands` | none |
| `ProtectLiveSessions` | `RTC_PARTICIPANTS` |
| `LiveReconciler` | all four |
| `LivePresenceService` (P9) | `RTC_OBSERVER.listParticipants` |

A use case cannot call what it does not inject: join cannot remove anyone,
raise cannot touch the provider at all.

### 8.3 The adapter

`live/infrastructure/livekit-rtc-provider.ts` stays the only SDK importer
(enforced from P0).

| `RtcCapabilities` | LiveKit field (in the token grant and in `updateParticipant`) |
| --- | --- |
| `canPublishAudio`, `canPublishScreen`, `canPublishScreenAudio` | `canPublishSources` = the explicit list of `MICROPHONE`, `SCREEN_SHARE`, `SCREEN_SHARE_AUDIO`; `canPublish` = the list is non-empty |
| `canSubscribe` | `canSubscribe` |
| `canPublishData` | `canPublishData`, always explicit |
| `hidden` | `hidden`, always explicit |
| — | `canUpdateMetadata` / `canUpdateOwnMetadata` false; `CAMERA` never listed; `roomAdmin`, `roomCreate`, `roomList`, `roomRecord` never set; `room` = the room name; `identity` = the user id; `name` = the directory name; `ttl` |

| LiveKit outcome | Port outcome |
| --- | --- |
| NotFound on `updateParticipant` or `removeParticipant` (SRV `pkg/service/roomservice.go:224-245, 270-287`) | `'not_connected'` |
| NotFound on `getParticipant` | `null` |
| NotFound on `deleteRoom` | success |
| `createRoom` on an existing room | success: the server finds and updates it (SRV `pkg/service/roomallocator.go:60-127`) |
| Network error, timeout (10 s), 5xx | `RtcUnavailableError` |
| Authentication failure (wrong key or secret) | a thrown misconfiguration fault: 500 and an alert log |

Every logged error is scrubbed: no token, secret or JWT-shaped string. The
provider factory logs which provider it chose at startup, and the fake gains
scriptable observations for the reconciler's tests.

---

## 9. LiveKit hardening

| Concern | LiveKit behaviour (source) | Today | Design |
| --- | --- | --- | --- |
| **Room auto-creation** | `room.auto_create` defaults to true (SRV `pkg/config/config.go:563`); with it false, joining a room that does not exist needs a token carrying `roomCreate` (`pkg/service/roomallocator.go:175-184`) | No LiveKit configuration is in the repository; rooms are auto-created on first join | `room.auto_create=false` in a pinned LiveKit config kept in the repository (P6), with `enable_remote_unmute=false`, the timeouts as a backstop, `prometheus_port`, no webhooks and a TURN placeholder ([Q65](open-questions.md#q65--media-hosting-and-operations)). No token ever carries `roomCreate`, so a still-valid token cannot re-create an ended room. The adapter contract suite proves it against a real server. The adapter also self-checks it at boot and on every room sweep: it signs a `roomJoin`-only token for a random name of this deployment's form that no room has, and calls LiveKit's `/rtc/validate`, which runs the same allocator check without creating anything (SRV `pkg/service/rtcservice.go:102`; `pkg/service/utils.go:389-396`). 404 means `auto_create` is off; a success logs an alert and refuses Start (503 `live.media_unavailable`) until a probe answers 404 again |
| **Rooms created by us** | `createRoom` is create-or-update | `ensureRoom` is never called | Start creates the room with `maxParticipants = cap + reserve`; ensure-then-recheck (§4.4); the orphan sweep by prefix (§11.2) |
| **Token lifetime** | The server refreshes a connected participant's token once at join and then every 5 minutes; each refreshed token is valid for max(10 minutes, time left) and carries the participant's current grants (SRV `pkg/service/roommanager.go:61-64, 767-778, 1149-1181`) | 600 s | 120 s. **This bounds only the first connection.** A client holding a refreshed token can reconnect without `/join` for up to about 10 minutes |
| **Revocation** | The protocol defines `revoke_token_ts`, but the open-source server never reads it (no reference in the SRV source); the SDK says "Even after being removed, the participant can still re-join the room" (SDK `dist/RoomServiceClient.d.ts:128-136`) | — | Removal and demotion alone are **not final on the media plane**: a removed member can rejoin with a refreshed token, and each rejoin earns a fresh token of at least 10 minutes. **Ending is final**: the room is deleted and cannot come back (`auto_create=false`). The level-triggered reconciler (§11) removes or demotes within 10–60 s and counts violations; at the second violation inside the enforcement window it resets the media room by epoch (§11.4, P6), which ends the loop, because every old token names a deleted room. `revokeTokensIssuedBefore` is passed anyway, for providers that honour it |
| **One identity per account** | A join with an identity already in the room evicts the earlier connection with `DUPLICATE_IDENTITY` (SRV `pkg/service/roommanager.go:326-327, 398-400`) | identity = user id | Kept: the newest device wins; the client does not auto-rejoin on that reason ([Q60](open-questions.md#q60--one-account-on-several-devices-in-a-session)). One account never counts twice in capacity or observation |
| **Display names** | A participant may not change its own name or metadata unless `canUpdateOwnMetadata` (SRV `pkg/rtc/participant.go:722-727`) | from the client body | From `ACCOUNT_DIRECTORY.describe` (never an email); the DTO field is removed (P1); `canUpdateOwnMetadata` stays false |
| **Data channel** | Unset `canPublishData` equals `canPublish` on the server (PGO `auth/grants.go:355-360`), while the SDK comment says "defaults to true" (SDK `dist/grants.d.ts:35-38`); no server-side data rate limiter was found | listeners `true` | `false` for everyone, always explicit (P1). Raise hand is HTTP |
| **Source list** | An **empty** `canPublishSources` means **all** sources (PGO `auth/grants.go:326-340`) | `[]` for listeners, harmless only with `canPublish` false | Always the explicit list, and `canPublish` = the list is non-empty; `CAMERA` is never listed |
| **Partial updates** | `UpdateFromPermission` overwrites sources, data, subscribe, metadata and `hidden`; missing fields become false or empty (PGO `auth/grants.go:429-441`; SDK: "all desired permissions would need to be set"). Tracks from sources no longer allowed are removed at once (SRV `pkg/rtc/participant.go:878-883`) | three fields sent | The whole total set on every update |
| **Admin grants** | Room-service calls need `roomCreate`, `roomList` or `roomAdmin` (SDK `src/RoomServiceClient.ts`) | only `roomJoin` | Client tokens: `roomJoin` for one named room only. The server API signs its own short tokens with the secret, which never leaves the API |
| **Remote unmute** | Refused unless `enable_remote_unmute` (SRV `pkg/service/roommanager.go:868-870`) | — | Off: a moderator can silence, never open a microphone |
| **Room capacity** | `max_participants` counts non-dependent participants and refuses the join above it (SRV `pkg/rtc/room.go:458-467`); a room is pinned to one node and refused when that node is full (`pkg/service/roomallocator.go:139-148`) | never set | The hard cap (§12) |
| **Webhooks** | A per-room in-memory queue of at most 200 events and 30 s, dropped when full or old | none | None in v1. P12 may add them as accelerators only, with the signature checked over the raw body in `live/infrastructure` and a reviewed public-route entry |

---

## 10. Persistence

**PROPOSAL.** No migration or table exists. The tables are owned by `live` and
touched only by `live/infrastructure` Drizzle adapters. No foreign key crosses
a module: community and user ids are plain text. Ids are text; timestamps are
`timestamptz` from the injected clock; isolation is READ COMMITTED. Nothing is
deleted; retention is
[Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history).

### 10.1 Tables

**`live_sessions`** — `id` PK; `community_id`, `host_user_id` NOT NULL;
`state` CHECK IN (`live`, `ended`); `state_version` ≥ 1; `started_at`;
`ended_at`, `ended_by` NULL; `end_reason` CHECK IN (`moderator`, `idle`,
`community_closed`); `participant_cap` > 0 (no upper CHECK: it is
configuration); `moderator_reserve` ≥ 0; `media_room_epoch` DEFAULT 0, ≥ 0;
reconciler bookkeeping `empty_since` NULL, `enforcement_violations` DEFAULT 0,
`last_violation_at` NULL.

- CHECK `(state = 'live') = (ended_at IS NULL)`
- CHECK `(state = 'live') = (end_reason IS NULL)`
- CHECK `end_reason IS DISTINCT FROM 'moderator' OR ended_by IS NOT NULL`
- UNIQUE INDEX `live_sessions_one_live_per_community ON (community_id) WHERE state = 'live'` (S1)
- INDEX `(community_id, started_at DESC, id DESC)` — history per community
- INDEX `(started_at, id) WHERE state = 'live'` — reconciler pages

**`live_speaker_requests`** — `id` PK; `session_id` REFERENCES
`live_sessions` ON DELETE RESTRICT; `user_id`; `state` CHECK IN (`pending`,
`granted`, `revoked`, `withdrawn`, `declined`, `expired`); `requested_at`;
`granted_at`, `decided_at`, `decided_by` NULL.

- CHECK `(state = 'pending') = (decided_at IS NULL)`
- CHECK `(state IN ('pending', 'expired')) = (decided_by IS NULL)` (R3)
- CHECK `state <> 'granted' OR granted_at IS NOT NULL`
- UNIQUE INDEX `(session_id, user_id) WHERE state IN ('pending', 'granted')` (R1)
- INDEX `(session_id, requested_at, id) WHERE state = 'pending'` — the FCFS keyset queue
- INDEX `(session_id) WHERE state = 'granted'` — the cap count and convergence
- INDEX `(session_id, decided_at) WHERE granted_at IS NOT NULL AND state IN ('revoked', 'withdrawn', 'expired')` — the targeted watch

**`live_presenter_grants`** — `id` PK; `session_id` REFERENCES
`live_sessions`; `user_id`; `granted_by`; `granted_at`; `ended_at`,
`ended_by` NULL; `end_reason` CHECK IN (`stopped`, `revoked`,
`session_ended`, `ineligible`).

- CHECK `(ended_at IS NULL) = (end_reason IS NULL)`
- UNIQUE INDEX `(session_id) WHERE ended_at IS NULL` (P1), a backstop: the
  claim reads the open grant under the session lock first (§10.2); a
  violation is detected with `isUniqueViolation`
  (`platform/database/postgres-errors.ts:5`) and answered 409
- INDEX `(session_id, ended_at)` — the targeted watch

**`live_moderation_actions`** — `id` PK; `session_id` REFERENCES
`live_sessions`; `actor_user_id` NULL (system); `target_user_id` NULL; `type`
CHECK IN (the ten types of §3.5); `at`; `reason_code` NULL (a code, never
free text). INDEX `(session_id, at, id)`.

### 10.2 Transactions and locks

Provider calls happen **after commit**; no transaction spans one. Every
transition locks the session row first, so the order is always session row,
then child rows. Before it checks out a pool connection, every transition
also takes an in-process async mutex keyed by `sessionId` (one API instance
until P11), so a hand storm queues in memory and holds at most one of the
process's 10 connections (`platform/database/database.ts:28-30`) instead of
starving unrelated routes; the unlocked fast-path read for a repeat raise
stays outside it.

| Operation | Statements, in one transaction |
| --- | --- |
| Start | (after `ensureRoom`) `INSERT … ON CONFLICT (community_id) WHERE state = 'live' DO NOTHING RETURNING`; moderation row |
| Raise | (fast path: an unlocked read of the caller's open request returns it) session `FOR UPDATE`, must be `live`; `INSERT … ON CONFLICT (session_id, user_id) WHERE state IN ('pending','granted') DO NOTHING RETURNING`; if inserted, `state_version + 1` |
| Grant | session `FOR UPDATE`, `live`; count `granted` < cap; `UPDATE … SET state = 'granted' … WHERE id = $r AND state = 'pending' RETURNING`; `state_version + 1`; moderation row |
| Decline, revoke, withdraw, yield | session `FOR UPDATE`, `live`; `UPDATE … WHERE id = $r AND state = ANY($from) RETURNING` (compare-and-set); `state_version + 1`; a moderation row for moderator acts |
| Presenter claim | session `FOR UPDATE`, `live`; read the open grant: the same user → `held` (200), another user → `occupied` (409); none → `INSERT`; `state_version + 1`; moderation row. The partial unique index is only a backstop, because a unique violation aborts the transaction and cannot tell a repeat from a rival |
| Presenter close | session `FOR UPDATE`; `UPDATE … WHERE session_id = $s AND ended_at IS NULL RETURNING`; `state_version + 1`; a moderation row when revoked |
| Ineligible expiry | session `FOR UPDATE`; expire that user's open request; close their presenter grant; `state_version + 1` |
| Media reset (§11.4) | session `FOR UPDATE`, `live`; `UPDATE … SET media_room_epoch = $e + 1 WHERE media_room_epoch = $e` (compare-and-set); the `reset_media` moderation row (null actor) |
| End | §4.2 |
| Reconciler bookkeeping | `markEmpty`, `noteViolation`: single-row `UPDATE … WHERE state = 'live'` |

### 10.3 Repository ports

No port ever returns every request of a session (`findBySession` goes).

```ts
interface LiveSessionRepository {
  findById(id): Promise<LiveSession | null>;
  findLiveByCommunity(communityId): Promise<LiveSession | null>;
  start(session, moderation): Promise<{ created: boolean; session: LiveSession }>;
  end(input: { sessionId; at; endedBy: string | null; reason; moderation }):
    Promise<{ ended: boolean; session: LiveSession } | null>;
  listLive(after: string | null, limit: number): Promise<readonly LiveSession[]>;
  markEmpty(id, emptySince: Date | null): Promise<void>;
  noteViolation(id, at): Promise<number>;
  bumpEpoch(id, expected: number, moderation): Promise<LiveSession | null>;   // P6: the reset (§11.4)
}
interface SpeakerRequestRepository {
  raise(r): Promise<{ created: boolean; request: SpeakerRequest; stateVersion: number } | 'session_not_live'>;
  findById(id); findOpen(sessionId, userId);
  granted(sessionId): Promise<readonly SpeakerRequest[]>;                     // ≤ 4 rows
  pendingPage(sessionId, after: { requestedAt: Date; id: string } | null, limit /* ≤ 100 */);
  grantWithinCap(i): Promise<'granted' | 'unchanged' | 'slots_full' | 'invalid' | 'session_not_live'>;
  transition(i: { requestId; from; to; at; by: string | null; moderation | null }):
    Promise<{ kind: 'applied' | 'unchanged' | 'invalid' | 'session_not_live'; request }>;
  expireOpenFor(sessionId, userId, at): Promise<SpeakerRequest | null>;
  floorClosedSince(sessionId, since): Promise<readonly string[]>;
}
interface PresenterGrantRepository {
  active(sessionId): Promise<PresenterGrant | null>;
  open(grant, moderation): Promise<'opened' | 'held' | 'occupied' | 'session_not_live'>;
  close(sessionId, by: string | null, reason, at, moderation | null): Promise<PresenterGrant | null>;
  closedSince(sessionId, since): Promise<readonly string[]>;
}
```

### 10.4 Mock and development mode

In-memory adapters implement the same ports and are chosen by
`config.database.configured`, as messaging does (`messaging.module.ts:68-83`).
The fake provider is chosen for the development secret, with a startup log
line. Mock mode keeps working; it never produces a usable media grant.

### 10.5 Redis: not now

The queue is at most the cap in rows, served by partial indexes; presence is
observed, never stored; the API runs as one instance. realtime.md's plan
(`:542-554`) is superseded, and its rule "no permanent business truth lives
only in Redis" still holds. Redis is revisited with a second API instance
(rate limiter, broker — P11) or a hot spot a load test measures. LiveKit's own
Redis, for a distributed LiveKit, is a deployment choice of the media server,
not our data store.

---

## 11. The reconciler

### 11.1 Why level-triggered

Postgres is the truth; LiveKit is brought back in line with it (the
provisional answer to
[Q5](open-questions.md#q5--what-happens-when-the-media-provider-and-our-record-disagree):
the record wins). An edge-triggered repair cannot work here: the in-process
bus has no outbox, so a lost event would mean no revocation; and a rejoin
earns a fresh token of at least 10 minutes each time, so no fixed window after
a revocation bounds the problem. The reconciler therefore compares **desired**
(Postgres, Communities, identity) with **observed** (LiveKit) for everyone
connected, on a period, and corrects the difference. Every step is idempotent.

`LiveReconciler` is an application service on `setInterval` with `unref()`
(`realtime-sessions.ts:94-101` precedent). An in-process guard stops ticks from
overlapping. It runs at boot and then on each period.

### 11.2 Room sweep — every 30 s

1. Page the live sessions (100 at a time); one `listRooms()` filtered by the
   prefix.
2. A live session whose current room is missing → ensure-then-recheck (§4.4).
3. A room observed with 0 participants → set `empty_since` if null; with more
   → clear it. `empty_since` older than 900 s → `endBySystem('idle')` (Q61).
4. A room named prefix + uuid [+ `.` + epoch] (§3.1) that is not the current
   room of any live session and is older than 60 s → `endRoom`. This covers
   a lost start race, a crash between `ensureRoom` and the INSERT, a failed
   `endRoom`, and old epochs. The grace stops it deleting the room of a start
   still in flight.

### 11.3 Participant sweep — every 60 s per live session, staggered

1. One `listParticipants(room)` (10 s timeout).
2. `COMMUNITY_MEMBERSHIP.heads([communityId])`: absent, or
   `runningLiveContinues` false → `endBySystem('community_closed')`.
3. For the connected identities, in chunks of 1,000:
   `COMMUNITY_AUTHORIZATION.permittedAmong` for `community.live.remain`
   (eligible to stay, §3.6), for `community.live.moderate`, and for the host
   alone `community.live.host` (together, the moderator set);
   `ACCOUNT_DIRECTORY.withPermission` for `live.speak` (it also drops
   suspended accounts); from Postgres, the granted requests (≤ 4 rows) and
   the open presenter grant (≤ 1 row). Live applies no ceiling, membership or
   lifecycle rule of its own.
4. For each identity (non-standard kinds — egress, ingress, SIP, agent — are
   ignored; unmappable identities are logged and metered):
   - **not eligible to stay** (§3.6) → one transaction expires the open
     request and closes the presenter grant (`ineligible`); events; then
     `removeParticipant(room, id, {revokeTokensIssuedBefore: now})`; the
     identity joins the watch set (already there: `noteViolation` and the
     media reset, §11.4);
   - **eligible, but no longer a moderator while holding the presenter
     grant** → the grant closes (`ineligible`) in one transaction, with its
     event, before the capability step below;
   - **eligible, but observed capabilities ≠ `capabilitiesFor(desired)`** →
     `updateCapabilities(desired)` (the full set); the identity joins the
     watch set; if it was already there, `noteViolation`, and the media reset
     when it holds a source it is not entitled to (§11.4).
5. Communities, identity, Postgres or LiveKit unreachable → this session's
   tick is skipped. **The sweep never ejects on unknown state.**

The sweep's bound matches the WebSocket revalidation, 60 s
(`realtime-policy.ts:34`).

### 11.4 Targeted watch — every 10 s

`getParticipant` for identities whose floor or presenter grant closed within
the last 660 s (from `granted_at`/`decided_at` and `ended_at` in Postgres),
plus identities the sweep corrected (in memory). Each gets the same step as
§11.3.4. The window is extended on every violation, and
`enforcement_violations` is shown to moderators in the session view. A
speaker demoted 12 minutes ago who rejoins with a refreshed speaker token is
still demoted — the regression test for the fixed-window design this replaces.

**Automatic media reset (P6).** Removal and demotion alone do not stop a
client that reconnects at once, because each rejoin earns a fresh token of at
least 10 minutes carrying the grants of the token it joined with (§9). So when
the reconciler has already removed or demoted an identity inside its
enforcement window and observes it again not eligible to stay, or holding a
source it is not entitled to publish (its second violation), it resets the
room: a compare-and-set `bumpEpoch` with the `reset_media` moderation row,
then `ensureRoom` of the new name, then `endRoom` of the old; the audit
`live.session.media_reset` has a null actor. Every token the violator holds
names the deleted room, which `auto_create=false` keeps deleted; eligible
clients follow `ROOM_DELETED` → refetch → `/join` (§17) and receive tokens for
the new room computed from Postgres. If LiveKit fails midway, the room sweep
ensures the new room and deletes the old as an orphan. A capability observed
below its desired set (a grant not yet applied) is never a violation. The
cost is a brief reconnect for everyone in the room (measured in §21). The
automatic reset is PROVISIONAL under
[Q63](open-questions.md#q63--losing-standing-during-a-running-session), whose
decisions it enforces; a reset or kick that a moderator chooses stays with
Q64 (P12).

### 11.5 After a restart or a LiveKit outage

| Situation | What happens |
| --- | --- |
| **Backend restart** | All truth is in Postgres; nothing is replayed. The reconciler runs at boot: current rooms are re-ensured, orphans deleted after their grace, every connected identity re-checked. The in-memory watch set is lost; the Postgres part of the watch is rebuilt from the timestamps, and the 60 s sweep backstops the rest. LiveKit media and token refresh never stopped |
| **LiveKit unavailable** | Start → **503 `live.media_unavailable`**, nothing stored. Join still issues a token (signed locally); the room and soft-cap checks fail open to the SFU's hard cap; the client's connect fails and it retries `/join` with jittered backoff. Grant, revoke, yield, presenter changes and End commit, are audited and published; the response says `media: 'pending'`. Sweep ticks are skipped |
| **LiveKit back, rooms lost** | The room sweep re-ensures each live session's room within 30 s (`/join` does so at once); the participant sweep converges every capability within 60 s; clients reconnect through the SDK's retries, then `/join`, which recomputes their capabilities from Postgres. Hands, floors and the presenter grant were never lost |
| **Nobody comes back** | The session ends as `idle` after 900 s observed empty (Q61) |

### 11.6 `ProtectLiveSessions` — accelerators, not correctness

Subscribes to `communities.member.removed` (the one class-S event),
`communities.capability.revoked`, `communities.ownership.transferred`, and
`communities.community.locked` / `.unlocked`. Handling is detached and chained
per community id (the `messaging-relay.ts:96-113` pattern). It finds the
community's live session and runs the sweep's per-identity step (removal,
revocation; for a transfer, `fromUserId`, who loses the owner's implicit
moderation, start and presenter eligibility, and `toUserId`, the holder of
`endedGrantIds`) or per-session step (lifecycle) at once. A lost event costs
at most one sweep period.

### 11.7 Several API instances

Exactly one API instance runs until P11. Two reconcilers would only duplicate
idempotent calls; P11 adds a lease (`pg_try_advisory_lock` on a pinned
connection, or a `live_worker_leases` row) for efficiency, not correctness.

---

## 12. Capacity

### 12.1 30,000 members is not 30,000 live participants

A community's size is a count of membership rows
([communities.md §9](communities.md#9-membership-at-30000-and-beyond)). A live
session's size is the number of connections one LiveKit room holds on one
node. The two are independent:

- Live **never lists or loads members**. Per request it makes one point
  permit; batch probes cover only the **connected** identities, once per 60 s.
  Start and end frames probe this instance's online accounts, never the
  community. `COMMUNITY_MEMBERSHIP` exposes no count and no "load all", so
  nothing can size a room from membership.
- **LiveKit rooms are single-node.** A self-hosted room is pinned to one node
  and must fit on it; joins are refused when that node is full (SRV
  `pkg/service/roomallocator.go:139-148`). More nodes means more rooms, not
  bigger rooms.
- **The ~3,000 per-room figure is published by LiveKit but must be
  benchmarked.** It is known here only second-hand (LiveKit GitHub issues
  #3041 and #3285 quote the documentation; one reporter reached 1,500
  subscribers). LiveKit's documentation site could not be read from this
  environment. Load profile 5 measures the knee on our hardware.
- **Nothing is promised above the measured cap**, and 30,000 simultaneous
  listeners in one room is not promised at all.

### 12.2 The cap and the reserve

| Bound | Value | Enforced by | For whom |
| --- | --- | --- | --- |
| `participantCap` | `config.live.maxParticipantsPerSession`, PROVISIONAL 300 (Q57), copied onto the session at start; a config change affects later sessions only | the soft cap | listeners |
| `moderatorReserve` | PROVISIONAL 10 (Q57) | — | moderators and current speakers may use it |
| Hard cap | `cap + reserve` as LiveKit `maxParticipants` | the SFU (SRV `pkg/rtc/room.go:458-467`) | everyone; the client maps the refusal to "full" |

**Soft cap:** on a listener's join, the sampled count (`listRooms([room])`,
cached ≤ 2 s per instance) plus the listener tokens this instance issued since
that sample must stay below `participantCap`; otherwise 412
`live.session_full`. Moderators and current speakers skip it, so a teacher
who drops out gets back in. If the observation fails, the check fails open to
the hard cap. **Residual:** a storm inside one sample, or several instances,
can let listeners take reserve seats; the hard cap still holds. No waitlist
and no overflow stream (Q57).

**What a room costs.** Publishers are bounded: at most 4 speakers, the
moderators publishing by right, and 1 presenter. Listeners publish nothing. A
screen share multiplies egress by the number of subscribers, which is why the
slot is one.

### 12.3 The large-event path stays out of the domain

A need for more listeners than one room holds
([Q58](open-questions.md#q58--more-listeners-than-one-room-can-hold)) is a
separate delivery problem, not built. If it arrives, it is a broadcast
capability **inside Live**: a new port in `live/domain`, implemented in
`live/infrastructure` (for example LiveKit egress to an HLS/CDN stream, or
cascaded rooms). Its listeners are not room participants; whether they may
raise hands or appear in a snapshot is Q58's. Communities, Messaging and
Attendance do not change, and the Community never learns of it.

The topology path changes configuration or the adapter, never domain logic:
a dedicated LiveKit node (the URL and keys); several nodes (LiveKit's own
Redis routing; a room still fits one node); TURN over TLS on 443 (Q65);
regions (`RtcAccessToken.url` is already per token, `rtc-provider.ts:49-54`;
a placement hint can be added to `RtcRoomSpec`); LiveKit Cloud (the same
ports; `revokeTokensIssuedBefore` starts to matter).

---

## 13. Contracts

`live.module.ts` becomes
`imports: [IdentityModule, CommunitiesModule]`,
`exports: [LIVE_AUDIENCE, LIVE_SESSIONS]` (P6), plus `LIVE_PRESENCE` (P9).
Exact TypeScript: the hub's
[§7.5](communities-live-attendance.md#75-live). Only `app.module`,
`realtime` (P7) and `attendance` (P9) import `LiveModule`; notification
translators (P10, Q67) would import `live/contracts` only. Live never imports
any of them.

| Contract (file) | Phase | What it answers | Implemented by | Consumers |
| --- | --- | --- | --- | --- |
| `LiveEvents` + payload types (`contracts/events.ts`) | P0 move, byte-identical; P6 payloads | the event vocabulary (§14) | the domain factories import it | realtime relay; attendance (optional); notifications later (Q67) |
| `LiveParticipantRole` (`contracts/participant-role.ts`) | P1 | `'moderator' \| 'speaker' \| 'listener'`, replacing `'host' \| 'speaker' \| 'listener'` with no alias (only `app.module` imports live; it also ends the name clash with messaging's `ParticipantRole`) | — | views; Flutter |
| `LIVE_SESSIONS.describe(id)` (`contracts/live-sessions.ts`) | P6 | `LiveSessionScope` `{liveSessionId, communityId, hostUserId, active}` or null. Live's own record only; never calls the provider; no principal — the caller authorizes its own act | `LiveSessionsReader` | attendance; any future reader of session scope |
| `LIVE_AUDIENCE` (`contracts/live-audience.ts`) | P6 | `participantsAmong(sessionId, ≤ 1,000 ids)`: those who may take part now, ignoring session state (`COMMUNITY_AUTHORIZATION.permittedAmong(C, ids, 'community.live.join')`, or a moderator); unknown session → `[]`. `moderators(sessionId, page ≤ 1,000)`: holders of `community.live.moderate` (`COMMUNITY_CAPABILITY_HOLDERS`, which applies the act's ceiling), plus the host while `permittedAmong(C, [hostUserId], 'community.live.host')` accepts them; `[]` once ended | `LiveAudienceService` over `COMMUNITY_AUTHORIZATION.permittedAmong` and `COMMUNITY_CAPABILITY_HOLDERS` | realtime `LiveRealtimeRelay` |
| `LIVE_PRESENCE.observe(id)` (`contracts/presence.ts`) | P9 (HELD) | exactly one provider read, normalized under `provider_registry_v1` → `observed {…participants}` \| `not_found` \| `not_active` \| `unavailable` | `LivePresenceService` over `RTC_OBSERVER` | **attendance only** — an allow-list test fails any other importer |

**`LivePresenceService`** (P9): refuse unless the record is `live`; record
`observationStartedAt`; take a concurrency slot (PROVISIONAL 4 per process);
one `listParticipants` under a 15 s deadline; `observedAt` on receipt; keep
standard participants whose identity maps to an account (hidden kept;
DISCONNECTED dropped by the adapter; egress, ingress, SIP, agent and
unmappable identities dropped and metered); `active` → `connected`, `joining`
or `joined` → `connecting`, one entry per account, connected wins, ascending
user id; re-read the record — not `live` after the read → `not_active`;
provider error, deadline, or more than 10,000 entries → `unavailable`. Live
stores nothing and labels nobody present
([Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot),
[Q72](open-questions.md#q72--when-and-how-often-snapshots-are-taken)). The
snapshot itself is [attendance.md](attendance.md).

**Module layout** (evolved in place; no god service):

```
live/
  contracts/   events.ts, participant-role.ts, live-sessions.ts, live-audience.ts, presence.ts (P9), index.ts
  domain/      live-session.ts, speaker-request.ts, presenter-grant.ts, moderation.ts, standing.ts
               (capabilitiesFor, mediaRoomName), live-limits.ts, rtc-provider.ts, ports.ts, events.ts (factories)
  application/ start-live-session, end-live-session, join-live-session, raise-hand, lower-hand,
               moderate-speaker (grant, decline, revoke), presenter (claim, stop), get-live-session,
               get-current-live-session, list-hands; live-access, live-standing, live-session-lifecycle,
               live-reconciler, protect-live-sessions, live-audience.service, live-sessions.reader,
               live-presence.service (P9), live-journal, views
  infrastructure/ livekit-rtc-provider.ts (the only SDK importer), fake-rtc-provider.ts,
               drizzle-live-repositories.ts, in-memory-live-repositories.ts, schema.ts
  api/         live.controller.ts, dto/
```

---

## 14. Events

Names and payload types live in `live/contracts/events.ts` (P0 moves today's
five byte-identically; P6 extends them). `aggregateId = sessionId` for all.
Ids, codes and versions only — never names, tokens, URLs or participant lists.
Every event goes through `LiveJournal`: audit, then event, after commit, and
nothing on a no-op. The full catalogue, with consumers and channels, is the
hub's [§14.3](communities-live-attendance.md#143-catalogue).

| Event (the brief's name) | Published when | Payload (P6) | Audited |
| --- | --- | --- | --- |
| `live.session.started` | a start creates a row | `{sessionId, communityId, hostUserId}` | yes |
| `live.session.ended` | an end changes state (never for the repeat) | `{sessionId, communityId, endedBy \| null, reason, durationSeconds}`; implies every expiry and the presenter close | yes (null actor for the system) |
| `live.speaker.requested` (`live.hand.raised`) | a raise creates a row | `{sessionId, communityId, requestId, userId, stateVersion}` | no |
| `live.speaker.granted` (`live.hand.accepted` **and** `live.speaker.granted`: one fact) | pending → granted | `+ grantedBy` | yes |
| `live.speaker.declined` (`live.hand.rejected`) | pending → declined | `+ declinedBy` | yes |
| `live.speaker.revoked` | granted → revoked | `+ revokedBy` | yes |
| `live.speaker.withdrawn` | withdraw or yield | `+ from: 'pending' \| 'granted'` | no (the requester's own act) |
| `live.speaker.expired` | ineligibility only; **never** for the end | `+ from, cause: 'ineligible'` | no (the cause is audited by its owner) |
| `live.screen_share.started` | a presenter grant opens | `{sessionId, communityId, userId, grantedBy, stateVersion}` | yes |
| `live.screen_share.stopped` | a presenter grant closes, never for the end | `{…, userId, stoppedBy \| null, reason: 'stopped' \| 'revoked' \| 'ineligible', stateVersion}` | when `revoked` |

**Not events:** token issuance, joins and leaves, track publications,
provider-only corrections by the reconciler (`updateCapabilities`,
`removeParticipant`), its media reset (audited only; clients learn of it from
`ROOM_DELETED`), occupancy samples, authorization evaluations. They go to
logs and metrics only; a violation increments the session's counter. Durability
class R for all: the fact is in Live's tables, and every consumer re-asks
(ADR 0021).

---

## 15. API under `/live`

### 15.1 Routes

Every route is prefixed by the module that owns it; the brief's
`/groups/:id/live/…` would put a Live concern in Communities' URL space and
invite the Communities → Live edge that closes a cycle
([hub §15.1](communities-live-attendance.md#151-conventions)). "Live now" is
composed by the client through `GET /live/communities/:id/sessions/current`.

| Route | Phase | Gate | Use case | Success |
| --- | --- | --- | --- | --- |
| `POST /live/communities/:communityId/sessions` (no body) | P6 | `live.moderate` | `StartLiveSession` | 201 `LiveSessionView`; 200 the running session |
| `GET /live/communities/:communityId/sessions/current` | P6 | `live.join` | `GetCurrentLiveSession` | 200 `{session: LiveSessionView \| null}` |
| `GET /live/sessions/:sessionId` | P6 | `live.join` | `GetLiveSession` | 200 `LiveSessionView` |
| `POST /live/sessions/:sessionId/join` (**no body**: the `displayName` DTO is removed) | P1 (P6: community scope) | `live.join` | `JoinLiveSession` | 200 `JoinTicket`; each call re-checks and mints a fresh token. **The only channel that carries a LiveKit credential** |
| `POST /live/sessions/:sessionId/end` | P6 | `live.moderate` | `EndLiveSession` | 200 `LiveSessionView` (ended); repeat 200 |
| `POST /live/sessions/:sessionId/hand` (no body) | P1 | `live.raise_hand` | `RaiseHand` | 201 new `SpeakerRequestView`; 200 the open one (today 202 or 409) |
| `DELETE /live/sessions/:sessionId/hand` | P1 | authenticated | `LowerHand` | 200 `{request: SpeakerRequestView \| null}` |
| `GET /live/sessions/:sessionId/hands?state=pending\|granted&cursor&limit≤100` | P6 | `live.moderate` | `ListHands` | 200 FCFS keyset page, with names from the directory and each speaker's last observed media status |
| `POST /live/requests/:requestId/grant` | P1 | `live.moderate` (before any load) | `ModerateSpeaker` | 200 `{request, media: 'applied' \| 'not_connected' \| 'pending'}` |
| `POST /live/requests/:requestId/revoke` | P1 | `live.moderate` | `ModerateSpeaker` | 200 `{request, media}` |
| `POST /live/requests/:requestId/decline` | P1 | `live.moderate` | `ModerateSpeaker` | 200 `{request}` |
| `POST /live/sessions/:sessionId/screen-share` (no body) | P6 | `live.moderate` | `Presenter.claim` | 201 `LiveSessionView`; 200 when already held |
| `DELETE /live/sessions/:sessionId/screen-share` | P6 | authenticated | `Presenter.stop` | 200 `LiveSessionView`; idempotent |

`media` on grant and revoke: `applied` — LiveKit has the new set;
`not_connected` — the person is not in the room, and the next `/join` carries
it; `pending` — LiveKit was unreachable, and the sweep converges it (Q5).

Not added: a moderator media-room reset (P12), a moderator "remove
participant" route (Q64), any LiveKit webhook route, any load-test or debug
route. The public route list is unchanged; `authorization.spec.ts`'s
controller list is updated in P1 and P6.

### 15.2 Refusal codes

| Code | Kind → HTTP | When |
| --- | --- | --- |
| `live.community_not_found` | not_found → 404 | start, current: no ACTIVE stint, identical to an unknown community |
| `live.session_not_found` | not_found → 404 | any session route: unknown session, or the caller may not take part — identical |
| `live.request_not_found` | not_found → 404 | request routes: unknown request, or its session is not visible to the caller |
| `live.start_not_permitted` | forbidden → 403 | start: a member without `community.live.start` |
| `live.not_a_moderator` | forbidden → 403 | a member who is not a moderator of this session |
| `live.target_is_host` | forbidden → 403 | a delegated moderator acting on the host (Q54) |
| `live.presenter_not_permitted` | forbidden → 403 | a moderator without `live.speak` claims the slot |
| `live.community_not_open` | precondition_failed → 412 | the lifecycle gate refused (start while LOCKED; join or raise under an unmapped status) |
| `live.session_not_live` | precondition_failed → 412 | existing code: the session has ended |
| `live.session_full` | precondition_failed → 412 | a listener over the soft cap (Q57) |
| `live.speaker_slots_full` | precondition_failed → 412 | existing code: 4 speakers already |
| `live.target_not_eligible` | precondition_failed → 412 | grant: the requester may no longer take part |
| `live.invalid_transition` | conflict → 409 | existing code: a transition outside the table |
| `live.presenter_slot_taken` | conflict → 409 | another moderator holds the slot |
| `live.too_many_starts`, `live.too_many_joins`, `live.too_many_hands` | rate_limited → 429 | PROVISIONAL limits (Q26) |
| `live.media_unavailable` | unavailable → 503 | start only: LiveKit unreachable; nothing stored |
| `unavailable` | unavailable → 503 | the Communities store or the directory could not be read |

`live.room_not_found` and `live.speaker_request_exists` disappear with
`LiveRoom` and idempotent raise. No client uses any live route today, so no
client breaks.

### 15.3 Views

Application views, never domain objects (the intent of
`.dependency-cruiser.cjs:129-137`):

- **`LiveSessionView`** `{id, communityId, state, stateVersion, hostUserId,
  startedAt, endedAt, endReason, participantCap, speakerCount,
  presenterUserId, me: {role, isHost, canJoin, canRaiseHand, canModerate,
  canEnd, canPresent, presenting, hand: {requestId, state} | null},
  moderation: {pendingHands, violations, lastViolationAt} | null}`. The `me`
  flags are computed on the server (the `Conversation.canPost` precedent) and
  are display hints; every command re-checks. `moderation` is present for
  moderators only. There is no attendance flag: Live does not know
  attendance.
- **`SpeakerRequestView`** `{id, sessionId, userId, state, requestedAt,
  grantedAt, decidedAt}`, plus `displayName` on the moderators' hands page
  only (from the directory; never an email).
- **`JoinTicket`** `{token, url, expiresInSeconds: 120, role, media:
  {microphone, screen, screenAudio}}`. Never logged; never in an event, frame
  or audit entry.

---

## 16. What travels where

| Fact | LiveKit (media plane) | App WebSocket `/realtime` | HTTP |
| --- | --- | --- | --- |
| Audio, the screen track, speaking indicators | yes | — | — |
| Joins, leaves, the in-room roster | yes (visible to all participants until Q59) | — (no "X joined" frame) | — |
| A participant's own permission change after grant, revoke, yield or presenter change | yes (`ParticipantPermissionsUpdated`; disallowed tracks unpublished at once) | the affected user's `live.session.changed` | the view |
| Disconnect reasons: `ROOM_DELETED` (end, reset), `PARTICIPANT_REMOVED` (ineligible), `DUPLICATE_IDENTITY` (a second device) | yes | — | the client refetches the view |
| Token refresh | yes | — | — |
| Session started, ended | `ROOM_DELETED` at the end | `live.session.started` / `.ended` `{communityId, sessionId[, reason]}` to online accounts `LIVE_AUDIENCE.participantsAmong` accepts, probed in chunks of 1,000; the frame grants nothing | current session; the view |
| Hand, speaker and presenter changes | only the media effect | `live.session.changed` `{communityId, sessionId, stateVersion}` | the view; the hands page |
| The join credential | — | **never** | `POST …/join` response only |
| Attendance observation | the provider read | — | attendance's own routes |
| Data channel | **unused**; `canPublishData` false for everyone | — | — |

**`live.session.changed` coalescing** (in realtime's `LiveRealtimeRelay`,
P7): the affected user (the payload's `userId`) gets the frame at once; online
moderators (`LIVE_AUDIENCE.moderators`, a short keyset list, filtered by who
is online on this instance) get **at most one frame per 250 ms per session**,
through a transient trailing timer that carries the latest `stateVersion`;
nothing is stored. A 300-hand storm gives each moderator about 40 frames, not
300. `eventId = live.session.changed:<sessionId>:<stateVersion>`, so a
redelivered fact has the same id. Listeners get **zero** application frames
for hand, speaker or presenter changes; LiveKit tells the room what the room
needs. Frames are hints: a client refetches the view when the version is newer
than the one it holds, on every reconnect, and on every LiveKit disconnect.
The relay chains per session and returns at once when no one is connected
(`messaging-relay.ts:96-113`). The connection gate stays `messaging.read`
([Q66](open-questions.md#q66--realtime-without-messagingread)). The full matrix
is the hub's [§16](communities-live-attendance.md#16-realtime-transport-matrix).

---

## 17. Flutter: `LiveRepository` and the `LiveMediaClient` seam

**Today:** abstract repositories in `lib/data/repositories/repositories.dart`,
bound to HTTP or mock implementations only in
`lib/providers/app_providers.dart`; media seams with Unavailable defaults
(`lib/data/media/media_seams.dart:5-13`, "a dependency is not added blind");
no `livekit_client`.

```dart
abstract interface class LiveRepository {            // HTTP + mock; bound only in app_providers.dart (P7)
  Future<LiveSessionView?> currentSession(String communityId);
  Future<LiveSessionView> session(String sessionId);
  Future<LiveSessionView> start(String communityId);
  Future<LiveMediaGrant> join(String sessionId);       // toString() redacts the token
  Future<SpeakerRequestView> raiseHand(String sessionId);
  Future<SpeakerRequestView?> lowerHand(String sessionId);
  Future<HandsPage> hands(String sessionId, {HandState? state, String? cursor});
  Future<ModerationResult> grant(String requestId);    // {request, media}
  Future<SpeakerRequestView> decline(String requestId);
  Future<ModerationResult> revoke(String requestId);
  Future<LiveSessionView> end(String sessionId);
  Future<LiveSessionView> claimScreenShare(String sessionId);
  Future<LiveSessionView> stopScreenShare(String sessionId);
}

abstract interface class LiveMediaClient {           // lib/data/live/live_media.dart
  bool get isAvailable;
  LiveMediaState get state;                          // unavailable | idle | connecting | connected
  Stream<LiveMediaState> get states;                 //   | reconnecting | disconnected(reason) | failed
  Future<void> connect(LiveMediaGrant grant);
  Future<void> setMicrophoneEnabled(bool enabled);
  Future<void> setScreenShareEnabled(bool enabled);
  Future<void> disconnect();
}
// Bound to UnavailableLiveMediaClient until P7b. The disconnect reason is our enum
// (duplicateIdentity, roomDeleted, participantRemoved, other) — never a LiveKit type.
```

- **Models** are plain Dart, parsed defensively: unknown enum values become
  `unknown` and are ignored; a missing capability boolean is false. Buttons
  follow the server's `me` flags, never roles, `CurrentUser.permissions` or
  LiveKit events.
- **`LiveSessionController`:** `loading → notLive | live(view, v) | notFound`;
  a `live.session.changed` with a version above `v` triggers one single-flight
  refetch; at or below `v` it is ignored; `live.session.ended` is terminal for
  that id; `reconnected` returns to `loading`. The media state is a sub-state;
  the microphone and screen controls are enabled only when the server view
  grants them **and** the media client reports the provider allows them. The
  media state is never reported to the server as presence.
- **Client rules** (UX; server correctness does not depend on them): on
  `DUPLICATE_IDENTITY`, say "joined from another device" and do not rejoin
  (Q60); on `ROOM_DELETED`, refetch the session — still live (an epoch reset,
  §11.4) → `/join` after a jittered delay, otherwise show "ended"; on
  `PARTICIPANT_REMOVED`, stop and refetch; any other failure after the SDK's
  own retries → `/join` with jittered backoff.
- **Until P7b** the member and moderator screens work over HTTP and realtime
  and say plainly that live audio is unavailable in this build.
  `MockLiveRepository` reproduces the server rules (idempotent raise and end,
  one open hand, the cap as the server reports it), carries `DataOrigin.mock`,
  and never produces a usable media grant.
- **P7b:** `lib/data/live/livekit_live_media_client.dart` becomes the only
  file importing `livekit_client` (2.13.0 at the source read; it pulls in the
  native `flutter_webrtc`). It needs an ADR, device evidence, the Android
  media-projection foreground service and the iOS broadcast extension.
- **Guards:** from P0, no `livekit_client`, `flutter_webrtc` or `dart_webrtc`
  in `pubspec.yaml` or `lib/`; after P7b, one adapter file only. Screens and
  `core/widgets` never import `package:http`, `web_socket`, `api_client.dart`,
  repository implementations, `websocket_realtime_client.dart` or
  `livekit_client`.

---

## 18. Sequences

Participants are columns; messages are numbered. The hub has the
cross-module versions ([A2](communities-live-attendance.md#a2-start-a-live-session-and-join-it),
[A3](communities-live-attendance.md#a3-raise-hand-grant-publish-revoke),
[A5](communities-live-attendance.md#a5-a-removed-member-loses-chat-and-live-access));
these show Live's inside.

### S1. Start a session

```
 Teacher app    StartLiveSession      Communities           Postgres (live)       RtcRoomProvider → LiveKit   LiveJournal
  │                  │                     │                      │                          │                     │
  │ 1 POST /live/communities/C/sessions    │                      │                          │                     │
  │─────────────────▶│ 2 gate live.moderate (no ownerUserId); rate limit per user                │                     │
  │                  │ 3 authorize(T, C, community.live.start)    │                          │                     │
  │                  │────────────────────▶│                      │                          │                     │
  │                  │ 4 permit {basis, membershipId, grantId}    │                          │                     │
  │                  │◀────────────────────│  (404 live.community_not_found · 403 live.start_not_permitted ·      │
  │                  │                     │   412 live.community_not_open, or 200 if live)   │                     │
  │                  │ 5 findLiveByCommunity(C)                   │                          │                     │
  │                  │───────────────────────────────────────────▶│ found → 200 with it; nothing else happens      │
  │                  │ 6 id := new; cap, reserve := AppConfig.live; room := prefix + id      │                     │
  │                  │ 7 ensureRoom({room, maxParticipants: cap + reserve, timeouts 1,200 s})│                     │
  │                  │──────────────────────────────────────────────────────────────────────▶│ create-or-update    │
  │                  │   RtcUnavailableError → 503 live.media_unavailable: no row, no audit, no event             │
  │                  │ 8 BEGIN; INSERT live_sessions (live, state_version 1, host T) ON CONFLICT (community_id)    │
  │                  │   WHERE state = 'live' DO NOTHING RETURNING; moderation start_session; COMMIT              │
  │                  │───────────────────────────────────────────▶│                          │                     │
  │                  │ 9 no row (a concurrent start won) → endRoom(room), best effort; read the winner → 200      │
  │                  │──────────────────────────────────────────────────────────────────────▶│                     │
  │                  │ 10 audit live.session.started; publish {sessionId, communityId, hostUserId}                │
  │                  │────────────────────────────────────────────────────────────────────────────────────────────▶│
  │ 11 201 LiveSessionView {stateVersion 1, me.isHost}         │                          │                     │
  │◀─────────────────│                     │                      │                          │                     │
```

A crash between 7 and 8 leaves an orphan room: the room sweep deletes it after
its 60 s grace. The realtime relay then sends `live.session.started` to
eligible accounts online (hub A2, steps 10–11).

### S2. Join, with the capacity check

```
 Member app     JoinLiveSession    Communities     Postgres (live)   RtcRoomProvider   AccountDirectory  RtcTokenIssuer   LiveKit SFU
  │                  │                 │                 │                 │                 │                │               │
  │ 1 POST /live/sessions/S/join (no body)               │                 │                 │                │               │
  │─────────────────▶│ 2 gate live.join; rate limit (S, U) → 429 live.too_many_joins          │                │               │
  │                  │ 3 findById(S) → null → 404 live.session_not_found                      │                │               │
  │                  │────────────────────────────────▶│                 │                 │                │               │
  │                  │ 4 authorize(U, S.communityId, community.live.join); else LiveAccess.moderator            │               │
  │                  │────────────────▶│  neither → 404 live.session_not_found; gate → 412 live.community_not_open │
  │                  │ 5 S.state ≠ live → 412 live.session_not_live                            │                │               │
  │                  │ 6 standing: findOpen(S, U) granted? presenter active(S)? moderator ∧ can(live.speak)?     │               │
  │                  │────────────────────────────────▶│  (indexed point reads; nothing loads all hands)            │               │
  │                  │ 7 listRooms([room]) — cached ≤ 2 s  │                 │                 │                │               │
  │                  │──────────────────────────────────────────────────▶│                 │                │               │
  │                  │ 7a room missing → ensureRoom(spec(S)); re-read S; ended → endRoom → 412 live.session_not_live  │
  │                  │ 7b listener ∧ sample + listener tokens issued since ≥ S.participantCap → 412 live.session_full │
  │                  │ 7c RtcUnavailableError → skip 7a and 7b: fail open to the SFU's hard cap                     │
  │                  │ 8 describe([U]) → displayName (never an email)    │                 │                │               │
  │                  │────────────────────────────────────────────────────────────────────▶│                │               │
  │                  │ 9 issueAccessToken({room, identity: U, displayName, capabilitiesFor(standing), ttl 120 s})   │
  │                  │─────────────────────────────────────────────────────────────────────────────────────▶│ local signing │
  │ 10 200 JoinTicket {token, url, expiresInSeconds: 120, role, media}   │                 │                │               │
  │◀─────────────────│                 │                 │                 │                 │                │               │
  │ 11 LiveMediaClient.connect(grant) ══════════════════════════════════════════════════════════════════════════════════▶│
  │    hard cap = cap + reserve (refused → "full"); the same identity evicts the older device; refreshed token at join, │
  │    then every 5 minutes                                                                                              │
```

Nothing is stored on join, audited or published: a join is transport noise.

### S3. Raise → grant → publish → revoke

```
 Student app     RaiseHand / ModerateSpeaker     LiveAccess → Communities    Postgres (live)     RtcParticipantControl → LiveKit   Moderator app
  │                     │                               │                         │                        │                         │
  │ 1 POST /live/sessions/S/hand                        │                         │                        │                         │
  │────────────────────▶│ 2 permit community.live.raise_hand (stored communityId)   │                        │                         │
  │                     │ 3 session FOR UPDATE (live); INSERT … ON CONFLICT (S, U) open DO NOTHING RETURNING;                          │
  │                     │   inserted → state_version v+1; COMMIT                    │                        │                         │
  │                     │─────────────────────────────────────────────────────────▶│                        │                         │
  │ 4 201 {request pending} — or 200 with the open one, and no event                │                        │                         │
  │◀────────────────────│ 5 publish live.speaker.requested → realtime: live.session.changed (student now; moderators coalesced)      │
  │                     │ 6 GET /live/sessions/S/hands?state=pending (keyset, names from the directory)      │                         │
  │                     │◀────────────────────────────────────────────────────────────────────────────────────────────────────────────│
  │                     │ 7 POST /live/requests/R/grant — gate live.moderate before any load                 │                         │
  │                     │◀────────────────────────────────────────────────────────────────────────────────────────────────────────────│
  │                     │ 8 moderator? (community.live.moderate, or host + community.live.host); target not the host;               │
  │                     │   the student still eligible (else 412 live.target_not_eligible)                    │                         │
  │                     │──────────────────────────────▶│                         │                        │                         │
  │                     │ 9 session FOR UPDATE (live); granted < 4 (else 412 live.speaker_slots_full); CAS pending → granted;        │
  │                     │   state_version+1; moderation grant_speaker; COMMIT       │                        │                         │
  │                     │─────────────────────────────────────────────────────────▶│                        │                         │
  │                     │ 10 updateCapabilities(room, U, full set: microphone on)   │                        │                         │
  │                     │──────────────────────────────────────────────────────────────────────────────────▶│ applied | not_connected │
  │                     │    RtcUnavailableError → media 'pending'; the record stands; the sweep converges     │ | pending               │
  │                     │ 11 audit live.speaker.granted {permit}; publish → live.session.changed              │                         │
  │                     │ 12 200 {request granted, media}                                                     │                         │
  │                     │────────────────────────────────────────────────────────────────────────────────────────────────────────────▶│
  │ 13 permission update: MICROPHONE allowed                                                                 │                         │
  │◀═════════════════════════════════════════════════════════════════════════════════════════════════════════│                         │
  │ 14 setMicrophoneEnabled(true): the room hears the student                                                │                         │
  │══════════════════════════════════════════════════════════════════════════════════════════════════════════▶│                         │
  │                     │ 15 POST /live/requests/R/revoke → as 8; CAS granted → revoked; state_version+1; moderation row; COMMIT     │
  │                     │ 16 updateCapabilities(full set: microphone off) — LiveKit unpublishes the track at once                    │
  │                     │──────────────────────────────────────────────────────────────────────────────────▶│                         │
  │ 17 microphone track removed; a listener again; membership untouched                                      │                         │
  │◀═════════════════════════════════════════════════════════════════════════════════════════════════════════│                         │
  │                     │ 18 audit + publish live.speaker.revoked; 200 {request revoked, media}                                      │
  │                     │ 19 reconciler: the targeted watch (10 s, for 660 s after the floor closed) and the 60 s sweep demote a      │
  │                     │    client that rejoins with an earlier refreshed speaker token, and count a violation                       │
```

### S4. Screen share: claim and stop

```
 Teacher app      Presenter (claim, stop)     LiveAccess → Communities     Postgres (live)      RtcParticipantControl → LiveKit     Room
  │                     │                              │                          │                       │                        │
  │ 1 POST /live/sessions/S/screen-share (no body)     │                          │                       │                        │
  │────────────────────▶│ 2 gate live.moderate; moderator of S? can(T, live.speak)? (else 403 live.presenter_not_permitted)     │
  │                     │─────────────────────────────▶│                          │                       │                        │
  │                     │ 3 BEGIN; session FOR UPDATE (live); open grant? T's → 200; another's → 409 live.presenter_slot_taken   │
  │                     │   none → INSERT (S, T, grantedBy T); state_version+1; moderation grant_presenter; COMMIT               │
  │                     │────────────────────────────────────────────────────────▶│                       │                        │
  │                     │ 4 updateCapabilities(room, T, {audio: by right, screen: true, screenAudio: false, data: false, hidden: false})
  │                     │─────────────────────────────────────────────────────────────────────────────────▶│                        │
  │                     │ 5 audit + publish live.screen_share.started → live.session.changed (moderators)  │                        │
  │ 6 201 LiveSessionView {presenterUserId: T, me.presenting}                     │                       │                        │
  │◀────────────────────│                              │                          │                       │                        │
  │ 7 LiveMediaClient.setScreenShareEnabled(true): SCREEN_SHARE track published    │                       │                        │
  │═══════════════════════════════════════════════════════════════════════════════════════════════════════▶│ 8 subscribers receive  │
  │                     │                              │                          │                       │═══════════════════════▶│
  │ 9 DELETE /live/sessions/S/screen-share             │                          │                       │                        │
  │────────────────────▶│ 10 T is the presenter → close 'stopped'; state_version+1; COMMIT (no moderation row)                   │
  │                     │────────────────────────────────────────────────────────▶│                       │                        │
  │                     │ 11 updateCapabilities(full set, screen off) — LiveKit unpublishes the screen track at once             │
  │                     │─────────────────────────────────────────────────────────────────────────────────▶│ 12 track gone          │
  │                     │ 13 publish live.screen_share.stopped {reason 'stopped'} (not audited); 200 view  │═══════════════════════▶│
  │◀────────────────────│                              │                          │                       │                        │
```

Another moderator's `DELETE` closes the grant as `revoked` (audited, with a
moderation row) — unless the presenter is the host (403 `live.target_is_host`,
Q54). The end closes it as `session_ended` with no separate event.

### S5. End the session, then reconcile after a crash

```
 Moderator app    EndLiveSession       Postgres (live)       LiveJournal        RtcRoomProvider → LiveKit      LiveReconciler (new process)
  │                    │                     │                     │                        │                            │
  │ 1 POST /live/sessions/S/end              │                     │                        │                            │
  │───────────────────▶│ 2 gate live.moderate; LiveAccess.moderator (404 · 403)                │                            │
  │                    │ 3 BEGIN; session FOR UPDATE; already ended → COMMIT; 200 same view (no audit, event, provider call)
  │                    │────────────────────▶│                     │                        │                            │
  │                    │ 4 UPDATE session ended (moderator, M), state_version+1; UPDATE requests → expired WHERE open;      │
  │                    │   UPDATE presenter → session_ended WHERE open; moderation end_session; COMMIT   ◀── ended is saved first
  │                    │────────────────────▶│                     │                        │                            │
  │                    │ 5 audit live.session.ended; publish ONE live.session.ended          │                            │
  │                    │──────────────────────────────────────────▶│                        │                            │
  │ 6 200 LiveSessionView (ended)            │                     │                        │                            │
  │◀───────────────────│                     │                     │                        │                            │
  │                    │ 7 endRoom(room)  ✗ the process crashes before (or during) this call │                            │
  │                    │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶│ the room still runs;       │
  │                    │                     │                     │                        │ clients keep hearing audio │
  │                    │                     │                     │                        │ and refreshing tokens      │
  │                    │                     │  8 boot: room sweep │                        │                            │
  │                    │                     │◀──────────────────────────────────────────────────────────────────────────│
  │                    │                     │ 9 listLive → S is not live                   │                            │
  │                    │                     │──────────────────────────────────────────────────────────────────────────▶│
  │                    │                     │                     │ 10 listRooms() by prefix → S's room, created > 60 s ago │
  │                    │                     │                     │                        │◀───────────────────────────│
  │                    │                     │                     │ 11 not the current room of any live session → endRoom  │
  │                    │                     │                     │                        │◀───────────────────────────│
  │                    │                     │                     │ 12 ROOM_DELETED to every participant                    │
  │ 13 app: GET /live/sessions/S → ended; a client holding a refreshed token cannot re-create the room (auto_create=false)  │
```

If the crash comes after step 4 but before step 5, the end stands and the
audit row and event are lost (the existing gap, `platform/audit/drizzle-audit-log.ts`;
closed by the outbox in P11); clients learn of the end from `ROOM_DELETED`
and from HTTP. If it comes before step 4 commits, nothing happened: the
session is still live, and the moderator retries (End is idempotent).

---

## 19. Failure-mode matrix

"Record" means Postgres. Timings are the PROVISIONAL values of §3.8.

| Case | Semantics |
| --- | --- |
| **LiveKit unavailable** | Start → 503 `live.media_unavailable`, nothing stored. Join → token issued (local signing), room and soft-cap checks fail open to the hard cap; the client retries `/join` with backoff. Grant, revoke, yield, decline, presenter → committed, audited, published; `media: 'pending'`; the sweep converges (Q5). End → committed; `endRoom` retried by the room sweep. Presence observation (P9) → `unavailable`, attendance stores nothing. Sweep ticks skipped. Communities, Messaging and the realtime socket are unaffected: none depends on Live |
| **Token generation failure** | Local HS256 signing fails only when misconfigured → 500 and an alert log with no token or secret; no state change. Production placeholders are refused at boot (`platform/config/app-config.ts:140-146`). `/join` is idempotent, so the client may retry |
| **Participant disconnected** (network, app killed) | Nothing changes in the record. Speaker and presenter grants survive, and `/join` returns the same capabilities (the tested property, `join-live-session.spec.ts:138-158`). A pending hand stays pending (Q62). The hands page shows `not_connected` for that speaker. LiveKit keeps the room for `departureTimeout` |
| **Teacher loses connection** | The session stays live: the record is the truth, not the room. Moderation continues over HTTP from any device; other moderators act or end the session; the teacher rejoins through `/join`, and the reserve keeps a seat. Host absence never ends a session (Q61) |
| **Teacher device crashes** | The teacher rejoins from any device; LiveKit evicts the stale connection (`DUPLICATE_IDENTITY`). A presenter grant stays until stopped or the session ends; a delegated moderator cannot revoke the host's grant (Q54, §6). If everyone leaves, the session ends as `idle` after 900 s observed empty; LiveKit's 1,200 s timeouts are a backstop |
| **Community locked while a session is active** | PROVISIONAL (Q46): no new session (412 `live.community_not_open`); the running session continues; join, rejoin, raise hand and moderation continue; the host keeps `community.live.host`. Every decision reads the permit or `effects` when it is made; the lock event only accelerates the per-session step |
| **Session ended twice** (double tap, two moderators, system racing a moderator) | The session row `FOR UPDATE` serializes them. The second sees `ended`: 200 with the same view, no audit, no event, no provider call. A repeated `endRoom` treats NotFound as success |
| **Speaker revoked while publishing** | The compare-and-set commits `revoked`; `updateCapabilities` sends the full set without the microphone, and LiveKit removes the track at once. If the call fails, the sweep converges within 60 s. A rejoin with an earlier refreshed speaker token is demoted by the targeted watch within 10 s, and the window extends on each violation; a further rejoin inside it resets the media room (§11.4) |
| **Backend restart** | §11.5. Nothing to replay; frames and events in flight are lost (no outbox); clients reconnect and refetch over HTTP; the reconciler re-converges at boot. A restart is never relied on to eject anyone |
| Session started twice | Step 3 of §4.1 returns the running session with no provider call, and so does step 2 when a lock came in between. Racing starts: the partial unique index keeps one row; the loser ends its own room and returns the winner (200). An orphan from a crashed start goes after the 60 s grace |
| Join racing end | A token minted before the end is useless after `endRoom` (`auto_create=false`). A join that re-created a missing room re-reads `ended`, deletes it and answers 412 |
| Grant to someone not connected | The adapter maps NotFound to `not_connected`; the grant is recorded, audited and published; the next `/join` carries the microphone. (Today the throw after save skips audit and event, `moderate-speaker.use-case.ts:98-109`) |
| Concurrent grants past the cap; two presenter claims | Exactly 4 speakers (412 for the rest); exactly one presenter (409 for the other) |
| Duplicate raise; hand storm | The open request is returned (200); only created rows publish; moderator frames are coalesced; raises serialize briefly on the session row, queued in memory behind the per-session mutex so they do not hold pool connections (§10.2; measured in profile 1) |
| Member removed, suspended, or losing `live.join` or a delegated capability mid-session | The event path, or at worst the 60 s sweep: the hand or floor expires (`ineligible`), the presenter grant closes, then `removeParticipant` or a demotion. Only their client sees `PARTICIPANT_REMOVED` (Q63) |
| Host loses `community.live.start` or leaves mid-session | The host loses moderation; the session continues for the others (Q63); a presenter grant closes as `ineligible` |
| Removed participant rejoins in a loop with refreshed tokens | Removed within 10–60 s; the rejoin inside the enforcement window is the second violation, and the reconciler resets the media room by epoch (§11.4), so no token the client holds opens a room any more; violations counted and shown to moderators. Residual: media until the second violation (the first removal, plus at most one 10 s watch tick), and a brief reconnect for everyone else |
| Media room vanished while live (LiveKit restart, a timeout) | The room sweep ensures it within 30 s; `/join` at once. Hands, floors and the presenter grant survive in the record |
| Communities, identity or Postgres unavailable | Start, join, hand and moderation fail closed with 503 `unavailable` and never fall back to a role-only answer. Sweeps skip the tick and never eject. Media already flowing continues |
| Room full | The hard cap refuses at the SFU; listeners over the soft cap get 412 `live.session_full`; moderators and speakers skip it. Residual: a storm inside one 2 s sample can take reserve seats |
| Same account on a second device | The newest connection wins; the app does not auto-rejoin (Q60) |
| `listParticipants` slow or large at the cap | 10 s timeout; the sweep skips that session and logs it; the watch still runs. A presence observation answers `unavailable` (15 s deadline, 10,000-entry ceiling, Q72) |
| Presence observation racing the end (P9) | `ended` is saved before `endRoom`; the re-read after the provider read sees it → `not_active`; attendance answers 412 and stores nothing |
| Wrong LiveKit key or secret | Every provider call fails as a misconfiguration fault with an alert; the adapter contract suite in CI and the boot-time placeholder check catch it before production |
| Relay or subscriber failure | Isolated and logged by the per-session chain; HTTP state is unaffected; clients reconcile on the next refetch |
| Several API instances (later) | Postgres invariants hold across instances; two reconcilers duplicate idempotent calls; the soft-cap counter is per instance and the hard cap bounds it; frames reach only the publishing instance until the broker (P11) |

---

## 20. Security

Never trusted from the client: its role, community id, display name,
participant state, capability booleans, or any list of participants. The
package-wide model is the hub's [§19](communities-live-attendance.md#19-security-threat-model);
Live's rows:

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Unauthorized LiveKit token (a non-member knows or guesses a session id) | Tokens only from `/join`, after the identity ceiling, the `community.live.join` permit on the stored `communityId`, and the lifecycle gate. Non-members get the same 404 as an unknown session. A token holds `roomJoin` for one room; never `roomCreate`, `roomAdmin` or `roomList`. `auto_create=false` | Depends on the correctness of Communities' membership |
| Token leak or reuse after removal | 120 s initial TTL; the 60 s sweep of everyone connected; the 10 s watch extended on every violation; the automatic epoch reset at the second violation (§11.4); violations shown to moderators; `revokeTokensIssuedBefore` for providers that honour it; tokens never logged, audited, published or framed | Media until the second violation: the first removal (10–60 s) plus at most one 10 s watch tick; the reset then reconnects everyone else briefly. Removal alone is not final on self-hosted LiveKit (Q65) |
| Speaker escalation (keeping the floor; gaining camera, screen or data) | The total set always lists explicit sources; `canPublish` is never true with an empty list; data and metadata updates false for everyone; `CAMERA` never granted; screen share needs a presenter grant; the cap is enforced by the database; a grant confers no community act; adapter contract tests assert every mapping | The convergence window after a rejoin with an old token |
| Teacher or delegate escalation (moderating another community's session; OWNER stepping in) | Moderation needs identity `live.moderate` AND a community permit for that session's community, re-checked on every request and every sweep; no institution-wide override; the host rule is replaced, not bypassed (§7.4) | Who may delegate `community.live.moderate` is Q44's |
| The identity veto becoming a hole during migration | Live stops passing `ownerUserId` and the rule is retired in the same change as `LiveAccess`; a test asserts a `live.moderate` holder without standing is refused | None once they ship together |
| Forged identity or display name | The identity is the user id inside a token signed with our secret; the name comes from the directory; participants cannot rename themselves; the UI takes roles from the session view | A leaked API secret allows any identity (rotate it) |
| Listener publish or data storm | Listeners have no sources, `canPublish` false and `canPublishData` false; at most 4 speakers and 1 presenter; raise hand is rate-limited HTTP with one open hand per user | API floods bounded by the per-process rate limiter |
| Join or rejoin storm | Rate limit per (session, user); a join is a handful of indexed reads and a local signature; jittered client backoff; the hard cap | Unmeasured on the shared VPS until P8 |
| Session id enumeration | uuid v4; 404 for non-members on every route; the coarse gate before any load; the hands page for moderators only | Timing differences, as in existing modules |
| A room re-created after its end; name collisions | `auto_create=false` pinned and tested, and self-checked by the adapter through `/rtc/validate` at boot and every room sweep (§9); ensure-then-recheck; a required prefix per deployment; names from id and epoch | A misconfiguration during the 30 s between two probes; the probe's behaviour is pinned by the contract suite at the pinned server version, so a LiveKit upgrade re-runs it |
| Presence surveillance through `LIVE_PRESENCE` | Allow-listed to attendance; ids and connection states only | Code review of the allow-list |
| Minors' privacy in large rooms | The hands queue for moderators only; frames carry ids only; `hidden` carried in every set as the seam | The roster stays visible to all participants until Q59 |
| API secret exposure | Read only by platform config and the adapter; placeholders refused in production; the SDK confined by the P0 rule; errors scrubbed; a test asserts no JWT pattern in logs | None identified |

---

## 21. Load tests that concern Live

The plan, tools and pass rules are the hub's
[§21](communities-live-attendance.md#21-load-testing-plan). No target is
invented: the curves go to Q57, Q58 and Q65, and the institution sets the
numbers. Runs never use production keys, rooms or hosts (Q65).

| Profile | Live's part | Live measures |
| --- | --- | --- |
| 1. 300 members in one session, audio only | `lk load-test` 1 audio publisher + 299 subscribers, ramped and as a storm; API: 300 joins in the storm window, 50 hands in 10 s, 10 grant/revoke cycles | join p50/p95/p99 and token-mint time; the raise row-lock and mutex wait; pool wait and the p95 of unrelated routes during the storm; grant → `updateCapabilities` latency; moderator frame latency; statements per command; SFU CPU, memory, egress, loss |
| 2. 1 teacher + 300 listeners + screen share | 1 audio + 1 video publisher (the screen-share approximation, labelled as such), with and without simulcast | egress split audio/video; video loss; decoding and battery on a low-end Android device, by hand |
| 3. Many simultaneous communities | K rooms stepped up; K concurrent starts (`ensureRoom`); K active moderators | node CPU and egress against total subscribed tracks; API p95 while the SFU shares the host; the room sweep's cost at K rooms |
| 5. Future large event | one room, subscribers stepped 500 → 1,000 → 2,000 → 3,000 → the knee | the knee on the target node class; `listParticipants` latency and size at each step (it feeds the sweep and the snapshot). **No 30,000-listener room test** |
| Live extras | inside profiles 1 and 5 | a hand storm of the cap in 10 s; the participant sweep's cost at the cap; promotion latency under load; the rejoin storm after an epoch reset (§11.4) |

Correctness under load: no listener track is ever published; every grant,
revoke, start and end has its audit row; `stateVersion` strictly increases
and nothing is missing after the final refetch; never more than 4 speakers or
1 presenter.

---

## 22. Tests

| Layer | What | Phase |
| --- | --- | --- |
| Domain | `ALLOWED_TRANSITIONS` over every (from, to) pair; `capabilitiesFor` total over every standing (listener publishes nothing; a grant adds the microphone only; a moderator without `live.speak` has no microphone; a presenter gets the screen; no standing maps to the camera; data, screen audio and hidden always false); `mediaRoomName` for epochs 0 and n | P1, P6 |
| Use cases (fakes; the real `PolicyAuthorizationService` with `principalWith()`; a fake `COMMUNITY_AUTHORIZATION`) | Idempotent start (one session, one audit, one event; a conflict ends the stray room; a provider failure → 503 and nothing stored); start refusals (404, 403, 412); start, lock, retry → 200 with the running session; join: a non-member gets 404 like an unknown session, an ended session 412, the name from the directory, the role matrix (a delegated moderator who did not start is a moderator; a moderator of another community is a listener; OWNER without standing is a listener; a revoked grant gives no microphone; a grant survives a reconnect); ensure-then-recheck with End in between → 412; the soft cap (tokens since the sample count; moderators and speakers exempt; observer failure fails open); raise 201 then 200 with one event; withdraw and yield; grant, revoke and decline repeats; `target_is_host`; end expires everything with no per-hand events; the presenter rules | P1, P6 |
| Authorization migration | An all-permission principal without standing cannot moderate, end or present, and nothing changes; no live use case passes `ownerUserId` (a spy on the context); `PROVISIONAL_POLICY_RULES` is `[]`; a speaker grant confers no community act | P6 |
| Audit | An explicit audit action per moderation act (the regression for `moderate-speaker.use-case.ts:193`); joins, raises, withdrawals, self-stops and provider-only corrections write no audit; a system end is audited with a null actor | P1, P6 |
| Reconciler (fake provider with scripted observations) | A missing room is re-created, then re-checked; `empty_since` set and cleared, `idle` after the bound; an orphan deleted only after the grace, never during a start in flight; a non-member or suspended account removed with its hand expired and presenter grant closed; a member who loses `communities.read` mid-session removed (eligibility comes from `permittedAmong`, never from a copy of the rule in Live); a member of a LOCKED community not removed; an unmapped status ejects nobody; a wrong permission corrected with the full set; the 12-minute refreshed-token regression; violations counted and the window extended; an identity the reconciler already removed or demoted, observed again inside its window → exactly one reset (epoch + 1 by compare-and-set, the new room ensured, the old ended, `reset_media` and the audit with a null actor), while a capability below its desired set never triggers one; a lost Communities event covered within one sweep; an unreachable dependency skips the tick with no ejection | P6 |
| Restart | Module A starts a session and grants a speaker, then is discarded; module B on the same database reconciles, and its `/join` issues the microphone with no in-memory state | P6 |
| Postgres concurrency (`describeWithPostgres`) | 20 concurrent starts → one live row and the same id for every caller; 20 raises by one user → one open request; 10 concurrent grants → exactly 4 granted; 2 presenter claims → one; grant, raise or claim racing End → nothing open in an ended session; `state_version` +1 per change; End of 3,000 pending hands in one statement within a time budget; the queue page uses its partial index (EXPLAIN); every CHECK rejects its violation | P6 |
| No N+1 | A query counter shows O(1) statements per join, raise, grant and end, whatever the number of hands; no port returns every request of a session | P1, P6 |
| **LiveKit adapter contract suite** (`test/integration/livekit-adapter.spec.ts`; a real, pinned `livekit-server` in CI with `room.auto_create=false`; skipped without credentials) | Decoded tokens carry exactly the expected grants (listener: no sources, `canPublish` false, data false; speaker: `MICROPHONE`; presenter: `SCREEN_SHARE`, no camera, no screen audio; identity = user id; name from the directory; TTL); an update always sends the full set and keeps `hidden` false; an update without the microphone unpublishes a live microphone track; update and remove for an absent identity → `not_connected`; `ensureRoom` surfaces authentication errors and enforces `maxParticipants`; a valid token cannot join a deleted room; the `/rtc/validate` self-check answers 404 for an absent room with `auto_create=false` and succeeds with it on; two deployments with different prefixes on one server never sweep each other's rooms; `DUPLICATE_IDENTITY` evicts the earlier connection; a rejoin gets a refreshed token of at least 10 minutes (documenting the gap the sweep exists for); `listParticipants` state mapping and kind filtering, with latency at 300, 1,000 and 3,000. The behavioural checks need a real client SDK in CI, chosen in P6 | P1 (token shapes), P6 |
| Adapter unit | NotFound → `not_connected`, `null` or success; network, timeout, 5xx → `RtcUnavailableError`; authentication → misconfiguration fault; `createRoom` errors not swallowed; no JWT or secret in any logged error | P1 |
| Presence (P9) | Non-standard kinds and unmappable identities dropped and metered; `joining` → connecting; one entry per account; `not_active` when the record ends before or after the read; `unavailable` on error, deadline or oversize | P9 |
| Realtime relay (P7) | Frames built field by field, ids only; `live.session.changed` to the affected user at once and to moderators coalesced (3,000 events → ≤ 4 frames/s per moderator); start and end frames to eligible online accounts only, with ⌈online/1000⌉ probes; nothing when nobody is connected; order kept per session | P7 |
| Architecture | `livekit-sdk-only-in-the-live-adapter` proven non-vacuous (the adapter's edge exists; nothing else reaches the SDK); the corrected vendor-SDK regex matches `node_modules/livekit-server-sdk/dist/index.js`; `live-boundaries.spec`: live never reaches realtime, notifications, messaging, attendance, operations or academic, and reaches communities only through contracts or `communities.module.ts`; communities never reaches live; `LIVE_PRESENCE` allow-listed to attendance; events live in contracts; exports are contract tokens; no `forwardRef`; the controller list updated | P0, P1, P6, P9 |
| Flutter | `LiveRepository` parsing against `MockClient` (unknown enums, missing booleans); frames from the shared golden fixtures; `LiveSessionController` with fakes (version gating, single-flight refetch, `reconnected`, terminal end, `DUPLICATE_IDENTITY` no rejoin, `ROOM_DELETED`, `PARTICIPANT_REMOVED`); controls only when the server grants and the provider allows; an Unavailable media client never shows connected; mock parity; the import guards | P0, P7 |

---

## 23. Open questions Live depends on

Written in full in [open-questions.md](open-questions.md). Every default below
is PROVISIONAL.

| Q | Where it bites in Live | PROVISIONAL default here |
| --- | --- | --- |
| [Q1](open-questions.md#q1--what-may-each-role-actually-do) | who moderates | revised by ADR 0017 in P6 (§7.4) |
| [Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history) | sessions, hands, presenter grants, moderation rows | kept; Live deletes nothing |
| [Q4](open-questions.md#q4--how-many-concurrent-speakers-and-in-what-order) | speaker cap, queue order | 4, FCFS, unchanged |
| [Q5](open-questions.md#q5--what-happens-when-the-media-provider-and-our-record-disagree) | provider vs record | the record wins; the reconciler converges; `media` reported per call |
| [Q12](open-questions.md#q12--timezone-and-academic-calendar) | scheduled sessions | none in Live; a schedule calls Start |
| [Q26](open-questions.md#q26--realtime-limits) | rate limits, frame coalescing | §3.8 |
| [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules) | P6 (through Communities) and P9 | P0 and P1 are not gated by Q40 (acceptance and approval still apply); P6 waits, through P2, for the §13 step (Q35/Q36 and ADR 0015) or the user's ruling on Q40; P9 also for the reconciliation review |
| [Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock) | LOCKED during a session | §7.3 |
| [Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session) | start, host, moderators, acting on the host | §7.2 |
| [Q55](open-questions.md#q55--parallel-live-sessions-in-one-community) | parallel sessions | one per community |
| [Q56](open-questions.md#q56--screen-sharing) | screen share | one presenter, a moderator with `live.speak`, no audio |
| [Q57](open-questions.md#q57--live-session-size-and-concurrency) | cap, reserve, full | 300 + 10; 412 when full; no waitlist |
| [Q58](open-questions.md#q58--more-listeners-than-one-room-can-hold) | beyond one room | not built; a seam inside Live |
| [Q59](open-questions.md#q59--visibility-inside-a-live-session) | roster, hands visibility | roster visible; hands to moderators; `hidden` false |
| [Q60](open-questions.md#q60--one-account-on-several-devices-in-a-session) | several devices | newest wins; no auto-rejoin |
| [Q61](open-questions.md#q61--ending-abandoned-live-sessions) | abandoned sessions | `idle` after 900 s observed empty |
| [Q62](open-questions.md#q62--floor-rules-beyond-first-come-first-served) | invitations to speak, yield, timeouts | hand only; yield allowed; no timeouts |
| [Q63](open-questions.md#q63--losing-standing-during-a-running-session) | losing standing mid-session | event path, ≤ 60 s by the sweep; a media reset at a second violation (§11.4) |
| [Q64](open-questions.md#q64--removing-a-participant-from-a-session) | kick, re-entry, media reset | seams only; the automatic reset at a second violation is Q63's (§11.4); a moderator's reset or kick waits (P12) |
| [Q65](open-questions.md#q65--media-hosting-and-operations) | hosting, TURN, load-test safety | self-hosted, `auto_create=false`; TURN before the first class |
| [Q66](open-questions.md#q66--realtime-without-messagingread) | frames without `messaging.read` | the gate stays; a coupling test |
| [Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts) | notifying session starts, grants | none; events published for later |
| [Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot), [Q69](open-questions.md#q69--who-records-and-who-views-snapshots), [Q72](open-questions.md#q72--when-and-how-often-snapshots-are-taken) | the presence side (P9) | raw connection states only; 15 s, 10,000, 4 |

---

## 24. Deferred

- **P12, policy-gated:** a media-room reset that a moderator chooses (the
  same mechanism as the reconciler's automatic reset in P6, §11.4, behind a
  route); a moderator kick and re-entry rules (Q64);
  delegated or audio screen share (Q56); hidden listeners (Q59); webhook
  accelerators with a signature check.
- **Not in this design:** recording, transcription and breakout rooms
  (realtime.md `:610`); scheduled sessions (Q12); a large-event broadcast (Q58);
  notifications for live facts (Q67); a waitlist or overflow (Q57).
- **Documents to correct when the phases land** (this package added only
  labelled correction notes and proposed-change pointers; the rewrites land
  with the phases):
  realtime.md Part A (§1.2 above), module-boundaries.md's live section,
  events.md's live catalogue, ADR 0003's consequences (superseded in part by
  ADR 0019, never edited), and the comments in `live/domain/events.ts:3-7` and
  `operations/contracts/index.ts:1-6` that give attendance to operations.
