# 0018 — Community chat: messaging keeps a named, versioned projection of community membership

**State: ACCEPTED (2026-09-23) — implemented in P4. Until then nothing here exists.**

**Status:** Accepted
**Accepted:** 2026-09-23, by the user (the architecture design was approved to proceed; the Q40 ruling is recorded in [0016](0016-communities-module.md)).
**Date:** 2026-09-23

**Supersedes [0011](0011-messaging-v1.md) §4–5 in part**: for a conversation
linked to a community, messaging no longer owns membership. Its own add,
remove and leave are refused, its caps do not apply, and "member" means a
Communities permit plus a projected row. For every other conversation 0011
stands unchanged. **Amends** [messaging.md](../messaging.md) and the doc
comment of `MESSAGE_RECIPIENTS` (`message-recipients.ts:13-20`). Builds on
[0007](0007-messaging-architecture.md) (one conversation model),
[0012](0012-realtime-messaging-transport.md),
[0013](0013-notifications-v1.md), [0016](0016-communities-module.md) and
[0017](0017-community-scoped-authorization.md). The design in full is
[community-chat.md](../community-chat.md).

## Context

The brief (§6): do not build a second message system. Communities owns who
belongs; messaging owns what messages exist and how they are delivered.
Messaging must be able to ask "may this principal send? read? who receives
this?" without importing Communities' infrastructure, and the design must say
whether the existing recipient contract can be extended.

**What exists today:**

- Messaging owns membership in `conversation_participants`, one row per
  (conversation, user). The row also carries the read watermark and the
  history window. Membership is checked by `ConversationAccess.member`
  (`conversation-access.ts:58-72`) and again under the conversation row lock
  when a message is appended.
- Caps: `GROUP` 500, `CHANNEL` 10,000, 200 per request
  (`messaging-policy.ts:20-27`).
- `ConversationType` is closed, `'DIRECT' | 'GROUP' | 'CHANNEL'`
  (`vocabulary.ts:11`), and the database checks it
  (`messaging/infrastructure/schema.ts:53`).
- MessagingModule exports exactly `MESSAGE_RECIPIENTS` and `MESSAGE_DELIVERY`
  (`messaging.module.ts:108`), and both realtime and notifications import it.
  `MESSAGE_RECIPIENTS` promises that delivery modules never keep a copy of
  membership (`message-recipients.ts:13-20`), and already has an
  `onlyUserIds` probe (`message-recipients.ts:40-44`).
- The event bus is in-process with no durability
  ([0006](0006-event-architecture.md); `event-bus.ts:43-56`).

Watermarks, windows, unread counts and "my conversations" are computed on
per-member rows, so messaging needs a row per member whatever the design. The
real questions are who writes those rows and which way the dependency points.

## Decision

Everything below is proposed. None of it exists today.

1. **One authority.** Communities alone decides who belongs and whether P may
   read or post in C now. Messaging owns conversations, messages, attachments,
   ordering, watermarks, history windows, and the link from a community to its
   chat.

2. **Messaging pulls; it exports no write port.** MessagingModule imports
   CommunitiesModule. Only `messaging/application` imports
   `communities/contracts`; `messaging/domain` never does. There is no
   `forwardRef`, and MessagingModule still exports exactly
   `[MESSAGE_RECIPIENTS, MESSAGE_DELIVERY]`. Communities never imports
   messaging.

3. **A community chat is an ordinary conversation.** At most one per
   community: the existing `CHANNEL` type (PROVISIONAL, [Q51]) plus
   `conversations.community_id` under a partial UNIQUE index. No new
   `ConversationType`. The title is NULL in storage and read from
   `COMMUNITY_DIRECTORY` when viewed. Messaging creates the chat itself,
   idempotently (`INSERT … ON CONFLICT (community_id) DO NOTHING`, then read),
   on the first positive permit, in the sync or in the sweeper. Creating it
   raises no event and writes no audit entry.

4. **Rules for a linked conversation override its type.**
   - Reading needs a `community.chat.read` permit and an active projected row.
     Posting needs a `community.chat.post` permit; otherwise the existing 403
     `messaging.posting_not_allowed`. After the post permit comes the capacity
     switch (decision 12): if the conversation's `member_count` is above
     `communityChatMaxServedMembers`, 412
     `messaging.community_chat_over_capacity`.
   - Listing participants: the existing 403 `messaging.members_hidden`. The
     roster is Communities' (`community.members.view`, [Q22]).
   - Add, remove (the owner route and the `messaging.manage` route) and leave:
     412 `messaging.membership_managed_by_community`, evaluated after the
     membership check, so a non-member still gets 404.
   - No messaging member cap. `canPost` is whether the `community.chat.post`
     permit is granted and `member_count` is within
     `communityChatMaxServedMembers`. `canManageMembers` is false; `myRole` is
     `MEMBER`.
   - History for newcomers: `COMMUNITY_HISTORY = 'FULL'` (PROVISIONAL, [Q52]).
     A rejoin starts a new window and a new watermark.
   - No system notices in the chat (PROVISIONAL, [Q53]).

5. **The rows are a named, non-authoritative projection.** For a linked
   conversation, `conversation_participants` rows project Communities' ACTIVE
   members. Three new columns carry the source: `source_version`,
   `source_membership_id` (the stint id, which decides rejoins; timestamps are
   never compared) and `source_joined_at` (provenance only), under the shape
   CHECK `conversation_participants_source_shape` (the three are all NULL or
   all set, `source_version > 0`, and such rows are `MEMBER` with `added_by`
   NULL). Each row is a last-writer-wins register keyed by the authority's
   per-community version (`source_version`), with
   tombstones, so a late, older ACTIVE can never bring access back. The
   database repeats the version guard (`ON CONFLICT … DO UPDATE … WHERE
   coalesce(source_version, 0) < excluded.source_version`).
   `conversations.projected_membership_version` advances with `greatest()`,
   only over a contiguous range, and never goes backwards.

6. **One apply is one transaction** of at most 1,000 states, under the
   conversation row lock (the lock `appendMessage` already takes). Communities
   is read before the lock is taken and never called while it is held. An
   apply publishes nothing, audits nothing and checks no cap.

7. **Correctness never depends on the in-process bus.**
   - **Sync**: a single-flight loop per community, woken by
     `communities.member.added` / `.removed` (which carry `membershipVersion`),
     pulls `COMMUNITY_MEMBERSHIP.changesSince`.
   - **Sweeper**: at boot and every 60 s (PROVISIONAL engineering bound,
     [Q26]) it pages `listHeads`, so it also finds communities whose chat was
     never created. At most two background connections.
   - **Repair on access** fixes the caller's own row from an ACTIVE permit. A
     refusal never waits for a write.
   - **Reconciler**: after an authority restore (projection ahead of the head)
     or on demand.

8. **The authority is asked on every access.** `ConversationAccess` stays the
   single checkpoint and gains a community branch that asks
   `COMMUNITY_AUTHORIZATION` for `community.chat.read` or
   `community.chat.post` on every request. Unknown, non-member and unreadable
   are one answer: 404 `messaging.conversation_not_found`. List views use
   `authorizeEach` (≤ 1,000 ids) and one `COMMUNITY_DIRECTORY` batch per page.

9. **`MESSAGE_RECIPIENTS` keeps its signature.** Its comment is amended: for a
   community chat, "current members" means messaging's named projection. While
   the projected version differs from the head's `membershipVersion`, each
   page is narrowed to the members `statesOf` reports ACTIVE, and a sync is
   scheduled (the lag filter). Every page, lagging or not and whatever
   `readersOnly` says, is then narrowed to the accounts holding every
   permission of `COMMUNITY_CHAT_READ_CEILING`: two
   `ACCOUNT_DIRECTORY.withPermission` calls per non-empty page. Communities
   exports that constant from `communities/contracts/capabilities.ts`, and its
   own act table uses the same constant, so the permit path and this
   principal-less path cannot drift. It is the one addition to Communities'
   contracts that P4 needs
   ([community-chat.md §7.3](../community-chat.md#73-who-receives-a-message-the-lag-filter)).
   An unknown community, or one whose `chatReadable` effect is false, yields
   an empty page.

10. **Events.** For a linked conversation messaging raises only
    `message.sent` and `message.read` (with `conversationType 'CHANNEL'`),
    never `conversation.created` or `participant.added` / `.removed`. A
    30,000-member import produces no messaging event, no frame and no
    `ADDED_TO_CONVERSATION` notification.

11. **One new route.** `GET /messaging/communities/:communityId/conversation`
    → 200 `ConversationResponse` or 404. `ConversationResponse` gains
    `communityId: string | null` (additive).

12. **Capacity gates.** Community chats stay disabled above the load-tested
    size until all four hold:
    - **G1**: `OnlineAudience` in realtime
      ([0021](0021-cross-cutting-rules-for-new-modules.md));
    - **G2**: a partial index on current participants;
    - **G3**: load profile 4 has run;
    - **G4**: [Q27] and [Q28] are answered, or the cost of one notification
      row per reader per message is explicitly accepted.

    **The capacity switch.** A messaging deployment setting,
    `communityChatMaxServedMembers` (PROVISIONAL, [Q26]; default 250, the
    largest fan-out any test exercises), compared with messaging's own
    `conversations.member_count`, the projection's count. Above it, a send to
    the community chat returns 412 `messaging.community_chat_over_capacity`,
    and `canPost` is false. Reading, marking read and the projection are
    unaffected; with no new post there is no `message.sent`, so the relay and
    the notification translator have nothing to fan out. The value is raised
    only when G1–G4 hold for the new size
    ([community-chat.md §11.2](../community-chat.md#112-gates-g1g4)).

13. **No outbox for this projection.** Outbox trigger T1 of
    [0021](0021-cross-cutting-rules-for-new-modules.md) (a projection used for
    authorization without a reconciler) does not fire: the projection is never
    trusted alone. Decisions 7–9 back it.

## Consequences

If accepted:

- **Removal takes effect when Communities commits it.** A request whose permit
  is read after the commit is refused. A send whose permits were read before
  it may still append; the conversation lock orders it before the projected
  removal. Delivery resolved after the commit excludes the removed person.
  Nothing depends on the client or on a wake-up arriving
  ([community-chat.md §8](../community-chat.md#8-removal-and-how-fast-it-takes-effect)).
- Conversations whose `community_id` is NULL behave exactly as today; the
  existing security and membership specs must pass unmodified (P4 exit).
- Current apps show a community chat as a channel and take `canPost` from the
  server; no client breaks.
- A different answer to Q51 changes Communities' act rules only. Messaging
  does not change.
- Messaging's own cost stays O(1) per send plus one primary-key lookup per
  request. Fan-out is the cost that grows: today the relay walks every
  recipient page, 30 at 30,000 members (`messaging-relay.ts:207-219`), and
  notifications store one row per reader per message, kept forever (Q27,
  Q28). That is why decision 12 gates it.
- A second copy of membership now exists in messaging. It is named, versioned,
  repaired from three directions, and never consulted without the authority.

## Alternatives considered

- **Communities pushes into a messaging provisioning port** (a principal-free
  "set these members" contract; edge Communities → messaging). Rejected: any
  module importing MessagingModule, including realtime and notifications,
  could inject a port that sets membership. Messaging could then never ask
  Communities anything without a cycle, so posting rights, the lock and the
  title would all have to be copied. Removal would stay open until the apply
  succeeded, and the removal response would wait on a busy conversation's
  lock.
- **Dependency inversion**: a membership port declared in `messaging/contracts`
  and implemented by Communities. Rejected: no token is provided outside the
  module that declares it; the answer would arrive outside messaging's
  transaction, losing the re-check under the lock; and rows are still needed.
- **A new conversation kind with no rows per member.** Rejected: watermarks,
  windows, unread counts and "my conversations" all run on those rows.
- **Pure event-driven sync** (apply `communities.member.*` deltas). Rejected:
  the bus has no outbox, so a lost event is silent drift; there is no version
  to detect it; and a 30,000-member import would put 30,000 events on a bus
  that awaits each handler.
- **One shared transaction, or two-phase commit in process.** Rejected: there
  is no unit of work, and holding the community row and the conversation row
  together invites deadlocks under join storms.
- **A shared table or a cross-module SQL view.** Forbidden: tables are private,
  and only `contracts/` and `*.module.ts` may cross modules
  (`.dependency-cruiser.cjs:141-161`).
- **Keep messaging as the authority and raise the caps**, or call messaging's
  use cases from Communities with a system principal. Rejected: two
  authorities; the use cases are not exported, need a human owner, and emit an
  audit entry, an event, a notification and a frame per person.
- **A new `ConversationType` `COMMUNITY`.** Rejected: it widens a closed
  vocabulary shared by the DB CHECK, event payloads, notification copy and the
  Flutter enum; current apps would show "unknown". The behaviour branches are
  needed either way and key on `community_id`.
- **Generic `membership_authority` columns and a Communities-side journal
  with versions from a global sequence.** Rejected: a global counter can
  commit out of order, so a reader of "id > cursor" can skip a row forever.
  Versions are per community and in commit order
  ([0016](0016-communities-module.md)).
- **Projected roles (the owner as PUBLISHER) and a copied title.** Rejected:
  copies that drift, when a permit and a directory lookup cost one
  primary-key read each.
- **Publish `conversation.created` at creation, or `participant.*` for each
  apply.** Rejected: the first has no audience; the second gives one fact two
  sources and would create 30,000 `ADDED_TO_CONVERSATION` notifications.
- **A notification window for community chats** (one notification per 900 s).
  Rejected: it invents notification policy, which is Q28. Gate G4 is used
  instead.
- **Hide history from newcomers as a new rule.** Rejected: Q21's channel rule
  already fits; the choice is one constant ([Q52]).
- **No tombstones** (a LEFT for an absent row writes nothing). Rejected: when
  the loop, repair and a second instance race, an older ACTIVE applied after a
  newer LEFT recreates an active row.
- **Advance with `SET projected = :to WHERE projected >= :from`.** Rejected: it
  can move the version backwards when another applier is already past `:to`;
  hence `greatest()`.
- **A sweeper over existing conversations only.** Rejected: it never finds a
  community whose first wake-up was lost. It pages `listHeads`.
- **Inline repair when the permit says LEFT.** Rejected: a refused read would
  take a busy conversation's lock. The refusal comes from the authority alone.
- **Filter every recipient page through Communities.** Rejected: it doubles
  fan-out reads in steady state. The version comparison gives the same
  membership safety; the read ceiling is applied on every page anyway,
  through identity (decision 9).
- **A `communities.membership.changed` hint, one per transaction.** Dropped:
  the per-member events carry `membershipVersion` and serve as wake-ups.
- **Messaging's caps for community chats** (a 30,000-member chat would be
  blocked by `CHANNEL`'s 10,000). Rejected: the caps apply to conversations
  messaging owns. Capacity is handled by gates G1–G4 and the switch
  (decision 12), and any community size
  limit is Communities configuration ([Q20]).
- **An outbox for `communities.member.removed` now.** Rejected: decision 13.
  The outbox stays deferred until T2, T3 or T4.
- **409 for the membership refusal.** Rejected: `precondition_failed` maps to
  412 (`http-failure.ts:18`), and the refusal is a precondition, not a
  conflict.

[Q20]: ../open-questions.md#q20--messaging-limits
[Q22]: ../open-questions.md#q22--who-may-see-who-is-in-a-conversation
[Q26]: ../open-questions.md#q26--realtime-limits
[Q27]: ../open-questions.md#q27--how-long-are-notifications-kept
[Q28]: ../open-questions.md#q28--what-deserves-a-notification-and-how-loudly
[Q51]: ../open-questions.md#q51--the-community-chat-who-may-post
[Q52]: ../open-questions.md#q52--community-chat-history-for-newcomers-and-returners
[Q53]: ../open-questions.md#q53--system-notices-in-a-community-chat
