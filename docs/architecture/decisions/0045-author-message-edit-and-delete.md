# 0045 — Authors edit and delete their own messages; moderators delete, never edit

**Status:** Accepted — 2026-10-25 (owner decision D, register §30). **Extends**
[ADR 0029](0029-community-message-moderation.md) (moderators delete in a community chat — unchanged) and
**supersedes in part** [messaging.md §16](../messaging.md#16-moderation-editing-and-deletion)'s
"editing: not built" and "deletion in DIRECT and GROUP conversations is still not exposed".

## Decision

- **Who.** The **author** edits and deletes their **own** message in a direct conversation, a group, a
  channel or a community chat. A community chat's moderator (`community.messages.moderate`, ADR 0029)
  deletes anyone's message there. **Nobody edits anyone else's message** — moderators included (no
  unrestricted moderator editing was approved). Anyone else's message is answered as not found
  (`404 messaging.message_not_found`) so the route is no probe; outside a community chat there is no
  moderator, so another member's delete is the not-found answer too.
- **Gates (server-side, asked on every call).** Edit: identity `messaging.send`, a *current* membership
  (a community chat admits through Communities, never a projected row), the posting rule *now*
  (`community.chat.post` / a channel's publishers) — whoever may no longer post may no longer edit — and
  the send rate limit. Delete-own: `messaging.read` and current membership; a removed author can neither
  edit nor delete there.
- **What changes.** An edit replaces the text only: a TEXT message's body (still required, ≤ 4,000
  characters, normalized as a send is) or a media message's caption (may be changed or cleared).
  Attachments, type, sequence, order and reply link never change. `editedAt` is stamped by the server; the
  same text changes nothing (no stamp, no audit, no event). No revision history is kept: the previous text
  is replaced (the audit records that an edit happened — message id, sequence, time, actor — never text).
- **Delete.** The same soft delete ADR 0029 defined: a tombstone in every read path, the body kept for the
  7-day review and then wiped by retention; idempotent. An author's delete is audited as
  `messaging.message.deleted_by_author` (not moderation).
- **Concurrency.** The edit is one conditional `UPDATE … WHERE sender = author AND deleted_at IS NULL`:
  a deleted message stays deleted (`409 messaging.message_deleted`), a delete always wins a race, two edits
  are last-write-wins.
- **Consistency across clients.** `messaging.message.edited` (ids + sequence only) → realtime
  `message.edited`, rendered per member by messaging's views like `message.sent` (author's devices get
  their `clientMessageId`), to current members who can see the sequence; nothing once the message is
  deleted. Deletes reuse `message.deleted`. The app replaces the held copy (newer `editedAt` wins), shows
  «معدّلة», updates the conversation-list preview, and offers edit/delete only on the viewer's own messages.
- **Notifications** read the message when shown (ADR 0046): an edited message previews its new text; a
  deleted one previews nothing. No new notification is sent for an edit.

Routes: `PATCH /messaging/conversations/:id/messages/:messageId` `{ body }` (200);
`DELETE …/messages/:messageId` now serves both the author and a moderator (204). No migration
(`messages.edited_at` already existed).

## Consequences

Tests: `edit-message.spec.ts` (every conversation kind, non-author, moderator cannot edit, removed author,
cross-conversation, unchanged, caption, bounds, concurrency), `messaging.api.spec.ts`,
`messaging-relay.spec.ts` (`message.edited` audience), `messaging-edit-delete-postgres.spec.ts` (conditional
update, delete-wins race, serialized edits), Flutter `message_edit_delete_test.dart`.
Open: an edit time window, and keeping revision history for moderation review — neither approved.
