# 0024 — Notification policy for P10 (answers Q67 and the P10 scope of Q28)

**State: ACCEPTED (2026-10-06) — records the owner's initial, reversible notification policy that
unblocks P10 Notifications. It answers [Q67](../open-questions.md#q67--notifications-for-community-live-and-attendance-facts)
and the P10 scope of [Q28](../open-questions.md#q28--what-deserves-a-notification-and-how-loudly). It
does NOT implement P10 — no translators, vocabulary, catalog, dispatcher, relay, push, or Flutter
change is made by this record.**

**Status:** Accepted. Resolves the notifications deferral recorded by
[0023](0023-attendance-authorization-and-policy.md) (its Q69b note) and
[0020](0020-attendance-snapshots.md) (decision 9, "no notification" for P9); **preserves the T2/outbox
gate** of [0021](0021-cross-cutting-rules-for-new-modules.md). Supersedes no earlier decision.
**Decided:** 2026-10-06, by the owner; **reversible** (this is the initial/default policy, not a
permanent contract).
**Date:** 2026-10-06

## Context

P10 (notification translators) was blocked only on **Q67** (which community, live and attendance facts
notify, and how loudly) and the P10 scope of **Q28** (notification policy)
([communities-live-attendance.md §25](../communities-live-attendance.md#25-implementation-phases)).

The substrate already exists: the source modules publish the relevant events
(`communities.*`, `live.*`, `attendance.snapshot.recorded`); the notifications module has the
dispatcher, realtime relay, push delivery (logging provider; no APNs/FCM SDK yet), per-category
per-channel preferences, and the `IN_APP / REALTIME / PUSH` channels; recipient contracts
(`COMMUNITY_CAPABILITY_HOLDERS`, `LIVE_AUDIENCE`, `COMMUNITY_MEMBERSHIP`) are available. What was
missing was **policy**, which the brief declined to decide and ADR 0020 decision 9 / ADR 0023 deferred
to P10/Q67. No notification vocabulary (type / category / target kind) exists for community, live or
attendance facts today — only `MESSAGES` is active; assignments/announcements/certificates/halaqat are
reserved-inactive.

## Decision (owner, 2026-10-06; reversible)

**The policy below is the initial/default and must remain changeable** through the notification
**catalog and contracts** (a type is activated by one catalog line plus a translator; a type can be
disabled; channels/recipients/priority are policy, not scattered conditionals). It is **not** an
irreversible architectural assumption. No speculative generic policy framework, premature configuration
infrastructure, or database-backed admin policy system is introduced — future flexibility is delivered
only through clean contracts and the existing architecture, at P10.

**Per-event policy** (canonical; other documents point here and do not duplicate it):

| Event | Channels (default) | Recipient | Notes |
| --- | --- | --- | --- |
| `communities.member.added` | IN_APP + PUSH | the affected member | |
| `communities.member.removed` | IN_APP + PUSH | the affected member | only on an actual removal (`reason: REMOVED`); a self-initiated `LEFT` is not notified |
| `communities.capability.granted` | IN_APP + PUSH | the grantee | |
| `communities.capability.revoked` | IN_APP + PUSH | the affected member | |
| `communities.ownership.transferred` | IN_APP + PUSH | the new owner | |
| `communities.community.locked` / `.unlocked` | none | — | realtime-frame behaviour unchanged |
| `communities.community.created` | none | — | the creator's own act |
| `communities.invitation.created` / `.revoked` | none | — | link/admin fact; the token is shown once |
| `live.session.started` | IN_APP / REALTIME to the applicable audience | the community's live audience | **PUSH is NOT default for the whole community**; push only via an explicit opt-in/preference; large-audience fan-out must not become default push spam |
| `live.speaker.requested` | IN_APP / REALTIME | moderators / applicable moderation recipients | push optional per preference |
| `live.speaker.granted` | IN_APP / REALTIME + PUSH | the requesting user | |
| `live.session.ended`, `live.speaker.declined` / `.revoked` / `.withdrawn` / `.expired`, `live.screen_share.started` / `.stopped` | none | — | realtime/in-session behaviour unchanged |
| `attendance.snapshot.recorded` | IN_APP + PUSH | holders of `community.attendance.view` | **students/participants are NOT notified by default**; repeated recording presses must not spam — notifications may be collapsed/grouped, the grouping defined at P10 implementation (no fixed window invented here) |

**Academic facts remain deferred** — `academic.student.enrolled`, `academic.teacher.assigned`, their
enrollment/assignment endings, and the `academic.section/program/halaqa.*` lifecycle events are **not**
activated; a separate future policy decision governs them.

**Messaging is unchanged** — `messaging.message.sent`, `messaging.conversation.created`,
`messaging.participant.added` stay active; `messaging.message.read` stays non-notifying. P10 does not
redesign messaging notifications.

**Delivery remains best-effort.** No guaranteed delivery and no transactional outbox is introduced; the
**T2/outbox gate ([ADR 0021](0021-cross-cutting-rules-for-new-modules.md)) is preserved** for a future
explicit decision (it would land with P11 if a guarantee is ever required). Recipients are resolved
through the existing contracts **at delivery time**, and a notification never grants access — opening
one re-runs the owning module's own view check.

## Consequences

- **P10 is unblocked for this scope.** Implementing it (a later, explicitly-requested task) is: one
  translator per notified fact importing only the source module's `contracts`; new
  `NOTIFICATION_TYPES` / `NOTIFICATION_CATEGORIES` / `targetKind` for the community, live and attendance
  facts (none exist today) plus their catalog lines and default channel preferences; no change to any
  publisher, the dispatcher, the relay, or the push port; no outbox; no schema change beyond the
  additive notification rows the dispatcher already writes.
- The notification **vocabulary/catalog stays extensible**: adding or disabling a fact is a catalog
  line (+ translator), decided explicitly — so this policy can change without redesigning the engine.
- Privacy defaults (students not told of snapshots; no community-wide live push) are conservative and
  reversible.

## Alternatives considered

- **Guaranteed delivery / outbox now** — rejected; best-effort suffices initially, and a guarantee is
  P11 scope (ADR 0021 T2), left gated.
- **Push-by-default for `live.session.started` to the whole community** — rejected; notification spam
  at community scale. Push is opt-in for this fact.
- **Notifying students/participants of a snapshot by default** — rejected on privacy grounds; the owner
  may revisit.
- **Activating academic categories now** — deferred to a separate policy (Q28 future categories, and
  parent-of-child visibility, which is unresolved).
- **A generic, database-backed, admin-editable notification-policy framework** — rejected as premature
  over-engineering; the policy lives in the catalog/contracts and changes by explicit decision.

## Deferred sub-decisions (explicitly NOT resolved here)

- **Q28, still open:** academic / future notification categories; parent-of-child visibility;
  collapsing/grouping specifics beyond the attendance anti-spam rule; large-channel (e.g. 2,000-member)
  behaviour; priority / always-deliver power and who may wield it; detailed per-role push defaults.
- **Guaranteed delivery** (transactional outbox, ADR 0021 trigger T2) — a future decision, with P11.
- **A real push provider** (APNs/FCM SDK) — still deferred (P7b / Q24); today's provider only logs.
