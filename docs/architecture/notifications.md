# Notifications

**State: implemented (V1).** A persistent inbox per person, fed by
messaging's facts, delivered live over the existing realtime connection and —
through a provider port — to devices. Decisions are recorded in
[ADR 0013](decisions/0013-notifications-v1.md), building on
[ADR 0006](decisions/0006-event-architecture.md) (events),
[ADR 0011](decisions/0011-messaging-v1.md) (messaging) and
[ADR 0012](decisions/0012-realtime-messaging-transport.md) (realtime).

**A notification is a stored domain object. Realtime and push only deliver
it; the database is the truth.** If the live connection is down, if push
fails, if both fail, the notification is still there when the person opens
the app.

---

## 1. The pipeline

```
 BUSINESS EVENT            messaging.message.sent (after Postgres has the message)
      │                    — messaging publishes; it knows nothing of notifications
      ▼
 NOTIFICATION TRANSLATOR   MessagingNotificationTranslator: who (messaging's
      │                    MESSAGE_RECIPIENTS), what (type, keys, params, target)
      ▼
 DISPATCHER                event-agnostic: valid? account active? wanted (IN_APP)?
      │
      ▼
 IDEMPOTENT PERSISTENCE    INSERT … ON CONFLICT (recipient, dedupe_key) DO NOTHING
      │                    RETURNING — only rows actually stored go on
      ▼
 notifications.notification.created   (one per stored row)
      ├──▶ REALTIME        NotificationRealtimeRelay → the recipient's own
      │                    connections (the same ConnectionManager, the same socket)
      │                        → Flutter → Notification Center → tap
      │                        → deep link → the destination's NORMAL authorization
      └──▶ PUSH            PushDelivery → PushProvider port → (APNs / FCM later;
                           a logging adapter today)
```

Nothing upstream waits for anything downstream: a send returns when the
message is stored; translation is detached from the publisher; realtime and
push are detached from the dispatcher.

**Where the logic lives.** Messaging, academic, assignments, live and
identity contain no notification logic and import nothing of notifications
(architecture test). They publish events; notifications subscribes. The one
piece of notifications code that knows messaging exists is the translator —
one translator per source module, as each source arrives.

---

## 2. The model

| Field | |
| --- | --- |
| `id` | UUID |
| `recipientUserId` | one account — a notification is personal |
| `type` | stable code (§3) |
| `category` | derived from the type, never from the caller — what preferences govern |
| `titleKey`, `bodyKey` | localization keys under `notification.<type>.` — **never rendered sentences** |
| `params` | at most 10 named plain values (text ≤ 200 characters, finite numbers, booleans) that fill the template |
| `target` | a typed address (§4) — **never a URL** |
| `dedupeKey` | names the source fact and the recipient (§6); never leaves the server |
| `createdAt` | |
| `readAt` | null while unread |

Text is not stored rendered: a notification reads correctly in whatever
language the app shows, and wording can change without rewriting history.
Parameters are plain text only — the domain refuses control characters, line
breaks and Unicode direction overrides/isolates (the characters that make
`gpj.exe` display as `exe.jpg`), nested structures, arrays and anything
executable; the translator sanitizes a display name before it becomes a
parameter, and the client renders every value as plain text.

`createNotification` (domain) is the only way a notification comes to exist:
every field checked, target and params **copied field by field** — nothing a
request carries beyond the named fields is stored — and the category taken
from the catalog.

---

## 3. Types and categories

| Type | Category | State | Created from |
| --- | --- | --- | --- |
| `MESSAGE_RECEIVED` | MESSAGES | **active** | `messaging.message.sent` |
| `CONVERSATION_CREATED` | MESSAGES | **active** | `messaging.conversation.created` |
| `ADDED_TO_CONVERSATION` | MESSAGES | **active** | `messaging.participant.added` |
| `ASSIGNMENT_CREATED`, `ASSIGNMENT_UPDATED` | ASSIGNMENTS | reserved | — |
| `ANNOUNCEMENT_CREATED` | ANNOUNCEMENTS | reserved | — |
| `CERTIFICATE_ISSUED` | CERTIFICATES | reserved | — |
| `HALAQA_UPDATE` | HALAQAT | reserved | — |

Reserved types are vocabulary only. **Nothing creates them**: the modules
whose facts they would announce publish no such events yet, and the
dispatcher refuses a type the catalog does not mark active. No publisher was
invented to fill them. Activating one is: the owning module publishes its
fact, a translator for it, one line in `domain/catalog.ts`. Clients already
have copy and icons for them, and show any type they do not know as a
generic notification.

---

## 4. Targets and deep links

```json
{ "kind": "conversation", "conversationId": "…" }
```

Kinds: `conversation` (used), and reserved `assignment`, `announcement`,
`certificate`, `halaqa`, `live_room`, `profile` — each with exactly one
identifier field (none for `profile`, which can only be the recipient's own).
A target is an address, not a key:

- The client maps it to a screen, and that screen asks the owning module's
  API for the content with the ordinary authorization. **A notification
  never grants access.** Someone removed from a conversation keeps the
  notification about it in their inbox, but tapping it gets
  `messaging.conversation_not_found` from messaging — exactly as if they had
  typed the id (API test: "opening what a notification points at").
- The Flutter tap flow is **mark read → ask the owning module whether the
  target may be opened now → go there** (where the destination checks again).
  Not available: "هذا المحتوى لم يعد متاحًا." A kind this version does not
  know: "لا يمكن فتح هذا الإشعار في هذا الإصدار من التطبيق." Nothing crashes.
- A raw URL was rejected as the primary target: it would let whatever created
  a notification send a person anywhere, bake one client's routes into stored
  rows, and read like permission to open what it points at.

---

## 5. Messaging notifications

**Who.** The translator asks messaging, at translation time, through
`MESSAGE_RECIPIENTS` — never querying users itself, never keeping a copy of
membership:

- current members only (a removal that has committed is in effect);
- whose history window includes the message (`visibleSequence`: someone who
  joined a group after the message was sent cannot open it, so is not told);
- **who may read the conversation now** — `readersOnly`, new in this
  milestone: active accounts whose roles grant `messaging.read`, asked of
  identity's account directory by messaging, the same way messaging decides
  who may be added as a reader. So suspended and disabled accounts, and
  members whose roles no longer let them read, are not notified;
- never the sender. There is no "you sent a message" notification.

A 10,000-member channel is walked a page of 1,000 at a time: each page is one
recipients query, one directory check, one account lookup, one preference
lookup and one multi-row insert.

**What it says.** `MESSAGE_RECEIVED` carries `senderDisplayName`,
`messageType` and `conversationType` — **never the message's text** (tested:
nothing of the body appears in the notification, its events or its push).
The app renders "رسالة جديدة" / "لديك رسالة جديدة من أحمد." (or "رسالة صوتية
جديدة", "صورة جديدة", "ملف جديد"). `CONVERSATION_CREATED` goes to everyone the
conversation was created with except its creator ("بدأ أحمد محادثة معك." for a
direct conversation, "أضافك أحمد إلى مجموعة جديدة." for a group);
`ADDED_TO_CONVERSATION` to the person added, unless they added themselves or
were removed again before translation.

The display name is a snapshot taken when the notification is created; a
later rename does not rewrite old notifications (the same as an email).

**Multi-device.** One notification per person, not per device. It is
delivered live to every connection that person has open, and pushed to every
registered device. Reading it on one device marks it read everywhere — the
server's state — and the others are told at once (`notification.read`,
`notification.read_all`), so every badge agrees. The sender's own devices get
the message live (realtime, ADR 0012) but no notification.

---

## 6. Deduplication and the transaction boundary

Every request carries a deduplication key naming the source fact and the
recipient:

| Type | `dedupeKey` |
| --- | --- |
| `MESSAGE_RECEIVED` | `message:<messageId>:user:<userId>` |
| `CONVERSATION_CREATED` | `conversation:<conversationId>:created:user:<userId>` |
| `ADDED_TO_CONVERSATION` | `conversation:<conversationId>:added:<userId>:<occurredAt ms>` — each addition is its own fact |

The database enforces one row per `(recipient_user_id, dedupe_key)`
(`notifications_dedupe_unique`). The insert is `ON CONFLICT DO NOTHING
RETURNING id`: the constraint, not a prior read, decides what is new, and only
what was actually inserted is announced. Consequences, each tested on
Postgres:

- the same fact delivered twice is one notification;
- twenty concurrent dispatches of the same request store exactly one row and
  publish exactly one `notification.created`;
- a messaging fact translated three times concurrently is one row per
  recipient;
- nothing downstream — live frame, push — happens twice.

**What the in-process bus does not give.** The pipeline today is: business
transaction commits → event published in-process → idempotent insert. There
is no outbox (none exists in this codebase; ADR 0006 describes it). A process
crash after the message commits and before its notifications are stored
loses those notifications — never the message. The dedupe keys are what make
the future outbox's at-least-once redelivery safe: when it arrives, retries
become free and nothing in the translator changes.

---

## 7. Read state

- **One:** `POST /notifications/:id/read` sets `readAt` if it is null
  (`greatest(created_at, now)`, so another instance's clock can never date a
  read before the notification). Idempotent: again returns the same `readAt`
  and publishes nothing. Another person's id is `404`, like a missing one.
- **All:** `POST /notifications/read-all { throughId? }` marks read everything
  up to a **boundary** — the newest notification the person was looking at
  (`(created_at, id) ≤ (…)`), or everything created until the request when no
  `throughId` is given. A notification that arrives while the request is on
  its way stays unread. The update runs in **chunks of 1,000 rows**, each its
  own statement on the partial unread index, never one unbounded `UPDATE`;
  after 50 chunks it stops and answers `complete: false` (call again). Both
  re-check `read_at is null` on the rows themselves, so a concurrent single
  read is neither re-stamped nor counted twice (tested on Postgres).
- Either publishes an event only if something changed; realtime tells the
  person's other devices.

---

## 8. Unread count

`GET /notifications/unread-count` → `{ "count": 42, "capped": false }`, or
`{ "count": 99, "capped": true }` for "more than 99". The query counts at most
100 rows through the partial unread index — a backlog of 100,000 costs what a
backlog of 100 does — and the app never loads a list to count.

In the app, **one controller is the only source every badge reads** (the
bells on Home and Programs, the Profile row, the center): the server's count,
+1 at once for each new live notification (each id once), re-fetched quietly
after, on reads from other devices, on reconnect and on sign-in. Badge: 0 →
none; 1–99 → the number; 100+ → "99+".

---

## 9. Pagination

`GET /notifications?limit=1..50&cursor=…` → `{ items, nextCursor }`, newest
first (`created_at DESC, id DESC` — ties broken by id, so the order is total
and stable). Keyset, never `OFFSET`: the cursor is opaque base64url of the
last `(createdAt, id)`, and every page is a range scan of
`notifications_recipient_created_idx` (asserted with `EXPLAIN` over 5,000
rows, after walking one person's 3,500 each once). The index is ascending on
purpose: scanned backwards it yields exactly `ORDER BY … DESC` (whose default
is NULLS FIRST) — the first version of the migration declared it
`DESC NULLS LAST`, which the planner cannot use for that order, and the test
caught it.

The app merges live notifications into the top by the same order, and a
first page fetched again after a reconnect is merged by id — each
notification once.

---

## 10. Preferences

Per person and category, three independent switches:

| Channel | Meaning |
| --- | --- |
| `IN_APP` | kept in the notification center and counted — the record itself |
| `REALTIME` | announced live while the app is connected |
| `PUSH` | sent to the person's registered devices |

- **Disabling push never disables in-app** (or realtime); each switch is
  stored and changed separately.
- `IN_APP` off means nothing is stored — so there is nothing to deliver live
  or by push either. The stored realtime/push choices are kept as set, and
  turning the center back on restores them. The settings screen says so and
  greys the two out rather than hiding it.
- Defaults: everything on (PROVISIONAL, Q28). No row means the defaults, so a
  new account costs nothing.
- Only categories with an active type are offered (`MESSAGES` today) — a
  switch for notifications that never arrive would be a lie. No matrix of
  types × channels.
- The dispatcher reads preferences for a whole page of recipients in one
  query; the decisions for realtime and push travel in
  `notification.created`, so the deliverers never re-read them.
- Not audited: a preference is a person's choice about their own inbox and
  grants nothing to anyone.

API: `GET /notifications/preferences` →
`{ "categories": [{ "category": "MESSAGES", "inApp": true, "realtime": true, "push": true }] }`;
`PATCH /notifications/preferences { "category": "MESSAGES", "push": false }`
(switches left out keep their value).

---

## 11. Realtime delivery

`NotificationRealtimeRelay` lives in the realtime module and reuses its
`ConnectionManager` — there is one socket per client, never a second one for
notifications. It subscribes to `notifications.notification.*`:

- `notification.created` → the stored notification (read back through
  notifications' `NOTIFICATION_READER`, rendered exactly as the HTTP inbox
  renders it) to **the recipient's connections only** — never by role,
  organisation, permission or channel; the recipient is the account the
  stored row names, not one taken from the event. Skipped when the
  recipient's REALTIME preference is off, or when they are not connected (then
  nothing is even read). A page of 1,000 creations is rendered with one read.
- `notification.read` / `notification.read_all` → the recipient's other
  devices.

Frames (protocol v1, `eventId` derived from the fact):

```json
{ "type": "notification.created", "version": 1, "eventId": "notification.created:<id>",
  "occurredAt": "…", "notification": { "id": "…", "type": "MESSAGE_RECEIVED", "category": "MESSAGES",
  "titleKey": "…", "bodyKey": "…", "params": { … }, "target": { … }, "createdAt": "…", "readAt": null } }
{ "type": "notification.read", "version": 1, "eventId": "notification.read:<id>",
  "occurredAt": "…", "notificationId": "…", "readAt": "…" }
{ "type": "notification.read_all", "version": 1, "eventId": "…",
  "occurredAt": "…", "throughCreatedAt": "…", "throughId": "…" | null, "readAt": "…" }
```

No recipient id and no deduplication key on the wire (tested).

Realtime stores nothing about notifications and depends on notifications'
contracts only (architecture test). The realtime connection itself still
requires `messaging.read` (ADR 0012) — held by every role today; an account
without it would get its notifications from the inbox over HTTP, not live.

**Offline.** Nothing is queued in realtime. A person who is offline finds the
notification in the inbox (and the badge) when the app next asks — on start,
sign-in, resume and every reconnect (tested end to end: connected,
disconnected, reconnected).

---

## 12. Push

**The seam.** `PushProvider` (notifications' domain port) —
`registerDevice`, `unregisterDevice`, `send(device, message) → outcome`. The
only implementation is `LoggingPushProvider` (infrastructure): it records at
debug level that a push *would* have gone out — device id, platform,
provider, notification id and type, never the token — and sends nothing.
**No Firebase, APNs or web-push SDK is installed** anywhere, and a
dependency-cruiser rule (`push-sdks-only-in-the-notifications-adapter`)
fails the build if one is imported outside `notifications/infrastructure/`.
Choosing a provider replaces one line in `notifications.module.ts`.

**What a push says — the lock-screen policy (PROVISIONAL, Q24).** Only what
KIND of thing happened: `titleKey` = `notification.<type>.title`, `bodyKey` =
`notification.<type>.body_private` ("لديك رسالة جديدة."), no arguments — **no
sender name, no content**. A lock screen is read by whoever holds the phone,
and many of these phones belong to children or are shared. The notification
itself, with the sender's name, is in the app, behind sign-in. Keys rather
than sentences because APNs (`title-loc-key`, `loc-key`) and FCM
(`title_loc_key`, `body_loc_key`) both render keys the app ships. Each push
carries the target (for the tap) and a thread key (`conversation:<id>`) so a
burst groups on the device.

**Outcomes, as the adapter classifies the provider's answer:**

| Outcome | What happens |
| --- | --- |
| `delivered` | done |
| `retryable` (throttled, 5xx, timeout — or an adapter that throws) | retried after 2 s, 4 s … (capped at 60 s, never sooner than the provider's `retry-after`), at most 3 attempts, then given up and logged. A provider that asks to wait longer than 60 s is not retried at all: sending early would push into its throttle, and the notification is in the inbox anyway |
| `invalid_token` (FCM `UNREGISTERED`, APNs `410`) | the device is disabled — push skips it until the app registers it again — and it is audited |
| `rejected` (a permanent failure for this message) | logged, never retried |

**A push failure never touches the notification** (tested with a provider
that rejects, throws and is down). Retries are in memory — a restart forgets
them — which is acceptable for a best-effort channel; there is no job queue in
this codebase and none was added. A durable one belongs with the outbox.

Push is sent only for notifications that are stored and still unread when
push gets to them, only when the recipient's PUSH preference is on, and once
per stored notification. Devices for a page of recipients are one query;
sends run 16 at a time.

**What a real provider needs** (evaluated 2026-09-23; see ADR 0013):

| | Server side (this repository) | App side |
| --- | --- | --- |
| FCM (Android; also iOS and web) | `firebase-admin` 14.4.0 (Apache-2.0, Node ≥ 22) with a service-account credential — a secret, via configuration only | `firebase_messaging` 16.7.0 + `firebase_core` 4.15.0 (BSD-3-Clause, publisher firebase.google.com, 160/160 pub points; Android, iOS, macOS, web), `google-services.json` / `GoogleService-Info.plist` |
| APNs directly (iOS) | `@parse/node-apn` 8.1.0 (MIT, Node 20/22/24) with a `.p8` token key, key id, team id, topic | the Push Notifications capability, an APNs key, a device (the simulator's push support is limited) |
| Web push | `web-push` 3.6.7 (MPL-2.0) with VAPID keys | a service worker |

None of this can be built or verified in this environment (no Firebase
project, no Apple team, no device, no native build), so **no dependency was
added to claim completion**. The contracts, the provider seam on both sides,
device registration and the delivery logic are implemented and tested; what
remains for the CI/App Store builds is the adapter, the credentials in
configuration, the platform project files, and a device test.

---

## 13. Devices

`POST /notifications/devices { platform, provider, token }` registers the
caller's device; `DELETE /notifications/devices/:id` unregisters it.

| Field | |
| --- | --- |
| `id`, `userId` | |
| `platform` | `IOS`, `ANDROID`, `WEB` |
| `provider` | `APNS` (iOS only), `FCM` |
| `token` | the provider's address for the installation |
| `createdAt`, `lastSeenAt` | registered again = seen again |
| `disabledAt` | set when the provider said the token is dead |

- **The token is never returned, logged, audited or put in an event.** The
  response is `{ id, platform, provider, createdAt, lastSeenAt }`; the logger
  censors `token`, `pushToken` and `deviceToken` at every depth; tests assert
  it for the API transcript, the audit trail and every log line.
- **A request cannot name another account** (unknown fields are refused); the
  device is always the caller's. Another person's device is `404`, like one
  that does not exist.
- One row per `(provider, token)`, normalized (APNs hex lower-cased).
  Registering a token another account holds **moves it to the caller** — a
  token names an app installation, and the installation belongs to whoever
  is signed in on it now. That is also what stops a shared classroom tablet
  from receiving the previous student's pushes. The move is audited with the
  previous account's id. Re-registering keeps the device's id and re-enables
  a disabled token.
- Several devices per person; at most 10 enabled — registering an eleventh
  forgets the one seen least recently (audited). 30 registrations per hour
  per account.
- **Sign-out:** the registration is not deleted by the server when a session
  ends — the app unregisters its device *before* signing out, while the
  session can still authenticate the request (`PushRegistration.release`).
  If that fails (offline), the next account to sign in on the device takes
  the token over; until then, what reaches that device is the lock-screen
  text above — no names, no content. (The app has no sign-out control yet;
  the call is in place for when it does.)
- **Push is never authentication.** A registered device proves nothing, a
  push carries no credential, and no request is granted anything because a
  device is registered.

---

## 14. Account state

Suspended and disabled accounts get **nothing new**: the translator asks for
readers only, and the dispatcher independently drops every recipient identity
does not report active — so no new notification, no live frame, no push.
Their **history is kept**: nothing is deleted because an account is
suspended, and a reactivated account finds its old notifications (API test,
for both states). Their open realtime connections are closed within 60
seconds by realtime's revalidation (ADR 0012), and they cannot sign in to
read anything.

---

## 15. Authorization

Every `/notifications` route is `@Authenticated()` — declared explicitly, and
checked by the architecture test that fails on an undeclared route. No new
permission: having an inbox is inherent to having an account, like managing
one's own sessions, and a role that could not read its own notifications
would make no sense. What keeps it safe is **scope, not a permission**: every
use case acts on the principal's own id, no request can name another account,
and another person's notification or device answers `404` exactly like one
that does not exist. Opening a target is the owning module's authorization
(§4).

---

## 16. Audit

Not audited: ordinary notification creation (it is the inbox itself — an
audit row per message per recipient would bury the log) and preference
changes (they grant nothing). Audited, with the platform `AUDIT_LOG`:
`notifications.device.registered` (with `movedFromUserId` when a token moved),
`notifications.device.unregistered`, `notifications.device.evicted`,
`notifications.device.disabled` (actor: the system, reason
`invalid_token`). Never a token, never message content.

---

## 17. Localization

The server sends stable keys and plain values; the app owns the words. In
Flutter every notification sentence lives in `NotificationCopy`
(`features/notifications/notification_copy.dart`) — a test fails if an Arabic
string literal appears in the notification state, models, repository or
screens. Relative times follow Arabic number agreement ("قبل دقيقتين",
"قبل 5 دقائق", "قبل 25 دقيقة", "أمس"). A key or type the app does not know
reads "إشعار جديد" / "لديك إشعار جديد." — never a raw key.

---

## 18. Performance

| Operation | Cost |
| --- | --- |
| a message to N members | ⌈N/1000⌉ × (recipients page + directory check + account lookup + preference lookup + one multi-row insert) |
| a page of the inbox | one range scan of `(recipient_user_id, created_at, id)` |
| the unread count | ≤ 100 rows of the partial unread index |
| mark all read | chunks of ≤ 1,000 rows of the partial unread index |
| live delivery of a page of creations | an in-memory "is anyone connected" check per recipient, one read for those who are |
| push for a page of creations | one notification read, one devices read |

No `OFFSET`, no load-then-filter in Dart, no per-recipient queries, no
per-target fetches.

---

## 19. API

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/notifications?limit&cursor` | `{ items: Notification[], nextCursor }` |
| GET | `/notifications/unread-count` | `{ count, capped }` |
| POST | `/notifications/:id/read` | the notification, read (idempotent) |
| POST | `/notifications/read-all` `{ throughId? }` | `{ markedRead, complete }` |
| GET | `/notifications/preferences` | `{ categories: [...] }` |
| PATCH | `/notifications/preferences` `{ category, inApp?, realtime?, push? }` | `{ categories: [...] }` |
| POST | `/notifications/devices` `{ platform, provider, token }` | `{ id, platform, provider, createdAt, lastSeenAt }` |
| DELETE | `/notifications/devices/:id` | `204` |

Error codes: `notifications.notification_not_found`,
`notifications.cursor_invalid`, `notifications.category_unknown`,
`notifications.preferences_empty`, `notifications.device_invalid`,
`notifications.device_rejected`, `notifications.device_not_found`,
`notifications.too_many_registrations`.

---

## 20. The Flutter client

- `NotificationsRepository` — `HttpNotificationsRepository` (the API above) and
  `MockNotificationsRepository` (the demo build: notifications pointing at the
  demo conversations, one of them at a conversation that no longer exists).
  Screens never see HTTP.
- State (Riverpod, no global singletons): `UnreadCountController` (§8),
  `NotificationListController` (pages; live insertion without duplicates;
  optimistic read and read-all, rolled back if the server refuses; merge on
  reconnect), `NotificationPreferencesController` (optimistic switches, rolled
  back on refusal).
- Screens: **الإشعارات** (`/notifications`) — icon by type, title, body,
  relative time, unread mark, pull to refresh, "mark all read", load more,
  error with retry; **إعدادات الإشعارات** (`/notifications/settings`).
- `UnreadBadge` on the existing notification icons of Home and Programs and on
  the Profile row — the only change to those screens.
- Push: `PushTokenSource` (an interface; `UnavailablePushTokenSource` in this
  build) and `PushRegistration` (registers while signed in, when a token
  exists). A test fails if any push SDK is a dependency or imported.

---

## 21. Tested

Backend (886 tests with Postgres): request validation, targets, params and
sanitizing; the catalog; preferences semantics; device token rules; the
lock-screen payload; creation, duplicate and concurrent-duplicate dispatch,
recipient isolation, suspended/disabled/unknown accounts, preferences on
dispatch, invalid requests, bounded batches, one directory call per batch;
translation for each messaging fact, sender exclusion, no message text,
visibility window, removal before translation, readers only, a 2,500-member
channel in pages; inbox isolation, unread count and cap, mark one (and
idempotence), mark all (boundary, chunks, chunk limit), keyset pages and
stable ties, forged cursors; preferences defaults, updates and isolation;
devices (registration, redaction in responses/audit/logs, multiple, refresh,
moving between accounts, ownership, eviction, rate limit, rejection); push
(provider abstraction, once per notification, preference off, failures never
delete, retries bounded, never sooner than a provider's `retry-after` and not
at all past 60 s, permanent never retried, dead tokens disabled,
already-read skipped, one lookup per page); the realtime relay (recipient
only, wire shape, preference off, offline, one read per page, read frames,
malformed events); the HTTP API (anonymous refused, flows, isolation, target
authorization after removal, suspended and disabled, preferences, devices,
live); Postgres (constraints by name, no cross-module foreign keys, database
guards, one row under 20 concurrent deliveries, concurrent translation,
thousands of rows by keyset on the index, the capped count on the partial
index, chunked mark-all alongside a concurrent read, devices); the end-to-end
connected / disconnected / reconnected scenario; architecture (no module
imports notifications; contracts only; no push SDK; adapters only in
infrastructure; realtime owns no notification persistence).

Flutter (328 tests): models and unknown types/targets, frames, copy and
Arabic number agreement, the HTTP repository, state (pages, live insertion
and duplicates, reads and rollbacks, cross-device reads, reconnect, errors
and retry, preferences, push registration), widgets (the badge at
0/1/99/100, the center, tap to a conversation, stale and unsupported targets,
empty, error and retry, mark all, live insertion, settings), boundaries.

---

## 22. Limitations and deferred work

- **Outbox.** In-process delivery is at most once (§6). The dedupe keys make
  the outbox a drop-in.
- **A push provider** (Q24): the adapter, credentials and platform setup
  (§12).
- **Retention** (Q27): notifications are kept indefinitely.
- **Collapsing** a busy conversation's notifications, quiet hours,
  per-conversation mute, email, priority levels, announcement-style
  notifications from staff (Q28).
- **Several instances:** like realtime, delivery reaches the connections of
  the instance that handled the event; a broker-backed bus is the path
  (ADR 0012).
- **A sign-out control** in the app, which would call
  `PushRegistration.release` before signing out.
