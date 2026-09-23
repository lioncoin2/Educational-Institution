# Messaging

**State: boundary only.** Contracts exist. No implementation, by instruction:

> Do NOT implement the complete chat UI.

This document exists so that when messaging is built, the shape is already
decided — and so that the features listed as "later" are genuinely additive
rather than a rewrite.

---

## 1. Scope

**Eventually:** text, voice messages, images, files; replies; read state;
notifications; search; direct conversations, groups and channels; mentions;
pins.

**Designed for but not implemented:** reactions, editing, deletion, moderation,
threads.

The brief asked for contracts shaped so those can be added cleanly. That
requirement, not the feature list, is what the design below is optimizing for.

---

## 2. The contracts, and the three decisions inside them

```ts
export type ConversationType = 'direct' | 'group' | 'channel';
export type MessageKind = 'text' | 'voice' | 'image' | 'file' | 'system';

export interface MessageRef {
  readonly messageId: string;
  readonly conversationId: string;
  readonly senderUserId: string;
  readonly kind: MessageKind;
  readonly inReplyToMessageId: string | null;   // ← threading, pre-wired
}

export interface MessageAttachmentRef {
  readonly fileAssetId: string;                 // ← a reference, never bytes
}

export interface ReadReceipt {
  readonly conversationId: string;
  readonly userId: string;
  readonly lastReadMessageId: string | null;    // ← a watermark, not a set
}
```

### Decision 1 — one conversation abstraction, three types

A direct message is a conversation with two participants. A group is a
conversation with many. A channel is a conversation with a broadcast
participation rule.

The alternative — three separate entities — means every feature gets built three
times, and "add reactions" becomes three changes with three sets of bugs.
Differences between the types are expressed as participation and permission
rules over one model, not as three models.

### Decision 2 — attachments are references, never payloads

A message row holds a `fileAssetId`. It never holds bytes, a path, or a URL.

Three things follow, all of which are expensive to retrofit:

- Message rows stay small, so conversation history paginates cheaply.
- Media lifecycle — retention, deletion, virus scanning, re-encoding — belongs
  to one module (`files`) instead of being duplicated per feature.
- A voice message and a homework submission use the same storage path and the
  same validation rules.

See [storage.md](storage.md).

### Decision 3 — read state is a per-participant watermark

`lastReadMessageId`, one row per (conversation, user).

The obvious alternative, a set of read message ids, grows without bound and
makes an unread count an expensive query. A watermark makes "unread" a
comparison against a monotonic position, which is what keeps unread badges
cheap in a channel with 2500 members.

---

## 3. Why the "later" features need no reshaping

| Feature | What it needs | Already present |
| --- | --- | --- |
| Threads | a parent pointer | `inReplyToMessageId` |
| Reactions | a table keyed by `messageId` | stable message ids |
| Editing | a revision keyed by `messageId` | stable message ids |
| Deletion | a tombstone state | `MessageKind.system` for the notice |
| Moderation | a permission + an audit entry | `messaging.*` permissions, `AuditLog` |
| Pins | a table keyed by (conversation, message) | both ids |
| Mentions | parsed spans referencing `userId` | stable user ids |
| Search | an index over message text | text is a first-class field |

Every one of them is an additive table plus a use case. None require changing
what already exists. That is the test the contract was written to pass.

---

## 4. Boundaries

**Messaging must not know** how a notification is delivered. It raises
`messaging.message.sent`; `notifications` decides channel, batching and quiet
hours.

**Messaging must not know** how a file is stored. It holds a `fileAssetId`.

**Messaging must not decide** who may message whom — that is an authorization
question, asked through `identity/contracts` with the conversation as context.
(Whether a student may DM a teacher is an *institutional* rule, and is
[open question Q6](open-questions.md).)

---

## 5. Sketch of the intended implementation

Not built. Recorded so the next person does not re-derive it.

```
messaging/
  domain/
    conversation.ts     Conversation, Participant, participation rules
    message.ts          Message, MessageKind, invariants
    read-state.ts       watermark logic
    ports.ts            ConversationRepository, MessageRepository, ReadStateRepository
  application/
    send-message.use-case.ts        authorize → validate → persist → raise event
    mark-read.use-case.ts
    list-conversation.use-case.ts   keyset pagination, never OFFSET
  infrastructure/
    drizzle-*-repository.ts
  api/
    messaging.controller.ts
```

Two implementation notes worth fixing now, because both are expensive to change
later:

**Pagination is keyset, never `OFFSET`.** Message history is the one place in
this system where offset pagination reliably degrades — deep offsets in a large
conversation scan everything before them, and concurrent inserts shift the
window under the reader.

**Voice messages are `files` assets with a duration.** Not a separate
subsystem. If voice ever needs streaming rather than whole-file download, that
is a `StorageProvider` concern, not a messaging one.

---

## 6. Realtime delivery is not decided

Messaging needs to push new messages to connected clients. Three options:

1. **WebSocket gateway in this process** — simplest; ties message delivery to
   API process lifetime and scaling.
2. **Reuse the LiveKit data channel** — no new infrastructure, but couples
   messaging to the RTC provider, which contradicts keeping messaging
   independent of `live`.
3. **Dedicated push channel** (SSE, or a separate WS service) — most work,
   cleanest separation.

No decision has been made, because the load profile is not known: a channel with
2500 members behaves very differently from direct messages between two people,
and picking now would be guessing. This is [open question Q7](open-questions.md).

What *is* decided: the choice must not leak past `messaging/infrastructure/`.
Use cases raise `messaging.message.sent` and are indifferent to how it reaches a
phone.
