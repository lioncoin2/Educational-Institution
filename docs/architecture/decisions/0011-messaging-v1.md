# 0011 — Messaging V1: server-ordered, idempotent, membership-first

**Status:** Accepted
**Date:** 2026-09-23

Builds on [0007](0007-messaging-architecture.md) (one conversation model;
references, not payloads) and refines two of its details; refines the public
surface of [0004](0004-storage-provider-abstraction.md). Neither is
superseded: their decisions stand.

## Context

Messaging V1 turns the Foundation's messaging boundary into a real subsystem:
persistent, permission-aware, correct under concurrency, and connected to the
Flutter app. The brief fixed the properties — server-decided ordering,
idempotent sends, a database-enforced single DM per pair, a read watermark,
keyset pagination, membership checked by every use case, attachments as file
references, privacy-safe events, no push provider and no realtime transport —
and left the mechanisms open. These are the mechanisms, chosen because each
is expensive to change once data exists.

## Decision

1. **Ordering is a per-conversation integer sequence, assigned under the
   conversation's row lock.** `conversations.last_sequence` is incremented in
   the same transaction that inserts the message
   (`SELECT … FOR UPDATE`, then `+1`), with `UNIQUE (conversation_id, sequence)`
   as the backstop. Timestamps are informational only. The read watermark
   (0007's `lastReadMessageId`) becomes `last_read_sequence`: a comparison of
   integers, and pagination cursors that never change.

2. **Idempotency is a client key, unique per sender per conversation, checked
   under the same lock.** `UNIQUE (conversation_id, sender_id,
   client_message_id)`. A retry with the same content returns the original
   (HTTP 200, no second event); the same key with different content is a 409.

3. **One direct conversation per pair, arbitrated by the database.** The pair
   is stored ordered in two columns under a unique constraint; creation is
   `INSERT … ON CONFLICT DO NOTHING` then a read. No find-then-insert.

4. **Membership is checked by every use case, after the permission and
   before anything else.** A non-member is told "not found", exactly as for a
   conversation that does not exist. No permission — including
   `messaging.manage` — reads a conversation one is not in; moderation
   removes, it never grants access. Starting a conversation is its own
   permission (`start_direct`, `create_group`, `create_channel`), separate
   from taking part.

5. **The same row lock serializes membership changes and caps.** Add, remove
   and send to one conversation cannot interleave; the member count is kept
   in the transactions that change membership, so caps hold under racing
   requests without counting rows.

6. **Deletion will be soft; readers already see tombstones.** 0007 proposed a
   `system` message as the deletion notice; instead `deleted_at` keeps the row,
   its sequence and every watermark intact, and every read path renders it as a
   tombstone. The `system` message kind is dropped from the vocabulary.

7. **Files exposes an asset-level contract, not the storage port.**
   `FILE_ASSETS` (`describe`, `verifyAttachable`, `createDownloadLink`) is
   files' public face; `StorageProvider` is internal. The module that attaches
   a file authorizes readers, then asks files for a short-lived link. Uploads
   are declared against an allow-list, transferred directly to storage by
   signed URL, and verified (size and magic bytes) before they can be attached.
   Signatures are purpose-bound, under their own secret.

8. **Events carry ids only, and notifications translate them.** Messaging
   publishes `messaging.*` facts and imports nothing of notifications; a
   translator in notifications pages current members through a messaging
   contract and hands id-only requests to a provider-agnostic dispatcher.

## Consequences

- Sends to one conversation are serialized. A send holds the row lock for a
  few milliseconds, which is ample for chats and for broadcast channels with
  few publishers; a channel with many simultaneous publishers would contend.
  Different conversations never contend.
- Sequences are dense, so "is there anything older or newer?" is arithmetic,
  and the Flutter client fills gaps by paging `after` a known sequence.
- Retries are safe end to end: the client keeps one key per message for life,
  and reuses a completed upload when a send fails after it.
- Nobody — not the institution owner — can read a conversation they are not
  in. Safeguarding review, if the institution wants it, will be a new, audited
  capability (open question Q23), not a widening of `messaging.read`.
- The storage port being private means a module that wants file links must go
  through an asset — no module can mint a link to an arbitrary key.
- Delivery (push, realtime) is additive: a subscriber and an adapter.

## Alternatives considered

- **Order by timestamp (server clock) with an id tie-break.** Rejected: two API
  instances with skewed clocks reorder a conversation, and cursors on
  timestamps skip or repeat rows at equal values.
- **A Postgres `SEQUENCE` or identity column per table.** Rejected: global, so
  per-conversation positions would have gaps, and "is there anything older"
  becomes a query. A sequence per conversation is not practical.
- **Optimistic concurrency (insert `max(sequence)+1`, retry on unique
  violation).** Rejected: under contention it retries in a loop exactly when
  the conversation is busiest; the row lock queues instead.
- **Idempotency keyed by the key alone, or per conversation.** Rejected: two
  people's clients could collide, and a retry could return someone else's
  message.
- **A `direct_key` text column (`"a:b"`).** Rejected for two ordered columns:
  no separator to escape, and the pair stays queryable.
- **Membership-agnostic `messaging.read` for supervisors or the owner.**
  Rejected by the brief ("user has messaging.read → user can read all
  messages" must not exist) and by safeguarding sense.
- **Keeping `StorageProvider` public and letting modules sign their own
  links.** Rejected: any holder could mint a link to any object; the asset
  contract confines each module to files it can name and has authorized.
- **Snapshotting file metadata into `message_attachments`.** Rejected for V1:
  one source of truth; rendering already batches one `describe` call per page.
- **Messaging calling the notification sender directly.** Rejected: it would
  couple messaging to notification policy (who is told, when, how often);
  the brief asked for `MessageSent → EventBus → Notifications`.
