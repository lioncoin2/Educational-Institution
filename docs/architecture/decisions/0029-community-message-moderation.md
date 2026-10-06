# 0029 — Community message moderation: delete, review, retention

**State: ACCEPTED (2026-10-07) — Q51/Q23. A moderator may DELETE any message in a community's chat; the
message becomes a tombstone (its body and attachments blanked in every normal read path), its original is
REVIEWABLE for exactly 7 days by a moderator, and RETENTION then wipes the original for good while the
tombstone row remains. Moderation authority is the new delegable Community capability
`community.messages.moderate` — the single delegable-capability ceiling `communities.moderate` (ADR 0017),
NEVER identity's `messaging.manage` — asked of Communities per request; it is NOT chat read, NOT a
projected participant row, and it never grants read. Scope is community CHANNEL conversations only. No new
identity permission, role, generic moderation framework, or cross-module deletion contract is introduced.**

**Status:** Accepted.
**Decided:** 2026-10-07, by the owner (Q51/Q23; the policy and architecture below were approved to proceed).
**Date:** 2026-10-07
**Reversible** by a new ADR.

**Builds on** [0018](0018-community-chat-projection.md) (a community chat is a `CHANNEL` conversation whose
participant rows are messaging's named projection of Communities' membership, never an access answer on
their own) and [0017](0017-community-authorization.md) (the single delegable-capability ceiling
`communities.moderate`). It **re-answers** the [Q23](../open-questions.md#q23--moderation-deletion-and-review)
and [Q51](../open-questions.md#q51--the-community-chat-who-may-post) open questions, whose "when answered"
notes reserved `community.messages.moderate` for this slice. No prior ADR's text is edited. The living
design is [community-chat.md §21](../community-chat.md#21-message-moderation-q51q23) and
[messaging.md](../messaging.md).

## Context

[Q51](../open-questions.md#q51--the-community-chat-who-may-post) deferred "who may delete or moderate
others' messages" and [Q23](../open-questions.md#q23--moderation-deletion-and-review) deferred deletion,
review and retention. The schema was already moderation-ready (P4/P2): `messages.deleted_at`, a tombstone
in every read path (`asSeen`), and a CHECK that permits a wiped body. `community.messages.moderate` was a
reserved name beside `COMMUNITY_CAPABILITIES`. The owner now decides the full policy; this slice builds it.

There are **three distinct concepts**, and the design keeps them apart: **read access** (membership —
`community.chat.read`), **moderation authority** (the new capability + standing), and **deleted-message
review** (a separate, audited operation). Holding one never implies another.

## Decision

1. **A new Community capability, `community.messages.moderate`.** A delegable capability the owner holds
   implicitly and may grant to a member (one grant per capability, R7), exactly as the attendance acts are
   (ADR 0017). Its standing ceiling is **`communities.moderate` alone** — never identity's `messaging.manage`,
   which the provisional role matrix gives to the OWNER role only, so requiring it would deny every teacher
   and every delegated moderator the act. Its lifecycle gate is **`always`**: content moderation is
   management, open even while the community is LOCKED, as member removal and live moderation are. No
   oversight reaches it (`communities.manage` never reads or moderates a community's chat — Q43). Adding it
   to the closed vocabulary is the whole mechanism: the grant DTO, the delegation/revoke/list use cases and
   the grant CHECK migration (`0017_community_messages_moderate.sql`) are all vocabulary-driven and needed no
   new code.

2. **Authority is asked of Communities, per request, from the message's own community.** The delete and the
   review resolve the conversation, require it to be a community chat, and ask
   `COMMUNITY_AUTHORIZATION.authorize(principal, conversation.communityId, 'community.messages.moderate')`
   (via `CommunityChats.mayModerate`). It is **never** decided from the projected participant rows and
   **never** from `community.chat.read`. A grant in community A therefore gives nothing in B; a non-member
   is the 404 any non-member hears; a member without the capability (a student) is 403
   `messaging.message_moderation_forbidden`; Communities unreachable is 503.

3. **Delete is a soft delete — a tombstone.** `MessagingRepository.softDeleteMessage` stamps `deleted_at`
   and `deleted_by` in one idempotent, atomic statement (set only if unset, so a repeat or a concurrent
   delete cannot clobber the first delete's stamps and raises no second event or audit). The body and
   attachment rows are KEPT for the review window. `asSeen` already blanks a deleted message's body and
   attachments in every normal read path, so a retained body never leaks; `MessageView` carries `deleted_at`
   (that it is gone) but not `deleted_by` (who acted). The actor is `principal.userId`, never a field in the
   request.

4. **Review reveals the original for exactly 7 days, audited.** A separate, capability-gated operation
   (`POST …/messages/:messageId/review`, a POST because it is a sensitive, audited disclosure — never a
   cacheable GET) returns the ORIGINAL body, attachments and `deleted_by` through the one un-tombstoned
   renderer (`MessagingViews.reviewed`). It is reachable only with `community.messages.moderate`, only while
   `now < deleted_at + 7d`, and it widens neither `messaging.read` nor `community.chat.read`. Past the
   window it is 404 `messaging.deleted_message_review_expired`; a message that is absent or not deleted is
   404 `messaging.deleted_message_not_found`.

5. **Retention wipes the original after the window; the tombstone remains.** `MessageRetentionSweeper` (the
   `CommunityChatSweeper` pattern — boot tick, unref'd interval, single-flight) calls
   `purgeDeletedBefore(now − 7d, batch)` to null the body and delete the attachment rows of messages
   deleted on or before the cutoff. The review bound (`now < deleted_at + 7d`) and the retention bound
   (`deleted_at + 7d ≤ now`) are complementary, so the 7-day boundary is deterministic with neither gap nor
   overlap. Retention **never hard-deletes a message row** (ordering, read state and the tombstone survive)
   and is a pure backstop: the review use case refuses past the window whether or not retention has run.

6. **Realtime is a content-free hint.** A new `messaging.message.deleted` event (ids and the sequence only;
   never the body, never who deleted it) is relayed as a `message.deleted` frame to the same audience the
   send reached — current members who can see that sequence. The client marks the sequence a tombstone or
   re-reads over HTTP; the original is reachable only through the audited review, never the wire. The
   moderator's identity is in the audit trail, never on any subscriber's stream.

## The attachment / Files boundary (owner STOP-gate)

Deleting and later wiping a community-chat message is **self-contained within messaging** and requires **no
new Files-side lifecycle contract and no destructive cross-module behaviour**:

- `message_attachments.message_id` → `messages.id` is `ON DELETE CASCADE`, and retention deletes the
  attachment *reference* rows directly — both are messaging-owned rows.
- `message_attachments.file_asset_id` is a plain text reference, **not** a foreign key into Files. The
  `FileAssets` contract exposes `describe` / `verifyAttachable` / `createDownloadLink` and **no**
  delete/release/detach method. Messaging never deletes a file asset and never could.
- The file bytes are Files' own to retire under its own retention; a now-unreferenced asset is Files'
  concern. Messaging inventing cross-module deletion here is exactly what the STOP-gate forbids, and it does
  not — it removes only its own rows.

## What this changed (and only this)

- **Communities:** `community.messages.moderate` added to `COMMUNITY_CAPABILITIES`, `ACT_RULES`
  (ceiling `communities.moderate`, no oversight) and `GATE_OF_ACT` (`always`). Grant CHECK migration
  `0017_community_messages_moderate.sql`. Grant/revoke/list are vocabulary-driven — unchanged.
- **Messaging domain:** `Message.deletedBy`; `MessageDraft` omits it; `asSeen` keeps it internal.
  `messages.deleted_by` column + CHECK `(deleted_at is null) = (deleted_by is null)` (same migration).
  Port: `softDeleteMessage`, `purgeDeletedBefore` (both stores). New event `messaging.message.deleted`.
- **Messaging application:** `CommunityChats.mayModerate`; `ModerateMessageUseCase`,
  `ReviewDeletedMessageUseCase`; `MessageRetentionSweeper`; `MessagingViews.reviewed` (the one
  un-tombstoned render); audit actions `moderation.message_deleted` / `moderation.message_reviewed`.
- **Messaging API:** `DELETE …/conversations/:c/messages/:m` (204, idempotent) and
  `POST …/conversations/:c/messages/:m/review` — both `@Authenticated()` at the edge, the decision in the
  use case. New `ReviewedMessageResponse`.
- **Realtime:** `messageDeletedFrame` (hint); the relay subscribes to `messaging.message.deleted` and
  delivers it to the visible-sequence audience.

## Consequences

- An owner or a delegated moderator can remove abuse from a community chat at once; a reader sees a
  tombstone; the original is reviewable for 7 days and then gone.
- Reading a community chat is unchanged and still rests on membership; moderation never opens it, and a
  student who can read cannot delete or review.
- No new identity permission (the `permissions` table is untouched), no role, no generic moderation
  framework, and no extension to Live, Attendance, Academic, Files, Profiles, Notifications or private
  conversations.
- **Flutter is deferred:** the HTTP and realtime contracts are prepared; no app UI is built in this slice.

## Alternatives considered

- **Require `messaging.manage` in the ceiling** — rejected: that identity permission is the OWNER role's
  alone (provisional-policy.ts), so it would restrict moderation to the system owner and break the owner
  policy (owner/moderator/teacher moderate). The community capability + `communities.moderate` is the
  correct, delegable authority.
- **Hard-delete the message row on moderation** — rejected: it would break ordering, read state and the
  audit trail, and leave no tombstone. Soft delete + a content wipe after the window is the design the
  schema was built for ("a CHECK that permits a wiped body").
- **A GET for review** — rejected: review is a sensitive, audited disclosure; a POST is never cached or
  prefetched.
- **Put the moderator on the deletion frame, or the body** — rejected: the frame is a hint (ids + sequence);
  the moderator is audit-only and the original is review-only.
- **Delete the file asset at retention** — rejected / out of scope: there is no Files deletion contract, and
  asset lifecycle is Files' own (see the boundary above).
- **A generic cross-module moderation framework** — rejected: a community-scoped capability and two use
  cases reuse the existing patterns; a framework would over-reach the slice.
