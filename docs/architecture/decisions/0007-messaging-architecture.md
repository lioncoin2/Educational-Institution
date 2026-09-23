# 0007 — One conversation model; references, not payloads

**Status:** Accepted
**Date:** 2026-09-23

## Context

Messaging must eventually support text, voice, images and files; replies; read
state; notifications; search; direct messages, groups and channels; mentions and
pins. And it must be possible to add reactions, editing, deletion, moderation,
attachments and threads *cleanly* afterwards.

The brief was equally clear that none of it should be built now:

> Do NOT implement the complete chat UI.

So this ADR is about a boundary, not an implementation.

## Decision

Contracts only, shaped by three decisions.

**1. One conversation abstraction, three types.**
A direct message is a conversation with two participants; a group has many; a
channel has a broadcast participation rule. Differences are participation and
permission rules over one model.

**2. Attachments are references, never payloads.**
`MessageAttachmentRef { fileAssetId }`. A message row never holds bytes, a path,
or a URL.

**3. Read state is a per-participant watermark.**
`ReadReceipt { conversationId, userId, lastReadMessageId }`.

## Consequences

**Good.**

The deferred features are additive — a table plus a use case, with no change to
what exists:

| Feature | Needs | Already present |
| --- | --- | --- |
| Threads | a parent pointer | `inReplyToMessageId` |
| Reactions | a table keyed by message | stable message ids |
| Editing | a revision table | stable message ids |
| Deletion | a tombstone state | `MessageKind.system` |
| Moderation | a permission + audit | `messaging.*` permissions, `AuditLog` |
| Pins | a table keyed by (conv, msg) | both ids |
| Search | an index over text | text is first-class |

One model means every feature is built once rather than three times — "add
reactions" is one change, not three with three sets of bugs.

References keep message rows small (so history paginates cheaply), put media
lifecycle in one module, and make a voice message and a homework submission use
the same storage path and validation.

A watermark makes an unread count a comparison against a monotonic position.
The alternative — a set of read message ids — grows without bound and makes
unread counts expensive, which matters most in a channel with 2500 members.

**Bad, and accepted.**
- One model means type-specific behaviour is expressed as rules rather than as
  separate code, which is slightly more indirection for the direct-message case.
- A watermark cannot express "read message 5 but not 4". Nothing in the
  requirements needs that.
- References mean fetching a message and its attachment is two lookups.

## Deliberately not decided

**How new messages reach connected clients.** WebSocket gateway in-process, the
LiveKit data channel, or a dedicated push channel. The load profile decides it
and is unknown; option 2 would couple messaging to the RTC provider, which
contradicts the separation the rest of the design maintains. Open question Q7.

What *is* decided: the choice must not leak past `messaging/infrastructure/`.
Use cases raise `messaging.message.sent` and are indifferent to delivery.

**Who may message whom.** A safeguarding decision before a technical one. Open
question Q6. It will be an authorization question with the conversation as
context, using the mechanism from ADR 0005 — no contract change.

## Two implementation notes, fixed now because they are expensive later

**Pagination is keyset, never `OFFSET`.** Deep offsets in a large conversation
scan everything before them, and concurrent inserts shift the window under the
reader. This is the one place in the system where offset pagination reliably
degrades.

**Voice messages are `files` assets with a duration**, not a separate subsystem.
If voice ever needs streaming rather than whole-file download, that is a
`StorageProvider` concern.

## Alternatives considered

**Separate entities for DM, group and channel.** Rejected: every feature built
three times, forever.

**Store attachments inline.** Rejected: bloats message rows, duplicates media
lifecycle per feature, and contradicts ADR 0004.

**Build it now.** Rejected: explicitly out of scope, and the contracts are the
part that is expensive to get wrong.
