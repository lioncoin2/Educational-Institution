# 0027 — No hidden live listeners: every admitted participant is visible

**State: ACCEPTED (2026-10-06) — Q59 is finalized. There are NO hidden listeners. Every account admitted
to a live session receives a media token whose `hidden` grant is `false`, so it appears in the in-room
participant roster like any other. No hidden-listener role, flag, mode, permission, audience type,
spectator, or observer participant exists or will be added. This record changes no production behaviour:
the architecture already enforces this, and this ADR finalizes the decision the seam was waiting on.**

**Status:** Accepted.
**Decided:** 2026-10-06, by the owner (Q59).
**Date:** 2026-10-06
**Reversible** only by a new ADR and a deliberate design: allowing hidden participation is not a
configuration toggle — it would require changing the authoritative capability builder and reckoning
again with the minors'-privacy reasoning below.

**Finalizes the provisional `hidden` seam introduced by [0019](0019-community-scoped-live-sessions.md)**
— which stated `hidden` in every permission set, always `false`, "as the seam for Q59" (its decision 7,
live.md §3.6). ADR 0019 remains **unchanged and in force**; nothing in it is replaced, so per the
[README](README.md) convention it is not annotated. This ADR only resolves the open question 0019
deferred. Builds on [0021](0021-cross-cutting-rules-for-new-modules.md). The design is
[live.md](../live.md); the question is [Q59](../open-questions.md#q59--visibility-inside-a-live-session).

## Context

[Q59](../open-questions.md#q59--visibility-inside-a-live-session) asked who may see the roster inside a
live session. LiveKit shows every participant who is not `hidden` to everyone in the room; a `hidden`
participant is connected but omitted from other participants' rosters and from the room's participant
count. The question flagged a real tension: a fully visible in-room roster undoes Q22's provisional
hidden community roster for anyone who joins a session, which touches **minors' privacy** in large rooms.

The module was built with the decision deferred: `hidden` is carried in the capability set as a seam,
always `false`, so that Q59 could later turn it on for a hidden-listener policy **or** close it. The
owner has now decided: **close it.** Everyone who enters a session is visible. The owner has weighed the
minors'-privacy consideration and chosen visibility; the roster, hands and frame-audience protections
below remain the privacy mechanisms.

## Decision

1. **No hidden listeners, ever.** Entering a live session means appearing in the participant roster.
   There is no hidden/invisible/anonymous/spectator mode and none will be introduced.

2. **Every admitted participant receives `hidden: false`.** The media token's visibility grant is
   `false` for every role — listener, speaker, moderator, host alike.

3. **`capabilitiesFor` is the authoritative capability builder** (`live/domain/standing.ts`). It is the
   single place the server derives what a participant may do from their `ParticipantStanding`, and it
   sets `hidden: false` unconditionally — there is no input, role, flag, or branch that yields `true`.
   The client never asks for capabilities; it receives them (the token is server-signed). The LiveKit
   adapter faithfully maps this set into the token grant and the runtime permission.

4. **`capabilityDrift` treats an observed `hidden` as a breach** (`live/domain/standing.ts`): if the
   provider ever reports a participant as hidden where the desired set is not, that is `exceeds`, which
   the reconciler corrects or removes. So a hidden participant minted out of band (impossible without the
   server's API secret) is ejected, not tolerated.

5. **`hidden` is retained intentionally.** The field stays in the RTC capability contract
   (`live/domain/rtc-provider.ts`) as an **enforced-`false` invariant** and the **drift-detection
   backstop** of decision 4. It is **not** removed: removing it would delete the signal the reconciler
   uses to detect and eject an externally-hidden participant, weakening the guarantee this ADR makes.

6. **Binds future media and Flutter.** When real LiveKit media binds (today the app's media seam is
   `Unavailable`, with no roster or hidden concept), and when the Flutter live roster is built, both
   inherit this decision: the roster the media client renders shows every admitted participant, because
   every token carries `hidden: false`. A future media/roster change must not introduce a hidden path.

## Consequences

- **No production code change.** The behaviour already matches this decision; this ADR records it and
  the accompanying change updates only documentation, stale comments, and regression hardening.
- The in-room roster is visible to every admitted participant, by decision. The **hands queue** stays
  moderators-only (`LIVE_AUDIENCE.moderators`) and realtime frames still carry ids only — those remain
  the in-session privacy protections, unchanged.
- Attendance's presence normalizer (`normalizePresence`) continues to **keep** a participant regardless
  of a `hidden` observation: were one ever seen, they are a connected member and are counted — a
  defensive property that composes with decision 4.
- A later decision to allow hidden participation would require a new ADR and a deliberate design; it is
  not reachable by configuration.

## Enforcement & verification

- **Authoritative point:** `capabilitiesFor` (`live/domain/standing.ts`) — `hidden: false` for every
  standing, proven by its full-matrix unit test (`standing.spec.ts`).
- **Backstop:** `capabilityDrift` — observed `hidden` ⇒ `exceeds` (breach), proven in `standing.spec.ts`.
- **Entry proof:** a join/use-case test asserts an admitted participant's issued token carries
  `hidden: false` across roles.
- **Source guard:** an architecture test scans the production Live source and fails if any file
  introduces a `hidden: true` literal (non-vacuous: it confirms it is scanning the real capability files
  and that its matcher detects an introduction).

## Alternatives considered

- **Allow hidden listeners (turn the seam on)** — rejected by owner policy: everyone who enters must be
  visible.
- **Remove the `hidden` field entirely** — rejected: it is the enforced-`false` value written into every
  grant and the input `capabilityDrift` uses to eject an externally-hidden participant; removing it would
  weaken the guarantee. The field stays, pinned false.
- **A role or permission for "audience-only / spectator"** — rejected: no new role, flag, permission,
  field, event, port, service, or API; visibility is not a capability the system grants selectively.

## Relationship to ADR 0019

0019 introduced the `hidden` seam as PROVISIONAL, pending Q59. This ADR **finalizes** that seam as
permanently `false` and records why it is kept. 0019's decisions are otherwise untouched and remain in
force; it is immutable and is not edited.
