# 0054 — Chat typing indicator

**Status:** Accepted
**Date:** 2026-11-06

## Context

Continuing the Telegram-like chat (after reactions, ADR 0053), the owner asked
for a live "typing…" hint. Unlike a message, a reaction or a pin, a typing hint
is **ephemeral**: it is true for a second or two, must never be stored, must
never be caught up over HTTP, and carries no history. The realtime module
already tracks who is connected (`online-audience.ts`) and fans server frames to
a conversation's members; it just had no *client→server* frame beyond
auth/subscribe/ping.

## Decision

A typing hint is a **new client frame** `{type:'typing',conversationId}`, added
to `realtime/domain/protocol.ts` (version-guarded like every frame), handled
entirely inside the realtime session — **no domain event, no use-case, no table,
no HTTP route**. It never touches the messaging module's write path.

- **Authorization:** the session re-checks the sender's own membership through
  the existing `MESSAGE_RECIPIENTS` port
  (`list(conversationId, {readersOnly, onlyUserIds:[self], limit:1})`) before
  fanning anything. A non-member's hint is dropped — the same contract that
  authorizes a read, reused, so typing cannot leak a conversation's existence.
- **Fan-out:** `typingFrame({conversationId,userId})` is sent to the
  conversation's *other* connected members via `onlineAudience(...)` with the
  typist excluded. It is fire-and-forget: no `eventId`, no `occurredAt`, nothing
  to de-duplicate or replay.
- **Client:** `RealtimeClient.sendTyping` (no-op while offline, no-op in the
  demo build). The composer calls `notifyTyping()` as the viewer types; the
  controller **throttles** outgoing hints to one per 3s. An incoming
  `TypingEvent` adds the member to an ephemeral `ConversationState.typing` set,
  each entry armed with a **5s lapse timer** that removes it if no further hint
  arrives. The viewer's own id is never added. The strip
  (`widgets/typing_indicator.dart`) names one or two typists, or "several",
  and shows nothing when the set is empty.

## Alternatives rejected

- **A domain event + relay** (as message/reaction use): rejected — a typing hint
  is not a fact of the conversation, has no persistence and no audit, so routing
  it through the event bus and the write side would be wrong weight and would
  dirty the messaging module with an ephemeral concern.
- **An HTTP endpoint:** rejected — typing only makes sense live; with no live
  connection there is nothing to show, and `sendTyping` is simply a no-op.
- **Server-side expiry/debounce:** rejected — the server fans each hint as it
  arrives; the client throttles the send (3s) and expires the display (5s),
  keeping the server stateless for this feature.

## Consequences

- One new client frame and one ephemeral server frame; zero schema change, zero
  new permission, zero new domain event, no change to any message flow. The
  messaging module is untouched. Verified: backend typecheck, lint, dependency
  rules, the realtime suite (incl. a new test that a hint reaches the other
  member and never the typist), and the Flutter suite (frame parse, the
  controller's add/ignore/throttle, and the indicator widget). The realtime
  harness constructor gained the `MESSAGE_RECIPIENTS` argument.
