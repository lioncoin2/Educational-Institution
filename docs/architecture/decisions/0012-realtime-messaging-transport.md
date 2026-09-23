# 0012 — Realtime messaging: plain WebSocket, membership decided per event

**Status:** Accepted
**Date:** 2026-09-23

Answers open question Q7 ("How are new messages pushed to connected
clients?"). Builds on [0006](0006-event-architecture.md) (in-process events,
outbox-ready), [0010](0010-stateful-sessions-and-rotating-refresh-tokens.md)
(sessions checked on every request) and [0011](0011-messaging-v1.md)
(server-ordered sequences, membership-first). None of them is superseded.

## Context

Messaging V1 stores messages and announces them (`messaging.message.sent`),
and the Flutter client catches up by sequence over HTTP. Realtime V1 must
put a new message in front of the people entitled to it while they are
connected, without becoming a second messaging system. The brief fixed the
properties:

- the database stays the source of truth; the socket only delivers, and
  persistence never depends on delivery;
- connections are authenticated with the existing identity infrastructure,
  fail closed, and never trust a client-supplied user, role, permission or
  membership;
- recipients are resolved from conversation membership — never "everyone
  online", a role, a permission or an organisation — and removal stops
  delivery immediately;
- the server's sequence is the order; clients deduplicate, detect gaps and
  catch up over HTTP;
- the messaging module does not import a socket library, the gateway holds
  no business logic, and the transport stays replaceable;
- no Redis, broker or framework "because realtime exists".

### What the official NestJS documentation says

Read from its source (`nestjs/docs.nestjs.com`, `content/websockets/`:
`gateways.md`, `adapter.md`, `guards.md`, `exception-filters.md`) — the
docs site itself was not reachable from this environment:

- Gateways are platform-agnostic; Nest ships two platforms, **socket.io**
  (`@nestjs/platform-socket.io`) and **ws** (`@nestjs/platform-ws`, whose
  `WsAdapter` "acts as a proxy between the framework and the fast,
  thoroughly tested ws library", is "fully compatible with native browser
  WebSockets and is faster than the socket.io package", and "offers
  significantly fewer features out of the box, which many applications
  don't need"). `ws` has no namespaces; a gateway is mounted on a path.
- **Global guards registered with `APP_GUARD` apply to gateways as well.**
- **Global exception filters do not apply to gateways.**
- socket.io across several load-balanced instances needs sticky sessions
  or clients restricted to the `websocket` transport — "Redis alone is not
  enough".
- Request-scoped (per-connection) gateway providers arrive in NestJS v12;
  this backend is on v11. `@nestjs/platform-ws@11.2.5` depends on
  `ws@8.21.2`.

### The comparison

| Criterion | socket.io | Plain WebSocket (`ws`) |
| --- | --- | --- |
| Flutter client | third-party `socket_io_client`, its own protocol | `package:web_socket` (dart.dev, BSD-3, every platform, one dependency the app already had) |
| Browser compatibility | needs the socket.io client library | the browser's own `WebSocket` |
| Protocol | Engine.IO framing, handshake, long-polling fallback | RFC 6455 text frames |
| Reconnection | built into the client | ~100 lines in the client; needed anyway, because recovery here is HTTP catch-up by sequence, not socket replay |
| Acknowledgements | built in | not needed: delivery is best-effort by design, recovery is by sequence |
| Rooms | built in | deliberately not wanted: membership is read from the database per event |
| Binary | yes | yes (unused) |
| Authentication | handshake `auth` payload | first frame (below) |
| Several instances | Redis adapter **and** sticky sessions or websocket-only | an event bus that reaches every instance (below) |
| Operational surface | a protocol, a client library, an adapter | one library behind one adapter |

Every socket.io advantage is either unneeded (acks, rooms) or already
required of our own code (reconnection with HTTP catch-up). Plain
WebSocket satisfies every requirement with the smallest moving parts.

## Decision

1. **Plain WebSocket (RFC 6455), through `ws` directly, in one
   infrastructure adapter** (`realtime/infrastructure/websocket-transport.ts`)
   on the API's own HTTP server at `/realtime`. Not socket.io — see the
   table. And not a Nest gateway on `@nestjs/platform-ws`: the global
   `AccessGuard` would run for every message handler — it is HTTP-shaped
   (`switchToHttp`, bearer header, route metadata) and fails closed on
   undeclared routes; global exception filters would not run; and the
   handshake checks this adapter makes before a socket exists (origin,
   capacity, per-address rate, all with injected configuration and the
   rate-limiter port) do not fit a decorator's static options. `ws` is the
   library `@nestjs/platform-ws` wraps; using it directly adds nothing and
   keeps the transport one replaceable file.

2. **Authentication is the access token, in the first frame, checked by
   identity's own code.** Never in the URL (URLs are logged by proxies and
   servers; browsers cannot set headers on a WebSocket). Identity exports
   `ACCESS_TOKEN_AUTHENTICATOR`, implemented by the same
   `ResolvePrincipalUseCase` the HTTP guard uses — one implementation of
   authentication. Invalid, expired, revoked and suspended all fail closed
   (`UNAUTHORIZED`, close 4401); a principal without `messaging.read` is
   `FORBIDDEN` (4403); ten seconds without authenticating closes the
   socket. A client re-authenticates on the same connection before its
   token expires (same account only); a connection that does not is closed
   at expiry; every open connection's session, account and permission are
   re-checked every 60 seconds, and at every `subscribe`.

3. **Delivery is decided per event, by messaging, from the database.**
   The realtime module subscribes to messaging's events through the
   existing `EVENT_SUBSCRIBER` port and asks messaging's contracts who and
   what: `MESSAGE_RECIPIENTS` (current members — now optionally only those
   whose history window includes the message's sequence) and
   `MESSAGE_DELIVERY` (the message rendered once by the same views the
   HTTP timeline uses, with its `clientMessageId` only in the sender's
   copy). There are no rooms and no cached membership: a removal that has
   committed is in effect for the next event. Read marks go to the
   reader's own devices only; membership events to the person they
   concern; `conversation.created` to its members.

4. **Subscriptions are derived on the server, never declared by the
   client.** A `subscribe` frame asks the server to confirm one
   conversation — with messaging's own "open this conversation" use case
   and a freshly revalidated principal — and answers with the positions a
   client catches up from. It stores nothing and cannot widen delivery.
   Missing and not-yours are the same `CONVERSATION_NOT_FOUND`.

5. **The sender's own devices receive their message** (with its
   `clientMessageId`): the sending device reconciles its optimistic copy by
   that key, whichever of the HTTP response and the live event arrives
   first; its other devices learn about it.

6. **The database is the truth; the socket is a hint.** Delivery is
   detached from the publisher (a send returns when the message is
   stored), best-effort, and ordered per conversation. Clients order by
   sequence, deduplicate by id, treat a sequence beyond the next expected
   one as a gap, and fill every gap — and everything missed while
   disconnected — over HTTP. The socket never replays history.

7. **A versioned wire contract**, built field by field — never a domain
   event or a row spread onto the wire. `message.sent` carries the message
   exactly as the HTTP API renders it; `eventId` is derived from the fact,
   so a redelivered fact carries the same id. Error codes: `UNAUTHORIZED`,
   `FORBIDDEN`, `INVALID_EVENT`, `INVALID_PAYLOAD`, `CONVERSATION_NOT_FOUND`,
   `NOT_MEMBER` (reserved), `RATE_LIMITED`, `SERVER_ERROR`.

8. **One instance, until there are more.** The connection manager is
   per-process. More instances need every instance to see every event —
   a broker-backed event bus behind the existing `EventSubscriber` port
   (Redis pub/sub, NATS, or the outbox relay of ADR 0006) — while each
   instance keeps delivering to its own connections. Nothing in the
   realtime module changes; no Redis is added now.

## Consequences

- A stored message is never lost to a delivery failure, and a delivery
  failure never fails a send. What a client misses, it recovers by sequence.
- Removal, revocation and suspension reach live connections: removal on the
  next event; revocation, suspension and a lost permission within 60 seconds,
  or immediately at the next `subscribe`; token expiry at expiry.
- Each `message.sent` costs one recipients query per 1,000 members and one
  render, only when someone is connected; an event for a conversation with
  nobody online costs one query.
- The limits are provisional (open question Q26), in one file.
- A browser connection must come from an origin in `CORS_ORIGINS`.
- Clients carry the reconnect, deduplication and gap logic. The Flutter
  client has it; the backend suites carry a TypeScript statement of the same
  rules to prove the protocol supports them end to end.

## Alternatives considered

- **socket.io with the Redis adapter.** Rejected: a second protocol and a
  third-party Flutter client for features we either do not want (rooms, a
  membership copy that can drift) or must build anyway (recovery by
  sequence); multi-instance needs sticky sessions besides Redis.
- **A Nest gateway on `@nestjs/platform-ws`.** Rejected for the reasons in
  decision 1; revisit with NestJS 12 if per-connection providers and a
  WebSocket-aware global guard would simplify anything.
- **Server-Sent Events.** One-way, so authentication and subscriptions
  would need a second channel; browsers cannot set an `Authorization`
  header on `EventSource` either.
- **The LiveKit data channel.** Couples messaging to the RTC provider that
  ADR 0003 isolates; rejected in Q7 already.
- **Token in the query string**, or a one-time ticket endpoint. The first
  puts a bearer credential in every access log between client and server;
  the second adds state that would have to be shared between instances.
  The first-frame token needs neither.
- **Client-declared subscriptions (rooms).** A client could only ever ask
  for what the server would then have to re-check on every event anyway;
  storing it adds a membership copy that can drift. Delivery is derived
  from membership instead.
- **Message bodies in domain events.** Would spread content to every
  subscriber and, later, the outbox; ADR 0011 keeps events to identifiers.
- **Read marks to every member (read receipts).** A privacy decision —
  channels do not even show their members to one another (Q22). Deferred to
  open question Q25.
