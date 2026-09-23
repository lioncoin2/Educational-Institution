# 0013 — Notifications V1: a stored inbox, idempotent by the database, delivered by subscribers

**Status:** Accepted
**Date:** 2026-09-23

Turns Messaging V1's logging-only notification pipeline into a real
subsystem. Builds on [0006](0006-event-architecture.md) (in-process events,
outbox-ready), [0011](0011-messaging-v1.md) (membership-first messaging) and
[0012](0012-realtime-messaging-transport.md) (one authenticated realtime
connection); none of them is superseded. Partly answers open question Q24 —
decision 9 below is recorded as provisional and Q24 stays open. The design in
full is [notifications.md](../notifications.md).

## Context

Until now `messaging.message.sent` reached a `MessageSentNotifier` that looked
up the conversation's members and logged a line per recipient through a
`NOTIFICATION_SENDER` port. Nothing was stored, nothing could be read later,
there were no preferences — and the members it logged included accounts that
were suspended or whose roles no longer let them read.

The brief fixed the properties:

- a notification is a persistent domain object; realtime and push only
  deliver it, and the database is the truth;
- the modules that produce facts (messaging, and later academic, assignments,
  live, identity) contain no notification logic — they publish events;
  notifications subscribes;
- stable localization keys and parameters, never rendered sentences; typed
  targets, never raw URLs; a target never grants access;
- at-least-once delivery is assumed: deduplication by key under a database
  constraint;
- read state per person, an unread count that does not grow with the backlog,
  keyset pagination;
- preferences per channel, where turning push off never turns off the inbox;
- a push-provider abstraction with no provider SDK in business code, and no
  native dependency added that this environment cannot build and verify;
- nobody notified by role, organisation or permission, nor anyone who cannot
  see the source; suspended and disabled accounts get nothing new and keep
  their history;
- no educational events invented to fill notification types.

These are the mechanisms, chosen because each is expensive to change once
rows exist.

## Decision

1. **One row per recipient, holding keys, parameters and a typed target.**
   `notifications (id, recipient_user_id, type, category, title_key, body_key,
   params, target, dedupe_key, created_at, read_at)`. Keys are
   `notification.<type>.title` / `.body`; params are at most ten named plain
   values (text ≤ 200 characters, stripped of control and bidirectional
   formatting characters, no nesting); the target is one of seven kinds, each
   with exactly its identifier field. The client owns the words and maps
   targets to screens. The category is derived from the type by the catalog,
   never taken from the caller. `createNotification` (domain) is the only
   constructor, and copies target and params field by field.

2. **Types are a catalog; only what the application publishes is active.**
   `MESSAGE_RECEIVED`, `CONVERSATION_CREATED` and `ADDED_TO_CONVERSATION` are
   active (category `MESSAGES`). `ASSIGNMENT_CREATED`, `ASSIGNMENT_UPDATED`,
   `ANNOUNCEMENT_CREATED`, `CERTIFICATE_ISSUED` and `HALAQA_UPDATE` are
   reserved vocabulary: the dispatcher refuses them and no preference category
   is offered for them, because no module publishes their facts yet.

3. **A translator per source module; one event-agnostic dispatcher.**
   `MessagingNotificationTranslator` subscribes to messaging's `message.sent`,
   `conversation.created` and `participant.added` and turns each into
   requests; it is the only notifications application code that knows
   messaging exists, and messaging imports nothing of notifications
   (architecture test). `NotificationDispatcher` knows requests, never events:
   valid → account active (identity's `ACCOUNT_DIRECTORY`, one call per page)
   → IN_APP preference → insert → announce. A new source adds a translator and
   a catalog line; the dispatcher does not change. `MessageSentNotifier`,
   `NOTIFICATION_SENDER` and the logging sender are removed.

4. **Recipients are messaging's answer, not a copy of its rules.**
   `MESSAGE_RECIPIENTS` gains `readersOnly` — members whose accounts are active
   and whose roles grant `messaging.read`, which messaging asks of identity —
   and `onlyUserIds`. The translator asks for current members within the
   message's visibility window, readers only, a page of 1,000 at a time, and
   leaves out the sender. Notifications never queries users and never stores
   membership.

5. **Idempotency is the database's.** Every request carries a dedupe key
   naming the source fact and the recipient (`message:<messageId>:user:<userId>`);
   `UNIQUE (recipient_user_id, dedupe_key)`; the insert is
   `INSERT … ON CONFLICT DO NOTHING RETURNING id`, and only rows actually
   inserted go on. There is no check-then-insert anywhere.

6. **`notifications.notification.created` is the idempotency boundary for
   delivery.** One event per stored row, carrying the recipient, the type and
   the realtime/push decisions made from preferences at dispatch — never the
   parameters, which may hold a person's name. Its `aggregateId` is the
   recipient. Deliverers subscribe to it; the dispatcher sends nothing.
   `notification.read` and `notification.all_read` are published only when
   something changed.

7. **Live delivery belongs to realtime and reuses its connection.**
   `NotificationRealtimeRelay` (in realtime) subscribes to the three events,
   reads stored notifications through notifications' `NOTIFICATION_READER`
   contract — a page at a time, and only for recipients who are connected —
   and sends `notification.created`, `notification.read` and
   `notification.read_all` frames to the recipient's own connections, through
   the same `ConnectionManager` and socket as messaging. Realtime depends on
   notifications' contracts only and stores nothing.

8. **Push is a port in notifications, with a logging adapter.**
   `PushProvider` has `registerDevice`, `unregisterDevice` and
   `send → outcome`. `PushDelivery` subscribes to `notification.created` when
   the push flag is set, skips notifications already read, reads the devices
   for a page of recipients at once, and acts on the outcome:
   - `delivered` — done;
   - `retryable` (or a thrown error) — retried in memory with backoff, at most
     three attempts, never sooner than `retry-after`, and not at all when the
     provider asks for longer than a retry is held (60 s);
   - `invalid_token` — the device is disabled and audited;
   - `rejected` — logged, never retried.

   The only adapter, `LoggingPushProvider`, sends nothing and never logs a
   token. No push SDK is a dependency; a dependency-cruiser rule confines any
   future one to `notifications/infrastructure/`.

9. **A push says only what kind of thing happened** (PROVISIONAL, Q24): the
   type's title key and a `body_private` key with no arguments — no sender
   and no content — so a lock screen shows "رسالة جديدة" and nothing a
   passer-by should read. The full notification is in the app, behind
   sign-in.

10. **Preferences: three channels per category, and IN_APP is the record.**
    `notification_preferences (user_id, category, in_app, realtime, push)`;
    no row means the defaults (all on, provisional — Q28). The effective
    channels are: stored if IN_APP; live if IN_APP and REALTIME; pushed if
    IN_APP and PUSH. Turning push off never turns anything else off. Only
    categories with an active type are offered.

11. **Devices: one row per `(provider, token)`, moved to whoever registers
    it.** A token names an app installation, and the installation belongs to
    whoever is signed in on it now, so registering a token another account
    holds rebinds it (audited with `movedFromUserId`). At most ten enabled
    devices per person — the least recently seen is evicted, and that is
    audited — and thirty registrations per hour. The token is never returned,
    logged, audited or put in an event. **Sign-out:** the app unregisters its
    device before signing out; the server does not tie devices to sessions
    (see Alternatives).

12. **Read state and counting are bounded.** Marking one read is idempotent
    and never dates a read before its notification
    (`greatest(created_at, now)`). "Mark all" marks up to a boundary — the
    newest notification the person saw, or the request's time — in chunks of
    1,000 rows, at most 50 per request (`complete: false` beyond that). The
    unread count reads at most 100 rows of a partial index and answers
    `{ count: 99, capped: true }` above 99. Lists are keyset-paginated on
    `(created_at, id)` behind an opaque cursor.

13. **Authorization is scope, not a new permission.** Every route is
    `@Authenticated()`; every use case acts on the principal's own id; no
    request names another account; another person's notification or device
    is `404`. Opening a target goes through the owning module's ordinary
    authorization.

14. **Audit devices, not notifications.** Device registration,
    unregistration, eviction and disabling are audited. Creating a
    notification and changing a preference are not.

15. **No foreign keys into other modules' tables.** `recipient_user_id` and
    `user_id` hold account ids as plain columns, as in messaging — so
    suspending or disabling an account leaves its history alone.

## Consequences

- A notification survives every delivery failure; a push or socket failure
  can neither remove nor duplicate it. What an offline person missed is in
  the inbox, and on the badge, the next time the app asks.
- A fact delivered twice, even concurrently, is one row, one frame and one
  push (tested on Postgres with twenty concurrent dispatches).
- In-process delivery is still at most once: a crash between the message's
  commit and the translator loses that message's notifications, never the
  message. The dedupe keys make ADR 0006's outbox a drop-in.
- Push retries live in memory, so a restart forgets them. That is acceptable
  for a best-effort channel; a durable queue belongs with the outbox.
- A post to a 10,000-member channel costs ten pages of five queries,
  detached from the send.
- Activating a reserved type needs a published fact, a translator and one
  catalog line; the Flutter client already has copy and icons for it.
- Real push still needs one adapter, credentials in configuration, the
  platform projects and a device test — nothing in business code changes.
- The realtime connection still requires `messaging.read` (ADR 0012). Every
  role holds it today; an account without it would receive notifications
  over HTTP only.
- Notifications are kept indefinitely until retention is decided (Q27).

## Alternatives considered

- **Messaging calls notifications** — a `notify()` inside the send use case.
  Rejected by the module rules and the brief: the source would have to know
  every channel, and a notification failure could fail a send.
- **Rendered sentences in the row.** They are tied to one language, frozen at
  creation, and one step from markup injection. Keys and params cost the
  client one lookup.
- **A URL as the target.** It would let whatever creates a notification send
  a person anywhere, bake one client's routes into stored rows, and read like
  permission to open what it points at.
- **Check-then-insert deduplication.** It races under concurrent delivery;
  the unique constraint cannot.
- **One notification per device.** Read state belongs to the person; a row
  per device would need a merge for every badge.
- **Notifications resolving its own recipients** by querying members and
  accounts itself. That is a second copy of messaging's membership and
  visibility rules, and it would drift.
- **Realtime reading the notifications table**, or a second socket for
  notifications. Realtime reads through `NOTIFICATION_READER`, over the one
  connection it already has.
- **Parameters in `notification.created`.** That would spread a person's name
  to every subscriber and, later, to the outbox.
- **Tying devices to sessions** and disabling a device when its session ends.
  Sessions (ADR 0010) describe a device — platform, label, app version — but
  hold nothing that identifies the app installation a push registration
  names; a revoked or expired session is discovered lazily; and identity
  publishes no session events. Rebinding on registration, together with the
  privacy-safe push text, covers the shared device. Revisit if identity gains
  a session-ended event.
- **Adding a push SDK now** (`firebase-admin`, `@parse/node-apn`,
  `web-push`; `firebase_messaging` in the app). Evaluated on 2026-09-23 —
  licences, maintenance, platforms; the table is in notifications.md §12 —
  and not added. None can be built or verified here without a Firebase
  project, an Apple team, credentials and a device, and the brief forbids
  adding one just to claim completion.
- **An outbox now.** None exists; adding one is ADR 0006's next step, not this
  milestone's. The dedupe keys were the part that had to be right today.
- **A permission per inbox action** (`notifications.read` and so on). Every
  account has an inbox; a permission nobody lacks is noise, and scope already
  confines each person to their own notifications.
- **Auditing each notification.** An audit row per recipient per message
  would bury the log and add nothing, because the notification is its own
  record.
