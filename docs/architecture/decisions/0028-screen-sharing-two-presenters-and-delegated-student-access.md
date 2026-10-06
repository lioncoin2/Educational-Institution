# 0028 — Screen sharing: two presenters, and delegated student access

**State: ACCEPTED (2026-10-06) — Q56. A live session allows up to TWO concurrent screen sharers.
Owner/Moderator/Teacher present by right (a session moderator holding identity's `live.speak`); a
Student presents only under an explicit, session-scoped PresenterGrant a moderator opens for them. The
two-slot cap is counted under the session's lock (the speaker floor's pattern), never from a LiveKit
participant count. No new role, community permission, generic approval framework, or persistent entity is
introduced — the existing Presenter architecture is evolved. Screen audio stays disabled.**

**Status:** Accepted.
**Decided:** 2026-10-06, by the owner (Q56; the policy and architecture below were approved to proceed).
**Date:** 2026-10-06
**Reversible** by a new ADR.

**Supersedes in part [0019](0019-community-scoped-live-sessions.md)** — its provisional presenter design
(decision 6's `MAX_CONCURRENT_PRESENTERS = 1`, and decision 7's "a moderator holding `live.speak`, for
themself"), and the **"Resolved for the current product (2026-09-27)"** note in the
[Q56 open question](../open-questions.md#q56--screen-sharing) that students "MUST NOT receive
screen-share authority." Per the immutable-ADR convention, ADR 0019's decision text is **not rewritten**;
this record states what it replaces, and the Q56 open-question record is re-answered. Builds on
[0026](0026-live-participant-control-and-media-reset.md) (Room Reset) and the Q64 kick semantics. The
design is [live.md §6](../live.md#6-the-presenter-slot-screen-share).

## Context

[Q56](../open-questions.md#q56--screen-sharing) asked who may share their screen, how many at once, and
whether a student may. The module was built (P6) with a provisional answer: ONE presenter, a moderator
holding `live.speak`, claiming for themself; the student path was deferred as "additive, through the
presenter grant's `grantedBy` seam." The discovery confirmed the seam and the evolution path. The owner
now decides the full policy.

## Decision

1. **Two concurrent screen sharers.** `MAX_CONCURRENT_PRESENTERS = 2`. The cap bounds the number of
   **open PresenterGrants** (authorized presenters), not active media tracks — authority and "currently
   publishing a screen track" are distinct; a grant is authority, held across the client starting and
   stopping the track.

2. **The database is the concurrency authority.** A grant is opened by
   `PresenterGrantRepository.openWithinCap(grant, cap, moderation)` — a compare-and-set under the
   session's row lock that counts the open grants and answers `opened` / `held` / `slots_full` /
   `session_not_live`, exactly as the speaker floor's `grantWithinCap` does. Two concurrent attempts for
   the last slot resolve to one `opened` and one `slots_full`; three can never open. A per-`(session,
   user)` partial unique index is the backstop the lock makes unreachable. **LiveKit's participant count
   is never the authority** (it is eventually-consistent, per-instance, and empty right after a reset);
   the reconciler is a backstop, not the gate. This is correct before and after horizontal scale (P11).

3. **By-right presenters.** An owner/moderator/teacher — a session moderator (`LiveAccess`, within the
   existing `community.live.moderate` / host-`community.live.host` model) holding identity's `live.speak`
   — claims a slot for themself (`grantedBy === userId`). A by-right presenter who loses `live.speak` has
   their grant closed by the reconciler, as before.

4. **Delegated student presenters.** A moderator grants a Student a slot with `grantedBy` the moderator
   and `userId` the student. The student presents by that grant alone — `capabilitiesFor` gives
   `canPublishScreen` to a delegated presenter **without** `live.speak` and **without** the microphone.
   **The student never receives `live.speak`**, and **never a community permission**: the authority is
   the session-scoped grant. The student cannot self-claim (the coarse `live.moderate` ceiling refuses
   them) and cannot self-grant (the grant is a moderator act). The target is validated server-side as a
   current participant; the path parameter names the target only, never authority.

5. **The grant is session-scoped and persistent within the session.** It survives the student stopping
   and restarting the screen track (the track is the client's; the grant is unchanged) — **no re-approval
   per share**. It survives a **Q64 Room Reset** (the epoch moves and tracks drop with the old room, but
   grants are not closed; on re-join the student's capability is restored) and a **Q64 Kick** (a
   disconnect, not a ban; the grant remains, and re-entry restores the screen). It ends only when the
   student relinquishes it (stops at the backend), a moderator **revokes** it, or the session ends.

6. **Revoke** closes the grant (`revoke_presenter`), pushes the capability off at once
   (`RTC_PARTICIPANTS.updateCapabilities`, which unpublishes the live track), announces
   `live.screen_share.stopped`, and audits. A revoked student cannot present again without a new grant.

7. **Runtime, not reconnect.** Granting and revoking take effect through `LiveMedia.push` →
   `updateCapabilities`; no reconnect is required. **`canPublishScreenAudio` stays `false`** — this
   decision does not enable screen audio.

## What this changed (and only this)

- `MAX_CONCURRENT_PRESENTERS: 1 → 2`.
- The repository port and both stores: `active()` → `activeGrants()`; `open()` → `openWithinCap(cap)`
  (outcome `occupied` → `slots_full`); the Postgres single-open-per-session unique index →
  one-open-per-**user** (migration `0016`), the cap counted under the lock.
- `ParticipantStanding` gains `presenterDelegated`; `capabilitiesFor` grants the screen to a delegated
  presenter without `live.speak`; `LiveStanding` reads the open grants as a set.
- The reconciler steps every grant-holder, and its "no `live.speak` ⇒ close the grant" rule now applies
  only to **by-right** presenters — a delegated student is not closed for lacking `live.speak`.
- `PresenterUseCase`: `claim` (by-right, capped), `grant` (delegated, moderator→student), `stop` (self),
  `revoke` (moderator→target). Two new routes: `POST …/screen-share/:userId/grant`,
  `DELETE …/screen-share/:userId`. The API `presenterUserId` becomes `presenterUserIds: string[]`.
- Realtime and audit are unchanged in shape: `screenShareStarted` / `screenShareStopped` already carry
  `userId` and `grantedBy` / `stoppedBy`, so they describe either presenter kind, and each is delivered
  as a `live.session.changed` hint.

## Consequences

- A session can have two screens at once; a third claim or grant answers 409 `live.presenter_slots_full`.
- Students can present when a teacher explicitly allows it, and only then; the authority is ephemeral and
  auditable, and disappears at the session's end.
- No Redis, no outbox, no notifications, no new persistent entity, no generic permission framework.
- **Flutter is deferred**: no media binding, no `livekit_client`, no screen-capture, no screen-share UI.
  The HTTP/realtime contracts are prepared (`presenterUserIds`, the grant/revoke routes) for a later
  reviewed media phase.

## Alternatives considered

- **LiveKit participant count as the cap** — rejected: racy, per-instance, stale after a reset; the DB
  CAS is the authority (ADR 0019: Postgres is the truth, LiveKit converges).
- **A `community.live.screen_share` capability for students** — rejected: that would be a persistent,
  cross-session permission; the per-session grant is the correct scope (owner policy, point 6/8).
- **A second StudentScreenShare entity / generic approval framework** — rejected: the PresenterGrant's
  `grantedBy` seam already models a delegated grant; a second system would duplicate the rules.
- **Giving a student `live.speak` to enable the screen** — rejected: that would also give the microphone
  and conflate floor with screen; the delegated grant gives the screen alone.
- **Enabling screen audio** — out of scope: this decision does not enable it.

## Relationship to ADR 0019 and the Q56 open question

0019 introduced the presenter slot as PROVISIONAL (one presenter, moderators only, pending Q56). This ADR
answers Q56: two presenters, and delegated student access through the `grantedBy` seam 0019 reserved. It
**supersedes in part** 0019's provisional presenter cap and self-claim-only rule, and the Q56
open-question's 2026-09-27 "students MUST NOT present" resolution. 0019 remains immutable and otherwise in
force; its text is not edited.
