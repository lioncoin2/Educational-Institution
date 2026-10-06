# 0025 — Defer persistent live-session-start notifications (P10)

**State: ACCEPTED (2026-10-06) — `live.session.started` is NOT implemented as a persistent
notification at this time. It remains a realtime-only Live event, delivered by the existing realtime
relay. No notification vocabulary, catalog entry, translator, dispatcher change, outbox, broadcast
model, or channel-default logic is introduced by this record.**

**Status:** Accepted. **Supersedes in part [0024](0024-notification-policy-p10.md)** — only its
`live.session.started` persistence/channel row. Every other 0024 policy (the community facts, the two
speaker facts, attendance, messaging-unchanged, best-effort delivery, and the preserved T2/outbox gate
of [0021](0021-cross-cutting-rules-for-new-modules.md)) stands unchanged.
**Decided:** 2026-10-06, by the owner; **reversible** — this defers a persistent/broadcast notification
for this event; it does not forbid one (see *Revisiting*).
**Date:** 2026-10-06

Grounded in the read-only architectural investigation at HEAD `3d23274` (P10 Slice 2A is complete: the
two speaker facts `LIVE_SPEAKER_REQUESTED` / `LIVE_SPEAKER_GRANTED` are implemented and are not affected
by this decision).

## Context

[0024](0024-notification-policy-p10.md) recorded `live.session.started` as **IN_APP / REALTIME to the
applicable audience**, with **PUSH not default for the whole community**. In the notifications engine
`IN_APP` **is** the stored record (`domain/preferences.ts`), so honouring that row means one durable
notification row per intended recipient. The investigation asked whether that is safely deliverable on
the current architecture. The facts, from the repository:

- **The event.** `live.session.started` carries `{ sessionId, communityId, hostUserId }` (ids only),
  `aggregateId = sessionId`, published after the session is committed. "An event is a hint, never a
  grant: every consumer re-asks" (ADR 0021; `live/contracts/events.ts`).
- **The dispatcher** (`NotificationDispatcher`) is the sole creator; it is synchronous, store-then-publish,
  and **capped at `maxRequestsPerDispatch = 1000`** (it throws above), so a caller must page a larger
  audience.
- **The bus is best-effort and non-durable.** `InProcessEventBus` awaits handlers in-process, swallows a
  throwing subscriber through `onHandlerError`, and **never retries or persists** the event. **No
  transactional outbox, job queue, background worker, or delivery-state tracking exists** (`ioredis` is a
  declared dependency but is never imported). The bus header notes a future outbox "replaces this class";
  the **T2/outbox gate of [0021](0021-cross-cutting-rules-for-new-modules.md) is still closed**, and
  [0024](0024-notification-policy-p10.md) preserved it.
- **The store has no broadcast or retention support.** The `notifications` table keeps one durable row
  per `(recipientUserId, dedupeKey)`; `REALTIME`/`PUSH` are delivery channels of that stored row. There
  is **no** realtime-only/ephemeral/broadcast representation, **no** grouping/collapse, and **no**
  retention/cleanup (`NotificationRepository` has no delete/prune; its indexes are per-recipient only —
  there is no index on `type`, `category`, `target`, or session).
- **The audience is O(members).** The applicable audience is ACTIVE members for whom
  `COMMUNITY_AUTHORIZATION.permittedAmong(communityId, candidates, 'community.live.join')` holds;
  `community.live.join` is a **derived act satisfied by ACTIVE membership** (not a capability).
  Candidates come from `COMMUNITY_MEMBERSHIP.members` (≤ `MAX_MEMBER_PAGE = 1000` per page; the contract
  "never loads a whole community or reports its size"), so a full-audience enumeration is proportional to
  community size, bounded per page but unbounded in total.

## Existing realtime behavior (unchanged by this decision)

The realtime relay (`realtime/application/live-relay.ts`) already subscribes to every `LiveEvents` name.
For `sessionStarted` it runs `toParticipants` → `onlineAudience(connections, COMMUNITY_MEMBERSHIP.members)`
→ `LIVE_AUDIENCE.participantsAmong` filter → one `liveSessionStartedFrame` (ids only;
`eventId = live.session.started:<sessionId>`) to each recipient via `connections.sendToUsers`.
`onlineAudience` makes the cost **bounded by connected accounts, not community size** ("nobody online →
no call at all"), and `schedule()` does zero work when nobody is connected here. Delivery is best-effort:
a failure is logged (`event: 'realtime.live.delivery_failed'`), never thrown, never retried.
`ConnectionManager` is single-instance by design (multi-instance would need a broker-backed bus, noted as
not yet built).

So the eligible **connected** audience already receives `live.session.started`, at a cost bounded by who
is connected.

## Decision

`LIVE_SESSION_STARTED` is **not** added to the notification vocabulary or catalog, and **not** handled by
a translator. `live.session.started` **remains a realtime-only Live event**, delivered by the existing
realtime relay frame. The notifications engine does not store (`IN_APP`), relay (notification `REALTIME`),
or push it. The dispatcher, realtime relay, notification schema, event bus, and ADR 0024's other rows are
untouched.

### Why persistent per-recipient fan-out is rejected for now

It is **O(community size)** durable rows **per session start**, with no retention and no index to clean
transient rows by session; it is **best-effort and non-resumable** on the current bus (a crash mid-fan-out
leaves some members notified and others not, with no replay); it produces a **redundant second signal**
for connected members (the `live.session.started` frame *and* a `notifications.notification.created`
frame for the same fact); and it **cannot honour** ADR 0024's push-not-default without a channel-default
seam that does not exist (the engine derives channels only from the per-category preference `??` the
global all-on `DEFAULT_CHANNEL_PREFERENCES`, which would push community-wide by default).

### Why synchronous paged fan-out is rejected

Paging respects the 1000-per-dispatch cap (⌈N/1000⌉ dispatches per start, each an
`insertMany(≤1000)` plus up to 1000 published `created` events), but it does **not** remove the problems
above: it is still O(members) work on the best-effort in-process bus, **non-resumable** across a crash or
restart, competing with request serving on the single process, and it leaves **unbounded** table growth
with no cleanup path.

### Why an outbox/worker is not introduced solely for this event

No durable outbox, worker, queue, or delivery-state mechanism exists; building one is **net-new,
cross-cutting infrastructure** (a table, a worker runtime, delivery-state, retention). ADR 0021's
T2/outbox gate is deliberately closed until a broader need (it "would land with P11 if a guarantee is
ever required", per 0024). Standing that infrastructure up for one transient event is disproportionate
and premature.

### Why a broadcast / fan-out-on-read model is deferred

A broadcast representation (one row plus a membership-scoped read model, instead of one row per
recipient) would be the structurally right shape for a community-wide signal, but it is a **different
notification architecture** (new schema, read model, repository, and API) and is gated on the same
product and infrastructure prerequisites. It is out of scope for this decision and deferred.

## Consequences

- **No code changes.** No new `NOTIFICATION_TYPES` / `NOTIFICATION_CATEGORIES` / `targetKind`, no catalog
  line, no translator, and no change to the dispatcher, the realtime relay, the notification schema, the
  event bus, the push port, or Flutter. The T2/outbox gate stays closed.
- `live.session.started` behaves exactly as today.
- ADR 0024's community, speaker, attendance and messaging policies, its best-effort delivery, and its
  preserved outbox gate are unchanged.

### What disconnected users currently experience

A member who is **not connected at the start instant receives nothing** for `live.session.started`: the
realtime frame is ephemeral, there is no catch-up, and no inbox row is written. They learn of a running
session when they next open the app through the owning module's own HTTP view (e.g. the
current-live-session endpoint), not through a notification.

### Push behavior

**No push** for `live.session.started`, consistent with ADR 0024's "PUSH is NOT default for the whole
community". Community-wide push stays off.

### Security / audience semantics

Unchanged. The realtime relay resolves recipients through `LIVE_AUDIENCE.participantsAmong` **at delivery
time**: ACTIVE members permitted `community.live.join`, with identity's ceiling and the community
**lifecycle gate** applied, so a member who has left, a member whose community is locked for joining, and
a deactivated account are excluded; membership changes between start and delivery are reflected because
the audience is re-asked, never cached. A frame grants nothing — the client re-runs the owning module's
view check.

### Idempotency / event semantics of the realtime frame

The realtime frame carries a deterministic `eventId = live.session.started:<sessionId>` (`envelopes.ts`)
— ids only, **no timestamp** — so a client dedupes a repeated delivery and never conflates two distinct
sessions. No persistent notification identity is created. (If a persistent notification is ever built, the
investigation's proposed deterministic key is `live:session_started:<sessionId>:user:<recipientUserId>`,
timestamp-free, retry/resume-safe.)

## Revisiting — conditions that would justify a persistent/broadcast notification

This decision is **reversible** and would be reopened by a new ADR, with new information, when all of:

1. a **product decision** that a durable inbox entry for this transient event is worth its cost;
2. a **durable, bounded, resumable fan-out mechanism** exists (the T2/outbox gate opened, or a
   broadcast/fan-out-on-read read model);
3. a **per-category / per-type default-channel seam** so push defaults off for this fact while honouring
   explicit opt-in (and a dedicated category, not the `LIVE` speaker category);
4. a **retention/cleanup path** (and supporting index) for transient broadcast rows;
5. the **audience-enumeration pipeline** (`COMMUNITY_MEMBERSHIP.members` → `participantsAmong`) wired into
   a translator, with the deterministic idempotency key above and the `DispatchOutcome` observability
   counts captured (not discarded).

**This ADR does NOT prohibit a future persistent or broadcast notification architecture** for
live-session facts; it defers it until the conditions above hold. The `EventPublisher`/`EventSubscriber`
ports are explicitly designed to accept a future outbox without changing callers.

## Alternatives considered

- **Persistent per-recipient synchronous fan-out now** — rejected: O(members) durable rows per start,
  best-effort and non-resumable, redundant with the realtime frame, no retention, and it cannot honour
  push-not-default without a channel-default seam.
- **Build an outbox/worker now, for this event** — rejected: disproportionate net-new infrastructure,
  gated to a later phase by ADR 0021's T2 trigger.
- **A broadcast / fan-out-on-read model now** — deferred: a different notification architecture, gated on
  the same product and infrastructure prerequisites.
- **Implement ADR 0024's `IN_APP` intent as-is** — rejected: not safely deliverable at community scale on
  the current best-effort, in-process architecture.

## Relationship to ADR 0024

This ADR **supersedes in part only** ADR 0024's `live.session.started` persistence/channel row, refining
"IN_APP / REALTIME to the applicable audience; push opt-in" to **"realtime-only (the existing relay); no
persistent notification for now"**. **Every other ADR 0024 policy remains unchanged and in force** — the
community facts, the two speaker facts (`live.speaker.requested` / `.granted`, implemented in P10 Slice
2A), `attendance.snapshot.recorded`, messaging-unchanged, best-effort delivery, and the preserved
T2/outbox gate. Per the README convention, ADR 0024 stays `Accepted` and gains a "superseded in part by
0025" status marker and a successor pointer at the replaced row; its historical decision text is
otherwise left as decided.
