# 0056 — Direct-chat read receipts (seen ✓✓)

**Status:** Accepted
**Date:** 2026-11-06

## Context

Completing the Telegram-like chat (reactions 0053, typing 0054, forward 0055),
the owner asked for a "seen" mark and chose **full ✓✓** — the read state is shown
to the other person, resolving the privacy question Q25 left open (the old
`messaging-relay.ts` comment: "whether others may see how far someone has read
is an open question"). Today a `message.read` mark is delivered only to the
reader's own devices.

The scaling catch: a community chat is a `CHANNEL`/`GROUP` with `communityId`
set and can hold tens of thousands of members. Broadcasting every read to every
member there is a one-to-many storm with no value. So receipts must be bounded.

## Decision

Read receipts are **DIRECT conversations only** — two people, so the broadcast
is to the one counterpart, bounded by construction, and ✓✓ means exactly "the
other person read it".

- **Audience (realtime):** the `MessageRead` event payload gains
  `conversationType` (precedent: `MessageSent`), decided in the mark-read use
  case, which already holds the conversation. The relay branches: `DIRECT` →
  fan out to the conversation's online members (reader's own devices + the
  counterpart) via the existing `onlineMembers` + `sendToUsers`; anything else →
  the reader's own devices only, unchanged. The frame is untouched — it already
  carries `userId` + `lastReadSequence` (a watermark, nothing personal).
- **Seed (read path):** the single-conversation view (`GetConversationUseCase`)
  resolves a DIRECT chat's `counterpartReadSequence` with one cheap read of the
  two participants, and attaches it to `ConversationView`. The conversation
  **list** leaves it null — resolving it per row would be a query each. Groups,
  channels and community chats are always null.
- **Client:** `ConversationState.counterpartReadSequence` is seeded from the
  opened conversation and advanced (monotonically) by the counterpart's live
  `MessageReadEvent`s (a second, un-viewer-guarded arm). A message bubble shows
  a tick on the viewer's own confirmed DIRECT messages: ✓ (sent) or ✓✓ (the
  counterpart's watermark has reached it). No tick anywhere else.

## Alternatives rejected

- **Broadcast to all participants in every conversation** (the literal "change
  the audience" reading): rejected — infeasible and meaningless in a 10k-member
  community chat. `communityId !== null` and non-DIRECT are the exclusions.
- **Group "seen by N":** a different affordance (a per-message reader count, an
  N² broadcast, a roster load). Deliberately deferred; DIRECT ✓✓ is the owner's
  decision fully delivered where it is unambiguous. A later ADR can add bounded
  small-group receipts if asked.
- **Widening `ParticipantView` with `lastReadSequence` + loading the roster on
  the client:** more general but needs the controller to hold the roster;
  `counterpartReadSequence` on the detail view is the minimal correct seed for
  the two-person case and needs no roster.
- **A per-user "hide my read receipts" setting:** not requested; the owner chose
  full ✓✓. A toggle can be added later without changing this shape.

## Consequences

- One new event field, one relay branch, one nullable view/response field, one
  client state field and a bubble tick; no new table, route, permission or
  domain event, and the mark-read write path is otherwise unchanged. Read
  receipts never appear in groups, channels or community chats. Verified:
  backend `npm run verify` (the mark-read event now carries the type; a new
  relay test proves a DIRECT read reaches the counterpart while the existing
  group test still proves reader-only) and the Flutter suite (model parse,
  controller seed + monotonic live advance + group-has-none, bubble ✓/✓✓/none).
