# 0020 — Attendance snapshots are observations owned by a new attendance module (implementation HELD)

**State: ACCEPTED as designed (2026-09-23) — implementation HELD until the institution answers the attendance policy questions, especially [Q68](../open-questions.md#q68--what-counts-as-present-in-a-snapshot) and [Q69](../open-questions.md#q69--who-records-and-who-views-snapshots). Nothing here exists.**

**Status:** Accepted
**Accepted:** 2026-09-23, by the user, as designed. Implementation stays HELD until the attendance policy questions are answered (the user's ruling on Q40, recorded in [0016](0016-communities-module.md)).
**Date:** 2026-09-23
**Implementation:** HELD (decision 11)

**Supersedes in part** [0006](0006-event-architecture.md)'s attendance example
("`operations` records attendance when a live session ends",
`0006-event-architecture.md:9-10`) and module-boundaries.md's statement that
operations derives attendance from `live.session.ended`
(`module-boundaries.md:146-149`, `:241-243`). The rest of 0006 stands.
Operations' contract types (`AttendanceState`, `SessionRef`,
`AttendanceAmendment`) are unchanged. Builds on
[0016](0016-communities-module.md), [0017](0017-community-scoped-authorization.md)
and [0019](0019-community-scoped-live-sessions.md). **Nothing here lifts the
academic hold.** The design in full is [attendance.md](../attendance.md); the
summary is [the hub, §13](../communities-live-attendance.md#13-attendance-snapshot-model).

## Context

The brief (§13–15): during a live session a teacher presses "Record
attendance", and the system records who is present at that moment. Attendance
is not owned by LiveKit; LiveKit provides the observation and our database owns
the history. "Present" means exactly what product policy says, and nothing may
be silently defined: no minimum minutes, percentages, or late or leave
thresholds. The teacher, the owner and explicitly authorized managers can view
the record. An `attendance.snapshot.recorded` event with ids and minimal
metadata is defined; no notification is delivered.

**What exists today** (commit `9670c47`; every `file:line` citation in this
record, documents included, refers to that commit):

- There is no attendance module. Operations is contract-only: `AttendanceState
  = 'present' | 'absent' | 'late' | 'excused'`, a halaqa-keyed `SessionRef` and
  `AttendanceAmendment` (`operations/contracts/index.ts:7-19`), all on hold.
- Comments say operations turns live-session events into attendance
  (`operations/contracts/index.ts:1-6`; `live/domain/events.ts:3-7`). But
  `live.session.ended` carries no participants and is never published, and
  `RtcProvider` has no way to list participants (`rtc-provider.ts:56-79`).
- Identity grants `attendance.read` and `attendance.manage` role-wide. The
  precondition recorded under [Q31] is that a module must scope them through
  `ACADEMIC_RELATIONSHIPS` or leave them unexercised
  (`open-questions.md:817-826`).
- **The hold**: "Assignments, Attendance, Progress and Promotion do not start
  until this reconciliation has been reviewed"
  (`academic-reconciliation.md:19-21`), and §13's "before any new module" step
  (`academic-reconciliation.md:483-493`).
- LiveKit lists every stored participant in one unpaginated call, and its
  webhooks are dropped under load (L8 and L9 in
  [0019](0019-community-scoped-live-sessions.md)).

## Decision

Everything below is proposed. None of it exists today.

1. **A new leaf module, `attendance`, owns `AttendanceSnapshot`.** It imports
   LiveModule (`LIVE_SESSIONS`, `LIVE_PRESENCE`), CommunitiesModule
   (`COMMUNITY_AUTHORIZATION`) and IdentityModule (`ACCOUNT_DIRECTORY`, for
   names at read time). Nothing imports it except `app.module`. It never
   imports LiveKit, `operations/contracts` or academic. Live never imports
   attendance. If [Q70] ever links snapshots to operations' record, operations
   depends on `attendance/contracts`, never the reverse.

2. **A snapshot is one provider read.** Live's `LIVE_PRESENCE.observe` makes
   exactly one read of one live session's participant registry when someone
   allowed to record presses Record. The header holds `communityId`,
   `liveSessionId`, `hostUserId`, `recordedBy`, `clientRequestId`,
   `observationRule`, `observationStartedAt`, `observedAt`, `recordedAt`,
   `connectedCount` and `connectingCount`. Entries are
   `(snapshot_id, user_id)` with a connection of `CONNECTED` or
   `CONNECTING`: one per account, every role treated alike.
   Zero entries is a valid snapshot.

3. **It labels nobody present.** It stores no "present" flag, no role, no
   duration, no join time, no display name, no LiveKit identifier, no
   absentees and no halaqa id. Both connection states are kept, with separate
   counts. What counts as present is [Q68] (PROVISIONAL default: nothing is
   labelled).

4. **The observation rule is named and versioned: `provider_registry_v1`.**
   Live keeps standard participants whose identity maps to an account; drops
   disconnected ones; keeps hidden ones; drops egress, ingress, SIP, agent and
   unmappable identities (metered, never returned); maps `ACTIVE` to connected
   and `JOINING` / `JOINED` to connecting, with connected winning per account.
   A different rule gets a new id; old snapshots keep theirs.

5. **The observation is bracketed, and nothing is written before it
   succeeds.** It is refused (412) if Live's record is not live before the
   read **or after it**; this relies on Live saving `ended` before calling
   `endRoom` ([0019](0019-community-scoped-live-sessions.md)). No transaction
   is held across the provider call. A provider error, the deadline or an
   oversized answer returns 503 `attendance.observation_unavailable` through
   `FailureKind 'unavailable'` ([0021](0021-cross-cutting-rules-for-new-modules.md)).
   The engineering bounds are PROVISIONAL ([Q72]): a 15 s deadline, a ceiling
   of 10,000 entries, at most 4 observations at once per process.

6. **Idempotency is the database's.** `clientRequestId` is required
   (`^[A-Za-z0-9_-]{8,64}$`, otherwise 422). `UNIQUE (live_session_id,
   recorded_by, client_request_id)` decides. A replay is looked up before any
   observation and returns the stored snapshot with 200. Concurrent presses
   with the same key may each observe, but `INSERT … ON CONFLICT DO NOTHING
   RETURNING` lets exactly one win. A different key is a different snapshot:
   no time-window merge and no per-session cap. A PROVISIONAL rate limit of 6
   presses per 60 s per recorder bounds abuse ([Q72]).

7. **Immutable** (PROVISIONAL, [Q71]). A snapshot is never amended, voided or
   deleted through the application. Corrections belong to a future attendance
   record carrying `AttendanceAmendment`. Snapshots are kept like the audit log
   until [Q3] is answered; there is no per-person index and no erasure path.

8. **Authorization through community standing, never through
   `attendance.*`.** Routes are `@Authenticated()`. The use case asks
   `COMMUNITY_AUTHORIZATION` for `community.attendance.record` or
   `community.attendance.view`, acts reserved in
   [0017](0017-community-scoped-authorization.md) and added in P9 by a CHECK
   migration, with ceilings that use no `attendance.*` permission. It asks in
   the fixed fallback order of
   [attendance.md §11.3](../attendance.md#113-attendanceaccess-how-refusals-map)
   and moves to the next act only on a `forbidden` answer: to record,
   `community.attendance.record`, then `community.live.moderate`, then
   `community.live.host` for the session's host; to view,
   `community.attendance.view`, then `community.view` with the membership
   basis for the session's host or a recorder of it. So
   `communities.capability_required` becomes 403 `attendance.not_allowed` only
   when no act in that order permits (and on one snapshot, 404 even then).
   The community and the host come from `LIVE_SESSIONS.describe` when
   recording and from the stored header when reading; the client never
   supplies `recordedBy`, the participants or the recording community. Brief
   §9/§13/§15 default, PROVISIONAL ([Q69]): the owner, the session's host
   (while `community.live.host` holds), its moderators
   ([live.md §7.2](../live.md#72-liveaccess-host-and-moderators)) and a
   `community.attendance.record` grantee may record; the owner, the host or a
   recorder of the session (for its snapshots, while still a member) and a
   `community.attendance.view` grantee may view; the recorder need not be the
   host; there is no institution-wide oversight until [Q43] says otherwise;
   students and parents have no view. `attendance.read`, `attendance.manage`
   and `AttendanceState` are never used, and a test enforces it.

9. **One event.** `attendance.snapshot.recorded {snapshotId, communityId,
   liveSessionId, recordedBy, observedAt, connectedCount, connectingCount}`,
   with `aggregateId = liveSessionId`, so one session's snapshots form one
   ordered stream. Published after commit and after the audit entry; replays
   and failures publish nothing. It never carries participant ids or names. No
   subscriber is built ([Q67], [Q70]).

10. **What the snapshot is for stays open.** It is an observation, not the
    institution's attendance record: no `AttendanceState`, no absentees, no
    derivation, and nothing fills the app's halaqa attendance figures
    (PROVISIONAL, [Q70]).

11. **Implementation is HELD.** It waits for three things. First, [Q40]'s
    two gates (the PROVISIONAL default is that both apply): (a) the §13 step
    (Q35/Q36 and ADR 0015; `academic-reconciliation.md:483-493`) or the
    user's ruling on Q40 that it does not apply to attendance, and (b) the
    reconciliation review (`academic-reconciliation.md:19-21`) or the user's
    ruling on Q40 that live-presence snapshots are outside the Attendance
    hold. Second, [Q69] settled: reviewers accepting community standing,
    instead of `ACADEMIC_RELATIONSHIPS`, as the scoping relationship §13
    requires, and the user confirming or replacing its record and view
    defaults. Third, community-scoped, persisted live sessions (P6). If the hold
    is lifted by the review rather than by a ruling that snapshots are outside
    it, P9 also waits for §13's Attendance row
    (`academic-reconciliation.md:504`): [Q8] and [Q12] answered, or ruled by
    the user not to apply to snapshots.

## Consequences

If accepted:

- A snapshot says exactly what the provider held at the press, and nothing
  about policy. "Present", "absent" and "late" remain for [Q68] and [Q70].
- LiveKit's own lag is recorded as it is, not corrected: a participant whose
  transport failed stays in the registry for a few seconds. There is no retry,
  no merge and no grace period of our own.
- A double press, or a retried request, yields one snapshot.
- The Q31 precondition is neither triggered nor answered by accident, and the
  design does not rule itself outside the hold.
- Live gains two contracts and one port method; attendance learns nothing
  about LiveKit. The dependency graph stays acyclic: attendance is a leaf.
- The comments that say operations derives attendance
  (`operations/contracts/index.ts:1-6`, `live/domain/events.ts:3-7`) are
  corrected in P0.
- The latency of one listing at a few thousand participants is unmeasured;
  the PROVISIONAL bounds are calibrated in load tests (P8).

## Alternatives considered

- **Operations owns snapshots.** Rejected: operations' charter is
  delivery-agnostic (`module-boundaries.md:146-149`); its `SessionRef` is
  keyed on a halaqa and a schedule; it would start the held work; and the
  event would not be the brief's `attendance.snapshot.recorded`.
- **Live owns and stores snapshots.** Rejected: the brief says Live does not
  own attendance history, and module-boundaries.md says Live must not know
  about attendance.
- **Derive attendance from `live.session.ended`** (the documented design).
  Rejected: the event carries no participants and is never raised; the brief
  asks for the moment of the press; and an event must not be used to ask a
  question.
- **A presence ledger built from LiveKit webhooks.** Rejected: webhooks are
  dropped under join storms (L9), no webhook route exists, and a ledger
  invites the duration rules the brief forbids.
- **A roster sent by the teacher's app.** Rejected: spoofable, blind to hidden
  participants, and the app has no LiveKit client.
- **Realtime WebSocket presence, or a Redis presence set.** Rejected: an app
  socket on one API instance is not media presence, and a Redis set would be a
  second, drifting copy of what the SFU holds.
- **A persisted `OBSERVING → RECORDED | FAILED` state machine** with an
  abandonment sweeper. Rejected: it guards a window this design never opens
  (nothing is written before the observation succeeds), stores failures as
  business rows, and needs job infrastructure that does not exist.
- **A per-session cap on snapshots.** Rejected: a lifetime cap is policy on how
  often attendance may be taken ([Q72]). A per-recorder rate limit bounds abuse
  without that meaning.
- **Owner or grant only; recording does not imply viewing.** Not the default,
  because it departs from brief §13/§15; left to [Q69].
- **Identity ceilings `attendance.manage` / `attendance.read`, plus a new
  `attendance.oversee`.** Rejected: it exercises the unscoped grants against
  the Q31 precondition, needs a migration that breaks the exact grant-delta
  test, lets the role matrix silently decide delegation, and puts oversight in
  one consumer module.
- **A boolean or three-valued capability check keyed by user id.** Replaced by
  `COMMUNITY_AUTHORIZATION` ([0017](0017-community-scoped-authorization.md)),
  which receives the `Principal` and distinguishes 404 from 403.
- **A live role on each entry** (host, speaker, listener). Rejected: not
  required by the brief, it couples attendance to Live's vocabulary, and the
  record and the SFU can disagree about it ([Q5]). It can be added if [Q68]
  needs it.
- **Keep a snapshot when the session ends during the read.** Rejected: a
  listing taken during teardown can be an artefact of the teardown itself.
- **A rule that lists only fully connected accounts** (`connected_v1`).
  Rejected: it silently decides that people joining or reconnecting are
  absent, exactly when teachers press, and throws that fact away for good.
- **Exclude hidden participants.** Rejected: hidden is a display grant, and
  hidden listeners are still connected members.
- **Reuse `AttendanceState` on entries, or record absentees.** Rejected:
  "present", "absent" and "late" are policy words, `AttendanceState` is
  unconfirmed, and absentees need a definition of "expected" and a roster of up
  to 30,000 at time T.
- **Time-window de-duplication, or an in-process single flight.** Rejected: a
  window silently merges intended presses and is itself policy; a single
  flight is wrong across API instances. The client key and the UNIQUE
  constraint are enough.
- **A lock or transaction held across the provider call.** Rejected: it would
  hold a pooled connection for up to the deadline on every press, on a single
  VPS.
- **Accept with 202 and take the snapshot in a background job.** Rejected: no
  job infrastructure or outbox exists, and a delay widens the gap between the
  press and the read.
- **Participants as an array or `jsonb` on the header.** Rejected: the
  database could not enforce one entry per account, and paging would be
  impossible.
- **Display names, join times or LiveKit ids on entries.** Rejected: names
  belong to identity and are resolved at read time; join times reset on
  reconnect and invite lateness rules; LiveKit ids are infrastructure.
- **One contract combining session scope and presence.** Rejected: the benign
  question (which community, is it live) and the sensitive one (who is
  connected) need different import allow-lists. `LIVE_PRESENCE` is importable
  by attendance only.
- **Routes under `/groups/:id/live/sessions/:id/attendance`.** Rejected: every
  controller is prefixed by its own module, and the client would supply a
  community id the server must then distrust.
- **`aggregateId = snapshotId`.** Rejected for `liveSessionId`, so a session's
  snapshots are one ordered stream.
- **Treat snapshots as outside the hold without asking.** Rejected: the user's
  constraint is unqualified; lifting it is the user's decision ([Q40]).

[Q5]: ../open-questions.md#q5--what-happens-when-the-media-provider-and-our-record-disagree
[Q3]: ../open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history
[Q8]: ../open-questions.md#q8--who-may-amend-attendance-and-is-a-reason-mandatory
[Q12]: ../open-questions.md#q12--timezone-and-academic-calendar
[Q31]: ../open-questions.md#q31--teaching-scope-and-what-staff-may-see
[Q40]: ../open-questions.md#q40--governance-which-gates-apply-to-the-new-modules
[Q43]: ../open-questions.md#q43--institutional-oversight-of-communities
[Q67]: ../open-questions.md#q67--notifications-for-community-live-and-attendance-facts
[Q68]: ../open-questions.md#q68--what-counts-as-present-in-a-snapshot
[Q69]: ../open-questions.md#q69--who-records-and-who-views-snapshots
[Q70]: ../open-questions.md#q70--is-a-snapshot-the-attendance-record
[Q71]: ../open-questions.md#q71--correcting-retaining-and-erasing-snapshots
[Q72]: ../open-questions.md#q72--when-and-how-often-snapshots-are-taken
