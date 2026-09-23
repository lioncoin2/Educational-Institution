# 0019 — Community-scoped live sessions: Postgres truth, level-triggered LiveKit convergence, a presenter slot, narrow RTC ports

**State: PROPOSED — design only. Nothing here is implemented; no table, endpoint, event publisher or screen exists.**

**Status:** Proposed
**Date:** 2026-09-23

**Amends [0003](0003-rtc-provider-abstraction.md)**: the port is split into
four narrow ports composed as `RtcProvider` and widened additively (as 0003
anticipated), `listParticipants` is added, and one adapter file stays the only
LiveKit importer. **Supersedes** the halaqa-bound `LiveRoom` design in
[module-boundaries.md](../module-boundaries.md) and
[realtime.md](../realtime.md), the claim "no camera, no screen share, by
construction" ([realtime.md §2.1](../realtime.md#21-listeners-receive-tokens-that-cannot-publish)),
and the Redis queue and presence plan
([realtime.md §4](../realtime.md#4-persistence-plan-not-yet-implemented)).
Builds on [0016](0016-communities-module.md),
[0017](0017-community-scoped-authorization.md) and
[0021](0021-cross-cutting-rules-for-new-modules.md). The design in full is
[live.md](../live.md).

## Context

The brief (§7–12, §17): a live session is our application object and a
LiveKit room is infrastructure; a community is not a room, and a room's name
is never a domain identity. 30,000 members is not 30,000 simultaneous
participants. Screen share is a session capability; raise hand leads to a
temporary speaker grant; everything is enforced on the server.

**What exists today:**

- `LiveRoom` is bound to a halaqa and has one host (`live-room.ts:10-18`).
  Repositories are in memory (`live.module.ts:51-57`), and LiveModule exports
  nothing (`live.module.ts:36-62`).
- Join checks only the role-wide `live.join` (`join-live-session.use-case.ts:61`);
  join tokens last 600 s (`join-live-session.use-case.ts:29`).
- Listeners are given `canPublishData: true` (`rtc-provider.ts:19-23`);
  publishing is microphone-only (`livekit-rtc-provider.ts:61`, `:81`), and
  `RtcCapabilities` has no screen flag (`rtc-provider.ts:11-17`).
- `ensureRoom` swallows every error (`livekit-rtc-provider.ts:34-45`), and no
  use case calls it or `endRoom`, so LiveKit creates rooms on its own
  defaults.
- Moderation goes through identity's `host-only-moderation` rule
  ([0017](0017-community-scoped-authorization.md)).
- The repository holds no LiveKit deployment configuration.

### What LiveKit does, and where that is known from

LiveKit's documentation site (docs.livekit.io, and livekit.com, its blog and
forum) **could not be read from this environment**: the egress proxy blocks
them. The facts below therefore come from source code: the installed SDK
(`backend/node_modules/livekit-server-sdk` 2.19.1, with `@livekit/protocol`
1.51.0), the open-source server (`livekit/livekit` at `6b2e3ec`, v1.13.7) and
the protocol repository (`livekit/protocol` at `72d9ef1`). The one figure that
comes only from second-hand quotes is marked as such.

| # | Fact | Source | What it forces |
| --- | --- | --- | --- |
| L1 | A self-hosted room lives on **one node**. Redis maps room → node; a room is never split, and joins are refused when its node is full | server `pkg/service/roomallocator.go:141-147`, `pkg/routing/redisrouter.go:39-40` | A session's size is bounded by one node, whatever the membership |
| L2 | "About 3,000 participants per room" is the **published** figure. It could not be read first-hand: it is known from quotes in GitHub issues #3041 and #3285 and from search summaries of the benchmark page (1 publisher, 3,000 subscribers, 92 % CPU on a 16-core machine). One reporter reached 1,500 | issues; search summaries | Not a design number. It must be **benchmarked** on the target hardware |
| L3 | The server refreshes a connected participant's token at join and every 5 minutes, valid for max(10 min, time left), carrying its current grants | server `pkg/service/roommanager.go:61-64`, `:767`, `:1149-1181` | A token TTL bounds only the first connect |
| L4 | `revoke_token_ts` is defined but never read by the open-source server; the SDK says a removed participant "can still re-join the room" | protocol `livekit_room.proto:161`; no reference in the server; SDK `RoomServiceClient.d.ts:131` | Removal alone does not keep someone out; enforcement needs a backstop |
| L5 | `room.auto_create` defaults to true | server `pkg/config/config.go:563` | A still-valid token can re-create an ended room unless it is turned off |
| L6 | A permission update **replaces the whole set**, `hidden` included, and unpublishes disallowed tracks at once. An empty source list means **all** sources; an unset `canPublishData` equals `canPublish` | protocol `auth/grants.go:429-441`, `:326-340`, `:355-360` | Always send the full, explicit set |
| L7 | Joining with an identity already in the room evicts the earlier session (`DUPLICATE_IDENTITY`) | server `pkg/service/roommanager.go:398-400` | With identity = account id, a second device evicts the first; whether one account may join from several devices is [Q60] (PROVISIONAL: no) |
| L8 | `ListParticipants` is unpaginated and returns every stored participant, including those still joining and hidden ones | server `pkg/service/roomservice.go:170-195` | One bounded read per observation ([0020](0020-attendance-snapshots.md)) |
| L9 | Webhooks go through one in-memory queue per room, at most 200 deep and 30 s old; excess is dropped | protocol `webhook/resource_url_notifier.go:54-55` | Webhooks are never a source of truth |
| L10 | `max_participants` counts every non-dependent participant; `CreateRoom` is create-or-update | server `pkg/rtc/room.go:458-467`, `pkg/service/roomallocator.go:60-127` | A hard cap is enforceable at the SFU; `ensureRoom` is idempotent |
| L11 | Screen share is an ordinary track with source `SCREEN_SHARE` (and optional `SCREEN_SHARE_AUDIO`), allowed by `canPublishSources` | installed `@livekit/protocol` `src/gen/livekit_models_pb.d.ts:163-170` | A presenter needs only a capability, never storage |

## Decision

Everything below is proposed. None of it exists today.

1. **`LiveSession` replaces `LiveRoom`.** `{communityId, hostUserId, state
   live | ended, state_version, endedBy, endReason, participantCap,
   moderatorReserve, mediaRoomEpoch}`. There is no `scheduled` or `cancelled`
   state: scheduling belongs to operations ([Q12]). The media room name is
   derived (prefix + session id, plus the epoch when non-zero) and is never an
   identity. `SpeakerRequest` has states `pending | granted | revoked |
   withdrawn | declined | expired`. Moderation actions are written in the same
   transaction as the change they record. `LiveParticipantRole` becomes
   `moderator | speaker | listener`.

2. **At most one live session per community** (PROVISIONAL, [Q55]), enforced
   by a partial unique index. A second start returns the running session.

3. **Start is idempotent and provider-first.** After authorization, a running
   session is returned as it is. Otherwise `ensureRoom` runs first: if LiveKit
   is unreachable the answer is 503 `live.media_unavailable` and nothing is
   stored. The insert is `ON CONFLICT DO NOTHING`; a start that loses the race
   ends its stray room and returns the winner. The starter becomes the host.

4. **End is idempotent.** One transaction ends the session, expires every open
   hand and floor, closes the presenter grant and records the action; exactly
   one `live.session.ended` follows, then `endRoom`. **Live saves `ended`
   before it calls `endRoom`**, which [0020](0020-attendance-snapshots.md)
   relies on. The system ends a session with a null actor, for `idle` or
   `community_closed`. No database transaction spans a LiveKit call. Any path
   that re-creates a missing room re-reads the session afterwards and ends the
   room if the session has ended (**ensure-then-recheck**).

5. **Authorization.** Start, join, raise hand, host and moderate all go
   through `COMMUNITY_AUTHORIZATION` ([0017](0017-community-scoped-authorization.md)).
   Start needs identity `live.moderate` and `community.live.start`. The
   community is always read from the stored session, never from the client.
   Live stops passing `ownerUserId` in the same change that retires
   `host-only-moderation`. Live never sees the raw lifecycle status: it reads
   permit refusals and `LifecycleEffects`.

6. **Postgres is the truth; LiveKit converges to it.** The record wins, the
   PROVISIONAL answer to [Q5]. A level-triggered reconciler compares desired
   state (Postgres, Communities, identity) with observed state (LiveKit):
   - **room sweep, every 30 s**: a live session without its room gets
     ensure-then-recheck; a room observed empty for 900 s ends its session as
     `idle` (PROVISIONAL, [Q61]); a prefixed room that belongs to no live
     session and is older than 60 s is ended;
   - **participant sweep, every 60 s per session**: an ineligible participant
     loses their hand, floor and presenter grant and is removed; a divergent
     permission set is re-applied;
   - **targeted watch, every 10 s**, for recent demotions;
   - **automatic media reset (P6)**: an identity's second violation inside its
     enforcement window (back while not eligible, or holding a source it is
     not entitled to) bumps `mediaRoomEpoch` by compare-and-set, with a
     `reset_media` row and a null actor, and moves the session to a new room.
     Every token the violator holds names the deleted room, which
     `auto_create=false` keeps deleted; eligible clients rejoin through
     `/join`.

   A tick is skipped when a dependency cannot be reached: the reconciler
   never ejects on unknown state. Because of L3 and L4, **the reconciler is the
   enforcement backstop**. Communities' events only accelerate it
   (`ProtectLiveSessions`).

7. **Pinned LiveKit configuration, short tokens, no admin grants.** The
   repository carries the deployment config: `room.auto_create=false`,
   `enable_remote_unmute=false`, LiveKit's empty and departure timeouts as a
   backstop only, no webhooks, and a TURN placeholder ([Q65]). Join tokens
   last 120 s, and no participant token ever carries `roomAdmin`, `roomCreate`
   or `roomList`. The LiveKit identity is the account id, and the display name
   comes from `ACCOUNT_DIRECTORY`, never from the client.

8. **Capabilities are total.** `RtcCapabilities {canPublishAudio,
   canPublishScreen, canPublishScreenAudio, canSubscribe, canPublishData,
   hidden}`, always applied as LiveKit's full permission set with an explicit
   source list (L6). Listeners publish nothing. `canPublishData` is false for
   everyone, and `hidden` is false for everyone until [Q59]. `CAMERA` is never
   granted.

9. **Screen share is one presenter slot per session** (PROVISIONAL bound,
   [Q56]). A `PresenterGrant` is claimed through the API by a moderator who
   holds `live.speak`, for themself. Another session moderator may revoke it,
   except that a moderator whose authority is not the host's own may not
   revoke the host's grant (403 `live.target_is_host`, PROVISIONAL, [Q54]).
   There is no screen audio and no delegation, and the stream is never stored.
   Opening the grant publishes `live.screen_share.started` and is audited.
   Closing it publishes `live.screen_share.stopped` (reason `stopped`,
   `revoked` or `ineligible`) and is audited only when `revoked`
   (PROVISIONAL, [Q56]). A close caused by the end of the session publishes
   nothing of its own; `live.session.ended` implies it.

10. **Narrow RTC ports.** `RTC_PROVIDER` is split into `RtcRoomProvider`,
    `RtcTokenIssuer`, `RtcParticipantControl` and `RtcParticipantObserver`,
    composed as `RtcProvider` and bound with `useExisting`, so each use case
    depends only on what it needs. `RtcUnavailableError` is a domain class.
    One adapter file remains the only importer of `livekit-server-sdk`,
    enforced by the rule `livekit-sdk-only-in-the-live-adapter`
    ([0021](0021-cross-cutting-rules-for-new-modules.md)).

11. **Contracts.** `LIVE_AUDIENCE` (`participantsAmong`, `moderators`) and
    `LIVE_SESSIONS` (`describe`) in P6; `LIVE_PRESENCE` in P9, importable only
    by attendance ([0020](0020-attendance-snapshots.md)). Live's events move to
    `live/contracts/events.ts` in P0, unchanged.

12. **Capacity is deployment configuration taken from measurement**
    ([Q57]), never from membership. PROVISIONAL: 300 participants per session
    plus a moderator reserve of 10, copied onto each session and enforced as
    LiveKit's `maxParticipants` (the hard cap), with a soft cap that refuses
    listeners with 412 `live.session_full`. The values are raised only after
    load profiles 1–3. **30,000 simultaneous listeners in one room is not
    promised.** If it is ever required, it is a separate large-event capability
    behind a Live port ([Q58]); Communities, messaging and attendance are
    unaffected.

13. **Hardening first, in the existing module (P1).** Total capabilities,
    adapter error mapping, names from the directory, idempotent raise, withdraw
    and decline, explicit audit actions and indexed repository reads come
    before any Communities dependency. The visible changes (listener data off,
    raise 202 → 201 for a new hand and 409 → 200 for an open one, token TTL
    600 → 120 s) need approval.

## Consequences

If accepted:

- A removed member, or a demoted speaker, loses the room when the event is
  delivered, and within 60 s at worst through the participant sweep
  ([Q63]). Removal alone does not keep a determined client out (L3, L4): each
  rejoin earns a fresh token. Violations are counted and shown to moderators,
  and the second one inside the enforcement window resets the media room,
  which ends the loop at the cost of a brief reconnect for everyone else. A
  reset that a moderator chooses stays with P12 ([Q64]).
- A LiveKit outage at start stores nothing. During a session it defers
  repairs; the reconciler catches up when LiveKit returns.
- There is no Redis. The queue is bounded by the speaker cap and lives in
  Postgres; presence is observed, never stored. With one API instance, an
  in-process guard is enough for the reconciler; a second instance needs a
  lease (P11).
- The app cannot publish audio or screen yet: it has no `livekit_client`, which
  brings the native `flutter_webrtc`. A `LiveMediaClient` seam stays bound to
  "unavailable" until P7b.
- Raising a hand now takes a short row lock (for `state_version`); load
  profile 1 measures it.
- A contract suite against a pinned LiveKit server in CI is required (P6),
  because the fake proves our logic, never LiveKit's behaviour.
- Capacity is honest: nothing above the measured sizes is enabled.

## Alternatives considered

- **Keep `LiveRoom` as a per-community aggregate** (rename `halaqaId`).
  Rejected: a second durable "place" competing with the Community, with a
  single host that contradicts delegation.
- **Rewrite live as a new module, or split it.** Rejected: it discards passing
  tests and a correct capability-token boundary. Cohesive use cases instead;
  no `LiveService`.
- **A media state machine** (`provisioning | ready | lost | closing |
  closed`). Rejected: provider-first start plus ensure-then-recheck gives the
  same crash safety with no second machine.
- **Report a provider outage as a thrown 500**, with no new failure kind.
  Rejected: a 503 `live.media_unavailable` needs `FailureKind 'unavailable'`,
  which the exhaustive status map makes compile-checked
  ([0021](0021-cross-cutting-rules-for-new-modules.md)).
- **A live-side table of what each community status means.** Rejected:
  Communities alone owns what LOCKED means ([0016](0016-communities-module.md)).
- **A `live.participate` capability** folding the lock into it. Rejected: it
  invents a capability every member must hold and splits "locked" across two
  modules.
- **The starter has no power** (attribution only). Rejected in
  [0017](0017-community-scoped-authorization.md): the host moderates their own
  session while `community.live.host` holds.
- **An admission table and a "dirty" flag** (edge-triggered repair). Rejected:
  it repairs only recorded edges and writes on every join during a storm.
- **Enforcement for a fixed 660 s after a revocation.** Rejected by L3: each
  rejoin earns a fresh token valid for at least 10 minutes, so someone
  rejoining at minute 9 outlives any fixed window.
- **Detect loss of entitlement from events only.** Rejected: the bus has no
  outbox, so a lost event would mean no revocation at all.
- **Join re-creates a missing room with no re-check.** Rejected: a join racing
  an end would bring the ended room back.
- **An orphan sweep without a grace period.** Rejected: it could delete the
  room of a start still in flight.
- **Screen share (and screen audio) in every moderator's token.** Rejected:
  unbounded concurrent video publishers, each multiplying egress by the
  number of listeners, on a single VPS; and screen audio is policy ([Q56]).
- **No screen-share events** (a track publication is transport). Rejected in
  part: the events are defined as the presenter grant opening and closing,
  which is exactly the auditable application fact. Track publications stay
  transport.
- **Screen-share events from `track_published` webhooks.** Rejected: lossy
  (L9).
- **Listeners hidden by default.** Rejected: a privacy choice ([Q59]); `hidden`
  travels in every permission set, always false, as the seam.
- **Release the presenter slot automatically; a config flag for student
  screen share.** Rejected: timing policy and policy by configuration.
- **A session-level advisory lock for the reconciler.** Rejected: it needs a
  pinned pool connection, and every step is idempotent.
- **Separate `live.hand.changed` and `live.moderation.changed` frames without
  a version.** Rejected for one `live.session.changed {communityId, sessionId,
  stateVersion}` ([0021](0021-cross-cutting-rules-for-new-modules.md)).
- **Find moderators by probing every online user on each hand event.**
  Rejected: thousands of queries in a hand storm. `LIVE_AUDIENCE.moderators`
  is a short, indexed list.
- **One combined observer contract for session scope and presence.** Rejected:
  the benign and the sensitive question need different import allow-lists
  ([0020](0020-attendance-snapshots.md)).
- **A moderator "remove participant" route now.** Rejected: whether and how is
  policy ([Q64]); the port method and the action type stay as seams.
- **Webhooks as the source of presence or reconciliation.** Rejected: L9.
- **Redis for the hand queue and presence**
  ([realtime.md §4](../realtime.md#4-persistence-plan-not-yet-implemented)). Rejected
  for now: the queue is bounded, presence is observed, and there is one
  instance.
- **Raise hand over the LiveKit data channel.** Rejected: it couples
  application state to the media provider and lets any listener broadcast.
- **A short token TTL as the revocation mechanism.** Rejected by L3.
- **Device-suffixed identities for several devices.** Rejected: one account
  would count twice in capacity and attendance ([Q60]).
- **Several concurrent sessions per community.** Rejected as the default
  ([Q55]): start would stop being idempotent.
- **"Live now" on the community, or live routes under `/communities` or
  `/groups`.** Rejected: Communities → Live closes a cycle. Routes are
  prefixed by their owning module, and the client asks
  `GET /live/communities/:id/sessions/current`.
- **Re-code `live.session_not_live` and `live.speaker_slots_full` from 412 to
  409.** Rejected: it changes existing semantics for no reason.
- **Size a session from the community's membership, or promise 30,000 in one
  room.** Rejected by L1 and L2 and by the brief.

[Q5]: ../open-questions.md#q5--what-happens-when-the-media-provider-and-our-record-disagree
[Q12]: ../open-questions.md#q12--timezone-and-academic-calendar
[Q54]: ../open-questions.md#q54--who-starts-ends-and-moderates-a-live-session
[Q55]: ../open-questions.md#q55--parallel-live-sessions-in-one-community
[Q56]: ../open-questions.md#q56--screen-sharing
[Q57]: ../open-questions.md#q57--live-session-size-and-concurrency
[Q58]: ../open-questions.md#q58--more-listeners-than-one-room-can-hold
[Q59]: ../open-questions.md#q59--visibility-inside-a-live-session
[Q60]: ../open-questions.md#q60--one-account-on-several-devices-in-a-session
[Q61]: ../open-questions.md#q61--ending-abandoned-live-sessions
[Q63]: ../open-questions.md#q63--losing-standing-during-a-running-session
[Q64]: ../open-questions.md#q64--removing-a-participant-from-a-session
[Q65]: ../open-questions.md#q65--media-hosting-and-operations
