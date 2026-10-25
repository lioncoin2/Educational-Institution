# 0046 — Notifications say who, where and what to an authorized recipient — resolved when shown, never stored, never on the lock screen

**Status:** Accepted — 2026-10-25 (owner decision E, register §30). **Supersedes in part**
[ADR 0013](0013-notifications-v1.md) (its "what a notification says: never the message's text" rule for the
in-app record) and the PROVISIONAL "no sender, no content" line of
[Q24](../open-questions.md#q24--notifications-push-provider-lock-screen-previews-quiet-hours-mute) **for
in-app notifications only**. ADR 0013 decision 9 (a push says only what kind of thing happened) **stands**.

## Decision

- **In the app** (the inbox and the realtime `notification.created` frame), a notification about a message
  shows its **sender**, its **conversation** (group/channel/community title; a direct conversation is
  named by its sender) and the **start of the message** (140 characters, the conversation list's preview) —
  where the recipient is authorized.
- **Resolved at read time, for that recipient, by messaging** — a new principal-less contract
  `MESSAGE_NOTIFICATION_CONTEXT.forRecipient(userId, refs)`, which answers only for a recipient who may read
  the conversation *now*: a current member (Communities' ACTIVE member holding the chat read ceiling for a
  community chat), an account that may read messages, within their history window. So a member removed
  since, a revoked or suspended account, a message from before someone joined, or an unknown conversation
  shows nothing more than the content-free text the notification was created with; a deleted message shows
  no preview; an edited one shows its new text.
- **Nothing is stored or published.** The notification row keeps ids, codes and the actor's name (it now
  also stores `messageId`, an id); `conversationTitle` and `messagePreview` are added to `params` when the
  view is built (`NotificationContextResolver`) and are never written to the database, an event, the audit
  trail or a log.
- **Push / lock screen:** unchanged — title key + `body_private`, no arguments, no sender, no text
  (`pushMessageFor`). A lock-screen preview would need its own opt-in setting; none was approved, and there
  is no real push provider on the Trial (`LoggingPushProvider`).
- **Preferences, quiet hours and mutes** are unchanged: they decide whether a notification is stored and
  pushed; context only fills what an already-delivered in-app notification says.
- Values are plain text (control and direction-override characters removed), as every param is.

## Consequences

- The content-free tests were replaced by privacy-aware ones: `messaging-notification.translator.spec.ts`
  (authorized preview; stored row, events and push stay content-free; removed member; deactivated / no
  `messaging.read`; deleted vs edited; realtime copy per recipient; plain text) and `notifications.api.spec.ts`
  (preview for a member, nothing for an outsider or after removal).
- Notifications created before this ADR carry no `messageId`: they are titled, never previewed.
- Flutter `NotificationCopy` renders «المرسل في «المجموعة»: النص» when given, and says less — never
  something else — when not.
