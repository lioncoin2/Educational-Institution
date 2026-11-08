# 0058 — Real push on Android through FCM, to devices bound to a live session

**Status:** Accepted (2026-11-08, the owner agreed — R9) — supersedes
[0013](0013-notifications-v1.md) decision 11 in part (devices are now tied to sessions);
decision 9 (a push says only what kind of thing happened) stands unchanged.
**Date:** 2026-11-08

## Context

Notifications V1 ([0013](0013-notifications-v1.md)) built the whole pipeline — stored
inbox, preferences, quiet hours, mutes, device registration, `PushDelivery` with retry
and dead-token handling — around a `PushProvider` port whose only adapter logged what
it would have sent. The app had a `PushTokenSource` seam bound to "unavailable". So no
phone ever showed a notification: a message, a task or a granted floor reached the
inbox, and nothing reached a pocket.

Making push real raised four questions the logging adapter never had to answer:

1. **What reaches the lock screen.** Q24 is still provisional; 0013 d9 says the kind of
   thing only — no name, no content. Some of these phones are children's, or shared.
2. **Who stops receiving, when.** 0013 d11 relied on the app unregistering its device
   before signing out. A session also ends without the app: revoked from another device,
   by a password change, by an administrator, refused at refresh, or at its absolute
   expiry (30 days). Under d11 such a phone kept receiving that account's push forever.
3. **How the server talks to FCM.** The Admin SDK is heavy and broad; the dependency
   rules confine any push SDK to `notifications/infrastructure/`.
4. **How a build without Firebase stays exactly as before** — the web, iOS, the demo,
   every test.

## Decision

1. **Content-free, keys only.** The FCM HTTP v1 request carries
   `android.notification.{title_loc_key, body_loc_key, channel_id, tag}` — the domain
   keys with `.` as `_` — and **no** literal title or body and **no** top-level
   `notification` object (FCM prefers a literal over a key). Android renders the
   sentence from the app's string resources, in Arabic. The data payload carries ids
   only (`notificationId`, `type`, the typed `target` as JSON). The app ships a type's
   strings before the server activates the type (a test reads the server catalog), and
   `res/raw/keep.xml` keeps them through release resource shrinking — nothing in code
   references them.
2. **A zero-dependency adapter.** `notifications/infrastructure/fcm/`: the service
   account's RS256 JWT-bearer assertion signed with `node:crypto`, exchanged at Google's
   token endpoint for a shared, refreshed bearer token (single-flight, failures
   remembered 10 s), one `fetch` POST per device. No SDK is installed; the existing
   guards hold unchanged.
3. **Classification by FcmError code first** (`fcm-outcome.ts`): `UNREGISTERED` and an
   `INVALID_ARGUMENT` on `message.token` disable the device; any other
   `INVALID_ARGUMENT`, `SENDER_ID_MISMATCH`, `THIRD_PARTY_AUTH_ERROR`, 403 and 404 are
   *rejected* — a configuration or request problem, logged once per five minutes, and
   never a reason to switch devices off (one wrong project id would otherwise disable
   every device); 401 replaces the access token and retries once; 429/5xx/network are
   retryable, honouring `Retry-After` — and a failed OAuth exchange (remembered 10 s)
   asks for a retry after it, while a token not yet expired keeps being used. Push
   delivery logs a rejection only at debug level. Reasons are codes, never message text.
4. **Devices are bound to the session they were registered through — supersedes 0013
   d11 in part.** `notification_devices.session_id` (migration 0038, nullable, indexed);
   registration requires `principal.sessionId` (a system principal cannot register) and
   the upsert writes it on insert and on conflict; one push row per session (a refreshed
   token replaces the old row, audited `notifications.device.superseded`; registrations
   through one session are serialized by a transaction-scoped advisory lock, as rows
   alone cannot lock a session that has none yet). Before each
   page of sends `PushDelivery` asks identity's new **`ACTIVE_SESSIONS`** contract —
   `activeAmong(refs) → refs` live for the account named with them, at most 1,000 per
   call — and sends only to those. A device whose session ended is forgotten with a
   compare-and-set (`id` and `session_id`, so a re-registration meanwhile survives),
   audited `notifications.device.session_ended`. A row with no session (from before
   0038) receives nothing until the app registers it again. **If identity cannot answer,
   nothing of that page is sent** — a push to a phone its owner signed out of is worse
   than a missing one, which the inbox makes up. A retry asks again — and is withheld if
   the session ended or the notification was read meanwhile. It is a question at send
   time, not an event, so every way a session ends is covered, expiry included. The app
   still unregisters on an explicit sign-out (d11's rule), now as defence in depth,
   bounded to 3 s so it never holds the sign-out up.
5. **No push for a raised hand** — ADR 0024 implemented: the catalog marks
   `LIVE_SPEAKER_REQUESTED` `push: false`; the dispatcher announces it with
   `push: false` whatever the preference. It is for moderators already in the room.
6. **At most one push per person and thread in 15 s** (`threadWindowMs`, in
   `PushDelivery`): a burst in a busy conversation buzzes once; every notification
   still reaches the inbox. Reading the conversation (`messaging.message.read`) ends the
   window for that reader, so the next message after a read always buzzes — someone who
   answered and put the phone down still hears the reply. `tag = threadKey`, so a newer
   push replaces the older one in the tray. In-memory, per process — best effort, like
   the retries.
7. **Android only, behind two switches.** The server's FCM adapter accepts only
   `FCM` + `ANDROID` registrations. The app binds `FirebasePushTokenSource`
   (`lib/data/push/firebase_push.dart`, the ONE file importing Firebase) only in a
   backend build made with `--dart-define=PUSH_ENABLED=true` on Android; the Google
   services Gradle plugin is applied only when `android/app/google-services.json`
   (git-ignored) exists. The web and iOS stay unavailable — on the web the Firebase JS
   SDK is injected only by `Firebase.initializeApp`, which is never called there (the
   release web build contains no Firebase code at all; a headless load requested nothing
   from Firebase). The Android plugins are linked into every Android build, so their
   manifest entries are merged in; without the flag no token is ever fetched.
   Packages pinned exactly: `firebase_core 5.1.0`, `firebase_messaging 17.0.1`.
8. **Client lifecycle** (`PushRegistration`, the state layer): auto-init off in the
   manifest; after sign-in, with permission, the token is fetched and registered —
   again only when the token or the account changes; a rotated token re-registers;
   an explicit sign-out releases the device, then signs out; any signed-out state
   deletes the token and clears the tray; at every start, sign-in and resume the
   permission is re-checked (switched off → released and the token deleted, switched on →
   registered); operations run one at a time, in order. The system dialog is shown only
   after the app's own once-per-installation offer, when the person taps "turn on";
   the notifications screen keeps a way to turn it on later. A tap opens its target
   through the same resolver as the inbox (marked read first; another account's →
   the inbox; the same tap twice → nothing); community and live-room targets now open
   too. No system banner while the app is open — the inbox updates live.
9. **Channels per category** (`messages`, `community`, `live`, `attendance`, `tasks` —
   the server's category, lower-case), created when push starts, so a person can
   silence one kind in the system settings. `HIGH` priority; TTL 15 min for live, a day
   otherwise.
10. **Configuration is a path, never a key.** `PUSH_PROVIDER=fcm` +
    `FCM_CREDENTIALS_FILE` (absolute); the file is read and checked once at startup
    (type, project id, account e-mail, key id, Google's token endpoint, an RSA key held
    as a `KeyObject`) and an unusable one stops the boot with a message naming the field,
    never a value. Overlays (`infra/compose.push.yaml`, `compose.trial.push.yaml`) mount
    it read-only; the redaction list gains the key, assertion and token field names. A
    `validate_only` smoke check (`dist/cli/push-smoke.js`) proves credentials, project,
    permission and payload without a phone. Runbook:
    [push-notifications-runbook.md](../../push-notifications-runbook.md).
11. **Delivery width 64** (was 16): HTTP sends answer in tens of milliseconds.

## Consequences

- A phone shows «رسالة جديدة» (and the other kinds) seconds after the fact, with nothing
  a passer-by should read; a tap opens the conversation, task, community or live room.
- Signing out, ending a session anywhere, a password change, an administrator's action
  or plain expiry all stop a device's push, without the app's help. A device signed in
  30+ days ago receives nothing until the person signs in again — that is the session's
  lifetime, now visible in push too.
- One identity lookup per page of sends (≤ ⌈devices/1000⌉ queries on the primary key).
- Existing registrations (none in production) carry no session and receive nothing until
  re-registered — the app re-registers on its next start.
- `firebase_messaging` 17 deprecates the registration-token API in favour of Firebase
  Installation IDs; this binding keeps the token deliberately (the server's v1 send takes
  `message.token`), behind the exact pin. Moving to FIDs is a later, server-first change.
- iOS, the web, rich notifications (names/previews), push for live-session start (ADR
  0025), per-type preferences and a durable send queue remain out of scope. iOS now links
  the Firebase pods; an iOS build is unverified here.
- Android shows `android:label` on every notification; the owner named the app
  «المؤسسة التعليمية» (2026-11-08). Owner items before it is switched on: the Firebase
  project and its `google-services.json`, a dedicated service account (FCM role only),
  Play Data-safety answers.

## Alternatives considered

- **firebase-admin.** Rejected: a large dependency with every Firebase product and an
  Admin-SDK credential far broader than sending; the v1 API is one HTTPS call.
- **A session-ended event to delete devices.** Rejected: expiry announces nothing, and a
  missed event would leave a device reachable forever; asking at send time cannot miss.
- **Literal titles/bodies in the request.** Rejected: the server would own sentences
  (0013: the client owns the words) and FCM would show them instead of the keys.
- **Rendering in the app (data-only messages + a local-notifications plugin).** Rejected
  for V1: a second native plugin, and a killed app on some phones would show nothing.
