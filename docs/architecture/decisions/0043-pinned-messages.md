# 0043 — Pinned messages: one server-authoritative pin per conversation, reconciled by a monotonic version

**Status:** Accepted — 2026-10-20 (owner decision, register §29: Pinned Messages included in the first
web-first Trial release). The behaviour below is **implemented in the working tree** (community-chat message
pinning, migrations 0028/0029); this record, written 2026-10-20, back-documents the implemented design (the
code already cited "ADR 0043" with no decision record), and the owner has now accepted it (register §29).
This ADR **back-documents the design the implementation actually supports** so the decision is not silently
missing ([ENGINEERING_RULES](../../ENGINEERING_RULES.md) ADR discipline; [ADR 0031](0031-architecture-navigation-index.md)
index). It separates **observed implementation facts** (the Decision/Mechanics sections) from **policy that
still needs the owner** (the Policy & open questions section), and claims no owner acceptance. Peer status to
[0040](0040-owner-command-center-reporting-registry.md)/[0041](0041-mass-publish-to-communities.md), which are
likewise implemented yet `Proposed`.

## Context

A community-chat moderator can pin one message so every member sees it highlighted (a banner). The feature is
built across backend (`messaging`), realtime, persistence and Flutter, and its realtime/reconciliation half
evolved to a version-ordered design. Because timestamps give no total order across concurrent/delayed/duplicate
events, local operations and reconnects, a naive "latest wins" banner can converge wrongly. Reactions were
**explicitly rejected** by the owner and are out of scope here. This record states what the code does and what
remains an owner decision; it does **not** change any messaging, moderation, community-permission or realtime
policy.

## Decision (observed implementation — what the code does)

- **One pin per conversation, a reference, not a copy.** The pin is three columns on the `conversations`
  row — `pinned_message_id`, `pinned_at`, `pinned_by` — never a stored copy of the message content
  (migration **0028**, additive; `CHECK conversations_pin_consistent` keeps the three columns null-together).
  A new pin **replaces** the current one (most-recent-wins); there is no multi-pin collection.
- **Authority reuses `community.messages.moderate`; no new permission.** Pinning/unpinning is a community-chat
  moderation act gated through the **same** seam the delete uses (`CommunityChats.mayModerate`): community
  chats only (anything else is the 404 a non-member hears), owner implicitly or a delegated moderator, a plain
  member refused. Routes `POST /messaging/conversations/:id/messages/:messageId/pin` and
  `DELETE /messaging/conversations/:id/pin` (`@Authenticated` at the edge; the use case asks Communities).
- **Only a live message may be pinned.** The repository rejects a cross-conversation id, an unknown id, or a
  **tombstone** as `message_not_found` (no probe). The FK `pinned_message_id → messages.id ON DELETE SET NULL`
  is defensive only: messages are never hard-deleted, so a pinned message that is later **moderated to a
  tombstone keeps its pin**, and the banner then resolves to the tombstone label «رسالة محذوفة» (consistent
  with [ADR 0029](0029-community-message-moderation.md)).
- **Ordering is a server-authoritative monotonic `pinVersion` per conversation** (migration **0029**:
  `pin_version bigint NOT NULL DEFAULT 0`, `CHECK conversations_pin_version_nonnegative`). The version is
  incremented **only on a real change**, under the conversation row lock (`.for('update')`), and read from the
  same committed row as the pin id; an **idempotent no-op** (re-pinning the current pin, unpinning when
  already unpinned) neither bumps the version nor emits an event.
- **Realtime is content-free and version-stamped.** A `messaging.message.pinned` event rides the existing
  in-process bus → `MessagingRealtimeRelay` → the WebSocket frame (type `message.pinned`, eventId
  `message.pinned:${conversationId}:${pinVersion}`), carrying `{ conversationId, pinnedMessageId | null,
  pinVersion }` only — never the body or the actor. Audience is every **online current member**
  (`onlineMembers(conversationId)`), so no content and no membership leak.
- **The client accepts strictly-newer pin state, centrally.** `Conversation` carries `pinnedMessageId` +
  `pinVersion` (default 0, preserved through every copy method). The controller accepts a pin change — event
  **or** conversation refresh — **only** when its `pinVersion` is strictly greater than the held version; a
  stale refresh keeps the newer local/remote pin; a missing/non-integer version is never treated as newest.
  Reconnect re-reads the conversation so a pin missed while away is recovered. The banner preview is resolved
  **client-side from the loaded timeline** (reusing the reply-quote resolver), so no message content is
  duplicated and no per-pin server round-trip is needed; an unresolved pin shows a truthful
  «الرسالة المثبتة غير متاحة».

## Policy & open questions (NOT settled by this record)

- **Owner acceptance of the feature itself** is not on record — hence `Proposed`.
- **Single pin vs. multiple pins.** The implementation chose a single pin (multi-pin judged an unnecessary
  subsystem). This is a product shape, not owner-ratified here.
- **Direct and non-community conversations have no pin** — an explicit, reported gap. Extending pinning to
  them would need a per-conversation capability decision (there is no `messaging`-native pin authority).
- **Reactions remain EXCLUDED** (owner rejection); nothing here reopens that.

## Mechanics (implemented, in source)

- **Backend `messaging`:** `application/pin-message.use-cases.ts` (`PinMessageUseCase`/`UnpinMessageUseCase`,
  audited, idempotent); `domain/conversation.ts` + `contracts/events.ts` + `domain/events.ts` (`MessagePinned`
  with `pinVersion`); `infrastructure/{schema.ts,row-mapping.ts,drizzle-messaging-repository.ts,in-memory-messaging-store.ts,drizzle-messaging-read-model.ts}`;
  `api/conversations.controller.ts` (pin/unpin routes), `api/responses.ts` + `api/dto/messaging.dto.ts`
  (the conversation response carries `pinnedMessageId` + `pinVersion`).
- **Realtime:** `modules/realtime/application/messaging-relay.ts` + `envelopes.ts` (the `message.pinned` frame).
- **Persistence:** migrations `0028_conversation_pinned_message.sql` (columns + FK + consistency CHECK) and
  `0029_conversation_pin_version.sql` (version column + non-negative CHECK); both **additive and
  backward-compatible** (existing rows: null pin, version 0) and **not applied to any shared database** by this
  record.
- **Flutter:** `data/models/messaging.dart` (`pinnedMessageId`/`pinVersion`/`withPin`), `data/realtime/realtime_frames.dart`
  (the frame parser), `features/messaging/state/conversation_controller.dart` (strictly-newer acceptance +
  reconnect refresh), `features/messaging/widgets/message_bubble.dart` + `conversation_screen.dart` (the banner,
  pin/unpin actions gated on `canModerate`).

## How this is verified (in source)

- `modules/messaging/application/pin-message.spec.ts` (authz, idempotency, the authoritative version — zero
  start, +1 per real change, no bump on no-op, two competing pins serialize deterministically).
- `test/integration/messaging-persistence.spec.ts` (pin round-trip, the `conversations_pin_version_nonnegative`
  constraint, version advances only on a real change) — **PostgreSQL, CI-gated; not run in a local no-DB
  session.**
- Flutter `test/messaging/pin_reconciliation_test.dart` (newer-wins / older-no-regress, duplicate idempotent,
  stale-refresh-can't-overwrite, newer-reconnect-wins, per-conversation isolation) and the pinned-message
  sections of `test/messaging/messaging_screens_test.dart` / `messaging_state_test.dart`.

## Consequences

- `pinVersion` is a new field on the conversation read/response, not a new module edge; the architecture index
  regenerates without a new dependency.
- No new permission and no new table: the pin lives on existing `conversations` columns, authorized by an
  existing community capability.
- Until the owner accepts this ADR, pinned messages should be treated like 0040/0041 — implemented but not a
  ratified policy; a production enablement decision stays with the owner.

## Alternatives considered

- **Order the banner by timestamp.** Rejected — concurrent/delayed events and local ops give no total order;
  a monotonic server `pinVersion` does, and the client's strictly-newer rule converges deterministically.
- **Carry the pinned message's content in the event.** Rejected — the event is content-free (id + version);
  the client resolves the preview from its own loaded timeline, so no content or membership leaks over realtime.
- **Multiple simultaneous pins.** Rejected for v1 — a single most-recent pin met the need without a pin
  collection, its ordering, or its own moderation surface.
- **A new `messaging`-native pin permission.** Rejected — pinning is a moderation act, so it reuses
  `community.messages.moderate`; this also means direct chats (no community authority) have no pin yet.
