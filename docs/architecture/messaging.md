# Messaging

**State: implemented (V1).** Domain, use cases, Postgres persistence, HTTP
API, events, notifications fan-out, and the first backend-backed Flutter
feature. Decisions are recorded in
[ADR 0011](decisions/0011-messaging-v1.md), building on
[ADR 0007](decisions/0007-messaging-architecture.md).

Messaging is a persistent, permission-aware subsystem, not a chat mock. Every
property below is enforced in code, and the ones that must hold under
concurrency are enforced by the database and tested against Postgres.

---

## 1. Conversation types

One model, three types. The differences are participation rules, not
separate entities (ADR 0007).

| Type | Members | Who may post | Membership changes | History for newcomers |
| --- | --- | --- | --- | --- |
| `DIRECT` | exactly 2 | both | never — fixed at creation | n/a |
| `GROUP` | ≤ 500 (provisional) | every member | the OWNER adds and removes; members leave | **hidden** — starts at the join (Q21) |
| `CHANNEL` | ≤ 10,000 (provisional) | OWNER and PUBLISHERs | the OWNER adds and removes; members leave | **full** history (Q21) |

Roles *inside a conversation* — `OWNER`, `PUBLISHER`, `MEMBER` — are
checked **in addition to** institutional permissions, never instead of them.
`MODERATOR` and `ADMIN` conversation roles are the expected next members of
that list; the column is text + CHECK, so adding one is a cheap migration.

At most **one direct conversation exists per pair of people**. The pair is
stored ordered (`direct_user_low < direct_user_high`) under a unique
constraint, and creation is `INSERT … ON CONFLICT DO NOTHING` followed by a
read — never find-then-insert. Twenty simultaneous "start a DM" requests from
both sides produce one conversation (tested on Postgres).

---

## 2. The model

```
Conversation   id, type, title?, created_by, created_at,
               direct_user_low?, direct_user_high?,      ← DIRECT only, unique pair
               last_sequence, last_message_at?,          ← ordering authority
               member_count                              ← kept in the same transactions

Participant    (conversation_id, user_id) PK, role, joined_at, left_at?,
               added_by?, last_read_sequence, hidden_through_sequence

Message        id, conversation_id, sequence, sender_id, type,
               body?, reply_to_message_id?, client_message_id,
               created_at, edited_at?, deleted_at?

MessageAttachment  (message_id, position) PK, file_asset_id   ← a reference, never bytes
```

Message types: `TEXT`, `VOICE`, `IMAGE`, `FILE`. **Video is not in V1** and
the shape does not preclude it: a `VIDEO` type is a new enum member, a new
file kind in the files policy, and one typed send use case.

`body` is the text of a `TEXT` message and the optional caption of media.
It is stored normalized — NFC, `\n` line endings, control characters removed,
trimmed — and bounded at 4,000 code points (not UTF-16 units). Direction
marks are deliberately **kept**: mixed Arabic and Latin text needs them.

Account ids and file ids are **not** foreign keys: those rows belong to
identity and files, and no module holds a constraint on another's tables.
Inside messaging, the keys are real (participants → conversations, messages →
conversations, attachments → messages, replies → messages).

---

## 3. Ownership

Messaging owns conversations, participants, membership, ordering, lifecycle
and read state. No other module reads or writes its tables — dependency-cruiser
forbids importing `messaging/infrastructure/`, and an architecture test states
it by name. Other modules learn about messaging through:

- **events** (`messaging.*`, §9), and
- **`MESSAGE_RECIPIENTS`** — the current members of a conversation, paged, for
  delivery modules (notifications today, a realtime gateway later).

---

## 4. Sending

Four typed use cases, one per message type — never `send(type, anything)`:

| Use case | Route | Accepts |
| --- | --- | --- |
| `SendTextMessageUseCase` | `POST /messaging/conversations/:id/messages/text` | `body` |
| `SendVoiceMessageUseCase` | `…/messages/voice` | one `VOICE` file |
| `SendImageMessageUseCase` | `…/messages/image` | one `IMAGE` file, caption |
| `SendFileMessageUseCase` | `…/messages/file` | one `DOCUMENT` or `AUDIO` file, caption |

All four go through one pipeline (`MessageSender`), cheapest refusal first:

1. `messaging.send`, then the per-user rate limit (provisional 120/minute);
2. the draft is well-formed — key shape, body length, text present;
3. the sender is a **current member**, and may post here (channels: owner and
   publishers only);
4. a reply points at a message **in this conversation that the sender can
   see** (another conversation's message, or one from before they joined, is
   "not found" — a reply must not become a way to learn a message exists);
5. an attachment is **the sender's own, verified** upload of an accepted kind
   (`FILE_ASSETS.verifyAttachable`); someone else's upload is reported exactly
   like a missing one;
6. the append, under the conversation's row lock (§5).

Only a newly stored message raises `messaging.message.sent`.

---

## 5. Ordering

**The server orders messages. Clients never do, and clocks never do.**

Each conversation has a counter, `last_sequence`. Appending a message:

```
BEGIN
  SELECT … FROM conversations WHERE id = $1 FOR UPDATE   -- the lock
  re-check: sender is a current member                   -- a removal cannot slip past
  idempotency: (conversation, sender, client key) exists? → return it
  sequence := last_sequence + 1
  UPDATE conversations SET last_sequence = sequence, last_message_at = now
  INSERT message (…, sequence), INSERT attachments
  UPDATE sender's last_read_sequence = sequence          -- writing means having read
COMMIT
```

Consequences:

- **Deterministic under concurrency.** Sends to one conversation serialize on
  its row; each gets the next integer. Fifty simultaneous sends get exactly
  1…50 (tested on Postgres). Different conversations never contend.
- **Gapless.** A rolled-back send rolls its increment back too; deletion is
  soft (§8). So sequences are dense, which makes "is there anything older /
  newer?" arithmetic rather than a query.
- **Integers, not floats or timestamps.** `created_at` is informational — two
  API servers with slightly different clocks cannot reorder a conversation.
- `UNIQUE (conversation_id, sequence)` is the database's own backstop.

The same lock serializes membership changes and the member cap, so "a member
is removed while sending" has exactly two outcomes: the message was stored
before the removal, or it is refused.

---

## 6. Idempotency

Mobile networks drop responses. A client that retries a send must not create
a second message.

- The client generates a `clientMessageId` **once**, when the person taps
  send (the app uses a random UUID), and resends it verbatim on every retry.
- `UNIQUE (conversation_id, sender_id, client_message_id)` — per sender, per
  conversation. Two people may use the same key; one person may reuse a key in
  another conversation.
- A retry with the same content returns the **original** message — same id,
  same sequence — with HTTP **200** instead of 201, and raises no second event.
- The same key with **different** content is `409
  messaging.client_message_id_reused`: a client bug or a probe, never a silent
  overwrite and never someone else's message.
- The check runs under the conversation lock; the unique constraint remains
  the last word. Twelve simultaneous retries store one row (tested).

The Flutter client keeps the key for the life of a pending message, so
"retry" after a failure is the same message. A media send that failed *after*
its upload reuses the completed upload instead of uploading again.

---

## 7. Read state

A **watermark**, per participant: `last_read_sequence`.

Invariant, per participant:

```
0 ≤ hidden_through_sequence ≤ last_read_sequence ≤ conversation.last_sequence
```

- `hidden_through_sequence` — messages at or below it predate the member and
  are never shown to them (group history, Q21).
- `last_read_sequence` — everything at or below it counts as read. It **only
  moves forward** and **never past the last message**: one `UPDATE … SET
  last_read_sequence = least($seq, last_sequence) WHERE last_read_sequence <
  that`. A stale device cannot un-read; a client cannot pre-read the future.
  Concurrent calls end at the highest request (tested).
- Joining sets `last_read_sequence` to the current last sequence: joining a
  channel with 500 notices does not greet anyone with "500 unread".
- Sending advances the sender's own watermark to their message.

The lower half of the invariant is a CHECK constraint; the upper bound is
enforced by the one statement that moves the watermark.

**Unread count** = visible messages above the watermark, from others, not
deleted — **counted only up to 100** (`LIMIT` inside the count). Clients show
"99+" from there. A 100,000-message backlog costs what a 100-message one does.

**Deletions:** a deleted message is not unread (the count skips
`deleted_at`), keeps its sequence, and is shown as a tombstone, so neither
ordering nor watermarks shift when deletion arrives.

Membership is **current** membership: someone who left reads nothing, and
rejoining starts a new visibility window.

---

## 8. Pagination

Keyset only. **No `OFFSET` anywhere.**

**Messages** — the cursor is a message's `sequence`:

| Request | Returns |
| --- | --- |
| no cursor | the latest page |
| `?before=S` | the page just older than S (scrolling back) |
| `?after=S` | the page just newer than S (catching up) |

Items are ascending within a page; the response says `hasOlder` / `hasNewer`.
Every query is a range scan of the `(conversation_id, sequence)` unique
index — `EXPLAIN` shows `Index Scan Backward using
messages_conversation_sequence_unique`, asserted in the Postgres suite over
12,000 rows. Page 1000 costs what page 1 does. Sequences never change, so a
cursor stays valid forever.

**Conversations** — most recently active first, keyset on
`(coalesce(last_message_at, created_at), id)`, the cursor opaque (base64url).
Activity changes as messages arrive, so a conversation can move between
pages while someone pages; clients refresh from the top. The query starts
from the member's own rows (partial index on current memberships) and probes
each conversation's timeline three times via `LATERAL`: counterpart, newest
visible message, capped unread count.

**Members** — keyset on `user_id` over the primary key; fan-out walks a
10,000-member channel in bounded pages.

---

## 9. Authorization and membership

Every use case checks **four** things, in this order:

1. **an authenticated principal** — the HTTP guard, and every use case takes
   the principal explicitly;
2. **the permission for the act**, asked of identity with the conversation
   named;
3. **current membership** of that conversation;
4. **the conversation's own rules** — role (channel posting, member
   management), visibility window, DM immutability.

| Act | Permission | Plus |
| --- | --- | --- |
| list own conversations | `messaging.read` | the query starts from the caller's memberships |
| open, page, mark read | `messaging.read` | current member; visibility window |
| list participants | `messaging.read` | member; in a channel, owner/publishers only (Q22) |
| send | `messaging.send` | member; channel role; own verified attachment |
| attachment link | `messaging.read` **and** `files.read` | member; message visible to them; file really on it |
| start a DM | `messaging.start_direct` (+ `read`) | counterpart ACTIVE with `messaging.read` |
| create a group / channel | `messaging.create_group` / `create_channel` (+ `read`) | members eligible; publishers hold `messaging.send` |
| add people | `messaging.read` + the type's create permission | conversation OWNER; not a DM |
| remove someone | — | OWNER (member), or `messaging.manage` (moderation, audited as such); never the owner; never in a DM |
| leave | `messaging.read` | not a DM; not the owner |

**Permission never substitutes for membership.** There is no "may read every
conversation" path. The security suite runs the most privileged principal the
system has — an OWNER holding every permission including `messaging.manage` —
against a conversation they are not in: listing, opening, paging, marking read,
listing members, sending, adding themselves and fetching an attachment link all
fail, and each failure is **indistinguishable from a conversation that does not
exist** (404 `messaging.conversation_not_found`), so membership cannot be probed.

`messaging.manage` **removes; it never grants access.** A moderator can take
someone out of a group without being in it, and cannot add anyone — least of
all themselves.

Eligibility (who may be put in a conversation) is identity's decision, via
the `AccountDirectory` contract: an ACTIVE account whose roles grant the
permission, decided by the same authorization service that decides for a
signed-in user. An unknown id and an ineligible one are reported alike.

The role policy is **provisional** (Q1, Q6): teachers and supervisors may
start conversations; students and assistants reply in conversations staff
place them in but start none; owners and admins may create channels.

---

## 10. Attachments

```
Message → MessageAttachment → FileAsset (files module) → StorageProvider
```

The message row holds a reference; the files module holds metadata; the
bytes are in storage. Nothing binary touches Postgres. Upload, verification,
limits and signed URLs are the files module's — see [storage.md](storage.md).

Messaging decides **who may read** an attachment (only files can mint a
link; only messaging knows what the file is attached to). Files mints a link
valid for five minutes, and a document is always served as a download, never
rendered.

**Voice** is a `VOICE` file — AAC in MP4 (iOS, Android, Safari) or Opus in
WebM/Ogg (Chrome, Firefox) — with its duration, byte size and content type.
It is asynchronous audio, not a call: nothing about LiveKit is involved, and
an architecture test asserts messaging cannot reach it.

**Images** carry client-reported width and height (bounded). Thumbnails are
the next step and fit the model without change: a derived `FileAsset`
(variant `thumbnail`) produced by a processing job subscribed to uploads.

---

## 11. Events

Ids and codes only — no text, no file names, no display names:

| Event | Payload |
| --- | --- |
| `messaging.conversation.created` | conversationId, conversationType, createdBy, participantCount |
| `messaging.participant.added` | conversationId, userId, role, addedBy |
| `messaging.participant.removed` | conversationId, userId, removedBy, reason (`left` / `removed` / `moderated`) |
| `messaging.message.sent` | conversationId, conversationType, messageId, sequence, senderId, messageType |
| `messaging.message.read` | conversationId, userId, lastReadSequence |

`aggregateId` is always the conversation id, so per-conversation order
survives a future partitioned transport. Initial members are implied by
`conversation.created` — a 5,000-member channel does not emit 5,000 events.
A read event is raised only when the watermark actually moved.

---

## 12. Audit

Conversation creation, every participant added, removed or leaving, and
moderation removals (`messaging.moderation.participant_removed`) are
audited — actor, conversation, target, role. **Ordinary messages are not:**
the conversation is their record, and auditing each would copy private
content into a second store.

---

## 13. Notifications

```
messaging ──messaging.message.sent──▶ event bus ──▶ notifications
                                                      │  MessageSentNotifier
                                                      │    pages MESSAGE_RECIPIENTS
                                                      │    (current members − sender)
                                                      ▼
                                                  NotificationDispatcher
                                                      ▼
                                                  NotificationDelivery ── logging placeholder
```

Messaging imports no notification or push code (asserted). The translator in
notifications is the only code there that knows messaging exists; the
dispatcher and delivery port know templates and recipients, never why. The
fan-out is detached from the send — a message returns when stored, not when
10,000 people have been notified — and walks recipients 1,000 at a time.
**No push provider exists yet** (FCM/APNs not chosen, Q24): delivery logs a
template and a recipient count.

---

## 14. Realtime — the extension point

Not built (Q7). Persistence is separate from delivery by construction:

- a message is **stored** by the send use case, and
- its existence is **announced** by `messaging.message.sent`.

A realtime transport (WebSocket gateway, SSE, a separate push service) is a
subscriber to that event plus `MESSAGE_RECIPIENTS` for who to tell, living
behind an adapter; the use cases do not change. Until then the Flutter client
catches up with `?after=<newest sequence>` on refresh and after each send,
filling any gap that others' messages left below its own.

---

## 15. Search — the extension point

`MessageSearch` is an interface in `messaging/contracts`, and nothing
implements it. The contract fixes the rule before any engine exists: an
implementation returns only messages the searcher could open through the
timeline right now — current memberships, within their visibility window,
never deleted content — because search is where "may read" most easily
becomes "may read everything". Postgres full-text over `messages.body` fits V1
volumes; a dedicated engine later sits behind the same interface, fed from
`messaging.message.sent`.

---

## 16. Moderation, editing and deletion — ready, not built

- **Deletion** — `deleted_at` exists; readers already see a tombstone
  (`asSeen`), unread counts already skip deleted rows, and the text CHECK
  already permits a wiped body. Whether deletion wipes the text or keeps it
  for review is Q23.
- **Editing** — `edited_at` exists; the sequence never changes on edit.
- **Moderation** — removal by `messaging.manage` exists and is audited. Reading
  a conversation one is not in — even for safeguarding — is deliberately not
  possible (Q23).
- **Pins, mute, member roles** — additive: a pins table keyed by (conversation,
  message); a `muted_until` on participants; new role codes.

---

## 17. Performance

Every read is a bounded number of indexed queries, whatever the size of the
conversation or the length of its history; rendering batches its
cross-module lookups (one directory call for all names on a page, one files
call for all attachments). No N+1 anywhere. What the Postgres suite asserts:
keyset paging over 2,000 messages returns each exactly once, the timeline
query uses the index with 10,000 rows of other conversations around it, the
unread count stops at the cap, and fan-out pages a 250-member channel.

**Not done:** load testing at 2,500 concurrent users (explicitly out of scope
for V1); a hot channel with many publishers is bounded by its row lock (a few
milliseconds per send), which is adequate for broadcast channels with a
handful of publishers.

---

## 18. API

```
GET    /messaging/conversations                     ?cursor&limit
POST   /messaging/conversations/direct              { userId }            201 new | 200 existing
POST   /messaging/conversations/groups              { title, memberIds }
POST   /messaging/conversations/channels            { title, memberIds, publisherIds }
GET    /messaging/conversations/:id
GET    /messaging/conversations/:id/messages        ?before|after&limit
POST   /messaging/conversations/:id/messages/text   { clientMessageId, body, replyToMessageId? }
POST   /messaging/conversations/:id/messages/voice  { clientMessageId, fileAssetId }
POST   /messaging/conversations/:id/messages/image  { clientMessageId, fileAssetId, caption? }
POST   /messaging/conversations/:id/messages/file   { clientMessageId, fileAssetId, caption? }
GET    /messaging/conversations/:id/messages/:messageId/attachments/:fileAssetId/link
POST   /messaging/conversations/:id/read            { sequence }
GET    /messaging/conversations/:id/participants    ?cursor&limit
POST   /messaging/conversations/:id/participants    { userIds, role? }
DELETE /messaging/conversations/:id/participants/:userId
POST   /messaging/conversations/:id/leave
```

Errors are the API's single shape (`error.kind`, `error.code`); the codes are
stable (`messaging.conversation_not_found`, `messaging.posting_not_allowed`,
`messaging.client_message_id_reused`, …). Internals never reach a response —
the API suite asserts the full transcript.

---

## 19. The Flutter client

- `MessagingRepository` is an abstract contract; screens never touch HTTP.
  `HttpMessagingRepository` speaks this API; `MockMessagingRepository` keeps
  the same rules in memory for the demo build and widget tests.
- The app talks to a backend only when built with
  `--dart-define=API_BASE_URL=…`; without it the GitHub Pages demo runs on
  mocks and says so on screen.
- State: Riverpod controllers — the list (cursor pages), and one per open
  conversation (older pages, catch-up, optimistic sends with retry under the
  same key, read marking that clears the list badge).
- Screens: the conversation list (previews, unread badges, 99+), the
  conversation (bubbles, sender names in groups, a "new messages" divider,
  older pages on scroll, a read-only notice in channels), a composer, and
  sign-in. Reached from the profile ("الرسائل").

### Client dependencies

Only `package:http` (dart.dev, BSD-3, all six platforms) was added. Device
capabilities sit behind seams with "unavailable" defaults, and the composer
shows their buttons disabled with an explanatory tooltip:

| Seam | Evaluated package | Status |
| --- | --- | --- |
| `AttachmentPicker` | `file_picker` 13.1 (MIT, all platforms) | not added |
| `VoiceRecorder` | `record` 7.1 (BSD-3, all platforms; web records Opus/WebM) | not added |
| `VoicePlayer` | `just_audio` 0.10 (Apache-2.0/MIT; Android, iOS, macOS, web) | not added |
| `TokenStore` | `flutter_secure_storage` 11.2 (BSD-3, all platforms) | not added — tokens live in memory |

They were not added because their native builds (Android SDK, Xcode, a
browser for web recording) cannot be verified in this environment, and a
dependency is not added blind. Binding each is one class implementing the
seam and one provider line.

---

## 20. Deferred — documented future work

Not built in V1, by the brief: reactions, threads (replies store a
reference; no thread view), editing, deletion, search UI, advanced
moderation, disappearing messages, end-to-end encryption, realtime delivery,
push notifications, a people picker for starting conversations (V1 starts
them through the API), video messages, image thumbnails, conversation
archiving, ownership transfer, promoting members to publishers.

End-to-end encryption in particular would change the model (the server could
no longer search, moderate or render previews); it is a product decision,
not an increment.
