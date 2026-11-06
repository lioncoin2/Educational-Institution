# 0055 — Chat message forwarding

**Status:** Accepted
**Date:** 2026-11-06

## Context

Continuing the Telegram-like chat (reactions 0053, typing 0054), the owner asked
for forwarding a message into another conversation. A forward is a new message
in a target conversation that carries the source's content and names its
original author — across direct, group and community chats.

## Decision

A forward **reuses the send path** and adds one new piece of state: the original
author. It does **not** copy bytes or re-register files.

- **Two authorizations, in order** (`application/forward-message.use-case.ts`):
  the forwarder must be a member of the SOURCE conversation (`messaging.read`)
  who can SEE that live message (visibility window; a tombstone is refused);
  then the ordinary `MessageSender.send` authorizes the POST into the TARGET
  (membership, channel/community posting rule, rate limit, idempotency) and
  raises the normal `messaging.message.sent` event. A non-member of the source,
  or an unseen/deleted message, is refused exactly like a missing one — forward
  never becomes a way to learn a message exists.
- **Origin snapshot:** a new nullable `forwarded_from_sender_id` column on
  `messages` (migration 0037) holds the ORIGINAL author's account id. Forwarding
  a forward keeps the FIRST origin (`source.forwardedFromSenderId ?? senderId`),
  so the chain never grows and the label always names the true author. The name
  is NOT stored — it is resolved live from the directory in the view, batched
  with the page's other senders, so a forwarded author appears in `senders` like
  any sender. A tombstone blanks the origin with the body (`asSeen`).
- **Attachments are referenced, not copied:** the forward's `messageAttachments`
  rows point at the SAME file assets. This is safe because a reader of the
  target is authorized for its attachments by **conversation membership**, never
  by owning the file (`GetAttachmentLinkUseCase`); Files' `createDownloadLink`
  does not check ownership. Because the attachments come from an authorized
  read, `MessageSender.send` is told (`attachmentsAlreadyAuthorized`) to skip the
  `verifyAttachable(…, senderId, …)` ownership check — which exists to stop
  forging a fresh upload and would wrongly reject a forward (the forwarder is not
  the uploader). Every fresh send still verifies as before.
- **Route:** `POST /conversations/:conversationId/messages/forward` where the
  param is the TARGET and the body is `{clientMessageId, sourceConversationId,
  sourceMessageId}`; guarded by `messaging.send`, idempotent on the client id.

## Alternatives rejected

- **Copying the file bytes / re-registering under the forwarder:** rejected —
  needless duplication, and a new Files contract method, when a shared reference
  already downloads correctly under the target's own authorization.
- **A dedicated `messaging.message.forwarded` event:** rejected — a forward is a
  new message; the existing `messageSent` delivery carries it (the frame already
  includes `forwardedFromSenderId`), so every path lights up with no new event.
- **Storing the author's name snapshot:** rejected — messaging holds no identity
  display names; resolving live keeps the boundary and matches every other name.
- **A new permission:** none — read of the source and post in the target are the
  exact rights a forward needs, and both already exist.

## Consequences

- One nullable column (migration 0037), one route, one use case, one send
  option, one `MessageView`/wire field; no new event, permission or table, and
  the message row, send, reply, pin, edit and delete flows are otherwise
  untouched. Verified: backend `npm run verify` (typecheck, lint, dependency
  rules, the messaging + realtime suites, a use-case spec over real
  authorization covering text, a forward of a forward, a media forward reusing
  the asset, and both refusals) and the Flutter suite (model parse, the mock's
  copy/origin/idempotency, and the bubble's forwarded header + action). The
  client renders "محوّلة من X" and forwards through a conversation picker.
