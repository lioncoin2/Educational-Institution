# Realtime

Two unrelated things are "realtime" in this system, and they share nothing
but the word:

- **[Part M — messaging in real time](#part-m--messaging-in-real-time):** a
  new message, read mark or membership change — and a new notification —
  reaches the people entitled to it while they are connected. A WebSocket
  from the API. Implemented (Realtime Messaging V1,
  [ADR 0012](decisions/0012-realtime-messaging-transport.md); notifications
  ride the same connection since Notifications V1,
  [ADR 0013](decisions/0013-notifications-v1.md)). Since P5 a community's
  lock and unlock, and a person's own addition, removal and access change,
  ride it too, as ids-only hints
  (**[Part C](#part-c--communities-in-real-time)**).
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
| imports no socket library, no realtime code (architecture tests) | reads messaging, identity, notifications and Communities through their contracts only |

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
   its notifications over HTTP. Community frames ([Part C](#part-c--communities-in-real-time))
   pass the same gate: every role holding `communities.read` or `live.join`
   also holds `messaging.read`, pinned by `identity/domain/role.spec.ts`
   ([Q66](open-questions.md#q66--realtime-without-messagingread)).)
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
Since P5 (gate G1) the relay asks `MESSAGE_RECIPIENTS` only about the
accounts connected to this instance ([§C5](#c5-onlineaudience-fan-out-bounded-by-who-is-connected-gate-g1)):
the same people, in at most 1 + ⌈A/1000⌉ calls for A accounts connected
here, instead of every page.

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
  multi-device, cleanup, dead and throwing connections, the snapshot of
  accounts online;
- `realtime/application/realtime-sessions.spec.ts` — authentication
  (invalid, expired, revoked, suspended, no permission), deadline, expiry,
  re-authentication, revalidation, limits, malformed frames, subscriptions
  (member, stranger, owner, revoked), and no subscription to a community
  ([§C4](#c4-no-community-subscription-account-addressed-push));
- `realtime/application/messaging-relay.spec.ts` — fan-out, envelope,
  sender reconciliation, files as references, removal, history windows,
  ordering, duplicates, read marks, membership, persistence unaffected by
  failure (unmodified by P5);
- `realtime/application/online-audience.spec.ts` and
  `messaging-relay-audience.spec.ts` — gate G1
  ([§C5](#c5-onlineaudience-fan-out-bounded-by-who-is-connected-gate-g1));
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
  (including: realtime reaches notifications and Communities through their
  contracts only);
- the community suites of [§C8](#c8-tested).

Flutter (`flutter test`): frame parsing; the WebSocket client against a fake
server (auth frame, never a URL token; duplicates; subscribe; reconnect;
4401 renewal; 4403 stop; backoff; heartbeat; re-authentication); the
conversation and list state (dedupe, pending reconciliation, a lost event,
reconnect catch-up, monotonic read marks, removal); notification frames and
their state (live insertion once, cross-device reads, reconnect resync);
community frames and state ([§C8](#c8-tested)); screens; the import
boundaries.

## M12. Deliberately deferred

- **Push to devices that are not connected** — built behind a provider port
  with a logging adapter; the real provider is Q24
  ([notifications.md §12](notifications.md#12-push)).
- **Read receipts and "seen by"** (Q25); **typing indicators; presence.**
  They would ride the same connection, gated by the same `subscribe`.
- **Announcing membership changes to the other members** of a group —
  waits on Q22 (who may see who is in a conversation). Likewise for a
  community (Q22, Q49): its frames tell only the person concerned
  ([§C2](#c2-who-receives-what-and-what-it-costs)).
- **Several instances** (§M10) and a durable outbox.

---

# Part C — Communities in real time

**Landed in P5 (2026-09-24).** Communities' facts reach the people they
concern while they are connected: on the same connection, through the same
`ConnectionManager`, as hints the app answers by reading the community again
over HTTP. The design is the hub's
[§15.6](communities-live-attendance.md#156-realtime) and
[§16](communities-live-attendance.md#16-realtime-transport-matrix), and
[ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md) decisions
6–9. This part records what was built, the choices made while building it,
and the evidence. Nothing here adds a table, a migration, a domain event, a
notification type, a client frame or a protocol version.

## C1. The pipeline

```
  HTTP act ──▶ Communities use case ──▶ communities tables (PostgreSQL)   ◀── the truth
                     │ after the commit: audit, then event (CommunitiesJournal)
                     ▼
   communities.member.added / .removed · .capability.granted / .revoked ·
   .ownership.transferred · .community.locked / .unlocked      (ids and versions only)
                     │ EventSubscriber port — the request has already returned
                     ▼
   realtime ─ CommunitiesRealtimeRelay      per community, in publication order
                 │ who?  COMMUNITY_MEMBERSHIP   the person's latest stint (statesOf), or
                 │                              heads, then the ACTIVE members connected
                 │                              here (members, through onlineAudience)
                 │ may they view it?  ACCOUNT_DIRECTORY.withPermission,
                 │                    for every permission of COMMUNITY_VIEW_CEILING
                 ▼
             ConnectionManager               the same connections, the same socket
                 ▼
   Flutter: CommunityListController / CommunityController / CommunityMembersController,
            ConversationController / ConversationListController  ──▶  re-read over HTTP
```

| Communities | Realtime |
| --- | --- |
| decides membership, lifecycle and what a person may do; publishes after the commit | decides nothing about communities: it asks, at delivery time, and forwards ids |
| imports nothing of realtime (`communities-boundaries.spec.ts`) | reaches only `communities/contracts`, and `communities.module.ts` for wiring (`realtime-boundaries.spec.ts:138-175`) |

`RealtimeModule` imports `CommunitiesModule` (`realtime.module.ts:43`), which
imports only `IdentityModule`, so no cycle can close. The relay uses
`COMMUNITY_MEMBERSHIP` (`statesOf`, `heads`, `members`), the constant
`COMMUNITY_VIEW_CEILING`, the `CommunityEvents` names and payload types, and
identity's `ACCOUNT_DIRECTORY.withPermission`. It stores nothing. When it is
down, Communities is unaffected and every client still converges over HTTP.

`communities.community.created` and the invitation events are not subscribed
to: the creator has the HTTP response and hears of their own membership
through the `member.added` that always follows; a link is never on any wire.

## C2. Who receives what, and what it costs

`CommunitiesRealtimeRelay` (`realtime/application/communities-relay.ts`).
`A` is the number of distinct accounts connected to this instance
(A ≤ 10,000, `realtime-policy.ts:42`); `N` is the number of the community's
ACTIVE members among them.

| Event | Frame | Delivered to, as Communities answers at delivery time | Contract calls on this instance |
| --- | --- | --- | --- |
| `communities.member.added` | `community.member.added` | the person added, only while the stint the event names (`membershipId`) is their latest and ACTIVE (`communities-relay.ts:145-166`) | 0 if they are not connected here; otherwise one `statesOf` and at most one `withPermission` |
| `communities.member.removed` | `community.member.removed`, `reason` `left` or `removed` (the event's `LEFT` or `REMOVED`) | the person who left or was removed, only while their latest stint is not ACTIVE, so a rejoin overtakes it (`:167-189`). Nobody else is told (PROVISIONAL, [Q22](open-questions.md#q22--who-may-see-who-is-in-a-conversation), [Q49](open-questions.md#q49--leaving-removal-and-rejoining)) | as above |
| `communities.capability.granted` / `.revoked` | `community.access.changed` | the holder, while an ACTIVE member (`:190-198`, `:219-232`). Nothing is announced to the others ([Q45](open-questions.md#q45--capability-grants-duration-handover-and-visibility)) | as above |
| `communities.ownership.transferred` | `community.access.changed`, one per person | the previous owner and the new one, each while an ACTIVE member (`:199-208`) | 0 if neither is connected here; otherwise one `statesOf` for both and at most one `withPermission` |
| `communities.community.locked` / `.unlocked` | `community.locked` / `community.unlocked` | the community's ACTIVE members connected here; nobody if Communities no longer knows the community or a newer lock or unlock has committed (its head's `lifecycleVersion` is above the event's) (`:234-265`) | one `heads`; then `members` through `onlineAudience`: 1 call if the community fits one page of 1,000, otherwise at most 1 + ⌈A/1000⌉; then ⌈N/1000⌉ `withPermission`. A stale event stops after `heads`. At most 22 calls at A = 10,000, whatever the community's size |
| `communities.community.created`, `communities.invitation.*` | — | nobody | — |

**Every audience is asked of Communities when the frame is built**, never
taken from the event alone, from a client, from messaging's projection, or
from anything realtime keeps (`concerned`, `communities-relay.ts:272-283`).
An event published out of order, or overtaken by a later change, reaches
nobody it no longer concerns: a stale `added` after a removal, a `removed`
after a rejoin, a lock after the unlock that followed it. A removed member
hears of the removal and then nothing more about the community, unless
they join again.

**Every audience is narrowed by the view ceiling.**
`COMMUNITY_VIEW_CEILING` (`communities/contracts/capabilities.ts:62-64`,
today `[communities.read]`) is the standing ceiling that `community.view`'s
act rule asks of a person on HTTP (`act-rules.ts:69`; `act-rules.spec.ts:39-44`
pins the two together). Recipients are kept only if their
ACTIVE account holds every permission of it, asked of identity in chunks of
`ACCOUNT_DIRECTORY_MAX_IDS` = 1,000 (`viewers`, `communities-relay.ts:289-302`).
So a member whose role lost it, or whose account was suspended, is refused
on HTTP and told nothing in the background either. It is published by
Communities, as `COMMUNITY_CHAT_READ_CEILING` was for the chat in P4, so the
two paths cannot drift.

**Lock frames go to members, not to the `community.view` permit.** An
overseer holding `communities.manage` without a stint receives no community
frame and sees a lock over HTTP.

**How this differs from the approved matrix.** The hub listed the per-person
frames at 0 queries, addressed from the event payload
([§16.1](communities-live-attendance.md#161-where-every-event-and-state-change-travels)).
P5 re-asks Communities for the person's latest stint and narrows every
audience by the view ceiling. Both only remove recipients, never add one.
The price is one `statesOf` and one `withPermission` for an event whose
person is connected here, and for a lock one `heads` and ⌈N/1000⌉
`withPermission` beyond the member pages.

The rest follows `messaging-relay.ts`:

- `schedule` returns at once, and asks nothing, when nobody is connected to
  this instance (`communities-relay.ts:119-121`); otherwise delivery is
  chained per community (the event's `aggregateId`) and detached from the
  publisher.
- Payloads cross a module boundary, so their shape is checked, not assumed:
  the payload's `communityId` must equal the event's `aggregateId`; ids are
  non-empty strings; versions are non-negative safe integers; a removal's
  reason is `LEFT` or `REMOVED`. Anything else is logged as `ignoring a
  malformed community event` and sends nothing (`:309-379`).
- A lock frame is serialized once for all its recipients. A per-person frame
  is serialized per recipient, because its `eventId` names them.
- Every connection of a recipient's account receives it; a dead device never
  stops the others.
- A failure is logged as `realtime delivery failed` with the event name and
  community id only, and the next event is delivered as usual.

## C3. The frames: protocol v1, additive

Every frame is `{type, eventId, occurredAt, …, version: 1}`, built field by
field in `envelopes.ts:286-411` from the event's ids and versions, never by
spreading a payload. No frame carries a title, a name, a count, a
capability, a grant or invitation id, a roster, or how or by whom someone
joined.

| Frame | Fields | `eventId` | Builder |
| --- | --- | --- | --- |
| `community.member.added` | `communityId`, `userId` | `community.member.added:<communityId>:<userId>:<membershipVersion>` | `envelopes.ts:299-312` |
| `community.member.removed` | `communityId`, `userId`, `reason: 'left' \| 'removed'` | `community.member.removed:<communityId>:<userId>:<membershipVersion>` | `:315-330` |
| `community.locked` | `communityId`, `lifecycleVersion` | `community.locked:<communityId>:<lifecycleVersion>` | `:337-349` |
| `community.unlocked` | `communityId`, `lifecycleVersion` | `community.unlocked:<communityId>:<lifecycleVersion>` | `:351-363` |
| `community.access.changed` | `communityId` | `community.access.changed:<communityId>:<recipientUserId>:<digest>` | `:383-399` |

- **The same fact always has the same id**, so a redelivery is a duplicate
  the client drops (§M6 rule 2).
- **`membershipVersion` is in the id only**, never a field: stable across
  redelivery, but not a version the client could compare with anything HTTP
  returns.
- **`lifecycleVersion` is a field** because `GET /communities/:id` returns
  it: the client drops a lock frame not newer than the version it holds.
- **The `community.access.changed` id ends in a digest of the fact**: the
  first 20 hex characters of SHA-256 over `granted:<grantId>`,
  `revoked:<grantId>` or `transferred:<side>:<occurredAt ms>`, `<side>` being `from` or `to`
  (`envelopes.ts:371-373`, `:392-395`, `digest` at `:409-411`). The P5 plan
  ended the id in `<occurredAt ms>` (the hub's "derived from community,
  user and time", [§16.2](communities-live-attendance.md#162-frames-added-to-protocol-v1)).
  That gives two changes of one person's access within one millisecond the
  same id: the client would drop the second as a duplicate, and the re-read
  it should have caused would never happen. The digest names the fact
  without putting the grant id or the capability on the wire. A transfer is
  named by which side of it the recipient is on and when, never by the
  other party: a digest is one-way only for what its reader cannot guess,
  and a former owner who may no longer read who owns the community could
  otherwise hash each member id they once saw until one matched (found by
  the P5 adversarial review; `communities-relay.spec.ts`, "never by the
  other party", gives the former owner the same id whoever the new owner
  is). The recipient is in the id because a transfer tells two people,
  each with their own frame (`envelopes.spec.ts:96-143`).

**Golden fixtures.** `backend/test/fixtures/realtime-frames/` holds one JSON
file per frame (two for `community.member.removed`, `left` and `removed`)
and a README. `envelopes.spec.ts` requires a builder case for every fixture
and a fixture for every case, compares each byte for byte (the same keys in
the same order), and allows no other keys. The app's
`test/realtime/community_frames_test.dart` parses every one of the same
files. A field changed on one side fails the other side's suite.

**The protocol version stays 1.** Installed apps drop a frame whose version
is not 1 (`realtime_frames.dart:56`) and ignore unknown types (`:79`), so the
five frames are additive: an old app works from HTTP, and the new app
ignores nothing it needs.

## C4. No community subscription: account-addressed push

A client never names a community to realtime. Community frames are pushed to
the accounts the relay has just checked, through `ConnectionManager`; no
interest set is kept per connection.

- **No client frame is added.** The strict parser refuses a `subscribe`
  carrying `communityId` or `topic` as `INVALID_PAYLOAD`, and knows no
  `community.subscribe` or `watch` type (`INVALID_EVENT`)
  (`protocol.spec.ts:66-90`).
- **`subscribe` stays conversation-only.** A community's id given as
  `conversationId` is answered exactly like a missing conversation,
  `CONVERSATION_NOT_FOUND`; so is a non-member subscribing to a community
  chat's real id; and a member Communities has removed while messaging's
  projection still lists them is refused and receives no frame
  (`realtime-sessions.spec.ts:411-500`). A community chat is subscribed to as
  the conversation it is, through messaging's own "open this conversation"
  decision, which asks Communities (§M4;
  [community-chat.md §12.5](community-chat.md#125-realtime)).
- **Why.** ADR 0021 rejected a `subscribe{topic}` or `watch` frame: server
  state that must follow every membership change, multi-instance semantics
  and a wider parser, for audiences that account addressing already serves.
  It stays a possible future extension, negotiated through `ready.features`.

## C5. `onlineAudience`: fan-out bounded by who is connected (gate G1)

`onlineAudience(online, pageOf)` (`realtime/application/online-audience.ts:59-85`)
is the one audience algorithm the relays share; each relay keeps its own
payload validation (ADR 0021's rejected "one generic relay").

- Nobody online: no call at all.
- Page 1 (`cursor: null`, `limit: 1000`). If it has no next page, its
  members, each kept if `isOnline`: the accounts online are never listed,
  so a direct message costs its page, not the instance's 10,000 accounts
  (found by the P5 adversarial review; `messaging-relay-audience.spec.ts`,
  "never lists who is online").
- Otherwise the accounts online, in chunks of `AUDIENCE_PAGE` = 1,000, each
  asked with `onlyUserIds` (following a cursor if a source ever pages
  shorter): at most 1 + ⌈A/1000⌉ calls, whether the audience is 2,000 or
  100,000.
- `AUDIENCE_PAGE` equals messaging's `MAX_RECIPIENT_PAGE` and Communities'
  `MAX_MEMBER_PAGE` (`online-audience.spec.ts:50-54`), so one page is one
  call on either side.
- The source stays the only judge: every id returned came from it, asked at
  delivery time; nothing is cached or widened. Results are de-duplicated.
- `online` is the connection registry itself, asked rather than copied
  (`OnlineAccounts`: `accountCount`, `isOnline`, `onlineUserIds`;
  `ConnectionManager` is one, `connection-manager.ts:57-74`).
  `onlineUserIds()` is every account with a connection here, each once: a
  snapshot, unaffected by connections that open or close afterwards, and
  asked for only when the audience spans more than one page.

**G1.** `MessagingRealtimeRelay.onlineMembers` (`messaging-relay.ts:209-219`)
now resolves `conversation.created` and `message.sent` through
`onlineAudience`, passing `visibleSequence` through. `MESSAGE_RECIPIENTS`
did not change: it already took `onlyUserIds`. A community chat's pages keep
every check of [ADR 0022](decisions/0022-community-chat-delivery-check.md)
(one `statesOf` per non-empty page, the read ceiling), now per chunk. A
message in a 30,000-member channel went from 30 recipient calls per instance
to at most 1 + ⌈A/1000⌉ (≤ 11 at A = 10,000). The existing
`messaging-relay.spec.ts` and `community-chat-relay.spec.ts` pass unmodified.
G1 alone does not reopen posting above 250 members: the switch waits for G3
and G4 ([community-chat.md §11.2](community-chat.md#112-gates-g1g4)).

## C6. The client's contract for community frames

§M6 applies: duplicates dropped by `eventId`, reconnect with backoff, HTTP is
the truth. In the app (`app/lib/features/communities/state/`,
`app/lib/features/messaging/state/`):

- **A frame is a reason to read again, never an answer.** What a person may
  do is the server's `me` block, never worked out on the device. The one
  thing shown before HTTP confirms it is the viewer's own removal, and a
  re-read that finds the community still theirs restores it.
- **`CommunityController`** (one community): a lock or unlock newer than the
  `lifecycleVersion` held → one re-read of `GET /communities/:id`; an older or
  repeated one → nothing; `access.changed` → a re-read; the viewer's
  `member.removed` → shown as removed at once, then a re-read (404 keeps it
  removed); the viewer's `member.added` → a re-read. A 404 is the removed
  state, not an error.
- **`CommunityListController`**: the viewer added → the first page again; the
  viewer removed → the community leaves the list at once, then the first
  page again; a newer lock or unlock, or `access.changed` → that community
  again (gone: it leaves the list).
- **`CommunityMembersController`**: pages of 50, never walked to the end on
  its own; `access.changed` or the viewer's `member.*` for this community →
  the first page again, which also answers whether the roster is still
  theirs (403 → "not yours to see").
- **Messaging's controllers**, for a community chat: the viewer's removal →
  the conversation subscribes and catches up again, and the server's
  `CONVERSATION_NOT_FOUND` marks it removed, never the frame alone; a lock,
  an unlock or `access.changed` → the conversation is read again (`canPost`).
  The list drops that community's chat when the viewer is removed and reads
  its first page again when they are added or removed.
- **Whenever the connection comes up** (connected or reconnected), each open
  community view reads again over HTTP: a frame missed meanwhile is in the
  answer.
- **One read at a time**, and a read asked for meanwhile runs once more after
  it, so the last answer shown was asked for after the last frame.
- **Only the account id is compared** with a frame's `userId`
  (`community_viewer.dart`), never roles or permissions
  (`community_boundaries_test.dart`).

## C7. When it fails

| Failure | Effect |
| --- | --- |
| A contract call throws | logged with ids only; nothing is sent for that event; the community's next event is delivered as usual (tested) |
| A frame is missed (the app was disconnected, the instance restarted, or a second instance served the change before P11) | the next lock frame, or the re-read when the connection comes up, converges: `GET /communities/:id` shows the status and a newer `lifecycleVersion` (API test) |
| An event overtaken by a later change | dropped at delivery (§C2) |
| A frame serialized before a removal commits | can still arrive; it grants nothing, because every HTTP read and command re-authorizes ([hub §19.3](communities-live-attendance.md#193-other-threats)) |
| Nobody connected to the instance | nothing is scheduled and nothing is asked |

## C8. Tested

Backend (`npm run verify`):

- `realtime/application/communities-relay.spec.ts` — the real Communities use
  cases and journal (`test/support/communities-harness.ts`) on an in-process
  bus, a real `ConnectionManager` with fake links: (A) a member hears of
  their own addition, a lock, an unlock and their own access change, on every
  device, and a creator hears of their own new community as an addition;
  (B) a removed member hears of the removal and nothing after it;
  (C, D) a non-member, and an overseer without a stint, hear nothing whatever
  ids they know; (E) messaging's projection is never read; (F) out-of-order
  and overtaken events deliver nothing stale; (G) access frames reach the
  grantee alone with the community's id only, a delegate hears nothing of
  others joining or leaving, and a transfer tells both sides; (H) lock frames
  carry the version only; (J) an event relayed twice gives byte-identical
  frames. Also: the view-ceiling narrowing, no call for a person who is not
  connected or when nobody is, the call counts of §C2, malformed payloads,
  per-community order, failure isolation, unsubscribing on shutdown.
- `envelopes.spec.ts` — the golden fixtures, byte for byte; the allowed keys;
  distinct access ids within one millisecond.
- `online-audience.spec.ts` — the page size pinned to both sources; no call
  when nobody is online; one call for one page; 50 of 30,000 in at most 2
  calls; at most 1,000 names per call; members ∩ online within
  1 + ⌈A/1000⌉ calls for 120 seeded audiences (0–30,000 members, 0–10,000
  online).
- `messaging-relay-audience.spec.ts` — G1: 50 and 2,500 people online among
  30,000 recipients reached in at most 2 and 4 calls instead of the old
  walk's 27 pages (every tenth recipient is outside the message's history
  window); one call for a conversation that fits a page; for 40 seeded
  channels, exactly the old walk's recipients within the bound.
- `connection-manager.spec.ts`, `domain/protocol.spec.ts`,
  `realtime-sessions.spec.ts` — `onlineUserIds`, and §C4.
- `communities/domain/act-rules.spec.ts` — `COMMUNITY_VIEW_CEILING` is
  `community.view`'s standing ceiling.
- `test/api/communities-realtime.api.spec.ts` — the running application over
  real sockets: addition, lock and unlock reach a member and nothing reaches a
  stranger; the grantee alone; a removed member is told once, then nothing,
  and after reconnecting HTTP agrees (`GET /communities` leaves it out,
  `GET /communities/:id` and the chat lookup answer 404); a lock missed while
  disconnected is recovered from `GET /communities/:id`; a fact delivered
  twice has the same `eventId`, byte for byte.
- `test/integration/communities-realtime-postgres.spec.ts` — the same on
  PostgreSQL: added, locked, missed and caught up, removed, isolated; a
  transfer and a grant.
- `test/integration/communities-realtime-scale.spec.ts` — a community of
  30,000 ACTIVE members and 100,000 departed stints, beside a second
  30,000-member community sharing half its members and 2,000 small ones
  (166,030 stints). With 50 and 2,500 accounts online (members, leavers and
  strangers) a lock reaches exactly the online ACTIVE members, with one
  `heads`, at most 1 + ⌈A/1000⌉ member pages, no `statesOf` and ⌈N/1000⌉
  `withPermission`; a 30-member community takes one member call. Every
  statement sent is EXPLAINed: `community_members` is read through a
  `community_members_*` index, never a Seq Scan, and no statement has an
  OFFSET. Each is also run under EXPLAIN ANALYZE, and no `community_members`
  node reads more than 1,001 rows, kept or filtered out: a member read is
  bounded by its page, not by the community (an index name alone could not
  tell a bounded probe from an index walk of all 30,000; the P5 adversarial
  review found the gap, and a non-sargable filter now fails the suite at
  30,000 rows read). Identity's side of the narrowing: a 1,000-account page is three
  statements (`users`, `user_identifiers`, `user_roles`), each bound to the
  page's 1,000 ids and joining nothing; with sequential scans disabled, each
  is served by its index (`users_pkey`, `user_identifiers_user_id_idx`,
  `user_roles_user_id_role_pk`). At the fixture's 60,000 accounts Postgres
  prefers a sequential pass of the 5 MB `user_roles` heap to 1,000 probes by
  cost; the suite's comment records that it turned to the primary key between
  120,000 and 260,000 rows when measured. That choice is not asserted.
- `test/integration/community-chat-scale.spec.ts` — G1 on PostgreSQL: a
  message in the 30,000-member community chat with 50 and 2,500 accounts
  online takes at most 2 and 4 recipient calls, every one with the message's
  `visibleSequence`, instead of the old walk's 30 pages, and reaches exactly
  whom the old walk reached.
- `test/architecture/realtime-boundaries.spec.ts` — realtime reaches
  Communities only through `contracts/` and wires it only through
  `communities.module.ts`; reaches nothing of its domain, application,
  infrastructure or API; and is found using `membership.ts`, `events.ts` and
  `capabilities.ts`, so the check is not vacuous.

Flutter (`flutter test`):

- `test/realtime/community_frames_test.dart` — every golden fixture parsed
  into its `CommunityEvent`; version ≠ 1, a missing field or a wrong type
  dropped; extra fields ignored; an unknown removal reason read as
  `unknown`.
- `test/communities/` — models (unknown values dropped, so they open no
  action), the HTTP repository against a `MockClient` (404, 403, sign-in,
  network, unreadable), the mock repository (a 30,000-member roster paged by
  cursor without being built), the controllers (duplicates, out-of-order
  lifecycle versions, a frame missed while offline, removal, HTTP overruling
  a frame), messaging's controllers and community frames, the screens,
  right-to-left layout, opening the chat, and `community_boundaries_test.dart`
  (community screens, widgets and state import no HTTP client, socket, API
  client or repository implementation, and read no permissions or roles; only
  `app_providers.dart` constructs a `CommunityRepository`; the wire models are
  plain Dart; the HTTP repository only reads).
- `test/layout_test.dart` and `test/navigation_test.dart` — the three
  community routes at every viewport; Profile → communities → a community →
  its chat.

## C9. Deliberately deferred

- **Announcing membership or access changes to other members** (Q22, Q45,
  Q49). The PROVISIONAL defaults tell only the person concerned.
  `memberCount` is not pushed; others see it on their next read.
- **Notifications about community facts** (Q67, Q28; P10).
- **In the app: the `/invite#<token>` link and every management action**
  (adding and removing members, leaving, creating and revoking invitations,
  joining by token, locking and unlocking, grants and their revocation,
  ownership transfer). P5's `CommunityRepository` only reads. They are
  deferred, to be scheduled
  ([hub §25](communities-live-attendance.md#25-implementation-phases)).
- **A frame for a change no event names**: a grant going dormant, or a role
  change that alters `me`. The next HTTP read shows it; a member who lost the
  view ceiling hears nothing more from the relay.
- **Live frames** (`live.session.*`, P7), **load profile 4** (P8), and
  **several instances** (§M10, P11).

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

> **Proposed change:** see [live.md](live.md) (the P6 design,
> [ADR 0019](decisions/0019-community-scoped-live-sessions.md) Accepted).
> Live sessions would belong to a community instead of a halaqa, with
> Postgres as the record, a presenter slot for screen sharing and a
> reconciler that brings LiveKit back in line with the record. The narrow
> RTC ports have landed, with the rest of P1's hardening of today's
> halaqa-bound module ([live.md](live.md), the P1 note above §1).
> A configured per-session cap, taken from load tests, would replace the
> 2500 target
> ([Q57](open-questions.md#q57--live-session-size-and-concurrency)). 30,000
> community members is not 30,000 live participants. Self-hosted LiveKit
> rooms are single-node (verified in LiveKit's server source), and the
> ~3,000-per-room figure LiveKit publishes is known only second-hand and
> must be benchmarked: LiveKit's documentation site could not be read from
> this environment. Until that lands, this part describes the design in
> force. The corrections below concern the code at `9670c47`, before P1;
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

> **Resolved in P1 (2026-09-23):** moderation now reports the media outcome
> (`applied`, `not_connected`, `pending`) instead of failing after saving,
> and every change is re-applied until the media plane agrees
> (`CapabilityConvergence`, [live.md](live.md#1-what-exists-today)). The note
> below records the defect.
>
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

> **Resolved in P1 (2026-09-23):** the join token lives **120 seconds**,
> listeners no longer carry the data channel, and the name in the token
> comes from the account directory. What 120 s means for reconnection —
> LiveKit's own refresh keeps connected clients connected — and the
> convergence watch that corrects a returning participant are in
> [live.md](live.md#1-what-exists-today) (the P1 note). The note below
> records what was wrong before.
>
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
>   `canPublishData: true` (`live/domain/rtc-provider.ts:19-23`;
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
> `platform/config/app-config.ts:194`). Nothing in the backend loads `.env`
> (no dotenv, `ConfigModule` or `--env-file`; `start:dev` is `ts-node-dev`
> on `src/main.ts`, `backend/package.json:10`), so `cp .env.example .env`
> (`backend/README.md:16`) has no effect and the fake is used. The real
> adapter is selected whenever any other value, including the `change-me`
> placeholder from `backend/.env.example:48`, is exported into the process
> environment; it then connects to whatever `LIVEKIT_URL` says
> (`wss://livekit.example.com` in `backend/.env.example:46`). The comment at
> `live.module.ts:44-46` says the choice is obvious in logs, but no log line
> reports it.

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
> only in unit tests that seed the in-memory repositories. Nothing durable
> is written at runtime: grant and revoke never get past
> `404 live.request_not_found`, because no request can exist
> (`moderate-speaker.use-case.ts:153-157`). The only write that would be
> durable is the audit entry for a grant or revoke
> (`platform/platform.module.ts:43-48`, with a database configured), and it
> cannot occur today.

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

> **Resolved in Phase 0 (2026-09-23):** the last item is now enforced by the
> rule `livekit-sdk-only-in-the-live-adapter` and asserted by
> `test/architecture/live-boundaries.spec.ts`
> ([dependency-rules.md](dependency-rules.md#livekit-sdk-only-in-the-live-adapter)).
> The note below records the gap it closed.
>
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
> `livekit-rtc-provider.ts`. *(Since P1, `livekit-rtc-provider.spec.ts`
> covers the adapter: the claims of the tokens it signs, the full permission
> set on every update, its error mapping and its logs, against a stubbed
> room service rather than a LiveKit server.)*

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
