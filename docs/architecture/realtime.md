# Realtime

Two unrelated things are "realtime" in this system, and they share nothing
but the word:

- **[Part M — messaging in real time](#part-m--messaging-in-real-time):** a
  new message, read mark or membership change — and a new notification —
  reaches the people entitled to it while they are connected. A WebSocket
  from the API. Implemented (Realtime Messaging V1,
  [ADR 0012](decisions/0012-realtime-messaging-transport.md); notifications
  ride the same connection since Notifications V1,
  [ADR 0013](decisions/0013-notifications-v1.md)).
- **[Part A — live audio rooms](#part-a--live-audio-the-2500-participant-design):**
  a teacher speaking to ~2500 listeners. LiveKit media, capability tokens.
  Designed; the coordination layer is implemented.

---

# Part M — Messaging in real time

## M1. The pipeline

```
  HTTP send ──▶ MessageSender ──▶ messages (PostgreSQL)            ◀── the truth
                     │ after the commit
                     ▼
            messaging.message.sent  (ids only)
                     │ EventSubscriber port — the send has already returned
                     ▼
   realtime ─ MessagingRealtimeRelay        per conversation, in publication order
                 │ who?  MESSAGE_RECIPIENTS  current members who can see this
                 │                           sequence — asked NOW, from the database
                 │ what? MESSAGE_DELIVERY    rendered once, by the timeline's own views
                 ▼
             ConnectionManager               this instance's connections, per account
                 ▼
             WebSocketTransport  ── /realtime ──▶  Flutter RealtimeClient
                                                    ▼
                                    ConversationController / ConversationListController
                                    merge by id, order by sequence, fill gaps over HTTP
```

Two stacks that meet only at an event:

| Messaging | Realtime |
| --- | --- |
| persistence → domain event | event subscriber → recipients → connections → transport |
| decides membership, visibility, what a message looks like | decides nothing about messaging |
| imports no socket library, no realtime code (architecture tests) | reads messaging, identity and notifications through their contracts only |

Realtime is an **extension**, not a second messaging system: it stores
nothing, and nothing depends on it. When it is down, messages are still
stored, HTTP still serves them, and clients catch up by sequence.

**Notifications use the same connection** — the same `ConnectionManager`,
the same socket, never a second one:

```
  notifications ─ dispatcher ──▶ notifications (PostgreSQL)        ◀── the truth
                     │ one per row actually stored
                     ▼
     notifications.notification.created  (ids, type, channel flags)
     notifications.notification.read / all_read
                     ▼
   realtime ─ NotificationRealtimeRelay     only if the recipient is connected
                 │ what? NOTIFICATION_READER  the stored notification, rendered as
                 │                            the HTTP inbox renders it; a page at a time
                 ▼
             ConnectionManager.sendToUser(recipient)   ──▶  UnreadCountController /
                                                            NotificationListController
```

The relay depends on notifications' contracts only and stores nothing; the
recipient is the account the stored row names. Notifications decides what
exists, for whom, and whether the person wants it live
([notifications.md §11](notifications.md#11-realtime-delivery)).

## M2. Transport

Plain WebSocket (RFC 6455) through `ws`, in one adapter
(`realtime/infrastructure/websocket-transport.ts`), on the API's own HTTP
server at **`/realtime`**. Why not socket.io and why not a Nest gateway:
[ADR 0012](decisions/0012-realtime-messaging-transport.md).

The adapter owns only what a transport can do:

| Concern | What it does |
| --- | --- |
| Handshake | path must be `/realtime` (404); a browser's `Origin` must be in `CORS_ORIGINS` (403) — CORS does not apply to WebSockets, so this is the check; instance capacity (503); handshakes per client address (429 + `Retry-After`) — all before a socket exists |
| Frames | text only; at most 4 KiB, refused by the library with close 1009 before it is buffered; no compression (CPU per connection, and CRIME-style attacks with a credential in the stream) |
| Liveness | a protocol ping every 25 s; a socket that has not answered by the next one is terminated |
| Backpressure | a client more than 1 MiB behind is closed (1013); it reconnects and catches up over HTTP |
| Shutdown | every socket closed with 1001, then the server stops |

Everything the frames mean is `RealtimeSessions`' business (application
layer); the adapter hands it text and a `ClientLink` (send, close) and
nothing else.

## M3. Authentication — the HTTP guard's own decision

1. The client opens the socket and sends `{"type":"auth","token":"<access token>"}`
   as its first frame. **Never in the URL**: URLs are written to proxy and
   server logs, and browsers cannot set headers on a WebSocket.
2. The server asks identity's `ACCESS_TOKEN_AUTHENTICATOR` — implemented by
   the same `ResolvePrincipalUseCase` the HTTP guard uses: signature,
   issuer, audience, expiry; the session still live; the account ACTIVE;
   roles and permissions read from storage now. One implementation of
   authentication, not two.
3. Then the coarse gate every messaging route has: `messaging.read`. (The
   connection also carries the account's own notifications; the gate is
   unchanged — every role holds it — and an account without it would read
   its notifications over HTTP.)
4. Then the per-account limits (§M8).
5. `ready` — `{connectionId, userId, expiresAt, heartbeatSeconds}`. The
   user id is the server's, from the token; a frame that tries to state one
   (or roles, or a membership) is refused as `INVALID_PAYLOAD`.

Fail closed, always: invalid, expired, revoked, suspended → `UNAUTHORIZED`
and close **4401**; no messaging permission → `FORBIDDEN` and **4403**; no
`auth` within 10 s → 4401.

**Staying authenticated.** A connection outlives its 15-minute access token.
The client sends `auth` again with a fresh token before `expiresAt` (same
account only — a connection never changes accounts). The server:

- closes a connection whose token has expired (4401);
- re-checks every open connection's session, account and `messaging.read`
  every **60 s** (once per session, however many devices), closing on
  revocation (4401) or a lost permission (4403);
- re-checks again, freshly, on every `subscribe`.

What the server keeps per connection (`domain/connection.ts`): connection
id, user id, session id, authenticated-at, expires-at, validated-at,
last-seen-at, remote address. No roles, no permissions, no memberships, no
message history, no profile data.

## M4. Who receives what

| Event | Delivered to |
| --- | --- |
| `conversation.created` | its members at creation (so a new conversation appears before anything is said) |
| `message.sent` | every **current** member whose history window includes the message's sequence — the sender's own devices too, with their `clientMessageId`; nobody else sees that key |
| `message.read` | the **reader's own** devices (read on the phone, badge clears on the laptop). Not other members: read receipts are open question Q25 |
| `participant.added` | the person added |
| `participant.removed` | the person removed or who left — no content |
| `notification.created` | **the recipient only** — every connection of the account the stored notification belongs to, unless their REALTIME preference for its category is off |
| `notification.read`, `notification.read_all` | the recipient's own devices, so every badge agrees |

Recipients are read from the database **at delivery time**, through
messaging's `MESSAGE_RECIPIENTS`: never "everyone online", a role, a
permission or an organisation. A removal that has committed is in effect for
the next event. Someone added to a group after a message was sent is not
sent it (their window starts after it). The institution owner, holding every
permission, receives nothing of a conversation they are not in (tested).

**Subscriptions are derived, not declared.** `{"type":"subscribe",
"conversationId"}` asks the server to confirm one conversation, with
messaging's own "open this conversation" use case and a freshly revalidated
principal, and answers `subscribed {lastSequence, lastReadSequence}` — the
positions a client catches up from. It stores nothing and cannot widen what
the connection receives. Missing and not-yours are the same
`CONVERSATION_NOT_FOUND`, so a guessed id tells nothing.

## M5. The wire protocol, version 1

One JSON object per text frame (`realtime/domain/protocol.ts`,
`realtime/application/envelopes.ts`). Every server frame has `type` and
`version`; client frames may carry `version: 1` and an `id` the reply echoes.

```json
{ "type": "message.sent", "version": 1,
  "eventId": "message.sent:7f3c…", "occurredAt": "2026-09-23T08:00:00.000Z",
  "conversationId": "c19a…", "conversationType": "GROUP",
  "messageId": "7f3c…", "sequence": 120,
  "message": { …exactly the HTTP MessageResponse… },
  "sender": { "userId": "…", "displayName": "الأستاذ عبدالله" } }
```

- Built field by field, never a domain event or row spread onto the wire:
  no storage keys, no signed URLs, no tokens, no audit fields. Attachments
  are references with a summary; a link is asked for over HTTP.
- `eventId` is derived from the fact (`message.sent:<messageId>`), so a
  redelivered fact carries the same id.
- `message.read` carries only the watermark: `conversationId`, `userId`,
  `lastReadSequence`, `occurredAt`.
- `notification.created` carries the notification exactly as
  `GET /notifications` renders it (`eventId` = `notification.created:<id>`);
  `notification.read` carries `notificationId` and `readAt`;
  `notification.read_all` carries the boundary (`throughCreatedAt`,
  `throughId`) and `readAt`. No recipient id, no deduplication key
  ([notifications.md §11](notifications.md#11-realtime-delivery)).

**Error codes** (an `error` frame; never a stack trace, never an internal
message): `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_EVENT` (not JSON, binary,
unknown type or version), `INVALID_PAYLOAD` (a known frame with bad, missing
or extra fields), `CONVERSATION_NOT_FOUND`, `NOT_MEMBER` (reserved: V1
answers every non-member with `CONVERSATION_NOT_FOUND`), `RATE_LIMITED`
(with `retryAfterSeconds`), `SERVER_ERROR`.

**Close codes:** 1001 server going away · 1009 frame too big · 1011 failure ·
1013 too far behind · 4401 authenticate again · 4403 not permitted, do not
retry · 4429 too many connections/frames, back off.

## M6. The client's contract: order, duplicates, gaps, reconnect

The socket is a hint; the database is the truth. The Flutter client
(`app/lib/data/realtime/`, `features/messaging/state/`) and the backend
suites' TypeScript reference (`test/support/realtime-client.ts`) follow the
same rules:

1. **Order is the sequence.** Never arrival order, never a device clock.
2. **Duplicates change nothing.** A message already held (by id) — from a
   page, a send response or an earlier event — is merged, not appended. The
   client also drops a repeated `eventId`.
3. **Gaps are filled over HTTP.** The client keeps `syncedThrough`: every
   sequence up to it is held. A message beyond `syncedThrough + 1` is held,
   but does not move it: messages were missed, and the client pages
   `GET …/messages?after=<syncedThrough>` until the server has nothing
   newer. So 105 then 107 is never read as "106 does not exist".
4. **Reconnect** (states `connecting → connected`, then on a drop
   `reconnecting → reconnected`, backoff 1 s doubling to 30 s with jitter):
   re-authenticate; every open conversation `subscribe`s, and catches up
   over HTTP when the server's `lastSequence` is ahead of `syncedThrough`;
   the conversation list fetches its first page again. Nothing is rebuilt
   from the socket.
5. **Optimistic sends reconcile exactly once.** A pending message carries
   its `clientMessageId`; whichever arrives first — the HTTP response or the
   live `message.sent` with the same key — confirms it, and the other finds
   the message already held.
6. **Read marks only move forward**: an older watermark arriving late never
   lowers a newer one. The client marks read only up to `syncedThrough`, so
   a gap's missing message is not marked read before it is shown.
7. **Liveness**: the client pings every 25 s and treats 10 s of silence as a
   dead connection (a phone moving from Wi-Fi to cellular, a laptop waking
   up); it reconnects at once when the app returns to the foreground.
8. **Notifications are merged by id.** A `notification.created` already held
   changes nothing (the badge counts each id once); on every (re)connect the
   unread count, and the center's first page if it is open, are fetched again
   over HTTP. A notification that arrived while the socket was down is found
   there.

## M7. Multi-device, and the sender

One account, many connections: a phone, a tablet, a browser. Everything
sent to the account reaches each of them; a device that disconnects stops
receiving and the others carry on (tested with two sessions). The sending
device receives its own `message.sent` — with the `clientMessageId` that
confirms its pending copy — and the account's other devices learn about the
message the same way.

## M8. Limits — PROVISIONAL (open question Q26)

Development-safe defaults in `realtime/domain/realtime-policy.ts`, not a
measured production policy:

| Limit | Value | Why this number |
| --- | --- | --- |
| Time to authenticate | 10 s | ample on a slow mobile network |
| Connections per account | 10 | phone, tablet, a few tabs |
| New connections per account | 30 / min | stops a client stuck in a reconnect loop |
| Handshakes per client address | 300 / min | high on purpose: a school reconnecting after a blip shares one NAT address |
| Frames per connection | 60 / min | an honest client sends ~3 (pings) plus a few subscriptions |
| Frame size | 4 KiB | the largest honest frame, `auth`, is ~1 KiB |
| Heartbeat | 25 s ping, dead after one missed | below common proxy idle timeouts (30–60 s) |
| Revalidation | 60 s | the longest a revoked session or suspended account keeps receiving |
| Outbound backlog | 1 MiB | a client this far behind catches up more cheaply over HTTP |
| Connections per instance | 10,000 | capacity guard; measure before raising |

Rate limits use the platform's `RATE_LIMITER` port — per process today, so
N instances multiply them by N until the Redis limiter exists (as for HTTP).

## M9. When realtime fails

| Failure | Effect |
| --- | --- |
| The relay throws, a render fails, a socket errors | logged; the send already returned 201; the message is stored; the next event is delivered as usual (tested) |
| A client misses an event | the next event reveals the gap, or the next reconnect's `subscribe` does; HTTP fills it |
| The instance restarts | sockets close with 1001; clients reconnect with backoff and catch up |
| Identity unreachable during revalidation | connections stay open until their token expires (re-authenticating needs identity too) — then close |
| No one connected | the relay does not even query recipients |

Delivery is in-process and at-most-once per connection — ADR 0006's bus.
The durable path, when needed, is the outbox; the client contract (§M6)
already assumes at-least-once.

## M10. More than one instance

The `ConnectionManager` is per process, deliberately. With several API
instances, a client is connected to one of them, and every instance must see
every event: the change is **the event bus** — a broker behind the existing
`EventSubscriber` port (Redis pub/sub, NATS, or the outbox relay) fanning
each event out to all instances — while each instance keeps delivering to
its own connections. The realtime module does not change; there is no shared
connection table to keep consistent. Rate limits move to Redis at the same
time. Nothing of this is built: one instance serves the institution's
current scale, and "do not introduce Redis just because realtime exists".

## M11. Tested

Backend (`npm run verify`):

- `realtime/domain/protocol.spec.ts` — frames, strictness, refusing
  client-claimed identity;
- `realtime/application/connection-manager.spec.ts` — registration,
  multi-device, cleanup, dead and throwing connections;
- `realtime/application/realtime-sessions.spec.ts` — authentication
  (invalid, expired, revoked, suspended, no permission), deadline, expiry,
  re-authentication, revalidation, limits, malformed frames, subscriptions
  (member, stranger, owner, revoked);
- `realtime/application/messaging-relay.spec.ts` — fan-out, envelope,
  sender reconciliation, files as references, removal, history windows,
  ordering, duplicates, read marks, membership, persistence unaffected by
  failure;
- `realtime/infrastructure/*.spec.ts` — handshake rate limit, frames,
  backpressure, CLI context, client address;
- `test/api/realtime.api.spec.ts` — the running application over real
  sockets: origin, path, auth, 1009, malformed frames, delivery as the
  timeline shows it, multi-device, reconnect catch-up, a lost event,
  isolation (stranger, owner, removed member, signed-out session),
  heartbeat, shutdown;
- `test/integration/realtime-postgres.spec.ts` — the brief's scenario on
  PostgreSQL end to end; multi-device; a lost event filled from Postgres;
  nobody receives a conversation they are not in;
- `realtime/application/notification-relay.spec.ts` — the recipient only,
  the wire shape, the REALTIME preference, offline recipients, one read per
  page, read and read-all frames, malformed events;
- `test/integration/notifications-realtime.spec.ts` — a message sent to a
  connected recipient, a disconnected one, and one who reconnects, on
  PostgreSQL end to end;
- `test/architecture/realtime-boundaries.spec.ts` — the module boundaries
  (including: realtime reaches notifications through its contracts only).

Flutter (`flutter test`): frame parsing; the WebSocket client against a fake
server (auth frame, never a URL token; duplicates; subscribe; reconnect;
4401 renewal; 4403 stop; backoff; heartbeat; re-authentication); the
conversation and list state (dedupe, pending reconciliation, a lost event,
reconnect catch-up, monotonic read marks, removal); notification frames and
their state (live insertion once, cross-device reads, reconnect resync);
screens; the import boundaries.

## M12. Deliberately deferred

- **Push to devices that are not connected** — built behind a provider port
  with a logging adapter; the real provider is Q24
  ([notifications.md §12](notifications.md#12-push)).
- **Read receipts and "seen by"** (Q25); **typing indicators; presence.**
  They would ride the same connection, gated by the same `subscribe`.
- **Announcing membership changes to the other members** of a group —
  waits on Q22 (who may see who is in a conversation).
- **Several instances** (§M10) and a durable outbox.

---

# Part A — Live audio: the 2500-participant design

The requirement: **~2500 concurrent participants in one audio room.** One
teacher speaks. Students listen and cannot publish by default. "Raise Hand"
enters a queue. The teacher grants and revokes speaking permission.

The instruction that shaped this document:

> Do NOT assume that 2500 participants automatically works just because the UI
> displays 2500.

So this document is organized around what actually breaks at that scale, what
the design does about it, and — at the end, explicitly — **what has been proven
and what has not.**

> **Proposed change:** see [live.md](live.md) (design only,
> [ADR 0019](decisions/0019-community-scoped-live-sessions.md) Proposed).
> Live sessions would belong to a community instead of a halaqa, with
> Postgres as the record, a presenter slot for screen sharing, narrow RTC
> ports and a reconciler that brings LiveKit back in line with the record.
> A configured per-session cap, taken from load tests, would replace the
> 2500 target
> ([Q57](open-questions.md#q57--live-session-size-and-concurrency)). 30,000
> community members is not 30,000 live participants. Self-hosted LiveKit
> rooms are single-node (verified in LiveKit's server source), and the
> ~3,000-per-room figure LiveKit publishes is known only second-hand and
> must be benchmarked: LiveKit's documentation site could not be read from
> this environment. Until that lands, this part describes the design in
> force. The corrections below concern today's code;
> [live.md §1.2](live.md#12-corrections-to-realtimemd-part-a) lists every
> known inaccuracy in this part.

---

## 1. Why 2500 is a different problem from 25

A naive conference room is a mesh or a selective-forwarding unit where every
participant both publishes and subscribes. Cost grows roughly with the square of
the participant count. At 2500 this is not "slow"; it is impossible.

The saving property of this use case is its **asymmetry**: at any moment there
is one speaker, occasionally a handful. 2499 people are receive-only.

So the architecture's job is to make that asymmetry a hard, server-enforced
guarantee rather than a hopeful UI convention.

### Three failure modes, named

1. **Publish storm.** If listeners *can* publish, a client bug, a malicious
   user, or an over-eager "unmute" button turns 2500 listeners into 2500
   publishers. The SFU dies.
2. **Signalling storm.** 2500 participants joining at the start of a class,
   each triggering presence updates fanned out to everyone else, is O(n²)
   signalling traffic — often the first thing to fall over, before media does.
3. **Coordination state in the media path.** If "who raised their hand" lives in
   the SFU, every hand-raise becomes a media-plane event multiplied by 2500.

---

## 2. The design

### 2.1 Listeners receive tokens that cannot publish

This is the core of it. Capabilities are decided **server-side, at token
issue**, and are carried in the token itself:

```ts
export const LISTENER: RtcCapabilities = {
  canPublishAudio: false,   // ← the property the whole design rests on
  canSubscribe: true,
  canPublishData: true,
};

export const SPEAKER: RtcCapabilities = {
  canPublishAudio: true,
  canSubscribe: true,
  canPublishData: true,
};
```

A client never *asks* for permissions — it receives them. Even a fully
compromised client holding a listener token cannot publish audio, because the
SFU enforces the grant encoded in the token it was given. Failure mode 1 is
closed at the protocol level, not the UI level.

In the LiveKit adapter, even a speaker is restricted to a microphone:

```ts
canPublishSources: grant.capabilities.canPublishAudio ? [TrackSource.MICROPHONE] : []
```

No camera, no screen share, by construction.

This is asserted by a test that exists specifically to protect it:

> `join-live-session.spec.ts` → *"issues a listener token that cannot publish
> audio"* — and the comment above it reads *"The property the whole
> 2500-participant design rests on."*

Four further tests cover the rest of the token decision: the host gets a
publishing token; a participant holding a live grant gets publishing rights back
on reconnect (otherwise every network blip would silently demote a speaker); a
**revoked** grant does not; and nothing is minted at all for a session that is
not live, or for a caller without permission.

### 2.2 The raise-hand queue never touches the media server

`RequestSpeakerUseCase` deliberately does not call `RtcProvider` at all. A
raised hand is application state. It changes nothing on the wire until a host
decides it should.

This is what keeps failure mode 3 closed: 2500 people raising their hands is
2500 rows, not 2500 media-plane events fanned out to 2500 subscribers.

Promotion is the only thing that reaches the provider, and only for the one
participant being promoted.

**Who may promote is asked of identity, with the room in context.** Holding
`live.moderate` means "may moderate rooms you host", not "any room". The use
case asks identity twice: coarsely before loading anything, then with the
room's host in context. The Foundation version checked the permission without
the room, so any teacher could moderate any room. That was fixed in Identity &
Access V1 and is tested against the real authorization service.
Whether anyone other than the host may moderate is open (Q1).

The flow:

```
grant:  own state → provider.updateCapabilities(SPEAKER) → audit → event
revoke: own state → provider.updateCapabilities(LISTENER) → audit → event
```

Own state first, deliberately: if the provider call fails, the system's record
and the media plane disagree, and we would rather be *more* restrictive on
record than have a silent grant. Reconciliation of that divergence is
[open question Q5](open-questions.md).

> **Correction (2026-09-23):** for a grant it is the other way round. The
> grant is saved before the provider is called
> (`moderate-speaker.use-case.ts:98-99`). If `updateCapabilities` throws, the
> record says `granted` while the SFU still has a listener. No moderation
> log entry, audit entry or event is written, and the request fails. The
> next join then mints a speaker token, because it reads the saved grant
> (`join-live-session.use-case.ts:92-100`). That is a silent grant. Only a
> failed revoke leaves the record as the more restrictive side.

### 2.3 Concurrent speakers are capped

`MAX_CONCURRENT_SPEAKERS = 4`. The cap is an engineering safeguard, not an
institutional rule — four simultaneous publishers is comfortably within what an
SFU handles while keeping the room intelligible. The *right* number for this
institution is [open question Q4](open-questions.md); the constant is one line.

### 2.4 The queue is a state machine, not a set of booleans

```
pending  → granted | declined | withdrawn
granted  → revoked
revoked | declined | withdrawn  → (terminal)
```

Encoded as an explicit `ALLOWED_TRANSITIONS` table with `canTransition()` and
`transition()`, and unit-tested. `withdrawn` (the student lowers their own hand)
is kept distinct from `declined` (the host passes them over), because the
difference matters for reporting — *how often were hands ignored?* is a question
an institution will eventually ask, and it cannot be reconstructed later from a
merged state.

A user may hold only one open hand per session (`hasOpenRequest`).

Ordering is first-come-first-served (`pendingQueue`, oldest first) and is
intentionally not configurable. Any other ordering — by participation, by level,
by whoever spoke least — is an institutional policy we have not been given.

### 2.5 The secret never leaves the server

The LiveKit API key and secret are read only by `platform/config`, and used only
by `LiveKitRtcProvider`. The Flutter client receives a join token with a
**600-second TTL** and the connection URL, which also comes from server
configuration rather than from the client.

A leaked join token is worth one room, one identity, ten minutes, and — for a
listener — no ability to publish anything.

> **Correction (2026-09-23):** the token is still bound to one room and one
> identity, but the other two limits are wrong.
>
> - **Not ten minutes.** The 600-second TTL limits only the first
>   connection. LiveKit sends a connected participant a refreshed token at
>   join and then every 5 minutes. Each refreshed token is valid for at least
>   10 minutes and carries the participant's current grants, room included.
>   Removal does not revoke it:
>   the open-source server never reads `revoke_token_ts`, and the SDK itself
>   says "Even after being removed, the participant can still re-join the
>   room". Nothing in `live` calls `removeParticipant` today anyway. Sources:
>   the LiveKit server source, v1.13.7 (`github.com/livekit/livekit` at
>   `6b2e3ec`), `pkg/service/roommanager.go:61-64, 767-778, 1149-1181`, where
>   a search for `RevokeTokenTs` finds nothing; and the installed
>   `livekit-server-sdk` 2.19.1, `dist/RoomServiceClient.d.ts:131`.
>   LiveKit's documentation site could not be read from this environment.
> - **Listeners can publish data.** A listener token carries
>   `canPublishData: true` (`live/domain/rtc-provider.ts:18-22`;
>   `livekit-rtc-provider.ts:59`), so a listener can send data messages to
>   the whole room. It cannot publish audio.

---

## 3. What talks to what

```
Flutter client
     │  POST /live/sessions/:id/join        (institution auth)
     ▼
LiveController ──► JoinLiveSessionUseCase
                        │  1. authorize via identity contracts
                        │  2. session must be live
                        │  3. host? existing grant? → SPEAKER, else LISTENER
                        ▼
                   RtcProvider (port)
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
  LiveKitRtcProvider            FakeRtcProvider
  (the only file that           (tests, and local dev
   imports livekit-server-sdk)   without credentials)
          │
          ▼
     LiveKit SFU ◄──── media ────► Flutter client
```

The client talks to our API for *permission* and to the SFU for *media*. It
never talks to the SFU about permission.

> **Correction (2026-09-23):** the diagram's "local dev without credentials"
> holds only when `LIVEKIT_API_SECRET` is unset or equals
> `development-only-secret` (`live.module.ts:47-49`; the default is at
> `platform/config/app-config.ts:194`). Any other value selects
> `LiveKitRtcProvider`. That includes the placeholder `change-me` in
> `backend/.env.example:48`, which the backend's setup copies
> (`backend/README.md:16`). With it, local development runs the real
> adapter against `wss://livekit.example.com` (`backend/.env.example:46`). The
> comment at `live.module.ts:44-46` says the choice is obvious in logs, but
> no log line reports it.

---

## 4. Persistence plan (not yet implemented)

Current repositories are in-memory. They implement the ports the real ones will:

| Data | Where it will live | Why |
| --- | --- | --- |
| `LiveRoom`, `LiveSession` | Postgres | Permanent business truth; attendance and reporting derive from it |
| `SpeakerRequest` queue | Redis, projected to Postgres on decision | Ephemeral, high-churn, read constantly during a session |
| Presence / participant counts | Redis, TTL'd | Ephemeral by definition |
| `ModerationAction` | Postgres + audit log | Must survive; someone will ask who muted whom |

Redis holds the live queue; Postgres holds what happened. No permanent business
truth lives only in Redis.

> **Correction (2026-09-23):** that sentence describes the plan, not today.
> Nothing of live is persisted. The four repositories are in memory, created
> empty at boot and lost on restart (`live.module.ts:51-57`). There is no
> live table, migration, Postgres adapter or Redis adapter. Nothing creates
> a room or a session either. So in the running application every join and
> raise-hand returns `404 live.session_not_found`, and the use cases run
> only in unit tests that seed the in-memory repositories. The one durable
> trace is the audit entry for a grant or revoke, and only when a database
> is configured (`platform/platform.module.ts:43-48`).

---

## 5. What is proven and what is not

**Proven** (implemented and covered by tests that run in CI):

- A listener's token cannot publish audio.
- A host's token can.
- A live grant survives reconnect; a revoked one does not.
- No token is minted for a non-live session, or for an unauthorized caller.
- The speaker-request state machine rejects every transition outside the table.
- The concurrent-speaker cap is enforced before a grant is issued.
- Moderation is scoped to the room: a teacher cannot moderate a room they do
  not host.
- Moderation writes the institution's audit trail (`live.speaker.granted` /
  `revoked`) and raises a domain event.
- A host publishes only while also holding `live.speak`.
- Nothing outside `livekit-rtc-provider.ts` imports LiveKit.

> **Correction (2026-09-23):** the last item is true today by search: only
> `live/infrastructure/livekit-rtc-provider.ts:2` imports
> `livekit-server-sdk`. But no test or rule proves it for the repository.
> `domain-is-dependency-free` covers `domain/` only.
> `application-has-no-vendor-sdks` never fires: its target pattern is
> anchored at the package name, while dependency-cruiser matches resolved
> paths such as `node_modules/livekit-server-sdk/dist/index.js`
> (`backend/.dependency-cruiser.cjs:88`). No rule confines LiveKit the way
> `websocket-library-only-in-the-realtime-adapter` confines `ws` (`:91-103`).
> Three module-specific specs forbid it: messaging's for the whole module,
> and notifications' and academic's for their domain and application layers.
> The fix is Phase 0 of the proposed design
> ([communities-live-attendance.md §25.1](communities-live-attendance.md#251-phase-0-corrections)).
> The token items above are proven against `FakeRtcProvider` only. They
> check the capability decision, not the LiveKit grant, and no spec covers
> `livekit-rtc-provider.ts`.

**Not proven — no load test has been run:**

- That the chosen LiveKit deployment holds 2500 subscribers in one room.
- Join-storm behaviour when a class of 2500 connects within a few seconds.
- Signalling fan-out cost at that participant count (failure mode 2 above is
  *understood*, and is addressed by keeping the queue off the media plane, but
  it has not been *measured*).
- Client-side performance on a low-end Android device subscribed to a room with
  2500 participants in its roster.

**This is the honest state:** the architecture is arranged so that these can be
measured before production, and so that a bad result changes an adapter rather
than the system. Nothing here should be read as a claim that 2500 works today.

### The load test this design is built to permit

1. Point `FakeRtcProvider` at a synthetic client harness; confirm the
   application layer issues 2500 correct listener grants without degradation.
   This isolates *our* code from the SFU's.
2. Run real LiveKit with 2500 headless subscriber clients, one publisher.
   Measure SFU CPU, bandwidth, and join latency at the 50th/95th/99th
   percentile.
3. Join storm: all 2500 within 10 seconds. Measure signalling, not just media.
4. Promotion under load: grant and revoke while 2500 are subscribed. Measure how
   long a promotion takes to take effect.
5. Repeat with participant-list updates disabled on the client, to isolate
   roster fan-out cost.

Step 1 is possible today. Steps 2–5 need an environment and credentials.

---

## 6. Deliberately deferred

- The 2500-user room **UI** — explicitly out of scope for this milestone.
- Recording, transcription, breakout rooms.
- Region/edge selection and SFU autoscaling policy.
- Reconciliation between our permission record and the provider's (Q5).
- Automatic room lifecycle from the schedule — `live` raises the events;
  `automation` will consume them.

> **Correction (2026-09-23):** `live` does not raise the session events
> today. `liveSessionStarted` and `liveSessionEnded` exist
> (`live/domain/events.ts:34-50`) but have no caller, because no use case
> starts or ends a session. Only `live.speaker.requested`, `.granted` and
> `.revoked` are published.
