# Community chat

**State: PROPOSED — design only. Nothing here is implemented; no table, endpoint, event publisher or screen exists.**

How messaging carries a community's chat (phase **P4**). Communities decides
who belongs and who may read or post; messaging stores the messages and
delivers them. This is one part of the Communities + Live + Attendance
package. The overview, dependency graph, realtime matrix and phases are in the
hub, [communities-live-attendance.md](communities-live-attendance.md). The
community side (stints, versions, act rules, the lifecycle table) is in
[communities.md](communities.md). The decision is recorded in
[ADR 0018](decisions/0018-community-chat-projection.md), status Proposed.

**The name.** In code and in these documents the brief's "Group" is the
**Community** aggregate: module `communities`, id `communityId`. "Group" is
avoided because it already means messaging's `GROUP` conversation type
(`vocabulary.ts:11`) and is used for Tahajji's «مجموعة» in
[Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups),
which is unanswered. So this document says "community chat", never "group
chat".

**Gated.** P4 builds on the Communities core (P2). Communities is a new
module, and whether the "before any new module" step of
[academic-reconciliation.md §13](academic-reconciliation.md#13-minimal-recommended-changes-before-the-next-milestone)
covers it is
[Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules).
The provisional default is that it does, so P2, and with it P4, waits for the
§13 step (Q35/Q36 and ADR 0015) or the user's ruling on Q40. Nothing here
lifts that gate.

**How to read it.** "Today" means the repository at commit `9670c47`; every
such statement says so and cites `file:line`. Every `file:line` is at that
commit, documents included (`messaging.md`, `events.md`,
`module-boundaries.md`, `open-questions.md` and the rest): this package's
notes have since moved lines in several of them. The code has not changed
since `9670c47`. Everything else is a proposal.
Every institutional default is labelled PROVISIONAL and names its open
question. Every engineering bound that must be measured is labelled
PROVISIONAL too.

---

## 1. Terminology

| Term | In code | Meaning |
| --- | --- | --- |
| Community | module `communities`; `communityId` | The brief's Group: a persistent space ([communities.md §1](communities.md#1-terminology)) |
| Community chat | a `conversations` row whose `community_id` is set | A community's one conversation. At most one per community ([Q51](open-questions.md#q51--the-community-chat-who-may-post)) |
| Authority | Communities' `community_members` | The only record of who belongs |
| Projection | community-chat rows of `conversation_participants`, plus `conversations.projected_membership_version` | Messaging's named, derived copy of a community's ACTIVE members. Never an access answer on its own |
| Stint | a `community_members` row | One stay in a community. A rejoin is a new stint with a new `membershipId` and `joinedAt` |
| Version | `MemberState.version`, `CommunityHead.membershipVersion` | Per community, unique, in commit order ([communities.md §5.2](communities.md#52-counters-and-version-allocation)) |
| Permit | `CommunityPermit` | `COMMUNITY_AUTHORIZATION`'s positive answer. It carries the caller's stint `{membershipId, joinedAt, version}` |
| Head | `CommunityHead` | A community's current `membershipVersion`, `lifecycleVersion` and `effects` |
| Lag | `projected_membership_version ≠ head.membershipVersion` | The projection is behind, or ahead after an authority restore |
| Tombstone | a LEFT row for someone never projected ACTIVE | Keeps a version, so an older ACTIVE can never bring access back |
| Wake-up | `communities.member.added`, `communities.member.removed` | Tells the sync to pull. Never a source of truth |
| Apply | `applyCommunityMembership` | One transaction of at most 1,000 member states under the conversation row lock |

---

## 2. What exists today

Messaging V1 owns membership outright. All of the following is today's code:

| Today | Evidence |
| --- | --- |
| One `conversation_participants` row per (conversation, user) holds the role, join and leave times, `addedBy`, the read watermark and the history window | `participant.ts:20-30`; `schema.ts:71-110`; `module-boundaries.md:176-182` |
| Membership is checked in four places: the `ConversationAccess.member` chokepoint; the summary query, scoped to `left_at is null`; a re-check under the conversation row lock in `appendMessage`; and the `markRead` UPDATE, which takes no conversation lock | `conversation-access.ts:58-72`; `drizzle-messaging-read-model.ts:47,69`; `drizzle-messaging-repository.ts:121-124,307-318` |
| One row lock (`SELECT … FOR UPDATE` on `conversations`) serializes the sends, adds and removes of a conversation | `drizzle-messaging-repository.ts:113-117,195-199` |
| Three closed conversation types. Posting follows type and role; the history window follows type | `vocabulary.ts:11`; `schema.ts:53`; `participant.ts:64-67`; `messaging-policy.ts:43-45` |
| Caps: DIRECT 2, GROUP 500, CHANNEL 10,000 members; 200 people per request (PROVISIONAL, [Q20](open-questions.md#q20--messaging-limits)) | `messaging-policy.ts:20-27` |
| Only the conversation's OWNER adds people. Nobody joins on their own. `messaging.manage` removes but never adds | `membership.use-cases.ts:47-59`; `security.spec.ts:103` |
| Each added person costs one audit row and one `participant.added` event, which becomes an `ADDED_TO_CONVERSATION` notification and a frame | `membership.use-cases.ts:143-158`; `messaging-notification.translator.ts:154-171` |
| `MessagingModule` imports identity and files, and exports exactly `MESSAGE_RECIPIENTS` and `MESSAGE_DELIVERY`. It subscribes to no event | `messaging.module.ts:62,108`; no `EVENT_SUBSCRIBER` under `src/modules/messaging/` |
| `MESSAGE_RECIPIENTS` pages members by user id, at most 1,000, with `visibleSequence`, `readersOnly` and `onlyUserIds`. Its comment forbids delivery modules to keep a copy of membership | `message-recipients.ts:11-49` |
| For every `message.sent`, the realtime relay walks every recipient page on every instance with a connection. The notifications translator walks every reader and stores one row per reader | `messaging-relay.ts:97-99,207-219`; `messaging-notification.translator.ts:182-205`; `notification-dispatcher.ts:141-161` |
| The event bus is in-process and awaits each handler. An event is lost if the process dies between commit and publish | `event-bus.ts:43-56`; `events.md:141` |
| Member pages scan the primary key and filter on `left_at`. No index covers a conversation's current members | `drizzle-messaging-read-model.ts:174-180`; `schema.ts:88-94` |
| Fan-out is tested at 250 members. No load test exists | `messaging-persistence.spec.ts:522-551` |

So today a 30,000-member community could not be a messaging conversation. It
would hit the caps. Filling it would take 150 add requests of 200, writing
30,000 audit rows, events, notifications and frames. And messaging would
become a second membership authority. The design below leaves all of this
untouched for the conversations messaging owns. It adds a separate, additive
branch for conversations linked to a community.

---

## 3. Authority and projection

### 3.1 Who answers what

| Question | Answered by | How |
| --- | --- | --- |
| Who belongs to community C? | Communities | `community_members` stints; `COMMUNITY_MEMBERSHIP` |
| May P read, or post in, C's chat now? | Communities | `COMMUNITY_AUTHORIZATION` with `community.chat.read` or `community.chat.post`, asked on every access |
| What does LOCKED mean for the chat? | Communities | `statePermits` inside the permit; `CommunityHead.effects.chatReadable` and `chatPostingOpen` for principal-less callers ([Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock)) |
| What is the chat called? | Communities | `COMMUNITY_DIRECTORY.describe` when viewed; the stored title is NULL |
| Which conversation is C's chat? | messaging | `conversations.community_id` |
| Messages, order, idempotency, attachments | messaging | unchanged |
| P's read watermark and history window | messaging | the projection row's `last_read_sequence` and `hidden_through_sequence` |
| Who receives a `message.sent`? | messaging, narrowed by Communities while the projection lags, and always by the `community.chat.read` ceiling (§7.3) | `MESSAGE_RECIPIENTS` |

### 3.2 Why messaging keeps rows at all

Watermarks and history windows are per (conversation, user)
(`participant.ts:20-30`). "My conversations" and unread counts
(`drizzle-messaging-read-model.ts:206-244`), keyset fan-out (`:136-172`) and
the send re-check under the lock (`drizzle-messaging-repository.ts:121-124`)
all run on those rows. Rows per member are therefore unavoidable. The only
questions are who writes them and which way the dependency points.

### 3.3 Why the projection is not a forbidden copy

`MESSAGE_RECIPIENTS` promises that delivery modules never keep a copy of
membership that could drift (`message-recipients.ts:13-20`). The projection
is messaging's own, and six rules keep it honest:

1. **Named.** ADR 0018 and the `MESSAGE_RECIPIENTS` comment (§12.1) call it
   a projection, and the `source_*` columns record where each row came from.
2. **One writer.** Only the projection applier writes the membership columns
   of these rows. `markRead` and `appendMessage` keep writing
   `last_read_sequence` only.
3. **Versioned from the authority.** Each row carries the authority's version
   for that user. The conversation carries the version up to which the
   projection is complete.
4. **Never an access answer on its own.** Every request asks the authority.
   Fan-out is narrowed through the authority while the projection lags, and
   by the read ceiling on every page (§7.3).
5. **Repairable.** A sync, a sweeper, repair on access and a reconciler
   (§7.5).
6. **Silent.** Applying it publishes no event and writes no audit entry.
   Membership facts are Communities' own.

---

## 4. Dependency direction

### 4.1 The edge

```
  A ◀── B : B depends on A (the brief's notation)

  identity ◀── communities ◀── messaging ◀── notifications
                                   ▲
                                   └──────── realtime

  Unchanged: identity ◀── messaging and files ◀── messaging.
  New:       communities ◀── messaging, from messaging's application layer only.
  Never:     messaging ◀── communities. That edge would close a cycle.
```

- `MessagingModule.imports` becomes `[IdentityModule, FilesModule,
  CommunitiesModule]`, with no `forwardRef`. `CommunitiesModule` imports
  `IdentityModule` only.
- Only `messaging/application` imports `communities/contracts`.
  `messaging/domain` never does, and `messaging-boundaries.spec.ts:27-41`
  stays green: the domain declares its own `CommunityMemberState`, and the
  application maps Communities' `MemberState` onto it.
- `communities/contracts` import only `src/shared` and
  `identity/contracts/permissions.ts`, never live. So messaging still never
  reaches live, even transitively (`messaging-boundaries.spec.ts:43-50`).
- `MessagingModule.exports` stays exactly `[MESSAGE_RECIPIENTS,
  MESSAGE_DELIVERY]` (`messaging.module.ts:108`). There is no write port, no
  provisioning port, and no use case is exported.
- What messaging uses: `COMMUNITY_AUTHORIZATION` (`authorize`,
  `authorizeEach`; acts `community.chat.read` and `community.chat.post`),
  `COMMUNITY_MEMBERSHIP` (`heads`, `listHeads`, `statesOf`, `changesSince`,
  `members`), `COMMUNITY_DIRECTORY.describe`, the constant
  `COMMUNITY_CHAT_READ_CEILING` (§7.3), and the events
  `communities.member.added` and `communities.member.removed` as wake-ups.
  Their shapes are in [communities.md §10](communities.md#10-public-contracts).
- Communities' API never carries chat data (no last message, no unread
  count). The client composes the two.

### 4.2 Why messaging pulls

1. **Precedent.** The authority exposes a read contract and consumers ask it,
   as academic does with `ACADEMIC_RELATIONSHIPS` (`relationships.ts:1-36`).
2. **No principal-free write port.** Anything `MessagingModule` exports can be
   injected into realtime and notifications, which both import it
   (`realtime.module.ts:34`; `notifications.module.ts:64`).
3. **Changing state is asked, not copied.** Posting rights (delegation,
   lock), readability and the title are asked at the moment they matter.
   Pushing them would need one more copied state, with its own drift, for
   each.
4. **Removal is stronger.** Access ends when Communities commits the removal,
   whether or not the projection has caught up.
5. **One authorization contract** serves messaging and live.
6. **No coupling of latency.** A removal in Communities never waits for a
   busy conversation's row lock.

### 4.3 Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| **A provisioning port**: Communities pushes membership into a messaging contract (`provision`, `apply`) | Needs Communities → messaging. Messaging must still ask Communities about posting and readability, so the two edges close a cycle. The port would take no principal and would be injectable into realtime and notifications (`realtime.module.ts:34`; `notifications.module.ts:64`), guarded only by a test on who imports it. Posting rights, lock state and the title would each become a copy. Removal would fail open until the apply ran, and the removal response would wait on a busy conversation's lock |
| **Dependency inversion**: a membership port declared in `messaging/contracts` and implemented by communities | Today no token is provided outside the module that declares it (`messaging.module.ts:105-106`; `identity.module.ts:150-152`). It becomes a Nest cycle the first time Communities needs anything from messaging. Its answer arrives outside messaging's transaction, so the re-check under the lock is lost, or a second pool connection is taken while holding the lock (the pool has 10, `database.ts:28`). Watermarks still need rows |
| **A new conversation kind with no rows**: access and recipients asked of Communities each time | Watermarks and windows are per member (`participant.ts:20-30`). The conversation list and unread counts are SQL over those rows (`drizzle-messaging-read-model.ts:206-244`). `visibleSequence` cannot be served without `hidden_through_sequence` (`:156-159`). It rebuilds a projection without its guarantees, gives up atomicity under the lock, and needs keyset streams merged across modules |
| **Pure event sync**: messaging applies `communities.member.*` deltas | The bus is in-process with no outbox; a crash between commit and publish loses the event (`event-bus.ts:43-56`; `events.md:141`). Without versions, drift cannot be detected. Events are kept only as wake-ups; the truth is pulled |
| **A new `ConversationType` `'COMMUNITY'`** | Widens a closed vocabulary shared by the DB CHECK (`schema.ts:53`), the event payloads, the notification copy (`notification_copy.dart:69-74`) and the Flutter enum; current apps would show the chat as `unknown` (`messaging.dart:11-23`). The behaviour branches are needed either way, and key on `community_id` instead |
| **One transaction across both modules**, or in-process two-phase commit | No unit of work exists; each repository opens its own transaction. It would hold the community row and the conversation row together, inviting deadlocks under join storms |
| **A shared table or a cross-module SQL view** | Forbidden: messaging's tables are private (`messaging-boundaries.spec.ts:72-77`), no module imports another's internals (`.dependency-cruiser.cjs:140-161`), and no foreign key crosses modules (`schema.ts:17-23`) |
| **Messaging stays the authority** with raised caps, or Communities calls messaging's use cases as a system principal | Two authorities for one fact. Use cases are not exported (`messaging.module.ts:108`), take at most 200 people per request, and emit one audit row, event, notification and frame per person (`membership.use-cases.ts:143-158`) |
| **Filter every recipient page through Communities**, not only while lagging | Doubles fan-out reads in steady state. The version comparison gives the same membership safety for one head lookup per page; the read ceiling is applied on every page anyway, through identity (§7.3) |
| **Publish `participant.added` / `removed` for applies**, so existing relays and translators announce them | One fact would have two sources, and an import of 30,000 would create 30,000 `ADDED_TO_CONVERSATION` rows and frames. Announcing membership is Q22, [Q49](open-questions.md#q49--leaving-removal-and-rejoining) and [Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts) |

---

## 5. What a community chat is

### 5.1 A CHANNEL conversation plus `community_id`

A community chat is an ordinary conversation of the existing `CHANNEL` type
(PROVISIONAL, [Q51](open-questions.md#q51--the-community-chat-who-may-post)),
plus an additive link column, `conversations.community_id`, under a partial
UNIQUE index. So each community has at most one chat.
`ConversationType` stays closed (`'DIRECT' | 'GROUP' | 'CHANNEL'`).

For a linked conversation, the type is a display label only. The rules below
override the type's rules, and every branch keys on `community_id`, never on
the type.

### 5.2 The rules that override the type

| Concern | A `CHANNEL` messaging owns (today) | A community chat |
| --- | --- | --- |
| Who may post | the OWNER and PUBLISHERs (`participant.ts:64-67`) | the holder of a `community.chat.post` permit, asked on every send (§7.2). PROVISIONAL, Q51 |
| Who may read | current participants | a `community.chat.read` permit **and** an active projection row (§7.1) |
| Member list | the owner and publishers; others get `members_hidden` (`read-conversations.use-cases.ts:170-178`) | nobody: 403 `messaging.members_hidden`. The roster is Communities' (`community.members.view`, [Q22](open-questions.md#q22--who-may-see-who-is-in-a-conversation)) |
| Add, remove, leave | the owner adds and removes; `messaging.manage` removes; members leave | 412 `messaging.membership_managed_by_community`. Membership changes go through `/communities` ([Q49](open-questions.md#q49--leaving-removal-and-rejoining)) |
| Member cap | 10,000 (`messaging-policy.ts:23`) | none in messaging (§10) |
| History for newcomers | full (`messaging-policy.ts:43-45`) | `COMMUNITY_HISTORY`, PROVISIONAL `'FULL'` ([Q52](open-questions.md#q52--community-chat-history-for-newcomers-and-returners)): the same value, a separate constant (§9) |
| Title | stored, 1–100 characters | NULL in storage; from `COMMUNITY_DIRECTORY` when viewed |
| Role on the row | OWNER, PUBLISHER or MEMBER | always MEMBER, and meaningless. `canManageMembers` is false; `myRole` is `'MEMBER'` |
| Events raised by messaging | `conversation.created`, `participant.*`, `message.sent`, `message.read` | `message.sent` and `message.read` only |
| Audit by messaging | creation, and each participant change | none. Communities audits each membership act once |
| Creator | a person | the label `system:messaging-community-chat` in `created_by`. It authorizes nothing and never reaches the wire |
| System notices ("X joined", "a live session started") | none: the `system` message kind was dropped (`0011-messaging-v1.md:54-57`) | none. The chat is written by people only (PROVISIONAL, [Q53](open-questions.md#q53--system-notices-in-a-community-chat)) |
| Message moderation | removal by `messaging.manage` exists; deletion is Q23 | not in v1. `community.messages.moderate` is reserved until Q51 and [Q23](open-questions.md#q23--moderation-deletion-and-review) |

Conversations whose `community_id` is NULL behave exactly as today.

### 5.3 Materialization

Messaging creates the conversation itself, idempotently, with the pattern the
DM pair already uses (`messaging.md:31-35`):

```sql
INSERT INTO conversations (id, type, title, created_by, community_id, projected_membership_version)
VALUES ($id, 'CHANNEL', NULL, 'system:messaging-community-chat', $communityId, 0)
ON CONFLICT (community_id) WHERE community_id IS NOT NULL DO NOTHING;
-- then read the row for $communityId
```

It happens on the first positive `community.chat.read` permit at the new
route, in the sync, or in the sweeper. Nothing is ever created for a
non-member. Materialization raises no `messaging.conversation.created` and
writes no audit entry: a conversation with no members yet has no audience.
Twenty concurrent materializations produce one row (§17).

### 5.4 Why `CHANNEL`

- Current apps already render a channel, and take `canPost` and
  `canManageMembers` from the server (`messaging.dart:225-226`). Nothing on
  the client must change for the chat to work.
- A channel is the notice-board case of Q21, which matches the provisional
  rule that only the owner and delegated posters write (Q51).
- A different answer to Q51 changes Communities' act rules only. Messaging
  does not change. A new type would be revisited only if Q51 needs semantics
  that clients must see and that `CHANNEL` plus `canPost` cannot express.

---

## 6. The named projection

### 6.1 Shape and invariants

The projection is the community-chat rows of `conversation_participants`,
with three new columns (`source_version`, `source_membership_id`,
`source_joined_at`), plus
`conversations.projected_membership_version`. Each row still holds
messaging's own state for that member: `last_read_sequence` and
`hidden_through_sequence`.

| # | Invariant | Enforced by |
| --- | --- | --- |
| C1 | `community_id` is set exactly when `projected_membership_version` is set | CHECK `conversations_community_chat_shape` |
| C2 | A community chat is never DIRECT; it is stored as CHANNEL (PROVISIONAL, Q51) | the same CHECK |
| C3 | At most one conversation per community | partial UNIQUE `conversations_community_unique` |
| C4 | A community chat's title is NULL in storage | `conversations_title_shape`, replaced (§12.3) |
| C5 | `member_count` equals the rows with `left_at IS NULL` | moved in the apply transaction, from rows read under the lock |
| C6 | `projected_membership_version` only moves forward, and only over a contiguous range: every authority change at or below it is reflected. Only the reconciler lowers it, after an authority restore | the guarded advance in the apply (§6.3) |
| C7 | On community-chat rows only the applier writes the membership columns (`role`, `joined_at`, `left_at`, `added_by`, `source_*`). Such rows are always `MEMBER` with `added_by` NULL | code plus a test; CHECK `conversation_participants_source_shape` |
| C8 | `0 ≤ hidden_through_sequence ≤ last_read_sequence ≤ last_sequence`, unchanged | the existing CHECK (`schema.ts:101-104`) and `markRead`'s clamp |

### 6.2 `projectMember`: a last-writer-wins register per member

`projectMember(row | null, state, conversation, at)` is a pure function in
`messaging/domain`. `state` is `{userId, membershipId m, active, joinedAt J,
version v}`, mapped from Communities' latest stint for that user. Each row is a register
keyed by the authority's version. **Every transition requires `v >
row.source_version`; anything else is `ignored`.**

| Row | Incoming | Result | Transition | Δ `member_count` | Written |
| --- | --- | --- | --- | --- | --- |
| absent | ACTIVE (m, J, v) | ACTIVE | `joined` | +1 | MEMBER, `added_by` NULL, `joined_at` now, `last_read` = last sequence, `hidden` per `COMMUNITY_HISTORY` (§9), source (v, m, J) |
| absent | LEFT (m, J, v) | LEFT | `tombstoned` | 0 | `joined_at` = `left_at` = now, `last_read` = `hidden` = 0, source (v, m, J) |
| ACTIVE (m) | ACTIVE (m, v) | ACTIVE | `bumped` | 0 | `source_version` only; watermark and window kept |
| ACTIVE (m) | ACTIVE (m′ ≠ m, J′, v) | ACTIVE | `rejoined`: a leave was missed | 0 | watermark and window reset as for `joined`; source (v, m′, J′) |
| ACTIVE | LEFT (m, J, v) | LEFT | `left` | −1 | `left_at` = greatest(now, `joined_at`); source (v, m, J) |
| LEFT | ACTIVE (m′, J′, v) | ACTIVE | `rejoined` | +1 | as `joined` |
| LEFT | LEFT (v) | LEFT | `bumped` | 0 | `source_version` only |
| any | version ≤ `source_version` | unchanged | `ignored` | 0 | nothing |

- A rejoin resets the window and watermark, exactly as messaging's own rejoin
  does today (`drizzle-messaging-repository.ts:240-251`).
- Rejoin detection works whether or not the leave was seen: LEFT → ACTIVE, or
  an ACTIVE whose `membershipId` differs from `source_membership_id`.
  Communities gives every stint its own id
  ([communities.md §3.2](communities.md#32-membership-stints)). Timestamps
  are never compared, so a clock step back or two stints within one
  millisecond cannot make a new stint look like the old one;
  `source_joined_at` is provenance only.
- The tombstone is what makes the register safe. Without it, an older ACTIVE
  applied after a newer LEFT would create an active row.
- The properties: **idempotent** (a replay is ignored), **commutative per
  member** (the highest version wins), and **convergent** under loss, retry,
  reordering and concurrent appliers.

### 6.3 One apply is one transaction

`applyCommunityMembership({conversationId, states ≤ 1,000 with distinct
userIds, advance: {from, to} | null, at})` runs in one messaging transaction:

```sql
BEGIN;                                                   -- READ COMMITTED
SELECT last_sequence, member_count, projected_membership_version
  FROM conversations WHERE id = $c FOR UPDATE;            -- the lock appendMessage takes
SELECT … FROM conversation_participants
 WHERE conversation_id = $c AND user_id = ANY($ids);      -- ≤ 1,000 distinct users
-- projectMember() for each state, in memory; only changed rows are written
INSERT INTO conversation_participants (…) VALUES (…)
ON CONFLICT (conversation_id, user_id) DO UPDATE SET …
 WHERE coalesce(conversation_participants.source_version, 0) < excluded.source_version;
UPDATE conversations
   SET member_count = member_count + $delta,
       projected_membership_version = CASE
         WHEN projected_membership_version >= $from
         THEN greatest(projected_membership_version, $to)
         ELSE projected_membership_version END            -- omitted when advance is null
 WHERE id = $c;
COMMIT;
```

- **Batch.** At most 1,000 states with distinct user ids; more, or a
  duplicate, is a `RangeError`. `changesSince` already returns the latest
  state per user within a page.
- **No call to Communities under the lock.** The applier fetches first and
  locks second. The community row and the conversation row are never held in
  one transaction, so there is no cross-module lock cycle, and the pool
  (10 connections, `database.ts:28`) cannot deadlock on itself.
- **The guard is repeated in the database.** The `ON CONFLICT … WHERE` holds
  even if application filtering were bypassed.
- **The advance is contiguous and monotonic.** `greatest()` never moves the
  version backwards when another applier has already passed `$to`. The
  contiguity predicate sits in a `CASE`, not in the `WHERE` clause, so a
  failed check never skips the `member_count` change (C5).
- **Silent.** An apply publishes no event, writes no audit entry and checks
  no cap.
- **Callers.** The sync loop (with an advance), repair on access (one state,
  advance null), and the reconciler (an override flag, §7.5).

---

## 7. How messaging answers

### 7.1 May this principal read?

`ConversationAccess` stays the single checkpoint. It gains one branch:

```
ConversationAccess.member(principal, conversationId, permission)
 1. identity: authorize(permission, {resourceType 'messaging.conversation', resourceId})   ← as today
 2. conversation := findConversation(id)                             absent → 404
 3. community_id NULL → today's path, unchanged: findParticipant; not active → 404
 4. community chat:
    a. COMMUNITY_AUTHORIZATION.authorize(principal, communityId, 'community.chat.read')
         every request; no cache across requests
         any refusal       → 404 messaging.conversation_not_found; a sync is scheduled
                             (single-flight per community, so repeats cost nothing more)
         promise rejected  → 503 unavailable; never a role-only answer
    b. row := findParticipant(id, principal.userId)
         active, and source_version ≥ permit.membership.version → allowed
         otherwise → repair on access: apply [{userId, membershipId, active, joinedAt, version}] alone,
                     advance null, under the lock; read the row again
         still not active → 404 (only after an authority restore, §7.6)
```

- It covers opening a conversation, paging messages, marking read, attachment
  links, listing participants (which then refuses, §5.2), add, remove and
  leave (which then refuse), and realtime `subscribe`, which runs
  `GetConversationUseCase` through `MESSAGE_DELIVERY.position`.
- Today `GetConversationUseCase` and `position()` rely on the summary query's
  membership scope, not on `ConversationAccess.member`
  (`read-conversations.use-cases.ts:65-78`; `message-delivery.service.ts:48-59`).
  In P4 they pass through the same branch before the summary is read.
- **Refusal is immediate.** It comes from the authority alone and never waits
  for a write.
- **Repair happens only for ACTIVE.** It creates or refreshes a row only from
  a permit, that is, from a membership Communities itself committed. A LEFT is
  repaired by the scheduled sync, never inline, so a refused read never takes
  a busy conversation's lock.
- **Cost.** The identity check in memory, two primary-key lookups in
  messaging, one statement in Communities. Repair adds one short transaction,
  and only when the caller's own row is behind.
- The existing invariants carry over: permission first, then membership; the
  same 404 for a missing conversation and one the caller is not in
  (`conversation-access.ts:25-36`); a permission never substitutes for
  membership. `communities.manage` never grants `community.chat.read`
  ([Q43](open-questions.md#q43--institutional-oversight-of-communities)).

### 7.2 May this principal send?

The send pipeline keeps its order (`messaging.md` §4). For a community chat
its membership step becomes:

1. the read branch of §7.1, with `messaging.send` as the edge permission. A
   non-member therefore always gets 404;
2. `authorize(principal, communityId, 'community.chat.post')`. Any refusal
   other than `not_found` (no capability, a missing identity ceiling, or the
   lifecycle gate while LOCKED) returns the existing 403
   `messaging.posting_not_allowed`;
3. the capacity switch of §11.2: if the conversation's `member_count` is above
   `communityChatMaxServedMembers`, 412
   `messaging.community_chat_over_capacity`.

`canPost(type, role)` (`participant.ts:64-67`) is not consulted for community
chats. The re-check under the lock in `appendMessage`
(`drizzle-messaging-repository.ts:121-124`) is unchanged; it checks the
projection row.

The act rule is Communities', and PROVISIONAL
([Q51](open-questions.md#q51--the-community-chat-who-may-post),
[Q44](open-questions.md#q44--who-may-hold-delegated-capabilities),
[Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock)):
`community.chat.post` is held by the owner implicitly or through an explicit
grant, with the ceiling `communities.moderate` + `messaging.send`, and is
refused while LOCKED. Grants arrive in P3, so before P3 only the owner posts.

Sends to one conversation serialize on its row lock, as channels do today.
That is adequate for a few posters (`messaging.md:444-447`). If Q51 lets
thousands post, allocating sequences without the row lock is a later
redesign.

### 7.3 Who receives a message: the lag filter

`MESSAGE_RECIPIENTS` keeps its signature. For each page:

| Conversation | Page returned |
| --- | --- |
| `community_id` NULL | exactly today's page |
| community chat; the head is absent (unknown community) or `effects.chatReadable` is false | `{userIds: [], nextCursor: null}` |
| community chat; `projected_membership_version = head.membershipVersion` | the projection page, as today; `visibleSequence`, `readersOnly` and `onlyUserIds` apply unchanged |
| community chat; the versions differ | the projection page narrowed to the users `statesOf` reports ACTIVE; a sync is scheduled |

**The ceiling, on every page.** For a community chat, lagging or not and
whatever `readersOnly` says, each non-empty page is then narrowed to the
accounts that hold every permission of the `community.chat.read` ceiling
(`communities.read` and `messaging.read`, PROVISIONAL,
[communities.md §6.4](communities.md#64-act-rules--provisional)): one
`ACCOUNT_DIRECTORY.withPermission` call per permission, which also drops
accounts that cannot authenticate. Messaging keeps no copy of that list:
Communities exports it from `communities/contracts/capabilities.ts` as
`COMMUNITY_CHAT_READ_CEILING`, and its own act table uses the same constant,
so the permit path and this principal-less path cannot drift. This is the one
addition to Communities' contracts that P4 needs. Without it, a member whose
role lost `communities.read` would be refused every HTTP read, yet still get
`message.sent` frames carrying the message body: the relay passes no
`readersOnly` (`messaging-relay.ts:207-219`), and its connection gate checks
`messaging.read` only (§12.5). They would get notification rows too, because
the `readersOnly` the translator passes checks only `messaging.read`
(`message-recipients.service.ts:62,69`).

- **Cost.** For a community chat, one `heads([C])` per page, one `statesOf`
  per page only while lagging, and two `withPermission` calls per non-empty
  page. For a conversation messaging owns, the only addition is learning that
  its `community_id` is NULL (a column of the conversation row).
- **The filter only narrows.** A member removed in the authority but still
  projected receives nothing, and neither does a member whose role lost part
  of the ceiling. A member who joined but is not yet projected is missed for
  that message: no frame and no notification. That fails closed; they read
  the message over HTTP.
- `MESSAGE_DELIVERY` is unchanged.

### 7.4 List views

`GET /messaging/conversations` still starts from the caller's own current
rows (`conversation_participants_user_current_idx`, `schema.ts:92-94`), so it
lists the chats in which the caller is projected. For the community-chat rows
on a page (at most 100, `messaging-settings.ts:18`) it makes three calls,
whatever the number of such rows, and none when there are none:

- one `authorizeEach(principal, ids, 'community.chat.read')`. Refused rows
  are dropped and a sync is scheduled for each;
- one `authorizeEach(principal, kept, 'community.chat.post')` for `canPost`;
- one `COMMUNITY_DIRECTORY.describe(kept)` for the titles.

A page may be shorter than the limit; the keyset continues after the last row
examined. A new member who is not yet projected does not see the chat in the
list until the sync applies it: usually milliseconds, at worst the next sweep.
Opening the chat from the community screen, through the new route, repairs
their row at once.

### 7.5 Keeping the projection current

| Service | When it runs | What it does | Bound |
| --- | --- | --- | --- |
| `CommunityChatSync` | Woken by `communities.member.added` and `.removed`, reading only the payload's `communityId`. Also scheduled by access refusals, the lag filter and the sweeper | One loop at a time per community; wake-ups that arrive mid-run set a rerun flag. The loop materializes the chat if missing, calls `changesSince(C, projected, 1000)`, applies with `advance {from: projected, to: throughVersion}`, and repeats while `hasMore` | The handler only schedules and returns, because the bus awaits handlers (`event-bus.ts:43-56`) |
| `CommunityChatSweeper` | At boot and every 60 s (PROVISIONAL, [Q26](open-questions.md#q26--realtime-limits)) | Pages `listHeads` 1,000 at a time and reads `communityChatsFor(ids)` once per page. No chat for a community → schedule (it materializes). Projected behind the head → schedule. Projected ahead → reconciler | 2 × ⌈communities / 1,000⌉ statements per tick |
| `CommunityChatReconciler` | When the projection is ahead of the head (the authority was restored from a backup), or on operator demand | Merge-joins `COMMUNITY_MEMBERSHIP.members(C)` with messaging's own member walk by user id (about 30 + 30 pages at 30,000). Resolves each difference with `statesOf`. Writes through the override flag, the only writer allowed to lower a row's `source_version`. Resets the projected version to the head. Logs a warning and a metric; no audit, because the state is derived | proportional to the community's size |

- Sync and sweeper together use at most two connections in the background
  (PROVISIONAL, Q26), because the pool has 10 per process (`database.ts:28`).
- An earlier draft of this design had a one-per-transaction hint,
  `communities.membership.changed`; it was dropped. The per-member events
  carry `membershipVersion`, a batch add is at most 200 per request, and each
  handler does O(1) work.
- **Correctness never depends on the in-process bus.** The per-access check,
  the lag filter and the sweeper close every window a lost wake-up leaves.
  That is why `communities.member.removed`, the only S-class event, needs no
  outbox here: trigger T1 (a projection used for authorization with no
  reconciler) does not fire, because the projection has a reconciler, a
  sweeper and repair on access
  ([ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md)).

### 7.6 Drift: detection and repair

| Drift | Detected by | Repaired by | Access meanwhile |
| --- | --- | --- | --- |
| The projection is behind: a wake-up was lost or is slow | `projected < head`: the lag filter on every fan-out page; the sweeper on every tick | the sync loop | correct: every request asks the authority |
| A community's chat was never materialized (its first wake-up was lost) | the sweeper: a head with no chat | the sync, which materializes | the new route materializes on the first positive permit |
| The caller's own row is behind | `permit.membership.version > row.source_version` | repair on access, inline, one row | served after the repair |
| The caller was removed but is still projected | the permit is refused | the scheduled sync | 404 at once |
| The projection is ahead: the authority was restored from a backup | `projected > head` | the reconciler | correct. A member whose row carries a newer tombstone gets 404 until the reconciler runs: fail closed |
| Rows diverge at equal versions (a bug) | the reconciler on demand | the reconciler | correct |

Metrics, not audit: the age of the oldest lag, the number of lagging chats,
repairs on access per minute, reconciler runs, and orphans (chats whose
community is unknown).

---

## 8. Removal, and how fast it takes effect

A removal takes effect when Communities commits it. Every messaging request
asks `COMMUNITY_AUTHORIZATION`, and the authority keeps no cache across
requests.

| Surface | When the removed person loses it | Mechanism |
| --- | --- | --- |
| Reading, sending, marking read, attachment links | at the commit | every request asks the authority (§7.1) |
| Realtime `subscribe` | at the commit | `position()` passes the same branch |
| `message.sent` frames and notification rows | for recipients resolved after the commit | the lag filter (§7.3) |
| A send already in flight | it may still land, if both permits were read before the commit | the conversation lock orders it (S2 below) |
| Frames whose recipients were resolved before the commit | they may still arrive | existing at-most-once delivery |
| Notification rows already stored | kept; they carry no message text, and opening one runs the checkpoint (404) | existing behaviour |
| The projection row | on the wake-up, usually milliseconds; at worst the next sweep, 60 s (PROVISIONAL, Q26) | sync, sweeper. It affects only list views, the displayed member count and the capacity switch (§11.2) |
| The removed person's app | the `community.member.removed` frame (P5), or the next 404 | realtime relay; HTTP |
| The messages they wrote | kept | [Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history), Q49 |

"Atomically enough": the only requests accepted after the commit are those
already in flight whose permits were read before it. Such a send is either
ordered before the projected removal, with a `createdAt` before the commit, or
refused under the lock (`send-message.use-cases.ts:155-158`). The cross-module view of the
same removal, including live, is the hub's
[Appendix A5](communities-live-attendance.md#a5-a-removed-member-loses-chat-and-live-access).

---

## 9. Read watermarks and history windows

- **Watermark on join.** `last_read_sequence` is set to the conversation's
  last sequence, read under the lock when the join is applied, as
  `newParticipant` does today (`participant.ts:55`). Nobody is greeted with
  thousands of unread messages.
- **History window.** `hidden_through_sequence` follows `COMMUNITY_HISTORY`, a
  constant in `messaging/domain`, PROVISIONAL `'FULL'`
  ([Q52](open-questions.md#q52--community-chat-history-for-newcomers-and-returners)):
  0, so newcomers see the whole history. This is Q21's channel rule
  ([Q21](open-questions.md#q21--does-someone-joining-a-group-see-what-was-said-before)).
  The alternative, `'FROM_JOIN'`, hides everything up to the last sequence at
  the apply. `historyHiddenThrough()` (`messaging-policy.ts:43-45`) stays the
  rule for the conversations messaging owns.
- **Rejoin.** A new stint starts a new window and a new watermark
  (PROVISIONAL, Q52, Q49). It is detected whether or not the leave was seen
  (§6.2).
- **Changing the answer.** Windows are stored per row, so an answer to Q52
  changes future joins only, and switching is one constant.
- **Moving the watermark** is unchanged: one clamped, forward-only UPDATE
  (`drizzle-messaging-repository.ts:299-327`), reached only after §7.1. Unread
  counts stay capped at 100 (`messaging-policy.ts:30`). Nobody sees how far
  others have read (Q25, unchanged).

Consequences, stated plainly:

- Messages sent between the authority's join and the apply count as read for
  the joiner, because the watermark is taken at the apply. Under `'FULL'` they
  are visible. Under `'FROM_JOIN'` they would be hidden, which fails closed.
- Under `'FULL'`, someone who joins through a leaked link sees the archive
  until they are removed
  ([Q48](open-questions.md#q48--invitation-links), Q52).
- A tombstone carries 0/0 and grants nothing.

---

## 10. Caps and size

- `MAX_PARTICIPANTS` (DIRECT 2, GROUP 500, CHANNEL 10,000) and
  `MAX_PARTICIPANTS_PER_REQUEST` (200) (`messaging-policy.ts:20-27`) apply only
  to conversations messaging owns (`community_id` NULL). The applier never
  consults them, and messaging's add route refuses community chats anyway.
- **A community's size is Communities' concern.** There is no ceiling as
  policy. If [Q20](open-questions.md#q20--messaging-limits) decides one, it is
  nullable Communities configuration, enforced in Communities' own conditional
  UPDATE under the community row lock: never a database CHECK, and never in
  messaging ([communities.md §5.4](communities.md#54-no-ceiling-as-policy)).
- **Capacity is handled by the gates in §11, not by caps.**

Engineering bounds, all PROVISIONAL
([Q26](open-questions.md#q26--realtime-limits)) and set from load profile 4:

| Bound | Value | Why |
| --- | --- | --- |
| States per apply | 1,000 | the contract page (`MAX_MEMBER_PAGE`); one batch is the longest a send waits |
| Sweep interval | 60 s | the worst-case lag after a lost wake-up |
| Background concurrency (sync plus sweeper) | 2 | the pool has 10 connections per process |
| Per-user rate limit on the new route | set in P4 | guards against probing community ids |
| `communityChatMaxServedMembers` | 250 | the switch for gates G1–G4 (§11.2): the largest fan-out any test exercises |
| Conversations per list page | 100 (existing) | `messaging-settings.ts:18` |

---

## 11. Fan-out at 30,000 members, and gates G1–G4

**30,000 members is a membership scale.** It is not 30,000 connections: one
instance holds 10,000 (`realtime-policy.ts:42`), and more than one instance
needs the broker of P11. It is not 30,000 live participants either: LiveKit
rooms are single-node, and the published figure of about 3,000 per room must
be benchmarked. LiveKit's documentation site could not be read from here, so
those facts come from the SDK and server source ([live.md](live.md)). A
community chat touches no LiveKit at all.

### 11.1 What one post costs

| Where | Existing code, applied to 30,000 members | With this design | Governed by |
| --- | --- | --- | --- |
| Messaging storage | O(1): the row lock, one append, the sender's watermark | unchanged | — |
| Access | — | one Communities statement per request; two for a send | — |
| Realtime relay | ⌈30,000 / 1,000⌉ = 30 recipient queries per message, on every instance with a connection (`messaging-relay.ts:207-219`) | at most 1 + ⌈A / 1,000⌉ ≤ 11 with `OnlineAudience`, where A is the accounts online on that instance (≤ 10,000) | G1 |
| Lag filter and ceiling | — | one `heads` per page; one `statesOf` per page while lagging; two `withPermission` per non-empty page | — |
| Notifications | 30 pages, each `listMemberIds`, `withPermission`, `describe`, preferences and `insertMany`: about 150 statements. Up to 29,999 rows and 29,999 `notification.created` events, each awaited through realtime and push; rows kept forever | unchanged | G4 |
| Member pages | primary-key scan filtered on `left_at`; slower as churn and tombstones grow | the partial index on current participants | G2 |

At 10 posts a day, one 30,000-member chat would store about 300,000
notification rows a day, about 110 million a year, under today's provisional
defaults ([Q27](open-questions.md#q27--how-long-are-notifications-kept),
[Q28](open-questions.md#q28--what-deserves-a-notification-and-how-loudly)).

Membership churn:

- **An import of 30,000** is at least 150 Communities add requests of 200.
  That is 30,000 `member.added` events, each an O(1) schedule. Messaging
  applies about 30 batches of 1,000, holding the conversation lock for one
  batch at a time, so sends interleave. Messaging itself publishes nothing: 0
  messaging events, 0 frames, 0 `ADDED_TO_CONVERSATION` notifications, 0
  messaging audit rows. (Messaging's own add path would cost 30,000 of each,
  §2.)
- **A join storm through one link** serializes on the community row in
  Communities, a per-community ceiling that profile 4 measures. Messaging
  coalesces the wake-ups, and joiners who open the chat are served by
  single-row repair.
- **The sweeper** costs 2 × ⌈communities / 1,000⌉ statements every 60 s.
- **The projection** is 30,000 rows plus tombstones.

### 11.2 Gates G1–G4

Community chats stay **disabled above the load-tested size** until all four
gates hold. No size is load-tested today; even the 10,000-member `CHANNEL`
figure is untested (`messaging.md:444-447`; `messaging-persistence.spec.ts:522-551`).

| Gate | What | Where | Phase |
| --- | --- | --- | --- |
| G1 | `OnlineAudience`: fan-out bounded by accounts online on the instance, not by members | realtime, internal (§12.5) | P5 |
| G2 | the partial index `conversation_participants_current_idx` on current participants | messaging (§12.3) | P4 |
| G3 | load profile 4 has run, and its results are filed under `docs/architecture/load-tests/` | [hub §21](communities-live-attendance.md#21-load-testing-plan) | P8 |
| G4 | Q27 and Q28 answered, or the cost of one notification row per reader per post explicitly accepted | notifications policy | — |

Notifications about community facts themselves (added, removed) are
[Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts);
none is built, so they add no cost in v1.

**The switch.** A messaging deployment setting,
`communityChatMaxServedMembers` (PROVISIONAL,
[Q26](open-questions.md#q26--realtime-limits)). Its default is 250, the
largest fan-out any test exercises (`messaging-persistence.spec.ts:522-551`).
It is compared with messaging's own `conversations.member_count`, the
projection's count. Communities' count cannot be used, because
`COMMUNITY_MEMBERSHIP` exposes none. Above the setting, a send to the
community chat returns 412 `messaging.community_chat_over_capacity` (§7.2,
§13), and `canPost` is false. Reading, marking read and the projection are
unaffected. With no new post there is no `message.sent`, so the relay and
the notification translator have nothing to fan out, and neither changes.
The count may lag the authority until the next sync or sweep, which is
acceptable for an engineering bound. The value is raised only when G1–G4 hold for the new
size.

---

## 12. Contract changes

### 12.1 Messaging: public

```ts
// messaging.module.ts
imports: [IdentityModule, FilesModule, CommunitiesModule]         // no forwardRef
providers += CommunityChatSync, CommunityChatSweeper, CommunityChatReconciler, GetCommunityChatUseCase
controllers += CommunityChatController
exports: [MESSAGE_RECIPIENTS, MESSAGE_DELIVERY]                    // UNCHANGED; no write or provisioning port
```

`MESSAGE_RECIPIENTS`: the signature is unchanged. The comment at
`message-recipients.ts:13-20` gains one paragraph:

```ts
/**
 * For a community chat (conversations.community_id set), "current members"
 * means messaging's NAMED PROJECTION of Communities' ACTIVE members: derived,
 * versioned, written only by the projection applier. While its version
 * differs from the community's head, each page is narrowed to the members
 * Communities reports ACTIVE. Every page, whatever readersOnly says, is then
 * narrowed to the accounts holding every permission of
 * COMMUNITY_CHAT_READ_CEILING. An unknown or unreadable community yields an
 * empty page. Delivery modules still never keep a copy.
 */
```

`ConversationResponse` gains `communityId: string | null` (additive; old apps
ignore it). For a community chat:

| Field | Value |
| --- | --- |
| `type` | `'CHANNEL'` (PROVISIONAL, Q51) |
| `communityId` | the community's id |
| `title` | from `COMMUNITY_DIRECTORY` |
| `canPost` | whether the `community.chat.post` permit is granted and `member_count` is within `communityChatMaxServedMembers` (§11.2) |
| `canManageMembers` | `false` |
| `myRole` | `'MEMBER'` |
| `memberCount` | the projection's count (display, and the capacity switch of §11.2; never an access answer; it may lag) |

New route:

| Route | Declared | Use-case authorization | Success | Refusals |
| --- | --- | --- | --- | --- |
| `GET /messaging/communities/:communityId/conversation` | `messaging.read` | `community.chat.read`; a per-user rate limit (PROVISIONAL, Q26) | 200 `ConversationResponse`. The conversation is materialized idempotently on the first positive permit, and the caller's row is repaired if behind | 404 `messaging.conversation_not_found`, identical for an unknown community, a non-member and an unreadable community; 429; 503 |

Existing routes gain the refusals of §13. Event semantics:

- `messaging.conversation.created`, `messaging.participant.added` and
  `messaging.participant.removed` are raised **only** for conversations whose
  membership messaging manages (`community_id` NULL). Their types are
  unchanged.
- `messaging.message.sent` and `messaging.message.read` are unchanged. For a
  community chat, `conversationType` is `'CHANNEL'`.
- `ConversationType` stays closed: `'DIRECT' | 'GROUP' | 'CHANNEL'`.

### 12.2 Messaging: internal ports (not public; listed for review)

```ts
// messaging/domain: pure; imports nothing from communities
interface Conversation { /* … */ readonly communityId: string | null; readonly projectedMembershipVersion: number | null }
interface Participant  { /* … */ readonly sourceVersion: number | null; readonly sourceMembershipId: string | null; readonly sourceJoinedAt: Date | null }
interface CommunityMemberState { readonly userId: string; readonly membershipId: string; readonly active: boolean; readonly joinedAt: Date; readonly version: number }
export const COMMUNITY_HISTORY: 'FULL' | 'FROM_JOIN' = 'FULL';   // PROVISIONAL (Q52)
function isCommunityChat(c: Conversation): boolean;
function projectMember(row: Participant | null, s: CommunityMemberState,
  c: Pick<Conversation, 'id' | 'lastSequence'>, at: Date):
  { next: Participant | null; transition: 'joined' | 'rejoined' | 'left' | 'tombstoned' | 'bumped' | 'ignored'; delta: -1 | 0 | 1 };

MessagingRepository += {
  materializeCommunityChat(i: { id: ConversationId; communityId: string; at: Date }): Promise<Conversation>;
  applyCommunityMembership(i: { conversationId: ConversationId; states: readonly CommunityMemberState[]; // ≤ 1000, distinct users
    advance: { from: number; to: number } | null; override?: true /* reconciler only */; at: Date }):
    Promise<{ kind: 'applied'; joined: number; rejoined: number; left: number; tombstoned: number; projectedVersion: number }
          | { kind: 'conversation_not_found' } | { kind: 'not_community_chat' }>;
  resetProjectedVersion(conversationId: ConversationId, to: number): Promise<void>;    // reconciler only
};
MessagingReadModel += {
  communityChatsFor(communityIds: readonly string[]): Promise<readonly { conversationId: string; communityId: string; projectedVersion: number }[]>;
  communityChat(communityId: string): Promise<{ conversationId: string; projectedVersion: number } | null>;
};
```

The names follow this package's naming rule (an earlier draft of this design
wrote them with "Group").
`addParticipants` and `removeParticipant` are untouched. Both the Drizzle
adapters and `InMemoryMessagingStore` implement the new methods with the same
semantics, so mock mode keeps working (`messaging.module.ts:65-83`).

### 12.3 Persistence (proposal: one additive migration in P4)

Existing rows get NULLs and keep today's behaviour.

```sql
-- conversations
ALTER TABLE conversations ADD COLUMN community_id text NULL;              -- plain text, no FK (schema.ts:17-23)
ALTER TABLE conversations ADD COLUMN projected_membership_version bigint NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_community_chat_shape CHECK (
      (community_id IS NULL) = (projected_membership_version IS NULL)
  AND (community_id IS NULL OR type <> 'DIRECT')
  AND (projected_membership_version IS NULL OR projected_membership_version >= 0));
-- conversations_title_shape (schema.ts:58-61) is replaced by:
--   ((type = 'DIRECT' OR community_id IS NOT NULL) = (title IS NULL))
--   AND (title IS NULL OR char_length(title) BETWEEN 1 AND 100)
-- conversations_type_valid (schema.ts:53) is UNCHANGED.
CREATE UNIQUE INDEX conversations_community_unique
  ON conversations (community_id) WHERE community_id IS NOT NULL;         -- decides racing materializations

-- conversation_participants
ALTER TABLE conversation_participants ADD COLUMN source_version bigint NULL;
ALTER TABLE conversation_participants ADD COLUMN source_membership_id text NULL;   -- the stint id; decides rejoins
ALTER TABLE conversation_participants ADD COLUMN source_joined_at timestamptz NULL;  -- provenance only
ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_source_shape CHECK (
      (source_version IS NULL) = (source_membership_id IS NULL)
  AND (source_version IS NULL) = (source_joined_at IS NULL)
  AND (source_version IS NULL OR source_version > 0)
  AND (source_version IS NULL OR (role = 'MEMBER' AND added_by IS NULL)));
CREATE INDEX conversation_participants_current_idx                        -- gate G2
  ON conversation_participants (conversation_id, user_id) WHERE left_at IS NULL;
```

The existing CHECKs already admit tombstones: `read_state_valid` accepts 0/0
and `left_after_joined` accepts `left_at = joined_at` (`schema.ts:101-108`).

### 12.4 Notifications

- **No change in P4.** `MessagingNotificationTranslator` is unchanged. It
  receives lag-filtered pages from `MESSAGE_RECIPIENTS`, already narrowed by
  the `community.chat.read` ceiling (§7.3), so neither a removed member nor
  one whose role lost `communities.read` is notified.
- Because messaging raises no participant events for community chats, no
  `ADDED_TO_CONVERSATION` or `CONVERSATION_CREATED` notification is ever
  created for them.
- The cost stays one row per reader per post, kept forever. That is gate G4:
  [Q28](open-questions.md#q28--what-deserves-a-notification-and-how-loudly)
  and [Q27](open-questions.md#q27--how-long-are-notifications-kept).
- **Later (P10, only after Q28).** The collapse seam Q28 already documents: a
  translator key, one unread notification per conversation updated in place
  (`open-questions.md:651-653`). An additive `memberCount` on `message.sent`
  only if Q28's answer depends on audience size. Notifications about
  community facts themselves (added, removed) are
  [Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts);
  none in v1.

### 12.5 Realtime

- **Internal, additive (G1, P5).** `ConnectionManager.onlineUserIds()`
  returns the keys of `byUser` (`connection-manager.ts:24`). `OnlineAudience`
  reads page 1 (at most 1,000). If there is no next page, it keeps that
  page's online members. Otherwise it returns the union of
  `list({onlyUserIds: chunk, visibleSequence})` over chunks of 1,000 online
  accounts, using the existing `onlyUserIds` (`message-recipients.ts:40-44`).
  `MessagingRealtimeRelay.onlineMembers` (`messaging-relay.ts:207-219`) moves
  onto it, passing `visibleSequence` through. No contract changes.
- **No new frame for the chat.** It travels as the existing `message.sent` and
  `message.read`, with `conversationType` `'CHANNEL'`. `subscribe` is
  unchanged. Protocol v1 is not bumped. The `community.member.added` and
  `community.member.removed` frames come from `CommunitiesRealtimeRelay` (P5),
  to the affected user only ([hub §16](communities-live-attendance.md#16-realtime-transport-matrix)).
- **The connection gate stays `messaging.read`** (`realtime-sessions.ts:442-444`;
  [Q66](open-questions.md#q66--realtime-without-messagingread)). The
  `community.chat.read` ceiling includes `messaging.read`, so no reader of a
  community chat is shut out by it. The gate checks only `messaging.read`, so
  the rest of the ceiling is applied to each recipient page (§7.3), not left
  to the connection.
- **LiveKit carries nothing of the chat.** No data channel is used.

### 12.6 What Communities provides

Messaging consumes, and does not change, `COMMUNITY_AUTHORIZATION`,
`COMMUNITY_MEMBERSHIP`, `COMMUNITY_DIRECTORY` and `CommunityEvents`
([communities.md §10](communities.md#10-public-contracts)). It needs one
addition: `COMMUNITY_CHAT_READ_CEILING` in `capabilities.ts`, the permission
list of the `community.chat.read` ceiling, which Communities' act table also
uses (§7.3). Two properties it relies on:

- `changesSince` is **one statement**, so the states and the head come from
  one snapshot. It returns the latest state per user, in ascending version
  order, with `throughVersion` and `hasMore`. It never skips a version while
  writers commit, because versions are allocated under the community row lock
  in commit order ([communities.md §5.2](communities.md#52-counters-and-version-allocation)).
- `CommunityPermit.membership` carries `{membershipId, joinedAt, version}`,
  which is what repair on access needs.

### 12.7 Flutter (P5)

- `Conversation.communityId: String?`, parsed defensively.
- `MessagingRepository.conversationForCommunity(communityId)`, calling the
  new route, in both the HTTP and the mock repository.
- The current app already renders a community chat as a channel and posts
  according to `canPost`, because both come from the server
  (`messaging.dart:225-226`).

---

## 13. Error codes

| Situation | Kind | HTTP | Code | Note |
| --- | --- | --- | --- | --- |
| Unknown community, non-member, unreadable community (`chatReadable` false), or a removed member | `not_found` | 404 | `messaging.conversation_not_found` | identical in every case, and identical to a missing conversation |
| Add, remove (the owner route and the `messaging.manage` route) or leave on a community chat | `precondition_failed` | 412 | `messaging.membership_managed_by_community` | evaluated after the membership check, so a non-member still gets 404. Refused even for the OWNER role holding every permission |
| List a community chat's participants | `forbidden` | 403 | `messaging.members_hidden` (existing) | after the membership check |
| Send without the `community.chat.post` permit (no capability, no ceiling, or LOCKED) | `forbidden` | 403 | `messaging.posting_not_allowed` (existing) | after the read check |
| Send to a community chat whose `member_count` is above `communityChatMaxServedMembers` | `precondition_failed` | 412 | `messaging.community_chat_over_capacity` | after the post permit, so only a poster learns the chat is over the switch (§11.2) |
| A Communities call rejects (store failure, timeout) | `unavailable` (P0) | 503 | `unavailable` | fail closed; never a role-only answer |
| The same, on realtime `subscribe` | — | — | frame `SERVER_ERROR` | the default branch of `realtime-sessions.ts:339-340` |
| Too many requests to the new route | `rate_limited` | 429 | set in P4 | PROVISIONAL limit, Q26 |

An earlier draft of this design spelled the 412 code
`messaging.membership_managed_by_group`. It was renamed under this package's
rule that code says Community, never Group
(the hub's opening,
[communities-live-attendance.md](communities-live-attendance.md)).

---

## 14. Sequences

Numbered messages; participants are columns. The cross-module versions (with
the invitation redemption and live) are the hub's
[Appendix A1](communities-live-attendance.md#a1-join-through-an-invitation-link-then-open-the-chat)
and [A5](communities-live-attendance.md#a5-a-removed-member-loses-chat-and-live-access).

### S1. A member joins and can read

```
 App (U)         Communities         Bus        CommunityChatSync       GetCommunityChat        messaging tables
    │                 │               │                 │                       │                       │
    │ 1 POST /communities/join {token}│                 │                       │                       │
    │────────────────▶│               │                 │                       │                       │
    │                 │ 2 COMMIT: stint ACTIVE (membershipId m, joinedAt J, version v)                  │
    │                 │ 3 audit; publish communities.member.added {C, U, m, v}  │                       │
    │                 │──────────────▶│                 │                       │                       │
    │ 4 201           │               │                 │                       │                       │
    │◀────────────────│               │                 │                       │                       │
    │                 │               │ 5 wake-up: schedule(C), returns at once │                       │
    │                 │               │────────────────▶│                       │                       │
    │                 │ 6 changesSince(C, p, 1000) → [U ACTIVE m v], through v  │                       │
    │                 │◀────────────────────────────────│                       │                       │
    │                 │               │                 │ 7 apply [U ACTIVE m v]: BEGIN; conversation K FOR UPDATE;
    │                 │               │                 │   insert U (MEMBER, lastRead = K.lastSequence, hidden 0
    │                 │               │                 │   [FULL, Q52], source v/m/J); member_count+1; projected v; COMMIT
    │                 │               │                 │──────────────────────────────────────────────▶│
    │ 8 GET /messaging/communities/C/conversation       │                       │                       │
    │──────────────────────────────────────────────────────────────────────────▶│                       │
    │                 │ 9 authorize(U, C, community.chat.read) → permit {m, J, v}                       │
    │                 │◀────────────────────────────────────────────────────────│                       │
    │                 │               │                 │                       │ 10 K missing? materialize:
    │                 │               │                 │                       │    INSERT … ON CONFLICT DO NOTHING
    │                 │               │                 │                       │──────────────────────▶│
    │                 │               │                 │                       │ 11 U's row active, source ≥ v?
    │                 │               │                 │                       │    yes → 13. No (7 has not run):
    │                 │               │                 │                       │ 12 repair: apply [U ACTIVE m v]
    │                 │               │                 │                       │    alone, under K's row lock
    │                 │               │                 │                       │──────────────────────▶│
    │                 │ 13 authorize(U, C, community.chat.post) and the capacity│                       │
    │                 │    switch (§7.2) → canPost;                             │                       │
    │                 │    COMMUNITY_DIRECTORY.describe([C]) → title            │                       │
    │                 │◀────────────────────────────────────────────────────────│                       │
    │ 14 200 ConversationResponse {type CHANNEL, communityId C, title, canPost, canManageMembers false} │
    │◀──────────────────────────────────────────────────────────────────────────│                       │
```

- Steps 7 and 11–12 race harmlessly: whichever applies first, the other finds
  the row at version v and does nothing (the per-row guard).
- If the wake-up at step 5 is lost, step 12 serves U anyway, and the sweeper
  applies the rest of the community's changes (S3).
- The redemption itself (the token, the use count, the lock gate) is
  [communities.md S3](communities.md#s3--redeem-a-link-p2).

### S2. A member is removed while sending

```
 App (U)        MessageSender        Communities       Manager app      CommunityChatSync   conversation K (row lock)
    │                 │                   │                 │                   │                       │
    │ 1 POST /messaging/conversations/K/messages/text (draft.createdAt = t0)    │                       │
    │────────────────▶│                   │                 │                   │                       │
    │                 │ 2 messaging.send; K is C's chat → authorize chat.read, then chat.post           │
    │                 │──────────────────▶│                 │                   │                       │
    │                 │ 3 both permits ok (read at t1)      │                   │                       │
    │                 │◀──────────────────│                 │                   │                       │
    │                 │                   │ 4 DELETE /communities/C/members/U   │                       │
    │                 │                   │◀────────────────│                   │                       │
    │                 │                   │ 5 COMMIT at t2 > t1: U's stint REMOVED, version v+1         │
    │                 │                   │ 6 publish communities.member.removed {C, U, m, REMOVED, v+1}│
    │                 │                   │────────────────────────────────────▶│                       │
    ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ case A: the send takes K's lock first ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
    │                 │ 7a appendMessage: FOR UPDATE; U's row still ACTIVE → sequence s; COMMIT         │
    │                 │────────────────────────────────────────────────────────────────────────────────▶│
    │                 │                   │                 │                   │ 8a apply [U LEFT v+1]: left_at,
    │                 │                   │                 │                   │    member_count − 1, projected v+1
    │                 │                   │                 │                   │──────────────────────▶│
    │ 9a 201; s is ordered before the projected removal, and t0 < t2            │                       │
    │◀────────────────│                   │                 │                   │                       │
    ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ case B: the apply takes K's lock first ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
    │                 │                   │                 │                   │ 7b apply [U LEFT v+1] │
    │                 │                   │                 │                   │──────────────────────▶│
    │                 │ 8b appendMessage: re-check under the lock → not_participant                     │
    │                 │────────────────────────────────────────────────────────────────────────────────▶│
    │ 9b 404 messaging.conversation_not_found               │                   │                       │
    │◀────────────────│                   │                 │                   │                       │
    ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ either case: every request after t2 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
    │ 10 read, send, mark read, attachment link or subscribe│                   │                       │
    │────────────────▶│                   │                 │                   │                       │
    │                 │ 11 authorize(U, C, community.chat.read) → not_found     │                       │
    │                 │──────────────────▶│                 │                   │                       │
    │ 12 404 messaging.conversation_not_found (identical to a missing conversation); sync scheduled     │
    │◀────────────────│                   │                 │                   │                       │
```

- In case A the message was authorized before the removal committed, and its
  `createdAt` (t0) precedes the commit (t2). It is the kind of in-flight
  request "atomically enough" allows (§8).
- Fan-out of any message after step 5 excludes U, whether or not the apply has
  run: the lag filter asks `statesOf` while the versions differ.

### S3. The projection catches up after a missed event

```
 Communities           Bus        MessageRecipients   CommunityChatSweeper    CommunityChatSync   messaging tables
      │                 │                 │                     │                     │                   │
      │ 1 COMMIT: U1 removed (version v+1), U2 joined (v+2)     │                     │                   │
      │ 2 publish member.removed, member.added                  │                     │                   │
      │─────────╳       │                 │                     │                     │                   │
      │                 │   the process dies first, or the handler throws: no wake-up │                   │
    ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ until the sweep: access and fan-out stay correct ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
      │                 │                 │ 3 a message.sent is fanned out: list(K, page 1)               │
      │ 4 heads([C]) → v+2 ≠ projected v → statesOf(C, page ids)│                     │                   │
      │◀──────────────────────────────────│                     │                     │                   │
      │                 │                 │ 5 page = projected rows ∩ ACTIVE: U1 dropped, U2 not yet in it│
      │                 │                 │ 6 schedule(C) (a sync may already start here)                 │
      │                 │                 │──────────────────────────────────────────▶│                   │
    ┄┄┄┄┄┄┄┄┄┄┄┄┄┄ after a restart the in-memory schedule is gone: the sweeper finds the lag ┄┄┄┄┄┄┄┄┄┄┄┄┄┄
      │                 │                 │                     │ 7 boot, then every 60 s (PROVISIONAL, Q26)
      │ 8 listHeads(after, 1000) → [… C: membershipVersion v+2 …]                     │                   │
      │◀────────────────────────────────────────────────────────│                     │                   │
      │                 │                 │                     │ 9 communityChatsFor(page ids) → K: projected v
      │                 │                 │                     │────────────────────────────────────────▶│
      │                 │                 │                     │ 10 v < v+2 → schedule(C)                │
      │                 │                 │                     │────────────────────▶│                   │
      │ 11 changesSince(C, v, 1000) → [U1 LEFT v+1, U2 ACTIVE v+2], through v+2, hasMore false            │
      │◀──────────────────────────────────────────────────────────────────────────────│                   │
      │                 │                 │                     │                     │ 12 apply: K FOR UPDATE; U1 left (−1),
      │                 │                 │                     │                     │    U2 joined (+1); per-row guard;
      │                 │                 │                     │                     │    projected v ≥ from v → greatest = v+2
      │                 │                 │                     │                     │──────────────────▶│
      │                 │                 │ 13 next walk: projected = head → plain projection pages, U2 included
```

- Between steps 2 and 12, HTTP stays correct: U1 gets 404 on every request,
  and U2 is served after repair on access if they open the chat.
- The only cost of the lost wake-up is U2 missing frames and notifications
  for messages sent before step 12, unless U2 opened the chat meanwhile and
  was repaired. That fails closed; U2 reads them over HTTP.
- Two appliers on one range (the loop and a second instance, say) serialize
  on K's lock. The second finds every row at its version and changes nothing,
  and `greatest()` keeps the projected version monotonic.

---

## 15. Failure modes

| Case | Semantics |
| --- | --- |
| **Communities is down** (store error or timeout) | Every community-chat request fails closed with 503 `unavailable`; `subscribe` gets `SERVER_ERROR`. Nothing falls back to a role-only answer. `MESSAGE_RECIPIENTS` throws for community chats; the relay and translator log it (`messaging-relay.ts:103-107`). Realtime clients recover by sequence over HTTP. Notifications for that message may be lost, never the message (`messaging-notification.translator.ts:59-60`). The sync and the sweeper skip and retry on the next tick. Conversations messaging owns are unaffected: their path never calls Communities |
| **The projection is behind** (a lost or slow wake-up) | Access stays correct: the authority is asked on every request, and repair on access fixes the caller's own row. Fan-out stays correct: the lag filter. List views may omit a new member's chat until the sync runs. The sweeper converges within 60 s (PROVISIONAL, Q26). Metric: the age of the oldest lag |
| **The projection is ahead** (the authority restored from a backup) | Detected (projected > head). The reconciler rebuilds; the lag filter stays on until the versions match. A member whose row carries a newer tombstone gets 404 until then |
| **A community's first wake-up is lost before its chat exists** | The sweeper finds a head with no chat and materializes it. A member opening the chat first materializes it through the route |
| **The sweeper crashes** (a tick throws, or it stops) | The sweeper is stateless: a failed tick is logged and the next starts from the first page. Every apply it triggered is one transaction, committed or rolled back. Correctness does not depend on it. If it stays down, the projection can lag indefinitely: removed members are still filtered, but new members miss frames, notifications and list entries until they open the chat. The age-of-oldest-lag metric is the alarm |
| **The backend restarts** during an apply, a sync loop or a fan-out | An apply either committed (the version advanced) or rolled back. The in-memory schedule, the rerun flags and the per-conversation delivery chains are lost. The boot sweep finds every lag. Realtime clients catch up by sequence; notification dedupe keys prevent duplicates |
| **Wake-ups duplicated, reordered, forged in-process, or handled on two instances** | The applier reads nothing from the payload but `communityId` and pulls `changesSince`. The per-row guard makes a replay a no-op; `greatest()` and the contiguity check keep the projected version monotonic; one loop at a time per community bounds the work |
| **Concurrent appliers** (loop, sweeper, repair, a second instance) | All serialize on the conversation row lock. Tombstones stop an older ACTIVE from bringing back a LEFT member. `member_count` moves only on real transitions, computed from rows read under the lock |
| **A removal races a send** | S2. Only a send whose permits were read before the commit can land, ordered before the projected removal |
| **A join races a message** | The joiner's window and watermark are computed under the lock at the apply (§9) |
| **A leave is missed, then the person rejoins** | The new stint's `membershipId` differs from `source_membership_id`, so it is a rejoin: window and watermark reset, even if the clock stepped back or both stints share a `joinedAt` |
| **The community is locked, or a grant is revoked, during a send** | The permit is asked on each send. A send whose permit was read before the change committed may land, a window of milliseconds ([communities.md §8.4](communities.md#84-lock-concurrency-and-idempotency)). Reading continues while LOCKED (Q46) |
| **An unrecognised community status** (`chatReadable` false) | Every access returns 404 and recipient pages are empty. Messages are kept (Q3). The sweeper counts orphans |
| **A bulk apply competes with sends in a busy chat** | The lock is held for one batch of at most 1,000 rows, so a send waits at most one batch. Profile 4 measures the hold time |
| **An account is suspended, or loses `messaging.read` or `communities.read`** | Identity refuses at authentication and authorization, and without `communities.read` the permit is refused (404); the ceiling narrowing of §7.3 drops it from every recipient page, so it gets no frame and no notification row; an open realtime connection is re-checked within 60 s (`realtime-policy.ts:34`). The projection is unaffected: membership is not identity's concern ([Q13](open-questions.md#q13--what-do-suspended-and-disabled-mean-and-who-may-move-an-account-between-them)) |
| **No database is configured** (mock mode) | Communities provides in-memory adapters for its contracts; `InMemoryMessagingStore` implements materialization, the apply and `communityChatsFor` with the same register semantics. The same contract suites run against both adapters |

---

## 16. Security

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Self-admission to a community chat through messaging, or through an in-process call | No write path exists into community-chat membership. Add, remove and leave are refused; no provisioning port is exported, so realtime and notifications, which import `MessagingModule`, cannot inject members. Repair creates a row only from an ACTIVE permit, a membership Communities committed | A flaw in Communities' admission propagates; that is the invitation design's threat model ([communities.md §15](communities.md#15-security)) |
| A stale projection used to read or post after removal | The authority is asked on every access; list pages are filtered through `authorizeEach`; fan-out is lag-filtered | Requests already in flight whose permits were read before the commit (S2) |
| Probing community ids through the new route | The same 404 for an unknown community, a non-member and an unreadable community. Nothing is created without a positive permit. `messaging.read` is required, plus a per-user rate limit | Small timing differences |
| Disclosure of a large roster of minors through messaging | `ListParticipants` refuses community chats. Events and frames never carry member lists. `MESSAGE_RECIPIENTS` is in-process only | Depends on Communities' roster policy (Q22) |
| Posting privilege escalation (a client claims a role) | `canPost` is decided per request by Communities from the server-built `Principal`. The projected role is always MEMBER and ignored. `ConversationResponse.canPost` is display only | None in messaging |
| A leaked invitation link exposes the archive | Link expiry, revocation and use limits are Communities' (Q48). Removal takes effect at the commit. History for joiners is one constant (Q52) | Under the provisional `'FULL'`, a joiner through a leaked link sees history until removed |
| Notifications or realtime becoming an authorization bypass | No new delivery path. Recipients are resolved at delivery time from the projection, narrowed through the authority while lagging, and on every page by the full `community.chat.read` ceiling from `COMMUNITY_CHAT_READ_CEILING`, whatever `readersOnly` says (§7.3). So a member refused on HTTP for a lost ceiling gets no frame and no notification either. Notifications carry no message text, and opening one runs the checkpoint | A removed member keeps notification rows already stored (no content). Frames whose recipients were resolved before a role change may still arrive |
| Abuse of the system label | `system:messaging-community-chat` only fills `created_by`. It is never passed to `AuthorizationService`, never exposed, and authorizes nothing | None |
| Membership races (concurrent join and leave, duplicate joins, out-of-order sync) | Per-community versions in commit order; the per-row guard, repeated in the database; tombstones; the contiguous, monotonic advance | Covered by the tests in §17 |
| Title disclosure | `COMMUNITY_DIRECTORY` is asked only for rows the viewer may read | None |
| Event payload leakage | Wake-ups carry ids and versions only. Messaging raises nothing for applies | None |

---

## 17. Tests

| Level | Test | Phase |
| --- | --- | --- |
| Architecture | `messaging-boundaries.spec.ts`, extended: messaging reaches communities only through `contracts/` and `communities.module.ts`; `messaging/domain` reaches no communities file (`:27-41` unchanged); messaging still never reaches live, with `communities/contracts` in the graph (`:43-50` unchanged); `MessagingModule` exports exactly `[MESSAGE_RECIPIENTS, MESSAGE_DELIVERY]` | P4 |
| Architecture | `no-circular` and the no-`forwardRef` test stay green. `authorization.spec.ts:79-94` lists `CommunityChatController`, and its route declares exactly one access level | P4 |
| Wiring | A Nest smoke test: `AppModule` compiles; `COMMUNITY_AUTHORIZATION` resolves inside `MessagingModule`; `CommunitiesModule`'s imports contain no messaging module | P4 |
| Unit (pure) | The `projectMember` truth table: {absent, ACTIVE, LEFT} × {ACTIVE same `membershipId`, ACTIVE new `membershipId` (including one with an equal or earlier `joinedAt`), LEFT} × {older, equal, newer version} gives the next state, transition and Δ. A missed-leave rejoin resets window and watermark; a tombstone keeps its version; `'FULL'` gives hidden 0 and `'FROM_JOIN'` gives the last sequence | P4 |
| Property | Any permutation, duplication, or loss-then-resend of a member's state log, applied by 1–3 concurrent appliers, converges to the highest-version state, and `member_count` equals the active rows | P4 |
| Postgres | 20 concurrent materializations for one community produce exactly 1 conversation | P4 |
| Postgres (regression) | An apply with `advance {from: 10, to: 20}` after the projected version reached 50 leaves it at 50. Across 1,000 random interleavings it never decreases, and `member_count` stays exact when the contiguity check fails | P4 |
| Postgres | Two appliers on the same range give an identical final state; the database guard holds when application filtering is bypassed | P4 |
| Postgres (race) | 50 rounds of a concurrent send and removal (the authority commit, then the sync): every stored message from U has either permits read before the commit or a sequence below the projected removal; no request whose permit was read after the commit is accepted. Extends `messaging-persistence.spec.ts:250-260` | P4 |
| Postgres (drift) | Wake-ups duplicated, reordered or dropped still leave the projection equal to the authority. 100 wake-ups during one run cause at most 2 loop executions. The sweeper materializes a community whose first wake-up was dropped, and converges a lag after a simulated restart | P4 |
| Postgres (lag filter) | A member removed in the authority but not yet projected receives no frame and no notification row for a new message. `chatReadable` false yields empty pages | P4 |
| Application (ceiling) | An ACTIVE, projected member whose role loses `communities.read` gets 404 on HTTP and receives no `message.sent` frame and no notification row, with projection versions equal and with `readersOnly` absent or true. Communities' act table and `MESSAGE_RECIPIENTS` read the same `COMMUNITY_CHAT_READ_CEILING` | P4 |
| Application (capacity switch) | With `communityChatMaxServedMembers` = 3 and 4 projected members, the post-permit holder gets 412 `messaging.community_chat_over_capacity` and `canPost` false; reading and marking read still succeed; no `message.sent` is published. At 3 members the send succeeds | P4 |
| Postgres (reconciler) | Authority restored behind the projection: merge-join rebuild, projected version reset to the head, warning and metric logged, no audit row | P4 |
| Postgres (scale) | 30,000 members in 30 batches: the lock hold per batch is recorded; sends from other members succeed between batches; the `MESSAGE_RECIPIENTS` walk returns every member exactly once (extends `messaging-persistence.spec.ts:522-551` from 250); `EXPLAIN` shows `conversation_participants_current_idx` for member pages under 50% churn | P4 |
| Application | With the real authorization service and in-memory adapters: a member removed in the authority but still projected gets 404 and a sync is scheduled; a member joined but not yet projected gets 200 after the inline repair; an unknown community and a real one the caller is not in give byte-identical 404s; a refused `chat.post` gives 403 | P4 |
| Security | Repair never creates a row without an ACTIVE permit: a non-member calling the new route or any conversation route 100 times creates nothing. Add, remove (both routes) and leave return 412 even for the OWNER role with every permission. Listing participants returns 403. The existing `security.spec.ts` and `membership.spec.ts` pass **unmodified** | P4 |
| Events | With a bus spy: materialization and applies publish no `messaging.*` event and write no audit row; `message.sent` in a community chat carries `CHANNEL` | P4 |
| Failure | A rejected Communities call gives 503 on HTTP and `SERVER_ERROR` on `subscribe`, never a success; the sweeper skips the tick | P4 |
| Mock parity | The same contract suites run against Drizzle and the in-memory adapters, for messaging (materialize, apply, `communityChatsFor`) and for Communities (`authorize`, `changesSince`, `listHeads`) | P4 |
| Realtime (G1) | `OnlineAudience` returns exactly the full walk's recipients, intersected with online accounts, over random memberships and online sets; with 30,000 members and 50 online it makes at most 2 calls. The existing relay specs pass | P5 |
| Flutter | A community chat typed `CHANNEL` renders and posts according to `canPost` in the current app; `communityId` parsing and `conversationForCommunity` in the HTTP and mock repositories | P5 |
| Load (G3) | Profile 4 on the target topology: a 30,000-member chat at 0.1–20 messages/s with 1%, 10% and 33% online (realtime query rate, CPU, p99 send latency, notification rows/s); a join storm through one link (community-row lock wait, repair rate, send lock-wait p99); an import of 30,000 (total time, longest send stall) | P8 |

---

## 18. Open questions this design depends on

Every default below is PROVISIONAL; the design changes by one constant or one
act rule when a question is answered.

| Question | What it decides here | Provisional default |
| --- | --- | --- |
| [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules) | Whether P2, and so P4, may start | The §13 gate applies; P2, and so P4, waits for the §13 step (Q35/Q36 and ADR 0015) or the user's ruling on Q40 |
| [Q51](open-questions.md#q51--the-community-chat-who-may-post) | One chat per community; who posts | At most one chat, stored as `CHANNEL`; `chat.post` = the owner or a grant, refused while LOCKED; no message moderation in v1 |
| [Q52](open-questions.md#q52--community-chat-history-for-newcomers-and-returners) | History for joiners and returners | `COMMUNITY_HISTORY = 'FULL'`; a rejoin starts a new window and watermark |
| [Q53](open-questions.md#q53--system-notices-in-a-community-chat) | System notices in the chat | None; the chat is written by people only |
| [Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock) | What LOCKED does to the chat | Reading continues; posting stops |
| [Q49](open-questions.md#q49--leaving-removal-and-rejoining) | Leaving, removal, rejoining | Through Communities only; messaging refuses with 412 |
| [Q43](open-questions.md#q43--institutional-oversight-of-communities) | Whether oversight reads the chat | Never |
| [Q48](open-questions.md#q48--invitation-links) | Link risk that reaches the archive | Communities' link rules; see Q52 |
| [Q66](open-questions.md#q66--realtime-without-messagingread) | The realtime connection gate | Stays `messaging.read` |
| [Q67](open-questions.md#q67--notifications-for-community-live-and-attendance-facts) | Notifications for community facts | None in v1 |
| [Q20](open-questions.md#q20--messaging-limits), [Q26](open-questions.md#q26--realtime-limits) (existing) | Community size; operational bounds | No member limit; messaging's caps do not apply; posting closed above `communityChatMaxServedMembers` (250) until G1–G4 hold (§11.2); engineering bounds from profile 4 |
| [Q22](open-questions.md#q22--who-may-see-who-is-in-a-conversation) (existing) | Who sees the roster | Messaging never lists it (`members_hidden`) |
| [Q27](open-questions.md#q27--how-long-are-notifications-kept), [Q28](open-questions.md#q28--what-deserves-a-notification-and-how-loudly) (existing) | Notification cost per post | Today's behaviour; gate G4 |
| [Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history), [Q23](open-questions.md#q23--moderation-deletion-and-review) (existing) | Retention; moderation of messages | Nothing deleted; `community.messages.moderate` reserved |

---

## 19. Later, and the documents this changes

Deliberately later:

- **The Q28 collapse seam** and an optional `memberCount` on `message.sent`
  (P10, only after Q28).
- **Carrying the lag flag in the recipients cursor**, so a walk checks the
  head once instead of once per page.
- **`community.messages.moderate`** (P12, after Q51 and Q23). Messaging will
  ask one more permit; no new projection is needed.
- **Sequence allocation without the row lock**, if Q51 lets many people post.
- **The broker and the outbox** (P11), only when their triggers hold (ADR 0021).

Documents and code comments to change when P4 lands: `messaging.md`
(community chats, the 412 refusals, `members_hidden`, no messaging cap, the
lag filter, the ceiling narrowing, G1–G4, the new route); the
`MESSAGE_RECIPIENTS` comment (`message-recipients.ts:13-20`); the
`MessagingModule` header, which says it depends "on nothing else"
(`messaging.module.ts:50-60`); and the messaging section of
`module-boundaries.md`. This package added only a Proposed-change pointer to
`messaging.md` and to that section, plus a correction note in `messaging.md`
§11; the rewrites land with P4. If accepted, ADR 0018 would supersede ADR 0011
§4–5 in part, because messaging would no longer own membership for
conversations linked to a community (`0011-messaging-v1.md:41-52`). ADRs are
never edited.
