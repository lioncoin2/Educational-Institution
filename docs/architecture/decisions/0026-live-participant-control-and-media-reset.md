# 0026 — Moderator-commanded live participant control: a kick that is not a ban, and a shared media reset

**State: ACCEPTED (2026-10-06) — Q64 live participant control. A session moderator may remove a
participant from the media room (an administrative disconnect, never a ban) and may reset the media
room on command. Both are implemented in the Live module over the existing RTC ports and the existing
epoch mechanism; the realtime relay carries two new hints. No ban, denylist, transient block, outbox,
or new RTC capability is introduced. The Flutter side is deferred.**

**Status:** Accepted.
**Decided:** 2026-10-06, by the owner (the Q64 policy and the four architecture decisions below were
approved to proceed).
**Date:** 2026-10-06
**Reversible** in its policy (who may act, whether a reason is required, whether a kick should ever
become a ban); the extraction it rests on is a pure refactor with no behavioural change to revert.

**Builds on [0019](0019-community-scoped-live-sessions.md)** — it extends 0019's decision 6 *automatic
media reset* (the compare-and-set `mediaRoomEpoch` bump, the `reset_media` row, the room swap) into a
reusable service that a moderator may also command, and adds a `remove_participant` moderation act over
0019's narrow `RTC_PARTICIPANTS` port. **It does not supersede 0019 and changes none of its decisions**:
the reconciler's automatic reset behaves exactly as before. Builds on
[0017](0017-community-scoped-authorization.md) (authorization) and
[0021](0021-cross-cutting-rules-for-new-modules.md) (the dispatcher/outbox gate, best-effort events).
The design in full is [live.md](../live.md).

## Context

[Q64](../open-questions.md#q64--live-participant-control) asked for moderator control of a running
session beyond ending it: removing a disruptive participant, and resetting the room when tokens must be
invalidated. The owner's policy, approved as final:

- **Kick** — a **Moderator or Teacher** (the session's moderators, resolved through Communities) may
  remove a participant. A **reason is optional** and, when given, is a **code, never free text**. The
  removed participant **is informed**. **Re-entry is allowed**: it is a disconnect, **not a ban** — no
  denylist, no transient block, no state kept.
- **Media room reset** — a Moderator/Teacher may reset; the Owner only inasmuch as the existing model
  already grants it (the owner/host is a moderator). Kick and reset are **separate operations**.
- **Addressing** — the kick names its target by a server-validated path parameter; the parameter is the
  target only, **never trusted as authorization**.

The repository already carried the seams for this (so this record completes them, it does not invent
them): `MODERATION_ACTION_TYPES` includes `remove_participant` and `reset_media`;
`AUDIT_ACTION_BY_MODERATION` maps them to `live.participant.removed` and `live.session.media_reset`;
`LiveSessionRepository.bumpEpoch(id, expected, moderation)` is the compare-and-set used by the
reconciler; `RTC_PARTICIPANTS.removeParticipant(roomName, identity, { revokeTokensIssuedBefore? })` is
the narrow port 0019/0003 defined.

## Decision

### 1. One media reset, owned once and shared (extends 0019 decision 6)

The epoch bump + room swap that was private to the reconciler's `Enforcement.resetMedia` is extracted
into `live/application/live-media-reset.ts` (`LiveMediaReset`). It performs, unchanged: the
compare-and-set `bumpEpoch` with its `reset_media` row (a null bump — another reset, or the end, won —
returns `null` and does nothing further); then the **ensure-then-recheck** swap (ensure the new-epoch
room, re-read the session, seed occupancy or quietly end the new room if the session moved or ended, end
the old room); then the audit through the one `LiveJournal`. Every token a participant holds names the
deleted old room, which `auto_create=false` keeps gone; clients re-join through `/join`.

The caller supplies: its own `ModerationAction` (the reconciler a **null actor**, the command the
**moderator**); the provider **hooks** (`runProvider`, `onSkipped`) — so the reconciler keeps passing
its `ReconcilerRuntime.provider` wrapper and its skipped-logging, and its behaviour is **byte-identical**
to before the extraction; and the **events to publish**, if any. The reconciler supplies **none** (its
automatic reset stays event-free, exactly as 0019 decided), and keeps logging its own
`live.session.media_reset` line; the command supplies the new `live.session.media_reset` fact. The
extraction is proven behaviour-preserving by the unchanged reconciler specs and a direct contract test
(`application/participant-control.spec.ts`: no event without `eventsFor`, the fact with it, `null` on a
lost compare-and-set).

`ResetRoomUseCase` (`application/reset-room.use-case.ts`) is the command: identity `live.moderate` →
the session (404 before/412 after the end) → `LiveAccess.moderator` → `LiveMediaReset.reset` with the
moderator actor, the permit in the audit detail, and the `live.session.media_reset` event. The epoch is
committed before the provider calls, so a provider outage after the bump is left to the room sweep — the
reset still holds, because the old room is already unreachable.

### 2. Kick is a disconnect, not a ban

`KickParticipantUseCase` (`application/kick-participant.use-case.ts`): identity `live.moderate` → the
ids (a malformed session → 404, a malformed target → `live.target_not_in_session`, before any call) →
the optional reason **code** validated (`^[a-z][a-z0-9_.]{0,63}$`) → the session (404/412) →
`LiveAccess.moderator` → **host protection** (only the host may act on the host) → the media plane:
`RTC_PARTICIPANTS.removeParticipant` on the session's **current** room, `revokeTokensIssuedBefore = now`.

- `applied` → the `remove_participant` audit (with the permit, the target, the reason) **and** the
  `live.participant.removed` fact. `removed: true`.
- `not_connected` → the person was not in the room: a **no-op**, nothing audited, nothing announced.
  `removed: false`.
- a provider outage/misconfiguration → **503** `live.media_unavailable`, **never a false success**.

No ban, no denylist, no transient block, no state kept: the person may `POST …/join` again at once.
On the open-source LiveKit server a removal does **not** revoke an already-issued token, so **removal is
never the only enforcement** (live.md §9): the reset (decision 1) is what invalidates every current
credential. We do **not** invent a workaround for the OSS token-revoke gap; the reset is the tool for
"make current tokens die", and it is a separate, explicit operation.

### 3. The removed participant is told — the one exception to "a removed member is told nothing"

The realtime relay's rule is that a session's facts reach only its current participants, and a member
the session no longer accepts is told nothing more (`toConcerned`'s `participantsAmong` gate). The
`live.participant.removed` frame is the **one deliberate exception**: it is delivered **to the removed
person alone**, directly (`connections.sendToUser`), **bypassing that gate** — because the whole point
of the frame is that they are out of the room, so the gate would suppress the very notice it should
carry. The frame names the **session and community only**; the moderator's **reason is audited, never
put on the wire**, and never broadcast to anyone. The person re-reads over HTTP and may re-join.

The media reset is delivered as a start or an end is — `toParticipants` fan-out to the session's current
participants connected here — so each re-joins the new generation.

### 4. The path parameter is not authorization

The kick route is `POST /live/sessions/:sessionId/participants/:userId/remove` (reason as an optional
`?reason=` query, no body); the reset is `POST /live/sessions/:sessionId/reset`. The `:userId` names the
**target only**. Who may remove is decided **server-side**, every time: the coarse identity
`live.moderate` at the edge **and** in the use case, then `LiveAccess.moderator` on the community the
**stored session** names (never the client's claim), then presence on the media plane. A caller learns
nothing about a session they may not moderate — one 404, whether it exists or not.

## What this adds (and only this)

- **Two events** (`live/contracts/events.ts`): `live.participant.removed { sessionId, communityId,
  userId, removedBy, reason }` and `live.session.media_reset { sessionId, communityId, fromEpoch,
  toEpoch, resetBy }` — ids, codes and a null-able reason code only; `aggregateId = sessionId`.
- **One shared service** (`LiveMediaReset`) and the reconciler's delegation to it.
- **Two use cases** (`KickParticipantUseCase`, `ResetRoomUseCase`), wired in `live.module.ts`.
- **Two routes** on `LiveController`, each `@RequirePermission(live.moderate)`, no body.
- **Two realtime frames** (`envelopes.ts`: `liveParticipantRemovedFrame`, `liveMediaResetFrame`) and two
  relay branches (`live-relay.ts`), with golden fixtures under `test/fixtures/realtime-frames/live/`.
- The two moderation action types and their audit-action mappings (already present) are now exercised.

## Consequences

- The reconciler's automatic media reset is unchanged (same CAS, same ensure-then-recheck, same null
  actor, same absence of an event, same provider wrapper and skipped-logging). ADR 0019 stands as
  written and is **not edited**.
- A moderator-commanded reset now publishes a fact (`live.session.media_reset`); the automatic one still
  does not. Both write a `reset_media` audit row.
- A kick writes a `remove_participant` audit row and publishes `live.participant.removed` only when a
  removal actually applied; a `not_connected` kick writes and announces nothing.
- Events are **best-effort** on the in-process bus (ADR 0021); a lost frame costs a moment, never
  correctness — the client re-reads over HTTP. The **dispatcher/outbox gate stays closed**: these are
  realtime hints, not persistent notifications (consistent with [0025](0025-defer-persistent-live-session-start-notifications.md);
  live control signals are realtime-only).
- **Flutter is deferred.** The app's Live foundation is non-media/HTTP-only today (no roster UI, no
  live-frame consumption); it ignores frame types it does not know. A later Flutter phase adds the two
  parsers (golden fixtures already exist) and the moderator affordances.

## Security / audience semantics

The target is named by the server-validated path parameter and nothing is trusted from it but its
shape; authorization is `LiveAccess.moderator` on the stored session's community, within identity's
ceiling, re-asked every call. The reason never leaves the audit. The removal frame reaches only the
removed account's own connections; the reset frame reaches only the session's current participants,
resolved at delivery time. No frame carries a name, a roster, a count, a room name, or a credential.

## Idempotency / event semantics

- `live.participant.removed` frame `eventId = live.participant.removed:<sessionId>:<occurredAt-ms>` — a
  removal, a re-join, and a second removal are **distinct facts**, so the instant is part of the id.
- `live.session.media_reset` frame `eventId = live.session.media_reset:<sessionId>:<toEpoch>` — each
  generation is reset once; the epoch is a room-naming detail kept in the id, **off the wire**.
- A reset's compare-and-set makes concurrency safe: two resets from the same epoch yield one bump and
  one `reset: true`, the other `reset: false`.

## Alternatives considered

- **A ban / denylist / transient block on kick** — rejected by owner policy: a kick is an administrative
  disconnect, and re-entry is allowed. A durable exclusion is a different feature with its own record.
- **Token revocation as the only enforcement** — rejected: the OSS LiveKit server ignores token revoke,
  so a kick alone cannot guarantee a stale token dies. The reset (epoch bump + room delete) is the tool
  for that, offered as a separate operation; no workaround is invented.
- **Duplicating the epoch/room-swap in the command** — rejected: two copies of the enforcement's most
  delicate sequence would drift. One `LiveMediaReset`, parameterised by actor/events/hooks, keeps the
  reconciler's behaviour identical and gives the command the same guarantees.
- **Broadcasting the removal (or its reason) to the room** — rejected: only the removed person is told,
  and the reason stays in the audit. Telling the room who was removed and why is neither needed nor safe.
- **Trusting the `:userId` path parameter as authorization** — rejected: the path names the target; the
  server decides who may act.

## Relationship to ADR 0019

0026 **extends** 0019's decision 6 (automatic media reset) by factoring its mechanism into
`LiveMediaReset` and letting a moderator command it, and adds a `remove_participant` act over 0019's
`RTC_PARTICIPANTS` port. It introduces **no change** to 0019's decisions — Postgres-as-truth, the
level-triggered reconciler, the epoch mechanism, the narrow ports, the join/start/end flows, and the
enforcement backstop all stand exactly as 0019 records them. Per the README convention, because nothing
in 0019 is replaced, 0019 keeps its text and status and is **not annotated**; this record simply builds
on it.
