# 0021 — Cross-cutting rules for the new modules: events in contracts, journals, durability classes, the realtime transport matrix, protocol v1 growth, `FailureKind 'unavailable'`, executable guards

**State: PROPOSED — design only. Nothing here is implemented; no table, endpoint, event publisher or screen exists.**

**Status:** Proposed
**Date:** 2026-09-23

**Amends [0006](0006-event-architecture.md)**: event types live in the
publisher's contracts, and deferring the outbox now has explicit triggers
(T1–T4). **Amends [0009](0009-executable-architecture-rules.md)**: two rules are
corrected or added, and every rule must be proven to match something.
**Amends [0012](0012-realtime-messaging-transport.md)**: new server frame
families and an audience resolver; the socket, its authentication and its gate
are unchanged. None of the three is superseded. The rules apply to
[0016](0016-communities-module.md)–[0020](0020-attendance-snapshots.md). The
detail is in the hub:
[§14 events](../communities-live-attendance.md#14-event-model),
[§16 realtime](../communities-live-attendance.md#16-realtime-transport-matrix),
[§20 scaling](../communities-live-attendance.md#20-scaling-model) and
[§25.1 Phase 0](../communities-live-attendance.md#251-phase-0-corrections).

## Context

Two new modules (communities, attendance), a reworked one (live) and three
consumers (messaging, realtime, later notifications) need the same answers:
where events are declared, how they are emitted, whether losing one matters,
which channel carries what, how the wire protocol grows, how an outage is
reported, and which rules keep all of it honest.

**What exists today:**

- Messaging declares its event names and payload types in `contracts/events.ts`
  and its domain imports them (`messaging/domain/events.ts:1-9`). Live's are in
  `live/domain/events.ts:9-32`, which no other module may import
  (`.dependency-cruiser.cjs:141-161`).
- Academic's journal writes the audit entry, then the event, and nothing for a
  no-op (`academic-journal.ts:11-39`).
- The event bus is in-process and awaits each handler in turn
  (`event-bus.ts:43-56`); a crash between commit and publish loses the event
  ([0006](0006-event-architecture.md)).
- Realtime: one socket, protocol v1. The app drops any frame whose version is
  not 1 (`realtime_frames.dart:56`) and ignores unknown types
  (`realtime_frames.dart:70`). The connection gate is `messaging.read`
  (`realtime-sessions.ts:443`). One instance accepts 10,000 connections
  (`realtime-policy.ts:42`). The messaging relay walks every recipient page
  for every message (`messaging-relay.ts:207-219`).
- `FailureKind` has seven kinds and none maps to 503 (`result.ts:21-28`;
  `http-failure.ts:12-20`; `all-exceptions.filter.ts:33-56`).
- **Two guards are weaker than the documents say.**
  `application-has-no-vendor-sdks` is anchored at the package name, but
  resolved paths start with `node_modules/`, so it can never fire
  (`.dependency-cruiser.cjs:79-90`). And no rule confines `livekit-server-sdk`
  to live's adapter outside the domain and application layers, although
  `realtime.md:573` states it.
- Architecture specs hard-code today's module lists, and the academic upgrade
  test asserts an exact grant delta against the latest migration
  (`academic-postgres.spec.ts:580`), so any new identity migration breaks it.

## Decision

Everything below is proposed. None of it exists today.

1. **Events live in contracts.** Every event's name and payload type is in the
   publisher's `contracts/events.ts`; domain factories import from
   `../contracts/events`. In P0, Live's events move there with identical names
   and payloads, and `live.speaker.requested` joins the events.md catalogue.
   Identity's events move when they get their first subscriber in another
   module. A test forbids a `DomainEvent<'literal'>` outside `*/contracts/`,
   except an allow-list of identity's current events.

2. **One journal per module.** Every mutating use case emits through it: the
   audit entry, then the event, after commit, and neither on a no-op
   (`CommunitiesJournal`, `LiveJournal`, `AttendanceJournal`). The journal is
   the one class per module the outbox will later touch.

3. **Payloads carry ids, codes, counts and versions only.** Never text, names,
   emails, invitation tokens or hashes, LiveKit tokens or URLs. Transport noise
   is logs and metrics, never audit or events: token issuance, LiveKit joins,
   leaves and track publications, sweep corrections, authorization denials,
   failed redemptions.

4. **Durability classes.**
   - **R**: loss is tolerable, because the fact is in the owner's table.
     Every v1 event but one.
   - **S**: a security reaction with a reconciler backstop.
     `communities.member.removed` is the only S event: Live's participant
     sweep ([0019](0019-community-scoped-live-sessions.md)) and messaging's
     per-access check ([0018](0018-community-chat-projection.md)) back it.
   - **G**: guaranteed delivery. None in v1.

   Correctness never depends on delivery: decisions read contracts at the
   moment they are made, the one security reaction has a backstop, and clients
   reconcile over HTTP by version. Every subscriber that is not a relay is
   idempotent and detached.

5. **The outbox becomes mandatory on any one of four triggers.**
   - **T1**: a projection used for authorization that has no reconciler. The
     community chat's projection does not fire it
     ([0018](0018-community-chat-projection.md)).
   - **T2**: a delivery the institution requires to be guaranteed (see [Q67]).
   - **T3**: a second API instance.
   - **T4**: an external side effect that cannot be re-derived.

6. **The transport matrix.** The app WebSocket carries application state.
   LiveKit carries media and media-plane state: audio, the screen track,
   speaking indicators, the in-room roster, a participant's own permission
   change, disconnection when a room is deleted. **Nothing rides the LiveKit
   data channel.** No second socket and no topic system. HTTP stays the truth;
   frames are hints.

   | What | Travels on |
   | --- | --- |
   | Community lifecycle, membership, access changes; live session start, end and state changes | the app WebSocket (ids only), then HTTP refetch |
   | Audio, screen, speaking, joins, leaves, the in-room roster | LiveKit only |
   | The join credential | the HTTP response only |
   | Invitation changes, attendance snapshots | no frame in v1 |

   The full matrix, with audiences and costs, is
   [hub §16.1](../communities-live-attendance.md#161-where-every-event-and-state-change-travels).

7. **Audiences are resolved at delivery time.** One relay per source module
   in `realtime/application` (`CommunitiesRealtimeRelay`,
   `LiveRealtimeRelay`); no attendance relay. Each asks the source module's
   contracts, never keeps a copy, and uses one internal resolver,
   `OnlineAudience`: 0 queries when nobody is connected; 1 when the audience
   fits one page of 1,000; otherwise at most 1 + ⌈A/1000⌉, where A ≤ 10,000
   is the number of accounts connected to this instance. `ConnectionManager`
   gains `onlineUserIds()`, and the messaging relay moves onto the resolver
   (gate G1 of [0018](0018-community-chat-projection.md)) with no contract
   change, because `MESSAGE_RECIPIENTS` already has `onlyUserIds`.

8. **Protocol v1 grows only by additive server frames**, and the version is
   never bumped. New frames: `community.member.added`,
   `community.member.removed`, `community.locked`, `community.unlocked`,
   `community.access.changed`, `live.session.started`, `live.session.ended`,
   and `live.session.changed {communityId, sessionId, stateVersion}`, sent to
   moderators (coalesced to at most one per 250 ms per session) and at once to
   the affected user. No client frame is added and `subscribe` is unchanged.
   Golden frame fixtures are shared by the backend and Flutter.

9. **The connection gate stays `messaging.read`** (PROVISIONAL, [Q66]). A test
   pins that every role holding `live.join` or `communities.read` also holds
   `messaging.read`; an account without it gets HTTP only.

10. **`FailureKind` gains `'unavailable'`, mapped to 503**, in `result.ts`,
    `http-failure.ts` and the exception filter's `KIND_BY_STATUS` and
    `CODE_BY_STATUS`. The exhaustive status map makes it compile-checked. It
    carries `live.media_unavailable`, `attendance.observation_unavailable` and
    Communities store failures (callers fail closed).

11. **Executable guards, before any feature code (P0).**
    - Fix `application-has-no-vendor-sdks` to match resolved `node_modules/…`
      paths. It reports 0 violations on today's graph.
    - Add `livekit-sdk-only-in-the-live-adapter`: from `^src/`, except
      `^src/modules/live/infrastructure/`, to the LiveKit packages.
    - Add `rules-match.spec`: every forbidden rule with a target path must match
      a representative resolved path, so no rule is vacuous.
    - Module exports are contract tokens only; `forwardRef` is forbidden; the
      module lists in the architecture specs are derived from
      `src/modules/*`.
    - Every new module gets a boundary spec (communities, live, attendance, the
      last with the `LIVE_PRESENCE` allow-list and a ban on `attendance.*`
      strings).
    - A Flutter guard: no `livekit_client`, `flutter_webrtc` or `dart_webrtc`
      in `pubspec.yaml` or under `lib/`.
    - Pin the academic upgrade test to its own migrations
      (`migrateTo(scratch.db, 9)`); migration 0009 gets its own grant-delta
      test.

12. **Exactly one API instance until P11.** Relays are per process, the
    reconciler runs in-process with an overlap guard, and rate limits are in
    memory. P11 adds, only on evidence (T3, or T2 or T4): the outbox written by
    each journal through a unit of work, a broker behind `EventSubscriber` with
    every-instance and one-instance delivery, a Redis `RateLimiter`, and a
    reconciler lease.

## Consequences

If accepted:

- Adding a notification translator later changes no publisher: it subscribes
  to contract events and asks contracts for recipients (P10, after [Q67] and
  [Q28]).
- In-process delivery stays at most once. Losing an R event costs latency;
  losing the S event is bounded by the 60 s participant sweep and never opens
  chat access.
- A second API instance stays blocked until P11. That is a stated operating
  constraint, not an accident.
- Installed apps keep working: they ignore frames they do not know, and every
  new frame has an HTTP read behind it.
- Fan-out per event per instance is bounded (≤ 11 queries) whatever the
  community's size.
- Phase 0 changes production code in two places only: the Live event move
  (names and payloads identical) and the new failure kind. The Flutter error
  parser must tolerate `'unavailable'`.
- The claims "LiveKit in exactly one file" and "application layers import no
  vendor SDK" become true, not just stated.

## Alternatives considered

- **An outbox for every new event now.** Rejected: ADR 0006 already judged it a
  table, a dispatcher and a retry policy before any consumer needs guaranteed
  delivery. Correctness here does not depend on delivery, and T1–T4 say when
  it becomes mandatory.
- **A realtime contract that modules call to push to an audience.** Rejected:
  realtime is imported by the composition root only, and modules would couple
  to transport and decide audiences outside their own contracts.
- **A client `subscribe{topic}` or `watch` frame with interest sets per
  connection.** Rejected: server state that must follow every membership
  change, multi-instance semantics, and a wider parser, for audiences that
  account addressing already serves. Kept as a negotiated future extension
  (`ready.features`).
- **The LiveKit data channel or room metadata for queue, lock or session
  state.** Rejected: it couples application state to the media provider,
  reaches only room participants, and makes every listener a broadcaster.
- **LiveKit webhooks as the source of truth** for presence, screen share,
  session end or attendance. Rejected: dropped under join storms, and a public
  route would be needed.
- **Protocol v2 for the new frames.** Rejected: the app drops every frame whose
  version is not 1, so a bump would silence messaging and notification frames
  on every installed app.
- **Walk every member per event**, as the messaging relay does today.
  Rejected: 30 queries per event per instance at 30,000 members, even when
  almost nobody is online.
- **The brief's `live.hand.raised` / `.accepted` / `.rejected` as events next
  to `live.speaker.*`.** Rejected: two names for one fact. Raising is
  `live.speaker.requested`, accepting is `live.speaker.granted`, rejecting is
  `live.speaker.declined`.
- **Report provider outages as a thrown 500**, with no new failure kind.
  Rejected: the designed 503s could not be represented, and a thrown fault is
  indistinguishable from a bug.
- **An attendance relay in v1.** Rejected: the recorder has the HTTP answer,
  viewers read over HTTP, and owner delivery is notification policy ([Q67]).
- **A `realtime.connect` permission** to decouple the gate. Rejected for now:
  a catalogue entry, a migration and matrix changes, while every role already
  holds `messaging.read` ([Q66]).
- **Redis or a broker now.** Rejected: one instance, and realtime.md already
  says not to add Redis just because realtime exists. The ports keep the path
  open.
- **One generic relay for every source.** Rejected: payload validation per
  source is deliberate; only the audience algorithm is shared.
- **A per-transaction membership hint event.** Dropped: per-member events
  carry versions and serve as wake-ups ([0016](0016-communities-module.md)).
- **`group.*` frames and `/groups` routes.** Rejected: the name is Community
  ([0016](0016-communities-module.md)), and routes are prefixed by the module
  that owns them.
- **Large-event support (30,000 listeners) in Communities.** Rejected: it is a
  media-distribution problem and belongs inside Live, behind a port
  ([0019](0019-community-scoped-live-sessions.md)).
- **Add `livekit_client` to the app now.** Rejected: it brings the native
  `flutter_webrtc`, which cannot be built or verified here; a seam with an
  "unavailable" default is used until P7b.

[Q28]: ../open-questions.md#q28--what-deserves-a-notification-and-how-loudly
[Q66]: ../open-questions.md#q66--realtime-without-messagingread
[Q67]: ../open-questions.md#q67--notifications-for-community-live-and-attendance-facts
