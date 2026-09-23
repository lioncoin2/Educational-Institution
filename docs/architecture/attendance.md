# Attendance

**State: APPROVED as designed (2026-09-23) — implementation HELD** until the institution answers the attendance policy questions, especially [Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot) and [Q69](open-questions.md#q69--who-records-and-who-views-snapshots) (the user's Q40 ruling). Nothing here exists.

> **HELD.** Implementing this module is held, and nothing in this document
> lifts the hold. Three things stand in the way, and all three must clear
> before phase **P9** starts ([§23](#23-before-p9-can-start)):
>
> 1. **[Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules),
>    which covers the user's Attendance hold.** "Assignments, Attendance,
>    Progress and Promotion do not start until this reconciliation has been
>    reviewed" (`academic-reconciliation.md:19-21`; `academic.md:28-30`). Q40
>    asks whether that hold, with what §13 says Attendance needs first
>    (`academic-reconciliation.md:504`), and §13's "before any new module" step
>    (`academic-reconciliation.md:483-493`) cover live-presence snapshots. The
>    provisional default is that they do.
> 2. **[Q69](open-questions.md#q69--who-records-and-who-views-snapshots).**
>    Reviewers must accept community standing, not `ACADEMIC_RELATIONSHIPS`,
>    as the scoping relationship §13 asks for (`academic-reconciliation.md:504`),
>    and the user must confirm or replace its record and view defaults.
> 3. **Phase P6.** There is nothing to observe until community-scoped, persisted
>    live sessions exist ([live.md](live.md)).

This is the design of the `attendance` module: attendance snapshots taken
during a live session (brief §13–§15), phase **P9**. It is one part of the
Communities + Live + Attendance package. The overview, dependency graph,
cross-module contracts and phase table are in the hub,
[communities-live-attendance.md](communities-live-attendance.md). The decision
is [ADR 0020](decisions/0020-attendance-snapshots.md) (Accepted; implementation
HELD), and the rules it follows for events, journals and failure kinds are
[ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md). Live's side
of the observation is in [live.md](live.md); the community acts it asks about
are in [communities.md](communities.md).

**The name.** In code and in these documents the brief's "Group" is the
**Community** aggregate: module `communities`, id `communityId`. "Group" is
avoided because it already means messaging's `GROUP` conversation type
(`messaging/contracts/vocabulary.ts:11`), and it is used for Tahajji's
«مجموعة» in
[Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups),
which is unanswered. The brief's `group.attendance.record` and
`group.attendance.view` are `community.attendance.record` and
`community.attendance.view` here.

**How to read this document.**

- **What exists today** means the repository at commit `9670c47`. It is
  described in [§1](#1-what-exists-today), and every such statement says so and
  cites `file:line` (the file name, or a short path when the name is ambiguous).
  Every `file:line` in this document is at `9670c47`, documents included: the
  notes this package added have since moved lines in `module-boundaries.md`,
  `events.md` and `open-questions.md`.
- **Everything else is a proposal.** Every default that is institutional policy
  is labelled PROVISIONAL and names its open question. Engineering bounds that
  must be measured are PROVISIONAL too.
- **LiveKit facts come from source, not documentation.** LiveKit's
  documentation site could not be read from this environment. The facts were
  read in the installed `livekit-server-sdk` 2.19.1 (**SDK**), the server at
  commit `6b2e3ec` (**SRV**) and the protocol at `72d9ef1` (**PGO**), as in
  [live.md](live.md).

---

## 1. What exists today

**Today there is no attendance module**, and no snapshot, observation or
attendance table anywhere. What exists today that this design depends on,
replaces or must not disturb:

| What exists today | Where | Consequence here |
| --- | --- | --- |
| No `attendance` module. The backend modules are academic, assignments, automation, files, identity, live, messaging, notifications, operations, people, realtime and reporting | `backend/src/modules/` | Attendance is a new module, and so a "new module" in §13's sense (Q40) |
| Operations is an empty `@Module({})`. Its only code is contract types: `AttendanceState = 'present' \| 'absent' \| 'late' \| 'excused'`, `SessionRef {sessionId, halaqaId, scheduledAt}`, `AttendanceAmendment {reason, amendedBy}` | `operations.module.ts:11-12`; `operations/contracts/index.ts:7-19` | Unchanged. Snapshots use none of them ([§13](#13-snapshots-and-operations-attendancerecord)) |
| The documents give attendance to operations, derived from `live.session.ended` | `module-boundaries.md:146-149`, `:241-243`; `events.md:47-54`, `:181`; ADR 0006 `0006-event-architecture.md:9-10` | Corrected in P0 ([§3](#3-the-smallest-change-to-existing-documents)) |
| Two code comments say the same: operations "reacts to `live.session.*` events to record attendance"; "Operations turns `LiveSessionStarted`/`Ended` into attendance" | `operations/contracts/index.ts:1-6`; `live/domain/events.ts:3-7` | Corrected in P0 |
| `live.session.ended` is declared as `{sessionId, roomId, durationSeconds}`, with no participants, and its factory has no caller | `live/domain/events.ts:14-17`, `:43-50` | Attendance could never have been derived from it ([§2](#2-why-attendance-is-a-module-of-its-own)) |
| `LiveSession` is called "the unit attendance is tied to", but `LiveRoom` is bound to a halaqa, every live repository is in memory and empty at boot, and there is no start or end use case | `live-room.ts:10-18`, `:22`; `live.module.ts:51-57` | Nothing to observe until P6 |
| The RTC port has six methods and no participant listing | `live/domain/rtc-provider.ts:56-79` | Live gains `RtcParticipantObserver.listParticipants` (P6) and `LIVE_PRESENCE` (P9) |
| The room name is the session id; the LiveKit identity is the account id | `join-live-session.use-case.ts:96-98` | Live can map a provider identity back to an account without any table |
| `LiveModule` exports nothing; `live/contracts` exports only `ParticipantRole`, and its comment says other modules react to events "rather than calling in" | `live.module.ts:36-62`; `live/contracts/index.ts:1-7` | Two new contracts and a reworded comment ([live.md §13](live.md#13-contracts)) |
| SUPERVISOR holds **unscoped** `attendance.read`; TEACHER unscoped `attendance.read` and `attendance.manage`; ASSISTANT_TEACHER unscoped `attendance.read` | `provisional-policy.ts:52`, `:71-72`, `:94` | Never consulted here ([§11](#11-who-records-and-who-views)) |
| Those grants must be scoped "through `ACADEMIC_RELATIONSHIPS` (or leave them unexercised)" before Attendance uses them | `open-questions.md:817-826` (Q31); `academic-reconciliation.md:504` | Left unexercised |
| "`attendance.*` will be enforced by Operations" | `identity/contracts/permissions.ts:9-10` | Stays true: the permission namespace is not this module ([§11.2](#112-institutional-oversight-without-attendanceread)) |
| No failure kind maps to 503 | `shared/result.ts:21-28`; `http-failure.ts:12-20` | P0 adds `'unavailable'` |
| The global ValidationPipe rejects any body field a DTO does not declare | `configure-app.ts:15-22` | A client-supplied participant list is refused at the edge |
| Idempotency by a client key and a named UNIQUE constraint: `messages_idempotency_unique`, key shape `^[A-Za-z0-9_-]{8,64}$` | messaging `schema.ts:137-141`; `message.ts:50`, `:64-71` | The same pattern ([§8](#8-idempotency-the-double-press)) |
| After a change: its audit entry, then its event; nothing for a no-op | `academic-journal.ts:11-39` | `AttendanceJournal` |
| The app's `Halaqa.attendedSessions` and `attendanceRatio`, and `ProgressSummary.attendanceRatio`, exist; the academic repository records no attendance and computes no percentage | `learning.dart:67`, `:90`, `:106-107`; `progress.dart:25`; `academic_learning_repository.dart:16-18` | Snapshots never fill them ([§12](#12-no-threshold-duration-or-percentage)) |

---

## 2. Why attendance is a module of its own

| Owner | Verdict | Why |
| --- | --- | --- |
| **A new leaf module, `attendance`** | chosen | Brief §13 makes attendance "its own domain capability", and §7 says Live does not own attendance history. The brief's event `attendance.snapshot.recorded` names the module under `<module>.<aggregate>.<verb>` (`events.md:243`) |
| operations | rejected | Its charter is delivery-agnostic: it "must not know how a session is delivered" (`module-boundaries.md:146`). Its only contract is keyed on a halaqa and a schedule (`SessionRef`, `operations/contracts/index.ts:9-13`). Its `AttendanceRecord` is the held work (`academic-reconciliation.md:504`). It would add live and communities to a dependency list documented as academic and people only (`module-boundaries.md:144`), making operations a hub. And the event would be `operations.*` |
| live | rejected | Live must not know attendance (brief §7; `module-boundaries.md:241-243`). It would need the view capability, a retention rule and a management audience it has no business with, and its persistence is in memory today |

**Why a contract, not an event.** "Who is connected right now" is a question,
and a question is asked through a contract, never an event
(`events.md:56-60`, `:249`). The documented design, deriving attendance from
`live.session.ended`, could never work: the event carries no participants and
is never raised (§1), and the brief wants the moment of the press, not the end
of the session.

**Other sources, rejected.**

| Source | Why not |
| --- | --- |
| LiveKit webhooks (`participant_joined` / `left`) as a presence ledger | The notifier queues per room with a default depth of 200 and a maximum age of 30 s (PGO `webhook/resource_url_notifier.go:53-56`), so events are dropped in join storms. No webhook route exists. A ledger also invites durations, which brief §14 forbids |
| The app WebSocket (`ConnectionManager.isOnline`) or a Redis presence set | `isOnline` means "has an app socket on this API instance" (`connection-manager.ts:57-59`): not media presence, and per process. A Redis set would be a second, drifting copy of what the SFU already holds |
| A list sent by the teacher's app | Spoofable (brief §25). Hidden participants are invisible to clients. The app has no LiveKit client at all |
| A later query of LiveKit, when someone views a snapshot | Brief §13: "do NOT make attendance depend on querying LiveKit later". The observation is read once and stored; reads never touch LiveKit |

---

## 3. The smallest change to existing documents

Two documents and one ADR say that operations derives attendance from
`live.session.ended`. The corrections are P0 item 11 in the hub
([§25.1](communities-live-attendance.md#251-phase-0-corrections)). **This
package only annotates them:** it added labelled Correction and Proposed-change
notes to `events.md` §2 and to `module-boundaries.md`'s operations and live
sections. The replacement text below lands in P0. Its line numbers are at
`9670c47`, so each row for a changed document also names its section.

| Where | Says today | Becomes |
| --- | --- | --- |
| `module-boundaries.md:146-149` (operations, "Must not know") | "How a session is delivered. A session held in a live audio room is the same session to operations; it subscribes to `live.session.ended` and records attendance from it, and would work identically for a room with chairs." | "How a session is delivered. Live-session presence observations are attendance-module snapshots ([attendance.md](attendance.md)). Whether the institution's `AttendanceRecord` uses them is Q70; if it does, operations depends on `attendance/contracts`, never the reverse." |
| `module-boundaries.md:241-243` (live, "Must not know") | "It also must not know about attendance — operations derives that from the events." | "It also must not know about attendance: attendance asks `LIVE_PRESENCE`, and live never imports attendance." |
| `module-boundaries.md` (new section) | — | An `attendance` section, marked HELD: owns `AttendanceSnapshot`; public contract `attendance/contracts/events.ts` only; events `attendance.snapshot.recorded`; depends on `live/contracts`, `communities/contracts`, `identity/contracts`; must not know LiveKit, operations' `AttendanceState`, halaqa ids, `attendance.read` or `attendance.manage` |
| `events.md:47-54` (§2, the example) | `operations` "needs to record attendance when a live session ends" | The principle stays. A note says the attendance example is superseded by [ADR 0020](decisions/0020-attendance-snapshots.md): "who is connected now" is a question, answered through `LIVE_PRESENCE`, which is exactly the rule at `:56-60` |
| `events.md:181` (catalogue) | `live.session.ended` → "operations (attendance), reporting" | "the realtime relay (P7); attendance (optional, none built); reporting". A new row: `attendance.snapshot.recorded`, raised by attendance, no subscriber |
| ADR 0006 `0006-event-architecture.md:9-10` | "`operations` records attendance when a live session ends" | **Not edited**: an ADR is superseded, never rewritten. ADR 0020 supersedes this example in part. ADR 0006's decision (an in-process bus, outbox-ready) stands |
| `operations/contracts/index.ts:1-6`; `live/domain/events.ts:3-7` (comments) | operations records attendance from `live.session.*` | The operations comment becomes: "Operations: scheduling, sessions and the institution's `AttendanceRecord` (on hold). Live-session presence observations are attendance-module snapshots; whether `AttendanceRecord` uses them is Q70." Live's comment drops the operations sentence. Types unchanged |
| `identity/contracts/permissions.ts:9-10` | "`attendance.*` will be enforced by Operations" | **Unchanged.** It stays true ([§11.2](#112-institutional-oversight-without-attendanceread)) |

---

## 4. Dependency direction

Arrows point from the importer to what it imports.

```
          ┌──────────────┐
          │   identity   │◀──────────────────────────────────────┐
          └──────────────┘                                       │ ACCOUNT_DIRECTORY.describe
                 ▲                                               │ (names at read time)
                 │ imports                                       │
          ┌──────────────┐    COMMUNITY_AUTHORIZATION            │
          │ communities  │◀───────────────────────────────┐      │
          └──────────────┘    (community.attendance.*)    │      │
                 ▲                                        │      │
                 │ imports                                │      │
          ┌──────────────┐    LIVE_SESSIONS.describe  ┌──────────────┐
          │     live     │◀───────────────────────────│  attendance  │
          └──────────────┘    LIVE_PRESENCE.observe   │  HELD · P9   │
                 │                                    └──────────────┘
                 ▼ the only SDK importer                     ▲
          livekit-server-sdk                                 │ registers
                                                        app.module only
```

`AttendanceModule.imports = [IdentityModule, CommunitiesModule, LiveModule]`,
and it exports nothing. The topological order is Identity → Communities →
Live → Attendance, so the graph stays a DAG with no `forwardRef` (the hub's
[§3](communities-live-attendance.md#3-dependency-graph) has the whole graph).

| Edge | Allowed? | Enforced by |
| --- | --- | --- |
| attendance/application → `live/contracts` (`LIVE_SESSIONS`, `LIVE_PRESENCE`) | yes (P9) | — |
| attendance/application → `communities/contracts` (`COMMUNITY_AUTHORIZATION`) | yes (P9) | — |
| attendance/application, api → `identity/contracts` (`ACCOUNT_DIRECTORY`, route-access decorators) | yes (P9) | — |
| attendance → shared (`AUDIT_LOG`, `EVENT_PUBLISHER`, `RATE_LIMITER`, `CLOCK`, `ID_GENERATOR`, `Result`, `Principal`, pagination) | yes | — |
| live → attendance, even transitively | **no** | `live-boundaries.spec`, `attendance-boundaries.spec` |
| communities → attendance or live | **no** | `communities-boundaries.spec` (`edgesFrom` for the module file) |
| any module except `app.module` → attendance | **no**: it is a leaf | `attendance-boundaries.spec` |
| any module except attendance → `live/contracts/presence.ts` | **no** | an importer allow-list test |
| attendance → `livekit-server-sdk`, `@livekit/*`, or live and communities internals | **no** | `livekit-sdk-only-in-the-live-adapter` (P0); `attendance-boundaries.spec` |
| attendance → `operations/contracts`, academic, realtime, notifications | **no**: a vocabulary firewall; no halaqa ids | `attendance-boundaries.spec` |
| attendance → `COMMUNITY_MEMBERSHIP`, `COMMUNITY_CAPABILITY_HOLDERS` | **no**: it asks only `COMMUNITY_AUTHORIZATION`, and a snapshot never enumerates members ([§6.4](#64-size)) | `attendance-boundaries.spec` |
| the strings `attendance.read` / `attendance.manage` under `src/modules/attendance/` | **no** | a grep test |
| operations → `attendance/contracts` | only if Q70 says so | — |
| notifications → `attendance/contracts` | P10, only after Q67 | — |

---

## 5. The observation contract

Live owns the observation and writes it in attendance-agnostic words: it
reports connection states, and knows nothing of snapshots. The detail of Live's
side is [live.md §13](live.md#13-contracts); this section fixes what
attendance relies on.

### 5.1 `LIVE_SESSIONS` and `LIVE_PRESENCE`

```ts
// live/contracts/live-sessions.ts (P6)
export const LIVE_SESSIONS = Symbol('LIVE_SESSIONS');
export interface LiveSessionScope { readonly liveSessionId: string; readonly communityId: string; readonly hostUserId: string; readonly active: boolean }
export interface LiveSessions { describe(liveSessionId: string): Promise<LiveSessionScope | null> }
// Live's own record only; never calls the provider; no principal (the trusted caller authorizes itself).

// live/contracts/presence.ts (P9; importable only by attendance)
export const LIVE_PRESENCE = Symbol('LIVE_PRESENCE');
export type ObservedConnection = 'connected' | 'connecting';
export type PresenceObservation =
  | { kind: 'observed'; liveSessionId: string; communityId: string; observationStartedAt: Date; observedAt: Date;
      participants: readonly { userId: string; connection: ObservedConnection }[] /* one per account, ascending userId */ }
  | { kind: 'not_found' } | { kind: 'not_active' } | { kind: 'unavailable' };
export interface LivePresence { observe(liveSessionId: string): Promise<PresenceObservation> } // exactly one provider read
```

- **No principal.** The caller is a trusted in-process module that has already
  authorized, as with `MESSAGE_RECIPIENTS` (`message-recipients.ts:13-20`).
  Because a principal-less presence question is sensitive, an architecture test
  lets only attendance (and `app.module`, for wiring) import `presence.ts`.
  `LIVE_SESSIONS` is benign and open to any module.
- **Exactly one provider read per call**, never cached. `LIVE_SESSIONS.describe`
  never calls the provider at all.
- **Inside Live** (not a contract): `LivePresenceService` implements it over
  `RtcParticipantObserver.listParticipants(room)`, which the adapter implements
  with `RoomServiceClient.listParticipants` (SDK `src/RoomServiceClient.ts:202-211`:
  one unpaginated call, with a per-call `roomAdmin` token). Live derives the
  room name from its own record. The port also returns `joinedAt`, published
  sources and capabilities for Live's reconciler. **None of them crosses the
  contract**: attendance receives an account id and a connection state, nothing
  else.

### 5.2 What counts as observed: `provider_registry_v1`

An **observation** is what LiveKit's participant registry held for the session's
room at one read, filtered by this rule. It is not a statement that anyone was
present. **What "present" means is institutional policy and stays open
([Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot)).**

| Registry entry (PGO `ParticipantInfo`) | Becomes |
| --- | --- |
| kind STANDARD, identity is account-shaped, state `ACTIVE` ("ICE connectivity established", PGO `livekit/livekit_models.pb.go:942-943`) | an entry, `CONNECTED` |
| kind STANDARD, identity is account-shaped, state `JOINING` or `JOINED` | an entry, `CONNECTING` |
| the same account twice (defensive; `DUPLICATE_IDENTITY` normally evicts the older one, SRV `pkg/service/roommanager.go:398-400`) | **one** entry; `CONNECTED` wins |
| a participant with a hidden grant | **kept**, like any other |
| state `DISCONNECTED` | dropped by the adapter |
| any other kind (PGO `livekit/livekit_models.pb.go:995-1007`: INGRESS, EGRESS, SIP, AGENT, CONNECTOR, BRIDGE) | dropped; counted in Live's metrics, never returned |
| an identity that is not an account id under Live's scheme | dropped; counted as a security signal, logged without its value |

Why these choices:

- **CONNECTING is kept, not decided.** People still joining or reconnecting are
  commonest exactly when a teacher presses (join storms). A rule listing only
  ACTIVE participants would silently decide that they are absent and throw the
  fact away for good. Both states are stored and counted separately; neither is
  labelled present.
- **Hidden is kept.** `hidden` is a Live display grant for roster privacy. LiveKit
  stores a hidden participant like any other (SRV `pkg/service/roommanager.go:595`;
  the hidden check at `:600` affects only the room's participant count). If
  listeners are ever hidden ([Q59](open-questions.md#q59--visibility-inside-a-live-session)),
  they are still connected members.
- **Every role is treated the same**: host, moderators, speakers, listeners, and
  the recorder if connected. No role is stored.
- **The rule is versioned.** Each snapshot stores `observation_rule =
  'provider_registry_v1'`. A different rule (dial-in mapped to accounts, or a
  large-event path's own presence source,
  [Q58](open-questions.md#q58--more-listeners-than-one-room-can-hold)) gets a
  new id; old snapshots keep theirs and are never rewritten.

### 5.3 The observation bracket and the re-check

`LivePresenceService.observe(S)`:

1. Reads Live's record. Unknown → `not_found`; not `live` → `not_active`.
2. Takes a concurrency slot and sets `observationStartedAt` from the clock.
3. Makes **one** `listParticipants` call under the deadline.
4. Sets `observedAt` on receipt, then applies the rule.
5. **Re-reads its record.** No longer `live` → `not_active`, and the listing is
   thrown away.
6. Any error, the deadline, or an oversize answer → `unavailable`.

The registry read that serves the listing happens somewhere inside
`[observationStartedAt, observedAt]`. We cannot know exactly when, so both ends
are stored: the bracket is the honest instant.

**A requirement on Live.** Ending a session must save `ended` **before** calling
`endRoom`. Otherwise step 5 cannot catch a listing taken during teardown, when
`endRoom` is removing everyone. [live.md §4.2](live.md#42-end--idempotent-one-transaction-one-event)
adopts this ordering.

### 5.4 Bounds

All PROVISIONAL engineering bounds, each in one file, calibrated by the load
test before production use ([Q72](open-questions.md#q72--when-and-how-often-snapshots-are-taken);
hub [§21](communities-live-attendance.md#21-load-testing-plan)):

| Bound | Value | Owner | Why |
| --- | --- | --- | --- |
| Overall deadline per observation | 15 s | Live | The SDK's per-request default is 10 s (SDK `src/TwirpRPC.ts:41`), and a self-hosted host gets a single attempt: failover applies only to LiveKit Cloud hosts (SDK `src/failover.ts:27-39`) |
| Listings in flight per process | 4 | Live | On the single VPS, LiveKit, the API and Postgres share one box; this protects media CPU and the event loop |
| Entries per listing | 10,000 | Live | A defensive memory guard; above it → `unavailable` |
| Presses per recorder | 6 per 60 s (`RateLimitPolicy 'attendance.snapshot.user'`) | attendance | Anti-abuse: it bounds bursts from one recorder, not how many snapshots a session may have, which a per-session cap would (policy, Q72) |

---

## 6. The snapshot model

### 6.1 The aggregate

```ts
// attendance/domain/snapshot.ts: pure; imports only the shared kernel, never live's contract.
export interface AttendanceSnapshot {
  readonly id: Id<'AttendanceSnapshot'>;
  readonly communityId: string;        // the community the permit was issued for
  readonly liveSessionId: string;      // Live's LiveSession id; never a LiveKit room name, sid or identity
  readonly hostUserId: string;         // Live's hostUserId at the press: the host's view basis (§11.3)
  readonly recordedBy: string;         // principal.userId, never from the client
  readonly clientRequestId: string;    // ^[A-Za-z0-9_-]{8,64}$
  readonly observationRule: 'provider_registry_v1';
  readonly observationStartedAt: Date;
  readonly observedAt: Date;
  readonly recordedAt: Date;           // max(clock.now(), observedAt)
  readonly connectedCount: number;
  readonly connectingCount: number;
  readonly entries: readonly SnapshotEntry[];   // persisted as child rows
}
export interface SnapshotEntry { readonly userId: string; readonly connection: 'CONNECTED' | 'CONNECTING' }

/** Re-validates what Live already guarantees (one entry per account, connected wins), derives the counts,
 *  refuses a malformed key with validation 'attendance.client_request_id_invalid'. Zero entries is valid. */
export function takeSnapshot(input: TakeSnapshotInput): Result<AttendanceSnapshot>;
```

The application maps `PresenceObservation` into the domain's own input type,
so the domain never imports Live. A snapshot has **no lifecycle**: it is created
once and read afterwards. There is no OBSERVING or FAILED state, because nothing
is written until the observation has succeeded ([§8](#8-idempotency-the-double-press)).

### 6.2 Invariants

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | One entry per (snapshot, account) | PK `(snapshot_id, user_id)`; `takeSnapshot` |
| I2 | The counts equal the entries by connection | written in the same transaction as the entries; integration test |
| I3 | `observationStartedAt ≤ observedAt ≤ recordedAt` | CHECK; the writer sends `greatest(now, observed_at)`, the `notBefore` helper's pattern (`drizzle-academic-repository.ts:41-44`) |
| I4 | One snapshot per `(liveSessionId, recordedBy, clientRequestId)` | UNIQUE constraint, not a prior read |
| I5 | Immutable | no mutator, no UPDATE or DELETE path in the port, adapter or API; a test asserts it ([§10](#10-immutability-and-amendment)) |
| I6 | No attendance vocabulary: no present, absent, late or excused; no absentees; no halaqa id | the vocabulary is `CONNECTED \| CONNECTING` only; a test scans for the words |
| I7 | Ids only: no display names, LiveKit identities or sids, join times or roles | columns ([§7](#7-persistence-proposal)) |
| I8 | Observed while the session was live | Live's re-check after the read ([§5.3](#53-the-observation-bracket-and-the-re-check)). A session that ends after the re-check still yields a valid snapshot: the observation came first |
| I9 | `communityId` is the authorized community | the use case asserts `observation.communityId === permit.communityId`; a mismatch is a fault (500) and nothing is stored |

### 6.3 Names are read at view time

The entries hold **stable account ids only**. Display names belong to identity
and are resolved when a snapshot is viewed, through `ACCOUNT_DIRECTORY.describe`
(at most 1,000 ids a call, `account-directory.ts:18`; never an email,
`account-directory.ts:6-10`), one call per page. An account that has since been
deactivated is still listed, because the record is historical; an unknown one
shows a null name. Storing names would copy identity's data, freeze a stale
spelling, and store what the client supplies to Live today
(`join-session.dto.ts:3-8`, removed in P1).

### 6.4 Size

A snapshot is bounded by **one live room**, never by the community.
30,000 members is not 30,000 live participants, and so not 30,000 entries: a
snapshot never enumerates members, computes absentees or checks membership.

| Room size | Why this size | Entries | Storage (rough; measure it) |
| --- | --- | --- | --- |
| 310 | the PROVISIONAL cap proposed for P6, 300 plus a reserve of 10 ([Q57](open-questions.md#q57--live-session-size-and-concurrency)) | ≤ 310 | about 60 KB |
| about 3,000 | an illustrative upper bound for storage estimates only; not a design target or capacity. A self-hosted LiveKit room lives on one node; about 3,000 per room is a published figure, unverified here, and must be benchmarked before any cap is raised | ≤ 3,000; three insert statements | about 0.6 MB |
| 10,000 | the defensive ceiling ([§5.4](#54-bounds)) | never stored: `unavailable` | — |

The estimate is about 110 B of heap plus about 90 B of primary-key index per
entry (ids are 36-character text). Growth is presses × room size. The
`connection` column could later become a smallint behind the same CHECK meaning,
with no contract change.

---

## 7. Persistence proposal

Proposal only: no schema or migration is written in this pass. The tables are
private to attendance and follow house style: text ids, plain cross-module id
columns with no foreign key (`persistence.md:26-28`), CHECKs that mirror the
domain, keyset indexes, and an in-memory twin when there is no `DATABASE_URL`.
The migration takes the next free number when P9 lands.

```
attendance_snapshots
  id                      text PRIMARY KEY
  community_id            text NOT NULL          -- plain id, no FK
  live_session_id         text NOT NULL          -- plain id, no FK
  host_user_id            text NOT NULL          -- plain id, no FK; Live's hostUserId at the press
  recorded_by             text NOT NULL          -- plain id, no FK
  client_request_id       text NOT NULL
  observation_rule        text NOT NULL
  observation_started_at  timestamptz NOT NULL
  observed_at             timestamptz NOT NULL
  recorded_at             timestamptz NOT NULL
  connected_count         integer NOT NULL
  connecting_count        integer NOT NULL
  CONSTRAINT attendance_snapshots_idempotency_unique UNIQUE (live_session_id, recorded_by, client_request_id)
  CHECK attendance_snapshots_client_request_id_shape  client_request_id ~ '^[A-Za-z0-9_-]{8,64}$'
  CHECK attendance_snapshots_observation_rule_valid   observation_rule IN ('provider_registry_v1')
  CHECK attendance_snapshots_counts_non_negative      connected_count >= 0 AND connecting_count >= 0
  CHECK attendance_snapshots_time_order               observed_at >= observation_started_at AND recorded_at >= observed_at
  INDEX attendance_snapshots_community_idx (community_id, observed_at, id)     -- community list, read backwards
  INDEX attendance_snapshots_session_idx   (live_session_id, observed_at, id)  -- the same list filtered by session

attendance_snapshot_entries
  snapshot_id  text NOT NULL REFERENCES attendance_snapshots (id) ON DELETE RESTRICT   -- in-module FK
  user_id      text NOT NULL                                                           -- plain id, no FK
  connection   text NOT NULL CHECK (connection IN ('CONNECTED', 'CONNECTING'))
  PRIMARY KEY (snapshot_id, user_id)
```

- The indexes are ascending on purpose; a backward scan serves newest first
  (`persistence.md:233`).
- **No `(user_id)` index** until a per-person view or erasure is decided
  ([Q69](open-questions.md#q69--who-records-and-who-views-snapshots),
  [Q71](open-questions.md#q71--correcting-retaining-and-erasing-snapshots)).
  **No institution-wide index** until oversight is decided
  ([Q43](open-questions.md#q43--institutional-oversight-of-communities)).
  Adding either later is additive.
- The `connection` filter is a range scan inside one snapshot, so it needs no
  index of its own.
- Communities' own P9 migration widens the capability CHECK of
  `communities_capability_grants` with the two acts ([§11.1](#111-the-two-acts));
  attendance does not touch Communities' tables.

**The write path**: one short transaction, **after** the observation returned.

1. `BEGIN`.
2. `INSERT` the header `… ON CONFLICT ON CONSTRAINT
   attendance_snapshots_idempotency_unique DO NOTHING RETURNING id`. The
   constraint is named, so a primary-key collision surfaces as a fault instead
   of being swallowed.
3. A row came back: insert the entries in multi-row statements of at most 1,000
   rows (3 parameters a row, 3,000 a statement, far below 65,535); `COMMIT` →
   `created`.
4. No row came back: `ROLLBACK`; read by key → `duplicate`, with the stored
   header.

No transaction and no lock is held across the provider call, so concurrent
presses cannot starve the connection pool. Different keys never conflict, and
there is no cross-row invariant, so nothing else needs a lock.

**Reads never touch Live or LiveKit.** The community list is a keyset range on
`community_idx` (or `session_idx` when filtered), limit clamped to 200
(`pagination.ts:13`). An entries page is a PK range `(snapshot_id, user_id >
cursor) LIMIT n+1`. Cursors are opaque base64url, as in academic
(`academic/application/cursors.ts:4-13`).

---

## 8. Idempotency: the double press

| Case | Result |
| --- | --- |
| **Retry with the same key** (a lost response, a network retry, any API instance) | The key lookup runs before the active check, the rate limit and the observation. It finds the snapshot → **200** with it. No observation, no rate-limit charge, no audit, no event. It works even after the session has ended |
| **Concurrent requests with the same key** (the request is resent before the first returns) | Both may observe. The UNIQUE constraint lets exactly one insert win; the other blocks on the uncommitted unique entry, sees the conflict, rolls back and returns the winner with **200**. Its own observation is discarded. One snapshot, one audit entry, one event ([S2](#s2-a-double-press)) |
| **Two presses with different keys** (a buggy client, or two recorders at once) | **Two snapshots**, each a true, complete, single observation with its own `observedAt`. Nothing is merged. Both are bounded by the per-recorder rate limit |
| **The same key from another recorder, or for another session** | An independent snapshot: the key is scoped by `(live_session_id, recorded_by)` |

- **The key.** `clientRequestId` is required and must match
  `^[A-Za-z0-9_-]{8,64}$`, the messaging precedent (`message.ts:50`). The app
  generates it once per press and reuses it on every retry of that press. A
  missing key is a 400 (ValidationPipe); a malformed one is 422
  `attendance.client_request_id_invalid` (domain validation, `http-failure.ts:17`).
- **The database decides**, not a prior read: the lookup only saves the
  observation on an ordinary retry. Correctness does not depend on the client;
  tidiness does (the app disables the button while a request is in flight).
- **Rejected:** a time window ("one snapshot per session per N seconds"), which
  is policy and silently merges intended presses; an in-process single flight,
  which is wrong across API instances; a per-session cap, which limits how often
  attendance may be taken (Q72); and a persisted OBSERVING → RECORDED | FAILED
  state machine with a sweeper, which guards a window this ordering never opens
  and stores failures as business rows.

---

## 9. The observation instant: someone leaving mid-press

The linearization point is **LiveKit's registry read that serves the single
listing**, inside `[observationStartedAt, observedAt]`. We add no retry, no
merge and no grace of our own; LiveKit's own lag is recorded as it is.

| Participant Z | Recorded as | Why (SRV) |
| --- | --- | --- |
| Z's provider session closed before the read | no entry (not in the registry at the read) | the registry entry is deleted on close (`pkg/service/roommanager.go:616`) |
| Z closes after the read | included | the listing already held Z |
| Z's transport failed moments before; LiveKit waits for a resume | included, in the state LiveKit last stored (usually `CONNECTED`) | the participant is closed only after `disconnectCleanupDuration`, 5 s (`pkg/rtc/participant.go:77`, `:2741-2754`); the store is updated asynchronously and not for disconnected participants (`pkg/service/roommanager.go:718-722`) |
| Z is rejoining (a new connection) | `CONNECTING` | the new participant is `JOINING` or `JOINED` (PGO `livekit/livekit_models.pb.go:939-945`) |
| The session ends during the read | nothing stored: **412** `attendance.session_not_live` | Live saves `ended` before `endRoom`, and its re-read sees it ([§5.3](#53-the-observation-bracket-and-the-re-check)) |
| The session ends after Live's re-read | the snapshot is stored | the observation preceded the end |

An account with no entry is not thereby absent; what absence means is
[Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot) and
[Q70](open-questions.md#q70--is-a-snapshot-the-attendance-record).

Whether a `CONNECTING` entry, or a participant inside LiveKit's resume window,
counts as present is [Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot).
The load test measures how often each happens.

---

## 10. Immutability and amendment

- **Immutable.** A snapshot is never amended, voided or deleted through the
  application. There is no mutator in the domain and no UPDATE or DELETE in the
  repository port, the adapter or the API. It is append-only by convention, like
  `audit_log` (`observability.md:90`), and a test asserts that the adapter
  exposes no such path.
- **A mistaken press stays recorded.** An observation that could be edited
  would stop being an observation. Correcting what the institution records
  belongs to a future attendance **record**, which carries `AttendanceAmendment
  {reason, amendedBy}` (`operations/contracts/index.ts:15-19`); who may amend, and
  whether a reason is mandatory, is
  [Q8](open-questions.md#q8--who-may-amend-attendance-and-is-a-reason-mandatory).
  PROVISIONAL, [Q71](open-questions.md#q71--correcting-retaining-and-erasing-snapshots).
- **Retention.** Kept like the audit log until
  [Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history)
  is answered. A future purge job deletes entries before headers, because of
  `RESTRICT`.
- **A person's own entries.** No per-person index, no own-entries view and no
  erasure path until Q71 and Q69 say otherwise.

---

## 11. Who records and who views

### 11.1 The two acts

Recording and viewing are **community acts**, asked of Communities for the one
community concerned. `community.attendance.record` and
`community.attendance.view` are reserved in Communities' proposed
`capabilities.ts` (a comment beside `COMMUNITY_CAPABILITIES`) and are added in
P9, with a CHECK migration, by Communities
([communities.md §6.3](communities.md#63-the-act-vocabulary)); neither exists
today. Both have three segments, so neither can pass identity's permission
shape CHECK (`identity/infrastructure/schema.ts:36`). Disjointness for all
acts, including the two-segment `community.view` and `community.lock`, rests on
the three guards of [communities.md §6.3](communities.md#63-the-act-vocabulary).

PROVISIONAL defaults ([Q69](open-questions.md#q69--who-records-and-who-views-snapshots)):

| Question | Default |
| --- | --- |
| Who may record? | The community's owner; the session's host while `community.live.host` holds; any moderator of that session ([live.md §7.2](live.md#72-liveaccess-host-and-moderators)); and a member holding an explicit `community.attendance.record` grant (P3). Brief §9/§13/§15 default; needs institutional confirmation (Q69) |
| Who may view? | The owner; the host or a recorder, for the snapshots of sessions they hosted or recorded in; and a member holding `community.attendance.view`. Brief §9/§13/§15 default; needs institutional confirmation (Q69) |
| Identity ceilings for the two acts | Chosen in P9 **without** any `attendance.*` permission, as a row of Communities' act table and its pinning test ([communities.md §6.4](communities.md#64-act-rules--provisional)) |
| Institutional oversight | None until [Q43](open-questions.md#q43--institutional-oversight-of-communities) says otherwise ([§11.2](#112-institutional-oversight-without-attendanceread)) |
| Does recording imply viewing? | For the sessions one recorded in, yes (brief §13: "teacher can view"); beyond them, only with `community.attendance.view`. The POST still answers with counts only. Brief §9/§13/§15 default; needs institutional confirmation (Q69) |
| Must the recorder be the host, or connected? | No. The owner, a moderator or a grantee records too, and nobody needs to be connected: a record basis and a live session are enough. Brief §9/§13/§15 default; needs institutional confirmation (Q69) |
| May a student or parent see their own entries? | No view exists |
| While the community is LOCKED | Attendance applies no lock rule of its own; Communities' answer governs ([Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock), [Q72](open-questions.md#q72--when-and-how-often-snapshots-are-taken)) |

These follow the brief: the teacher triggers attendance (§9), presses Record
and can view (§13), and is among those the record is available to (§15). An
alternative the institution may choose instead (Q69) is narrower: the owner or
an explicit grant only, with recording not implying viewing.

**Where each id comes from.** Recording takes `communityId` and `hostUserId`
from `LIVE_SESSIONS.describe`, Live's record, and stores both in the header. A
single snapshot takes them from the stored header. The community list
authorizes the path's `communityId` as the scope being asked about, and trusts
nothing else. The client never supplies
`recordedBy`, participants, or the community of a recording.

**At the edge**, every route is `@Authenticated()` only, because only the use
case can decide (the precedent at `conversations.controller.ts:336-342`). There
is no `@RequirePermission(attendance.*)`.

**System principals** never hold a stint, and none of the bases in
[§11.3](#113-attendanceaccess-how-refusals-map) admits oversight, so a system
principal is always refused. There is no
system-initiated snapshot (Q72).

### 11.2 Institutional oversight, without `attendance.read`

Brief §15 makes the record available to "the teacher who owns/teaches the
relevant group/session; owner; explicitly authorized management principals".
The teacher of the session is covered, PROVISIONALLY, by the host and recorder
bases of [§11.1](#111-the-two-acts). Which owner, the community's or the
institution's `OWNER` role, is Q69. The community's owner is covered,
PROVISIONALLY: ownership implies the view act
([Q42](open-questions.md#q42--community-ownership)). The
institution's `OWNER` and `ADMIN` get **no attendance view by role** in this
design: Q43's provisional reach for `communities.manage` never includes
attendance.

If oversight is wanted later, it is added **inside Communities' act table**, as
an oversight ceiling on `community.attendance.view`. That ceiling must **not**
be `attendance.read`. SUPERVISOR, TEACHER and ASSISTANT_TEACHER hold
`attendance.read` unscoped (`provisional-policy.ts:52`, `:71-72`, `:94`), and the
reconciliation's precondition is to scope those grants "through
`ACADEMIC_RELATIONSHIPS` (or leave them unexercised)"
(`academic-reconciliation.md:504`; `open-questions.md:824-826`). Exercising them
behind a Communities narrowing would be neither.

So `attendance.read` and `attendance.manage` stay reserved for operations'
`AttendanceRecord`, as `permissions.ts:9-10` says; this module never consults
them, and a grep test forbids the strings under `src/modules/attendance/`.

Rejected: a new `attendance.oversee` catalogue permission; coarse
`attendance.read` / `attendance.manage` edge checks on these routes; and
`attendance.*` as the acts' ceilings. Each exercises the unscoped namespace, or
lets the provisional role matrix silently decide delegation (a delegated
monitor who is a student could never record), and each puts community oversight
into one consumer module, so every future consumer would grow its own.

### 11.3 `AttendanceAccess`: how refusals map

`AttendanceAccess` wraps `COMMUNITY_AUTHORIZATION.authorize(principal,
communityId, act)` and maps its answer, as `ConversationAccess` and Live's
`LiveAccess` do ([communities.md §6.12](communities.md#612-how-live-messaging-and-attendance-ask)).
Views re-check on every request; nothing is cached.

It asks for the bases of [§11.1](#111-the-two-acts) in a fixed order. It moves
to the next act only on a `forbidden` answer, and stops at a permit,
`not_found`, `precondition_failed` or a rejected promise:

- **Record:** `community.attendance.record`; then `community.live.moderate`;
  then, if the principal is the session's `hostUserId`, `community.live.host`.
  The last two are Live's own moderator bases
  ([live.md §7.2](live.md#72-liveaccess-host-and-moderators)), asked of
  Communities, never of Live.
- **One snapshot, or its participants:** `community.attendance.view`; then, if
  the principal is the header's `hostUserId` or recorded a snapshot of the same
  session (a prefix read on the idempotency index), `community.view` with the
  membership basis, so a former member sees nothing.
- **The community list:** `community.attendance.view`; without it, only with a
  `liveSessionId` the caller hosted or recorded in, checked as for one snapshot.

The permit that wins, its act included, goes into the audit metadata. If none
permits, the table below maps the answer to the attendance act.

| Communities' answer | Record (POST) | Community list | One snapshot, or its participants |
| --- | --- | --- | --- |
| a permit | continue; the permit (basis, stint, grant, ceiling) is copied into the audit metadata | continue | continue |
| `not_found` `communities.community_not_found` (unknown, or no ACTIVE stint) | 404 `attendance.session_not_found`, the same body as an unknown session | 404 `attendance.community_not_found` | 404 `attendance.snapshot_not_found` |
| `forbidden` `identity.permission_denied` (no ceiling on any path) | 404 `attendance.session_not_found` | 404 `attendance.community_not_found` | 404 `attendance.snapshot_not_found` |
| `forbidden` `communities.capability_required` (a member, and no act in the fallback order permits) | 403 `attendance.not_allowed` | 403 `attendance.not_allowed` | 404 `attendance.snapshot_not_found` |
| `precondition_failed` `communities.community_locked` (only if the act table refuses while LOCKED, Q46) | 412 `attendance.community_not_open` | 412 `attendance.community_not_open` | 412 `attendance.community_not_open` |
| the promise rejects (store unavailable) | 503 `unavailable`: fail closed, never a role-only answer | 503 | 503 |

`identity.permission_denied` maps to 404 on the POST because the session has
already been looked up: a 403 would tell a caller with no standing that the id
exists. Only a member learns that a session exists in their own community.

---

## 12. No threshold, duration or percentage

Brief §14: "present" means exactly what product policy says, and nothing may
silently define minutes, join duration, percentage, a late or a leave
threshold. This design computes none of them.

| Not computed or stored | Why | Where it would be decided |
| --- | --- | --- |
| A "present" label | Policy | [Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot) |
| Absent, absentees | It would need the expected roster at time T (up to 30,000+ members) and a definition of "expected" | [Q70](open-questions.md#q70--is-a-snapshot-the-attendance-record) |
| Late or left-early thresholds, minutes, durations | No join or leave history is kept; `joinedAt` is not passed across the contract (it resets on reconnect and would invite lateness rules) | Q70, and whoever owns the record |
| A ratio or percentage | The app never derives one; `Halaqa.attendedSessions`, `Halaqa.attendanceRatio` and `ProgressSummary.attendanceRatio` stay unfilled by snapshots (`learning.dart:90`, `:106-107`; `progress.dart:25`), keeping the promise at `academic_learning_repository.dart:16-18` | Q70 |
| Roles, speaking, muted or idle state | Not required by the brief; Live's record and the SFU can disagree ([Q5](open-questions.md#q5--what-happens-when-the-media-provider-and-our-record-disagree)) | Q68, if ever needed |
| Combining several snapshots of one session | Every press stands alone | Q70 |

A future rule is either a new observation rule id ([§5.2](#52-what-counts-as-observed-provider_registry_v1))
or a derivation owned by another module; it never edits a stored snapshot.

---

## 13. Snapshots and operations' `AttendanceRecord`

A snapshot is an **observation**, not the institution's attendance record.
Operations' `AttendanceRecord` (contract only, on hold) would own
`AttendanceState` `present | absent | late | excused` and its amendments
(`operations/contracts/index.ts:7-19`). PROVISIONAL,
[Q70](open-questions.md#q70--is-a-snapshot-the-attendance-record):

- **A snapshot never silently becomes present or absent.** No code maps
  `CONNECTED` to `'present'`. Attendance never imports `operations/contracts`,
  and a test enforces it.
- **If Q70 decides that snapshots feed the record**, operations depends on
  `attendance/contracts` (a snapshot reader, or the event), never the reverse.
  The derivation is operations' rule, and it must answer Q70 first: how several
  snapshots combine, which states result, what happens for communities that
  correspond to halaqat ([Q50](open-questions.md#q50--communities-and-the-academic-structure),
  Q36), and how it rolls up by calendar
  ([Q12](open-questions.md#q12--timezone-and-academic-calendar)).
- **Snapshots carry no halaqa id.** A community has no halaqa link in v1 (Q50).

This is why snapshots can be argued to sit outside §13's attendance
preconditions (Q40(b)). **The user decides that, not this document.**

| §13 precondition for Attendance (`academic-reconciliation.md:504`) | This design |
| --- | --- |
| Scope `attendance.*` through `ACADEMIC_RELATIONSHIPS` | `attendance.*` is never exercised; scoping is community standing instead (Q69) |
| Q8 (amendment) | No amendment: snapshots are immutable |
| Q12 (calendar) | No calendar, schedule or roll-up |
| Do not take the states from TE-04 | No `AttendanceState` and no TE-04 states: only `CONNECTED \| CONNECTING` |

---

## 14. Event, audit and owner delivery

**The event.** One, declared in `attendance/contracts/events.ts` (ADR 0021):

```ts
export const AttendanceEvents = { snapshotRecorded: 'attendance.snapshot.recorded' } as const;
export interface AttendanceSnapshotRecordedPayload {
  readonly snapshotId: string;
  readonly communityId: string;
  readonly liveSessionId: string;
  readonly recordedBy: string;
  /** ISO 8601, like notifications/contracts/events.ts:45-46. */
  readonly observedAt: string;
  readonly connectedCount: number;
  readonly connectingCount: number;
}
export type AttendanceSnapshotRecorded =
  DomainEvent<typeof AttendanceEvents.snapshotRecorded, AttendanceSnapshotRecordedPayload>;   // aggregateId = liveSessionId
export const SNAPSHOT_CONNECTIONS = ['CONNECTED', 'CONNECTING'] as const;
```

| Property | Value |
| --- | --- |
| Payload | Ids, one timestamp and two counts. **Never** participant ids, names, tokens or provider identities |
| `aggregateId` | `liveSessionId`, so one session's snapshots form one ordered stream for subscribers that chain per aggregate |
| `occurredAt` | `recordedAt`; `correlationId` from the call metadata |
| Published | Once per **created** snapshot, after commit and after the audit entry (`AttendanceJournal`, the order of `academic-journal.ts:11-39`). Never for a replay, a lost same-key race or a failure |
| Durability | Class R: loss is tolerable, because the table is the truth. In-process only, not durable (ADR 0006); consumers must read the table and tolerate duplicates |
| Consumers | **None built.** Candidates, each a separate decision reading `attendance/contracts` only: a notifications translator ([Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts)), reporting, operations (Q70). Live, communities and messaging never subscribe |
| Channel | No realtime frame |

**Attendance subscribes to nothing in v1.** A snapshot is taken on a press, and
correctness at the end of a session comes from Live's re-check, not from
`live.session.ended`. `LiveEvents` lists attendance as an optional consumer of
that event, for a later need; none is built.

**The audit entry.** Only created snapshots are audited (brief §26): action
`attendance.snapshot.recorded`, resource type `attendance.snapshot`, resource id
the snapshot id, actor the recorder, metadata `{communityId, liveSessionId,
connectedCount, connectingCount, observationRule, authority: {act, basis,
membershipId, grantId, ceiling}}`, the permit copied as ADR 0017 requires. No
participant id is audited. Failures are logged with ids and codes, and metered;
they are not audited. Views are not audited in v1; if oversight is ever added
(Q43), oversight-basis views are audited like Communities' own oversight reads.

**Owner delivery** (brief §15) is **not implemented**. The path is fixed so a
translator can be added later without changing any publisher:

```
 attendance.snapshot.recorded (ids, counts)
   └─▶ notifications translator (P10, only after Q67 and Q28)
         ├─ recipients at delivery time: COMMUNITY_CAPABILITY_HOLDERS.list(communityId, 'community.attendance.view'), a page at a time
         ├─ stores one notification per recipient; the existing relay and push deliver it
         └─ opening it runs attendance's own view check: a notification never grants access
```

Which facts deserve a notification and how loudly (every snapshot, a summary,
or exceptions only) is Q67, with
[Q28](open-questions.md#q28--what-deserves-a-notification-and-how-loudly) and
[Q24](open-questions.md#q24--notifications-push-provider-lock-screen-previews-quiet-hours-mute).
If delivery must be guaranteed, the transactional outbox comes first
(trigger T2, ADR 0021). PROVISIONAL
([Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts)):
participants in the room are not told that a snapshot was taken.

---

## 15. API under `/attendance`

Routes are prefixed by the module that owns them, like every controller in the
codebase; the brief's candidate `…/groups/:id/live/sessions/:sessionId/attendance`
would put attendance in Communities' URL space and make the client supply a
community id the server must then distrust. The hub's
[§15.5](communities-live-attendance.md#155-attendance-p9-held) lists the same
routes.

### 15.1 Routes

| Route | Declared | Use-case authorization | Success |
| --- | --- | --- | --- |
| `POST /attendance/live-sessions/:liveSessionId/snapshots` body `{clientRequestId}` | `@Authenticated()` | `LIVE_SESSIONS.describe` → the record bases of [§11.3](#113-attendanceaccess-how-refusals-map) on its `communityId`; `recordedBy` = the principal | **201** `SnapshotView` (counts only); **200** the stored snapshot for a replayed key |
| `GET /attendance/communities/:communityId/snapshots?liveSessionId&cursor&limit` | `@Authenticated()` | `community.attendance.view` on the path's community; without it, only a `liveSessionId` the caller hosted or recorded in (§11.3) | 200 `{items: SnapshotView[], nextCursor}`, newest first, limit ≤ 200. A `liveSessionId` of another community yields an empty page. Never calls Live |
| `GET /attendance/snapshots/:snapshotId` | `@Authenticated()` | load the header, then the view bases of §11.3 on its `communityId` | 200 `SnapshotView` |
| `GET /attendance/snapshots/:snapshotId/participants?connection&cursor&limit` | `@Authenticated()` | as above | 200 `{items: [{userId, displayName \| null, connection}], nextCursor}`, keyset on `user_id`, limit ≤ 200, one `ACCOUNT_DIRECTORY.describe` per page |

### 15.2 Refusal codes

| Code | Kind → HTTP | When |
| --- | --- | --- |
| (ValidationPipe) | 400 | a missing `clientRequestId`, or any other body field: `participants`, `communityId`, `recordedBy` (`configure-app.ts:17-18`) |
| `attendance.client_request_id_invalid` | validation → 422 | the key does not match `^[A-Za-z0-9_-]{8,64}$` |
| `attendance.cursor_invalid` | validation → 422 | a cursor that does not decode |
| `attendance.session_not_found` | not_found → 404 | POST: an unknown session, or a caller with no standing in its community (identical bodies) |
| `attendance.community_not_found` | not_found → 404 | list: an unknown community, or one the caller has no standing in |
| `attendance.snapshot_not_found` | not_found → 404 | one snapshot: unknown, invisible or not permitted, all identical |
| `attendance.not_allowed` | forbidden → 403 | a member whom no basis in the fallback order of [§11.3](#113-attendanceaccess-how-refusals-map) permits |
| `attendance.session_not_live` | precondition_failed → 412 | POST: the session is not live, or ended during the observation. Nothing stored |
| `attendance.community_not_open` | precondition_failed → 412 | Communities' lifecycle gate refused the act (only if its table says so, Q46) |
| `attendance.too_many_snapshots` | rate_limited → 429, `retryAfterSeconds` | the PROVISIONAL per-recorder limit (Q72) |
| `attendance.observation_unavailable` | unavailable → 503 | POST: provider error, deadline or oversize. Nothing stored; retrying with the same key is safe |
| `unavailable` | unavailable → 503 | the Communities store or the directory could not be read |

Three codes follow the code rather than the obvious guess: a session that is not live is
412, not 409 (`precondition_failed` maps to 412, `http-failure.ts:18`, as Live's
own `live.session_not_live` does, `join-live-session.use-case.ts:68-75`); a
malformed key is 422, not 400 (domain validation, `http-failure.ts:17`); and 503
needs the new `'unavailable'` kind (P0).

### 15.3 Views

```ts
SnapshotView = {
  id, communityId, liveSessionId,
  recordedBy: { userId, displayName },          // resolved at read time
  observationStartedAt, observedAt, recordedAt, // ISO 8601
  observationRule,                              // 'provider_registry_v1'
  connectedCount, connectingCount,
}                                               // no participant list: entries are paged through /participants

SnapshotParticipant = { userId, displayName: string | null, connection: 'CONNECTED' | 'CONNECTING' }
                                                // no "present" or state field; no email, ever
```

---

## 16. Realtime: nothing new

- **The app WebSocket carries nothing new.** Recording is request and response
  over HTTP; the presser's app shows the in-flight state and gets the result
  synchronously. Viewers fetch over HTTP. No frame, relay or protocol v1 change
  is needed (hub [§16](communities-live-attendance.md#16-realtime-transport-matrix)).
- **LiveKit carries nothing new.** The only LiveKit traffic attendance causes is
  one server-to-server `ListParticipants` call per press, from Live's single
  adapter. The server requires admin permission for it (SRV
  `pkg/service/roomservice.go:174-176`). It is not on the media plane, and never
  on the data channel: attendance is never triggered or announced through data
  messages, which listeners can publish today (`rtc-provider.ts:19-23`) and
  nobody can from P1.
- **No webhook** is used, and the client never sends its LiveKit roster.

---

## 17. Flutter: `AttendanceRepository` (P9 only)

Nothing is added to the app before P9. Then one repository, justified because
attendance is a separate backend owner with its own HTTP surface:

```dart
abstract interface class AttendanceRepository {
  Future<SnapshotView> record(String liveSessionId, {required String clientRequestId});
  Future<SnapshotPage> snapshots(String communityId, {String? liveSessionId, String? cursor});
  Future<SnapshotView> snapshot(String snapshotId);
  Future<SnapshotParticipantPage> participants(String snapshotId,
      {SnapshotConnection? connection, String? cursor});
}
enum SnapshotConnection { connected, connecting, unknown }   // unknown wire values map to unknown
```

- `HttpAttendanceRepository` and `MockAttendanceRepository`, bound only in
  `lib/providers/app_providers.dart`, like every repository today. Mock data
  carries `DataOrigin.mock` and reproduces the idempotency rule; it is never
  presented as real.
- **The key** is generated once per press in the controller (state) layer and
  reused on every retry of that press; the button is disabled while a request
  is in flight.
- **The Record button** is shown only when the server says so:
  `CommunityView.me.capabilities` contains `attendanceRecord` (the
  `CommunityCapability` enum gains `attendanceRecord` and `attendanceView` in
  P9) or the live session's `me.canModerate` is true (the host and moderators,
  [§11.1](#111-the-two-acts)), **and** `LiveRepository.currentSession(communityId)`
  is live. Live's view
  carries no attendance flag: Live does not know attendance. The screen never
  reads roles or `CurrentUser.permissions`.
- **Copy** says "connected" and "connecting" (in the app's language), never a
  word meaning present or absent. No screen turns a snapshot into a ratio, and
  snapshot data never fills `Halaqa.attendedSessions`, `Halaqa.attendanceRatio`
  or `ProgressSummary.attendanceRatio`.
- Screens import no `http`, `api_client`, repository implementation or LiveKit
  package (the hub's [§17](communities-live-attendance.md#17-flutter-architecture)
  guards).

---

## 18. Sequences

Participants are columns; messages are numbered. The hub's
[A4](communities-live-attendance.md#a4-record-an-attendance-snapshot-held)
shows the same flow across modules; these show the use case's inside.

### S1. Record a snapshot

`S` is the live session, `C` its community, `K` the client key.

```
 Teacher app       Attendance          Live                Communities       LiveKit           Postgres          Audit log
                   use case            (contracts)         (authorize)       (via Live)        (attendance)      + event bus
  │                 │                   │                 │                 │                 │                 │
  │ 1 POST /attendance/live-sessions/S/snapshots {clientRequestId: K}       │                 │                 │
  │────────────────▶│                   │                 │                 │                 │                 │
  │                 │ 2 K matches ^[A-Za-z0-9_-]{8,64}$, else 422 attendance.client_request_id_invalid          │
  │                 │ 3 LIVE_SESSIONS.describe(S)         │                 │                 │                 │
  │                 │──────────────────▶│                 │                 │                 │                 │
  │                 │ 4 {S, communityId: C, hostUserId: H, active: true}   (null → 404 attendance.session_not_found)
  │                 │◀──────────────────│                 │                 │                 │                 │
  │                 │ 5 authorize(principal, C, act): record bases, §11.3   │                 │                 │
  │                 │────────────────────────────────────▶│                 │                 │                 │
  │                 │ 6 permit {act, basis, membershipId, grantId, ceiling}   (refusals mapped: §11.3)          │
  │                 │◀────────────────────────────────────│                 │                 │                 │
  │                 │ 7 findByKey(S, principal.userId, K) → none   (found → 200 with the stored snapshot; stop) │
  │                 │────────────────────────────────────────────────────────────────────────▶│                 │
  │                 │ 8 active? else 412 attendance.session_not_live · consume attendance.snapshot.user, else 429
  │                 │ 9 LIVE_PRESENCE.observe(S)          │                 │                 │                 │
  │                 │──────────────────▶│                 │                 │                 │                 │
  │                 │                   │ 10 record live? · slot (≤ 4 per process) · observationStartedAt := clock
  │                 │                   │ 11 listParticipants(room): ONE unpaginated read, 15 s deadline        │
  │                 │                   │──────────────────────────────────▶│                 │                 │
  │                 │                   │ 12 the whole registry: JOINING/JOINED/ACTIVE, kinds, identities, hidden flag
  │                 │                   │◀──────────────────────────────────│                 │                 │
  │                 │                   │ 13 observedAt := clock · provider_registry_v1 · re-read record: still live
  │                 │ 14 observed {C, observationStartedAt, observedAt, participants[]}       │                 │
  │                 │◀──────────────────│                 │                 │                 │                 │
  │                 │ 15 observation.communityId = C, else fault 500 and nothing stored · takeSnapshot(...)     │
  │                 │ 16 BEGIN · INSERT header ON CONFLICT (idempotency) DO NOTHING RETURNING id                │
  │                 │────────────────────────────────────────────────────────────────────────▶│                 │
  │                 │    entries in statements of ≤ 1,000 rows · COMMIT → created             │                 │
  │                 │ 17 audit attendance.snapshot.recorded, then publish {ids, observedAt, counts}             │
  │                 │──────────────────────────────────────────────────────────────────────────────────────────▶│
  │ 18 201 SnapshotView (counts only)   │                 │                 │                 │                 │
  │◀────────────────│                   │                 │                 │                 │                 │
```

### S2. A double press

`T` is the teacher (recorder); `X` the stored snapshot.

```
 Teacher app         Request R1            Request R2            Live                  Postgres
                     (use case)            (use case)            (LIVE_PRESENCE)       (attendance)
  │                   │                     │                     │                     │
  │ A. Retry after a lost response (sequential, same key K, any API instance)           │
  │ 1 POST .../S/snapshots {K}              │                     │                     │
  │──────────────────▶│                     │                     │                     │
  │                   │ 2 S1 steps 2–17: observed, stored as X, audited, published      │
  │ 3 201 X   ✗ the response is lost (network)                    │                     │
  │◀──────────────────│                     │                     │                     │
  │ 4 POST .../S/snapshots {K}   (the app reuses K on retry)      │                     │
  │────────────────────────────────────────▶│                     │                     │
  │                   │                     │ 5 describe(S) and authorize(record), as S1 steps 3–6
  │                   │                     │ 6 findByKey(S, T, K) → X                  │
  │                   │                     │──────────────────────────────────────────▶│
  │ 7 200 X: no observation, no rate-limit charge, no audit, no event                   │
  │◀────────────────────────────────────────│                     │                     │
  │                   │                     │                     │                     │
  │ B. Concurrent, same key K (the request is resent before the first returns)          │
  │ 8 POST {K}        │                     │                     │                     │
  │──────────────────▶│                     │                     │                     │
  │ 9 POST {K}        │                     │                     │                     │
  │────────────────────────────────────────▶│                     │                     │
  │                   │ 10 both pass S1 steps 2–15; both find no key at step 7          │
  │                   │ 11 observe(S)       │                     │                     │
  │                   │──────────────────────────────────────────▶│                     │
  │                   │                     │ 12 observe(S)   (two provider reads)      │
  │                   │                     │────────────────────▶│                     │
  │                   │ 13 BEGIN · INSERT header … RETURNING → X · entries (uncommitted)│
  │                   │────────────────────────────────────────────────────────────────▶│
  │                   │                     │ 14 BEGIN · INSERT header … waits on R1's uncommitted unique entry
  │                   │                     │──────────────────────────────────────────▶│
  │                   │ 15 COMMIT           │                     │                     │
  │                   │────────────────────────────────────────────────────────────────▶│
  │                   │                     │ 16 conflict: no row · ROLLBACK · SELECT by key → X
  │                   │                     │◀──────────────────────────────────────────│
  │                   │ 17 audit, then event, once                │                     │
  │ 18 201 X          │                     │                     │                     │
  │◀──────────────────│                     │                     │                     │
  │ 19 200 X   (its observation is discarded; nothing audited or published)             │
  │◀────────────────────────────────────────│                     │                     │
```

Two presses with **different** keys run S1 twice: two snapshots, two audit
entries, two events, each with its own `observedAt`, both counted by the
per-recorder limit.

### S3. LiveKit unavailable

```
 Teacher app         Attendance            Live                  LiveKit               Postgres
                     use case              (LIVE_PRESENCE)       (RoomService)         (attendance)
  │                   │                     │                     │                     │
  │ 1 POST /attendance/live-sessions/S/snapshots {K}              │                     │
  │──────────────────▶│                     │                     │                     │
  │                   │ 2 S1 steps 2–8 pass: key shape, describe, authorize, no stored key, active, rate limit
  │                   │ 3 LIVE_PRESENCE.observe(S)                │                     │
  │                   │────────────────────▶│                     │                     │
  │                   │                     │ 4 record live · observationStartedAt := clock
  │                   │                     │ 5 listParticipants(room)                  │
  │                   │                     │────────────────────▶│                     │
  │                   │                     │                     │ 6 ✗ refused, 5xx, or no answer inside the 15 s deadline
  │                   │                     │ 7 RtcUnavailableError or deadline → logged and metered (no identities)
  │                   │ 8 {kind: 'unavailable'}   (no provider detail crosses the contract)
  │                   │◀────────────────────│                     │                     │
  │ 9 503 attendance.observation_unavailable: nothing stored, audited or published      │
  │◀──────────────────│                     │                     │                     │
  │ 10 the button is enabled again; K is kept for a retry         │                     │
  │ 11 POST {K}   (retried later)           │                     │                     │
  │──────────────────▶│                     │                     │                     │
  │                   │ 12 findByKey(S, T, K) → none: nothing was stored                │
  │                   │────────────────────────────────────────────────────────────────▶│
  │                   │ 13 continues as S1 from step 8: a NEW observation at a new instant
```

The failed press still counts against the per-recorder limit (it was charged at
step 8 of S1). There is deliberately no fallback to webhooks, app sockets or
token issuance: each is a weaker, different observation.

---

## 19. Failure modes

| Case | Semantics |
| --- | --- |
| **LiveKit unavailable, slow or erroring** | Live's deadline (15 s, PROVISIONAL) bounds the call; any error or timeout is `unavailable` → **503** `attendance.observation_unavailable`. Nothing stored, audited or published. A retry with the same key is safe and takes a new observation at a new instant ([S3](#s3-livekit-unavailable)) |
| **The session ended before the press** | 412 `attendance.session_not_live`, before any provider call or rate-limit charge. A token that auto-creates a room after the end is never observed: `observe` requires Live's record to be live (and P6 pins `room.auto_create=false`) |
| **The session ends during the observation** | Live re-reads its record after the listing: not live → `not_active` → **412**, nothing stored. Requires `ended` saved before `endRoom` ([live.md §4.2](live.md#42-end--idempotent-one-transaction-one-event)) |
| **The session ends after Live's re-read** | The snapshot is stored: the observation came first |
| **Duplicate press, same key** | 200 with the stored snapshot; no second observation, audit or event. Concurrent same key: the UNIQUE constraint decides; every response carries one id ([§8](#8-idempotency-the-double-press)) |
| **Duplicate press, different keys** | Two true snapshots, bounded by the per-recorder limit. Nothing merged, nothing partial |
| **A participant leaves during the observation** | Decided by LiveKit's registry read inside the bracket: closed before → no entry; after → included ([§9](#9-the-observation-instant-someone-leaving-mid-press)) |
| **A participant's network dropped moments before** | Inside LiveKit's 5 s resume window the participant may be recorded `CONNECTED`: the provider's semantics, recorded as is and measured, not corrected by policy (Q68) |
| **Joining or reconnecting during a join storm** | A resumed session stays ACTIVE → `CONNECTED`; a full rejoin is `JOINING`/`JOINED` → `CONNECTING` |
| **The provider has no room while Live's record says live** | The store answers an empty list (SRV `pkg/service/localstore.go:177-181`; `redisstore.go:337-338`), so the snapshot has zero entries: recorded truthfully. With psrpc listing enabled (`roomservice.go:178-179`) the behaviour is unverified; the adapter contract suite pins it, and any error is `unavailable` |
| **The recorder lost their media connection, or their device crashed** | Recording needs a record basis ([§11.1](#111-the-two-acts)) and a live session, not the recorder's presence in the room. A client crash mid-request does not matter: the server completes, and a same-key retry returns the result |
| **Backend restart mid-request** | Before commit: nothing exists; a same-key retry observes again. After commit, before the response: the retry returns the stored snapshot. After commit, before the audit or the event: the snapshot exists without them, the existing audit-after-change risk with no outbox (ADR 0006); the row keeps `recorded_by` and `recorded_at`, and consumers read the table |
| **Database unavailable** | The key lookup fails first, before any provider call → 500. A failure during the insert rolls the one transaction back; a header is never visible without its entries |
| **Communities store unavailable** | `authorize` rejects → 503 `unavailable`, fail closed, never a role-only answer |
| **Capability revoked, or community locked, mid-request** | Evaluated once, at request start. An in-flight observation completes and is stored; the permit it relied on is in the audit |
| **A removed member, or a holder of a still-valid LiveKit token, is connected at the press** | Recorded as observed, which is true. Ejection is Live's job: the open-source server refreshes connected participants' tokens, so Live's reconciler is the backstop, within 60 s ([Q63](open-questions.md#q63--losing-standing-during-a-running-session)). Attendance does not filter by membership, which would copy Communities' fact |
| **Ghost registry entries after a LiveKit node crash** | Unverified. One read cannot detect them. A chaos test before go-live measures it |
| **Egress, agent, SIP or unmappable identities in the listing** | Dropped by Live and metered; never entries. Dial-in mapped to accounts would be a new rule id |
| **The same account on two devices** | LiveKit evicts the earlier connection (`DUPLICATE_IDENTITY`); the PK keeps one entry either way ([Q60](open-questions.md#q60--one-account-on-several-devices-in-a-session)) |
| **A very large room, or many presses at once** | Live's concurrency limit queues listings within the deadline; those that time out, and any answer above 10,000 entries, are 503 |
| **The observation's community differs from the authorized one** | Impossible under Live's invariant that a session belongs to one community; if it happens, a fault (500) is logged and nothing stored |
| **An event subscriber fails** | The in-process bus isolates handler errors (ADR 0006 `0006-event-architecture.md:35-39`); the snapshot stays. No subscriber exists in v1 |

---

## 20. Security

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| **Attendance spoofing**: a member marks themself present | Entries come only from the server-side provider read through Live. No route writes entries, and nothing is updated after creation | Connected is not listening: the system records connections, not engagement (Q68) |
| **A forged participant identity** | LiveKit identities come only from JWTs signed with the server-held secret, and Live mints identity = account id (`join-live-session.use-case.ts:98`). Placeholder secrets are refused in production (`app-config.ts:75-83`, `:140-146`, `:194`), so the fake provider, selected only by the placeholder (`live.module.ts:47-49`), cannot run there. Non-standard kinds and non-account identities are dropped. Display names are never stored or trusted | A leaked LiveKit API secret allows any identity: an infrastructure compromise, outside attendance |
| **A client-supplied list** | The body carries only `clientRequestId`; the ValidationPipe rejects `participants`, `communityId` or `recordedBy` with 400 (`configure-app.ts:17-18`) | None |
| Spoofing the recorder or the community | `recordedBy` = the principal. The community comes from Live's record and must equal the observation's. Reads take it from the stored header | Only the correctness of Live's session-to-community record |
| Escalation through the unscoped `attendance.read` | Never consulted; a grep test. Every action asks `COMMUNITY_AUTHORIZATION` for that community, and views re-check every request | The correctness of Communities' act rules (Q69, Q43) |
| Probing session, community or snapshot ids | Random UUIDs; identical 404 bodies ([§11.3](#113-attendanceaccess-how-refusals-map)); an unauthorized caller never reaches LiveKit | A member with no basis learns a session exists in their own community (403). Timing is not addressed, as in existing modules |
| Denial of service by spamming the button | The per-recorder limit, charged after authorization, the key lookup and the active check; Live's concurrency limit, deadline and ceiling. A replay costs one indexed read | The in-memory limiter multiplies by the number of instances (`rate-limit.ts:1-9`); acceptable with one instance until P11 |
| Replaying a key to read someone else's snapshot | The key is scoped by recorder, and a replay passes the record check first | None |
| Presence data about minors leaking | The event, audit and logs carry ids, a timestamp and counts, never the list. Lists go only to those with a view basis ([§11.3](#113-attendanceaccess-how-refusals-map)), paged, names per page, no emails. The POST returns counts only. The app never labels anyone present | Who may see presence at all is policy (Q69; the Q22/Q25 reasoning); retention is Q3/Q71 |
| Tampering after the fact | Immutable; creation audited, so `audit_log` is a cross-check | A database superuser can still edit rows |
| Another module surveilling presence through `LIVE_PRESENCE` | The importer allow-list test | Code review of the allow-list |
| LiveKit admin credentials exposed by the new call | The per-call `roomAdmin` token is minted inside the one adapter (SDK `src/RoomServiceClient.ts:207`). The app never receives admin tokens or provider details, and join tokens never carry `roomAdmin` | As for the existing adapter |

---

## 21. Scale

The hub's [§20](communities-live-attendance.md#20-scaling-model) separates the
four scales; this is the attendance row in detail.

- **Membership scale is never touched.** A snapshot's cost is independent of
  community size.
- **Per press:** one read of Live's record, one `authorize` (one statement), one
  key lookup, one rate-limit call; then one unpaginated `ListParticipants`,
  O(P) in room size P. Each `ParticipantInfo` carries permission and track data,
  so the payload is estimated at 1–5 MB of JSON at 3,000 (unmeasured). It is
  parsed once and reduced at once.
- **Writes:** one transaction, 1 + ⌈P/1000⌉ statements (3 at P = 3,000). No
  lock or transaction spans the provider call. Different sessions never
  contend; only same-key races meet, on one unique index entry.
- **Reads:** keyset pages of at most 200, one directory call per page, no N+1,
  no OFFSET, never Live or LiveKit.
- **Several API instances:** idempotency lives in Postgres, so every snapshot
  stays correct; the rate limiter is per process until P11.
- **Distributed or future LiveKit:** with Redis-backed LiveKit the listing is
  served from the shared participant hash (SRV `pkg/service/redisstore.go:334-352`),
  or routed to the room's node with psrpc listing. If a large-event path ever
  spreads one session over several rooms or a broadcast audience (Q58), Live's
  observer answers from that path under a new rule id; attendance and
  Communities do not change.

**Load measurements before production use** (hub [§21](communities-live-attendance.md#21-load-testing-plan)):
`ListParticipants` latency and payload at 300, 1,000 and 3,000 simulated
participants; the `CONNECTING` share during and just after a join storm; 20–50
simultaneous presses across rooms on the target VPS (provider latency, event
loop, insert time, effect on media quality); a 3,000-row insert; a LiveKit node
crash followed by a press (ghost entries). The results calibrate the §5.4
bounds. None is assumed.

---

## 22. Module layout and tests

```
attendance/
  contracts/      events.ts (AttendanceEvents, payload), vocabulary.ts (SNAPSHOT_CONNECTIONS), index.ts
  domain/         snapshot.ts (AttendanceSnapshot, takeSnapshot), ports.ts (AttendanceSnapshotRepository)
  application/    record-attendance-snapshot.use-case.ts, list-community-snapshots.use-case.ts,
                  get-attendance-snapshot.use-case.ts, list-snapshot-entries.use-case.ts,
                  attendance-access.ts, attendance-journal.ts, attendance-policy.ts (the RateLimitPolicy),
                  views.ts, cursors.ts
  infrastructure/ schema.ts, drizzle-attendance-repository.ts, in-memory-attendance-repository.ts
  api/            attendance.controller.ts, dto/
  attendance.module.ts   imports [IdentityModule, CommunitiesModule, LiveModule]; exports nothing
```

One use case per act and no `AttendanceService`. The repository port is
`findByKey`, `insert` (→ `created` | `duplicate`), `findById`,
`listByCommunity`, `entries`; it has no update or delete.

| Level | What is tested |
| --- | --- |
| Domain (pure) | `takeSnapshot`: one entry per account, connected wins; counts equal entries; zero entries valid; time order; a malformed key → `attendance.client_request_id_invalid`; no mutator exported; the vocabulary has no present, absent, late or excused |
| Live's side (in [live.md §22](live.md#22-tests)) | `normalizePresence` keeps STANDARD, account-shaped, not-disconnected entries, **keeps hidden**, maps states, collapses per account, sorts; `LivePresenceService` refuses unknown and ended sessions without calling the provider, returns `not_active` when the fake flips the session to ended mid-listing, `unavailable` on error, deadline and oversize, caps concurrency; `describe` never calls the provider |
| Use case, with fakes | unknown session → 404 and `observe` not called; no standing → the same 404 body; a member with none of the record bases → 403, no `observe`, no rate-limit charge; a moderator and the session's host record without the grant, and the permit's act is audited; a host or recorder without `community.attendance.view` sees only their sessions' snapshots, and nothing once no longer a member; not live → 412 before any provider call or charge; limit → 429 with `retryAfterSeconds`; `unavailable` → 503 with nothing stored, audited or published; `not_active` → 412, nothing stored; community mismatch → fault, nothing stored |
| Idempotency | same key twice → one snapshot, 200 the second time, `observe` once, one audit, one event; a replay after the session ended → 200; different keys → two; the same key from another recorder or for another session → independent |
| Participant churn | a fake provider whose roster changes between `describe` and the listing → the snapshot equals exactly the list returned; a joining user → `CONNECTING` |
| Audit and event | audit, then event, after commit, once per created snapshot; none for replays, lost races or failures; payload keys exactly `{snapshotId, communityId, liveSessionId, recordedBy, observedAt, connectedCount, connectingCount}`; `aggregateId = liveSessionId`; no participant id, name or provider identity in the event, audit metadata or log lines |
| Postgres (`describeWithPostgres`) | **20 concurrent same-key presses → one header, one set of entries, one audit entry, one id in every response**; a 3,000-entry snapshot commits in one transaction of three chunks; a failure injected mid-entries leaves nothing; every named constraint and index exists; each CHECK refuses its bad value; the PK refuses a duplicate account; no FK reaches another module (`pg_constraint`); `EXPLAIN` shows index range scans for the three reads at 1M entries; the adapter has no update or delete |
| In-memory twin | the same idempotency and PK suite |
| API (supertest through `configureApp`) | no key → 400; a body with `participants`, `communityId` or `recordedBy` → 400; malformed key → 422; 201 then 200 on replay; the 404, 403, 412, 429 and 503 bodies carry their stable codes; the POST has counts and no list; pages capped at 200 with opaque cursors; a forbidden snapshot → 404 identical to unknown; no email in any response |
| Architecture | `attendance-boundaries.spec`: layers exist; the domain reaches only itself and shared; no `drizzle-orm` or `pg` outside infrastructure; no LiveKit package or `ws` anywhere; never `operations/contracts`, academic, notifications, realtime, a LiveKit package, or live or communities internals; nothing but `app.module` reaches attendance; only attendance imports `live/contracts/presence.ts`; attendance never injects `COMMUNITY_MEMBERSHIP` or `COMMUNITY_CAPABILITY_HOLDERS` (a token grep, and no import of `communities/contracts/membership.ts` or `capability-holders.ts`); no `attendance.read` / `attendance.manage` string. `AttendanceController` joins the controller list (`authorization.spec.ts:80-92`) with every route `@Authenticated()`; the schema joins `OTHER_SCHEMAS` (`academic-boundaries.spec.ts:20-25`); the P0-derived module lists pick attendance up; no `forwardRef`; `CommunitiesModule` imports neither `LiveModule` nor `AttendanceModule` |
| Adapter contract (Live's, opt-in CI job against a real LiveKit, ADR 0003 `0003-rtc-provider-abstraction.md:82-85`) | `listParticipants` maps state and kind; a hidden participant appears; a missing room → `[]`, and psrpc-mode behaviour is pinned; a timeout surfaces as an error |
| Flutter | `HttpAttendanceRepository` parses views and pages defensively (unknown `connection` → `unknown`); one key per press, reused on retry; the button disabled in flight; shown only with the server capability or `canModerate`, and a live session; mock data flagged `DataOrigin.mock`; screens import no `http`, `api_client` or LiveKit; copy never says present; snapshots never fill the halaqa or progress ratios |
| Load (before production use) | [§21](#21-scale) |

---

## 23. Before P9 can start

P9's entry condition is exactly three things: Q40's gates cleared, that is the
§13 step (Q35/Q36 and ADR 0015) and the reconciliation review with §13's
Attendance row, or the user's ruling on Q40 (rows 1 and 2); Q69 settled by the
reviewers and the user (rows 3a and 3b); and P6 done (hub
[§25](communities-live-attendance.md#25-implementation-phases)).

**Must be answered.** Nothing else moves the module out of HELD.

| # | Question | Answered by | Recorded in |
| --- | --- | --- | --- |
| 1 | [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules)(b): an explicit ruling that live-presence snapshots are outside the Attendance hold and §13's Attendance row, **or** the hold is lifted after the reconciliation review (`academic-reconciliation.md:19-21`) **and** §13's Attendance row (`academic-reconciliation.md:504`) is met: scoping through row 3a, and [Q8](open-questions.md#q8--who-may-amend-attendance-and-is-a-reason-mandatory) and [Q12](open-questions.md#q12--timezone-and-academic-calendar) answered or ruled by the user not to apply to snapshots. The case for "outside" is [§13](#13-snapshots-and-operations-attendancerecord)'s table; this document does not decide it | the reconciliation review (with §13's Attendance row), or the user's ruling | ADR 0020 |
| 2 | Q40(a): §13's "before any new module" step (Q35 and Q36 answered, ADR 0015 landed; `academic-reconciliation.md:483-493`) completed, **or** ruled not to apply to attendance | the §13 step (Q35/Q36 and ADR 0015), or the user's ruling | ADR 0015 (the step); ADR 0020 (a ruling) |
| 3a | [Q69](open-questions.md#q69--who-records-and-who-views-snapshots): community standing (`community.attendance.record` / `.view`) accepted as the scoping relationship instead of `ACADEMIC_RELATIONSHIPS` (`academic-reconciliation.md:504`; `open-questions.md:824-826`) | reviewers | ADR 0020; open-questions.md |
| 3b | Q69's record and view defaults ([§11.1](#111-the-two-acts), the brief §9/§13/§15 default) confirmed or replaced | the user (the institution) | ADR 0020; open-questions.md (Q69) |

**Must be done.**

| # | What | Phase |
| --- | --- | --- |
| 4 | `FailureKind 'unavailable'` → 503; the corrected vendor-SDK rule; `livekit-sdk-only-in-the-live-adapter`; rules-match; derived module lists; Live's events in `live/contracts`; the document and comment corrections of [§3](#3-the-smallest-change-to-existing-documents) | P0 |
| 5 | `COMMUNITY_AUTHORIZATION` with the owner and grant bases, and `communities_capability_grants`, whose CHECK P9 widens | P2, P3 |
| 6 | A persisted, community-scoped `LiveSession` with start and end; `ended` saved before `endRoom`; `LIVE_SESSIONS`, including `hostUserId`; `RtcParticipantObserver.listParticipants`, with the adapter contract suite green against a pinned LiveKit in CI | P6 |

**Must be on record, not answered.** The provisional defaults of Q43, Q67, Q68,
Q70, Q71 and Q72 ([§24](#24-open-questions)) are recorded in
open-questions.md, so P9 builds against recorded defaults. Each is the
conservative choice: it stores the raw fact, derives nothing, edits nothing and
notifies no one, and a later answer changes code or adds a rule id without
rewriting a stored snapshot. None of them blocks P9.

**Decided inside P9's first change**, not before: the identity ceilings of the
two acts (no `attendance.*`) and their LOCKED column, as one row of Communities'
act table; the migration number; the hard-coded lists of §22.

**Not needed to start P9, but needed before production use:** the load
measurements of [§21](#21-scale), which calibrate the PROVISIONAL bounds.

---

## 24. Open questions

| Question | Default here (PROVISIONAL) | Blocks P9? |
| --- | --- | --- |
| [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules) Governance: which gates apply to the new modules? | Both the hold and §13's step apply | **yes** |
| [Q69](open-questions.md#q69--who-records-and-who-views-snapshots) Who records and who views snapshots? | The brief's default: the owner, the session's host and moderators, and grantees record; the owner, the session's host and recorders, and grantees view; no `attendance.*` | **yes** |
| [Q68](open-questions.md#q68--what-counts-as-present-in-a-snapshot) What counts as present in a snapshot? | Nobody is labelled; `CONNECTED` and `CONNECTING` stored, counted apart | no |
| [Q70](open-questions.md#q70--is-a-snapshot-the-attendance-record) Is a snapshot the attendance record? | Observation only; nothing derived | no |
| [Q71](open-questions.md#q71--correcting-retaining-and-erasing-snapshots) Correcting, retaining and erasing snapshots | Immutable; kept like the audit log; no erasure path | no |
| [Q72](open-questions.md#q72--when-and-how-often-snapshots-are-taken) When and how often snapshots are taken | On a press only; no per-session limit; 6 per 60 s per recorder; 4 listings in flight; 15 s; 10,000 entries | no |
| [Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts) Notifications for community, live and attendance facts | None; the event is published for a later translator | no |
| [Q43](open-questions.md#q43--institutional-oversight-of-communities) Institutional oversight of communities | No attendance oversight | no |
| [Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock) What does LOCKED mean, and who may lock? | Communities' answer governs attendance | no |
| [Q57](open-questions.md#q57--live-session-size-and-concurrency) Live session size and concurrency | 300 + 10 per session, so snapshots of at most 310 entries until measured | no |
| [Q60](open-questions.md#q60--one-account-on-several-devices-in-a-session) One account on several devices in a session | Newest device wins; one entry per account | no |
| [Q63](open-questions.md#q63--losing-standing-during-a-running-session) Losing standing during a running session | Still recorded if connected; ejection is Live's | no |
| [Q8](open-questions.md#q8--who-may-amend-attendance-and-is-a-reason-mandatory), [Q12](open-questions.md#q12--timezone-and-academic-calendar) (existing) | Not exercised: no amendment, no calendar | **yes**, unless the user rules ([Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules)(b)) that §13's Attendance row does not apply to snapshots |
| [Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history), [Q31](open-questions.md#q31--teaching-scope-and-what-staff-may-see) (existing) | Not exercised: nothing deleted, `attendance.*` unexercised | no |

---

## 25. Deferred

- The `ATTENDANCE_SNAPSHOTS` reader (`byCommunity`, `entries`; keyset pages of at
  most 1,000), built with its first consumer (operations under Q70, or a
  notifications translator under Q67). Consumers rebuild from the table, never
  from event delivery.
- The notifications translator for owner delivery (P10; Q67, Q28).
- A per-person index, an own-entries view and an erasure path (Q69, Q71).
- An institution-wide listing and oversight (Q43, Q69), inside Communities' act
  table and never through `attendance.read`.
- New observation rules: dial-in mapped to accounts, or a large-event path's
  presence source (Q58).
- `COPY` for the entries if the 10,000-entry ceiling is ever raised, and a
  smallint `connection` code: adapter changes with no contract change.
- The Redis rate limiter (P11).
